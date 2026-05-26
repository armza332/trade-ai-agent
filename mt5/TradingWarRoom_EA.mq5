//+------------------------------------------------------------------+
//|              TradingWarRoom_EA.mq5                                |
//|              AI-derived Strategy for Cent Accounts ($30+)         |
//|                                                                   |
//|   Strategy:    RSI + Bollinger + Fibonacci confluence            |
//|   Symbols:     AUDUSDc + EURUSDc (proven 70%+ WR in KB)         |
//|   Timeframe:   H1 (Swing)                                         |
//|   Risk:        1.5% per trade, R:R 1:1.6                         |
//|   Lot:         Auto-calculated from balance + risk + SL          |
//+------------------------------------------------------------------+
#property copyright "Trading War Room v1.0"
#property version   "1.00"
#property strict
#property description "AI-validated swing trading on Cent account"

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

//═══════════════════ INPUTS ═════════════════════════════════════════
input group "=== SYMBOLS ==="
input string  Symbol1            = "AUDUSDc";    // Primary symbol
input string  Symbol2            = "EURUSDc";    // Secondary symbol
input bool    EnableSymbol2      = true;          // Trade EURUSD too

input group "=== STRATEGY ==="
input ENUM_TIMEFRAMES Timeframe  = PERIOD_H1;    // Analysis TF
input int     RSIPeriod          = 14;
input double  RSIOversold        = 35.0;
input double  RSIOverbought      = 65.0;
input int     BBPeriod           = 20;
input double  BBDeviation        = 2.0;
input int     FibLookback        = 50;            // bars for Fib swing high/low
input int     ATRPeriod          = 14;

input group "=== RISK MANAGEMENT ==="
input double  RiskPercent        = 1.5;           // % of balance per trade
input double  SLAtrMult          = 1.5;           // SL = ATR × this
input double  RewardRiskRatio    = 1.6;           // TP = SL × this
input double  MinLot             = 0.01;
input double  MaxLot             = 1.0;

input group "=== FILTERS ==="
input bool    OnlyLondonNY       = true;          // Skip Asia session
input int     SignalCooldownMin  = 30;            // Wait between signals
input int     MaxOpenPositions   = 2;             // per symbol

input group "=== SYSTEM ==="
input int     MagicNumber        = 992511;
input bool    EnableAlerts       = true;
input bool    EnableNotify       = false;         // Push notifications
input bool    ShowDashboard      = true;          // On-chart status panel

input group "=== WEB BRIDGE (Optional) ==="
input string  WebhookURL         = "";            // Apps Script URL (paste after deploy)
input string  WebhookSecret      = "twr-secret";  // Match Apps Script secret
input int     WebPushSec         = 30;            // Push status every N seconds (scalp = 15-30s)
input string  WatchXAU           = "XAUUSDm";     // XAU symbol for price feed (Phase 12.3)
input int     CommandPollSec     = 15;            // Poll web commands every N seconds (Phase 12.4)
input bool    AllowRemoteControl = true;          // Allow Close All / Pause from web (Phase 12.4)

//═══════════════════ GLOBALS ════════════════════════════════════════
CTrade        trade;
CPositionInfo posInfo;

datetime      lastSignalTime[2];
datetime      lastWebPush = 0;
datetime      lastCmdPoll = 0;
int           lastCmdId   = 0;       // last processed command ID
bool          eaPaused    = false;   // Phase 12.4: remote pause flag
int           rsiHandle[2], bbHandle[2], atrHandle[2];
string        symbols[2];
int           tradesToday_W = 0, tradesToday_L = 0;
double        pnlToday      = 0;

//═══════════════════ ON INIT ════════════════════════════════════════
int OnInit() {
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(30);
   trade.SetTypeFillingBySymbol(Symbol1);

   symbols[0] = Symbol1;
   symbols[1] = Symbol2;

   int nSyms = EnableSymbol2 ? 2 : 1;

   for (int i = 0; i < nSyms; i++) {
      // Verify symbol exists
      if (!SymbolSelect(symbols[i], true)) {
         Print("❌ Symbol not available: ", symbols[i]);
         return INIT_FAILED;
      }

      rsiHandle[i] = iRSI(symbols[i], Timeframe, RSIPeriod, PRICE_CLOSE);
      bbHandle[i]  = iBands(symbols[i], Timeframe, BBPeriod, 0, BBDeviation, PRICE_CLOSE);
      atrHandle[i] = iATR(symbols[i], Timeframe, ATRPeriod);

      if (rsiHandle[i] == INVALID_HANDLE ||
          bbHandle[i]  == INVALID_HANDLE ||
          atrHandle[i] == INVALID_HANDLE) {
         Print("❌ Failed to init indicators for ", symbols[i]);
         return INIT_FAILED;
      }

      lastSignalTime[i] = 0;
   }

   PrintFormat("✅ Trading War Room EA initialized");
   PrintFormat("   Symbols: %s%s", Symbol1, (EnableSymbol2 ? " + " + Symbol2 : ""));
   PrintFormat("   Timeframe: %s | Risk: %.1f%% | R:R 1:%.1f",
               EnumToString(Timeframe), RiskPercent, RewardRiskRatio);
   PrintFormat("   Account: $%.2f balance, %.2f equity",
               AccountInfoDouble(ACCOUNT_BALANCE),
               AccountInfoDouble(ACCOUNT_EQUITY));

   return INIT_SUCCEEDED;
}

//═══════════════════ ON DEINIT ══════════════════════════════════════
void OnDeinit(const int reason) {
   for (int i = 0; i < 2; i++) {
      if (rsiHandle[i] != INVALID_HANDLE) IndicatorRelease(rsiHandle[i]);
      if (bbHandle[i]  != INVALID_HANDLE) IndicatorRelease(bbHandle[i]);
      if (atrHandle[i] != INVALID_HANDLE) IndicatorRelease(atrHandle[i]);
   }
   Print("🛑 EA stopped — reason ", reason);
}

//═══════════════════ ON TICK ════════════════════════════════════════
void OnTick() {
   // Update dashboard + web push (every tick is OK, they have internal throttle)
   if (ShowDashboard) UpdateDashboard();
   PushToWeb();
   PollWebCommands();    // Phase 12.4: check for remote commands

   // Only run signal check on new bar to save CPU
   static datetime lastBar = 0;
   datetime curBar = iTime(Symbol1, Timeframe, 0);
   if (curBar == lastBar) {
      ManagePositions();
      return;
   }
   lastBar = curBar;

   // Update today's stats (after each new bar)
   UpdateTodayStats();

   // Phase 12.4: skip trading if paused remotely
   if (eaPaused) return;

   // Session filter
   if (OnlyLondonNY && !IsLondonNYSession()) return;

   // Trade check per symbol
   int nSyms = EnableSymbol2 ? 2 : 1;
   for (int i = 0; i < nSyms; i++) {
      CheckSignal(symbols[i], i);
   }
}

//═══════════════════ SIGNAL DETECTION ═══════════════════════════════
void CheckSignal(string sym, int idx) {
   // Cooldown
   if (TimeCurrent() - lastSignalTime[idx] < SignalCooldownMin * 60) return;

   // Already in position?
   if (CountPositions(sym) >= MaxOpenPositions) return;

   // Get indicator values — use dynamic arrays so ArraySetAsSeries works
   double rsiArr[], bbU[], bbM[], bbL[], atrArr[];
   ArraySetAsSeries(rsiArr, true);
   ArraySetAsSeries(bbU, true);
   ArraySetAsSeries(bbM, true);
   ArraySetAsSeries(bbL, true);
   ArraySetAsSeries(atrArr, true);

   if (CopyBuffer(rsiHandle[idx], 0, 0, 3, rsiArr) != 3) return;
   if (CopyBuffer(bbHandle[idx], 1, 0, 3, bbU)    != 3) return;
   if (CopyBuffer(bbHandle[idx], 0, 0, 3, bbM)    != 3) return;
   if (CopyBuffer(bbHandle[idx], 2, 0, 3, bbL)    != 3) return;
   if (CopyBuffer(atrHandle[idx], 0, 0, 3, atrArr) != 3) return;

   double rsi    = rsiArr[1];   // last closed bar
   double rsiPrev= rsiArr[2];
   double bbUp   = bbU[1];
   double bbDn   = bbL[1];
   double bbMid  = bbM[1];
   double atr    = atrArr[1];

   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double mid = (bid + ask) / 2;

   // Fibonacci: find swing high/low in last N bars
   double fibHigh = 0, fibLow = 999999;
   for (int j = 1; j <= FibLookback; j++) {
      double h = iHigh(sym, Timeframe, j);
      double l = iLow(sym, Timeframe, j);
      if (h > fibHigh) fibHigh = h;
      if (l < fibLow)  fibLow  = l;
   }
   double fibRange = fibHigh - fibLow;
   double fib618_buy  = fibLow + fibRange * 0.382;  // 0.618 retrace from high
   double fib618_sell = fibHigh - fibRange * 0.382;
   double fib50_buy   = fibLow + fibRange * 0.5;
   double fib50_sell  = fibHigh - fibRange * 0.5;

   // ─── BUY SIGNAL: RSI oversold + price at lower BB + near Fib support ───
   bool rsiBuy  = (rsi <= RSIOversold && rsiPrev <= RSIOversold);
   bool bbBuy   = (mid <= bbDn * 1.0015);  // within 0.15% of lower BB
   bool fibBuy  = (mid <= fib618_buy * 1.005);  // near 38.2-50% retrace

   if (rsiBuy && bbBuy && fibBuy) {
      ExecuteTrade(sym, idx, true, atr, rsi);
      return;
   }

   // ─── SELL SIGNAL: RSI overbought + price at upper BB + near Fib resistance ───
   bool rsiSell = (rsi >= RSIOverbought && rsiPrev >= RSIOverbought);
   bool bbSell  = (mid >= bbUp * 0.9985);
   bool fibSell = (mid >= fib618_sell * 0.995);

   if (rsiSell && bbSell && fibSell) {
      ExecuteTrade(sym, idx, false, atr, rsi);
      return;
   }
}

//═══════════════════ EXECUTE TRADE ══════════════════════════════════
void ExecuteTrade(string sym, int idx, bool isBuy, double atr, double rsi) {
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double entry = isBuy ? ask : bid;
   double slDist = atr * SLAtrMult;
   double tpDist = slDist * RewardRiskRatio;
   double sl = isBuy ? entry - slDist : entry + slDist;
   double tp = isBuy ? entry + tpDist : entry - tpDist;

   // Normalize prices to symbol digits
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   sl = NormalizeDouble(sl, digits);
   tp = NormalizeDouble(tp, digits);
   entry = NormalizeDouble(entry, digits);

   // Calculate lot size from risk
   double lot = CalculateLot(sym, slDist);
   if (lot < MinLot) lot = MinLot;
   if (lot > MaxLot) lot = MaxLot;

   string comment = StringFormat("TWR %s RSI%.0f", isBuy ? "BUY" : "SELL", rsi);
   bool ok;
   if (isBuy) ok = trade.Buy(lot, sym, entry, sl, tp, comment);
   else       ok = trade.Sell(lot, sym, entry, sl, tp, comment);

   if (ok) {
      lastSignalTime[idx] = TimeCurrent();
      PrintFormat("🎯 %s %s @ %.5f | SL %.5f | TP %.5f | Lot %.2f | RSI %.1f",
                  sym, isBuy ? "BUY" : "SELL", entry, sl, tp, lot, rsi);
      if (EnableAlerts) Alert(comment, " ", sym, " @ ", DoubleToString(entry, digits));
      if (EnableNotify) SendNotification("TWR: " + comment + " " + sym);
   } else {
      PrintFormat("❌ Trade failed: %s %s — error %d (%s)",
                  sym, isBuy ? "BUY" : "SELL",
                  trade.ResultRetcode(), trade.ResultRetcodeDescription());
   }
}

//═══════════════════ LOT CALCULATION ════════════════════════════════
double CalculateLot(string sym, double slDistance) {
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskUSD = balance * RiskPercent / 100.0;

   double tickValue = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   if (tickValue <= 0 || tickSize <= 0) return MinLot;

   double slTicks = slDistance / tickSize;
   double lot = riskUSD / (slTicks * tickValue);

   double minLotBroker = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double maxLotBroker = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double lotStep      = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);

   lot = MathMax(lot, minLotBroker);
   lot = MathMin(lot, maxLotBroker);
   lot = MathFloor(lot / lotStep) * lotStep;
   return NormalizeDouble(lot, 2);
}

//═══════════════════ POSITION MANAGEMENT ════════════════════════════
int CountPositions(string sym) {
   int count = 0;
   for (int i = PositionsTotal() - 1; i >= 0; i--) {
      if (posInfo.SelectByIndex(i)) {
         if (posInfo.Symbol() == sym && posInfo.Magic() == MagicNumber) count++;
      }
   }
   return count;
}

void ManagePositions() {
   // Currently relies on broker SL/TP. Future: trailing stop, breakeven move.
}

//═══════════════════ SESSION FILTER ═════════════════════════════════
bool IsLondonNYSession() {
   MqlDateTime t;
   TimeCurrent(t);
   int h = t.hour;
   // London 8-12 UTC, NY 13-17 UTC → broker H = UTC + offset
   return (h >= 8 && h < 17);
}

//═══════════════════ TODAY STATS ════════════════════════════════════
datetime StartOfDay() {
   MqlDateTime t;
   TimeCurrent(t);
   t.hour = 0; t.min = 0; t.sec = 0;
   return StructToTime(t);
}

void UpdateTodayStats() {
   tradesToday_W = 0; tradesToday_L = 0; pnlToday = 0;
   if (!HistorySelect(StartOfDay(), TimeCurrent())) return;
   int n = HistoryDealsTotal();
   for (int i = 0; i < n; i++) {
      ulong t = HistoryDealGetTicket(i);
      if (HistoryDealGetInteger(t, DEAL_MAGIC) != MagicNumber) continue;
      if (HistoryDealGetInteger(t, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;
      double profit = HistoryDealGetDouble(t, DEAL_PROFIT)
                    + HistoryDealGetDouble(t, DEAL_SWAP)
                    + HistoryDealGetDouble(t, DEAL_COMMISSION);
      if (profit > 0)      tradesToday_W++;
      else if (profit < 0) tradesToday_L++;
      pnlToday += profit;
   }
}

//═══════════════════ ON-CHART DASHBOARD ═════════════════════════════
void UpdateDashboard() {
   string p = "";
   p += "╔═════════════════════════════╗\n";
   p += "║  🤖 TRADING WAR ROOM v1.0    ║\n";
   p += "╚═════════════════════════════╝\n";
   p += StringFormat("⏰ %s  | Server time\n",
        TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES));
   p += "─────────────────────────────\n";
   p += StringFormat("💰 Balance:  $%.2f\n", AccountInfoDouble(ACCOUNT_BALANCE));
   p += StringFormat("📊 Equity:   $%.2f\n", AccountInfoDouble(ACCOUNT_EQUITY));
   p += StringFormat("💵 Today P/L: $%+.2f  (%dW/%dL)\n", pnlToday, tradesToday_W, tradesToday_L);
   p += "─────────────────────────────\n";

   int nSyms = EnableSymbol2 ? 2 : 1;
   for (int i = 0; i < nSyms; i++) {
      double rsi[]; ArraySetAsSeries(rsi, true);
      double bbU[], bbL[]; ArraySetAsSeries(bbU, true); ArraySetAsSeries(bbL, true);
      bool ok = (CopyBuffer(rsiHandle[i], 0, 0, 2, rsi) == 2) &&
                (CopyBuffer(bbHandle[i], 1, 0, 2, bbU) == 2) &&
                (CopyBuffer(bbHandle[i], 2, 0, 2, bbL) == 2);
      if (!ok) continue;

      double bid = SymbolInfoDouble(symbols[i], SYMBOL_BID);
      double mid = bid;
      string sigEmoji = "⚪";
      string sigText  = "WAIT";
      if (rsi[0] < RSIOversold && mid <= bbL[0] * 1.001)      { sigEmoji = "🟢"; sigText = "BUY watch"; }
      else if (rsi[0] > RSIOverbought && mid >= bbU[0] * 0.999) { sigEmoji = "🔴"; sigText = "SELL watch"; }

      int posCnt = CountPositions(symbols[i]);
      p += StringFormat("💎 %s   %s %s\n", symbols[i], sigEmoji, sigText);
      p += StringFormat("   RSI %.1f  | Pos: %d\n", rsi[0], posCnt);
   }

   p += "─────────────────────────────\n";
   string sessionTxt = IsLondonNYSession() ? "🟢 London/NY ACTIVE" : "🟡 Asia / Off-hours";
   p += sessionTxt + "\n";
   if (StringLen(WebhookURL) > 10) {
      p += StringFormat("🌐 Web sync: ON (every %ds)\n", WebPushSec);
   }
   p += "═════════════════════════════";

   Comment(p);
}

//═══════════════════ WEB BRIDGE ═════════════════════════════════════
void PushToWeb() {
   if (StringLen(WebhookURL) < 10) return;
   if (TimeCurrent() - lastWebPush < WebPushSec) return;
   lastWebPush = TimeCurrent();

   // Build JSON status payload
   string posJson = "";
   for (int i = PositionsTotal() - 1; i >= 0; i--) {
      if (!posInfo.SelectByIndex(i)) continue;
      if (posInfo.Magic() != MagicNumber) continue;
      if (StringLen(posJson) > 0) posJson += ",";
      posJson += StringFormat(
         "{\"sym\":\"%s\",\"side\":\"%s\",\"vol\":%.2f,\"open\":%.5f,\"sl\":%.5f,\"tp\":%.5f,\"profit\":%.2f}",
         posInfo.Symbol(),
         posInfo.PositionType() == POSITION_TYPE_BUY ? "buy" : "sell",
         posInfo.Volume(),
         posInfo.PriceOpen(),
         posInfo.StopLoss(),
         posInfo.TakeProfit(),
         posInfo.Profit() + posInfo.Swap() + posInfo.Commission()
      );
   }

   // ── Phase 12.3: Real-time prices for Web analysis ──
   string pxJson = BuildPricesJson();

   string json = StringFormat(
      "{\"type\":\"status\",\"secret\":\"%s\",\"ts\":%d,"
      "\"balance\":%.2f,\"equity\":%.2f,\"freeMargin\":%.2f,"
      "\"todayWins\":%d,\"todayLosses\":%d,\"todayPnL\":%.2f,"
      "\"symbols\":[\"%s\",\"%s\"],"
      "\"paused\":%s,"
      "\"prices\":%s,"
      "\"positions\":[%s]}",
      WebhookSecret, (int)TimeCurrent(),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_MARGIN_FREE),
      tradesToday_W, tradesToday_L, pnlToday,
      Symbol1, Symbol2,
      (eaPaused ? "true" : "false"),
      pxJson,
      posJson
   );

   char post[]; StringToCharArray(json, post, 0, StringLen(json));
   char result[]; string headers;
   ResetLastError();
   int code = WebRequest("POST", WebhookURL,
                          "Content-Type: application/json\r\n",
                          5000, post, result, headers);
   if (code != 200) {
      int err = GetLastError();
      if (err == 4014) {
         // URL not in allowed list — silently disable to avoid log spam
         static bool warned = false;
         if (!warned) {
            Print("⚠️ WebRequest blocked — add ", WebhookURL, " to Tools → Options → Expert Advisors → WebRequest allowed URLs");
            warned = true;
         }
      }
   }
}

//═══════════════════ PHASE 12.3: Build prices JSON ═════════════════════
// Outputs live bid/ask + H1 indicators for XAU + Symbol1 + Symbol2.
// Web side uses these as ground truth (replaces external API).
string BuildPriceEntry(string sym) {
   if (!SymbolSelect(sym, true)) return "";
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   if (bid <= 0 || ask <= 0) return "";
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double spread = (ask - bid) / point;

   // Try to grab H1 RSI/ATR (cached for Symbol1/Symbol2; else create temp handle)
   double rsi = 0, atr = 0;
   double bbUp = 0, bbDn = 0, bbMid = 0;

   int hRsi = iRSI(sym, PERIOD_H1, 14, PRICE_CLOSE);
   int hAtr = iATR(sym, PERIOD_H1, 14);
   int hBb  = iBands(sym, PERIOD_H1, 20, 0, 2.0, PRICE_CLOSE);

   if (hRsi != INVALID_HANDLE) {
      double a[]; ArraySetAsSeries(a, true);
      if (CopyBuffer(hRsi, 0, 0, 1, a) > 0) rsi = a[0];
      IndicatorRelease(hRsi);
   }
   if (hAtr != INVALID_HANDLE) {
      double a[]; ArraySetAsSeries(a, true);
      if (CopyBuffer(hAtr, 0, 0, 1, a) > 0) atr = a[0];
      IndicatorRelease(hAtr);
   }
   if (hBb != INVALID_HANDLE) {
      double bU[], bM[], bL[];
      ArraySetAsSeries(bU, true); ArraySetAsSeries(bM, true); ArraySetAsSeries(bL, true);
      if (CopyBuffer(hBb, 1, 0, 1, bU) > 0 &&
          CopyBuffer(hBb, 0, 0, 1, bM) > 0 &&
          CopyBuffer(hBb, 2, 0, 1, bL) > 0) {
         bbUp = bU[0]; bbMid = bM[0]; bbDn = bL[0];
      }
      IndicatorRelease(hBb);
   }

   // Daily change percent
   MqlRates dayRates[]; ArraySetAsSeries(dayRates, true);
   double dayChg = 0;
   if (CopyRates(sym, PERIOD_D1, 0, 2, dayRates) >= 2 && dayRates[1].close > 0) {
      dayChg = (bid - dayRates[1].close) / dayRates[1].close * 100.0;
   }

   string fmt = StringFormat("%%.%df", digits);
   return StringFormat(
      "\"%s\":{\"bid\":" + fmt + ",\"ask\":" + fmt + ",\"spread\":%.1f,"
      "\"rsi\":%.2f,\"atr\":" + fmt + ",\"bbUp\":" + fmt + ",\"bbMid\":" + fmt + ",\"bbDn\":" + fmt + ","
      "\"dayChg\":%.3f,\"digits\":%d}",
      sym, bid, ask, spread, rsi, atr, bbUp, bbMid, bbDn, dayChg, digits
   );
}

string BuildPricesJson() {
   string list[3] = {WatchXAU, Symbol1, Symbol2};
   string out = "{";
   bool first = true;
   for (int i = 0; i < 3; i++) {
      if (StringLen(list[i]) == 0) continue;
      // Skip duplicates (e.g., if user puts Symbol1 in WatchXAU by mistake)
      bool dup = false;
      for (int j = 0; j < i; j++) if (list[j] == list[i]) { dup = true; break; }
      if (dup) continue;
      string entry = BuildPriceEntry(list[i]);
      if (StringLen(entry) == 0) continue;
      if (!first) out += ",";
      out += entry;
      first = false;
   }
   out += "}";
   return out;
}

//═══════════════════ PHASE 12.4: Remote Command Polling ═══════════════
// EA polls /?action=command every CommandPollSec seconds.
// Commands: close_all, pause, resume, reset_pnl
void PollWebCommands() {
   if (!AllowRemoteControl) return;
   if (StringLen(WebhookURL) < 10) return;
   if (TimeCurrent() - lastCmdPoll < CommandPollSec) return;
   lastCmdPoll = TimeCurrent();

   string url = WebhookURL + "?action=command&secret=" + WebhookSecret + "&since=" + IntegerToString(lastCmdId);
   char post[]; char result[]; string headers;
   ResetLastError();
   int code = WebRequest("GET", url, "", 5000, post, result, headers);
   if (code != 200) return;

   string body = CharArrayToString(result, 0, -1, CP_UTF8);
   if (StringLen(body) < 10) return;

   // Parse simple JSON: {"ok":true,"cmd":"close_all","id":5}
   // Cheap string-based parser (no JSON lib in MQL5 core)
   int idPos = StringFind(body, "\"id\":");
   if (idPos < 0) return;
   int idVal = (int)StringToInteger(StringSubstr(body, idPos + 5, 10));
   if (idVal <= lastCmdId) return;     // already processed

   int cmdPos = StringFind(body, "\"cmd\":\"");
   if (cmdPos < 0) return;
   int cmdStart = cmdPos + 7;
   int cmdEnd = StringFind(body, "\"", cmdStart);
   if (cmdEnd < 0) return;
   string cmd = StringSubstr(body, cmdStart, cmdEnd - cmdStart);

   ExecuteCommand(cmd);
   lastCmdId = idVal;
}

void ExecuteCommand(string cmd) {
   if (cmd == "close_all") {
      int closed = CloseAllMyPositions();
      Print("🔴 REMOTE: Close All → closed ", closed, " positions");
   }
   else if (cmd == "pause") {
      eaPaused = true;
      Print("⏸ REMOTE: EA paused (no new trades, existing positions managed)");
   }
   else if (cmd == "resume") {
      eaPaused = false;
      Print("▶️ REMOTE: EA resumed");
   }
   else if (cmd == "reset_pnl") {
      tradesToday_W = 0;
      tradesToday_L = 0;
      pnlToday = 0;
      Print("🔄 REMOTE: Today stats reset");
   }
}

int CloseAllMyPositions() {
   int closed = 0;
   for (int i = PositionsTotal() - 1; i >= 0; i--) {
      if (!posInfo.SelectByIndex(i)) continue;
      if (posInfo.Magic() != MagicNumber) continue;
      if (trade.PositionClose(posInfo.Ticket())) closed++;
   }
   return closed;
}
