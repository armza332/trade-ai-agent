/* ═══════════════════════════════════════════════════════
   AI AGENT SYSTEM - All Agents, Teams, Commander
   ═══════════════════════════════════════════════════════ */

/* ─── Base Agent ─── */
class BaseAgent {
  constructor(name, role, icon, team) {
    this.name   = name;
    this.role   = role;
    this.icon   = icon;
    this.team   = team;
    this.signal = 'wait';
    this.conf   = 50;
    this.report = {};
    this.lastLog = '';
  }

  _randFluke(prob = 0.05) { return Math.random() < prob; }
  _conf(base)             { return Math.min(95, Math.max(20, base + Math.floor((Math.random() - 0.5) * 12))); }
}

/* ═══════════════════════════════════════════════════════
   SMC ANALYST — Structure, OB, FVG, BOS/ChoCH
   ═══════════════════════════════════════════════════════ */
class SMCAgent extends BaseAgent {
  constructor(team) {
    super('SMC-Analyst', 'Structure & Order Flow', '⚡', team);
  }

  analyze(data) {
    const { candles } = data;
    const closes  = candles.map(c => c.close);
    const atr     = TA.atr(candles);
    const bos     = TA.bos(candles);
    const fvgs    = TA.fvg(candles);
    const obs     = TA.orderBlocks(candles);
    const struct  = TA.structure(candles);
    const last    = candles.at(-1);

    // Find nearest OB
    const bullOBs = obs.filter(o => o.type === 'bull' && last.close >= o.bot && last.close >= o.top * 0.98);
    const bearOBs = obs.filter(o => o.type === 'bear' && last.close <= o.top && last.close <= o.bot * 1.02);
    const nearOB  = bullOBs.length > 0 ? bullOBs.at(-1) : bearOBs.length > 0 ? bearOBs.at(-1) : null;

    // Nearest FVG
    const bullFVGs = fvgs.filter(f => f.type === 'bull');
    const bearFVGs = fvgs.filter(f => f.type === 'bear');
    const nearFVG  = fvgs.length > 0 ? fvgs.at(-1) : null;

    let score = 0;
    if (struct.trend === 'bullish') score += 20;
    if (struct.trend === 'bearish') score -= 20;
    if (bos.bull && !bos.fake)  score += 25;
    if (bos.bear && !bos.fake)  score -= 25;
    if (bos.bull && bos.fake)   score += 5;
    if (bos.bear && bos.fake)   score -= 5;
    if (nearOB?.type === 'bull') score += 15;
    if (nearOB?.type === 'bear') score -= 15;
    if (bullFVGs.length > 0)    score += 10;
    if (bearFVGs.length > 0)    score -= 10;

    this.signal = score >= 20 ? 'buy' : score <= -20 ? 'sell' : Math.abs(score) < 8 ? 'wait' : 'watch';
    this.conf   = this._conf(50 + Math.abs(score) * 0.4);

    // BOS label
    const bosLabel = bos.bull ? (bos.fake ? 'FAKE BOS ↑' : 'REAL BOS ↑') :
                     bos.bear ? (bos.fake ? 'FAKE BOS ↓' : 'REAL BOS ↓') : 'No BOS';

    this.report = {
      structure: struct.trend.toUpperCase(),
      bos:       bosLabel,
      ob:        nearOB ? `${nearOB.type.toUpperCase()} OB @ ${nearOB.origin.toFixed(data.cfg.digits - 1)}` : 'None nearby',
      fvg:       nearFVG ? `${nearFVG.type.toUpperCase()} FVG [${nearFVG.bot.toFixed(data.cfg.digits-1)}–${nearFVG.top.toFixed(data.cfg.digits-1)}]` : 'No open FVG',
      fvgCount:  `Bull:${bullFVGs.length} Bear:${bearFVGs.length}`,
      atr:       atr.toFixed(data.cfg.digits - 1),
    };

    this.lastLog = `${bosLabel} | ${struct.trend} | ${nearOB ? 'OB hit' : 'No OB'} | FVG: ${fvgs.length}`;
    return { signal: this.signal, conf: this.conf, report: this.report, log: this.lastLog };
  }
}

/* ═══════════════════════════════════════════════════════
   ELLIOTT WAVE ANALYST
   ═══════════════════════════════════════════════════════ */
class ElliottWaveAgent extends BaseAgent {
  constructor(team) {
    super('Elliott-Wave', 'Wave Structure & Count', '🌊', team);
  }

  analyze(data) {
    const { candles } = data;
    const ew     = TA.elliottWave(candles);
    const struct = TA.structure(candles);
    const rsi    = TA.rsi(candles.map(c => c.close));
    const last   = candles.at(-1);

    // Wave 3 and wave 5 are best entries
    const goodWave    = ew.wave === 'Wave 3' || ew.wave === 'Wave 1' || ew.wave === 'Wave 5';
    const corrWave    = ew.wave === 'Wave 4' || ew.wave === 'Wave 2';
    const biasBull    = ew.bias === 'bullish';
    const biasStruct  = struct.trend === 'bullish';

    let score = 0;
    if (goodWave && biasBull && biasStruct)  score += 35;
    if (goodWave && !biasBull && !biasStruct) score -= 35;
    if (corrWave) score += biasBull ? -10 : 10;
    if (ew.stage === 'Extension') score += biasBull ? 15 : -15;

    this.signal = score >= 25 ? 'buy' : score <= -25 ? 'sell' : 'wait';
    this.conf   = this._conf(ew.confidence);

    this.report = {
      wave:     ew.wave,
      stage:    ew.stage,
      bias:     ew.bias.charAt(0).toUpperCase() + ew.bias.slice(1),
      impulse:  `Impulse moves: ${ew.impulse}`,
      rsi:      `RSI ${rsi.toFixed(1)}`,
      action:   corrWave ? 'Wait for Wave completion' : goodWave ? 'Momentum active' : 'Unclear structure',
    };

    this.lastLog = `${ew.wave} | ${ew.stage} | Bias: ${ew.bias} | Conf: ${this.conf}%`;
    return { signal: this.signal, conf: this.conf, report: this.report, log: this.lastLog };
  }
}

/* ═══════════════════════════════════════════════════════
   FIBONACCI ANALYST
   ═══════════════════════════════════════════════════════ */
class FibonacciAgent extends BaseAgent {
  constructor(team) {
    super('Fibonacci', 'Fib Retracement & Extension', '📐', team);
  }

  analyze(data) {
    const { candles, cfg } = data;
    const n = candles.length;
    if (n < 20) return { signal: 'wait', conf: 30, report: {}, log: 'Insufficient data' };

    // Find recent swing high/low from last 50 bars
    const recent = candles.slice(-50);
    const swHigh = Math.max(...recent.map(c => c.high));
    const swLow  = Math.min(...recent.map(c => c.low));
    const last   = candles.at(-1);
    const struct = TA.structure(candles);
    const fibs   = TA.fibLevels(swHigh, swLow);
    const range  = swHigh - swLow;

    // Find nearest fib level
    const fibKeys = ['0.236', '0.382', '0.5', '0.618', '0.786'];
    let nearestFib = null, nearestDist = Infinity;
    fibKeys.forEach(k => {
      const dist = Math.abs(last.close - fibs[k]);
      if (dist < nearestDist) { nearestDist = dist; nearestFib = k; }
    });

    const nearPct   = (nearestDist / range * 100).toFixed(1);
    const atSupport = struct.trend === 'bullish' && parseFloat(nearestFib) >= 0.5;
    const atResist  = struct.trend === 'bearish' && parseFloat(nearestFib) <= 0.5;
    const golden    = nearestFib === '0.618';
    const halfBack  = nearestFib === '0.5';
    const shallow   = nearestFib === '0.236' || nearestFib === '0.382';

    let score = 0;
    if (atSupport && golden)  score += 40;
    if (atSupport && halfBack) score += 25;
    if (atSupport && shallow)  score += 15;
    if (atResist  && golden)  score -= 40;
    if (atResist  && halfBack) score -= 25;
    if (atResist  && shallow)  score -= 15;
    if (nearPct > 2) score = score * 0.5; // Far from level = weak signal

    this.signal = score >= 20 ? 'buy' : score <= -20 ? 'sell' : 'watch';
    this.conf   = this._conf(50 + Math.abs(score) * 0.5);

    // Extension targets
    const tp1 = struct.trend === 'bullish' ? fibs['1.272'] : fibs['1'];
    const tp2 = struct.trend === 'bullish' ? fibs['1.618'] : fibs['0'];
    const sl  = struct.trend === 'bullish' ? swLow - range * 0.05 : swHigh + range * 0.05;
    const rr  = range > 0 ? ((Math.abs(tp1 - last.close)) / Math.max(0.001, Math.abs(last.close - sl))).toFixed(2) : '?';

    this.report = {
      swHigh:  swHigh.toFixed(cfg.digits - 1),
      swLow:   swLow.toFixed(cfg.digits - 1),
      nearest: `@ ${nearestFib} (${nearPct}% away)`,
      level:   fibs[nearestFib]?.toFixed(cfg.digits - 1) ?? '--',
      tp1:     tp1.toFixed(cfg.digits - 1),
      tp2:     tp2.toFixed(cfg.digits - 1),
      sl:      sl.toFixed(cfg.digits - 1),
      rr:      `1:${rr}`,
      golden:  golden ? '✅ Golden Zone' : '○ Not golden',
    };

    this.lastLog = `Price at Fib ${nearestFib} (${nearPct}% away) | ${atSupport ? 'Support' : atResist ? 'Resistance' : 'Mid-range'} | R:R ${rr}`;
    return { signal: this.signal, conf: this.conf, report: this.report, log: this.lastLog };
  }
}

/* ═══════════════════════════════════════════════════════
   RSI / VALUE ANALYST
   ═══════════════════════════════════════════════════════ */
class RSIValueAgent extends BaseAgent {
  constructor(team) {
    super('RSI-Value', 'Momentum & Value Analysis', '📊', team);
  }

  analyze(data) {
    const { candles, cfg } = data;
    const closes = candles.map(c => c.close);
    const rsi14  = TA.rsi(closes, 14);
    const rsi7   = TA.rsi(closes, 7);
    const adx    = TA.adx(candles);
    const div    = TA.divergence(candles);
    const vp     = TA.volumeProfile(candles.slice(-50));
    const last   = candles.at(-1);
    const struct = TA.structure(candles);

    const overbought = rsi14 >= 70;
    const oversold   = rsi14 <= 30;
    const bullZone   = rsi14 >= 40 && rsi14 <= 60;
    const trending   = adx >= 22;
    const strongTrend= adx >= 30;

    const atPOC = Math.abs(last.close - vp.poc) < TA.atr(candles) * 0.5;
    const aboveVAH = last.close > vp.vah;
    const belowVAL = last.close < vp.val;

    let score = 0;
    if (oversold   && struct.trend === 'bullish') score += 35;
    if (overbought && struct.trend === 'bearish') score -= 35;
    if (div === 'bullish') score += 25;
    if (div === 'bearish') score -= 25;
    if (bullZone   && trending)                  score += 10;
    if (aboveVAH   && struct.trend === 'bullish') score += 10;
    if (belowVAL   && struct.trend === 'bearish') score -= 10;
    if (atPOC)                                    score += 5;

    this.signal = score >= 25 ? 'buy' : score <= -25 ? 'sell' : Math.abs(score) < 10 ? 'wait' : 'watch';
    this.conf   = this._conf(50 + Math.abs(score) * 0.45);

    const rsiState = overbought ? '⚠️ OB' : oversold ? '⚠️ OS' : bullZone ? '✓ Normal' : '○ Mid';

    this.report = {
      rsi14:  `${rsi14.toFixed(1)} — ${rsiState}`,
      rsi7:   rsi7.toFixed(1),
      adx:    `${adx} — ${adx >= 30 ? 'Strong' : adx >= 22 ? 'Trend' : 'Weak'}`,
      div:    div === 'none' ? 'No divergence' : `⚠️ ${div.charAt(0).toUpperCase() + div.slice(1)} Divergence`,
      poc:    vp.poc.toFixed(cfg.digits - 1),
      vah:    vp.vah.toFixed(cfg.digits - 1),
      val:    vp.val.toFixed(cfg.digits - 1),
      pos:    atPOC ? 'At POC' : aboveVAH ? 'Above VAH' : belowVAL ? 'Below VAL' : 'In Value',
    };

    this.lastLog = `RSI ${rsi14.toFixed(1)} | ADX ${adx} | ${div !== 'none' ? div + ' divergence' : 'No divergence'} | ${this.report.pos}`;
    return { signal: this.signal, conf: this.conf, report: this.report, log: this.lastLog };
  }
}

/* ═══════════════════════════════════════════════════════
   NEWS ANALYST — Economic Calendar Simulation
   ═══════════════════════════════════════════════════════ */
class NewsAgent extends BaseAgent {
  constructor(team, pairs) {
    super('News-Intel', 'Economic Events & Sentiment', '📰', team);
    this.pairs = pairs; // e.g. ['XAU','USD'] or ['AUD','EUR','USD']
  }

  _generateEvents() {
    const now  = new Date();
    const base = [
      { time: '08:30', event: 'USD Core PCE m/m',          impact: 'high',   bias: 'bearish', curr: 'USD' },
      { time: '09:00', event: 'EUR CPI y/y Flash',          impact: 'high',   bias: 'bullish', curr: 'EUR' },
      { time: '10:00', event: 'GBP Manufacturing PMI',      impact: 'medium', bias: 'neutral', curr: 'GBP' },
      { time: '12:30', event: 'USD Initial Jobless Claims',  impact: 'high',   bias: 'neutral', curr: 'USD' },
      { time: '14:00', event: 'AUD RBA Meeting Minutes',     impact: 'high',   bias: 'hawkish', curr: 'AUD' },
      { time: '15:30', event: 'USD GDP q/q Second Estimate', impact: 'high',   bias: 'bullish', curr: 'USD' },
      { time: '17:00', event: 'EUR ECB Rate Decision',       impact: 'high',   bias: 'bearish', curr: 'EUR' },
      { time: '21:30', event: 'AUD CPI q/q',                 impact: 'high',   bias: 'neutral', curr: 'AUD' },
      { time: '23:00', event: 'XAU/Gold Technical Support',  impact: 'medium', bias: 'bullish', curr: 'XAU' },
    ];

    // Filter by relevant currencies for this team
    return base.filter(e => this.pairs.some(p => e.curr.includes(p))).slice(0, 4);
  }

  analyze() {
    const events = this._generateEvents();
    const session = TA.session();
    const h = new Date().getUTCHours();

    let bias = 0;
    events.forEach(e => {
      const w = e.impact === 'high' ? 3 : e.impact === 'medium' ? 2 : 1;
      if (e.bias === 'bullish' || e.bias === 'hawkish') bias += w;
      if (e.bias === 'bearish' || e.bias === 'dovish')  bias -= w;
    });

    const highImpact = events.filter(e => e.impact === 'high').length;
    const nearEvent  = events.some(e => {
      const [eh] = e.time.split(':').map(Number);
      return Math.abs(eh - h) <= 1;
    });

    let riskLevel = 'LOW';
    if (highImpact >= 2 || nearEvent) riskLevel = 'HIGH';
    else if (highImpact >= 1) riskLevel = 'MED';

    this.signal = riskLevel === 'HIGH' ? 'watch' :
                  bias >= 4 ? 'buy' : bias <= -4 ? 'sell' : 'wait';
    this.conf   = this._conf(50 + Math.min(25, Math.abs(bias) * 5));

    const biasTxt = bias >= 4 ? '🟢 Bullish' : bias <= -4 ? '🔴 Bearish' : '⚪ Neutral';

    this.report = {
      events,
      session:   `${session.flag} ${session.name} (${session.active ? 'ACTIVE' : 'OFF'})`,
      bias:      biasTxt,
      risk:      `${riskLevel} — ${highImpact} high-impact events`,
      nearEvent: nearEvent ? '⚠️ Event within 1h!' : '✓ No immediate events',
    };

    this.lastLog = `Session: ${session.name} | Bias: ${biasTxt} | Risk: ${riskLevel} | ${nearEvent ? '⚠️ Near event' : 'Clear'}`;
    return { signal: this.signal, conf: this.conf, report: this.report, log: this.lastLog };
  }
}

/* ═══════════════════════════════════════════════════════
   HEAD AGENT — Team Leader, Aggregates Analysts
   ═══════════════════════════════════════════════════════ */
class HeadAgent extends BaseAgent {
  constructor(name, team, symbol) {
    super(name, `${team} Team Leader`, '👑', team);
    this.symbol  = symbol;
    this.analysts = [];
  }

  addAnalyst(agent) { this.analysts.push(agent); }

  aggregate(results) {
    const weights = { 'buy': 1, 'sell': -1, 'watch': 0, 'wait': 0 };
    let weightedScore = 0, totalWeight = 0;

    results.forEach(r => {
      if (!r) return;
      const w = (r.conf / 100) * (r.signal === 'buy' || r.signal === 'sell' ? 1.5 : 0.5);
      weightedScore += (weights[r.signal] ?? 0) * r.conf * w;
      totalWeight   += r.conf * w;
    });

    const normalized = totalWeight > 0 ? weightedScore / totalWeight : 0;

    // Count votes
    const votes = { buy: 0, sell: 0, wait: 0, watch: 0 };
    results.forEach(r => { if (r) votes[r.signal] = (votes[r.signal] || 0) + 1; });

    const signal = normalized >= 0.3 ? 'buy' :
                   normalized <= -0.3 ? 'sell' :
                   Math.abs(normalized) < 0.1 ? 'wait' : 'watch';

    const conf = Math.min(90, Math.abs(normalized) * 100 + 30);

    this.signal = signal;
    this.conf   = Math.round(conf);

    return { signal, conf: Math.round(conf), votes, normalized, analysts: results };
  }
}

/* ═══════════════════════════════════════════════════════
   GOLD TEAM — XAUUSD
   ═══════════════════════════════════════════════════════ */
class GoldTeam {
  constructor() {
    this.name    = 'GOLD TEAM';
    this.symbol  = 'XAUUSD';
    this.icon    = '🥇';
    this.color   = 'gold';
    this.head    = new HeadAgent('Maj.Gold', 'GOLD', 'XAUUSD');
    this.smc     = new SMCAgent('GOLD');
    this.elliott = new ElliottWaveAgent('GOLD');
    this.fib     = new FibonacciAgent('GOLD');
    this.rsi     = new RSIValueAgent('GOLD');
    this.news    = new NewsAgent('GOLD', ['XAU', 'USD']);

    this.head.addAnalyst(this.smc);
    this.head.addAnalyst(this.elliott);
    this.head.addAnalyst(this.fib);
    this.head.addAnalyst(this.rsi);
  }

  analyze(data) {
    const smcR = this.smc.analyze(data);
    const ewR  = this.elliott.analyze(data);
    const fibR = this.fib.analyze(data);
    const rsiR = this.rsi.analyze(data);
    const newsR= this.news.analyze();

    const agg  = this.head.aggregate([smcR, ewR, fibR, rsiR, newsR]);

    return {
      team: this.name, symbol: this.symbol, icon: this.icon, color: this.color,
      head: { signal: agg.signal, conf: agg.conf, votes: agg.votes },
      agents: { smc: smcR, elliott: ewR, fib: fibR, rsi: rsiR, news: newsR },
      price: data.price,
      cfg:   data.cfg,
    };
  }
}

/* ═══════════════════════════════════════════════════════
   CURRENCY TEAM — AUDUSD + EURUSD
   ═══════════════════════════════════════════════════════ */
class CurrencyTeam {
  constructor() {
    this.name    = 'CURRENCY TEAM';
    this.symbols = ['AUDUSD', 'EURUSD'];
    this.icon    = '💱';
    this.color   = 'teal';

    // AUDUSD sub-analysts
    this.aud = {
      head:    new HeadAgent('Lt.AUD', 'AUDUSD', 'AUDUSD'),
      smc:     new SMCAgent('AUDUSD'),
      elliott: new ElliottWaveAgent('AUDUSD'),
      fib:     new FibonacciAgent('AUDUSD'),
      rsi:     new RSIValueAgent('AUDUSD'),
    };

    // EURUSD sub-analysts
    this.eur = {
      head:    new HeadAgent('Lt.EUR', 'EURUSD', 'EURUSD'),
      smc:     new SMCAgent('EURUSD'),
      elliott: new ElliottWaveAgent('EURUSD'),
      fib:     new FibonacciAgent('EURUSD'),
      rsi:     new RSIValueAgent('EURUSD'),
    };

    this.news    = new NewsAgent('CURRENCY', ['AUD', 'EUR', 'USD']);
    this.head    = new HeadAgent('Maj.FX', 'CURRENCY', 'FX');

    [this.aud, this.eur].forEach(t => {
      t.head.addAnalyst(t.smc);
      t.head.addAnalyst(t.elliott);
      t.head.addAnalyst(t.fib);
      t.head.addAnalyst(t.rsi);
    });
  }

  analyze(audData, eurData) {
    // AUD analysis
    const audSMC = this.aud.smc.analyze(audData);
    const audEW  = this.aud.elliott.analyze(audData);
    const audFib = this.aud.fib.analyze(audData);
    const audRSI = this.aud.rsi.analyze(audData);
    const audAgg = this.aud.head.aggregate([audSMC, audEW, audFib, audRSI]);

    // EUR analysis
    const eurSMC = this.eur.smc.analyze(eurData);
    const eurEW  = this.eur.elliott.analyze(eurData);
    const eurFib = this.eur.fib.analyze(eurData);
    const eurRSI = this.eur.rsi.analyze(eurData);
    const eurAgg = this.eur.head.aggregate([eurSMC, eurEW, eurFib, eurRSI]);

    const newsR = this.news.analyze();

    // Overall team decision (best opportunity between AUD and EUR)
    const combined = this.head.aggregate([
      { signal: audAgg.signal, conf: audAgg.conf },
      { signal: eurAgg.signal, conf: eurAgg.conf },
      newsR,
    ]);

    // Determine which pair has better setup
    const leadPair = audAgg.conf >= eurAgg.conf ? 'AUDUSD' : 'EURUSD';

    return {
      team: this.name, symbols: this.symbols, icon: this.icon, color: this.color,
      head:   { signal: combined.signal, conf: combined.conf, votes: combined.votes, leadPair },
      aud:    { signal: audAgg.signal, conf: audAgg.conf, votes: audAgg.votes, price: audData.price, cfg: audData.cfg,
                agents: { smc: audSMC, elliott: audEW, fib: audFib, rsi: audRSI } },
      eur:    { signal: eurAgg.signal, conf: eurAgg.conf, votes: eurAgg.votes, price: eurData.price, cfg: eurData.cfg,
                agents: { smc: eurSMC, elliott: eurEW, fib: eurFib, rsi: eurRSI } },
      news:   newsR,
    };
  }
}

/* ═══════════════════════════════════════════════════════
   COMMANDER — Final Orchestrator
   ═══════════════════════════════════════════════════════ */
class Commander {
  constructor() {
    this.name = 'Commander';
    this.rank = 'GENERAL';
  }

  decide(goldReport, currReport) {
    const goldConf  = goldReport.head.conf;
    const currConf  = currReport.head.conf;
    const goldSig   = goldReport.head.signal;
    const currSig   = currReport.head.signal;

    // Pick highest-confidence actionable signal
    let primary = null;
    if ((goldSig === 'buy' || goldSig === 'sell') && goldConf >= 50) {
      primary = { sym: 'XAUUSD', signal: goldSig, conf: goldConf, price: goldReport.price, cfg: goldReport.cfg };
    }
    if ((currSig === 'buy' || currSig === 'sell') && currConf >= (primary?.conf ?? 0)) {
      const fxSym = currReport.head.leadPair;
      const fxData = fxSym === 'AUDUSD' ? currReport.aud : currReport.eur;
      primary = { sym: fxSym, signal: currSig, conf: currConf, price: fxData.price, cfg: fxData.cfg };
    }

    if (!primary) {
      primary = { sym: 'ALL', signal: 'wait', conf: 30, price: goldReport.price, cfg: goldReport.cfg };
    }

    const { sym, signal, conf, price, cfg } = primary;
    const atr   = cfg.atr;
    const rr    = 1.5 + (conf / 100);
    const sl    = signal === 'buy'  ? price - atr * 1.5  : price + atr * 1.5;
    const tp1   = signal === 'buy'  ? price + atr * rr   : price - atr * rr;
    const tp2   = signal === 'buy'  ? price + atr * rr * 2 : price - atr * rr * 2;
    const posSize = Math.min(2, (conf / 100) * 1.5).toFixed(1);
    const rrRatio = (Math.abs(tp1 - price) / Math.max(0.0001, Math.abs(sl - price))).toFixed(2);
    const d = cfg.digits - 1;

    // Aggregate votes from all analysts
    const allVotes = {
      SMC:     this._pickVote(goldReport.agents?.smc?.signal, currReport.aud?.agents?.smc?.signal),
      Elliott: this._pickVote(goldReport.agents?.elliott?.signal, currReport.aud?.agents?.elliott?.signal),
      Fib:     this._pickVote(goldReport.agents?.fib?.signal, currReport.aud?.agents?.fib?.signal),
      RSI:     this._pickVote(goldReport.agents?.rsi?.signal, currReport.aud?.agents?.rsi?.signal),
      News:    goldReport.agents?.news?.signal ?? 'wait',
    };

    return {
      signal, sym, conf,
      entry:  price.toFixed(d),
      sl:     sl.toFixed(d),
      tp1:    tp1.toFixed(d),
      tp2:    tp2.toFixed(d),
      rr:     `1:${rrRatio}`,
      pos:    `${posSize}%`,
      votes:  allVotes,
      goldSig, goldConf, currSig, currConf,
      summary: signal === 'wait' || signal === 'watch'
        ? `⏸ STANDBY — No high-confidence setup detected`
        : `${signal.toUpperCase()} ${sym} @ ${price.toFixed(d)} | SL ${sl.toFixed(d)} | TP1 ${tp1.toFixed(d)}`,
    };
  }

  _pickVote(g, c) {
    if (!g && !c) return 'wait';
    if (!c) return g;
    if (!g) return c;
    if (g === c) return g;
    if ((g === 'buy' && c === 'sell') || (g === 'sell' && c === 'buy')) return 'watch';
    return g === 'wait' ? c : g;
  }
}

if (typeof module !== 'undefined') {
  module.exports = { SMCAgent, ElliottWaveAgent, FibonacciAgent, RSIValueAgent, NewsAgent, HeadAgent, GoldTeam, CurrencyTeam, Commander };
}
