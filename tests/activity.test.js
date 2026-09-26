// Route tests for the Item Activity Feed — GET /api/df/activity-log and
// GET /api/df/activity-position. Mocked Notion, same vm-sandbox pattern as routes.test.js.
// Run: node tests/activity.test.js
const fs = require("fs"), vm = require("vm"), assert = require("assert");

const env = {
  NOTION_DB_ACTIVITY_LOG: "ACT", NOTION_DB_ACTIONS_INFO: "AI",
  NOTION_DB_RFIS: "RFIS", NOTION_DB_TASKS: "TASKS", NOTION_DB_SUBMISSIONS: "SUBS",
};
const mod = { exports: {} };
const srcPath = fs.existsSync(__dirname + "/drawing-flow.js") ? __dirname + "/drawing-flow.js" : __dirname + "/../drawing-flow.js";
const lanesPath = srcPath.replace(/drawing-flow\.js$/, "public/lanes.js");
vm.runInNewContext(fs.readFileSync(srcPath, "utf8") +
  "\n;module.exports.__t = { createActionRow, resolveActionRow, createActivityLogEntry, LANES, safeSheetName };", {
  module: mod, exports: mod.exports,
  require: (n) => n === "@netlify/blobs" ? { getStore: () => ({ get: async () => [], setJSON: async () => {} }) }
    : n === "./public/lanes.js" ? require(lanesPath) : require(n),
  process: { env }, console: { ...console, log() {}, warn() {} },
  fetch: async () => ({ ok: true, status: 200, text: async () => "" }),
  setTimeout, Promise, Date, Map, Set, JSON, Math, Buffer, ArrayBuffer, Uint8Array,
});

// ---- fixtures --------------------------------------------------------------
const title = (t) => ({ title: [{ plain_text: t }] });
const rt    = (t) => ({ rich_text: t ? [{ plain_text: t }] : [] });
const rel   = (...ids) => ({ relation: ids.map((id) => ({ id })) });
const sel   = (n) => ({ select: n ? { name: n } : null });
const msel  = (...n) => ({ multi_select: n.map((name) => ({ name })) });
const chk   = (v) => ({ checkbox: v });
const dt    = (d) => ({ date: d ? { start: d } : null });
const num   = (v) => ({ number: v });

const pages = {
  // "Projects" (plural) is the real relation name on the Tasks DB — the fixture used to say
  // "Project", which quietly agreed with the bug in the resolver instead of catching it.
  task1:  { id: "task1",  url: "u/task1",  properties: { "Item Name": title("Suffix 112 B2 Glazed Screen"), "Projects": rel("proj1") } },
  task2:  { id: "task2",  url: "u/task2",  properties: { "Item Name": title("Suffix 200 Soft Cell Panelling"), "Projects": rel("proj1") } },
  proj1:  { id: "proj1",  url: "u/proj1",  properties: { "Project Name": title("24-354 EIT") } },
};

// Activity Log rows. a3 is the important one: created today, but carrying an Event Date
// from March — a backfilled historical entry.
const actRows = [
  { id: "a1", url: "u/a1", created_time: "2026-09-18T09:22:00.000Z",
    properties: { Entry: title("Suffix 112 blocked — awaiting decision."), Source: sel("A&I"), Tag: sel("#action"), Author: rt("DM"), Detail: rt(""), Link: { url: null }, "Event Date": dt(null), Task: rel("task1") } },
  { id: "a2", url: "u/a2", created_time: "2026-09-17T16:40:00.000Z",
    properties: { Entry: title("RFI-014 raised — grid B4 setting out."), Source: sel("RFI"), Tag: sel("#query"), Author: rt("DM"), Detail: rt(""), Link: { url: null }, "Event Date": dt(null), Task: rel("task1") } },
  { id: "a3", url: "u/a3", created_time: "2026-09-18T08:00:00.000Z",
    properties: { Entry: title("Backfilled: March kickoff decision."), Source: sel("Manual"), Tag: sel("#decision"), Author: rt("DM"), Detail: rt(""), Link: { url: null }, "Event Date": dt("2026-03-02"), Task: rel("task2") } },
  { id: "a4", url: "u/a4", created_time: "2026-09-16T11:00:00.000Z",
    properties: { Entry: title("Drawing A-101 Rev C02 approved by DM."), Source: sel("Drawing Flow"), Tag: sel("#approved"), Author: rt("DM"), Detail: rt(""), Link: { url: null }, "Event Date": dt(null), Task: rel("task2") } },
  { id: "a5", url: "u/a5", created_time: "2026-09-15T10:00:00.000Z",
    properties: { Entry: title("Suffix 112 on hold — awaiting structural sign-off."), Source: sel("A&I"), Tag: sel("#blocked"), Author: rt("DM"), Detail: rt(""), Link: { url: null }, "Event Date": dt(null), Task: rel("task1") } },
];

const aiRows = [
  { id: "ai1", url: "u/ai1", created_time: "2026-09-01T09:00:00.000Z", properties: { Note: title("Confirm grid B4"), Tags: msel("Track"), Archived: chk(false),
    "Status": sel("Waiting"), "Ball in Court": sel("Client"), Blocker: sel("Awaiting decision"), Category: sel("Design Coordination"), Items: rel("task1") } },
  { id: "ai2", url: "u/ai2", created_time: "2026-09-16T09:00:00.000Z", properties: { Note: title("Review A-101 Rev C02"), Tags: msel("Track"), Archived: chk(false),
    "Status": sel("Open"), "Ball in Court": sel("Me"), Blocker: sel("—"), Category: sel("Drawing Update"), Items: rel("task2") } },
  { id: "ai3", url: "u/ai3", created_time: "2026-08-20T09:00:00.000Z", properties: { Note: title("Chase panel finish sample"), Tags: msel("Track"), Archived: chk(false),
    "Status": sel("Open"), "Ball in Court": sel("Me"), Blocker: sel(null), Category: sel("Supplier Coordination"), Items: rel() } },
];

const rfiRows = [
  { id: "r1", url: "u/r1", created_time: "2026-09-17T09:00:00.000Z", properties: { "RFI Description": title("Grid B4 setting out"), "RFI Number": num(14),
    "RFI Status": sel("Open"), "TBC by": sel("Architect"), "Date Raised": dt("2026-09-17"), "Related Item(s)": rel("task1") } },
];

// Submissions. This is an EVENT LOG — one row per attempt — and these fixtures encode the
// two ways a naive count gets it wrong:
//   d1  bounced at S4 R1, then issued at S4 R2. The bounce is superseded; counting rows
//       would report a drawing sitting with the DT that came back weeks ago.
//   d2  graded at S4, then resubmitted at A4.5. Counting per stage would count it twice and
//       claim a sign-off that the drawing has already moved past.
const sub = (id, code, dwgNo, stage, status, extra = {}) => ({
  id, url: "u/" + id, created_time: "2026-01-01T09:00:00.000Z",
  properties: {
    Submission:      title(`${code}_${dwgNo}_${stage}_R${extra.qa ?? 1}`),
    Stage:           sel(stage),
    Status:          sel(status),
    "QA Round":      num(extra.qa ?? 1),
    Submitted:       dt(extra.on || "2026-01-10"),
    Drawing:         extra.dwg === null ? rel() : rel(extra.dwg),
    Item:            extra.item ? rel(extra.item) : rel(),
    "DT Notified":   chk(extra.notified ?? true),
    "Ball In Court": sel(extra.bic || null),
    "Comment Paths": rt(extra.paths || ""),
  },
});

const subRows = [
  sub("s1", "24-354-190", "DWG-A", "S4",   "Rejected", { dwg: "d1", item: "task1", qa: 1, on: "2026-01-10" }),
  sub("s2", "24-354-190", "DWG-A", "S4",   "Issued",   { dwg: "d1", item: "task1", qa: 2, on: "2026-02-10" }),
  sub("s3", "24-354-190", "DWG-B", "S4",   "Graded",   { dwg: "d2", item: "task1", qa: 1, on: "2026-01-11" }),
  sub("s4", "24-354-190", "DWG-B", "A4.5", "Issued",   { dwg: "d2", item: "task1", qa: 1, on: "2026-03-01" }),
  sub("s5", "24-354-200", "DWG-C", "AB",   "Graded",   { dwg: "d3", item: "task2" }),
  sub("s6", "24-354-200", "DWG-D", "S4",   "Rejected", { dwg: "d4", item: "task2", notified: false }),
  sub("s7", "24-354-200", "DWG-E", "S4",   "Schedule", { dwg: "d5", item: "task2" }),
  sub("s8", "24-354-200", "DWG-F", "S5",   "Issued",   { dwg: "d6", item: "task2", bic: "DM" }),
  // No Item relation — must be reported as unlinked, never folded onto someone else's card.
  sub("s9", "24-354-200", "DWG-G", "S4",   "Submitted", { dwg: "d7" }),
];

// ---- Notion mock -----------------------------------------------------------
const seen = { ACT: [], AI: [], RFIS: [], TASKS: [], SUBS: [] };
let rfiShouldFail = false;
const notion = {
  databases: { query: async ({ database_id, filter, page_size }) => {
    seen[database_id] ??= [];
    // Filters are built inside the vm realm; round-trip them so deepStrictEqual against
    // plain host-realm literals compares structure rather than prototype identity.
    seen[database_id].push(JSON.parse(JSON.stringify(filter ?? null)));
    if (database_id === "ACT")   return { results: actRows.slice(0, page_size ?? 100), has_more: false };
    if (database_id === "AI")    return { results: aiRows, has_more: false };
    if (database_id === "SUBS")  return { results: subRows, has_more: false };
    if (database_id === "RFIS") { if (rfiShouldFail) throw new Error("boom"); return { results: rfiRows, has_more: false }; }
    // Only proj1 has items — an unknown project must come back empty, so the route's
    // "no items in scope" short-circuit is actually exercised.
    //
    // The property name is matched strictly. The Tasks DB's relation to Projects is called
    // "Projects" (plural); there is no "Project" property on it, and asking Notion for one
    // 400s — which is exactly how every project-scoped call came back as a 500 in
    // production on 18 Sep 2026. A mock that ignored the property name would have let that
    // regression through, so this one refuses anything but the real name.
    if (database_id === "TASKS") return {
      results: (filter?.property === "Projects" && filter?.relation?.contains === "proj1")
        ? [pages.task1, pages.task2] : [], has_more: false };
    return { results: [], has_more: false };
  }},
  pages: { retrieve: async ({ page_id }) => pages[page_id] || (() => { throw new Error("404"); })() },
};

const routes = {};
const app = new Proxy({}, { get: (_t, m) => (path, h) => { routes[`${m.toUpperCase()} ${path}`] = h; } });
mod.exports(app, notion);
const call = async (key, query = {}) => {
  let status = 200, json;
  const res = { status(c) { status = c; return res; }, json(j) { json = j; return res; } };
  await routes[key]({ body: {}, params: {}, query }, res);
  return { status, json: json === undefined ? undefined : JSON.parse(JSON.stringify(json)) };
};
const callRaw = async (key, query = {}) => {
  let status = 200, headers = {}, sent, json;
  const res = {
    status(c) { status = c; return res; },
    setHeader(k, v) { headers[k.toLowerCase()] = v; return res; },
    send(b) { sent = b; return res; },
    json(j) { json = j; return res; },
  };
  await routes[key]({ body: {}, params: {}, query }, res);
  return { status, headers, buffer: sent, json };
};
const reset = () => { for (const k of Object.keys(seen)) seen[k] = []; rfiShouldFail = false; };

// Notion rejects a filter nested more than two levels deep. Every route here can compose
// a scope `or` inside an outer `and`, which is exactly two — this guards the third.
const depth = (f) => !f || typeof f !== "object" ? 0
  : (f.and || f.or) ? 1 + Math.max(0, ...(f.and || f.or).map(depth)) : 0;

let n = 0; const ok = (name) => { n++; console.log("✓", name); };

(async () => {
  // ── feed: scope modes ───────────────────────────────────────────────────
  reset();
  let r = await call("GET /api/df/activity-log");
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.entries.length, actRows.length);
  assert.ok(JSON.stringify(seen.ACT[0]).includes("on_or_after"), "default view applies a rolling window");
  ok("feed: default view is a rolling Created window");

  reset();
  await call("GET /api/df/activity-log", { taskId: "task1" });
  assert.deepStrictEqual(seen.ACT[0], { property: "Task", relation: { contains: "task1" } });
  ok("feed: taskId scopes to one item, unbounded by date");

  reset();
  await call("GET /api/df/activity-log", { projectId: "proj1" });
  assert.ok(seen.ACT[0].or, "project scope OR's the project's task ids");
  assert.strictEqual(seen.ACT[0].or.length, 2);
  ok("feed: projectId resolves to the project's items");

  // Regression: the Tasks relation is "Projects", not "Project". Getting this wrong 500s
  // every project-scoped call, and it shipped that way once.
  reset();
  await call("GET /api/df/activity-log", { projectId: "proj1" });
  assert.strictEqual(seen.TASKS[0].property, "Projects",
    'Tasks are related to Projects by "Projects" — "Project" does not exist and Notion 400s on it');
  reset();
  await call("GET /api/df/activity-position", { projectId: "proj1" });
  assert.strictEqual(seen.TASKS[0].property, "Projects");
  ok("feed + position: project scope uses the relation that actually exists");

  // ── feed: composing filters ─────────────────────────────────────────────
  reset();
  await call("GET /api/df/activity-log", { projectId: "proj1", tag: "#returned,#approved", source: "RFI", from: "2026-09-01" });
  const f = seen.ACT[0];
  assert.ok(f.and, "composed filter is an AND");
  assert.ok(depth(f) <= 2, `filter nested ${depth(f)} deep — Notion caps at 2`);
  const tagClause = f.and.find((c) => c.or?.[0]?.property === "Tag");
  assert.strictEqual(tagClause.or.length, 2, "comma-separated tags become an OR");
  assert.deepStrictEqual(f.and.find((c) => c.property === "Source"), { property: "Source", select: { equals: "RFI" } });
  ok("feed: scope + tag list + source + date compose, nesting stays within Notion's limit");

  reset();
  await call("GET /api/df/activity-log", { source: "RFI" });
  assert.deepStrictEqual(seen.ACT[0].and?.find?.((c) => c.property === "Source") ?? seen.ACT[0],
    { property: "Source", select: { equals: "RFI" } });
  ok("feed: single-value source is a bare filter, not a one-element OR");

  // ── feed: the Event Date subtlety ───────────────────────────────────────
  // a3 was created in September but records something that happened in March. It must fall
  // in a March range and out of a September one — the whole reason the upper date bound is
  // applied here rather than handed to Notion.
  reset();
  r = await call("GET /api/df/activity-log", { from: "2026-03-01", to: "2026-03-31" });
  assert.deepStrictEqual(r.json.entries.map((e) => e.id), ["a3"]);
  ok("feed: a backfilled entry lands in its Event Date's range, not its Created range");

  reset();
  r = await call("GET /api/df/activity-log", { from: "2026-09-01", to: "2026-09-30" });
  assert.ok(!r.json.entries.some((e) => e.id === "a3"), "backfilled entry must not leak into the month it was typed up");
  assert.deepStrictEqual(r.json.entries.map((e) => e.id), ["a1", "a2", "a4", "a5"]);
  ok("feed: Created date alone never places an entry in the range");

  reset();
  r = await call("GET /api/df/activity-log", { from: "2020-01-01", to: "2020-12-31" });
  assert.deepStrictEqual(r.json.entries, []);
  ok("feed: empty range returns nothing rather than everything");

  // Notion can be trusted with the lower bound only — asserting we never send an upper one.
  reset();
  await call("GET /api/df/activity-log", { from: "2026-03-01", to: "2026-03-31" });
  assert.ok(!JSON.stringify(seen.ACT[0]).includes("on_or_before"), "upper bound must not go to Notion");
  ok("feed: only the lower date bound is delegated to Notion");

  // ── feed: ordering ──────────────────────────────────────────────────────
  reset();
  r = await call("GET /api/df/activity-log", { days: 365 });
  assert.deepStrictEqual(r.json.entries.map((e) => e.id), ["a1", "a4", "a2", "a3", "a5"].sort((x, y) => {
    const d = (id) => ({ a1: "2026-09-18T09:22", a2: "2026-09-17T16:40", a3: "2026-03-02",
                         a4: "2026-09-16T11:00", a5: "2026-09-15T10:00" }[id]);
    return new Date(d(y)) - new Date(d(x));
  }));
  assert.strictEqual(r.json.entries.at(-1).id, "a3", "the March entry sorts to the bottom, not the top");
  ok("feed: sorted by effective date, so backfill doesn't cluster at the top");

  // ── position ────────────────────────────────────────────────────────────
  reset();
  r = await call("GET /api/df/activity-position");
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.open, 4, "3 tracked A&I rows + 1 open RFI");
  assert.strictEqual(r.json.withDM, 2, "two A&I rows sit with Me");
  assert.strictEqual(r.json.blocked, 2, "one real A&I blocker + one open RFI");
  ok("position: open / withDM / blocked counted across A&I and RFIs");

  assert.ok(!r.json.blockers.some((b) => b.title === "Review A-101 Rev C02"),
    '"—" means assessed-and-clear, and must not count as a blocker');
  assert.ok(!r.json.blockers.some((b) => b.title === "Chase panel finish sample"),
    "a blank Blocker is not a blocker either");
  ok("position: neither an em-dash nor a blank Blocker counts as blocked");

  const rfiBlk = r.json.blockers.find((b) => b.source === "RFI");
  assert.strictEqual(rfiBlk.ref, "RFI-014", "RFI number is zero-padded for display");
  assert.strictEqual(rfiBlk.bic, "Architect");
  assert.strictEqual(r.json.blockers.find((b) => b.source === "A&I").item, "Suffix 112 B2 Glazed Screen");
  ok("position: blockers carry ref, item name and who holds them");

  assert.strictEqual(r.json.unassigned, 1, "the untethered A&I row is surfaced, not dropped");
  ok("position: untethered tracked rows are counted, not silently swallowed");

  // The dedup rule: submissions reach the header through their A&I row, so querying the
  // Submissions DB as well would count every one of them twice.
  assert.strictEqual(seen.SUBS.length, 0);
  ok("position: never queries the Submissions DB");

  reset();
  await call("GET /api/df/activity-position");
  assert.ok(seen.AI[0].and.some((c) => c.property === "Checked" && c.checkbox.equals === false),
    "a row Greig has ticked Checked in Notion is done — it must not count against 'with DM'");
  ok("position: a manually ticked (Checked) row drops out of the open count");

  reset();
  r = await call("GET /api/df/activity-position", { taskId: "task1" });
  assert.ok(seen.AI[0].and.some((c) => c.property === "Items" && c.relation.contains === "task1"));
  assert.ok(seen.RFIS[0].and.some((c) => c.property === "Related Item(s)" && c.relation.contains === "task1"));
  assert.ok(depth(seen.AI[0]) <= 2 && depth(seen.RFIS[0]) <= 2);
  ok("position: item scope reaches both trackers by their own relation names");

  reset();
  r = await call("GET /api/df/activity-position", { projectId: "nope" });
  const empty = { ...r.json };
  assert.strictEqual(empty.open, 0);
  assert.deepStrictEqual(empty.blockers, []);
  ok("position: a project with no items returns zeroes, not a crash");

  // ── position degrades rather than fails ─────────────────────────────────
  reset(); rfiShouldFail = true;
  r = await call("GET /api/df/activity-position");
  assert.strictEqual(r.status, 200, "an RFI outage must not blank the whole header");
  assert.strictEqual(r.json.open, 3, "A&I numbers still come through");
  assert.strictEqual(r.json.blocked, 1);
  assert.ok(r.json.errors?.[0]?.includes("RFIs unavailable"));
  ok("position: an RFI failure degrades to A&I-only with the problem reported");

  // ── export ──────────────────────────────────────────────────────────────
  //
  // Run against a plain require, NOT the vm sandbox above. exceljs tests values with
  // `instanceof Array` and `instanceof Date`, and both are false across realms: inside the
  // sandbox, addRow silently stores nothing and every cell reads back null, so sandboxed
  // export assertions pass against empty sheets and prove nothing. Netlify runs a single
  // realm. So the export is exercised the way production runs it.
  const ExcelJS = require("exceljs");
  Object.assign(process.env, env);
  const routesH = {};
  const appH = new Proxy({}, { get: (_t, m) => (path, h) => { routesH[`${m.toUpperCase()} ${path}`] = h; } });
  require("../drawing-flow")(appH, notion);

  const callH = async (key, query = {}) => {
    let status = 200, headers = {}, sent, json;
    const res = {
      status(c) { status = c; return res; },
      setHeader(k, v) { headers[k.toLowerCase()] = v; return res; },
      send(b) { sent = b; return res; },
      json(j) { json = j; return res; },
    };
    await routesH[key]({ body: {}, params: {}, query }, res);
    return { status, headers, buffer: sent, json };
  };
  // The lane definitions, as the source file sees them — both the export sheet and the
  // summary cards are asserted against these rather than a hand-copied list.
  const { LANES } = mod.exports.__t;

  const readBack = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };
  const rowVals = (ws, i) => ws.getRow(i).values.slice(1);

  reset();
  let x = await callH("GET /api/df/activity-export", { days: 365 });
  assert.strictEqual(x.status, 200, JSON.stringify(x.json));
  assert.match(x.headers["content-type"], /spreadsheetml\.sheet/);
  // No mode given means detail — the old two-sheet workbook, so a saved link keeps working.
  assert.match(x.headers["content-disposition"], /attachment; filename="activity-detail_\d{4}-\d{2}-\d{2}\.xlsx"/);
  ok("export: served as a downloadable .xlsx with a dated filename, defaulting to detail");

  let wb = await readBack(x.buffer);
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ["Activity Log", "Current Position"]);
  const s1 = wb.getWorksheet("Activity Log");
  assert.deepStrictEqual(rowVals(s1, 1),
    ["Date", "Project", "Item", "Tag", "Source", "Author", "Entry", "Detail", "Link"]);
  assert.strictEqual(s1.rowCount, actRows.length + 1, "one header row plus one row per entry");
  ok("export: two sheets, Activity Log carries a row per entry under the right headings");

  // Content actually made it into the cells — the check the sandbox could not make.
  const a1row = rowVals(s1, 2);
  assert.strictEqual(a1row[6], "Suffix 112 blocked — awaiting decision.");
  assert.strictEqual(a1row[2], "Suffix 112 B2 Glazed Screen");
  assert.strictEqual(a1row[1], "24-354 EIT");
  assert.strictEqual(a1row[4], "A&I");
  ok("export: entry text, item and project names land in the right columns");

  assert.strictEqual(s1.getRow(1).getCell(1).font?.bold, true, "header is bold");
  assert.strictEqual(s1.getRow(1).getCell(9).font?.bold, true);
  assert.strictEqual(s1.views?.[0]?.state, "frozen");
  assert.strictEqual(s1.views?.[0]?.ySplit, 1, "top row frozen");
  assert.ok(s1.columns.every((c) => c.width > 0), "columns are sized");
  ok("export: bold header, frozen top row, sized columns");

  const dcell = s1.getRow(2).getCell(1);
  assert.ok(dcell.value instanceof Date, "dates are real Date cells, not pre-formatted strings");
  assert.strictEqual(dcell.numFmt, "dd/mm/yyyy hh:mm", "UK date format");
  ok("export: UK-formatted real dates, so Excel sorts them as dates, not alphabetically");

  // A backfilled entry must export under the date it happened, not the date it was typed.
  const backfilled = [];
  s1.eachRow((r, i) => { if (i > 1 && String(r.getCell(7).value).startsWith("Backfilled")) backfilled.push(r.getCell(1).value); });
  assert.strictEqual(backfilled.length, 1);
  assert.strictEqual(backfilled[0].toISOString().slice(0, 7), "2026-03", "exported under its Event Date");
  ok("export: a backfilled entry exports under its Event Date, not its Created date");

  // The rule that matters: the export is exactly what is on screen, filters and all.
  reset();
  const onScreen = await call("GET /api/df/activity-log", { from: "2026-03-01", to: "2026-03-31" });
  reset();
  wb = await readBack((await callH("GET /api/df/activity-export", { from: "2026-03-01", to: "2026-03-31" })).buffer);
  assert.strictEqual(onScreen.json.entries.length, 1, "sanity: the March range holds one entry");
  assert.strictEqual(wb.getWorksheet("Activity Log").rowCount, onScreen.json.entries.length + 1);
  ok("export: row count matches the filtered feed exactly");

  const s2 = wb.getWorksheet("Current Position");
  assert.deepStrictEqual(rowVals(s2, 1),
    ["Source", "Ref", "Project", "Item", "Title", "Status", "Ball in Court", "Blocker", "Opened", "Days Open"]);
  assert.strictEqual(s2.rowCount, aiRows.length + rfiRows.length + 1, "every open item, from both trackers");
  const days = [];
  s2.eachRow((r, i) => { if (i > 1) days.push(r.getCell(10).value); });
  assert.ok(days.length === 4 && days.every((v) => typeof v === "number" && v >= 0),
    `Days Open must be backend-computed numbers, got ${JSON.stringify(days)}`);
  const refs = []; s2.eachRow((r, i) => { if (i > 1) refs.push(r.getCell(2).value); });
  assert.ok(refs.includes("RFI-014"), "RFI rows carry their zero-padded ref");
  ok("export: Current Position lists both trackers with a numeric Days Open");

  // ── export modes (§8) ───────────────────────────────────────────────────
  // Three deliverables with different readers: summary for the client, detail as the
  // evidence behind it, combined for handing over a project in one file.
  reset();
  x = await callH("GET /api/df/activity-export", { mode: "summary" });
  assert.strictEqual(x.status, 200, JSON.stringify(x.json));
  assert.match(x.headers["content-disposition"], /filename="activity-summary_\d{4}-\d{2}-\d{2}\.xlsx"/);
  wb = await readBack(x.buffer);
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ["Summary"],
    "the client workbook is the summary alone — the submission detail is noise to them");
  ok("export: summary mode is one sheet, named for what it is");

  const sum = wb.getWorksheet("Summary");
  const head = rowVals(sum, 1);
  assert.deepStrictEqual(head.slice(0, 3), ["Project", "Item", "Code"]);
  // Lane columns are generated from LANE_ORDER, so adding a lane cannot leave the
  // spreadsheet a column short of the badges.
  assert.deepStrictEqual(head.slice(3, 3 + LANES.LANE_ORDER.length),
    LANES.LANE_ORDER.map((id) => LANES.LANE_SHORT[id]));
  assert.deepStrictEqual(head.slice(3 + LANES.LANE_ORDER.length),
    ["Drawings", "Blockers", "Blocker detail", "Open RFIs", "RFI refs"]);
  ok("export: one column per lane, driven by lanes.js, then the totals");

  const sumRows = {};
  sum.eachRow((r, i) => { if (i > 1) sumRows[r.getCell(3).value] = r; });
  const col = (row, laneId) => row.getCell(4 + LANES.LANE_ORDER.indexOf(laneId)).value;
  const r190 = sumRows["24-354-190"], r200 = sumRows["24-354-200"];
  assert.ok(r190 && r200, `expected both items on the summary, got ${Object.keys(sumRows)}`);

  assert.strictEqual(col(r190, "awaiting-comments"), 1);
  assert.strictEqual(col(r190, "signoff"), 1);
  // The whole point of the lane count: the bounce is superseded, so the cell is empty
  // rather than reporting a drawing that came back weeks ago.
  assert.ok(col(r190, "bounced") == null, "a superseded bounce leaves the cell empty");
  ok("export: superseded rounds do not reach the client's spreadsheet");

  for (const laneId of LANES.LANE_ORDER) {
    const v = col(r200, laneId);
    assert.ok(v == null || v > 0, `lane ${laneId} exported a zero instead of a blank cell`);
  }
  assert.strictEqual(col(r200, "closed"), 1, "a signed-off drawing is what the client wants to read");
  assert.strictEqual(col(r200, "scheduled"), 1);
  ok("export: zeros are blank cells, never 0 — the spreadsheet form of dropping them");

  const nLanes = LANES.LANE_ORDER.length;
  assert.strictEqual(r190.getCell(4 + nLanes).value, 2, "Drawings total");
  assert.strictEqual(r190.getCell(5 + nLanes).value, 1, "Blockers count");
  assert.strictEqual(r190.getCell(6 + nLanes).value, "Awaiting decision", "blocker reasons spelled out");
  assert.strictEqual(r190.getCell(7 + nLanes).value, 1, "Open RFIs count");
  assert.strictEqual(r190.getCell(8 + nLanes).value, "RFI-014", "RFI refs so they can be looked up");
  ok("export: totals, blocker reasons and RFI refs make the summary self-contained");

  reset();
  x = await callH("GET /api/df/activity-export", { mode: "combined", days: 365 });
  assert.match(x.headers["content-disposition"], /filename="activity-combined_\d{4}-\d{2}-\d{2}\.xlsx"/);
  wb = await readBack(x.buffer);
  const names = wb.worksheets.map((w) => w.name);
  assert.strictEqual(names[0], "Summary", "the summary leads — it is what gets read first");
  assert.ok(names.length > 1, "then a sheet per item");
  assert.ok(names.every((n) => n.length <= 31), `Excel caps sheet names at 31: ${names}`);
  assert.strictEqual(new Set(names).size, names.length, "duplicate sheet names corrupt the workbook");
  ok("export: combined leads with the summary, then one sheet per item");

  // Every entry lands on exactly one item sheet, and none is lost on the way.
  const perItemRows = wb.worksheets.slice(1).reduce((n, w) => n + w.rowCount - 1, 0);
  assert.strictEqual(perItemRows, actRows.length,
    "every entry in the filtered feed appears on exactly one item sheet");
  ok("export: splitting by item neither drops nor duplicates an entry");

  reset();
  x = await callH("GET /api/df/activity-export", { mode: "nonsense" });
  assert.strictEqual(x.status, 400);
  assert.match(x.json.error, /Invalid mode/);
  ok("export: an unknown mode is refused rather than quietly served as something else");

  // Summary mode must not pay for the Activity Log it does not print.
  reset();
  await callH("GET /api/df/activity-export", { mode: "summary" });
  assert.strictEqual(seen.ACT.length, 0, "summary mode never queries the Activity Log");
  reset();
  await callH("GET /api/df/activity-export", { mode: "combined", days: 365 });
  const combinedActCalls = seen.ACT.length;
  reset();
  await callH("GET /api/df/activity-export", { days: 365 });
  assert.strictEqual(combinedActCalls, seen.ACT.length,
    "combined regroups the entries it already fetched — no extra Notion calls per sheet");
  ok("export: each mode fetches only what it prints");

  // ── blocked rows go red ─────────────────────────────────────────────────
  // "A quick glance can reveal the issues that need resolving" (Greig, 26 Sep). Asserted by
  // reading the rule back out of the written workbook, not by trusting the call that set it.
  const cfOf = (ws) => (ws.conditionalFormattings || []).flatMap((c) =>
    (c.rules || []).map((rule) => ({ ref: c.ref, formula: rule.formulae?.[0], style: rule.style })));

  reset();
  wb = await readBack((await callH("GET /api/df/activity-export", { mode: "summary" })).buffer);
  const sumWs = wb.getWorksheet("Summary");
  const sumCf = cfOf(sumWs);
  assert.strictEqual(sumCf.length, 1, "one rule, not one per row");
  // Absolute column, relative row. "$Q$2" would test a single cell for the whole range and
  // "Q2" would drift a column at a time across it.
  const blockersLetter = sumWs.getColumn(5 + LANES.LANE_ORDER.length).letter;
  assert.strictEqual(sumCf[0].formula, `$${blockersLetter}2<>""`,
    "keyed on the Blockers column, absolute column and relative row");
  assert.strictEqual(sumCf[0].ref, `A2:${sumWs.getColumn(8 + LANES.LANE_ORDER.length).letter}${sumWs.rowCount}`,
    "the whole row is painted, header excluded");
  ok("export: Summary highlights any row with a blocker, across every column");

  // The trap that renders as no fill at all: a DIFFERENTIAL fill's visible colour lives in
  // bgColor, the opposite of an ordinary cell fill.
  assert.strictEqual(sumCf[0].style?.fill?.pattern, "solid");
  assert.ok(/F8D7DA$/i.test(sumCf[0].style?.fill?.bgColor?.argb || ""),
    `differential fill must set bgColor, got ${JSON.stringify(sumCf[0].style?.fill)}`);
  assert.ok(/9C0006$/i.test(sumCf[0].style?.font?.color?.argb || ""), "dark red text on the light red fill");
  ok("export: the highlight is a real differential fill, colour in bgColor where Excel reads it");

  reset();
  wb = await readBack((await callH("GET /api/df/activity-export", { days: 365 })).buffer);
  const logCf = cfOf(wb.getWorksheet("Activity Log"));
  assert.strictEqual(logCf.length, 1);
  // A log sheet has no blockers column — the log's way of saying an item is stuck is the tag.
  assert.strictEqual(logCf[0].formula, '$D2="#blocked"');
  assert.ok(logCf[0].ref.startsWith("A2:I"), `should span all nine log columns, got ${logCf[0].ref}`);
  const posCf = cfOf(wb.getWorksheet("Current Position"));
  assert.strictEqual(posCf[0].formula, '$H2<>""', "Current Position keys on its own Blocker column");
  ok("export: log sheets redden #blocked rows, Current Position its Blocker column");

  // Guard the fixture the rule depends on, so a tag rename cannot leave a rule matching
  // nothing while every test still passes.
  const tagsInLog = [];
  wb.getWorksheet("Activity Log").eachRow((r2, i) => { if (i > 1) tagsInLog.push(r2.getCell(4).value); });
  assert.ok(tagsInLog.includes("#blocked"),
    "no #blocked row in the export — the rule would be dead and nothing would say so");
  ok("export: there is a #blocked row for the rule to act on");

  reset();
  wb = await readBack((await callH("GET /api/df/activity-export", { mode: "combined", days: 365 })).buffer);
  for (const ws2 of wb.worksheets.slice(1)) {
    const rules = cfOf(ws2);
    assert.strictEqual(rules.length, 1, `item sheet "${ws2.name}" has no highlight rule`);
    assert.strictEqual(rules[0].formula, '$D2="#blocked"');
  }
  ok("export: every item sheet in a combined workbook carries the same rule");

  // A sheet with nothing under the header must get no rule: "A2:I1" is not a range Excel
  // will open.
  reset();
  wb = await readBack((await callH("GET /api/df/activity-export", { from: "2020-01-01", to: "2020-12-31" })).buffer);
  const emptyLog = wb.getWorksheet("Activity Log");
  assert.strictEqual(emptyLog.rowCount, 1, "sanity: header only");
  assert.strictEqual(cfOf(emptyLog).length, 0, "an empty sheet gets no rule rather than an invalid range");
  ok("export: a header-only sheet is left alone rather than given a broken range");

  // A client-facing sheet gets printed and PDF'd. At 18 columns it breaks across pages, and
  // page 2 of a default layout is a block of counts with no item name beside them.
  reset();
  wb = await readBack((await callH("GET /api/df/activity-export", { mode: "summary" })).buffer);
  const psum = wb.getWorksheet("Summary");
  assert.strictEqual(psum.pageSetup?.fitToWidth, 1, "one page wide");
  assert.strictEqual(psum.pageSetup?.fitToHeight, 0, "any number of pages long");
  assert.strictEqual(psum.pageSetup?.orientation, "landscape");
  assert.strictEqual(psum.pageSetup?.printTitlesColumn, "A:C", "item columns repeat on every page");
  assert.strictEqual(psum.pageSetup?.printTitlesRow, "1:1");
  assert.strictEqual(psum.views?.[0]?.xSplit, 3, "Project/Item/Code stay put when scrolling the lanes");
  ok("export: the Summary prints one page wide with the item columns repeated");

  // ── A&I action rows (§6.1) ──────────────────────────────────────────────
  //
  // A&I is the queue and the Activity Log is the ledger. A submission opens a queue row for
  // the DM decision it needs and closes it once that decision is made — the row dropping out
  // of A&I is the queue working, not history being lost.
  const { createActionRow, resolveActionRow, createActivityLogEntry } = mod.exports.__t;

  const writes = { created: [], updated: [] };
  const aiNotion = {
    pages: {
      create: async ({ parent, properties }) => { writes.created.push({ parent, properties }); return { id: "ai-new", url: "u/ai-new" }; },
      update: async (u) => { writes.updated.push(u); return {}; },
    },
  };

  const rowId = await createActionRow(aiNotion, {
    taskId: "task1", personId: "dtGary", received: "2026-09-21T09:15:00.000Z",
    note: "Review A-101 Rev C02 — Suffix 112",
    category: "Drawing Update", context: "Stage S4 · QA Round 1", link: "https://notion.test/sub",
  });
  assert.strictEqual(rowId, "ai-new", "the new row id is returned so it can be stored on the submission");
  const props = writes.created[0].properties;
  assert.strictEqual(writes.created[0].parent.database_id, "AI");
  // joined rather than deepStrictEqual: the array is built in the vm realm, so a
  // structural compare against a host-realm literal fails on prototype identity.
  assert.strictEqual(props["Status"].select.name, "Open", "born tracked — no manual step for submissions");
  assert.ok(!("Tags" in props),     "Tags is gone — Status is the tracking flag");
  assert.ok(!("Archived" in props), "Archived is gone — Checked is the only done flag");
  assert.strictEqual(props["Ball in Court"].select.name, "Me", "a submission lands in the DM's court");
  assert.strictEqual(props["Items"].relation[0].id, "task1");
  assert.strictEqual(props["Category"].select.name, "Drawing Update");
  ok("A&I row: opens tracked, Open, with DM, tied to the item");

  // Projects is a rollup through Items as of 24 Sep 2026. Writing it would 400, and the
  // catch inside createActionRow would swallow that — every submission would silently stop
  // getting a queue row. This assertion is the guard against that regression.
  assert.ok(!("Projects" in props), "Projects is a rollup — writing it would fail silently");
  assert.strictEqual(props["Person"].relation[0].id, "dtGary", "the DT whose submission is waiting");
  assert.strictEqual(props["Received"].date.start, "2026-09-21T09:15:00.000Z",
    "A&I is sorted by Received — a submission row must carry it like an email row does");
  ok("A&I row: Person and Received are written, Projects is left to the rollup");

  writes.created.length = 0;
  await createActionRow(aiNotion, { taskId: "task1", note: "no extras" });
  const bare = writes.created[0].properties;
  assert.strictEqual(bare["Person"], undefined, "no person known — relation left off, not sent empty");
  assert.ok(bare["Received"].date.start, "Received still defaults to now when not passed");
  ok("A&I row: a missing person is omitted; Received always has a value");

  // Source is what keeps every submission out of the feed twice over — the Make scenario
  // filters on it. If this ever stops being "Submission", the feed double-logs.
  assert.strictEqual(props["Source"].select.name, "Submission",
    "Source=Submission is what lets the Make A&I scenario skip these rows");
  ok("A&I row: stamped Source=Submission so Make can skip it and the feed never doubles up");

  assert.ok(props["Context"].rich_text[0].text.content.includes("https://notion.test/sub"));
  assert.strictEqual(props["Email Link"], undefined,
    "Email Link belongs to the Email Task Tracker — additive means not repurposing it either");
  ok("A&I row: link goes in Context, not in the Email Tracker's own property");

  // ── the Log writer must not write Projects either ───────────────────────────
  // Same silent-failure shape as the A&I row above: the Log's Projects is a rollup through
  // Task, and createActivityLogEntry swallows its own errors so a submission is never broken
  // by a logging failure. Write Projects and every entry would vanish without a trace.
  const logWrites = [];
  const logNotion = { pages: { create: async ({ parent, properties }) => {
    logWrites.push({ parent, properties }); return { id: "log-new" };
  } } };
  await createActivityLogEntry(logNotion, {
    taskId: "task1", source: "Drawing Flow", tag: "#submitted", author: "Gary",
    entry: "Drawing A-101 Rev C02 submitted by Gary.",
  });
  const lp = logWrites[0].properties;
  assert.strictEqual(logWrites[0].parent.database_id, "ACT");
  assert.strictEqual(lp["Task"].relation[0].id, "task1", "the entry lands on its item");
  assert.ok(!("Projects" in lp), "Projects is a rollup — writing it would fail silently");
  ok("Activity Log: entry carries Task only; Projects is left to the rollup");

  writes.updated.length = 0;
  await resolveActionRow(aiNotion, "ai-new");
  const up = writes.updated[0].properties;
  assert.strictEqual(writes.updated[0].page_id, "ai-new");
  assert.strictEqual(up["Status"].select, null, "clearing Status takes it out of the open queue");
  assert.ok(!("Archived" in up), "Archived is gone — Checked is the only done flag");
  assert.strictEqual(up["Checked"].checkbox, true,
    "Checked is the done-flag the Response Reconciler and Chase List read — resolve must set it too");
  assert.strictEqual(up["Ball in Court"].select, null, "nobody holds a closed item");
  assert.strictEqual(up["Blocker"].select, null);
  ok("A&I row: closing ticks Checked, clears Status and clears who holds it");

  writes.updated.length = 0;
  await resolveActionRow(aiNotion, null);
  await resolveActionRow(aiNotion, undefined);
  assert.strictEqual(writes.updated.length, 0);
  ok("A&I row: a submission with no row (pre-dating this, or a failed create) closes quietly");

  // P4: a queue failure must never take down the submission endpoint it hangs off.
  const brokenNotion = { pages: { create: async () => { throw new Error("notion down"); },
                                  update: async () => { throw new Error("notion down"); } } };
  assert.strictEqual(await createActionRow(brokenNotion, { note: "x" }), null,
    "a failed create returns null rather than throwing");
  await resolveActionRow(brokenNotion, "ai-new");
  ok("A&I row: Notion being down degrades to null and a warning, never an exception (P4)");

  // Wiring guard. The helpers above are unit-tested; this checks every DM action endpoint
  // actually calls the closer, so a fifth action added later cannot silently leave rows open
  // in the queue forever.
  const source = fs.readFileSync(srcPath, "utf8");
  for (const action of ["approve", "issue", "bounce", "log-status"]) {
    const start = source.indexOf(`app.patch("/api/df/submissions/:id/${action}"`);
    assert.ok(start > -1, `${action} endpoint not found`);
    const nextRoute = source.slice(start + 1).search(/app\.(get|post|patch)\("\/api\/df\//);
    const body = source.slice(start, nextRoute > -1 ? start + 1 + nextRoute : source.length);
    assert.ok(body.includes("resolveActionRow("), `${action} does not close its A&I row`);
  }
  assert.ok(source.includes("createActionRow(notion, {"), "ingest must open the row");
  ok("A&I row: every DM action endpoint closes the row ingest opened");

  // ── summary: drawing lanes ──────────────────────────────────────────────
  // The executive-summary view. Three badge groups per item — drawings by lane, blockers,
  // open RFIs — and no reliance on the hand-maintained `Item Status`.
  const laneMap = (item) => Object.fromEntries(item.drawings.map((l) => [l.id, l.n]));

  reset();
  r = await call("GET /api/df/activity-summary");
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const byCode = Object.fromEntries(r.json.items.map((i) => [i.taskCode, i]));

  // d1: R1 Rejected superseded by R2 Issued. This is the 24-354-190 case — the naive row
  // count says "Bounced — With DT 8" where the truthful answer is zero.
  assert.strictEqual(laneMap(byCode["24-354-190"]).bounced, undefined,
    "a bounce with a later round on the same drawing is not current state");
  assert.strictEqual(laneMap(byCode["24-354-190"])["awaiting-comments"], 1,
    "the drawing counts once, at the round it actually sits on");
  ok("summary: a superseded bounce does not count — one row per drawing, latest round");

  // d2: Graded at S4, reissued at A4.5. Stage outranks round, so the later stage wins.
  assert.strictEqual(laneMap(byCode["24-354-190"]).signoff, 1);
  assert.strictEqual(laneMap(byCode["24-354-190"]).closed, undefined,
    "a drawing that moved on to a later stage is not still signed off at the earlier one");
  assert.strictEqual(byCode["24-354-190"].drawingTotal, 2, "two drawings, two badge slots");
  ok("summary: a later stage supersedes an earlier one, however many rounds it ran");

  const t200 = laneMap(byCode["24-354-200"]);
  assert.deepStrictEqual(t200, { reviewed: 1, comments: 1, closed: 1, scheduled: 1 });
  assert.ok(byCode["24-354-200"].drawings.every((l) => l.n > 0), "zeros are excluded");
  assert.deepStrictEqual(byCode["24-354-200"].drawings.map((l) => l.id),
    ["reviewed", "comments", "closed", "scheduled"], "badges read in board order");
  assert.ok(byCode["24-354-200"].drawings.every((l) => l.title),
    "each badge carries its full lane title, not just an id");
  ok("summary: lanes are counted, zeros dropped, board order preserved");

  // Graded + DT Notified has left the cockpit board entirely, but it is the one thing a
  // client actually wants to read off the card.
  assert.strictEqual(t200.closed, 1, "a graded, notified drawing reports as signed off");
  assert.strictEqual(t200.scheduled, 1, "placeholder rows are counted apart from work in flight");
  ok("summary: terminal and placeholder rows have lanes of their own");

  assert.strictEqual(r.json.unlinked.drawings, 1,
    "a submission with no Item is surfaced as unlinked, not folded onto another card");
  assert.ok(!r.json.items.some((i) => i.taskCode === null && i.drawingTotal > 0));
  ok("summary: a submission with no Item is reported, never silently reassigned");

  // Blockers and RFIs come from fetchPosition — one definition of "blocked", two surfaces.
  assert.strictEqual(byCode["24-354-190"].blockers.length, 1);
  assert.strictEqual(byCode["24-354-190"].blockers[0].reason, "Awaiting decision");
  assert.strictEqual(byCode["24-354-190"].rfis.length, 1);
  assert.strictEqual(byCode["24-354-190"].rfis[0].ref, "RFI-014");
  assert.strictEqual(byCode["24-354-200"].blockers.length, 0,
    "Blocker = '—' means assessed and clear, which is not a blocker");
  ok("summary: blockers and open RFIs reuse fetchPosition's numbers");

  assert.strictEqual(r.json.items[0].taskCode, "24-354-190", "blocked items sort to the top");
  ok("summary: most pressing item first");

  // `Item Status` is hand-maintained and lags the drawings; a client-facing card must not
  // quote it. This guard is the whole reason the drawing badge exists.
  const summarySrc = fs.readFileSync(srcPath, "utf8");
  const fsStart = summarySrc.indexOf("async function fetchSummary(");
  assert.ok(fsStart > -1);
  const fsEnd = summarySrc.indexOf("\n  // GET /api/df/activity-log", fsStart);
  assert.ok(!summarySrc.slice(fsStart, fsEnd).includes("Item Status"),
    "fetchSummary must not read Item Status — it is manual and stale (handoff 7.5)");
  ok("summary: the card never quotes the hand-maintained Item Status");

  reset();
  await call("GET /api/df/activity-summary", { taskId: "task1" });
  assert.deepStrictEqual(seen.SUBS[0], { and: [{ property: "Item", relation: { contains: "task1" } }] });
  ok("summary: taskId scopes the Submissions query on the Item relation");

  reset();
  await call("GET /api/df/activity-summary", { projectId: "proj1" });
  assert.ok(seen.SUBS[0].and[0].or, "project scope OR's the project's task ids");
  assert.ok(depth(seen.SUBS[0]) <= 2, "filter stays inside Notion's two-level nesting limit");
  ok("summary: project scope composes without breaching Notion's nesting limit");

  reset();
  r = await call("GET /api/df/activity-summary", { projectId: "nope" });
  assert.deepStrictEqual(r.json.items, [], "an empty project short-circuits");
  ok("summary: a project with no items returns empty rather than the whole portfolio");

  // ── anti-drift: one definition of the lanes ─────────────────────────────
  // The lane rules used to live only as client-side buckets in cockpit.jsx. If a lane is
  // added to the board and not to lanes.js, the client card and the cockpit start telling
  // different stories about the same drawings — this is the test that stops that.
  const cockpit  = fs.readFileSync(srcPath.replace(/drawing-flow\.js$/, "public/cockpit.jsx"), "utf8");
  const colsSrc  = cockpit.slice(cockpit.indexOf("const COLS = ["));
  const boardIds = [...colsSrc.slice(0, colsSrc.indexOf("\n  ];")).matchAll(/\{ id: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(boardIds.length >= 8, `expected the board's lanes, found ${boardIds.length}`);
  for (const id of boardIds) {
    assert.ok(LANES.LANE_ORDER.includes(id), `cockpit lane "${id}" is missing from lanes.js`);
  }
  assert.deepStrictEqual(boardIds, LANES.LANE_ORDER.slice(0, boardIds.length),
    "lanes.js must list the board's lanes first, in the board's order");
  ok("summary: every cockpit board lane is defined in lanes.js, in the same order");

  // A lane added to lanes.js but not to the stylesheet renders as unstyled grey text — it
  // still says the right thing, but it stops looking like a state, which on a client-facing
  // card is its own kind of wrong.
  const css = fs.readFileSync(srcPath.replace(/drawing-flow\.js$/, "public/styles.css"), "utf8");
  for (const id of LANES.LANE_ORDER) {
    assert.ok(css.includes(`.lane-${id}`), `lane "${id}" has no .lane-${id} rule in styles.css`);
  }
  ok("summary: every lane has a pill style");

  // Optional: `node tests/activity.test.js --dump-summary` writes the Summary sheet the real
  // route produces, both as a grid on stdout and as a .xlsx, so the client-facing workbook
  // can be eyeballed without standing the whole app up against Notion.
  if (process.argv.includes("--dump-summary")) {
    reset();
    const dump = await callH("GET /api/df/activity-export", { mode: "summary" });
    fs.writeFileSync(__dirname + "/../sample-summary.xlsx", dump.buffer);
    reset();
    const dumpC = await callH("GET /api/df/activity-export", { mode: "combined", days: 365 });
    fs.writeFileSync(__dirname + "/../sample-combined.xlsx", dumpC.buffer);
    const dws = (await readBack(dump.buffer)).getWorksheet("Summary");
    const grid = [];
    dws.eachRow((r) => grid.push(r.values.slice(1).map((v) => (v == null ? "" : String(v)))));
    const w = grid[0].map((_, i) => Math.max(...grid.map((r) => (r[i] || "").length)));
    console.log("\n" + grid.map((r) => r.map((c, i) => (c || "").padEnd(w[i])).join(" | ")).join("\n"));
    console.log("\nwrote sample-summary.xlsx and sample-combined.xlsx");
  }

  console.log(`\n${n} activity tests passed`);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
