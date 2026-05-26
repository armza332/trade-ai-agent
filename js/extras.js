/* ═══════════════════════════════════════════════════════
   EXTRAS — Signal Grading + Telegram + Settings + Help
   ═══════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════
   CONFLUENCE — Category-based multi-technique agreement
   วิเคราะห์ว่าเทคนิคหลายประเภทเห็นด้วยกับสัญญาณไหม
   เหมือนกับ trader จริงดู trend + momentum + structure + pattern พร้อมกัน
   ═══════════════════════════════════════════════════════ */
const Confluence = {
  CATEGORIES: {
    TREND:     { icon: '📈', agents: ['mtf', 'elliott'] },
    MOMENTUM:  { icon: '⚡', agents: ['macd', 'rsi'] },
    STRUCTURE: { icon: '🏛', agents: ['smc', 'fib', 'pivot', 'bollinger'] },
    PATTERN:   { icon: '🕯', agents: ['pattern'] },
    SENTIMENT: { icon: '📰', agents: ['news'] },
  },

  /** Returns breakdown of category alignment with the given signal */
  analyze(agents, signal) {
    if (!agents || (signal !== 'buy' && signal !== 'sell')) {
      return { score: 0, aligned: 0, total: 0, breakdown: {}, label: '— Wait' };
    }
    const breakdown = {};
    let alignedCats = 0, totalCats = 0;

    for (const [cat, def] of Object.entries(this.CATEGORIES)) {
      const live = def.agents.map(name => agents[name]).filter(Boolean);
      if (live.length === 0) continue;
      totalCats++;
      const agree = live.filter(a => a.signal === signal).length;
      const dissent = live.filter(a => a.signal === (signal === 'buy' ? 'sell' : 'buy')).length;
      const aligned = agree > dissent && agree >= 1;
      if (aligned) alignedCats++;
      breakdown[cat] = {
        icon: def.icon,
        active: live.length,
        agree, dissent,
        aligned,
      };
    }

    const score = totalCats > 0 ? alignedCats / totalCats : 0;
    const label =
      score >= 0.8 ? '🟢 STRONG'    :
      score >= 0.6 ? '🟡 GOOD'      :
      score >= 0.4 ? '🟠 PARTIAL'   :
                     '🔴 WEAK';
    return { score, aligned: alignedCats, total: totalCats, breakdown, label };
  },

  /** Adjust grade based on confluence — boost or demote */
  adjustGrade(originalGrade, confluenceScore) {
    const order = ['D', 'C', 'B', 'A', 'S+'];
    let idx = order.indexOf(originalGrade);
    if (idx < 0) return originalGrade;
    if (confluenceScore >= 0.8) idx = Math.min(order.length - 1, idx + 1); // boost
    if (confluenceScore < 0.4)  idx = Math.max(0, idx - 1);                // demote
    return order[idx];
  },

  /** Render UI block for Commander panel */
  render(c) {
    if (!c || c.total === 0) return '';
    const rows = Object.entries(c.breakdown).map(([cat, d]) => {
      const mark = d.aligned ? '✅' : (d.dissent > d.agree ? '❌' : '⚪');
      const cls  = d.aligned ? 'text-green' : (d.dissent > d.agree ? 'text-red' : 'text-gray');
      return `<div class="row" style="font-size:6px">
        <span class="lbl">${d.icon} ${cat}</span>
        <span class="val ${cls}">${mark} ${d.agree}/${d.active}</span>
      </div>`;
    }).join('');
    return `<div style="margin-top:8px">
      <div class="cmd-section-title" style="font-size:7px;color:var(--gold)">⚖ CONFLUENCE — ${c.label} (${c.aligned}/${c.total})</div>
      <div class="trade-params">${rows}</div>
    </div>`;
  },
};
window.Confluence = Confluence;

/* ─── Signal Grading System ─── */
const SignalGrade = {

  /**
   * Grade a Commander signal:
   *   S+ = 90%+ Strong  (BIG ALERT, push Telegram)
   *   A  = 80–89%       (high confidence, push Telegram)
   *   B  = 65–79%       (good setup, watchlist)
   *   C  = 50–64%       (mediocre)
   *   D  = below 50%    (skip)
   */
  grade(cmdReport, goldReport, currReport) {
    const conf      = cmdReport.conf;
    const signal    = cmdReport.signal;
    const allAgents = [
      goldReport.agents.smc, goldReport.agents.elliott, goldReport.agents.fib, goldReport.agents.rsi,
      currReport.aud?.agents?.smc, currReport.aud?.agents?.elliott,
      currReport.eur?.agents?.smc, currReport.eur?.agents?.elliott,
    ].filter(Boolean);

    // Count how many agents AGREE with the final signal
    const agree = allAgents.filter(a => a.signal === signal).length;
    const total = allAgents.length;
    const consensus = total > 0 ? agree / total : 0;

    // Final score = confidence × consensus
    const finalScore = conf * (0.5 + consensus * 0.5);

    let grade, color, alert, sound;
    if (signal === 'wait' || signal === 'watch' || finalScore < 50) {
      grade = 'D'; color = '#555577'; alert = false; sound = false;
    } else if (finalScore >= 88) {
      grade = 'S+'; color = '#ff00ff'; alert = true; sound = true;
    } else if (finalScore >= 80) {
      grade = 'A';  color = '#00ff41'; alert = true; sound = true;
    } else if (finalScore >= 65) {
      grade = 'B';  color = '#ffe600'; alert = false; sound = false;
    } else {
      grade = 'C';  color = '#ff8c00'; alert = false; sound = false;
    }

    return {
      grade, color, alert, sound,
      conf,
      consensus: Math.round(consensus * 100),
      agree, total,
      finalScore: Math.round(finalScore),
    };
  },

  /** Render the big alert banner */
  renderBanner(cmdReport, gradeInfo) {
    const el = document.getElementById('alert-banner');
    if (!el) return;

    if (!gradeInfo.alert) {
      el.style.display = 'none';
      return;
    }

    const isB = cmdReport.signal === 'buy';
    const arrow = isB ? '▲' : '▼';
    const sigClass = isB ? 'buy' : 'sell';

    el.style.display = 'flex';
    el.className = `alert-banner ${sigClass}`;
    el.innerHTML = `
      <div class="banner-grade" style="background:${gradeInfo.color};color:#000">
        ${gradeInfo.grade}
      </div>
      <div class="banner-text">
        <div class="banner-action">${arrow} ${cmdReport.signal.toUpperCase()} ${cmdReport.sym}</div>
        <div class="banner-detail">
          ENTRY ${cmdReport.entry} • SL ${cmdReport.sl} • TP1 ${cmdReport.tp1} • R:R ${cmdReport.rr}
        </div>
        <div class="banner-meta">
          Confidence ${cmdReport.conf}% • Consensus ${gradeInfo.agree}/${gradeInfo.total} agents agree • Score ${gradeInfo.finalScore}
        </div>
      </div>
      <div class="banner-cta">
        ${gradeInfo.grade === 'S+' ? '🚨 STRONG SIGNAL' : '⚡ HIGH PROBABILITY'}
      </div>
    `;
  },

  /** Render grade badge in commander panel */
  renderGradeBadge(gradeInfo) {
    return `<div class="grade-badge" style="border-color:${gradeInfo.color};color:${gradeInfo.color}">
      <div class="grade-letter">${gradeInfo.grade}</div>
      <div class="grade-score">${gradeInfo.finalScore}/100</div>
    </div>`;
  },

  /** Play sound alert */
  playSound(gradeInfo) {
    if (!gradeInfo.sound) return;
    if (!Settings.get('sound', true)) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = gradeInfo.grade === 'S+' ? 880 : 660;
      gain.gain.value = 0.05;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(440, ctx.currentTime + 0.1);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.2);
      setTimeout(() => { osc.stop(); ctx.close(); }, 350);
    } catch (e) { /* ignore */ }
  },
};

/* ═══════════════════════════════════════════════════════
   SETTINGS — localStorage backed
   ═══════════════════════════════════════════════════════ */
const Settings = {
  KEY: 'twr_settings',
  defaults: {
    telegramToken:  '',
    telegramChatId: '',
    telegramOn:     false,
    minGrade:       'A',
    sound:          true,
    cooldownMin:    5,
    priceApiKey:    '',
    priceFeedOn:    false,
    priceRefreshSec: 300,    // 5 นาที (เดิม 2 นาที — ลดการใช้ API)
    apiSaver:        true,   // throttle aggressive
    tradeMode:      'swing',  // scalp | swing | position
    enableXAU:      true,
    enableAUD:      true,
    enableEUR:      true,
    adxGate:        20,       // skip signal if ADX below this (0 = off)
    // Analyst toggles
    enableSMC:       true,
    enableElliott:   true,
    enableFib:       true,
    enableRSI:       true,
    enableMACD:      true,
    enableBollinger: true,
    enablePivot:     false,   // off by default — overlaps with Fib S/R
    enablePattern:   true,
    enableNews:      true,
    enableMTF:       true,
    enableDivergence: true,
    minAgentWeight:  0.5,     // skip agents with KB weight below this in voting
    keepAlive:       true,    // wake lock + browser notification
    accountSize:     30,      // USD balance — used to calculate lot size
    riskPerTrade:    2,       // % of account per trade
    accountCurrency: 'USD',
  },

  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      this.data = raw ? { ...this.defaults, ...JSON.parse(raw) } : { ...this.defaults };
    } catch (e) { this.data = { ...this.defaults }; }
    return this.data;
  },

  save() { localStorage.setItem(this.KEY, JSON.stringify(this.data)); },

  get(key, fallback) { return this.data?.[key] ?? fallback; },
  set(key, val)      { this.data[key] = val; this.save(); },
};

Settings.load();

/* ═══════════════════════════════════════════════════════
   TELEGRAM BOT INTEGRATION
   ─ auto-detect: ถ้าอยู่บน Apps Script → ใช้ google.script.run (server-side, ปลอดภัย)
                 ถ้า static hosting → ใช้ fetch ตรงไป Telegram API
   ═══════════════════════════════════════════════════════ */
const Telegram = {
  lastSent: 0,

  /** Detect if running inside Google Apps Script HtmlService */
  _onAppsScript() {
    return typeof google !== 'undefined' && google.script && google.script.run;
  },

  /** Send via Apps Script server-side bridge */
  _sendViaAppsScript(msg) {
    return new Promise((resolve) => {
      google.script.run
        .withSuccessHandler(r => resolve(r && r.ok ? { ok: true } : { ok: false, msg: r?.error || 'failed' }))
        .withFailureHandler(e => resolve({ ok: false, msg: e.message }))
        .sendTelegram(msg);
    });
  },

  /** Send via direct browser fetch */
  async _sendViaFetch(msg) {
    const token  = Settings.get('telegramToken');
    const chatId = Settings.get('telegramChatId');
    if (!token || !chatId) return { ok: false, msg: 'Token หรือ Chat ID ว่าง' };
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' }),
      });
      const data = await r.json();
      return data.ok ? { ok: true } : { ok: false, msg: data.description };
    } catch (e) { return { ok: false, msg: e.message }; }
  },

  async _send(msg) {
    return this._onAppsScript() ? this._sendViaAppsScript(msg) : this._sendViaFetch(msg);
  },

  // ── Thai translation of economic events ──
  _thaiEvents: {
    'USD Core PCE m/m':             'USD เงินเฟ้อ Core PCE รายเดือน',
    'USD Initial Jobless Claims':    'USD ผู้ขอสวัสดิการว่างงานครั้งแรก',
    'USD GDP q/q Second Estimate':   'USD GDP รายไตรมาส (ครั้งที่ 2)',
    'USD Non-Farm Payrolls':         'USD การจ้างงานนอกภาคเกษตร (NFP) ⭐',
    'USD Unemployment Rate':         'USD อัตราว่างงาน',
    'USD ISM Manufacturing':         'USD ISM ภาคการผลิต',
    'USD JOLTS Job Openings':        'USD ตำแหน่งงานว่าง (JOLTS)',
    'USD FOMC Minutes':              'USD รายงานการประชุม FOMC ⭐',
    'USD ADP Employment':            'USD การจ้างงาน ADP',
    'USD Consumer Sentiment':        'USD ความเชื่อมั่นผู้บริโภค',
    'EUR CPI y/y Flash':             'EUR เงินเฟ้อ CPI รายปี (Flash)',
    'EUR ECB Rate Decision':         'EUR ECB ประกาศอัตราดอกเบี้ย ⭐',
    'GBP BoE Rate Decision':         'GBP BoE ประกาศอัตราดอกเบี้ย',
    'GBP Manufacturing PMI':         'GBP PMI ภาคการผลิต',
    'AUD RBA Rate Statement':        'AUD RBA แถลงนโยบายอัตราดอกเบี้ย',
    'AUD RBA Meeting Minutes':       'AUD รายงานการประชุม RBA',
    'AUD CPI q/q':                   'AUD เงินเฟ้อ CPI รายไตรมาส',
    'AUD Retail Sales':              'AUD ยอดค้าปลีก',
    'XAU/Gold Technical Support':    'XAU แนวรับเชิงเทคนิคของทอง',
  },

  _impactThai: { high: '🔴 สำคัญมาก', medium: '🟡 ปานกลาง', low: '🟢 ผลน้อย' },
  _biasThai:   {
    bullish: '📈 หนุน', bearish: '📉 กด',
    hawkish: '🦅 hawkish', dovish: '🕊 dovish',
    neutral: '⚪ กลาง',
  },

  /** ส่งสรุปข่าวประจำวันเป็นภาษาไทย */
  async sendDailyNews() {
    if (!Settings.get('telegramOn') && !this._onAppsScript()) return { ok:false, msg:'Telegram ปิดอยู่' };

    // รวม events จาก calendar ของ NewsAgent
    const day = new Date().getUTCDay();
    const dayName = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'][day];

    if (day === 0 || day === 6) {
      const msg = `📰 <b>ข่าวเศรษฐกิจวัน${dayName}</b>\n\n💤 ตลาดปิด (สุดสัปดาห์)\nไม่มี high-impact news`;
      const r = await this._send(msg);
      return r;
    }

    const newsAgent = new NewsAgent('ALL', ['XAU', 'USD', 'AUD', 'EUR', 'GBP']);
    const all = newsAgent._calendar();

    // กรองตาม symbols ที่ user เปิด
    const enabledCurrencies = ['USD']; // USD เกี่ยวข้องเสมอ
    if (Settings.get('enableXAU', true)) enabledCurrencies.push('XAU');
    if (Settings.get('enableAUD', true)) enabledCurrencies.push('AUD');
    if (Settings.get('enableEUR', true)) enabledCurrencies.push('EUR');

    const relevant = all.filter(e => enabledCurrencies.some(p => e.curr.includes(p)));

    if (relevant.length === 0) {
      const msg = `📰 <b>ข่าวเศรษฐกิจวัน${dayName}</b>\n\n✅ ไม่มีข่าวสำคัญสำหรับคู่ที่คุณติดตาม`;
      return await this._send(msg);
    }

    // จัด format
    let msg = `📰 <b>ข่าวเศรษฐกิจวัน${dayName}</b>\n`;
    msg += `<i>ส่งผลกับ: ${enabledCurrencies.join(', ')}</i>\n`;
    msg += `${'─'.repeat(28)}\n\n`;

    relevant.forEach(e => {
      const eventThai = this._thaiEvents[e.event] || e.event;
      const impactThai = this._impactThai[e.impact] || e.impact;
      const biasThai   = this._biasThai[e.bias] || e.bias;

      msg += `${impactThai}  <b>${e.time} UTC</b>\n`;
      msg += `📌 ${eventThai}\n`;
      msg += `   ${biasThai} ${e.curr}\n\n`;
    });

    msg += `${'─'.repeat(28)}\n`;
    msg += `⚠️ <i>แนะนำเลี่ยงเทรด 30 นาทีก่อน/หลังข่าว 🔴 สำคัญมาก</i>\n`;
    msg += `🕐 ${new Date().toLocaleString('th-TH')}`;

    return await this._send(msg);
  },

  /** ส่งข่าวเฉพาะ event ที่จะมาภายใน X ชม.ข้างหน้า */
  async sendUpcomingNews(hoursAhead = 1) {
    if (!Settings.get('telegramOn') && !this._onAppsScript()) return;

    const day = new Date().getUTCDay();
    if (day === 0 || day === 6) return;

    const newsAgent = new NewsAgent('ALL', ['XAU', 'USD', 'AUD', 'EUR', 'GBP']);
    const all = newsAgent._calendar();
    const nowHour = new Date().getUTCHours();
    const nowMin  = new Date().getUTCMinutes();
    const nowDecimal = nowHour + nowMin / 60;

    const enabledCurr = ['USD'];
    if (Settings.get('enableXAU', true)) enabledCurr.push('XAU');
    if (Settings.get('enableAUD', true)) enabledCurr.push('AUD');
    if (Settings.get('enableEUR', true)) enabledCurr.push('EUR');

    const upcoming = all.filter(e => {
      if (!enabledCurr.some(p => e.curr.includes(p))) return false;
      const [eh, em] = e.time.split(':').map(Number);
      const eDecimal = eh + em / 60;
      const diff = eDecimal - nowDecimal;
      return diff > 0 && diff <= hoursAhead && e.impact === 'high';
    });

    if (upcoming.length === 0) return;

    let msg = `🚨 <b>เตือนข่าว ${hoursAhead} ชม. ข้างหน้า!</b>\n\n`;
    upcoming.forEach(e => {
      const eventThai = this._thaiEvents[e.event] || e.event;
      const biasThai  = this._biasThai[e.bias] || e.bias;
      msg += `🔴 <b>${e.time} UTC</b>\n`;
      msg += `   ${eventThai}\n`;
      msg += `   ${biasThai} ${e.curr}\n\n`;
    });
    msg += `⚠️ <i>เตรียม spread กว้าง — ระวัง slippage</i>`;

    return await this._send(msg);
  },

  /** Test bot connection */
  async test() {
    const env = this._onAppsScript() ? 'Apps Script' : 'Browser';
    const msg = `🤖 <b>Trading War Room — Test (${env})</b>\n` +
                `เชื่อมต่อสำเร็จ ${new Date().toLocaleString()}\n` +
                `ระบบจะส่งสัญญาณ Grade ${Settings.get('minGrade')}+ ขึ้นไป`;
    const r = await this._send(msg);
    return r.ok ? { ok: true, msg: `ส่งสำเร็จ (ผ่าน ${env})! ตรวจ Telegram` }
                : { ok: false, msg: r.msg };
  },

  /** Notify on strong signal */
  async notify(cmdReport, gradeInfo) {
    if (!Settings.get('telegramOn')) return;
    if (cmdReport.signal === 'wait' || cmdReport.signal === 'watch') return;

    // Symbol filter — only notify for symbols the user wants
    const sym = cmdReport.sym;
    if (sym === 'XAUUSD' && !Settings.get('enableXAU', true)) return;
    if (sym === 'AUDUSD' && !Settings.get('enableAUD', true)) return;
    if (sym === 'EURUSD' && !Settings.get('enableEUR', true)) return;

    const minGrade = Settings.get('minGrade', 'A');
    const order    = ['D', 'C', 'B', 'A', 'S+'];
    if (order.indexOf(gradeInfo.grade) < order.indexOf(minGrade)) return;

    const cooldownMs = Settings.get('cooldownMin', 5) * 60000;
    if (Date.now() - this.lastSent < cooldownMs) return;

    // Skip token check if on Apps Script (token is server-side)
    if (!this._onAppsScript()) {
      if (!Settings.get('telegramToken') || !Settings.get('telegramChatId')) return;
    }

    const arrow = cmdReport.signal === 'buy' ? '🟢▲' : '🔴▼';
    const msg = `${arrow} <b>${gradeInfo.grade} GRADE — ${cmdReport.signal.toUpperCase()} ${cmdReport.sym}</b>\n\n` +
                `💰 <b>Entry:</b> <code>${cmdReport.entry}</code>\n` +
                `🛑 <b>SL:</b> <code>${cmdReport.sl}</code>\n` +
                `🎯 <b>TP1:</b> <code>${cmdReport.tp1}</code>\n` +
                `🎯 <b>TP2:</b> <code>${cmdReport.tp2}</code>\n` +
                `📊 <b>R:R</b>: ${cmdReport.rr}\n` +
                `💼 <b>Position:</b> ${cmdReport.pos}\n\n` +
                `🎓 <b>Confidence:</b> ${cmdReport.conf}%\n` +
                `🤝 <b>Consensus:</b> ${gradeInfo.agree}/${gradeInfo.total} agents agree\n` +
                `⭐ <b>Final Score:</b> ${gradeInfo.finalScore}/100\n\n` +
                `<i>Trading War Room — ${new Date().toLocaleString()}</i>`;

    const r = await this._send(msg);
    if (r.ok) this.lastSent = Date.now();

    // Also log signal to Sheet if running on Apps Script
    if (this._onAppsScript()) {
      try {
        google.script.run.logSignal({
          grade: gradeInfo.grade,
          signal: cmdReport.signal,
          symbol: cmdReport.sym,
          entry: cmdReport.entry,
          sl: cmdReport.sl,
          tp1: cmdReport.tp1,
          tp2: cmdReport.tp2,
          rr: cmdReport.rr,
          conf: cmdReport.conf,
          consensus: gradeInfo.consensus,
        });
      } catch (e) { /* ignore */ }
    }
  },
};

/* ═══════════════════════════════════════════════════════
   MODAL MANAGER
   ═══════════════════════════════════════════════════════ */
const Modal = {
  open(name) {
    document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
    const el = document.getElementById(`modal-${name}`);
    if (el) el.style.display = 'flex';
    if (name === 'settings') this.fillSettings();
    if (name === 'journal' && typeof Journal !== 'undefined') {
      document.getElementById('journal-body').innerHTML = Journal.render();
    }
    if (name === 'backtest' && typeof Backtest !== 'undefined') {
      document.getElementById('backtest-body').innerHTML = Backtest.renderUI();
    }
  },
  close() {
    document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
  },

  fillSettings() {
    document.getElementById('s-token').value     = Settings.get('telegramToken', '');
    document.getElementById('s-chatid').value    = Settings.get('telegramChatId', '');
    document.getElementById('s-on').checked      = Settings.get('telegramOn', false);
    document.getElementById('s-mingrade').value  = Settings.get('minGrade', 'A');
    document.getElementById('s-sound').checked   = Settings.get('sound', true);
    document.getElementById('s-cooldown').value  = Settings.get('cooldownMin', 5);
    const pk = document.getElementById('s-pricekey'); if (pk) pk.value = Settings.get('priceApiKey', '');
    const pf = document.getElementById('s-pricefeed'); if (pf) pf.checked = Settings.get('priceFeedOn', false);
    const pr = document.getElementById('s-pricerefresh'); if (pr) pr.value = Settings.get('priceRefreshSec', 120);
    const tm = document.getElementById('s-trademode'); if (tm) tm.value = Settings.get('tradeMode', 'swing');
    const as = document.getElementById('s-accountsize'); if (as) as.value = Settings.get('accountSize', 30);
    const rk = document.getElementById('s-risk'); if (rk) rk.value = Settings.get('riskPerTrade', 2);
    const ex = document.getElementById('s-enableXAU'); if (ex) ex.checked = Settings.get('enableXAU', true);
    const ea = document.getElementById('s-enableAUD'); if (ea) ea.checked = Settings.get('enableAUD', true);
    const ee = document.getElementById('s-enableEUR'); if (ee) ee.checked = Settings.get('enableEUR', true);
    const ag = document.getElementById('s-adxgate');   if (ag) ag.value   = Settings.get('adxGate', 20);
    const ka = document.getElementById('s-keepalive'); if (ka) ka.checked = Settings.get('keepAlive', true);
    // Analyst toggles
    ['SMC','Elliott','Fib','RSI','MACD','Bollinger','Pivot','Pattern','Divergence','MTF','News'].forEach(name => {
      const el = document.getElementById('s-en-' + name);
      if (el) el.checked = Settings.get('enable' + name, name !== 'Pivot');
    });
    const mw = document.getElementById('s-minweight'); if (mw) mw.value = Settings.get('minAgentWeight', 0.5);
  },

  saveSettings() {
    Settings.set('telegramToken',  document.getElementById('s-token').value.trim());
    Settings.set('telegramChatId', document.getElementById('s-chatid').value.trim());
    Settings.set('telegramOn',     document.getElementById('s-on').checked);
    Settings.set('minGrade',       document.getElementById('s-mingrade').value);
    Settings.set('sound',          document.getElementById('s-sound').checked);
    Settings.set('cooldownMin',    parseInt(document.getElementById('s-cooldown').value) || 5);
    const pk = document.getElementById('s-pricekey');     if (pk) Settings.set('priceApiKey', pk.value.trim());
    const pf = document.getElementById('s-pricefeed');    if (pf) Settings.set('priceFeedOn', pf.checked);
    const pr = document.getElementById('s-pricerefresh'); if (pr) Settings.set('priceRefreshSec', Math.max(60, parseInt(pr.value) || 120));
    const tm = document.getElementById('s-trademode');    if (tm) Settings.set('tradeMode', tm.value);
    const as = document.getElementById('s-accountsize');  if (as) Settings.set('accountSize', Math.max(10, parseFloat(as.value) || 30));
    const rk = document.getElementById('s-risk');         if (rk) Settings.set('riskPerTrade', Math.max(0.5, Math.min(10, parseFloat(rk.value) || 2)));
    const ex = document.getElementById('s-enableXAU');    if (ex) Settings.set('enableXAU', ex.checked);
    const ea = document.getElementById('s-enableAUD');    if (ea) Settings.set('enableAUD', ea.checked);
    const ee = document.getElementById('s-enableEUR');    if (ee) Settings.set('enableEUR', ee.checked);
    const ag = document.getElementById('s-adxgate');      if (ag) Settings.set('adxGate', Math.max(0, Math.min(50, parseInt(ag.value) || 0)));
    const ka = document.getElementById('s-keepalive');    if (ka) {
      Settings.set('keepAlive', ka.checked);
      if (typeof KeepAlive !== 'undefined') {
        if (ka.checked) KeepAlive.enable(); else KeepAlive.disable();
      }
    }
    // Analyst toggles
    ['SMC','Elliott','Fib','RSI','MACD','Bollinger','Pivot','Pattern','Divergence','MTF','News'].forEach(name => {
      const el = document.getElementById('s-en-' + name);
      if (el) Settings.set('enable' + name, el.checked);
    });
    const mw = document.getElementById('s-minweight'); if (mw) Settings.set('minAgentWeight', parseFloat(mw.value) || 0.5);

    const status = document.getElementById('s-status');
    status.textContent = '✓ บันทึกแล้ว';
    status.style.color = 'var(--green)';
    setTimeout(() => status.textContent = '', 2000);
  },

  async testPriceFeed() {
    this.saveSettings();
    const status = document.getElementById('s-status');
    status.textContent = '⏳ ดึงราคา...';
    status.style.color = 'var(--yellow)';
    try {
      const px = await TradingWarRoom.market.fetchRealPrices(Settings.get('priceApiKey'));
      if (px && isFinite(px.XAUUSD)) {
        status.innerHTML = `✓ XAU:<b>${px.XAUUSD.toFixed(2)}</b> AUD:<b>${px.AUDUSD.toFixed(4)}</b> EUR:<b>${px.EURUSD.toFixed(4)}</b>`;
        status.style.color = 'var(--green)';
      } else {
        status.textContent = '✗ ดึงราคาไม่ได้ (เช็ค API key)';
        status.style.color = 'var(--red)';
      }
    } catch (e) {
      status.textContent = '✗ ' + e.message;
      status.style.color = 'var(--red)';
    }
  },

  async testTelegram() {
    this.saveSettings();
    const status = document.getElementById('s-status');
    status.textContent = '⏳ กำลังทดสอบ...';
    status.style.color = 'var(--yellow)';

    const result = await Telegram.test();
    status.textContent = (result.ok ? '✓ ' : '✗ ') + result.msg;
    status.style.color = result.ok ? 'var(--green)' : 'var(--red)';
  },
};

/* ═══════════════════════════════════════════════════════
   TRADE JOURNAL — log every signal sent, track wins/losses
   ═══════════════════════════════════════════════════════ */
const Journal = {
  KEY: 'twr_journal',

  load() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); }
    catch { return []; }
  },

  save(entries) { localStorage.setItem(this.KEY, JSON.stringify(entries)); },

  _nextId() { return Date.now() * 1000 + ((this._seq = (this._seq || 0) + 1) % 1000); },

  /** Add a new signal to the journal (called automatically by Telegram.notify) */
  add(cmdReport, gradeInfo) {
    const entries = this.load();
    entries.unshift({
      id:        this._nextId(),
      ts:        new Date().toISOString(),
      grade:     gradeInfo.grade,
      symbol:    cmdReport.sym,
      signal:    cmdReport.signal,
      entry:     cmdReport.entry,
      sl:        cmdReport.sl,
      tp1:       cmdReport.tp1,
      tp2:       cmdReport.tp2,
      rr:        cmdReport.rr,
      conf:      cmdReport.conf,
      mode:      cmdReport.mode || 'Swing',
      outcome:   'pending', // win | loss | breakeven | pending
      pnl:       null,      // user fills R-multiple later
      notes:     '',
    });
    // Keep last 200
    if (entries.length > 200) entries.length = 200;
    this.save(entries);
  },

  setOutcome(id, outcome, pnl, notes) {
    const entries = this.load();
    const e = entries.find(x => x.id === id);
    if (!e) return;
    e.outcome = outcome;
    if (pnl != null)   e.pnl = pnl;
    if (notes != null) e.notes = notes;
    this.save(entries);
    // Adaptive learning — update agent scores
    if (typeof AgentScores !== 'undefined') AgentScores.update(e);
  },

  remove(id) {
    this.save(this.load().filter(e => e.id !== id));
  },

  clear() { this.save([]); },

  stats() {
    const entries = this.load();
    const closed  = entries.filter(e => e.outcome !== 'pending');
    const wins    = closed.filter(e => e.outcome === 'win').length;
    const losses  = closed.filter(e => e.outcome === 'loss').length;
    const be      = closed.filter(e => e.outcome === 'breakeven').length;
    const totalR  = closed.reduce((s, e) => s + (parseFloat(e.pnl) || 0), 0);
    return {
      total: entries.length,
      pending: entries.length - closed.length,
      wins, losses, be,
      winRate: closed.length > 0 ? Math.round(wins / closed.length * 100) : 0,
      totalR: totalR.toFixed(2),
      avgR: closed.length > 0 ? (totalR / closed.length).toFixed(2) : '0.00',
    };
  },

  render() {
    const entries = this.load();
    const s = this.stats();

    const statsHTML = `
      <div class="journal-stats">
        <div class="js-tile"><div class="js-num">${s.total}</div><div class="js-lbl">Total Signals</div></div>
        <div class="js-tile" style="color:var(--green)"><div class="js-num">${s.wins}</div><div class="js-lbl">Wins</div></div>
        <div class="js-tile" style="color:var(--red)"><div class="js-num">${s.losses}</div><div class="js-lbl">Losses</div></div>
        <div class="js-tile" style="color:var(--yellow)"><div class="js-num">${s.be}</div><div class="js-lbl">Breakeven</div></div>
        <div class="js-tile" style="color:var(--teal)"><div class="js-num">${s.winRate}%</div><div class="js-lbl">Win Rate</div></div>
        <div class="js-tile" style="color:var(--gold)"><div class="js-num">${s.totalR}R</div><div class="js-lbl">Total P/L</div></div>
      </div>
    `;

    const rowsHTML = entries.length === 0
      ? '<div style="padding:20px;text-align:center;color:var(--gray);font-size:7px">📭 ยังไม่มี signal ที่บันทึก — รอให้ระบบส่ง Telegram ครั้งแรก</div>'
      : entries.map(e => {
          const d = new Date(e.ts);
          const time = `${d.toLocaleDateString()} ${d.toTimeString().slice(0,5)}`;
          const sigCls = e.signal === 'buy' ? 'text-green' : 'text-red';
          const outCls = e.outcome === 'win' ? 'text-green' : e.outcome === 'loss' ? 'text-red' : e.outcome === 'breakeven' ? 'text-yellow' : 'text-gray';
          return `<tr class="j-row" data-id="${e.id}">
            <td class="text-gray">${time}</td>
            <td class="text-teal">${e.symbol}</td>
            <td class="${sigCls}">${e.signal === 'buy' ? '▲' : '▼'} ${e.signal.toUpperCase()}</td>
            <td class="text-gold">${e.grade}</td>
            <td>${e.entry}</td>
            <td class="text-red">${e.sl}</td>
            <td class="text-green">${e.tp1}</td>
            <td class="${outCls}">${e.outcome}</td>
            <td>${e.pnl ?? '-'}R</td>
            <td>
              <button onclick="Journal.markWin(${e.id})" class="j-mini-btn text-green">W</button>
              <button onclick="Journal.markLoss(${e.id})" class="j-mini-btn text-red">L</button>
              <button onclick="Journal.markBE(${e.id})" class="j-mini-btn text-yellow">B</button>
              <button onclick="Journal.del(${e.id})" class="j-mini-btn text-gray">✕</button>
            </td>
          </tr>`;
        }).join('');

    return statsHTML + `
      <div class="j-table-wrap">
        <table class="j-table">
          <thead><tr>
            <th>Time</th><th>Sym</th><th>Side</th><th>Grade</th>
            <th>Entry</th><th>SL</th><th>TP1</th><th>Outcome</th><th>P/L</th><th>Action</th>
          </tr></thead>
          <tbody>${rowsHTML}</tbody>
        </table>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button class="btn btn-secondary" onclick="Journal.exportCSV()">📥 Export CSV</button>
        <button class="btn btn-secondary" onclick="if(confirm('ลบประวัติทั้งหมด?')){Journal.clear();Modal.open('journal');}">🗑 Clear All</button>
      </div>
      ${(typeof AgentScores !== 'undefined') ? AgentScores.render() : ''}
      `;
  },

  markWin(id)  { const r = prompt('กำไรกี่ R? (เช่น 1.5)', '1');   if (r !== null) { this.setOutcome(id, 'win', parseFloat(r) || 1); Modal.open('journal'); } },
  markLoss(id) { const r = prompt('ขาดทุนกี่ R? (เช่น -1)', '-1'); if (r !== null) { this.setOutcome(id, 'loss', parseFloat(r) || -1); Modal.open('journal'); } },
  markBE(id)   { this.setOutcome(id, 'breakeven', 0); Modal.open('journal'); },
  del(id)      { if (confirm('ลบ entry นี้?')) { this.remove(id); Modal.open('journal'); } },

  exportCSV() {
    const entries = this.load();
    const headers = ['Time','Symbol','Signal','Grade','Entry','SL','TP1','TP2','RR','Confidence','Mode','Outcome','PnL_R','Notes'];
    const rows = entries.map(e => [
      e.ts, e.symbol, e.signal, e.grade, e.entry, e.sl, e.tp1, e.tp2, e.rr, e.conf, e.mode, e.outcome, e.pnl ?? '', e.notes
    ].map(v => `"${(v + '').replace(/"/g, '""')}"`).join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `trading-journal-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },
};

/* ═══════════════════════════════════════════════════════
   KNOWLEDGE BASE / AGENT SCORES — Regime-aware learning
   จากทั้ง Journal (live) และ Backtest
   เก็บสถิติ per-agent แยกตาม:
     - all (overall)
     - regime: trending / ranging / volatile
     - symbol (XAUUSD / AUDUSD / EURUSD)
   ═══════════════════════════════════════════════════════ */
const AgentScores = {
  KEY: 'twr_agent_scores_v2',
  MIN_TRADES: 5,

  /** Classify market regime from candles — ใช้ตอน record + ตอน lookup */
  classifyRegime(candles) {
    if (!candles || candles.length < 30) return 'unknown';
    const adx = TA.adx(candles);
    const atr = TA.atr(candles);
    const atrAvg = TA.atr(candles, 30);
    const volatile = atr > atrAvg * 1.4;
    if (adx >= 25) return volatile ? 'volatile_trending' : 'trending';
    if (adx <= 18) return volatile ? 'volatile_ranging'  : 'ranging';
    return 'transitional';
  },

  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (raw) return JSON.parse(raw);
      // Migrate from v1 if exists
      const old = localStorage.getItem('twr_agent_scores');
      if (old) {
        const oldScores = JSON.parse(old);
        const migrated = { agents: {}, meta: { liveTrades: 0, backtestTrades: 0, created: Date.now() }};
        Object.entries(oldScores).forEach(([name, s]) => {
          migrated.agents[name] = {
            all: { t: s.trades || 0, w: s.wins || 0, l: s.losses || 0, R: s.totalR || 0 }
          };
          migrated.meta.liveTrades += (s.trades || 0);
        });
        return migrated;
      }
    } catch {}
    return { agents: {}, meta: { liveTrades: 0, backtestTrades: 0, created: Date.now() } };
  },

  save(kb) {
    if (!kb.meta) kb.meta = {};
    kb.meta.lastUpdate = Date.now();
    localStorage.setItem(this.KEY, JSON.stringify(kb));
  },

  /** Generic record — เรียกจากทั้ง Journal และ Backtest */
  recordTrade(opts) {
    const { votes, signal, outcome, r, regime, symbol, source } = opts;
    if (!votes || votes.length === 0) return;
    if (outcome === 'pending' || outcome === 'breakeven') return;

    const kb = this.load();
    if (source === 'backtest') kb.meta.backtestTrades = (kb.meta.backtestTrades || 0) + 1;
    else                       kb.meta.liveTrades     = (kb.meta.liveTrades || 0)     + 1;

    const won = outcome === 'win';
    const rAbs = Math.abs(r || (won ? 1 : -1));

    votes.forEach(v => {
      if (!v || !v.agent) return;
      const agreed = v.signal === signal;
      const correct = (agreed && won) || (!agreed && !won);
      const rDelta = correct ? rAbs : -rAbs;

      if (!kb.agents[v.agent]) kb.agents[v.agent] = {};
      const a = kb.agents[v.agent];

      // Update buckets: 'all', regime, sym_SYMBOL
      const buckets = ['all'];
      if (regime) buckets.push(regime);
      if (symbol) buckets.push(`sym_${symbol}`);

      buckets.forEach(bk => {
        if (!a[bk]) a[bk] = { t: 0, w: 0, l: 0, R: 0 };
        a[bk].t++;
        if (correct) a[bk].w++; else a[bk].l++;
        a[bk].R += rDelta;
      });
    });

    this.save(kb);
  },

  /** Legacy adapter — Journal.setOutcome → recordTrade */
  update(entry) {
    if (!entry.agentVotes) return;
    // Try to classify regime from current candles (live trade)
    let regime = null;
    try {
      const c = TradingWarRoom?.market?.candles?.[entry.sym];
      if (c) regime = this.classifyRegime(c);
    } catch {}
    this.recordTrade({
      votes:   entry.agentVotes,
      signal:  entry.signal,
      outcome: entry.outcome,
      r:       parseFloat(entry.pnl) || (entry.outcome === 'win' ? 1 : -1),
      regime,
      symbol:  entry.sym,
      source:  'live',
    });
  },

  /** Weight multiplier — รวม accuracy + average R per trade
   *  ทำให้ agent ที่ทั้งทายถูกบ่อย + ทำเงินได้เยอะ ได้ weight สูง
   *  agent ที่ทายถูกแต่กำไรน้อย (เช่น scratch trades) ไม่ได้ boost เต็ม */
  weight(agentName, ctx = {}) {
    const a = this.load().agents[agentName];
    if (!a) return 1.0;

    const bucketsToTry = [];
    if (ctx.regime)               bucketsToTry.push(ctx.regime);
    if (ctx.symbol)               bucketsToTry.push(`sym_${ctx.symbol}`);
    bucketsToTry.push('all');

    for (const bk of bucketsToTry) {
      const s = a[bk];
      if (s && s.t >= this.MIN_TRADES) {
        const acc  = s.w / s.t;
        const avgR = s.R / s.t;
        // Score: accuracy delta (50% baseline) + avgR contribution
        const score = (acc - 0.5) * 2 + Math.max(-0.6, Math.min(0.6, avgR * 0.5));
        return Math.max(0.2, Math.min(2.5, 1.0 + score));
      }
    }
    return 1.0;
  },

  /** Detail stats for UI */
  stats() {
    const kb = this.load();
    return Object.entries(kb.agents).map(([name, a]) => {
      const all = a.all || { t:0, w:0, l:0, R:0 };
      const regimeStats = (key) => {
        const b = a[key];
        if (!b || b.t === 0) return null;
        return { t: b.t, w: b.w, acc: Math.round(b.w/b.t*100), R: b.R.toFixed(1) };
      };
      return {
        name,
        total:    all.t,
        wins:     all.w,
        losses:   all.l,
        accuracy: all.t > 0 ? Math.round(all.w / all.t * 100) : 0,
        totalR:   all.R.toFixed(2),
        weight:   this.weight(name).toFixed(2),
        trending: regimeStats('trending'),
        ranging:  regimeStats('ranging'),
        vol_tr:   regimeStats('volatile_trending'),
        vol_rg:   regimeStats('volatile_ranging'),
        xau:      regimeStats('sym_XAUUSD'),
        aud:      regimeStats('sym_AUDUSD'),
        eur:      regimeStats('sym_EURUSD'),
      };
    }).sort((a, b) => b.total - a.total);
  },

  meta() {
    const kb = this.load();
    return kb.meta || {};
  },

  /** Export KB as JSON string */
  exportJSON() {
    return JSON.stringify(this.load(), null, 2);
  },

  /** Import & merge */
  importJSON(text) {
    try {
      const imported = JSON.parse(text);
      if (!imported.agents) return { ok: false, msg: 'invalid format' };
      const current = this.load();
      Object.entries(imported.agents).forEach(([name, a]) => {
        if (!current.agents[name]) current.agents[name] = {};
        Object.entries(a).forEach(([bk, s]) => {
          if (!current.agents[name][bk]) current.agents[name][bk] = { t:0, w:0, l:0, R:0 };
          current.agents[name][bk].t += s.t || 0;
          current.agents[name][bk].w += s.w || 0;
          current.agents[name][bk].l += s.l || 0;
          current.agents[name][bk].R += s.R || 0;
        });
      });
      this.save(current);
      return { ok: true, msg: 'merged ' + Object.keys(imported.agents).length + ' agents' };
    } catch (e) {
      return { ok: false, msg: e.message };
    }
  },

  reset() {
    this.save({ agents: {}, meta: { liveTrades: 0, backtestTrades: 0, created: Date.now() } });
  },

  /** Fresh Start — backup เก่าก่อนแล้วค่อย reset */
  async freshStart() {
    const meta = this.meta();
    const total = (meta.liveTrades || 0) + (meta.backtestTrades || 0);

    if (total < 10) {
      // ไม่มีข้อมูลให้ backup → reset ตรงเลย
      if (confirm(`KB ยังไม่มีข้อมูลพอที่จะ backup (${total} trades) — reset เลยไหม?`)) {
        this.reset();
        if (typeof Journal !== 'undefined') Journal.clear();
        if (typeof Modal !== 'undefined') Modal.open('journal');
      }
      return;
    }

    const confirmMsg = `🔄 FRESH START\n\n` +
                      `จะทำ 3 ขั้น:\n` +
                      `1. Backup KB ปัจจุบัน (${total} trades) → คัดลอกใส่ clipboard\n` +
                      `2. รีเซ็ต KB เป็นค่าศูนย์\n` +
                      `3. ล้าง Journal ทั้งหมด\n\n` +
                      `⚠️ ข้อมูลที่ผ่านการเรียนรู้จะหายไป — ต้องรัน Auto-Opt ใหม่เพื่อสร้าง KB กลับ\n\n` +
                      `ดำเนินการต่อ?`;
    if (!confirm(confirmMsg)) return;

    // Step 1: Backup to clipboard
    const json = this.exportJSON();
    try {
      await navigator.clipboard.writeText(json);
    } catch (e) {
      // Fallback: prompt user
      const ok = prompt(`Copy ข้อมูลนี้เก็บไว้ก่อน (Ctrl+A → Ctrl+C):`, json.slice(0, 200) + '...(truncated)');
      if (ok === null) return; // user cancelled
    }

    // Step 2 + 3: Reset KB + Journal
    this.reset();
    if (typeof Journal !== 'undefined') Journal.clear();

    alert(`✅ Fresh Start สำเร็จ!\n\n` +
          `• Backup ${total} trades → คัดลอกใน clipboard แล้ว (paste ใส่ Notepad เก็บไว้ได้)\n` +
          `• KB + Journal: รีเซ็ตเป็น 0\n\n` +
          `ขั้นต่อไป:\n` +
          `1. เปิด 🔬 BACKTEST\n` +
          `2. กด 🚀 Start Auto-Opt\n` +
          `3. ปล่อยไว้ ~30 นาที = ได้ KB ใหม่ที่ใช้ Weight Formula + Divergence Agent ใหม่`);

    if (typeof Modal !== 'undefined') Modal.open('journal');
  },

  /** Trade counts per symbol */
  symbolCounts() {
    const kb = this.load();
    const result = { XAUUSD: 0, AUDUSD: 0, EURUSD: 0 };
    Object.values(kb.agents).forEach(a => {
      ['XAUUSD','AUDUSD','EURUSD'].forEach(sym => {
        const b = a[`sym_${sym}`];
        if (b) result[sym] = Math.max(result[sym], b.t);
      });
    });
    return result;
  },

  /** Render progress bar for KB data quality */
  renderProgress() {
    const counts = this.symbolCounts();
    const TARGET_HIGH = 100;   // high confidence
    const TARGET_MIN  = 30;    // minimum usable

    const bar = (count, target) => {
      const pct = Math.min(100, Math.round(count / target * 100));
      const fill = '█'.repeat(Math.floor(pct / 10));
      const empty = '░'.repeat(10 - Math.floor(pct / 10));
      const color = pct >= 100 ? 'var(--green)' : pct >= 30 ? 'var(--yellow)' : 'var(--gray)';
      const status = count >= TARGET_HIGH ? '✅ ดีมาก' :
                     count >= TARGET_MIN  ? '⚠️ พอใช้' :
                                            '🔴 ยังน้อย';
      return `<div style="font-size:7px;color:var(--white);font-family:monospace">
        <span style="color:${color}">${fill}${empty}</span>
        <span style="color:${color}"> ${count}/${target}</span>
        <span style="color:var(--gray)"> — ${status}</span>
      </div>`;
    };

    return `
      <div style="margin-top:14px;font-size:8px;color:var(--gold);border-bottom:1px solid var(--border);padding-bottom:4px">📊 KB DATA QUALITY</div>
      <div style="font-size:6px;color:var(--gray);padding:4px 0">
        เป้าหมาย: <b style="color:var(--yellow)">30</b> trades/symbol = พอใช้ |
        <b style="color:var(--green)">100</b> trades/symbol = ดีมาก
      </div>
      <div style="display:grid;grid-template-columns:60px 1fr;gap:4px;align-items:center;padding:4px 0">
        <span style="color:var(--gold)">🥇 XAU</span> ${bar(counts.XAUUSD, TARGET_HIGH)}
        <span style="color:var(--teal)">🇦🇺 AUD</span> ${bar(counts.AUDUSD, TARGET_HIGH)}
        <span style="color:var(--teal)">🇪🇺 EUR</span> ${bar(counts.EURUSD, TARGET_HIGH)}
      </div>
      ${counts.XAUUSD < TARGET_MIN || counts.AUDUSD < TARGET_MIN || counts.EURUSD < TARGET_MIN
        ? '<div style="margin-top:4px;font-size:6px;color:var(--yellow);border-left:2px solid var(--yellow);padding-left:6px">💡 รัน Auto-Optimize อีกหน่อย — แต่ละ cycle เพิ่ม 5-15 trades/symbol</div>'
        : ''}
    `;
  },

  /** Render UI panel for inclusion in Journal modal */
  render() {
    const s = this.stats();
    const meta = this.meta();
    const progressHTML = this.renderProgress();
    if (s.length === 0) {
      return progressHTML + '<div style="padding:10px;font-size:7px;color:var(--gray);text-align:center">📭 ยังไม่มีข้อมูล — รัน Backtest หรือบันทึก W/L ใน Journal (min ' + this.MIN_TRADES + ' trades/bucket)</div>';
    }

    const cell = (b, fallback = '—') => {
      if (!b) return `<span style="color:var(--gray)">${fallback}</span>`;
      const cls = b.acc >= 60 ? 'text-green' : b.acc >= 40 ? 'text-yellow' : 'text-red';
      return `<span class="${cls}">${b.acc}%</span><span style="color:var(--gray);font-size:5px"> (${b.t})</span>`;
    };

    const rows = s.map(a => {
      const accCls = a.accuracy >= 60 ? 'text-green' : a.accuracy >= 40 ? 'text-yellow' : 'text-red';
      const wCls   = parseFloat(a.weight) >= 1.2 ? 'text-green' : parseFloat(a.weight) <= 0.8 ? 'text-red' : 'text-gray';
      return `<tr>
        <td class="text-teal">${a.name}</td>
        <td>${a.total}</td>
        <td class="${accCls}">${a.accuracy}%</td>
        <td class="${parseFloat(a.totalR) > 0 ? 'text-green' : 'text-red'}">${a.totalR}R</td>
        <td class="${wCls}">${a.weight}x</td>
        <td>${cell(a.trending)}</td>
        <td>${cell(a.ranging)}</td>
        <td>${cell(a.xau)}</td>
        <td>${cell(a.aud)}</td>
        <td>${cell(a.eur)}</td>
      </tr>`;
    }).join('');

    return `
      ${progressHTML}
      <div style="margin-top:14px;font-size:8px;color:var(--gold);border-bottom:1px solid var(--border);padding-bottom:4px">🧠 KNOWLEDGE BASE — Regime-Aware Learning</div>
      <div style="font-size:6px;color:var(--gray);padding:4px 0">
        Live trades: <b style="color:var(--green)">${meta.liveTrades || 0}</b> |
        Backtest trades: <b style="color:var(--teal)">${meta.backtestTrades || 0}</b> |
        Total: <b>${(meta.liveTrades || 0) + (meta.backtestTrades || 0)}</b>
      </div>
      <div style="font-size:6px;color:var(--gray);padding:2px 0 6px">
        💡 Weight ใช้ <b>regime-specific</b> ก่อน (ถ้ามี ≥${this.MIN_TRADES} trades) → ตกลงไป symbol → ตกลงไป all.
        Agent ที่ accuracy ต่ำในตลาดบางแบบ จะถูกลดน้ำหนัก<b>เฉพาะตลาดนั้น</b> ไม่กระทบตลาดที่ทายเก่ง
      </div>
      <div class="j-table-wrap" style="max-height:240px">
        <table class="j-table" style="font-size:5px">
          <thead><tr>
            <th>Agent</th><th>T</th><th>Acc</th><th>R</th><th>W</th>
            <th>🟢Trend</th><th>🔵Range</th>
            <th>XAU</th><th>AUD</th><th>EUR</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-secondary" onclick="navigator.clipboard.writeText(AgentScores.exportJSON()).then(()=>alert('Copied to clipboard — paste in another device'))">📤 Export JSON</button>
        <button class="btn btn-secondary" onclick="const t=prompt('Paste KB JSON:');if(t){const r=AgentScores.importJSON(t);alert(r.msg);Modal.open('journal');}">📥 Import & Merge</button>
        <button class="btn btn-secondary" onclick="if(confirm('Reset KB only (not Journal)?')){AgentScores.reset();Modal.open('journal');}">🔄 Reset KB</button>
        <button class="btn btn-primary" style="border-color:var(--orange);color:var(--orange)" onclick="AgentScores.freshStart()">🆕 Fresh Start (backup + reset all)</button>
      </div>
      <div style="margin-top:6px;font-size:6px;color:var(--gray);border-left:2px solid var(--orange);padding-left:6px">
        💡 <b>Fresh Start</b>: ใช้เมื่อต้องการ <b>วัดผลระบบใหม่</b> หลัง update — backup + reset ในขั้นเดียว
      </div>
    `;
  },
};

// Hook journal into Telegram.notify (auto-log every signal sent + capture agent votes)
const _origNotify = Telegram.notify.bind(Telegram);
Telegram.notify = async function(cmd, grade) {
  // Check if would actually send (replicate gate logic for journal)
  if (Settings.get('telegramOn') && cmd.signal !== 'wait' && cmd.signal !== 'watch') {
    const minGrade = Settings.get('minGrade', 'A');
    const order    = ['D', 'C', 'B', 'A', 'S+'];
    if (order.indexOf(grade.grade) >= order.indexOf(minGrade)) {
      const sym = cmd.sym;
      const enabled =
        (sym === 'XAUUSD' && Settings.get('enableXAU', true)) ||
        (sym === 'AUDUSD' && Settings.get('enableAUD', true)) ||
        (sym === 'EURUSD' && Settings.get('enableEUR', true));
      if (enabled) Journal.add(cmd, grade);
    }
  }
  return _origNotify(cmd, grade);
};

// Capture agent votes when adding to journal (called from app.js fullUpdate)
Journal._origAdd = Journal.add;
Journal.add = function(cmd, grade) {
  this._origAdd(cmd, grade);
  // Attach votes to the latest entry
  if (cmd._agentVotes) {
    const entries = this.load();
    if (entries[0]) {
      entries[0].agentVotes = cmd._agentVotes;
      this.save(entries);
    }
  }
};

/* ═══════════════════════════════════════════════════════
   KEEP-ALIVE — Wake Lock + Browser Notifications
   ป้องกัน tab sleep + ส่ง native notification เสริม Telegram
   ═══════════════════════════════════════════════════════ */
const KeepAlive = {
  wakeLock: null,
  enabled: false,

  async enable() {
    this.enabled = true;
    // 1. Wake Lock — ห้ามจอดับ (รองรับ Chrome/Edge/Safari mobile)
    //    หมายเหตุ: ต้องเรียกหลัง user gesture ครั้งแรก → ครั้งแรกอาจ silently fail
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => {
          if (this.enabled) setTimeout(() => this.enable(), 1000);
        });
      }
    } catch (e) { /* user denied or unsupported */ }

    // 2. Re-acquire wake lock เมื่อกลับมา foreground
    if (!this._visBound) {
      this._visBound = true;
      document.addEventListener('visibilitychange', () => {
        if (this.enabled && document.visibilityState === 'visible' && !this.wakeLock) {
          this.enable();
        }
      });
    }
    return true;
  },

  /** Request notification permission (must be called from user click) */
  async requestNotifPerm() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    try {
      return await Notification.requestPermission();
    } catch (e) { return 'denied'; }
  },

  disable() {
    this.enabled = false;
    if (this.wakeLock) {
      this.wakeLock.release();
      this.wakeLock = null;
    }
  },

  /** Show browser notification (เสริมจาก Telegram) */
  notify(title, body, opts = {}) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, {
        body,
        icon: opts.icon || 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiBmaWxsPSIjMGEwYTBmIi8+PHRleHQgeD0iMzIiIHk9IjQ0IiBmb250LXNpemU9IjQ4IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjZmZkNzAwIj7ihLk8L3RleHQ+PC9zdmc+',
        badge: opts.badge,
        tag: opts.tag || 'twr-signal',
        requireInteraction: opts.requireInteraction ?? false,
        silent: opts.silent ?? false,
      });
      n.onclick = () => { window.focus(); n.close(); };
      setTimeout(() => n.close(), 10000);
    } catch (e) { /* silent */ }
  },

  status() {
    return {
      wakeLockSupported: 'wakeLock' in navigator,
      wakeLockActive:    !!this.wakeLock && !this.wakeLock.released,
      notifPermission:   'Notification' in window ? Notification.permission : 'unsupported',
      enabled:           this.enabled,
    };
  },
};

window.KeepAlive    = KeepAlive;
window.SignalGrade  = SignalGrade;
window.Settings     = Settings;
window.Telegram     = Telegram;
window.Modal        = Modal;
window.Journal      = Journal;
window.AgentScores  = AgentScores;
