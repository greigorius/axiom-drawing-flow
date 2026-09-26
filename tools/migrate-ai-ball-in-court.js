// One-off migration: move Actions & Info's Ball in Court onto the Submissions vocabulary,
// and clear the two properties that are being retired with it.
//
//   Me       -> DM      (30 rows on 26 Sep 2026)
//   DT Team  -> DT      (2 rows)
//   Closed   -> cleared (0 rows, but the option existed and duplicated `Checked`)
//
// Why: `Ball in Court` is replacing `Status` as the signal for "this is live work". Status
// was filled on 15 of 91 rows and only ever held one of its three values, while gating both
// the Tracked view and the position header — so 76 rows were invisible to the tracker that
// was supposed to be showing them. BIC says the same thing and is the field that was
// actually being used. See handoff §5.3.
//
// The new option names must already exist on the property: the Notion API REFUSES an unknown
// select value rather than creating it ("If a new select option is needed, the data source
// must be updated to add it"), which this script would otherwise hit on its first write.
// They were added on 26 Sep 2026.
//
// Runs read-only by default and prints what it WOULD change. Pass --apply to write.
//
//   node tools/migrate-ai-ball-in-court.js            # dry run
//   node tools/migrate-ai-ball-in-court.js --apply    # do it
//
// Safe to re-run: rows already on the new vocabulary match nothing and are skipped.

const fs   = require("fs");
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
const DB    = process.env.NOTION_DB_ACTIONS_INFO;
if (!TOKEN) { console.error("Missing NOTION_TOKEN (checked .env and the environment)."); process.exit(1); }
if (!DB)    { console.error("Missing NOTION_DB_ACTIONS_INFO."); process.exit(1); }

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Notion-Version": NOTION_VERSION,
  "Content-Type": "application/json",
};

const plain = (rt) => (rt || []).map((x) => x.plain_text || "").join("");

// --- the mapping -----------------------------------------------------------
// null means "clear the value" — `Closed` duplicated the `Checked` checkbox, which is now
// the single completion action.
const BIC_MAP = {
  "Me":          "DM",
  "DT Team":     "DT",
  "DT — Gary":   "DT",
  "DT — Andrew": "DT",
  "Closed":      null,
};

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

  console.log(`Read ${rows.length} Actions & Info rows.\n`);

  const planned = [];
  const untouched = new Map();
  for (const page of rows) {
    const bic     = page.properties?.["Ball in Court"]?.select?.name || "";
    const status  = page.properties?.Status?.select?.name || "";
    const blocker = page.properties?.Blocker?.select?.name || "";
    const note    = plain(page.properties?.Note?.title);

    const mapped    = Object.prototype.hasOwnProperty.call(BIC_MAP, bic);
    // Status and Blocker are being deleted from the schema. Clearing them first is not
    // strictly required — deleting a property discards its values — but it makes the dry
    // run an honest preview of what the rows will look like afterwards.
    const needsWipe = !!status || (!!blocker && blocker !== "—");

    if (mapped || needsWipe) {
      planned.push({
        id: page.id, note,
        from: bic || "(blank)",
        to:   mapped ? (BIC_MAP[bic] ?? "(cleared)") : (bic || "(blank)"),
        bicChanges: mapped,
        status, blocker,
      });
    } else {
      untouched.set(bic || "(blank)", (untouched.get(bic || "(blank)") || 0) + 1);
    }
  }

  const counts = new Map();
  for (const p of planned.filter((x) => x.bicChanges)) {
    const k = `${p.from} -> ${p.to}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  console.log("Ball in Court changes:");
  if (!counts.size) console.log("   (none — already migrated)");
  for (const [k, n] of [...counts].sort()) console.log(`  ${String(n).padStart(4)}  ${k}`);

  const wipes = planned.filter((p) => p.status || (p.blocker && p.blocker !== "—"));
  console.log(`\nStatus / Blocker to clear: ${wipes.length} rows`);

  console.log("\nLeft as-is:");
  for (const [k, n] of [...untouched].sort()) console.log(`  ${String(n).padStart(4)}  ${k}`);

  console.log("\nSample:");
  for (const p of planned.slice(0, 5)) {
    console.log(`  ${p.from} -> ${p.to}${p.status ? `  [clearing Status=${p.status}]` : ""}`);
    console.log(`      ${p.note.slice(0, 90)}`);
  }

  if (!APPLY) {
    console.log(`\nDry run — nothing written. Re-run with --apply to update ${planned.length} rows.`);
    return;
  }

  console.log(`\nApplying to ${planned.length} rows...`);
  let done = 0, failed = 0;
  for (const p of planned) {
    const properties = {};
    if (p.bicChanges) {
      properties["Ball in Court"] = BIC_MAP[p.from] ? { select: { name: BIC_MAP[p.from] } } : { select: null };
    }
    if (p.status)  properties["Status"]  = { select: null };
    if (p.blocker) properties["Blocker"] = { select: null };

    const res = await fetch(`https://api.notion.com/v1/pages/${p.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ properties }),
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
    console.log("Next: delete Status, Blocker and Suggested Complete, and the Me / DT Team /");
    console.log("DT — Gary / DT — Andrew / Closed options, in the Notion UI (handoff §5.3).");
  }
})().catch((err) => { console.error("Migration failed:", err.message); process.exit(1); });
