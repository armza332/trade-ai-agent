/* ═══════════════════════════════════════════════════════
   EXTRAS — Signal Grading + Telegram + Settings + Help
   ═══════════════════════════════════════════════════════ */

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
    priceRefreshSec: 120,
    tradeMode:      'swing',  // scalp | swing | position
    enableXAU:      true,
    enableAUD:      true,
    enableEUR:      true,
    adxGate:        20,       // skip signal if ADX below this (0 = off)
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
    const ex = document.getElementById('s-enableXAU'); if (ex) ex.checked = Settings.get('enableXAU', true);
    const ea = document.getElementById('s-enableAUD'); if (ea) ea.checked = Settings.get('enableAUD', true);
    const ee = document.getElementById('s-enableEUR'); if (ee) ee.checked = Settings.get('enableEUR', true);
    const ag = document.getElementById('s-adxgate');   if (ag) ag.value   = Settings.get('adxGate', 20);
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
    const ex = document.getElementById('s-enableXAU');    if (ex) Settings.set('enableXAU', ex.checked);
    const ea = document.getElementById('s-enableAUD');    if (ea) Settings.set('enableAUD', ea.checked);
    const ee = document.getElementById('s-enableEUR');    if (ee) Settings.set('enableEUR', ee.checked);
    const ag = document.getElementById('s-adxgate');      if (ag) Settings.set('adxGate', Math.max(0, Math.min(50, parseInt(ag.value) || 0)));

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
      </div>`;
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

// Hook journal into Telegram.notify (auto-log every signal sent)
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

window.SignalGrade = SignalGrade;
window.Settings    = Settings;
window.Telegram    = Telegram;
window.Modal       = Modal;
window.Journal     = Journal;
