// Route tests for the Item Activity Feed — GET /api/df/activity-log and
// GET /api/df/activity-position. Mocked Notion, same vm-sandbox pattern as routes.test.js.
// Run: node tests/activity.test.js
const fs = require("fs"), vm = require("vm"), assert = require("assert");

const env = {
  NOTION_DB_ACTIVITY_LOG: "ACT", NOTION_DB_ACTIONS_INFO: "AI",
  NOTION_DB_RFIS: "RFIS", NOTION_DB_TASKS: "TASKS",
};
const mod = { exports: {} };
const srcPath = fs.existsSync(__dirname + "/drawing-flow.js") ? __dirname + "/drawing-flow.js" : __dirname + "/../drawing-flow.js";
vm.runInNewContext(fs.readFileSync(srcPath, "utf8") +
  "\n;module.exports.__t = { createActionRow, resolveActionRow };", {
  module: mod, exports: mod.exports,
  require: (n) => n === "@netlify/blobs" ? { getStore: () => ({ get: async () => [], setJSON: async () => {} }) } : require(n),
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
    properties: { Entry: title("Suffix 112 blocked — awaiting decision."), Source: sel("A&I"), Tag: sel("#issue"), Author: rt("DM"), Detail: rt(""), Link: { url: null }, "Event Date": dt(null), Task: rel("task1") } },
  { id: "a2", url: "u/a2", created_time: "2026-09-17T16:40:00.000Z",
    properties: { Entry: title("RFI-014 raised — grid B4 setting out."), Source: sel("RFI"), Tag: sel("#query"), Author: rt("DM"), Detail: rt(""), Link: { url: null }, "Event Date": dt(null), Task: rel("task1") } },
  { id: "a3", url: "u/a3", created_time: "2026-09-18T08:00:00.000Z",
    properties: { Entry: title("Backfilled: March kickoff decision."), Source: sel("Manual"), Tag: sel("#decision"), Author: rt("DM"), Detail: rt(""), Link: { url: null }, "Event Date": dt("2026-03-02"), Task: rel("task2") } },
  { id: "a4", url: "u/a4", created_time: "2026-09-16T11:00:00.000Z",
    properties: { Entry: title("Drawing A-101 Rev C02 approved by DM."), Source: sel("Drawing Flow"), Tag: sel("#approval"), Author: rt("DM"), Detail: rt(""), Link: { url: null }, "Event Date": dt(null), Task: rel("task2") } },
];

const aiRows = [
  { id: "ai1", url: "u/ai1", created_time: "2026-09-01T09:00:00.000Z", properties: { Note: title("Confirm grid B4"), Tags: msel("Track"), Archived: chk(false),
    "Track Status": sel("Waiting"), "Ball in Court": sel("Client"), Blocker: sel("Awaiting decision"), Category: sel("Design Coordination"), Items: rel("task1") } },
  { id: "ai2", url: "u/ai2", created_time: "2026-09-16T09:00:00.000Z", properties: { Note: title("Review A-101 Rev C02"), Tags: msel("Track"), Archived: chk(false),
    "Track Status": sel("Open"), "Ball in Court": sel("Me"), Blocker: sel("—"), Category: sel("Drawing Update"), Items: rel("task2") } },
  { id: "ai3", url: "u/ai3", created_time: "2026-08-20T09:00:00.000Z", properties: { Note: title("Chase panel finish sample"), Tags: msel("Track"), Archived: chk(false),
    "Track Status": sel("Open"), "Ball in Court": sel("Me"), Blocker: sel(null), Category: sel("Supplier Coordination"), Items: rel() } },
];

const rfiRows = [
  { id: "r1", url: "u/r1", created_time: "2026-09-17T09:00:00.000Z", properties: { "RFI Description": title("Grid B4 setting out"), "RFI Number": num(14),
    "RFI Status": sel("Open"), "TBC by": sel("Architect"), "Date Raised": dt("2026-09-17"), "Related Item(s)": rel("task1") } },
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
  assert.strictEqual(r.json.entries.length, 4);
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
  await call("GET /api/df/activity-log", { projectId: "proj1", tag: "#issue,#approval", source: "RFI", from: "2026-09-01" });
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
  assert.deepStrictEqual(r.json.entries.map((e) => e.id), ["a1", "a2", "a4"]);
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
  assert.deepStrictEqual(r.json.entries.map((e) => e.id), ["a1", "a4", "a2", "a3"].sort((x, y) => {
    const d = (id) => ({ a1: "2026-09-18T09:22", a2: "2026-09-17T16:40", a3: "2026-03-02", a4: "2026-09-16T11:00" }[id]);
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
  const readBack = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };
  const rowVals = (ws, i) => ws.getRow(i).values.slice(1);

  reset();
  let x = await callH("GET /api/df/activity-export", { days: 365 });
  assert.strictEqual(x.status, 200, JSON.stringify(x.json));
  assert.match(x.headers["content-type"], /spreadsheetml\.sheet/);
  assert.match(x.headers["content-disposition"], /attachment; filename="activity-export_\d{4}-\d{2}-\d{2}\.xlsx"/);
  ok("export: served as a downloadable .xlsx with a dated filename");

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

  // ── A&I action rows (§6.1) ──────────────────────────────────────────────
  //
  // A&I is the queue and the Activity Log is the ledger. A submission opens a queue row for
  // the DM decision it needs and closes it once that decision is made — the row dropping out
  // of A&I is the queue working, not history being lost.
  const { createActionRow, resolveActionRow } = mod.exports.__t;

  const writes = { created: [], updated: [] };
  const aiNotion = {
    pages: {
      create: async ({ parent, properties }) => { writes.created.push({ parent, properties }); return { id: "ai-new", url: "u/ai-new" }; },
      update: async (u) => { writes.updated.push(u); return {}; },
    },
  };

  const rowId = await createActionRow(aiNotion, {
    taskId: "task1", projectId: "proj1", personId: "dtGary", received: "2026-09-21T09:15:00.000Z",
    note: "Review A-101 Rev C02 — Suffix 112",
    category: "Drawing Update", context: "Stage S4 · QA Round 1", link: "https://notion.test/sub",
  });
  assert.strictEqual(rowId, "ai-new", "the new row id is returned so it can be stored on the submission");
  const props = writes.created[0].properties;
  assert.strictEqual(writes.created[0].parent.database_id, "AI");
  // joined rather than deepStrictEqual: the array is built in the vm realm, so a
  // structural compare against a host-realm literal fails on prototype identity.
  assert.strictEqual(props["Tags"].multi_select.map((t) => t.name).join(","), "Track", "born tracked — no manual step for submissions");
  assert.strictEqual(props["Track Status"].select.name, "Open");
  assert.strictEqual(props["Ball in Court"].select.name, "Me", "a submission lands in the DM's court");
  assert.strictEqual(props["Archived"].checkbox, false);
  assert.strictEqual(props["Items"].relation[0].id, "task1");
  assert.strictEqual(props["Category"].select.name, "Drawing Update");
  ok("A&I row: opens tracked, Open, with DM, tied to the item");

  assert.strictEqual(props["Projects"].relation[0].id, "proj1", "filterable by project in A&I");
  assert.strictEqual(props["Person"].relation[0].id, "dtGary", "the DT whose submission is waiting");
  assert.strictEqual(props["Received"].date.start, "2026-09-21T09:15:00.000Z",
    "A&I is sorted by Received — a submission row must carry it like an email row does");
  ok("A&I row: carries Project, Person and Received, so it sorts and filters like the rest");

  writes.created.length = 0;
  await createActionRow(aiNotion, { taskId: "task1", note: "no extras" });
  const bare = writes.created[0].properties;
  assert.strictEqual(bare["Projects"], undefined, "no project known — relation left off, not sent empty");
  assert.strictEqual(bare["Person"], undefined);
  assert.ok(bare["Received"].date.start, "Received still defaults to now when not passed");
  ok("A&I row: missing project/person are omitted; Received always has a value");

  // Source is what keeps every submission out of the feed twice over — the Make scenario
  // filters on it. If this ever stops being "Submission", the feed double-logs.
  assert.strictEqual(props["Source"].select.name, "Submission",
    "Source=Submission is what lets the Make A&I scenario skip these rows");
  ok("A&I row: stamped Source=Submission so Make can skip it and the feed never doubles up");

  assert.ok(props["Context"].rich_text[0].text.content.includes("https://notion.test/sub"));
  assert.strictEqual(props["Email Link"], undefined,
    "Email Link belongs to the Email Task Tracker — additive means not repurposing it either");
  ok("A&I row: link goes in Context, not in the Email Tracker's own property");

  writes.updated.length = 0;
  await resolveActionRow(aiNotion, "ai-new");
  const up = writes.updated[0].properties;
  assert.strictEqual(writes.updated[0].page_id, "ai-new");
  assert.strictEqual(up["Track Status"].select.name, "Resolved");
  assert.strictEqual(up["Archived"].checkbox, true);
  assert.strictEqual(up["Checked"].checkbox, true,
    "Checked is the done-flag the Response Reconciler and Chase List read — resolve must set it too");
  assert.strictEqual(up["Ball in Court"].select, null, "nobody holds a closed item");
  assert.strictEqual(up["Blocker"].select, null);
  ok("A&I row: closing resolves, archives, ticks Checked and clears who holds it");

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

  console.log(`\n${n} activity tests passed`);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
