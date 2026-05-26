/**
 * MT5 Bridge — Apps Script Web App
 * Receives status from MT5 EA via POST, serves to web dashboard via GET
 *
 * Setup:
 * 1. https://script.google.com → New project
 * 2. Paste this code as Code.gs
 * 3. Deploy → New deployment → Type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Copy the /exec URL
 * 5. Paste URL into:
 *    - MT5 EA → WebhookURL input
 *    - Web dashboard Settings → Bot Bridge URL
 * 6. Add the script domain to MT5 allowed URLs:
 *    Tools → Options → Expert Advisors → "Allow WebRequest" + add:
 *    https://script.google.com
 *    https://script.googleusercontent.com
 */

const SECRET = 'twr-secret';  // Must match EA's WebhookSecret

// ─── POST: Receive status from EA ────────────────────────
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET) {
      return json({ ok: false, error: 'Invalid secret' });
    }

    // Store latest status in script properties (key-value)
    const props = PropertiesService.getScriptProperties();
    data.receivedAt = Date.now();
    props.setProperty('LATEST_STATUS', JSON.stringify(data));

    // Append to history (last 100 records)
    let history;
    try { history = JSON.parse(props.getProperty('HISTORY') || '[]'); }
    catch { history = []; }
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

// ─── GET: Serve status to web dashboard ──────────────────
function doGet(e) {
  // CORS-friendly: any origin can read
  const props = PropertiesService.getScriptProperties();
  const action = (e.parameter && e.parameter.action) || 'status';

  if (action === 'status') {
    const raw = props.getProperty('LATEST_STATUS');
    if (!raw) return json({ ok: false, msg: 'No data yet — EA not connected' });
    const data = JSON.parse(raw);
    // Stale check (>5 min = disconnected)
    const ageSec = (Date.now() - data.receivedAt) / 1000;
    data.ageSec = Math.round(ageSec);
    data.online = ageSec < 300;
    return json({ ok: true, status: data });
  }

  if (action === 'history') {
    const h = JSON.parse(props.getProperty('HISTORY') || '[]');
    return json({ ok: true, history: h });
  }

  if (action === 'clear') {
    props.deleteProperty('LATEST_STATUS');
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
