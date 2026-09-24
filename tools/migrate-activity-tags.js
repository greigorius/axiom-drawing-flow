// One-off migration: rewrite the Item Activity Log's Tag values onto the event-verb set.
//
// It once had a second phase that backfilled the Log's Projects relation from each row's
// Item. That ran successfully on 24 Sep 2026 (329/329 rows), after which Projects was
// converted to a ROLLUP through Task — so it can no longer be written, and the phase was
// removed. Do not reinstate it: a write to a rollup 400s.
// The tag rewrite below is still safe to re-run; rows already on the new vocabulary match
// nothing and are skipped.
//
//   #info      + "submitted by"     -> #submitted
//   #approval  + "approved by DM"   -> #approved
//   #approval  + "issued to client" -> #issued
//   #issue     + "bounced"          -> #returned
//   #response  + Drawing Flow       -> #graded      (client/factory grade)
//   #info      + any other source   -> #note
//   #instruction                    -> #action
//
// #query / #response (RFI) / #decision / #instruction / #action are already correct and
// are left alone. RFI's #response keeps its meaning — only Drawing Flow's overloaded use
// of it (a grade) moves to #graded, which is why Source is part of the match.
//
// Runs read-only by default and prints what it WOULD change. Pass --apply to write.
//
//   node tools/migrate-activity-tags.js            # dry run
//   node tools/migrate-activity-tags.js --apply    # do it
//
// Safe to re-run: rows already on the new vocabulary match nothing and are skipped.
// Afterwards, delete the now-unused #info / #approval / #issue options in the Notion UI
// (Activity Log -> Tag -> the three greyed-out options with a count of 0).

const fs = require("fs");
const path = require("path");

const APPLY = process.argv.includes("--apply");
const NOTION_VERSION = "2022-06-28";

// --- env -------------------------------------------------------------------
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const TOKEN = process.env.NOTION_TOKEN;
const DB    = process.env.NOTION_DB_ACTIVITY_LOG;
if (!TOKEN) { console.error("Missing NOTION_TOKEN (checked .env and the environment)."); process.exit(1); }
if (!DB)    { console.error("Missing NOTION_DB_ACTIVITY_LOG."); process.exit(1); }

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Notion-Version": NOTION_VERSION,
  "Content-Type": "application/json",
};

const plain = (rt) => (rt || []).map((x) => x.plain_text || "").join("");

// --- the mapping -----------------------------------------------------------
// Order matters: the first rule whose test passes wins.
const RULES = [
  { from: "#info",     to: "#submitted", test: (e, s) => /submitted by/i.test(e) },
  // "issued to client" (Drawing Flow) and "Issued via email for comment" (the legacy Email
  // rows) are both an issue-out event. "approved by DM. Queued for issue." says "issue",
  // not "issued", so it falls through to #approved as intended.
  { from: "#approval", to: "#issued",    test: (e, s) => /issued/i.test(e) },
  { from: "#approval", to: "#approved",  test: (e, s) => true },
  { from: "#issue",    to: "#returned",  test: (e, s) => /bounced/i.test(e) },
  { from: "#response", to: "#graded",    test: (e, s) => s === "Drawing Flow" && /grade/i.test(e) },
  { from: "#info",     to: "#note",      test: (e, s) => true },  // any remaining #info
  // #instruction was dropped: one row used it, and an instruction IS an outstanding action.
  // Its colour slot went to #blocked, which A&I needs and the old set had no room for.
  { from: "#instruction", to: "#action", test: (e, s) => true },
];

function newTagFor(tag, entry, source) {
  for (const r of RULES) if (r.from === tag && r.test(entry, source)) return r.to;
  return null;
}

// --- run -------------------------------------------------------------------
(async () => {
  const rows = [];
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    const data = await res.json();
    if (!res.ok) { console.error("Query failed:", data.message || res.status); process.exit(1); }
    rows.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  console.log(`Read ${rows.length} Activity Log rows.\n`);

  const planned = [];
  const untouched = new Map();
  for (const page of rows) {
    const tag    = page.properties?.Tag?.select?.name || "";
    const source = page.properties?.Source?.select?.name || "";
    const entry  = plain(page.properties?.Entry?.title);
    const to     = newTagFor(tag, entry, source);
    if (to) planned.push({ id: page.id, from: tag, to, source, entry });
    else untouched.set(tag || "(none)", (untouched.get(tag || "(none)") || 0) + 1);
  }

  const counts = new Map();
  for (const p of planned) {
    const k = `${p.from} -> ${p.to}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  console.log("Planned changes:");
  for (const [k, n] of [...counts].sort()) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log("\nLeft as-is:");
  for (const [k, n] of [...untouched].sort()) console.log(`  ${String(n).padStart(4)}  ${k}`);

  // Show a sample so the mapping can be eyeballed before it runs for real.
  console.log("\nSample (one per mapping):");
  const shown = new Set();
  for (const p of planned) {
    const k = `${p.from} -> ${p.to}`;
    if (shown.has(k)) continue;
    shown.add(k);
    console.log(`  ${k}\n      ${p.entry.slice(0, 90)}`);
  }

  if (!APPLY) {
    console.log(`\nDry run — nothing written. Re-run with --apply to retag ${planned.length} rows.`);
    return;
  }

  console.log(`\nApplying tags to ${planned.length} rows...`);
  let done = 0, failed = 0;
  for (const p of planned) {
    const res = await fetch(`https://api.notion.com/v1/pages/${p.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ properties: { Tag: { select: { name: p.to } } } }),
    });
    if (res.ok) {
      done++;
      if (done % 25 === 0) console.log(`  ${done}/${planned.length}`);
    } else {
      failed++;
      const d = await res.json().catch(() => ({}));
      console.warn(`  FAILED ${p.id}: ${d.message || res.status}`);
    }
    // Notion allows ~3 requests/second. Stay under it.
    await new Promise((r) => setTimeout(r, 350));
  }
  console.log(`\nDone. ${done} updated, ${failed} failed.`);
  if (!failed) {
    console.log("Now delete the unused #info / #approval / #issue / #instruction options in the Notion UI.");
  }
})().catch((err) => { console.error("Migration failed:", err.message); process.exit(1); });
