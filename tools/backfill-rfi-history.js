// One-off backfill: write the RFI database's history into the Item Activity Log.
//
// The RFI generator only started logging on 23 Sep 2026, so everything before that is
// invisible to the feed. Every RFI carries real dates, so the history can be reconstructed
// exactly — up to three entries per RFI:
//
//   Date Raised     -> #query     "RFI-048 — Door B2-058-01 - Acoustic requirements raised."
//   Date Responded  -> #response  "RFI-048 — … — response received from {Responded By}."
//   Date Closed     -> #decision  "RFI-048 — … closed out."
//
// Each entry's **Event Date** is set to that date, which is what puts it in the right place
// in the feed: the feed and the export both sort on `Event Date || Created`. Without it every
// entry would stack up at "now", which is the whole problem this fixes.
//
//   node tools/backfill-rfi-history.js            # dry run — prints the plan, writes nothing
//   node tools/backfill-rfi-history.js --apply    # do it
//
// SAFE TO RE-RUN. Before writing anything it reads every existing Source=RFI entry in the Log
// and keys them on "<rfi page id>|<tag>". Anything already there is skipped — including the
// entries the live RFI generator has written since 23 Sep, so this can never duplicate them.
//
// Not written: Projects (a rollup through Task — see the handoff §5.1) and Detail beyond the
// response text. Nothing is invented: an RFI closed without a Date Responded gets raised and
// closed only. 66 of the 94 are in that state, so the 2025 history is genuinely sparser than
// the work was — that is honest rather than wrong.

const fs   = require("fs");
const path = require("path");

const APPLY = process.argv.includes("--apply");
const NOTION_VERSION = "2022-06-28";

// --- env --------------------------------------------------------------------
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const TOKEN = process.env.NOTION_TOKEN;
const RFIS  = process.env.NOTION_DB_RFIS;
const LOG   = process.env.NOTION_DB_ACTIVITY_LOG;
for (const [k, v] of [["NOTION_TOKEN", TOKEN], ["NOTION_DB_RFIS", RFIS], ["NOTION_DB_ACTIVITY_LOG", LOG]]) {
  if (!v) { console.error(`Missing ${k} (checked .env and the environment).`); process.exit(1); }
}
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Notion-Version": NOTION_VERSION,
  "Content-Type": "application/json",
};

// --- helpers ----------------------------------------------------------------
const plain = (rt) => (rt || []).map((x) => x.plain_text || "").join("").trim();

// Property types on the RFI database, checked against the live schema 25 Sep 2026 — getting
// these wrong fails silently rather than erroring, which is exactly what happened on the
// first dry run (every label came out as a bare "RFI-009." with no description):
//   RFI Description  TITLE      <- not rich_text
//   Question         rich_text
//   Response         rich_text
//   Responded By     SELECT     <- not rich_text
//   RFI Number       number
const text   = (prop) => plain(prop?.title || prop?.rich_text);
const choice = (prop) => prop?.select?.name || "";
const rfiRef = (n) =>
  (n === null || n === undefined || n === "") ? "RFI-?" : `RFI-${String(n).padStart(3, "0")}`;

// Some RFI descriptions already open with their own reference ("RFI-048 — Door B2-058-01 …").
// Strip it so the label does not print the number twice. Same rule as _activity-log.js in the
// rfi-generator repo — if you change one, change both.
const stripLeadingRef = (s) =>
  String(s || "").replace(/^\s*RFI[\s\-_]*\d+\s*[—–\-:.]*\s*/i, "").trim();

function rfiLabel(n, description) {
  const body = stripLeadingRef(description);
  return body ? `${rfiRef(n)} — ${body}` : rfiRef(n);
}

async function queryAll(dbId) {
  const out = [];
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST", headers,
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    const data = await res.json();
    if (!res.ok) { console.error("Query failed:", data.message || res.status); process.exit(1); }
    out.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return out;
}

// --- run --------------------------------------------------------------------
(async () => {
  const rfis = await queryAll(RFIS);
  const log  = await queryAll(LOG);
  console.log(`Read ${rfis.length} RFIs and ${log.length} Activity Log rows.\n`);

  // Existing Source=RFI entries, keyed on the RFI page id in their Link plus the tag. The RFI
  // page id is the last 32 hex characters of the url, after the title slug.
  const seen = new Set();
  for (const e of log) {
    if (e.properties?.Source?.select?.name !== "RFI") continue;
    const link = e.properties?.Link?.url || "";
    const id   = (link.replace(/-/g, "").match(/[0-9a-f]{32}/g) || []).pop();
    const tag  = e.properties?.Tag?.select?.name || "";
    if (id) seen.add(`${id}|${tag}`);
  }
  console.log(`${seen.size} RFI entries already in the Log — those are skipped.\n`);

  const planned = [];
  const noItem  = [];
  for (const r of rfis) {
    const p     = r.properties;
    const num   = p["RFI Number"]?.number;
    const desc  = text(p["RFI Description"]);
    const label = rfiLabel(num, desc);
    const items = (p["Related Item(s)"]?.relation || []).map((x) => x.id);
    const url   = r.url;
    const bare  = r.id.replace(/-/g, "");
    if (!items.length) noItem.push(label);

    const who      = choice(p["Responded By"]) || "the consultant";
    const response = text(p["Response"]);
    const question = text(p["Question"]);

    const events = [
      // Detail carries the question, not the description — the description is already the
      // label, and repeating it in both fields just makes the feed row twice as long.
      { date: p["Date Raised"]?.date?.start,    tag: "#query",    entry: `${label} raised.`,                          detail: question },
      { date: p["Date Responded"]?.date?.start, tag: "#response", entry: `${label} — response received from ${who}.`, detail: response },
      { date: p["Date Closed"]?.date?.start,    tag: "#decision", entry: `${label} closed out.`,                      detail: "" },
    ];

    for (const ev of events) {
      if (!ev.date) continue;
      if (seen.has(`${bare}|${ev.tag}`)) continue;
      planned.push({ ...ev, items, url, label });
    }
  }

  planned.sort((a, b) => a.date.localeCompare(b.date));

  const byTag = new Map();
  for (const e of planned) byTag.set(e.tag, (byTag.get(e.tag) || 0) + 1);
  console.log("Planned entries:");
  for (const [k, v] of [...byTag].sort()) console.log(`  ${String(v).padStart(4)}  ${k}`);
  console.log(`  ${String(planned.length).padStart(4)}  total`);
  if (planned.length) console.log(`\nDate range: ${planned[0].date} → ${planned[planned.length - 1].date}`);
  if (noItem.length) {
    console.log(`\n${noItem.length} RFI(s) have no Related Item — their entries will be unlinked:`);
    noItem.slice(0, 10).forEach((l) => console.log(`  ${l}`));
  }

  console.log("\nFirst five, oldest first:");
  planned.slice(0, 5).forEach((e) => console.log(`  ${e.date}  ${e.tag.padEnd(10)} ${e.entry.slice(0, 80)}`));
  console.log("Last five:");
  planned.slice(-5).forEach((e) => console.log(`  ${e.date}  ${e.tag.padEnd(10)} ${e.entry.slice(0, 80)}`));

  if (!APPLY) {
    console.log(`\nDry run — nothing written. Re-run with --apply to create ${planned.length} entries.`);
    return;
  }

  console.log(`\nWriting ${planned.length} entries...`);
  let done = 0, failed = 0;
  for (const e of planned) {
    const properties = {
      "Entry":      { title:     [{ text: { content: e.entry.slice(0, 1900) } }] },
      "Source":     { select:    { name: "RFI" } },
      "Tag":        { select:    { name: e.tag } },
      "Author":     { rich_text: [{ text: { content: "DM" } }] },
      "Event Date": { date:      { start: e.date } },
      "Link":       { url: e.url },
    };
    if (e.items.length) properties["Task"] = { relation: e.items.map((id) => ({ id })) };
    if (e.detail)       properties["Detail"] = { rich_text: [{ text: { content: e.detail.slice(0, 1900) } }] };

    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST", headers,
      body: JSON.stringify({ parent: { database_id: LOG }, properties }),
    });
    if (res.ok) {
      done++;
      if (done % 25 === 0) console.log(`  ${done}/${planned.length}`);
    } else {
      failed++;
      const d = await res.json().catch(() => ({}));
      console.warn(`  FAILED ${e.entry.slice(0, 50)}: ${d.message || res.status}`);
    }
    await new Promise((r) => setTimeout(r, 350));   // Notion allows ~3 req/sec
  }
  console.log(`\nDone. ${done} written, ${failed} failed.`);
})().catch((err) => { console.error("Backfill failed:", err.message); process.exit(1); });
