#!/usr/bin/env node
// One-off data fix: the PP-ZZ-D-I-34070…34075 set (Suffix 010 Flooring, 24-367 Observation
// Hall) was submitted and recorded as A4.5 / C02 for all five QA rounds. It is S4 / P01 work.
//
// Six of the rows (QA Round 2, 9 Oct 2026) are additionally titled "24-354-010" — the
// Auditorium — from the wrong-project misfile that predates the ingest guard. Their Item,
// Drawing and Projects relations are correct; only the title text is wrong.
//
// Relabels, across four databases:
//   Submissions   Stage A4.5 -> S4, Revision C02 -> P01, title _A4.5_R{n} -> _S4_R{n},
//                 24-354-010 -> 24-367-010, and Dropbox Path's filename segment
//   Drawings/MDS  Rev C02 -> P01, Submission Stage -> "S4 - For Review and Authorisation"
//   Activity Log  "Rev C02" -> "Rev P01" in the Entry title
//   Actions&Info  "Stage A4.5" -> "Stage S4" in Context, "Rev C02" -> "Rev P01" in Note
//
// QA round numbers are left alone: the five rounds are real review cycles.
//
// Idempotent — it only writes a row whose value still needs changing, so a re-run after a
// partial failure finishes the job rather than doubling up.
//
// Usage:  node tools/fix-ppzz-3407x-stage-rev.js           (dry run, writes nothing)
//         node tools/fix-ppzz-3407x-stage-rev.js --apply   (performs the updates)

require("dotenv").config();
const { Client } = require("@notionhq/client");

const APPLY = process.argv.includes("--apply");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const SUBMISSIONS = process.env.NOTION_DB_SUBMISSIONS;
const DRAWINGS    = process.env.NOTION_DB_DRAWINGS;
const ACTIVITY    = process.env.NOTION_DB_ACTIVITY_LOG;
const ACTIONS     = process.env.NOTION_DB_ACTIONS_INFO;
for (const [k, v] of Object.entries({ SUBMISSIONS, DRAWINGS, ACTIVITY, ACTIONS })) {
  if (!v) { console.error(`Missing database id for ${k} — check .env`); process.exit(1); }
}

const DWGS   = ["34070", "34071", "34072", "34073", "34074", "34075"].map((n) => `EIT-TMJ-PP-ZZ-D-I-${n}`);
// Taken from drawing-flow.js rather than retyped, so the MDS select option cannot drift
// from the one the flow itself writes.
const S4_LABEL = "S4 - For Review and Authorisation";
const MARKER = "PP-ZZ-D-I-3407";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const title = (p, n) => (p.properties?.[n]?.title ?? []).map((t) => t.plain_text).join("");
const text  = (p, n) => (p.properties?.[n]?.rich_text ?? []).map((t) => t.plain_text).join("");
const sel   = (p, n) => p.properties?.[n]?.select?.name ?? null;
const url   = (p, n) => p.properties?.[n]?.url ?? null;

async function queryAll(database_id, filter) {
  const out = []; let cursor;
  do {
    const r = await notion.databases.query({ database_id, filter, start_cursor: cursor, page_size: 100 });
    out.push(...r.results); cursor = r.has_more ? r.next_cursor : null;
    await sleep(120);
  } while (cursor);
  return out;
}

// Rewrites that define the fix. Each returns null when nothing needs changing.
const fixTitle = (t) => {
  const next = t.replace(/^24-354-010_/, "24-367-010_").replace(/_A4\.5_R/, "_S4_R");
  return next === t ? null : next;
};
const fixPath = (p) => {
  if (!p) return null;
  const next = p.replace(/_(?:A4\.5|A45)_C02_/, "_S4_P01_");
  return next === p ? null : next;
};
const fixRev = (s) => (s && /Rev C02/.test(s) ? s.replace(/Rev C02/g, "Rev P01") : null);

const plan = [];
const note = (db, id, what, from, to) => plan.push({ db, id, what, from, to });

(async () => {
  // ── 1. Submissions ────────────────────────────────────────────────────────
  const subs = (await queryAll(SUBMISSIONS, { property: "Submission", title: { contains: MARKER } }))
    .filter((p) => DWGS.some((d) => title(p, "Submission").includes(d)));
  console.log(`Submissions matched: ${subs.length}`);

  const subWrites = [];
  for (const p of subs) {
    const t = title(p, "Submission"), props = {};
    const nt = fixTitle(t);
    if (nt)                           { props["Submission"] = { title: [{ text: { content: nt } }] }; note("Submissions", p.id, "title", t, nt); }
    if (sel(p, "Stage") !== "S4")     { props["Stage"]      = { select: { name: "S4"  } }; note("Submissions", p.id, "Stage", sel(p, "Stage"), "S4"); }
    if (sel(p, "Revision") !== "P01") { props["Revision"]   = { select: { name: "P01" } }; note("Submissions", p.id, "Revision", sel(p, "Revision"), "P01"); }
    const np = fixPath(url(p, "Dropbox Path"));
    if (np)                           { props["Dropbox Path"] = { url: np }; note("Submissions", p.id, "Dropbox Path", url(p, "Dropbox Path"), np); }
    if (Object.keys(props).length) subWrites.push({ page_id: p.id, properties: props });
  }

  // A&I rows are reached through the id each submission recorded, not by searching text.
  const aiIds = [...new Set(subs.map((p) => text(p, "A&I Row")).filter(Boolean))];

  // ── 2. MDS drawings ───────────────────────────────────────────────────────
  const mds = (await queryAll(DRAWINGS, { property: "Drawing Number", title: { contains: MARKER } }))
    .filter((p) => DWGS.includes(title(p, "Drawing Number").trim()));
  console.log(`MDS drawings matched: ${mds.length}`);

  const mdsWrites = [];
  for (const p of mds) {
    const props = {}, dn = title(p, "Drawing Number").trim();
    if (sel(p, "Rev") !== "P01") { props["Rev"] = { select: { name: "P01" } }; note("MDS", p.id, `${dn} Rev`, sel(p, "Rev"), "P01"); }
    const stage = sel(p, "Submission Stage");
    if (stage && stage.startsWith("A4.5")) {
      props["Submission Stage"] = { select: { name: S4_LABEL } };
      note("MDS", p.id, `${dn} Submission Stage`, stage, S4_LABEL);
    }
    if (Object.keys(props).length) mdsWrites.push({ page_id: p.id, properties: props });
  }

  // ── 3. Activity Log ───────────────────────────────────────────────────────
  const logs = (await queryAll(ACTIVITY, { property: "Entry", title: { contains: MARKER } }))
    .filter((p) => DWGS.some((d) => title(p, "Entry").includes(d)));
  console.log(`Activity Log entries matched: ${logs.length}`);

  const logWrites = [];
  for (const p of logs) {
    const e = title(p, "Entry"), ne = fixRev(e);
    if (ne) { logWrites.push({ page_id: p.id, properties: { "Entry": { title: [{ text: { content: ne } }] } } });
              note("ActivityLog", p.id, "Entry", e, ne); }
  }

  // ── 4. Actions & Info ─────────────────────────────────────────────────────
  const ais = [];
  for (const id of aiIds) {
    try { ais.push(await notion.pages.retrieve({ page_id: id })); } catch { console.warn(`  A&I ${id} not retrievable — skipped`); }
    await sleep(120);
  }
  console.log(`A&I rows matched: ${ais.length} (from ${aiIds.length} recorded ids)`);

  const aiWrites = [];
  for (const p of ais) {
    const props = {};
    const ctx = text(p, "Context");
    if (/Stage A4\.5/.test(ctx)) {
      // Context carries a page mention after the text, so rebuild it segment by segment
      // rather than flattening it to a plain string and losing the link.
      const rt = (p.properties?.["Context"]?.rich_text ?? []).map((seg) => {
        if (seg.type !== "text" || !/Stage A4\.5/.test(seg.text?.content ?? "")) return seg;
        return { ...seg, text: { ...seg.text, content: seg.text.content.replace(/Stage A4\.5/g, "Stage S4") } };
      });
      props["Context"] = { rich_text: rt };
      note("A&I", p.id, "Context", "Stage A4.5 · …", "Stage S4 · …");
    }
    const n = title(p, "Note"), nn = fixRev(n);
    if (nn) { props["Note"] = { title: [{ text: { content: nn } }] }; note("A&I", p.id, "Note", n, nn); }
    if (Object.keys(props).length) aiWrites.push({ page_id: p.id, properties: props });
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const all = [...subWrites, ...mdsWrites, ...logWrites, ...aiWrites];
  const byDb = plan.reduce((m, c) => ((m[c.db] = (m[c.db] || 0) + 1), m), {});
  console.log(`\nField changes by database: ${JSON.stringify(byDb)}`);
  console.log(`Pages to update: ${all.length}\n`);
  for (const c of plan.slice(0, 12)) console.log(`  ${c.db.padEnd(12)} ${c.what.padEnd(22)} ${String(c.from).slice(0, 58)}  ->  ${String(c.to).slice(0, 58)}`);
  if (plan.length > 12) console.log(`  … and ${plan.length - 12} more field changes`);

  if (!APPLY) { console.log("\nDRY RUN — nothing written. Re-run with --apply to perform these updates."); return; }

  console.log("\nApplying…");
  let done = 0, failed = 0;
  for (const w of all) {
    try { await notion.pages.update(w); done++; }
    catch (e) { failed++; console.error(`  FAILED ${w.page_id}: ${e.message}`); }
    await sleep(200);
  }
  console.log(`\nDone. ${done} page(s) updated, ${failed} failed.`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error("ABORTED:", e.message); process.exit(1); });
