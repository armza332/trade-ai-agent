/**
 * MT5 Bridge — Apps Script Web App (Phase 12.3)
 *
 * Endpoints:
 *   POST /                 ← EA pushes status + prices
 *   GET  /?action=status   → Latest status JSON (balance, equity, positions...)
 *   GET  /?action=prices   → Latest prices (bid/ask/RSI/ATR/BB for each symbol)
 *   GET  /?action=history  → Last 100 status snapshots
 *   GET  /?action=clear    → Wipe stored data
 *
 * Setup:
 * 1. https://script.google.com → New project
 * 2. Paste as Code.gs
 * 3. Deploy → New deployment → Web app (Execute: Me, Access: Anyone)
 * 4. Copy /exec URL → paste into EA WebhookURL + web Settings → Bot Bridge URL
 * 5. MT5 → Tools → Options → Expert Advisors → Allow WebRequest + add:
 *      https://script.google.com
 *      https://script.googleusercontent.com
 */

const SECRET = 'twr-secret';  // Must match EA's WebhookSecret

// ─── POST: Receive status from EA ────────────────────────
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET) {
      return json({ ok: false, error: 'Invalid secret' });
    }

    const props = PropertiesService.getScriptProperties();
    data.receivedAt = Date.now();
    props.setProperty('LATEST_STATUS', JSON.stringify(data));

    // Phase 12.3: store prices separately for fast ?action=prices endpoint
    if (data.prices && typeof data.prices === 'object') {
      const pricesPayload = {
        prices:     data.prices,
        ts:         data.ts,
        receivedAt: data.receivedAt,
        symbols:    data.symbols || [],
      };
      props.setProperty('LATEST_PRICES', JSON.stringify(pricesPayload));
    }

    // Append to history (last 100 records)
    let history;
    try { history = JSON.parse(props.getProperty('HISTORY') || '[]'); }
    catch (e) { history = []; }
    history.unshift({
      ts:       data.ts,
      balance:  data.balance,
      equity:   data.equity,
      pnl:      data.todayPnL,
      wins:     data.todayWins,
      losses:   data.todayLosses,
      posCount: (data.positions || []).length,
    });
    if (history.length > 100) history.length = 100;
    props.setProperty('HISTORY', JSON.stringify(history));

    return json({ ok: true, msg: 'received' });
  } catch (err) {
    return json({ ok: false, error: err.toString() });
  }
}

// ─── GET: Serve to web dashboard ─────────────────────────
function doGet(e) {
  const props = PropertiesService.getScriptProperties();
  const action = (e.parameter && e.parameter.action) || 'status';

  if (action === 'status') {
    const raw = props.getProperty('LATEST_STATUS');
    if (!raw) return json({ ok: false, msg: 'No data yet — EA not connected' });
    const data = JSON.parse(raw);
    const ageSec = (Date.now() - data.receivedAt) / 1000;
    data.ageSec = Math.round(ageSec);
    data.online = ageSec < 300;
    return json({ ok: true, status: data });
  }

  if (action === 'prices') {
    const raw = props.getProperty('LATEST_PRICES');
    if (!raw) return json({ ok: false, msg: 'No prices yet — EA not connected' });
    const data = JSON.parse(raw);
    const ageSec = (Date.now() - data.receivedAt) / 1000;
    data.ageSec = Math.round(ageSec);
    data.online = ageSec < 300;
    return json({ ok: true, prices: data.prices, ts: data.ts, ageSec: data.ageSec, online: data.online, symbols: data.symbols });
  }

  if (action === 'history') {
    const h = JSON.parse(props.getProperty('HISTORY') || '[]');
    return json({ ok: true, history: h });
  }

  if (action === 'clear') {
    props.deleteProperty('LATEST_STATUS');
    props.deleteProperty('LATEST_PRICES');
    props.deleteProperty('HISTORY');
    return json({ ok: true, msg: 'Cleared' });
  }

  return json({ ok: false, msg: 'Unknown action' });
}

// Helper: JSON response
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
