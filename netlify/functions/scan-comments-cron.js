// Scheduled client-comment scan.
//
// Scenario 3 (Client Comment Ingest) is webhook-only: it has no trigger of its own and runs
// solely when something POSTs its hook. That was a deliberate choice to save Make credits over
// continuous folder-watching — see the note on /api/df/scan-comments — but it meant comments
// were only picked up when someone remembered to press Scan Comments in the cockpit. Between
// 6 and 14 October 2026 nobody did, and a week of client comments went un-ingested.
//
// This fires the same hook on a schedule from Netlify instead of from Make, so the trigger
// itself costs no Make operations. The schedule lives in netlify.toml and runs a few minutes
// after each Scenario 1 ingest poll, so a drawing is in Notion before its comments arrive.
//
// Scenario 3 only forwards PDFs modified in the last two days, and /api/df/cr-ingest dedupes
// against what is already recorded in Notion, so running this repeatedly is safe and cheap.

const WEBHOOK = process.env.MAKE_CR_INGEST_WEBHOOK || process.env.MAKE_ACTIONS_WEBHOOK;

exports.handler = async () => {
  if (!WEBHOOK) {
    console.error("[scan-comments-cron] MAKE_CR_INGEST_WEBHOOK / MAKE_ACTIONS_WEBHOOK not set — nothing fired.");
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "webhook env var not set" }) };
  }

  const requestedAt = new Date().toISOString().slice(0, 10);
  try {
    const resp = await fetch(WEBHOOK, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action: "cr-ingest", requestedAt, source: "netlify-schedule" }),
    });
    // Make answers 200 on receipt, which says nothing about whether the scan succeeded — the
    // scenario's own DLQ is what catches that now. Log the status so a rejected hook is visible.
    if (!resp.ok) {
      console.error(`[scan-comments-cron] hook returned ${resp.status}`);
      return { statusCode: 502, body: JSON.stringify({ ok: false, status: resp.status }) };
    }
    console.log(`[scan-comments-cron] cr-ingest fired (${requestedAt})`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, requestedAt }) };
  } catch (err) {
    console.error("[scan-comments-cron] hook failed:", err.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
