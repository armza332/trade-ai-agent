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
input bool    EnableSymbol2      = true;          // Trade Symbol2 too
input string  Symbol3            = "XAUUSDm";    // Third symbol (gold)
input bool    EnableSymbol3      = false;         // Trade Symbol3 too (XAU — ระวัง spread!)

input group "=== STRATEGY ==="
input ENUM_TIMEFRAMES Timeframe  = PERIOD_H1;    // Analysis TF (Swing default; Scalp uses ScalpTF below)
input int     RSIPeriod          = 14;
input double  RSIOversold        = 35.0;
input double  RSIOverbought      = 65.0;
input int     BBPeriod           = 20;
input double  BBDeviation        = 2.0;
input int     FibLookback        = 50;            // bars for Fib swing high/low
input int     ATRPeriod          = 14;

input group "=== SCALP MODE (Phase 12.7 — M1 scraping) ==="
input bool    ScalpMode          = false;         // ⚡ Enable M1 fast-scrap mode (overrides Timeframe)
input ENUM_TIMEFRAMES ScalpTF    = PERIOD_M1;     // Scalp timeframe (M1 default; try M5 if too noisy)
input double  ScalpRSIOversold   = 30.0;          // Tighter RSI for scalp (fewer fakes)
input double  ScalpRSIOverbought = 70.0;
input double  ScalpSLMult        = 0.8;           // Tighter SL (M1 = small moves)
input double  ScalpRR            = 1.3;           // Lower R:R (scalp aims for many small wins)
input int     ScalpCooldownMin   = 3;             // 3-min cooldown (was 30 for swing)
input int     ScalpMaxPosPerSym  = 1;             // Stricter — 1 trade at a time per symbol

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

#define MAX_SYMS 3

// Phase 12.8: Per-symbol scan state for dashboard
struct ScanState {
   bool   rsiBuy, bbBuy, fibBuy;       // BUY-side conditions
   bool   rsiSell, bbSell, fibSell;    // SELL-side
   double rsi;
   double distToBBLower;               // % distance (positive = above lower band)
   double distToBBUpper;               // % distance (negative = below upper)
   datetime lastScan;
   string tag;                         // human-readable hint
};
ScanState     scanState[MAX_SYMS];

datetime      lastSignalTime[MAX_SYMS];
datetime      lastWebPush = 0;
datetime      lastCmdPoll = 0;
int           lastCmdId   = 0;       // last processed command ID
bool          eaPaused    = false;   // Phase 12.4: remote pause flag
int           rsiHandle[MAX_SYMS], bbHandle[MAX_SYMS], atrHandle[MAX_SYMS];
string        symbols[MAX_SYMS];
int           nActiveSyms = 0;       // dynamically counted in OnInit
bool          runEnabled[MAX_SYMS];  // Phase 12.9: runtime per-symbol toggle (web can flip)
int           tradesToday_W = 0, tradesToday_L = 0;
double        pnlToday      = 0;

// Phase 12.7: Effective strategy params (swap when ScalpMode toggles)
ENUM_TIMEFRAMES effTF;
double          effRSIOver, effRSIUnder, effSLMult, effRR;
int             effCooldownMin, effMaxPos;

void ApplyMode() {
   if (ScalpMode) {
      effTF          = ScalpTF;
      effRSIUnder    = ScalpRSIOversold;
      effRSIOver     = ScalpRSIOverbought;
      effSLMult      = ScalpSLMult;
      effRR          = ScalpRR;
      effCooldownMin = ScalpCooldownMin;
      effMaxPos      = ScalpMaxPosPerSym;
   } else {
      effTF          = Timeframe;
      effRSIUnder    = RSIOversold;
      effRSIOver     = RSIOverbought;
      effSLMult      = SLAtrMult;
      effRR          = RewardRiskRatio;
      effCooldownMin = SignalCooldownMin;
      effMaxPos      = MaxOpenPositions;
   }
}

// Phase 12.6: Live training — entry context per open ticket
struct TradeCtx {
   ulong  ticket;
   string sym;
   string side;
   double entry;
   double sl;
   double rsiAtEntry;
   double bbPosAtEntry;   // 0..1 (where 0=lower band, 1=upper band)
   string sessionAtEntry;
   datetime openTime;
   double riskUSD;
};
TradeCtx openCtx[];        // dynamic array
int      openCtxCount = 0;

//═══════════════════ ON INIT ════════════════════════════════════════
int OnInit() {
   ApplyMode();              // Phase 12.7: set effective TF + thresholds

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(30);
   trade.SetTypeFillingBySymbol(Symbol1);

   // Phase 12.8: build active symbol list dynamically (1-3 symbols)
   nActiveSyms = 0;
   symbols[nActiveSyms++] = Symbol1;
   if (EnableSymbol2 && StringLen(Symbol2) > 0) symbols[nActiveSyms++] = Symbol2;
   if (EnableSymbol3 && StringLen(Symbol3) > 0) symbols[nActiveSyms++] = Symbol3;

   // Phase 12.9: init runtime toggle = enabled for all active symbols
   for (int k = 0; k < MAX_SYMS; k++) runEnabled[k] = (k < nActiveSyms);

   for (int i = 0; i < nActiveSyms; i++) {
      // Verify symbol exists
      if (!SymbolSelect(symbols[i], true)) {
         Print("❌ Symbol not available: ", symbols[i]);
         return INIT_FAILED;
      }

      rsiHandle[i] = iRSI(symbols[i], effTF, RSIPeriod, PRICE_CLOSE);
      bbHandle[i]  = iBands(symbols[i], effTF, BBPeriod, 0, BBDeviation, PRICE_CLOSE);
      atrHandle[i] = iATR(symbols[i], effTF, ATRPeriod);

      if (rsiHandle[i] == INVALID_HANDLE ||
          bbHandle[i]  == INVALID_HANDLE ||
          atrHandle[i] == INVALID_HANDLE) {
         Print("❌ Failed to init indicators for ", symbols[i]);
         return INIT_FAILED;
      }

      lastSignalTime[i] = 0;
   }

   PrintFormat("✅ Trading War Room EA initialized [%s MODE]", ScalpMode ? "⚡ SCALP M1" : "🌊 SWING");
   string symStr = symbols[0];
   for (int i = 1; i < nActiveSyms; i++) symStr += " + " + symbols[i];
   PrintFormat("   Trading %d symbols: %s", nActiveSyms, symStr);
   PrintFormat("   Timeframe: %s | Risk: %.1f%% | R:R 1:%.1f | Cooldown %dmin",
               EnumToString(effTF), RiskPercent, effRR, effCooldownMin);
   PrintFormat("   Account: $%.2f balance, %.2f equity",
               AccountInfoDouble(ACCOUNT_BALANCE),
               AccountInfoDouble(ACCOUNT_EQUITY));

   return INIT_SUCCEEDED;
}

//═══════════════════ ON DEINIT ══════════════════════════════════════
void OnDeinit(const int reason) {
   for (int i = 0; i < MAX_SYMS; i++) {
      if (rsiHandle[i] != INVALID_HANDLE) IndicatorRelease(rsiHandle[i]);
      if (bbHandle[i]  != INVALID_HANDLE) IndicatorRelease(bbHandle[i]);
      if (atrHandle[i] != INVALID_HANDLE) IndicatorRelease(atrHandle[i]);
   }
   RemoveDashboard();      // Phase 12.5: cleanup OBJ_LABEL items
   Comment("");            // clear any leftover Comment text
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
   datetime curBar = iTime(Symbol1, effTF, 0);
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
   for (int i = 0; i < nActiveSyms; i++) {
      if (!runEnabled[i]) continue;   // Phase 12.9: skip if disabled from web
      CheckSignal(symbols[i], i);
   }
}

//═══════════════════ SIGNAL DETECTION ═══════════════════════════════
void CheckSignal(string sym, int idx) {
   // Always scan (so dashboard always reflects fresh state).
   // Cooldown + position checks only block actual trade execution.

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
      double h = iHigh(sym, effTF, j);
      double l = iLow(sym, effTF, j);
      if (h > fibHigh) fibHigh = h;
      if (l < fibLow)  fibLow  = l;
   }
   double fibRange = fibHigh - fibLow;
   double fib618_buy  = fibLow + fibRange * 0.382;
   double fib618_sell = fibHigh - fibRange * 0.382;

   // ─── Evaluate all 6 conditions (used for both trade decision + dashboard) ───
   bool rsiBuy  = (rsi <= effRSIUnder && rsiPrev <= effRSIUnder);
   bool bbBuy   = (mid <= bbDn * 1.0015);
   bool fibBuy  = ScalpMode ? true : (mid <= fib618_buy * 1.005);

   bool rsiSell = (rsi >= effRSIOver && rsiPrev >= effRSIOver);
   bool bbSell  = (mid >= bbUp * 0.9985);
   bool fibSell = ScalpMode ? true : (mid >= fib618_sell * 0.995);

   // ─── Update scan state for dashboard ───
   scanState[idx].rsiBuy  = rsiBuy;
   scanState[idx].bbBuy   = bbBuy;
   scanState[idx].fibBuy  = fibBuy;
   scanState[idx].rsiSell = rsiSell;
   scanState[idx].bbSell  = bbSell;
   scanState[idx].fibSell = fibSell;
   scanState[idx].rsi     = rsi;
   scanState[idx].distToBBLower = (bbDn > 0) ? ((mid - bbDn) / bbDn * 100.0) : 0;
   scanState[idx].distToBBUpper = (bbUp > 0) ? ((bbUp - mid) / bbUp * 100.0) : 0;
   scanState[idx].lastScan = TimeCurrent();

   int buyHits  = (rsiBuy?1:0)  + (bbBuy?1:0)  + (fibBuy?1:0);
   int sellHits = (rsiSell?1:0) + (bbSell?1:0) + (fibSell?1:0);

   // Build tag for dashboard
   if (CountPositions(sym) >= effMaxPos)        scanState[idx].tag = "MAX-POS";
   else if (TimeCurrent() - lastSignalTime[idx] < effCooldownMin * 60) {
      int waitSec = (int)(effCooldownMin * 60 - (TimeCurrent() - lastSignalTime[idx]));
      scanState[idx].tag = StringFormat("CD %ds", waitSec);
   }
   else if (buyHits >= 3)                       scanState[idx].tag = "BUY!";
   else if (sellHits >= 3)                      scanState[idx].tag = "SELL!";
   else if (buyHits == 2)                       scanState[idx].tag = "BUY?";
   else if (sellHits == 2)                      scanState[idx].tag = "SELL?";
   else                                         scanState[idx].tag = "SCAN";

   // ─── Trade execution (only if cooldown + position allow) ───
   if (TimeCurrent() - lastSignalTime[idx] < effCooldownMin * 60) return;
   if (CountPositions(sym) >= effMaxPos) return;

   if (rsiBuy && bbBuy && fibBuy)   { ExecuteTrade(sym, idx, true,  atr, rsi); return; }
   if (rsiSell && bbSell && fibSell){ ExecuteTrade(sym, idx, false, atr, rsi); return; }
}

//═══════════════════ EXECUTE TRADE ══════════════════════════════════
void ExecuteTrade(string sym, int idx, bool isBuy, double atr, double rsi) {
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double entry = isBuy ? ask : bid;
   double slDist = atr * effSLMult;
   double tpDist = slDist * effRR;
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

//═══════════════════ ON-CHART DASHBOARD — BOSS MODE ════════════════
// Uses OBJ_RECTANGLE_LABEL + OBJ_LABEL for real graphics
// (replaces plain Comment() — far more impressive)
#define DASH_PFX  "TWR_DASH_"
#define DASH_W    340
#define DASH_X    10
#define DASH_Y    20

// helper: create / update label
void DashLabel(string id, int x, int y, string text, color clr, int fontSize=8, string font="Consolas") {
   string name = DASH_PFX + id;
   if (ObjectFind(0, name) < 0) {
      ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
      ObjectSetInteger(0, name, OBJPROP_BACK, false);
      ObjectSetString (0, name, OBJPROP_FONT, font);
   }
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE, fontSize);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetString (0, name, OBJPROP_TEXT, text);
}

void DashRect(string id, int x, int y, int w, int h, color bg, color border, int borderW=1) {
   string name = DASH_PFX + id;
   if (ObjectFind(0, name) < 0) {
      ObjectCreate(0, name, OBJ_RECTANGLE_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
      ObjectSetInteger(0, name, OBJPROP_BACK, false);
   }
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, name, OBJPROP_XSIZE,     w);
   ObjectSetInteger(0, name, OBJPROP_YSIZE,     h);
   ObjectSetInteger(0, name, OBJPROP_BGCOLOR,   bg);
   ObjectSetInteger(0, name, OBJPROP_BORDER_COLOR, border);
   ObjectSetInteger(0, name, OBJPROP_BORDER_TYPE,  BORDER_FLAT);
   ObjectSetInteger(0, name, OBJPROP_WIDTH, borderW);
}

string ProgressBar(double pct, int width) {
   if (pct < 0) pct = 0; if (pct > 1) pct = 1;
   int filled = (int)MathRound(pct * width);
   string s = "";
   for (int i = 0; i < width; i++) s += (i < filled) ? "█" : "░";
   return s;
}

void UpdateDashboard() {
   int y = DASH_Y;

   // ── Outer panel ──
   DashRect("PANEL", DASH_X, y, DASH_W, 280,
            C'10,15,25',           // bg: dark blue-black
            C'0,255,200',          // border: cyan
            2);

   // ── Header ──
   DashLabel("TITLE", DASH_X+12, y+8,
             eaPaused ? "▼ TRADING WAR ROOM — PAUSED ▼" : "▲ TRADING WAR ROOM — BOSS MODE ▲",
             eaPaused ? C'255,140,0' : C'0,255,200',
             10, "Consolas Bold");
   DashLabel("CLOCK", DASH_X+12, y+28,
             TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES) + "  " + (IsLondonNYSession() ? "[LDN/NY]" : "[ASIA]"),
             IsLondonNYSession() ? C'255,230,0' : C'128,128,128',
             7);

   // ── Account block ──
   y += 50;
   DashRect("ACC_BG", DASH_X+8, y, DASH_W-16, 70,
            C'18,28,40', C'0,180,140', 1);

   double bal = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq  = AccountInfoDouble(ACCOUNT_EQUITY);
   double fm  = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double pnlPct = (bal > 0) ? (pnlToday / bal * 100.0) : 0;
   color pnlClr = pnlToday > 0 ? C'0,255,100' : (pnlToday < 0 ? C'255,80,80' : C'180,180,180');

   DashLabel("ACC_LBL", DASH_X+16, y+5, "ACCOUNT", C'0,255,200', 7);
   DashLabel("BAL",     DASH_X+16, y+22, StringFormat("BAL  $%.2f", bal),  C'255,255,255', 9);
   DashLabel("EQ",      DASH_X+150, y+22, StringFormat("EQ  $%.2f", eq),  C'200,200,200', 9);
   DashLabel("PNL",     DASH_X+16, y+42, StringFormat("P/L  $%+.2f  (%+.2f%%)  W%d L%d",
                                                       pnlToday, pnlPct, tradesToday_W, tradesToday_L),
             pnlClr, 9);

   // ── Live Watch block ──
   y += 80;
   DashRect("WATCH_BG", DASH_X+8, y, DASH_W-16, 92,
            C'18,28,40', C'255,200,0', 1);
   DashLabel("WATCH_LBL", DASH_X+16, y+5, "LIVE WATCH", C'255,230,0', 7);

   // Phase 12.8: show trade symbols first (with scan state), then WatchXAU if not traded
   string displayList[4];
   int displayCount = 0;
   bool watchXauIsTraded = false;
   for (int i = 0; i < nActiveSyms; i++) {
      displayList[displayCount++] = symbols[i];
      if (symbols[i] == WatchXAU) watchXauIsTraded = true;
   }
   if (!watchXauIsTraded && StringLen(WatchXAU) > 0) displayList[displayCount++] = WatchXAU;

   for (int i = 0; i < displayCount; i++) {
      string sym = displayList[i];
      if (StringLen(sym) == 0 || !SymbolSelect(sym, true)) continue;

      double bid = SymbolInfoDouble(sym, SYMBOL_BID);
      int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);

      // For traded symbols: use scanState (refreshed every tick)
      // For watch-only: compute quick RSI
      bool isTraded = (i < nActiveSyms);
      double rsi = 50;
      string sigTag = "WATCH";
      color  sigClr = C'120,180,255';   // blue for watch
      string RBF = "   ";

      if (isTraded) {
         rsi = scanState[i].rsi;
         sigTag = scanState[i].tag;

         // R/B/F indicator: bright if condition met (use BUY side if BUY tag, SELL side if SELL)
         bool buyDir = (StringFind(sigTag, "BUY") >= 0);
         bool sellDir = (StringFind(sigTag, "SELL") >= 0);
         string r = " ", b = " ", f = " ";
         if (buyDir) {
            r = scanState[i].rsiBuy ? "R" : "·";
            b = scanState[i].bbBuy  ? "B" : "·";
            f = scanState[i].fibBuy ? "F" : "·";
         } else if (sellDir) {
            r = scanState[i].rsiSell ? "R" : "·";
            b = scanState[i].bbSell  ? "B" : "·";
            f = scanState[i].fibSell ? "F" : "·";
         } else {
            // Pure SCAN — show which side has more hits
            int buyHits  = (scanState[i].rsiBuy?1:0)  + (scanState[i].bbBuy?1:0)  + (scanState[i].fibBuy?1:0);
            int sellHits = (scanState[i].rsiSell?1:0) + (scanState[i].bbSell?1:0) + (scanState[i].fibSell?1:0);
            r = (buyHits > sellHits) ? (scanState[i].rsiBuy ? "r" : "·") : (scanState[i].rsiSell ? "r" : "·");
            b = (buyHits > sellHits) ? (scanState[i].bbBuy  ? "b" : "·") : (scanState[i].bbSell  ? "b" : "·");
            f = (buyHits > sellHits) ? (scanState[i].fibBuy ? "f" : "·") : (scanState[i].fibSell ? "f" : "·");
         }
         RBF = r + b + f;

         // Color by tag
         if      (sigTag == "BUY!")    sigClr = C'0,255,100';
         else if (sigTag == "SELL!")   sigClr = C'255,80,80';
         else if (sigTag == "BUY?")    sigClr = C'150,220,150';
         else if (sigTag == "SELL?")   sigClr = C'220,150,150';
         else if (StringFind(sigTag, "CD") == 0) sigClr = C'255,200,0';
         else if (sigTag == "MAX-POS") sigClr = C'255,140,0';
         else                          sigClr = C'160,160,160';   // SCAN
      } else {
         // watch-only: just show RSI from indicator (no scan info)
         int hRsi = iRSI(sym, effTF, RSIPeriod, PRICE_CLOSE);
         double rsiArr[]; ArraySetAsSeries(rsiArr, true);
         if (hRsi != INVALID_HANDLE) {
            if (CopyBuffer(hRsi, 0, 0, 1, rsiArr) > 0) rsi = rsiArr[0];
            IndicatorRelease(hRsi);
         }
      }

      int posCnt = CountPositions(sym);
      string symShort = StringSubstr(sym, 0, 6);
      string line = StringFormat("%-7s %-6s [%s] $%-10s RSI %5.1f P:%d",
                                  symShort, sigTag, RBF,
                                  DoubleToString(bid, digits),
                                  rsi, posCnt);
      DashLabel("WATCH_" + IntegerToString(i), DASH_X+16, y+22 + i*18, line, sigClr, 8);
   }

   // ── System block ──
   y += 100;
   DashRect("SYS_BG", DASH_X+8, y, DASH_W-16, 56,
            C'18,28,40', C'120,80,255', 1);
   DashLabel("SYS_LBL", DASH_X+16, y+5, "SYSTEM", C'170,140,255', 7);

   string webStatus = (StringLen(WebhookURL) > 10) ? StringFormat("WEB %ds OK", WebPushSec) : "WEB OFF";
   color  webClr    = (StringLen(WebhookURL) > 10) ? C'0,255,200' : C'128,128,128';
   string trade_status = eaPaused ? "▮▮ PAUSED" : "▶ TRADING";
   color  tradeClr  = eaPaused ? C'255,140,0' : C'0,255,100';

   DashLabel("SYS_LINE1", DASH_X+16, y+22,
             StringFormat("%s    %s", trade_status, webStatus),
             tradeClr, 8);
   DashLabel("SYS_LINE2", DASH_X+16, y+38,
             StringFormat("%s  Risk %.1f%%  R:R 1:%.1f  %s  Magic %d",
                          ScalpMode ? "⚡SCALP" : "🌊SWING",
                          RiskPercent, effRR, EnumToString(effTF), MagicNumber),
             C'160,160,160', 7);

   // ── Footer signal hunt bar ──
   y += 62;
   double cooldownLeft = 0;
   for (int i = 0; i < nActiveSyms; i++) {
      double remain = (double)(effCooldownMin * 60) - (double)(TimeCurrent() - lastSignalTime[i]);
      if (remain > cooldownLeft) cooldownLeft = remain;
   }
   double cdPct = 1.0 - (cooldownLeft / (effCooldownMin * 60.0));
   string bar = ProgressBar(cdPct, 22);
   DashLabel("CD_BAR", DASH_X+16, y+4, "READY " + bar + " " + IntegerToString((int)(cdPct*100)) + "%",
             cdPct >= 1 ? C'0,255,100' : C'255,230,0', 8, "Consolas");
}

// Cleanup dashboard objects on deinit
void RemoveDashboard() {
   ObjectsDeleteAll(0, DASH_PFX);
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

   // Build symbols list: WatchXAU (if set) + Symbol1 + Symbol2 (if enabled)
   string symList = "";
   if (StringLen(WatchXAU) > 0) symList += "\"" + WatchXAU + "\"";
   if (StringLen(Symbol1) > 0) {
      if (StringLen(symList) > 0) symList += ",";
      symList += "\"" + Symbol1 + "\"";
   }
   if (EnableSymbol2 && StringLen(Symbol2) > 0) {
      if (StringLen(symList) > 0) symList += ",";
      symList += "\"" + Symbol2 + "\"";
   }

   // Phase 12.9: per-symbol enabled state (only first nActiveSyms valid)
   string enabledJson = "[";
   for (int e = 0; e < nActiveSyms; e++) {
      if (e > 0) enabledJson += ",";
      enabledJson += StringFormat("{\"sym\":\"%s\",\"on\":%s}",
                                  symbols[e], runEnabled[e] ? "true" : "false");
   }
   enabledJson += "]";

   string json = StringFormat(
      "{\"type\":\"status\",\"secret\":\"%s\",\"ts\":%d,"
      "\"balance\":%.2f,\"equity\":%.2f,\"freeMargin\":%.2f,"
      "\"todayWins\":%d,\"todayLosses\":%d,\"todayPnL\":%.2f,"
      "\"symbols\":[%s],"
      "\"tradeSymbols\":[\"%s\",\"%s\"],"
      "\"watchSymbols\":[\"%s\"],"
      "\"symEnabled\":%s,"
      "\"mode\":\"%s\","
      "\"paused\":%s,"
      "\"prices\":%s,"
      "\"positions\":[%s]}",
      WebhookSecret, (int)TimeCurrent(),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_MARGIN_FREE),
      tradesToday_W, tradesToday_L, pnlToday,
      symList,
      Symbol1, Symbol2,
      WatchXAU,
      enabledJson,
      (ScalpMode ? "scalp" : "swing"),
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
   // Phase 12.9: per-symbol enable/disable
   else if (StringFind(cmd, "sym_") == 0) {
      // Format: sym_1_on / sym_1_off / sym_2_on / ...
      int idx = (int)StringToInteger(StringSubstr(cmd, 4, 1)) - 1;  // 1→0, 2→1, 3→2
      bool on = (StringFind(cmd, "_on") > 0);
      if (idx >= 0 && idx < MAX_SYMS && idx < nActiveSyms) {
         runEnabled[idx] = on;
         PrintFormat("🎚 REMOTE: Symbol %d (%s) → %s", idx+1, symbols[idx], (on ? "ON" : "OFF"));
      }
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

//═══════════════════ PHASE 12.6: Live Training Loop ═══════════════════
// Capture trade context on entry + send result on close → Web KB learns
void OnTradeTransaction(const MqlTradeTransaction& trans,
                       const MqlTradeRequest& request,
                       const MqlTradeResult& result) {
   if (trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
   if (!HistoryDealSelect(trans.deal)) return;
   if (HistoryDealGetInteger(trans.deal, DEAL_MAGIC) != MagicNumber) return;

   long entryType = HistoryDealGetInteger(trans.deal, DEAL_ENTRY);

   if (entryType == DEAL_ENTRY_IN) {
      // Position OPENING — snapshot context
      CaptureOpenContext(trans.deal);
   }
   else if (entryType == DEAL_ENTRY_OUT) {
      // Position CLOSING — send trade record to web for AI training
      SendTradeRecord(trans.deal);
   }
}

void CaptureOpenContext(ulong dealTicket) {
   string sym = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
   long type  = HistoryDealGetInteger(dealTicket, DEAL_TYPE);
   double entry = HistoryDealGetDouble(dealTicket, DEAL_PRICE);
   ulong posId  = HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);

   // Compute indicator context
   double rsi = 50, bbPos = 0.5;
   double bbU[], bbL[];
   ArraySetAsSeries(bbU, true); ArraySetAsSeries(bbL, true);

   int hRsi = iRSI(sym, effTF, RSIPeriod, PRICE_CLOSE);
   int hBb  = iBands(sym, effTF, BBPeriod, 0, BBDeviation, PRICE_CLOSE);
   if (hRsi != INVALID_HANDLE) {
      double a[]; ArraySetAsSeries(a, true);
      if (CopyBuffer(hRsi, 0, 0, 1, a) > 0) rsi = a[0];
      IndicatorRelease(hRsi);
   }
   if (hBb != INVALID_HANDLE) {
      if (CopyBuffer(hBb, 1, 0, 1, bbU) > 0 && CopyBuffer(hBb, 2, 0, 1, bbL) > 0) {
         double range = bbU[0] - bbL[0];
         if (range > 0) bbPos = (entry - bbL[0]) / range;
      }
      IndicatorRelease(hBb);
   }

   double bal = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskUSD = bal * RiskPercent / 100.0;

   // Get SL from position (just opened)
   double sl = 0;
   if (PositionSelectByTicket(posId)) sl = PositionGetDouble(POSITION_SL);

   // Append to openCtx
   ArrayResize(openCtx, openCtxCount + 1);
   openCtx[openCtxCount].ticket   = posId;
   openCtx[openCtxCount].sym      = sym;
   openCtx[openCtxCount].side     = (type == DEAL_TYPE_BUY) ? "buy" : "sell";
   openCtx[openCtxCount].entry    = entry;
   openCtx[openCtxCount].sl       = sl;
   openCtx[openCtxCount].rsiAtEntry = rsi;
   openCtx[openCtxCount].bbPosAtEntry = bbPos;
   MqlDateTime _tm; TimeToStruct(TimeCurrent(), _tm);
   openCtx[openCtxCount].sessionAtEntry = IsLondonNYSession() ? (_tm.hour < 13 ? "london" : "ny") : "asia";
   openCtx[openCtxCount].openTime = (datetime)HistoryDealGetInteger(dealTicket, DEAL_TIME);
   openCtx[openCtxCount].riskUSD  = riskUSD;
   openCtxCount++;
}

void SendTradeRecord(ulong dealTicket) {
   string sym = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
   double exit = HistoryDealGetDouble(dealTicket, DEAL_PRICE);
   double profit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT)
                  + HistoryDealGetDouble(dealTicket, DEAL_SWAP)
                  + HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
   datetime closeTime = (datetime)HistoryDealGetInteger(dealTicket, DEAL_TIME);
   ulong posId = HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);

   // Find context — match by position ID
   int ctxIdx = -1;
   for (int i = 0; i < openCtxCount; i++) {
      if (openCtx[i].ticket == posId) { ctxIdx = i; break; }
   }

   string side = "?";
   double entry = 0, rsiAtEntry = 50, bbPosAtEntry = 0.5;
   string sessionAtEntry = "?";
   datetime openTime = 0;
   double riskUSD = 0;
   if (ctxIdx >= 0) {
      side           = openCtx[ctxIdx].side;
      entry          = openCtx[ctxIdx].entry;
      rsiAtEntry     = openCtx[ctxIdx].rsiAtEntry;
      bbPosAtEntry   = openCtx[ctxIdx].bbPosAtEntry;
      sessionAtEntry = openCtx[ctxIdx].sessionAtEntry;
      openTime       = openCtx[ctxIdx].openTime;
      riskUSD        = openCtx[ctxIdx].riskUSD;
   }

   // R-multiple = profit / risk_USD
   double rMult = (riskUSD > 0) ? (profit / riskUSD) : (profit > 0 ? 1.0 : -1.0);
   string outcome = profit > 0 ? "win" : (profit < 0 ? "loss" : "breakeven");

   string json = StringFormat(
      "{\"type\":\"trade\",\"secret\":\"%s\","
      "\"sym\":\"%s\",\"side\":\"%s\","
      "\"entry\":%.5f,\"exit\":%.5f,\"profit\":%.2f,\"rMult\":%.3f,"
      "\"outcome\":\"%s\","
      "\"rsiAtEntry\":%.2f,\"bbPosAtEntry\":%.3f,\"sessionAtEntry\":\"%s\","
      "\"openTime\":%d,\"closeTime\":%d,\"posId\":%I64u}",
      WebhookSecret, sym, side, entry, exit, profit, rMult, outcome,
      rsiAtEntry, bbPosAtEntry, sessionAtEntry,
      (int)openTime, (int)closeTime, posId
   );

   PostToBridge(json);

   // Remove from openCtx
   if (ctxIdx >= 0) {
      for (int i = ctxIdx; i < openCtxCount - 1; i++) openCtx[i] = openCtx[i+1];
      openCtxCount--;
      ArrayResize(openCtx, openCtxCount);
   }

   Print(StringFormat("📚 LIVE TRADE recorded: %s %s entry %.5f → exit %.5f | %s %.2fR ($%.2f)",
         sym, side, entry, exit, outcome, rMult, profit));
}

void PostToBridge(string json) {
   if (StringLen(WebhookURL) < 10) return;
   char post[]; StringToCharArray(json, post, 0, StringLen(json));
   char result[]; string headers;
   ResetLastError();
   WebRequest("POST", WebhookURL, "Content-Type: application/json\r\n", 5000, post, result, headers);
}
