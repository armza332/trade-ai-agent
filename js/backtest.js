/* ═══════════════════════════════════════════════════════
   BACKTEST ENGINE
     - รัน strategy บน historical candles
     - เปิด trade เมื่อมี signal Grade B+
     - Walk-forward จนกว่า SL หรือ TP จะแตะก่อน
     - คำนวณ win rate, total R, max drawdown, equity curve
   ═══════════════════════════════════════════════════════ */

const Backtest = {
  running: false,
  lastResult: null,

  /** Run backtest on given symbol */
  async run(symbol = 'XAUUSD', opts = {}) {
    if (this.running) return { error: 'Backtest กำลังทำงานอยู่' };
    this.running = true;

    try {
      const market = TradingWarRoom.market;
      let candles = market.candles[symbol];

      // ถ้ามีน้อย ลองดึงประวัติเพิ่ม
      const apiKey = Settings.get('priceApiKey');
      if ((!candles || candles.length < 200) && apiKey) {
        const fresh = await market.fetchHistory(symbol, '5min', 500, apiKey);
        if (fresh && fresh.length > 200) {
          candles = fresh;
          market.applyHistory(symbol, fresh);
        }
      }

      if (!candles || candles.length < 150) {
        return { error: 'ต้องมีอย่างน้อย 150 candles — เปิด "ดึงราคาจริง" + รอโหลด history ก่อน' };
      }

      const cfg = market.symbols[symbol];
      const mode = opts.mode || Settings.get('tradeMode', 'swing');
      const minConf = opts.minConf || 60;
      const minGradeOrder = ['D','C','B','A','S+'];
      const minGradeIdx = minGradeOrder.indexOf(opts.minGrade || 'B');

      // Temp team instance — ปิด MTF (ไม่มี historical MTF data)
      const wasMTF = Settings.get('enableMTF', true);
      Settings.set('enableMTF', false);
      const team = (symbol === 'XAUUSD') ? new GoldTeam() : null;
      let pairTeam = null;
      if (!team) {
        // For forex, create a single-pair analyzer
        pairTeam = {
          head:      new HeadAgent('BT', symbol, symbol),
          smc:       new SMCAgent(symbol),
          elliott:   new ElliottWaveAgent(symbol),
          fib:       new FibonacciAgent(symbol),
          rsi:       new RSIValueAgent(symbol),
          macd:      new MACDAgent(symbol),
          bollinger: new BollingerAgent(symbol),
          pattern:   new PatternAgent(symbol),
        };
      }

      const TP_MULT = { scalp: 0.6, swing: 1.5, position: 2.5 };
      const SL_MULT = { scalp: 0.5, swing: 1.5, position: 2.5 };
      const tpM = TP_MULT[mode] || 1.5;
      const slM = SL_MULT[mode] || 1.5;
      const rrFactor = 1.6;

      const trades = [];
      const equityCurve = [];
      let equity = 0;
      let openTrade = null;
      const startIdx = 100;       // warm-up
      const endIdx   = candles.length - 1;
      const checkEvery = 3;       // ตรวจ signal ทุก 3 candles

      for (let i = startIdx; i <= endIdx; i++) {
        const slice = candles.slice(0, i + 1);
        const c = candles[i];

        // ── ตรวจ exit ของ trade ที่เปิดอยู่ ──
        if (openTrade) {
          const isLong = openTrade.signal === 'buy';
          const hitSL = isLong ? c.low  <= openTrade.sl : c.high >= openTrade.sl;
          const hitTP = isLong ? c.high >= openTrade.tp : c.low  <= openTrade.tp;

          if (hitSL && hitTP) {
            // ทั้งสองชนกัน → assume SL ก่อน (conservative)
            openTrade.exit = openTrade.sl;
            openTrade.outcome = 'loss';
            openTrade.r = -1;
            openTrade.exitIdx = i;
          } else if (hitSL) {
            openTrade.exit = openTrade.sl;
            openTrade.outcome = 'loss';
            openTrade.r = -1;
          } else if (hitTP) {
            openTrade.exit = openTrade.tp;
            openTrade.outcome = 'win';
            openTrade.r = +rrFactor;
            openTrade.exitIdx = i;
          }

          if (openTrade.outcome) {
            openTrade.exitIdx = i;
            openTrade.duration = i - openTrade.entryIdx;
            equity += openTrade.r;
            equityCurve.push({ idx: i, equity, ts: c.ts });
            trades.push(openTrade);
            openTrade = null;
          }
        }

        // ── หา signal ใหม่ (ถ้าไม่มี trade เปิดอยู่) ──
        if (!openTrade && i % checkEvery === 0) {
          const fakeData = {
            candles: slice,
            price:   c.close,
            sym:     symbol,
            cfg,
          };

          let res = null;
          if (team) {
            res = team.analyze(fakeData);
          } else if (pairTeam) {
            // Simplified per-pair analysis
            const agents = [];
            if (Settings.get('enableSMC', true))       agents.push(pairTeam.smc.analyze(fakeData));
            if (Settings.get('enableElliott', true))   agents.push(pairTeam.elliott.analyze(fakeData));
            if (Settings.get('enableFib', true))       agents.push(pairTeam.fib.analyze(fakeData));
            if (Settings.get('enableRSI', true))       agents.push(pairTeam.rsi.analyze(fakeData));
            if (Settings.get('enableMACD', true))      agents.push(pairTeam.macd.analyze(fakeData));
            if (Settings.get('enableBollinger', true)) agents.push(pairTeam.bollinger.analyze(fakeData));
            if (Settings.get('enablePattern', true))   agents.push(pairTeam.pattern.analyze(fakeData));
            const agg = pairTeam.head.aggregate(agents);
            res = { head: { signal: agg.signal, conf: agg.conf } };
          }

          if (res && (res.head.signal === 'buy' || res.head.signal === 'sell') && res.head.conf >= minConf) {
            const atr = TA.atr(slice);
            if (atr > 0) {
              const entry = c.close;
              const sl = res.head.signal === 'buy' ? entry - atr * slM : entry + atr * slM;
              const tp = res.head.signal === 'buy' ? entry + atr * tpM * rrFactor : entry - atr * tpM * rrFactor;
              openTrade = {
                entryIdx: i,
                entry, sl, tp,
                signal: res.head.signal,
                conf: res.head.conf,
                ts: c.ts,
              };
            }
          }
        }
      }

      // Restore MTF setting
      Settings.set('enableMTF', wasMTF);

      // ── Calculate stats ──
      const wins   = trades.filter(t => t.outcome === 'win').length;
      const losses = trades.filter(t => t.outcome === 'loss').length;
      const winRate = trades.length > 0 ? Math.round(wins / trades.length * 100) : 0;
      const totalR  = trades.reduce((s,t) => s + t.r, 0);
      const avgR    = trades.length > 0 ? totalR / trades.length : 0;

      // Max drawdown
      let peak = 0, maxDD = 0;
      equityCurve.forEach(p => {
        if (p.equity > peak) peak = p.equity;
        const dd = peak - p.equity;
        if (dd > maxDD) maxDD = dd;
      });

      // Expectancy = avg R per trade
      const profitFactor = (() => {
        const gross_w = trades.filter(t => t.r > 0).reduce((s,t) => s + t.r, 0);
        const gross_l = Math.abs(trades.filter(t => t.r < 0).reduce((s,t) => s + t.r, 0));
        return gross_l > 0 ? (gross_w / gross_l).toFixed(2) : '∞';
      })();

      this.lastResult = {
        symbol, mode, minGrade: opts.minGrade || 'B',
        period: {
          fromTs: candles[startIdx]?.ts,
          toTs:   candles[endIdx]?.ts,
          totalCandles: candles.length,
        },
        totalTrades: trades.length,
        wins, losses, winRate,
        totalR:    totalR.toFixed(2),
        avgR:      avgR.toFixed(2),
        maxDrawdown: maxDD.toFixed(2),
        profitFactor,
        equityCurve,
        trades: trades.slice(-30), // last 30 for display
      };

      return this.lastResult;
    } finally {
      this.running = false;
    }
  },

  /** Render results to HTML */
  render(result) {
    if (!result) {
      return '<div style="padding:20px;text-align:center;font-size:7px;color:var(--gray)">ยังไม่ได้รัน backtest — เลือก symbol แล้วกด ▶ Run Backtest</div>';
    }
    if (result.error) {
      return `<div style="padding:20px;text-align:center;font-size:8px;color:var(--red)">❌ ${result.error}</div>`;
    }

    const grade = parseFloat(result.totalR) > 0 && result.winRate >= 50 ? 'A' : parseFloat(result.totalR) > 0 ? 'B' : 'F';
    const gradeColor = grade === 'A' ? '#00ff41' : grade === 'B' ? '#ffe600' : '#ff3333';

    const fromDate = new Date(result.period.fromTs).toLocaleDateString();
    const toDate   = new Date(result.period.toTs).toLocaleDateString();

    // Equity curve as SVG sparkline
    const eq = result.equityCurve;
    let sparkSVG = '';
    if (eq.length > 1) {
      const minE = Math.min(0, ...eq.map(p => p.equity));
      const maxE = Math.max(0, ...eq.map(p => p.equity));
      const W = 600, H = 80;
      const points = eq.map((p, i) => {
        const x = (i / (eq.length - 1)) * W;
        const y = H - ((p.equity - minE) / Math.max(0.01, maxE - minE)) * H;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      const zeroY = H - ((0 - minE) / Math.max(0.01, maxE - minE)) * H;
      sparkSVG = `<svg width="100%" height="80" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="background:var(--bg-dark);border:1px solid var(--border)">
        <line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="#555" stroke-dasharray="2,2"/>
        <polyline points="${points}" stroke="${gradeColor}" stroke-width="1.5" fill="none"/>
      </svg>`;
    }

    const tradesRows = result.trades.length === 0
      ? '<tr><td colspan="6" style="text-align:center;padding:10px;color:var(--gray)">ไม่มี trade เลย — ลองลด minConf หรือ minGrade</td></tr>'
      : result.trades.map(t => {
          const sigCls = t.signal === 'buy' ? 'text-green' : 'text-red';
          const outCls = t.outcome === 'win' ? 'text-green' : 'text-red';
          return `<tr>
            <td>${new Date(t.ts).toLocaleString().slice(0,16)}</td>
            <td class="${sigCls}">${t.signal === 'buy'?'▲':'▼'}</td>
            <td>${t.entry.toFixed(4)}</td>
            <td class="text-red">${t.sl.toFixed(4)}</td>
            <td class="text-green">${t.tp.toFixed(4)}</td>
            <td>${t.duration}</td>
            <td class="${outCls}">${t.outcome === 'win' ? `+${t.r.toFixed(1)}R` : `${t.r.toFixed(1)}R`}</td>
          </tr>`;
        }).join('');

    return `
      <div class="journal-stats">
        <div class="js-tile" style="border-color:${gradeColor};color:${gradeColor}"><div class="js-num">${grade}</div><div class="js-lbl">Strategy Grade</div></div>
        <div class="js-tile"><div class="js-num">${result.totalTrades}</div><div class="js-lbl">Total Trades</div></div>
        <div class="js-tile" style="color:var(--green)"><div class="js-num">${result.wins}</div><div class="js-lbl">Wins</div></div>
        <div class="js-tile" style="color:var(--red)"><div class="js-num">${result.losses}</div><div class="js-lbl">Losses</div></div>
        <div class="js-tile" style="color:var(--teal)"><div class="js-num">${result.winRate}%</div><div class="js-lbl">Win Rate</div></div>
        <div class="js-tile" style="color:var(--gold)"><div class="js-num">${result.totalR}R</div><div class="js-lbl">Total P/L</div></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px">
        <div class="js-tile"><div class="js-num" style="font-size:10px">${result.avgR}R</div><div class="js-lbl">Avg R/Trade</div></div>
        <div class="js-tile" style="color:var(--orange)"><div class="js-num" style="font-size:10px">-${result.maxDrawdown}R</div><div class="js-lbl">Max Drawdown</div></div>
        <div class="js-tile" style="color:var(--purple)"><div class="js-num" style="font-size:10px">${result.profitFactor}</div><div class="js-lbl">Profit Factor</div></div>
        <div class="js-tile"><div class="js-num" style="font-size:7px">${fromDate}<br>→ ${toDate}</div><div class="js-lbl">Period</div></div>
      </div>
      <div style="margin-top:10px;font-size:7px;color:var(--gold)">📈 Equity Curve (R-multiples)</div>
      ${sparkSVG}
      <div style="margin-top:10px;font-size:7px;color:var(--gold)">🗂 Last ${result.trades.length} Trades</div>
      <div class="j-table-wrap" style="max-height:240px">
        <table class="j-table">
          <thead><tr>
            <th>Time</th><th>Side</th><th>Entry</th><th>SL</th><th>TP</th><th>Bars</th><th>R</th>
          </tr></thead>
          <tbody>${tradesRows}</tbody>
        </table>
      </div>
      <div style="margin-top:8px;font-size:6px;color:var(--gray);border-left:2px solid var(--purple);padding-left:6px">
        ⚠️ Backtest = ผลในอดีต ไม่รับประกันอนาคต. รัน multiple times + เทียบหลาย mode/grade เพื่อหา strategy เสถียรที่สุด.
        ปิด MTF ระหว่าง backtest เพราะไม่มี historical MTF cache
      </div>
    `;
  },

  /** Render configuration form + result panel */
  renderUI() {
    const symbol = document.getElementById('bt-symbol')?.value || 'XAUUSD';
    const mode   = document.getElementById('bt-mode')?.value   || Settings.get('tradeMode', 'swing');
    const minGr  = document.getElementById('bt-mingrade')?.value || 'B';
    const minCf  = document.getElementById('bt-minconf')?.value || 60;
    return `
      <div style="background:var(--bg-dark);border:1px solid var(--border);padding:10px;margin-bottom:10px">
        <div style="font-size:8px;color:var(--gold);margin-bottom:8px">🔬 BACKTEST CONFIG</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px">
          <div>
            <label class="form-label">Symbol</label>
            <select id="bt-symbol" class="form-input">
              <option value="XAUUSD" ${symbol==='XAUUSD'?'selected':''}>🥇 XAUUSD</option>
              <option value="AUDUSD" ${symbol==='AUDUSD'?'selected':''}>🇦🇺 AUDUSD</option>
              <option value="EURUSD" ${symbol==='EURUSD'?'selected':''}>🇪🇺 EURUSD</option>
            </select>
          </div>
          <div>
            <label class="form-label">Mode</label>
            <select id="bt-mode" class="form-input">
              <option value="scalp" ${mode==='scalp'?'selected':''}>⚡ Scalp</option>
              <option value="swing" ${mode==='swing'?'selected':''}>🌊 Swing</option>
              <option value="position" ${mode==='position'?'selected':''}>🏔 Position</option>
            </select>
          </div>
          <div>
            <label class="form-label">Min Conf</label>
            <input id="bt-minconf" class="form-input" type="number" min="40" max="95" value="${minCf}">
          </div>
          <div style="display:flex;align-items:end">
            <button class="btn btn-primary" onclick="Backtest.runFromUI()" style="width:100%">▶ Run Backtest</button>
          </div>
        </div>
      </div>
      <div id="bt-result">${this.render(this.lastResult)}</div>
    `;
  },

  async runFromUI() {
    const symbol = document.getElementById('bt-symbol').value;
    const mode   = document.getElementById('bt-mode').value;
    const minConf = parseInt(document.getElementById('bt-minconf').value) || 60;
    document.getElementById('bt-result').innerHTML = '<div style="padding:30px;text-align:center;font-size:9px;color:var(--teal)"><div class="pixel-loader"></div> กำลังรัน backtest...</div>';
    const result = await this.run(symbol, { mode, minConf });
    document.getElementById('bt-result').innerHTML = this.render(result);
  },
};

window.Backtest = Backtest;
