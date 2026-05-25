/* ═══════════════════════════════════════════════════════
   TRADING WAR ROOM — Main Application Controller
   ═══════════════════════════════════════════════════════ */

const TradingWarRoom = {
  market:    null,
  goldTeam:  null,
  fxTeam:    null,
  commander: null,

  prevPrices: {},
  tickCount:  0,
  updateMs:   4000,   // full analysis refresh
  tickMs:     800,    // price tick

  init() {
    // Create market engine + teams
    this.market    = new MarketEngine();
    this.goldTeam  = new GoldTeam();
    this.fxTeam    = new CurrencyTeam();
    this.commander = new Commander();

    // First render
    this.fullUpdate();
    UI.updateClock();

    // Schedule updates
    setInterval(() => this.priceTick(),   this.tickMs);
    setInterval(() => this.fullUpdate(),  this.updateMs);
    setInterval(() => UI.updateClock(),   1000);

    // Real-price feed loop (separate cadence to respect API rate limits)
    this._realPriceLoop();

    // Mark live
    document.getElementById('live-status').textContent = 'LIVE';
    this._log('CMD', 'Commander', '🟢 Trading War Room initialized. All agents ONLINE.');
    this._log('GOLD', 'Maj.Gold', '⚡ GOLD TEAM ready — monitoring XAUUSD.');
    this._log('FX', 'Maj.FX', '💱 CURRENCY TEAM ready — monitoring AUDUSD & EURUSD.');
  },

  priceTick() {
    this.market.tick();
    this.tickCount++;

    const prices = {
      XAUUSD: this.market.prices.XAUUSD,
      AUDUSD: this.market.prices.AUDUSD,
      EURUSD: this.market.prices.EURUSD,
    };

    UI.updateTicker(prices);
    UI.updatePriceTags(prices, this.prevPrices);

    // Update header prices
    const xauEl = document.getElementById('price-xau');
    const audEl = document.getElementById('price-aud');
    const eurEl = document.getElementById('price-eur');
    if (xauEl) xauEl.querySelector('.val').textContent = prices.XAUUSD.toFixed(2);
    if (audEl) audEl.querySelector('.val').textContent = prices.AUDUSD.toFixed(4);
    if (eurEl) eurEl.querySelector('.val').textContent = prices.EURUSD.toFixed(4);
  },

  fullUpdate() {
    const goldData = this.market.getData('XAUUSD');
    const audData  = this.market.getData('AUDUSD');
    const eurData  = this.market.getData('EURUSD');

    // Run teams
    const goldR = this.goldTeam.analyze(goldData);
    const fxR   = this.fxTeam.analyze(audData, eurData);
    const cmdR  = this.commander.decide(goldR, fxR);

    // Grade the signal
    const gradeInfo = SignalGrade.grade(cmdR, goldR, fxR);
    cmdR.gradeInfo = gradeInfo;

    // Render UI
    UI.renderGoldTeam(goldR);
    UI.renderCurrencyTeam(fxR);
    UI.renderCommander(cmdR);

    // Render big banner + grade badge
    SignalGrade.renderBanner(cmdR, gradeInfo);

    // Save prices
    this.prevPrices = { ...this.market.prices };

    // Log significant changes
    this._logAgentUpdates(goldR, fxR, cmdR);

    // Flash + sound + telegram on strong signal
    if (gradeInfo.alert) {
      const banner = document.getElementById('alert-banner');
      if (banner && this._lastGrade !== gradeInfo.grade) {
        SignalGrade.playSound(gradeInfo);
        Telegram.notify(cmdR, gradeInfo);
        UI.addLog('CMD', 'Commander', `🚨 GRADE ${gradeInfo.grade} — ${cmdR.signal.toUpperCase()} ${cmdR.sym} @ ${cmdR.entry}`);
      }
      this._lastGrade = gradeInfo.grade;
    } else {
      this._lastGrade = null;
    }

    if (cmdR.signal === 'buy' || cmdR.signal === 'sell') {
      const cmdEl = document.getElementById('commander-panel');
      if (cmdEl) {
        cmdEl.classList.add('alert-flash');
        setTimeout(() => cmdEl.classList.remove('alert-flash'), 1500);
      }
    }
  },

  _logAgentUpdates(goldR, fxR, cmdR) {
    const logQueue = [
      { team:'GOLD', agent:'SMC-Gold',    msg: goldR.agents.smc.log },
      { team:'GOLD', agent:'Elliott-Gold', msg: goldR.agents.elliott.log },
      { team:'GOLD', agent:'Fib-Gold',     msg: goldR.agents.fib.log },
      { team:'GOLD', agent:'RSI-Gold',     msg: goldR.agents.rsi.log },
      { team:'FX',   agent:'SMC-AUD',      msg: fxR.aud?.agents?.smc?.log },
      { team:'FX',   agent:'SMC-EUR',      msg: fxR.eur?.agents?.smc?.log },
      { team:'FX',   agent:'News-FX',      msg: fxR.news?.log },
      { team:'CMD',  agent:'Commander',    msg: cmdR.summary },
    ];

    // Rotate through logs (show 2-3 per update to avoid flooding)
    const start = (this.tickCount * 3) % logQueue.length;
    const show  = logQueue.slice(start, start + 3);
    show.forEach(l => { if (l.msg) this._log(l.team, l.agent, l.msg); });
  },

  _log(team, agent, msg) {
    UI.addLog(team, agent, msg);
  },

  async _realPriceLoop() {
    const refresh = async () => {
      if (!Settings.get('priceFeedOn')) return;
      const onApps = this.market._onAppsScript();
      const key    = Settings.get('priceApiKey');
      if (!onApps && !key) return;

      try {
        const px = await this.market.fetchRealPrices(key);
        if (px && isFinite(px.XAUUSD) && isFinite(px.AUDUSD) && isFinite(px.EURUSD)) {
          this.market.applyRealPrices(px);
          this._log('CMD', 'PriceFeed', `📡 Real prices: XAU ${px.XAUUSD.toFixed(2)} | AUD ${px.AUDUSD.toFixed(4)} | EUR ${px.EURUSD.toFixed(4)}`);
        }
      } catch (e) { /* silent */ }
    };

    // Initial fetch shortly after boot, then on Settings cadence
    setTimeout(refresh, 2000);
    setInterval(() => refresh(), Math.max(60, Settings.get('priceRefreshSec', 120)) * 1000);
  },
};

// Boot when DOM ready
document.addEventListener('DOMContentLoaded', () => {
  TradingWarRoom.init();
});
