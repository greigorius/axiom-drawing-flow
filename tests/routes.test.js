// Route-level smoke tests with a mocked Notion client, Express app and Make webhook.
// Run: node tests/routes.test.js
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const env = { NOTION_DB_SUBMISSIONS: "SUBS", NOTION_DB_DRAWINGS: "DWGS", NOTION_DB_TEAM: "TEAM", NOTION_DB_TASKS: "TASKS", MAKE_ACTIONS_WEBHOOK: "https://hook.test/actions" };
const feed = [];
const blobs = { getStore: () => ({ get: async () => feed, setJSON: async (_k, v) => { feed.splice(0, feed.length, ...v); } }) };
const webhooks = [];
const fetchMock = async (url, opts) => { webhooks.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, text: async () => "Accepted" }; };
const mod = { exports: {} };
const srcPath = fs.existsSync(__dirname + "/drawing-flow.js") ? __dirname + "/drawing-flow.js" : __dirname + "/../drawing-flow.js";
vm.runInNewContext(fs.readFileSync(srcPath, "utf8"),
  { module: mod, exports: mod.exports, require: (n) => n === "@netlify/blobs" ? blobs
      : n === "./public/lanes.js" ? require(srcPath.replace(/drawing-flow\.js$/, "public/lanes.js")) : require(n), process: { env }, console: { ...console, log(){}, warn(){} }, fetch: fetchMock, setTimeout, Promise, Date, Map, Set, JSON, Math });

// ---- Notion mock ---------------------------------------------------------
const title = (t) => ({ title: [{ plain_text: t }] });
const rt    = (t) => ({ rich_text: t ? [{ plain_text: t, text: { content: t } }] : [] });
const rel   = (...ids) => ({ relation: ids.map((id) => ({ id })) });
const sel   = (n) => ({ select: n ? { name: n } : null });
const pages = {
  task1: { id: "task1", properties: { "Item Name": title("Suffix 003 Reception desk"), "Item No.": { formula: { type: "string", string: "003" } }, "Person": rel("dtAI") } },
  task2: { id: "task2", properties: { "Item Name": title("Suffix 004 Bar"), "Item No.": { formula: { type: "string", string: "004" } }, "Person": rel() } },
  // Real pair from the Tasks DB: a base item and its derivative, whose Item No. formula reads the same.
  task200:  { id: "task200",  properties: { "Item Name": title("Suffix 200 - LIN-804 Soft Cell Wall Panelling"), "Item No.": { formula: { type: "string", string: "200" } }, "Person": rel("dtAI") } },
  task200d: { id: "task200d", properties: { "Item Name": title("Suffix 200_1 - LIN-804 Soft Cell Wall Panelling - Lobby"), "Item No.": { formula: { type: "string", string: "200" } }, "Person": rel("dtAI") } },
  dwg1:  { id: "dwg1", properties: { "Drawing Number": title("EIT-TMJ-AA-B2-D-I-45120"), "Dwg No. Assigned": sel(null) } },
  dtGF:  { id: "dtGF", properties: { "Name": title("Greig Fensome"), "Email": { email: "g@x.com" } } },
  dtAI:  { id: "dtAI", properties: { "Name": title("Andrew Isted"), "Email": { email: "a@x.com" } } },
};
let submissions = [];
const created = [], updates = [];
// Minimal evaluator for the Notion filters drawing-flow.js uses on the Submissions DB.
const val = (page, prop) => page.properties[prop];
const match = (page, f) => {
  if (!f) return true;
  if (f.and) return f.and.every((x) => match(page, x));
  const p = val(page, f.property);
  if (f.url) {
    const v = p?.url ?? null;
    if (f.url.ends_with   !== undefined) return (v ?? "").endsWith(f.url.ends_with);
    if (f.url.contains    !== undefined) return (v ?? "").includes(f.url.contains);
    if (f.url.is_not_empty!== undefined) return f.url.is_not_empty ? !!v : !v;
    return v === f.url.equals;
  }
  if (f.select)   return (p?.select?.name ?? null) === f.select.equals;
  if (f.checkbox) return (p?.checkbox ?? false) === f.checkbox.equals;
  if (f.relation) return (p?.relation ?? []).some((r) => r.id === f.relation.contains);
  return true;
};
const notion = {
  databases: { query: async ({ database_id, filter, sorts }) => {
    const f = JSON.stringify(filter);
    if (database_id === "TASKS") return { results:
      f.includes("Suffix 003")   ? [pages.task1]
      : f.includes("Suffix 004") ? [pages.task2]
      // Notion's "contains" returns the derivative too — order deliberately puts it first.
      : f.includes("Suffix 200_1") ? [pages.task200d]
      : f.includes("Suffix 200")   ? [pages.task200d, pages.task200]
      : [] };
    if (database_id === "DWGS")  return { results: [pages.dwg1] };
    if (database_id === "TEAM")  return { results: [pages.dtGF, pages.dtAI] };
    if (database_id === "SUBS") {
      let r = submissions.filter((s) => match(s, filter));
      if (sorts?.[0]?.property === "QA Round") r = r.sort((a, b) => (b.properties["QA Round"]?.number ?? 0) - (a.properties["QA Round"]?.number ?? 0));
      return { results: r, has_more: false };
    }
    return { results: [] };
  }},
  pages: {
    create: async ({ properties }) => { const p = { id: `new${created.length + 1}`, properties }; created.push(p); return p; },
    update: async (u) => { updates.push(u); return {}; },
    retrieve: async ({ page_id }) => pages[page_id] || submissions.find((s) => s.id === page_id) || (() => { throw new Error("404"); })(),
  },
};

// ---- Express mock ----------------------------------------------------------
const routes = {};
const app = new Proxy({}, { get: (_t, m) => (path, h) => { routes[`${m.toUpperCase()} ${path}`] = h; } });
mod.exports(app, notion);
const call = async (key, { body = {}, params = {} } = {}) => {
  let status = 200, json;
  const res = { status(c) { status = c; return res; }, json(j) { json = j; return res; } };
  await routes[key]({ body, params, query: {} }, res);
  return { status, json };
};
const hook = (action) => webhooks.filter((w) => w.body.action === action).pop()?.body;
const R = "/DESIGN KNOW HOW/TMJ Interiors/Drawing Submissions";
const DWG = "EIT-TMJ-AA-B2-D-I-45120";
let n = 0; const ok = (name) => { n++; console.log("✓", name); };

(async () => {
  // ── Ingest ──────────────────────────────────────────────────────────────
  let r = await call("POST /api/df/ingest", { body: { filePath: `${R}/24-367/Pending/003_S4_P01_${DWG}_AI.pdf`, dropboxPath: `${R}/24-367/Pending/003_S4_P01_${DWG}_AI.pdf` } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.dtSource, "initials");
  let p = created[0].properties;
  assert.strictEqual(p.Stage.select.name, "S4"); assert.strictEqual(p.Revision.select.name, "P01");
  assert.strictEqual(p.DT.relation[0].id, "dtAI");
  assert.strictEqual(p["Dropbox Path"].url, `Drawing Submissions/24-367/Pending/003_S4_P01_${DWG}_AI.pdf`);
  assert.strictEqual(p.Submission.title[0].text.content, `24-367-003_${DWG}_S4_R1`);
  ok("ingest v2 → DT from initials, stage from filename");

  r = await call("POST /api/df/ingest", { body: { filePath: `${R}/24-367/Pending/003_A4.5_C01_${DWG}_GF.pdf` } });
  assert.strictEqual(r.json.dtSource, "initials"); assert.strictEqual(created[1].properties.DT.relation[0].id, "dtGF");
  assert.strictEqual(created[1].properties.Stage.select.name, "A4.5");
  ok("ingest v2 with initials → DT from initials");

  r = await call("POST /api/df/ingest", { body: { filePath: `${R}/24-367/Pending/004_S5_P02_${DWG}.pdf` } });
  assert.strictEqual(r.status, 400); assert.match(feed[0].message, /initials missing/);
  ok("missing initials → rejected with rename hint");

  r = await call("POST /api/df/ingest", { body: { filePath: `${R}/24-367/Pending/003_S5_P02_${DWG}_ZZ.pdf` } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.dtSource, "item");
  assert.strictEqual(created[2].properties.DT.relation[0].id, "dtAI");
  assert.match(feed[0].message, /no DT matched initials "ZZ"/);
  ok("unknown initials → falls back to Item Person + flagged");

  // Derivative items: 200 and 200_1 are different items and must not be confused
  r = await call("POST /api/df/ingest", { body: { filePath: `${R}/24-367/01_Pending/200_S4_P01_${DWG}_AI.pdf` } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  let pi = created[created.length - 1].properties;
  assert.strictEqual(pi.Item.relation[0].id, "task200");
  assert.strictEqual(pi.Submission.title[0].text.content, `24-367-200_${DWG}_S4_R1`);
  r = await call("POST /api/df/ingest", { body: { filePath: `${R}/24-367/01_Pending/200_1_S4_P01_${DWG}_AI.pdf` } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  pi = created[created.length - 1].properties;
  assert.strictEqual(pi.Item.relation[0].id, "task200d");
  assert.strictEqual(pi.Submission.title[0].text.content, `24-367-200_1_${DWG}_S4_R1`);
  assert.strictEqual(pi.Stage.select.name, "S4"); assert.strictEqual(pi.Revision.select.name, "P01");
  ok("ingest: 200 → Suffix 200, 200_1 → Suffix 200_1 (derivative items kept apart)");


  r = await call("POST /api/df/ingest", { body: { filePath: `${R}/24-367/Pending/004_S5_P02_${DWG}_ZZ.pdf` } });
  assert.strictEqual(r.status, 200); assert.ok(!created[created.length - 1].properties.DT); assert.match(feed[0].message, /set DT manually/);
  ok("unknown initials + no Item Person → created, DT flagged for manual set");

  r = await call("POST /api/df/ingest", { body: { filePath: `${R}/24-367/S5/Pending/003_${DWG}_P03_GF.pdf` } });
  assert.strictEqual(r.status, 200); assert.strictEqual(created[created.length - 1].properties.Stage.select.name, "S5");
  ok("legacy stage-folder ingest still works");

  r = await call("POST /api/df/ingest", { body: { filePath: `${R}/24-367/Pending/003_${DWG}_P01_GF.pdf` } });
  assert.strictEqual(r.status, 400); assert.match(feed[0].message, /Old-style filename/);
  ok("old-style name in new Pending → clear error");

  r = await call("POST /api/df/ingest", { body: { filePath: `${R}/24-367/Pending/003_S6_P01_A-101_GF.pdf` } });
  assert.strictEqual(r.status, 400); assert.match(feed[0].message, /isn't a stage/);
  ok("typo'd stage → clear error");

  r = await call("POST /api/df/ingest", { body: { filePath: `${R}/24-367/Pending/003_S4_P01_${DWG}_GF (Greig's conflicted copy).pdf` } });
  assert.strictEqual(r.status, 400); assert.match(feed[0].message, /duplicate copy/);
  ok("conflicted copy rejected");

  // Drawboard save re-surfaces a still-Submitted file → skipped silently
  submissions = [{ id: "subX", properties: { "Status": sel("Submitted"), "Dropbox Path": { url: "Drawing Submissions/24-367/Pending/003_S4_P01_A-101.pdf" } } }];
  const feedLen = feed.length;
  r = await call("POST /api/df/ingest", { body: { filePath: `${R}/24-367/Pending/003_S4_P01_A-101.pdf` } });
  assert.strictEqual(r.json.duplicate, true); assert.strictEqual(feed.length, feedLen);
  ok("Drawboard re-save of a Submitted file (even pre-initials name) → skipped, no feed noise");

  // Pending folder renamed ("Pending" → "01_Pending"): same file re-surfaces at a new path → repointed, not duplicated
  submissions = [{ id: "subP", properties: { "Status": sel("Submitted"), "Dropbox Path": { url: `Drawing Submissions/24-367/Pending/003_S4_P01_${DWG}_GF.pdf` } } }];
  updates.length = 0; const createdBefore = created.length;
  r = await call("POST /api/df/ingest", { body: { filePath: `${R}/24-367/01_Pending/003_S4_P01_${DWG}_GF.pdf` } });
  assert.strictEqual(r.json.repointed, true); assert.strictEqual(created.length, createdBefore);
  assert.strictEqual(updates[0].properties["Dropbox Path"].url, `Drawing Submissions/24-367/01_Pending/003_S4_P01_${DWG}_GF.pdf`);
  ok("renamed Pending folder → existing row repointed, no duplicate submission");

  // Same rev re-appearing after an Approve → created but flagged
  submissions = [{ id: "subOld", properties: { "Drawing": rel("dwg1"), "Stage": sel("S4"), "QA Round": { number: 1 }, "Revision": sel("P01"), "Status": sel("Approved"),
    "Dropbox Path": { url: `Drawing Submissions/24-367/04_Issued/003_S4_P01_${DWG}.pdf` } } }];
  r = await call("POST /api/df/ingest", { body: { filePath: `${R}/24-367/Pending/003_S4_P01_${DWG}_GF.pdf` } });
  assert.strictEqual(r.status, 200); assert.match(feed[0].message, /same Rev as QA R1 \(Approved\)/);
  ok("same-rev resubmission flagged as possible Drawboard re-sync");

  // ── Approve / Bounce ───────────────────────────────────────────────────
  const sub = (id, extra) => ({ id, properties: { "Status": sel("Submitted"), "Stage": sel("S4"), "Submission": title(`24-367-003_${DWG}_S4_R1`),
    "DT": rel("dtAI"), "Item": rel(), "Revision": sel("P01"), ...extra } });
  submissions = [sub("subA", { "Dropbox Path": { url: `Drawing Submissions/24-367/01_Pending/003_S4_P01_${DWG}_GF.pdf` } })];
  webhooks.length = 0; updates.length = 0;
  r = await call("PATCH /api/df/submissions/:id/approve", { params: { id: "subA" } });
  assert.strictEqual(r.status, 200);
  let a = hook("approve");
  assert.strictEqual(a.dropboxMove.toFolderParent, `${R}/24-367`); assert.strictEqual(a.dropboxMove.toFolderName, "03_Ready For Issue");
  assert.strictEqual(a.dropboxMove.newFilename, `003_S4_P01_${DWG}_GF.pdf`);
  assert.strictEqual(a.suffixFolderPath, `${R}/24-367/03_Ready For Issue`); assert.strictEqual(a.uploadPath, `${R}/24-367/03_Ready For Issue`);
  assert.deepStrictEqual(a.approvedDrawingNos, [DWG]);
  assert.strictEqual(updates[0].properties["Dropbox Path"].url, `Drawing Submissions/24-367/03_Ready For Issue/003_S4_P01_${DWG}_GF.pdf`);
  assert.strictEqual(updates[0].properties.Status.select.name, "Approved");
  ok("approve → {Project}/03_Ready For Issue, filename unchanged, path written with status");

  submissions = [sub("subB", { "QA Round": { number: 2 }, "Revision": sel("P02"), "Dropbox Path": { url: `Drawing Submissions/24-367/Pending/003_S4_P02_${DWG}_GF.pdf` } })];
  webhooks.length = 0; updates.length = 0;
  r = await call("PATCH /api/df/submissions/:id/bounce", { params: { id: "subB" }, body: {} });
  let b = hook("bounce");
  assert.strictEqual(b.bounceFolderPath, `${R}/24-367/02_Rejected`);
  assert.strictEqual(b.dropboxMove.toFolderParent, `${R}/24-367`); assert.strictEqual(b.dropboxMove.toFolderName, "02_Rejected");
  assert.strictEqual(b.dropboxMove.newFilename, `003_S4_P02_${DWG}_GF_R2.pdf`);
  assert.ok(!("hasAnnotatedPdf" in b) && !("miroLink" in b) && !("annotatedDropboxPath" in b));
  assert.strictEqual(updates[0].properties["Dropbox Path"].url, `Drawing Submissions/24-367/02_Rejected/003_S4_P02_${DWG}_GF_R2.pdf`);
  ok("bounce → {Project}/02_Rejected/…_R2.pdf, no DT Checker/Miro fields");

  submissions[0].properties.Status = sel("Rejected");
  r = await call("PATCH /api/df/submissions/:id/bounce", { params: { id: "subB" }, body: {} });
  assert.strictEqual(r.status, 409);
  r = await call("PATCH /api/df/submissions/:id/approve", { params: { id: "subB" } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(routes["GET /api/df/submissions/:id/bounce-dest"], undefined);
  ok("approve/bounce refuse non-Submitted (double-click safe); bounce-dest removed");

  // ── Client comments ────────────────────────────────────────────────────
  const issued = (id, stage, rev, extra = {}) => ({ id, properties: { "Status": sel("Issued"), "Stage": sel(stage), "Revision": sel(rev), "QA Round": { number: 1 },
    "Drawing": rel("dwg1"), "Submission": title(`24-367-003_${DWG}_${stage}_R1`), "DT": rel("dtAI"), "Item": rel(), ...extra } });
  submissions = [issued("subI", "S5", "P02")];
  updates.length = 0;
  r = await call("POST /api/df/cr-ingest", { body: { filePath: `${R}/24-367/05_Client Comments/MC_260910_${DWG}_P02.pdf`, shareLink: "https://db/x" } });
  assert.strictEqual(r.json.stage, "S5"); assert.strictEqual(r.json.submissionId, "subI");
  const subUpd = updates.find((u) => u.page_id === "subI").properties;
  assert.strictEqual(subUpd["DM Action"].select.name, "Review Comments");
  assert.strictEqual(subUpd["Comment Paths"].rich_text[0].text.content, `Drawing Submissions/24-367/05_Client Comments/MC_260910_${DWG}_P02.pdf`);
  assert.ok(updates.find((u) => u.page_id === "dwg1").properties["S5 Comment Files"]);
  ok("cr-ingest (project-level folder) → stage from Issued submission, path stored");

  updates.length = 0;
  r = await call("POST /api/df/cr-ingest", { body: { filePath: `${R}/24-367/S4/Client Comments/AR_260910_${DWG}_P01.pdf` } });
  assert.strictEqual(r.json.stage, "S4");
  ok("cr-ingest (legacy stage folder) → stage from folder");

  // Current naming: {YYMMDD}_{Commenter}_{Item}_{Stage}_{Rev}_{DrawingNo} — stage + rev from the name
  submissions = [issued("subS4", "S4", "P01"), issued("subS5", "S5", "P02")];
  updates.length = 0;
  r = await call("POST /api/df/cr-ingest", { body: { filePath: `${R}/24-367/05_Client Comments/260604_F&P_003_S4_P01_${DWG}.PDF`, filename: `260604_F&P_003_S4_P01_${DWG}.PDF` } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.stage, "S4"); assert.strictEqual(r.json.submissionId, "subS4"); assert.strictEqual(r.json.clientAcronym, "F&P");
  const s4Dwg = updates.find((u) => u.page_id === "dwg1").properties;
  assert.ok(s4Dwg["S4 Comment Files"]); assert.strictEqual(JSON.stringify(s4Dwg["S4 Client Reviewers"].multi_select), JSON.stringify([{ name: "F&P" }]));
  assert.ok(updates.find((u) => u.page_id === "subS4")); assert.ok(!updates.find((u) => u.page_id === "subS5"));
  ok("cr-ingest: 260604_F&P_003_S4_P01_{DrawingNo}.PDF → S4 submission (stage from filename, not the newer S5)");

  // Stage in the name with no Issued submission at that stage → logged, flagged in the feed, no card moved
  submissions = [issued("subS5", "S5", "P02")];
  updates.length = 0; feed.length = 0;
  r = await call("POST /api/df/cr-ingest", { body: { filePath: `${R}/24-367/05_Client Comments/260604_F&P_003_S4_P01_${DWG}.pdf` } });
  assert.strictEqual(r.json.submissionId, null); assert.ok(!updates.find((u) => u.page_id === "subS5"));
  assert.strictEqual(feed[0].type, "error"); assert.match(feed[0].message, /no Issued S4 submission at P01/);
  ok("cr-ingest: no Issued submission at the filename's stage → flagged in the feed");

  // Bad name → clear feed message
  feed.length = 0;
  r = await call("POST /api/df/cr-ingest", { body: { filePath: `${R}/24-367/05_Client Comments/260604_F&P_003_S6_P01_${DWG}.pdf` } });
  assert.strictEqual(r.status, 400); assert.match(feed[0].message, /isn't a stage/);
  r = await call("POST /api/df/cr-ingest", { body: { filePath: `${R}/24-367/05_Client Comments/260604_F&P_003_AB_P01_${DWG}.pdf` } });
  assert.match(r.json.note, /aren't tracked for AB/);
  ok("cr-ingest: bad stage / untracked stage → feed explains why");

  r = await call("POST /api/df/cr-ingest", { body: { filePath: `${R}/24-367/05_Client Comments/Reviewed/R_260604_F&P_003_S4_P01_${DWG}.pdf` } });
  assert.strictEqual(r.json.skipped, true);
  r = await call("POST /api/df/cr-ingest", { body: { filePath: `${R}/24-367/05_Client Comments/Reviewed/R_MC_260910_${DWG}_P02.pdf` } });
  assert.strictEqual(r.json.skipped, true);
  ok("cr-ingest ignores Reviewed/R_ files");

  r = await call("POST /api/df/cr-ingest", { body: { filePath: `${R}/24-367/05_Client Comments/003_A4.5_C01_${DWG}_Rejected_260910.pdf` } });
  assert.strictEqual(r.json.skipped, true); assert.match(r.json.reason, /grade return/);
  r = await call("POST /api/df/cr-ingest", { body: { filePath: `${R}/24-367/A4.5/Grade Returns/003_A4.5_C01_${DWG}_Rejected_260910.pdf` } });
  assert.strictEqual(r.json.skipped, true);
  ok("cr-ingest ignores C01 returns in 05_Client Comments (by filename) and legacy Grade Returns/");

  // Grade S5 with a logged comment → move-files to Reviewed/R_
  submissions = [issued("subI", "S5", "P02", { "DM Action": sel("Review Comments"),
    "Comment Paths": rt(`Drawing Submissions/24-367/05_Client Comments/MC_260910_${DWG}_P02.pdf\nDrawing Submissions/24-367/05_Client Comments/AR_260911_${DWG}_P02.pdf`),
    "Dropbox Path": { url: `Drawing Submissions/24-367/04_Issued/003_S5_P02_${DWG}.pdf` } })];
  webhooks.length = 0; updates.length = 0;
  r = await call("PATCH /api/df/submissions/:id/log-status", { params: { id: "subI" }, body: { grade: "B", returnDate: "2026-09-09" } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  let mv = hook("move-files");
  assert.strictEqual(mv.moves.length, 2);
  assert.strictEqual(mv.moves[0].toFolderParent, `${R}/24-367/05_Client Comments`); assert.strictEqual(mv.moves[0].toFolderName, "Reviewed");
  assert.strictEqual(mv.moves[0].newFilename, `R_MC_260910_${DWG}_P02.pdf`);
  const lsUpd = updates.find((u) => u.page_id === "subI").properties;
  assert.strictEqual(lsUpd["DM Action"].select.name, "Log Status");
  assert.match(lsUpd["Comment Paths"].rich_text[0].text.content, /05_Client Comments\/Reviewed\/R_MC_260910/);
  ok("S5 grade (was 'Review Comments') → allowed; comment PDFs → Client Comments/Reviewed/R_…");

  // Re-grade: comments already in Reviewed → nothing to move
  submissions[0].properties["Comment Paths"] = rt(`Drawing Submissions/24-367/05_Client Comments/Reviewed/R_MC_260910_${DWG}_P02.pdf`);
  webhooks.length = 0;
  r = await call("PATCH /api/df/submissions/:id/log-status", { params: { id: "subI" }, body: { grade: "A", returnDate: "2026-09-09" } });
  assert.strictEqual(hook("move-files"), undefined);
  ok("re-grade → no duplicate moves");

  // A4.5 Rejected → 05_Client Comments with the grade-return name
  submissions = [issued("subC", "A4.5", "C01", { "Submission": title(`24-367-003_${DWG}_A4.5_R1`),
    "Dropbox Path": { url: `Drawing Submissions/24-367/04_Issued/003_A4.5_C01_${DWG}_GF.pdf` } })];
  webhooks.length = 0; updates.length = 0;
  r = await call("PATCH /api/df/submissions/:id/log-status", { params: { id: "subC" }, body: { grade: "Rejected" } });
  mv = hook("move-files");
  assert.strictEqual(mv.moves.length, 1);
  assert.strictEqual(mv.moves[0].toFolder, `${R}/24-367/05_Client Comments`);
  assert.strictEqual(mv.moves[0].toFolderParent, `${R}/24-367`); assert.strictEqual(mv.moves[0].toFolderName, "05_Client Comments");
  assert.match(mv.moves[0].newFilename, new RegExp(`^003_A4\\.5_C01_${DWG}_Rejected_\\d{6}\\.pdf$`));
  assert.match(updates[0].properties["Dropbox Path"].url, /^Drawing Submissions\/24-367\/05_Client Comments\/003_A4\.5_C01_/);
  // …and re-grading it once it's already in 05_Client Comments moves nothing
  submissions[0].properties["Dropbox Path"] = { url: updates[0].properties["Dropbox Path"].url };
  webhooks.length = 0;
  r = await call("PATCH /api/df/submissions/:id/log-status", { params: { id: "subC" }, body: { grade: "Rejected" } });
  assert.strictEqual(hook("move-files"), undefined);
  ok("A4.5 Rejected → 05_Client Comments/{Item}_{Stage}_{Rev}_{DrawingNo}_Rejected_{YYMMDD}.pdf; re-grade doesn't move twice");

  // A4.5 Approved → 06_Signed Off, filename unchanged
  submissions = [issued("subD", "A4.5", "C01", { "Submission": title(`24-367-003_${DWG}_A4.5_R1`),
    "Dropbox Path": { url: `Drawing Submissions/24-367/04_Issued/003_A4.5_C01_${DWG}_GF.pdf` } })];
  webhooks.length = 0; updates.length = 0;
  r = await call("PATCH /api/df/submissions/:id/log-status", { params: { id: "subD" }, body: { grade: "Approved" } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  mv = hook("move-files");
  assert.strictEqual(mv.moves.length, 1);
  assert.strictEqual(mv.moves[0].from, `${R}/24-367/04_Issued/003_A4.5_C01_${DWG}_GF.pdf`);
  assert.strictEqual(mv.moves[0].toFolderParent, `${R}/24-367`); assert.strictEqual(mv.moves[0].toFolderName, "06_Signed Off");
  assert.strictEqual(mv.moves[0].newFilename, `003_A4.5_C01_${DWG}_GF.pdf`);
  assert.strictEqual(updates[0].properties["Dropbox Path"].url, `Drawing Submissions/24-367/06_Signed Off/003_A4.5_C01_${DWG}_GF.pdf`);
  ok("A4.5 Approved → 06_Signed Off/{filename}, path written with the grade");

  // ── PRD: approve → issue → factory grade (mirrors A4.5) ────────────────
  submissions = [{ id: "subP", properties: { "Status": sel("Submitted"), "Stage": sel("PRD"), "Submission": title(`24-367-003_${DWG}_PRD_R1`),
    "DT": rel("dtAI"), "Item": rel(), "Revision": sel("C01"), "Drawing": rel("dwg1"),
    "Dropbox Path": { url: `Drawing Submissions/24-367/01_Pending/003_PRD_C01_${DWG}_GF.pdf` } } }];
  webhooks.length = 0; updates.length = 0;
  r = await call("PATCH /api/df/submissions/:id/approve", { params: { id: "subP" } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const pa = hook("approve");
  assert.strictEqual(pa.dropboxMove.toFolderName, "03_Ready For Issue");
  assert.strictEqual(pa.dropboxMove.newFilename, `003_PRD_C01_${DWG}_GF.pdf`);
  ok("PRD approve → 03_Ready For Issue, filename unchanged");

  // Issue is where the stage's approve map lands: Schedule Production (Actual) + BIC Production
  submissions = [{ id: "subPI", properties: { "Status": sel("Awaiting Issue"), "Stage": sel("PRD"), "Drawing": rel("dwg1"), "Item": rel(),
    "Submission": title(`24-367-003_${DWG}_PRD_R1`), "Revision": sel("C01"),
    "Dropbox Path": { url: `Drawing Submissions/24-367/03_Ready For Issue/003_PRD_C01_${DWG}_GF.pdf` } } }];
  webhooks.length = 0; updates.length = 0;
  r = await call("PATCH /api/df/submissions/:id/issue", { params: { id: "subPI" } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(updates[0].properties["Ball In Court"].select.name, "Production");
  const pdwg = updates.find((u) => u.page_id === "dwg1").properties;
  assert.ok(pdwg["Schedule Production (Actual)"], "PRD issue writes Schedule Production (Actual)");
  assert.ok(!pdwg["C01 Submit Date (Actual)"], "PRD issue must not touch the A4.5 date");
  ok("PRD issue → 04_Issued, BIC Production, Schedule Production (Actual) written");

  // PRD Rejected → 05_Client Comments, PRD Status + PRD Status Date both written
  submissions = [issued("subP2", "PRD", "C01", { "Submission": title(`24-367-003_${DWG}_PRD_R1`),
    "Dropbox Path": { url: `Drawing Submissions/24-367/04_Issued/003_PRD_C01_${DWG}_GF.pdf` } })];
  webhooks.length = 0; updates.length = 0;
  r = await call("PATCH /api/df/submissions/:id/log-status", { params: { id: "subP2" }, body: { grade: "Rejected" } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  mv = hook("move-files");
  assert.strictEqual(mv.moves.length, 1);
  assert.strictEqual(mv.moves[0].toFolderParent, `${R}/24-367`); assert.strictEqual(mv.moves[0].toFolderName, "05_Client Comments");
  assert.match(mv.moves[0].newFilename, new RegExp(`^003_PRD_C01_${DWG}_Rejected_\\d{6}\\.pdf$`));
  let prdDwg = updates.find((u) => u.page_id === "dwg1").properties;
  assert.strictEqual(prdDwg["PRD Status"].select.name, "Rejected");
  assert.ok(prdDwg["PRD Status Date"], "PRD Status Date is written on Rejected too (unlike C01 Sign Off)");
  assert.ok(!prdDwg["Drawing Status"], "PRD defers Drawing Status to send-grade-emails");
  ok("PRD Rejected → 05_Client Comments/…_Rejected_{YYMMDD}.pdf; PRD Status + Date written, Drawing Status deferred");

  // PRD Approved → 06_Signed Off
  submissions = [issued("subP3", "PRD", "C01", { "Submission": title(`24-367-003_${DWG}_PRD_R1`),
    "Dropbox Path": { url: `Drawing Submissions/24-367/04_Issued/003_PRD_C01_${DWG}_GF.pdf` } })];
  webhooks.length = 0; updates.length = 0;
  r = await call("PATCH /api/df/submissions/:id/log-status", { params: { id: "subP3" }, body: { grade: "Approved" } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.isA45Approved, true);
  mv = hook("move-files");
  assert.strictEqual(mv.moves[0].toFolderName, "06_Signed Off");
  assert.strictEqual(mv.moves[0].newFilename, `003_PRD_C01_${DWG}_GF.pdf`);
  assert.strictEqual(updates[0].properties["Dropbox Path"].url, `Drawing Submissions/24-367/06_Signed Off/003_PRD_C01_${DWG}_GF.pdf`);
  prdDwg = updates.find((u) => u.page_id === "dwg1").properties;
  assert.strictEqual(prdDwg["PRD Status"].select.name, "Approved");
  ok("PRD Approved → 06_Signed Off/{filename}, PRD Status Approved");

  // A PRD grade return dropped back into 05_Client Comments is ignored by cr-ingest
  r = await call("POST /api/df/cr-ingest", { body: { filePath: `${R}/24-367/05_Client Comments/003_PRD_C01_${DWG}_Rejected_260910.pdf` } });
  assert.strictEqual(r.json.skipped, true); assert.match(r.json.reason, /grade return/);
  ok("cr-ingest ignores PRD grade returns");

  // ── Issue: 03_Ready For Issue → 04_Issued ─────────────────────────────
  submissions = [{ id: "subR", properties: { "Status": sel("Awaiting Issue"), "Stage": sel("S4"), "Drawing": rel("dwg1"), "Item": rel(),
    "Submission": title(`24-367-003_${DWG}_S4_R1`), "Revision": sel("P01"),
    "Dropbox Path": { url: `Drawing Submissions/24-367/03_Ready For Issue/003_S4_P01_${DWG}_GF.pdf` } } }];
  webhooks.length = 0; updates.length = 0;
  r = await call("PATCH /api/df/submissions/:id/issue", { params: { id: "subR" } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  mv = hook("move-files");
  assert.strictEqual(mv.reason, "issue"); assert.strictEqual(mv.moves.length, 1);
  assert.strictEqual(mv.moves[0].from, `${R}/24-367/03_Ready For Issue/003_S4_P01_${DWG}_GF.pdf`);
  assert.strictEqual(mv.moves[0].toFolderParent, `${R}/24-367`); assert.strictEqual(mv.moves[0].toFolderName, "04_Issued");
  assert.strictEqual(mv.moves[0].newFilename, `003_S4_P01_${DWG}_GF.pdf`);
  assert.strictEqual(updates[0].properties["Dropbox Path"].url, `Drawing Submissions/24-367/04_Issued/003_S4_P01_${DWG}_GF.pdf`);
  assert.strictEqual(updates[0].properties.Status.select.name, "Issued");
  ok("issue → PDF moves 03_Ready For Issue → 04_Issued, name unchanged, path written with status");

  // With the issue-files webhook configured, Make is asked for every file carrying the drawing number
  env.MAKE_ISSUE_FILES_WEBHOOK = "https://hook.test/issue-files";
  submissions = [{ id: "subR2", properties: { "Status": sel("Awaiting Issue"), "Stage": sel("S4"), "Drawing": rel("dwg1"), "Item": rel(),
    "Submission": title(`24-367-003_${DWG}_S4_R1`), "Revision": sel("P01"),
    "Dropbox Path": { url: `Drawing Submissions/24-367/03_Ready For Issue/003_S4_P01_${DWG}_GF.pdf` } } }];
  webhooks.length = 0; updates.length = 0;
  r = await call("PATCH /api/df/submissions/:id/issue", { params: { id: "subR2" } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const isf = hook("issue-files");
  assert.strictEqual(isf.drawingNo, DWG);
  assert.strictEqual(isf.fromFolder, `${R}/24-367/03_Ready For Issue`);
  assert.strictEqual(isf.toFolder, `${R}/24-367/04_Issued`);
  assert.strictEqual(isf.toFolderName, "04_Issued"); assert.strictEqual(isf.toFolderParent, `${R}/24-367`);
  assert.strictEqual(hook("move-files"), undefined);   // no separate single-file move
  assert.strictEqual(updates[0].properties["Dropbox Path"].url, `Drawing Submissions/24-367/04_Issued/003_S4_P01_${DWG}_GF.pdf`);
  delete env.MAKE_ISSUE_FILES_WEBHOOK;
  ok("issue → issue-files webhook moves every file for that drawing number");

  // ── Grade emails: folder per stage ─────────────────────────────────────
  submissions = [
    { id: "g1", properties: { "Status": sel("Graded"), "DT Notified": { checkbox: false }, "Stage": sel("S5"), "Client Grade": sel("B"), "Revision": sel("P02"),
      "Submission": title(`24-367-003_${DWG}_S5_R1`), "DT": rel("dtAI"), "Drawing": rel(),
      "Comment Paths": rt(`Drawing Submissions/24-367/05_Client Comments/Reviewed/R_MC_260910_${DWG}_P02.pdf`) } },
    { id: "g2", properties: { "Status": sel("Graded"), "DT Notified": { checkbox: false }, "Stage": sel("A4.5"), "Client Grade": sel("Rejected"), "Revision": sel("C01"),
      "Submission": title(`24-367-003_${DWG}_A4.5_R1`), "DT": rel("dtAI"), "Drawing": rel(),
      "Dropbox Path": { url: `Drawing Submissions/24-367/05_Client Comments/003_A4.5_C01_${DWG}_Rejected_260910.pdf` } } },
    { id: "g3", properties: { "Status": sel("Graded"), "DT Notified": { checkbox: false }, "Stage": sel("A4.5"), "Client Grade": sel("Approved"), "Revision": sel("C01"),
      "Submission": title(`24-367-004_${DWG}_A4.5_R1`), "DT": rel("dtAI"), "Drawing": rel(),
      "Dropbox Path": { url: `Drawing Submissions/24-367/06_Signed Off/004_A4.5_C01_${DWG}_GF.pdf` } } },
  ];
  webhooks.length = 0;
  r = await call("POST /api/df/send-grade-emails", { body: {} });
  const gs = hook("grade-summary");
  const heads = gs.folderBlocks.map((f) => f.folderHtml);
  assert.ok(heads.includes("<strong>24-367/05_Client Comments/Reviewed</strong>"), heads.join(" | "));
  assert.ok(heads.includes("<strong>24-367/05_Client Comments</strong>"), heads.join(" | "));
  assert.ok(heads.includes("<strong>24-367/06_Signed Off</strong>"), heads.join(" | "));
  assert.ok(gs.folderBlocks.some((f) => /R_/.test(f.drawingsHtml)) && gs.folderBlocks.some((f) => /\{Item\}_\{Stage\}/.test(f.drawingsHtml)));
  ok("grade email: S5 → 05_Client Comments/Reviewed, A4.5 Rejected → 05_Client Comments, A4.5 Approved → 06_Signed Off");

  // Drawing Status is finalised here, and Approved differs by stage:
  //   A4.5 → Production Updates (DT now draws the PRD set)
  //   PRD  → Schedule (factory signed off; item goes for production scheduling)
  // Rejected → DT Review for both.
  submissions = [
    { id: "g4", properties: { "Status": sel("Graded"), "DT Notified": { checkbox: false }, "Stage": sel("A4.5"), "Client Grade": sel("Approved"), "Revision": sel("C01"),
      "Submission": title(`24-367-003_${DWG}_A4.5_R1`), "DT": rel("dtAI"), "Drawing": rel("dwgA45"),
      "Dropbox Path": { url: `Drawing Submissions/24-367/06_Signed Off/003_A4.5_C01_${DWG}_GF.pdf` } } },
    { id: "g5", properties: { "Status": sel("Graded"), "DT Notified": { checkbox: false }, "Stage": sel("PRD"), "Client Grade": sel("Approved"), "Revision": sel("C01"),
      "Submission": title(`24-367-004_${DWG}_PRD_R1`), "DT": rel("dtAI"), "Drawing": rel("dwgPRD"),
      "Dropbox Path": { url: `Drawing Submissions/24-367/06_Signed Off/004_PRD_C01_${DWG}_GF.pdf` } } },
    { id: "g6", properties: { "Status": sel("Graded"), "DT Notified": { checkbox: false }, "Stage": sel("PRD"), "Client Grade": sel("Rejected"), "Revision": sel("C01"),
      "Submission": title(`24-367-005_${DWG}_PRD_R1`), "DT": rel("dtAI"), "Drawing": rel("dwgPRDrej"),
      "Dropbox Path": { url: `Drawing Submissions/24-367/05_Client Comments/005_PRD_C01_${DWG}_Rejected_260910.pdf` } } },
  ];
  webhooks.length = 0; updates.length = 0;
  r = await call("POST /api/df/send-grade-emails", { body: {} });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const dsOf = (id) => updates.find((u) => u.page_id === id)?.properties?.["Drawing Status"]?.select?.name;
  assert.strictEqual(dsOf("dwgA45"),    "Production Updates");
  assert.strictEqual(dsOf("dwgPRD"),    "Schedule");
  assert.strictEqual(dsOf("dwgPRDrej"), "DT Review");
  ok("grade email finalises Drawing Status: A4.5 Approved → Production Updates, PRD Approved → Schedule, Rejected → DT Review");

  // ── DT emails: filename (with _R#) + folder link ───────────────────────
  submissions = [
    { id: "d1", properties: { "Status": sel("Approved"), "DT Notified": { checkbox: false }, "Stage": sel("S4"), "DM Action": sel("Approve"),
      "Submission": title(`24-354-003_${DWG}_S4_R2`), "DT": rel("dtAI"), "QA Round": { number: 2 },
      "Folder Link": { url: "https://db/readyforissue" },
      "Dropbox Path": { url: `Drawing Submissions/24-354/03_Ready For Issue/003_S4_P01_${DWG}_AI_R1.PDF` } } },
    { id: "d2", properties: { "Status": sel("Rejected"), "DT Notified": { checkbox: false }, "Stage": sel("S5"), "DM Action": sel("Bounce"),
      "Submission": title(`24-354-112_${DWG}_S5_R1`), "DT": rel("dtAI"), "QA Round": { number: 1 },
      "Folder Link": { url: null },   // Make's bounce run failed, so no link was written back
      "Dropbox Path": { url: `Drawing Submissions/24-354/02_Rejected/112_S5_P02_${DWG}_AI_R1.PDF` } } },
    // An older submission already in that folder carries the link the email can borrow.
    { id: "d0", properties: { "Status": sel("Rejected"), "DT Notified": { checkbox: true }, "Stage": sel("S4"), "DM Action": sel("Bounce"),
      "Submission": title(`24-354-003_${DWG}_S4_R1`), "DT": rel("dtAI"), "QA Round": { number: 1 },
      "Folder Link": { url: "https://db/rejected" },
      "Dropbox Path": { url: `Drawing Submissions/24-354/02_Rejected/003_S4_P01_${DWG}_SF_R1.PDF` } } },
  ];
  webhooks.length = 0; updates.length = 0;
  r = await call("POST /api/df/send-dt-emails", { body: {} });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const dt = hook("dt-summary");
  const blocks = dt.folderBlocks.map((b) => b.folderHtml + b.drawingsHtml).join(" | ");
  assert.ok(blocks.includes(`003_S4_P01_${DWG}_AI_R1.PDF`), blocks);
  assert.ok(blocks.includes(`112_S5_P02_${DWG}_AI_R1.PDF`), blocks);
  assert.ok(blocks.includes("https://db/readyforissue") && blocks.includes("https://db/rejected"), blocks);
  assert.ok(/24-354 \/ 03_Ready For Issue/.test(blocks) && /24-354 \/ 02_Rejected/.test(blocks), blocks);
  assert.match(blocks, /dropping only a <code>_R1<\/code>/);
  ok("DT email: full filename incl. _R#, links to 03_Ready For Issue / 02_Rejected (link borrowed when Make didn't write one)");

  // stage-upload still finds the stage when the DWG keeps a _R# suffix
  // ── stage-upload ───────────────────────────────────────────────────────
  const seen = []; const q = notion.databases.query;
  notion.databases.query = async (a) => { if (a.database_id === "SUBS") seen.push(JSON.stringify(a.filter)); return { results: [
    { id: "s1", properties: { "Submission": title("24-367-003_A-101_S4_R1") } },
    { id: "s2", properties: { "Submission": title("24-3670-001_A-9_S4_R1") } } ], has_more: false }; };
  r = await call("POST /api/df/stage-upload", { body: { filePath: `${R}/24-367/03_Ready For Issue/003_S4_P01_A-101.dwg` } });
  assert.strictEqual(r.json.updated, 1); assert.match(seen[0], /"S4"/);
  r = await call("POST /api/df/stage-upload", { body: { filePath: `${R}/24-367/03_Ready For Issue/003_S4_P01_A-101_GF_R2.dwg` } });
  assert.strictEqual(r.json.updated, 1); assert.match(seen[seen.length - 1], /"S4"/);
  r = await call("POST /api/df/stage-upload", { body: { filePath: `${R}/24-367/03_Ready For Issue/A-101.dwg` } });
  assert.strictEqual(r.json.updated, 1); assert.doesNotMatch(seen[seen.length - 1], /"Stage"/);
  r = await call("POST /api/df/stage-upload", { body: { filePath: `${R}/24-367/S5/Suffix 003/A-101.dwg` } });
  assert.match(seen[seen.length - 1], /"S5"/);
  notion.databases.query = q;
  ok("stage-upload: stage from DWG name (incl. a kept _R# suffix) / project-wide fallback / legacy folder");

  console.log(`\n${n} route tests passed`);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
