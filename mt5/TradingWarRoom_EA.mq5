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

//═══════════════════ GLOBALS ════════════════════════════════════════
CTrade        trade;
CPositionInfo posInfo;

datetime      lastSignalTime[2];
int           rsiHandle[2], bbHandle[2], atrHandle[2];
string        symbols[2];

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
   // Only run on new bar to save CPU
   static datetime lastBar = 0;
   datetime curBar = iTime(Symbol1, Timeframe, 0);
   if (curBar == lastBar) {
      // Still manage open positions every tick
      ManagePositions();
      return;
   }
   lastBar = curBar;

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

   // Get indicator values (3 bars back for context)
   double rsiArr[3], bbU[3], bbM[3], bbL[3], atrArr[3];

   if (CopyBuffer(rsiHandle[idx], 0, 0, 3, rsiArr) != 3) return;
   if (CopyBuffer(bbHandle[idx], 1, 0, 3, bbU)    != 3) return;
   if (CopyBuffer(bbHandle[idx], 0, 0, 3, bbM)    != 3) return;
   if (CopyBuffer(bbHandle[idx], 2, 0, 3, bbL)    != 3) return;
   if (CopyBuffer(atrHandle[idx], 0, 0, 3, atrArr) != 3) return;

   ArraySetAsSeries(rsiArr, true);
   ArraySetAsSeries(bbU, true);
   ArraySetAsSeries(bbM, true);
   ArraySetAsSeries(bbL, true);
   ArraySetAsSeries(atrArr, true);

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
   // Server time is usually broker server time; many brokers use GMT+2 or +3
   // For Exness Demo (server typically GMT+0-3) — adjust if needed
   // London 8-12 UTC, NY 13-17 UTC → broker H = UTC + offset
   // Default: assume broker = UTC, so 8-17
   return (h >= 8 && h < 17);
}
