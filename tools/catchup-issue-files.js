#!/usr/bin/env node
// Re-fires the Scenario 4 "issue-files" webhook for drawings that were issued while
// MAKE_ISSUE_FILES_WEBHOOK was missing from .env. In that state the backend took its
// documented fallback and moved the PDF alone, leaving the DWGs (and anything else the DT
// uploaded beside them) behind in 03_Ready For Issue.
//
// Safe to re-run. Scenario 4 lists 03_Ready For Issue and moves only files whose NAME
// contains the drawing number, so a drawing whose files already moved matches nothing and
// nothing happens. Costs 5 Make operations per drawing either way, so scope it with --since
// rather than firing at the whole history.
//
// BEFORE RUNNING, check no drawing in scope has a NEWER submission sitting at Approved or
// Awaiting Issue: that newer PDF would be in 03_Ready For Issue under the same drawing
// number, and this would move it into 04_Issued as though it had been issued. The script
// refuses to fire for any drawing in that state.
//
// Usage:  node tools/catchup-issue-files.js --since 2026-11-18            (dry run)
//         node tools/catchup-issue-files.js --since 2026-11-18 --apply

require("dotenv").config();
const { Client } = require("@notionhq/client");

const args  = process.argv.slice(2);
const APPLY = args.includes("--apply");
const since = (args[args.indexOf("--since") + 1] || "").match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
if (!since) { console.error("Usage: node tools/catchup-issue-files.js --since YYYY-MM-DD [--apply]"); process.exit(1); }

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const SUBMISSIONS = process.env.NOTION_DB_SUBMISSIONS;
const HOOK        = process.env.MAKE_ISSUE_FILES_WEBHOOK;
if (!SUBMISSIONS) { console.error("NOTION_DB_SUBMISSIONS missing from .env"); process.exit(1); }
if (!HOOK)        { console.error("MAKE_ISSUE_FILES_WEBHOOK missing from .env — that is the bug this script cleans up after."); process.exit(1); }

// Must match drawing-flow.js exactly, or the folders in the payload will not resolve.
const DROPBOX_ROOT = "/DESIGN KNOW HOW/TMJ Interiors";
const READY = "03_Ready For Issue";
const ISSUED = "04_Issued";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const title = (p) => (p.properties?.["Submission"]?.title ?? []).map((t) => t.plain_text).join("");
const pathOf = (p) => p.properties?.["Dropbox Path"]?.url ?? null;
const statusOf = (p) => p.properties?.["Status"]?.select?.name ?? null;

// {Project}-{Item}_{DrawingNo}_{Stage}_R{n} — the drawing number is the section after the
// first underscore. Items can contain an underscore ("200_1"), so work from "EIT-"/the
// first hyphenated section rather than counting separators.
function drawingNoFrom(t) {
  const parts = String(t).split("_");
  return parts.find((seg, i) => i > 0 && seg.includes("-")) ?? null;
}

async function queryAll(filter) {
  const out = []; let cursor;
  do {
    const r = await notion.databases.query({ database_id: SUBMISSIONS, filter, start_cursor: cursor, page_size: 100 });
    out.push(...r.results); cursor = r.has_more ? r.next_cursor : null;
    await sleep(120);
  } while (cursor);
  return out;
}

(async () => {
  const issued = await queryAll({ and: [
    { property: "Issued", date: { on_or_after: since } },
    { or: [{ property: "Status", select: { equals: "Issued" } },
           { property: "Status", select: { equals: "Complete" } }] },
  ]});
  console.log(`Issued on/after ${since}: ${issued.length}`);

  // Anything still queued for issue under the same drawing number is a trap, not a target.
  const pending = await queryAll({ or: [
    { property: "Status", select: { equals: "Approved"       } },
    { property: "Status", select: { equals: "Awaiting Issue" } },
  ]});
  const pendingDwgs = new Set(pending.map((p) => drawingNoFrom(title(p))).filter(Boolean));

  const jobs = [], skipped = [];
  for (const p of issued) {
    const t = title(p), dwg = drawingNoFrom(t), sp = pathOf(p);
    if (!dwg)  { skipped.push([t, "no drawing number in the title"]); continue; }
    if (!sp)   { skipped.push([t, "no Dropbox Path"]); continue; }
    const segs = sp.split("/");                       // Drawing Submissions/{project}/{folder}/{file}
    const i = segs.findIndex((s) => s === ISSUED);
    if (i < 1) { skipped.push([t, `path is not in ${ISSUED}: ${sp}`]); continue; }
    if (pendingDwgs.has(dwg)) { skipped.push([t, `another submission for ${dwg} is awaiting issue — would move the wrong file`]); continue; }

    const projectRoot = `${DROPBOX_ROOT}/${segs.slice(0, i).join("/")}`;
    jobs.push({ submissionId: p.id, title: t, drawingNo: dwg,
      payload: { action: "issue-files", submissionId: p.id, drawingNo: dwg,
                 fromFolder: `${projectRoot}/${READY}`, toFolder: `${projectRoot}/${ISSUED}`,
                 toFolderParent: projectRoot, toFolderName: ISSUED } });
  }

  for (const [t, why] of skipped) console.log(`  SKIP  ${t}  — ${why}`);
  console.log(`\nWill re-fire issue-files for ${jobs.length} drawing(s)  (~${jobs.length * 5} Make operations)`);
  for (const j of jobs) console.log(`  ${j.drawingNo.padEnd(26)} ${j.payload.fromFolder.replace(DROPBOX_ROOT + "/", "")}  ->  ${ISSUED}`);

  if (!APPLY) { console.log("\nDRY RUN — nothing fired. Re-run with --apply."); return; }

  console.log("\nFiring…");
  let ok = 0, bad = 0;
  for (const j of jobs) {
    try {
      const r = await fetch(HOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(j.payload) });
      if (r.ok) { ok++; console.log(`  sent  ${j.drawingNo}`); }
      else      { bad++; console.error(`  FAIL  ${j.drawingNo} — HTTP ${r.status}`); }
    } catch (e) { bad++; console.error(`  FAIL  ${j.drawingNo} — ${e.message}`); }
    await sleep(1000);   // one per second; Scenario 4 runs instantly and is not sequential
  }
  console.log(`\nDone. ${ok} fired, ${bad} failed.`);
  console.log("Check Make → Scenario 4 executions, then confirm 03_Ready For Issue is empty of these drawings.");
  if (bad) process.exitCode = 1;
})().catch((e) => { console.error("ABORTED:", e.message); process.exit(1); });
