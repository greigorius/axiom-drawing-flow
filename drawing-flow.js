// drawing-flow.js — Axiom Drawing Flow API routes
// Mounted into the main Express app via:  require('./drawing-flow')(app, notion)
//
// Routes:
//   POST   /api/df/ingest
//   GET    /api/df/submissions          ?status=Submitted|Issued|Graded|Rejected|pending-notification
//   PATCH  /api/df/submissions/:id/approve
//   PATCH  /api/df/submissions/:id/issue
//   PATCH  /api/df/submissions/:id/bounce
//   PATCH  /api/df/submissions/:id/log-status
//   POST   /api/df/send-dt-emails       batch DT notification — fires action=dt-summary webhook per DT
//   GET    /api/df/drawings             ?taskId&stage&status
//   GET    /api/df/inputs/:projectId
//   GET    /api/df/inputs/:projectId/:taskId
//   POST   /api/df/inputs
//   GET    /api/df/activity-log        ?taskId&limit  — Item Activity Log feed for a task
//   POST   /api/df/activity-log        manual/backfill entry (also auto-fired on approve/issue/bounce/log-status/ingest)
//
// Make.com integration:
//   Scenario 1 (Ingest):      Make watches Dropbox /Pending/ and calls POST /api/df/ingest
//   Scenario 2 (Actions Hub): backend fires MAKE_ACTIONS_WEBHOOK with action=dt-summary (batch email)
//                             or action=approve|bounce (Dropbox moves only — no immediate email)
//                             See docs/MAKE-CONFIG-GUIDE.md for full configuration steps

"use strict";

// --- DB IDs ---
const DRAWINGS_DB    = process.env.NOTION_DB_DRAWINGS;
const SUBMISSIONS_DB = process.env.NOTION_DB_SUBMISSIONS;
const TEAM_DB        = process.env.NOTION_DB_TEAM;
const TASKS_DB       = process.env.NOTION_DB_TASKS;
const INPUTS_DB      = () => process.env.NOTION_DB_INPUTS;
const ACTIVITY_LOG_DB = process.env.NOTION_DB_ACTIVITY_LOG;

// --- Stage constants ---

const VALID_STAGES = ["S3", "S4", "S5", "A4.5", "AB"];

const STAGE_LABEL = {
  "S3":   "S3 - For Coordination",
  "S4":   "S4 - For Review and Authorisation",
  "S5":   "S5 - For Review and Acceptance",
  "A4.5": "A4.5 - Authorised Mfg. & Constr. Design",
  "AB":   "AB - As Built Record Drawings",
};

const STAGE_APPROVE_MAP = {
  "S3":   { dateField: "Model Submit Date"        },
  "S4":   { dateField: "S4 Submit Date (Actual)"  },
  "S5":   { dateField: "S5 Submit Date (Actual)"  },
  "A4.5": { dateField: "C01 Submit Date (Actual)" },
  "AB":   { dateField: "AB Submit Date (Actual)"  },
};

const STAGE_APPROVE_DRAWING_STATUS = {
  "S3":   "Client Review",
  "S4":   "Client Review",
  "S5":   "Client Review",
  "A4.5": "Production Updates",
  "AB":   "Client Review",
};

// NOTE: Add "Document Control" to Submissions DB BIC select options,
//       then change "AB" entry from "Project Team" to "Document Control".
const STAGE_APPROVE_BIC = {
  "S3":   "Architect",
  "S4":   "Contractor",   // MC & consultants review
  "S5":   "Architect",    // Client review
  "A4.5": "Contractor",   // MC sign-off
  "AB":   "Project Team",
};

const STAGE_LOG_STATUS_MAP = {
  "S3":   { supported: false, statusField: null,        dateField: null,             grades: []                       },
  "S4":   { supported: true,  statusField: "S4 Status", dateField: "S4 Status Date", grades: ["A","B","C","NA"]      },
  "S5":   { supported: true,  statusField: "S5 Status", dateField: "S5 Status Date", grades: ["A","B","C","NA"]      },
  "A4.5": { supported: true,  statusField: null,        dateField: "C01 Sign Off",   grades: ["Approved","Rejected"]  },
  "AB":   { supported: true,  statusField: "AB Status", dateField: "AB Status Date", grades: ["Approved","Rejected"] },
};

const BIC = {
  SUBMITTED:        "DM",
  BOUNCED:          "DT",
  GRADED:           "DM",   // DM holds BIC until grade email is fired, then switches to DT
  COMMENTS_RECEIVED: "DM",  // Client comments landed on an Issued submission — DM needs to review
};

// ── Working-days helper ──────────────────────────────────────────────────────
function addWorkingDays(dateStr, days) {
  const d = new Date(dateStr);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;   // skip Sat & Sun
  }
  return d.toISOString().slice(0, 10);
}

// ── Resolve revision days from Projects DB via Drawing → Item → Project chain ─
async function getRevisionDays(notion, drawingPageIds) {
  try {
    if (!drawingPageIds?.length) return 7;
    const drawing    = await notion.pages.retrieve({ page_id: drawingPageIds[0] });
    const taskIds    = getProp(drawing, "Item",    "relation");
    if (!taskIds?.length) return 7;
    const task       = await notion.pages.retrieve({ page_id: taskIds[0] });
    const projectIds = getProp(task,    "Project", "relation");
    if (!projectIds?.length) return 7;
    const project    = await notion.pages.retrieve({ page_id: projectIds[0] });
    return getProp(project, "Revision Days", "number") ?? 7;
  } catch (err) {
    console.warn("[getRevisionDays] Falling back to 7:", err.message);
    return 7;
  }
}

// Approval Days, Revision Days, C01 Sign Off Days are project-level — stored in Projects DB.
const INPUTS_FIELDS = [
  { key: "programmeStart", prop: "Programme Start",      type: "date"   },
  { key: "s3LeadTime",     prop: "S3 Lead Time (days)",  type: "number" },
  { key: "s4LeadTime",     prop: "S4 Lead Time (days)",  type: "number" },
  { key: "s4QaDays",       prop: "S4 QA Days",           type: "number" },
  { key: "s5LeadTime",     prop: "S5 Lead Time (days)",  type: "number" },
  { key: "s5QaDays",       prop: "S5 QA Days",           type: "number" },
  { key: "c01LeadTime",    prop: "C01 Lead Time (days)", type: "number" },
];

// --- Dropbox helpers ---

// Root path stripped from stored Dropbox Path to keep Notion tidy.
// Stored path starts from "Drawing Submissions/..." — full path is reconstructed on move.
const DROPBOX_ROOT = "/DESIGN KNOW HOW/TMJ Interiors";

function toFullDropboxPath(rawPath) {
  if (!rawPath) return null;
  // Case-insensitive check — path_lower from Make will be lowercase
  if (rawPath.toLowerCase().startsWith(DROPBOX_ROOT.toLowerCase())) return rawPath;
  return `${DROPBOX_ROOT}/${rawPath.replace(/^\//, "")}`;
}

function computeDropboxMove(rawPath, action, qaRound) {
  const fullPath = toFullDropboxPath(rawPath);
  if (!fullPath) return null;
  // Case-insensitive check — path_lower from Make will be lowercase
  const idx = fullPath.toLowerCase().indexOf("/pending/");
  if (idx < 0) return null;
  const before  = fullPath.slice(0, idx);          // everything before /Pending/
  const filename = fullPath.slice(idx + "/pending/".length); // filename after /Pending/
  if (action === "bounce") {
    const fileParts      = filename.split("_");
    const itemNo         = fileParts[0] ?? "";
    const toFolderParent = `${before}/Rejected`;
    const toFolderName   = `R${qaRound}`;
    const rFolder        = `${toFolderParent}/${toFolderName}`;
    const toFolder       = itemNo ? `${rFolder}/Suffix ${itemNo}` : rFolder;
    const to             = `${toFolder}/${filename}`;
    return { from: fullPath, to, toFolder, rFolder, toFolderParent, toFolderName, itemNo };
  }
  if (action === "approve") {
    // Filename format: {itemNo}_{drawingNo}_{revision}_{dtInitials}.pdf
    const fileParts    = filename.split("_");
    const itemNo       = fileParts[0] ?? "";
    const drawingNo    = fileParts[1] ?? "";
    const ext          = filename.split(".").pop().toLowerCase();
    const toFolderParent = before;
    const toFolderName   = `Suffix ${itemNo}`;
    const toFolder       = `${toFolderParent}/${toFolderName}`;
    const newFilename    = drawingNo ? `${drawingNo}.${ext}` : filename;
    const to             = `${toFolder}/${newFilename}`;
    return { from: fullPath, to, toFolder, toFolderParent, toFolderName, newFilename, itemNo, drawingNo };
  }
  return null;
}

// --- Drawing type inference ---

// Infers the Dwg No. Assigned value from the drawing number pattern.
// -SK- checked before -S- to avoid partial matches.
function inferDwgType(drawingNo) {
  if (!drawingNo) return null;
  const n = drawingNo.toUpperCase();
  if (n.includes("-SK-")) return "Sketch";
  if (n.includes("-D-"))  return "Drawing";
  if (n.includes("-M-"))  return "Model";
  if (n.includes("-L-"))  return "Schedule";
  return null;
}

// --- Path / filename parsers ---

function parsePath(filePath) {
  const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const pendingIdx = parts.findIndex((p) => p.toLowerCase() === "pending");
  if (pendingIdx < 3 || pendingIdx >= parts.length - 1) return null;
  const projectNo = parts[pendingIdx - 2].toUpperCase();
  const stage     = parts[pendingIdx - 1].toUpperCase();
  const filename  = parts[pendingIdx + 1];
  if (!VALID_STAGES.includes(stage)) return null;
  return { projectNo, stage, filename };
}

function parseFilename(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  if (ext !== "pdf") return null;
  const base  = filename.slice(0, -(ext.length + 1));
  const parts = base.split("_");
  if (parts.length < 4) return null;
  const [itemNo, drawingNoRaw, revisionRaw, ...dtParts] = parts;
  const drawingNo  = drawingNoRaw?.toUpperCase();
  const revision   = revisionRaw?.toUpperCase();
  const dtInitials = dtParts.join("_").toUpperCase();
  if (!itemNo || !drawingNo || !revision || !dtInitials) return null;
  return { itemNo, drawingNo, revision, dtInitials };
}

function parseSubmissionTitle(title, stage) {
  if (!title) return { taskCode: null, drawingNo: null };
  const firstUnder = title.indexOf("_");
  if (firstUnder < 0) return { taskCode: title, drawingNo: null };
  const taskCode = title.slice(0, firstUnder);
  const rest = title.slice(firstUnder + 1);
  const stageMarker = `_${stage}_`;
  const stageIdx = rest.lastIndexOf(stageMarker);
  const drawingNo = stageIdx >= 0 ? rest.slice(0, stageIdx) : rest.split("_")[0];
  return { taskCode, drawingNo };
}

// --- Notion utilities ---

// Notion's API returns 429 ("You have been rate limited...") once its ~3 req/s limit is
// exceeded — easy to trip when several status groups' worth of DT/drawing lookups land at
// once, and near-guaranteed if more than one cockpit tab (e.g. a Netlify tab left open plus
// a local dev tab) is polling against the same integration token at the same time. None of
// the Notion calls in this file retried on that before, so a single 429 surfaced straight to
// the client as an uncaught 500. This retries up to 3 times with backoff, honoring Notion's
// Retry-After header when present, before giving up for real.
async function withNotionRetry(fn, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimited = err?.status === 429 || err?.code === "rate_limited";
      if (!isRateLimited || attempt >= retries) throw err;
      const retryAfterSec = Number(err?.headers?.["retry-after"]) || (attempt + 1) * 1.5;
      await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
    }
  }
}

async function queryAll(notion, database_id, filter, sorts) {
  const results = [];
  let cursor;
  do {
    const res = await withNotionRetry(() => notion.databases.query({
      database_id, filter, sorts,
      ...(cursor ? { start_cursor: cursor } : {}),
      page_size: 100,
    }));
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

// Notion's API is limited to ~3 requests/second. A bare Promise.all over a large
// list (e.g. every Issued submission needing its own drawing lookup) fires everything
// at once and trips that limit — Notion returns 429s that this codebase doesn't retry,
// so they surface as unhandled rejections → 500s. This runs `fn` over `items` with only
// `limit` in flight at a time, so any one status-group request stays under the rate limit
// even when the group has 50+ rows.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function getProp(page, name, type) {
  const prop = page.properties?.[name];
  if (!prop) return null;
  switch (type) {
    case "title":     return prop.title?.[0]?.plain_text ?? null;
    case "rich_text": return prop.rich_text?.[0]?.plain_text ?? null;
    case "select":    return prop.select?.name ?? null;
    case "status":    return prop.status?.name ?? null;
    case "number":    return prop.number ?? null;
    case "date":      return prop.date?.start ?? null;
    case "checkbox":  return prop.checkbox ?? false;
    case "email":     return prop.email ?? null;
    case "url":       return prop.url ?? null;
    case "relation":  return prop.relation?.map((r) => r.id) ?? [];
    case "rollup":    return prop.rollup ?? null;
    case "formula": {
      const f = prop.formula;
      if (!f) return null;
      if (f.type === "string")  return f.string  ?? null;
      if (f.type === "number")  return f.number  ?? null;
      if (f.type === "boolean") return f.boolean ?? null;
      if (f.type === "date")    return f.date?.start ?? null;
      return null;
    }
    default: return null;
  }
}

function now() {
  return new Date().toISOString().slice(0, 10);
}

// --- Notion lookups ---

async function findTask(notion, projectNo, itemNo) {
  // "Item No." is a formula property — cannot be used as a query filter.
  // Search for "Suffix NNN" to avoid false matches (e.g. "CLG-111" would match a search for "111").
  const paddedItemNo = itemNo.padStart(3, "0");
  const res = await notion.databases.query({
    database_id: TASKS_DB,
    filter: { property: "Item Name", title: { contains: `Suffix ${paddedItemNo}` } },
    page_size: 50,
  });
  if (!res.results.length) return null;

  const byFormula = res.results.filter(
    (page) => getProp(page, "Item No.", "formula") === paddedItemNo
  );
  const candidates = byFormula.length ? byFormula : res.results;
  if (candidates.length === 1) return candidates[0];

  for (const page of candidates) {
    const roll  = getProp(page, "Projects", "rollup");
    const names = roll?.array?.map((r) => r.rich_text?.[0]?.plain_text) ?? [];
    if (names.some((n) => n?.includes(projectNo))) return page;
  }
  return candidates[0] ?? null;
}

async function findDrawing(notion, drawingNo, taskPageId) {
  // First try: match by drawing number AND task relation (precise)
  const res1 = await notion.databases.query({
    database_id: DRAWINGS_DB,
    filter: {
      and: [
        { property: "Drawing Number", title:    { contains: drawingNo  } },
        { property: "Item",           relation: { contains: taskPageId } },
      ],
    },
    page_size: 10,
  });
  if (res1.results.length) return res1.results[0];

  // Fallback: drawing number only (relation filter may fail if task ID mismatch)
  const res2 = await notion.databases.query({
    database_id: DRAWINGS_DB,
    filter: { property: "Drawing Number", title: { contains: drawingNo } },
    page_size: 10,
  });
  return res2.results[0] ?? null;
}

async function findDT(notion, initials) {
  // No Initials property — derive from Name (first letter of each word, e.g. "Greig Fensome" → "GF").
  const res = await notion.databases.query({ database_id: TEAM_DB, page_size: 50 });
  const target = initials.toUpperCase();
  return res.results.find((page) => {
    const name = getProp(page, "Name", "title") ?? "";
    const derived = name.trim().split(/\s+/).map((w) => w[0] ?? "").join("").toUpperCase();
    return derived === target;
  }) ?? null;
}

// Returns the most recent submission for this drawing+stage regardless of status.
// Used in ingest to determine the current QA round and whether a supersede is needed.
async function findLatestSubmission(notion, drawingPageId, stage) {
  const res = await notion.databases.query({
    database_id: SUBMISSIONS_DB,
    filter: {
      and: [
        { property: "Drawing", relation: { contains: drawingPageId } },
        { property: "Stage",   select:   { equals: stage }          },
      ],
    },
    sorts: [{ property: "QA Round", direction: "descending" }],
    page_size: 1,
  });
  return res.results[0] ?? null;
}

// Resolve DT name and email from the Team DB.
async function resolveDT(notion, dtIds) {
  if (!dtIds?.length) return { name: null, email: null };
  try {
    const dtPage = await withNotionRetry(() => notion.pages.retrieve({ page_id: dtIds[0] }));
    return {
      name:  getProp(dtPage, "Name",  "title"),
      email: getProp(dtPage, "Email", "email") ?? getProp(dtPage, "Email", "rich_text"),
    };
  } catch { return { name: null, email: null }; }
}

// Convenience wrapper for the submissions list endpoint.
async function resolveDTName(notion, dtIds) {
  return (await resolveDT(notion, dtIds)).name;
}

// Request-scoped DT resolver — dedupes concurrent lookups for the same DT id so a
// status list with many submissions from the same handful of DTs only hits Notion
// once per unique DT, not once per submission. Cuts Notion API load substantially
// on endpoints that map an array of pages in parallel (Promise.all).
function makeDTResolver(notion) {
  const cache = new Map(); // dtId -> Promise<{ name, email }>
  return function resolveCached(dtIds) {
    const id = dtIds?.[0];
    if (!id) return Promise.resolve({ name: null, email: null });
    if (!cache.has(id)) cache.set(id, resolveDT(notion, [id]));
    return cache.get(id);
  };
}

// POST to a Make.com webhook URL. Never throws (logged on error) — callers don't need
// try/catch — but IS awaited by every call site. This must not be true fire-and-forget:
// Netlify freezes the Lambda's execution environment the instant res.json() is sent, which
// kills any still-in-flight promise that wasn't awaited first. An un-awaited webhook call
// here would race the response and frequently get cut off mid-request, silently dropping
// the trigger to Make. (This was confirmed as the cause of "Scan Comments" intermittently
// not triggering — the request usually didn't get a chance to leave before the function froze.)
async function fireWebhook(url, payload) {
  if (!url) return;
  try {
    const r = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    if (!r.ok) console.warn(`[make] Webhook returned ${r.status} — ${url}`);
  } catch (err) {
    console.warn(`[make] Webhook POST failed:`, err.message);
  }
}

// --- Activity Log helper ---

// Writes one entry to the Item Activity Log DB. Never throws — errors are logged and
// swallowed so a logging failure can never break the calling submission endpoint.
// IMPORTANT: still call this with `await`, same as fireWebhook above. Netlify freezes the
// Lambda the instant res.json() is sent, so an un-awaited "fire and forget" call here would
// frequently get cut off mid-write before it reaches Notion, silently dropping the entry.
async function createActivityLogEntry(notion, { taskId, source, tag, author, entry, detail, link }) {
  if (!ACTIVITY_LOG_DB) {
    console.warn("[activity-log] NOTION_DB_ACTIVITY_LOG not configured — skipping entry:", entry);
    return;
  }
  try {
    const properties = {
      "Entry":  { title:    [{ text: { content: entry } }] },
      "Source": { select:   { name: source } },
      "Tag":    { select:   { name: tag } },
      "Author": { rich_text: [{ text: { content: author || "System" } }] },
    };
    if (taskId) properties["Task"]   = { relation: [{ id: taskId }] };
    if (detail) properties["Detail"] = { rich_text: [{ text: { content: detail } }] };
    if (link)   properties["Link"]   = { url: link };

    await notion.pages.create({ parent: { database_id: ACTIVITY_LOG_DB }, properties });
  } catch (err) {
    console.warn("[activity-log] write failed:", err.message);
  }
}

// --- Inputs helpers ---

function extractInputsFromPage(page) {
  const out = { id: page.id };
  for (const { key, prop, type } of INPUTS_FIELDS) out[key] = getProp(page, prop, type);
  return out;
}

function buildInputsProps(data) {
  const props = {};
  for (const { key, prop, type } of INPUTS_FIELDS) {
    if (data[key] === undefined) continue;
    const v = data[key];
    if (v === null) {
      if (type === "number") props[prop] = { number: null };
      else if (type === "date") props[prop] = { date: null };
    } else {
      if (type === "number") props[prop] = { number: Number(v) };
      else if (type === "date") props[prop] = { date: { start: v } };
    }
  }
  return props;
}

async function findInputsRow(notion, projectId, taskId) {
  const db = INPUTS_DB();
  if (!db) throw new Error("NOTION_DB_INPUTS not set");
  const filter = taskId
    ? { and: [{ property: "Task",    relation: { contains: taskId    } }, { property: "Scope", select: { equals: "Task"    } }] }
    : { and: [{ property: "Project", relation: { contains: projectId } }, { property: "Scope", select: { equals: "Project" } }] };
  const res = await notion.databases.query({ database_id: db, filter, page_size: 1 });
  return res.results[0] ?? null;
}

// --- Route factory ---

module.exports = function mountDrawingFlow(app, notion) {

  // POST /api/df/ingest
  // Triggered by Make Scenario 1: Make watches Dropbox /Pending/ and calls this endpoint.

  app.post("/api/df/ingest", async (req, res) => {
    const { filePath, dropboxLink, dropboxPath, shareLink } = req.body;
    if (!filePath) return res.status(400).json({ ok: false, error: "Missing filePath" });

    const pathParts = parsePath(filePath);
    if (!pathParts) return res.status(400).json({ ok: false, error: "Path does not match protocol", received: filePath });
    const { projectNo, stage, filename } = pathParts;

    const fileParts = parseFilename(filename);
    if (!fileParts) return res.status(400).json({ ok: false, error: "Filename does not match convention", received: filename });
    const { itemNo, drawingNo, revision, dtInitials } = fileParts;

    console.log(`[ingest] ${projectNo}/${stage}/${filename}`);

    let taskPage, drawingPage, dtPage;

    try { taskPage = await findTask(notion, projectNo, itemNo); }
    catch (err) { return res.status(500).json({ ok: false, error: "Task lookup failed", detail: err.message }); }
    if (!taskPage) return res.status(422).json({ ok: false, error: "Task not found", detail: `No Task for item "${itemNo}" in ${projectNo}` });

    try { drawingPage = await findDrawing(notion, drawingNo, taskPage.id); }
    catch (err) { return res.status(500).json({ ok: false, error: "Drawing lookup failed", detail: err.message }); }
    if (!drawingPage) return res.status(422).json({ ok: false, error: "Drawing not found in MDS", detail: `No MDS row for "${drawingNo}"` });

    try { dtPage = await findDT(notion, dtInitials); }
    catch (err) { console.warn(`[ingest] DT lookup failed for "${dtInitials}":`, err.message); }

    let qaRound = 1;
    try {
      const prev = await findLatestSubmission(notion, drawingPage.id, stage);
      if (prev) {
        qaRound = (getProp(prev, "QA Round", "number") ?? 1) + 1;
        // Only supersede a still-open submission — a Rejected one is already closed
        const prevStatus = getProp(prev, "Status", "select");
        if (prevStatus === "Submitted") {
          notion.pages.update({ page_id: prev.id, properties: { "Status": { select: { name: "Rejected" } } } })
            .catch((e) => console.warn("[ingest] Supersede failed:", e.message));
        }
      }
    } catch (err) { console.warn("[ingest] Resubmission check:", err.message); }

    const submissionTitle = `${projectNo}-${itemNo.padStart(3, "0")}_${drawingNo}_${stage}_R${qaRound}`;

    const submissionProps = {
      "Submission":    { title:    [{ text: { content: submissionTitle } }] },
      "Drawing":       { relation: [{ id: drawingPage.id }] },
      "Item":          { relation: [{ id: taskPage.id    }] },
      "Stage":         { select:   { name: stage         } },
      "Revision":      { select:   { name: revision      } },
      "QA Round":      { number:   qaRound                 },
      "Status":        { select:   { name: "Submitted"   } },
      "Submitted":     { date:     { start: now()         } },
      "Ball In Court": { select:   { name: BIC.SUBMITTED  } },
      "BIC Since":     { date:     { start: now()         } },
    };
    if (dropboxPath || filePath) {
      // Strip DROPBOX_ROOT prefix — stored path is relative to Drawing Submissions for tidiness.
      // Case-insensitive comparison since path_lower from Make will be lowercase.
      const fullRaw = dropboxPath ?? filePath;
      const shortPath = fullRaw.toLowerCase().startsWith(DROPBOX_ROOT.toLowerCase())
        ? fullRaw.slice(DROPBOX_ROOT.length).replace(/^\//, "")
        : fullRaw;
      submissionProps["Dropbox Path"] = { url: shortPath };
    }
    if (dtPage) submissionProps["DT"] = { relation: [{ id: dtPage.id }] };
    if (shareLink) submissionProps["Share Link"] = { url: shareLink };

    let newSubmission;
    try {
      newSubmission = await notion.pages.create({ parent: { database_id: SUBMISSIONS_DB }, properties: submissionProps });
    } catch (err) {
      return res.status(500).json({ ok: false, error: "Failed to create Submission", detail: err.message });
    }

    try {
      const mdsProps = {
        "Drawing Status":   { select: { name: "DM Review"        } },
        "Submission Stage": { select: { name: STAGE_LABEL[stage]  } },
        "Rev":              { select: { name: revision            } },
      };
      // Populate Dwg No. Assigned if empty — infer from drawing number pattern
      if (!getProp(drawingPage, "Dwg No. Assigned", "select")) {
        const inferred = inferDwgType(drawingNo);
        if (inferred) mdsProps["Dwg No. Assigned"] = { select: { name: inferred } };
      }
      await notion.pages.update({ page_id: drawingPage.id, properties: mdsProps });
    } catch (err) { console.warn("[ingest] MDS update failed:", err.message); }

    const dtName = dtPage ? (getProp(dtPage, "Name", "title") ?? dtInitials) : dtInitials;
    await createActivityLogEntry(notion, {
      taskId: taskPage.id,
      source: "Drawing Flow",
      tag:    "#info",
      author: dtName || "System",
      entry:  `Drawing ${drawingNo} Rev ${revision} submitted by ${dtName}. (QA Round ${qaRound})`,
    });

    console.log(`[ingest] created ${submissionTitle} (${newSubmission.id})`);
    return res.json({ ok: true, submissionId: newSubmission.id, submissionTitle, qaRound, isResubmission: qaRound > 1 });
  });

  // GET /api/df/queue
  // Returns all cockpit queues in a single request, with sequential Notion calls
  // to avoid hitting the ~3 req/s rate limit when multiple Lambda invocations run in parallel.

  app.get("/api/df/queue", async (req, res) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    try {
      // ── 1. Fetch all status groups with 200ms gaps (sequential, one Notion call each) ──
      const STATUSES = ["Submitted", "Rejected", "Approved", "Awaiting Issue", "Issued", "Graded"];
      const rawByStatus = {};
      for (const s of STATUSES) {
        rawByStatus[s] = await queryAll(notion, SUBMISSIONS_DB,
          { property: "Status", select: { equals: s } },
          [{ property: "BIC Since", direction: "ascending" }]
        );
        await sleep(200);
      }

      // ── 2. Pending-notification: 4 filter queries with 200ms gaps ──
      const FOLDER_STATUSES  = ["Approved", "Rejected"];
      const INSTANT_STATUSES = ["Issued",   "Graded"];
      const pendingRaw = [];
      for (const s of [...FOLDER_STATUSES, ...INSTANT_STATUSES]) {
        const pages = await queryAll(notion, SUBMISSIONS_DB, {
          and: [
            { property: "Status",      select:   { equals: s     } },
            { property: "DT Notified", checkbox: { equals: false } },
          ]
        }, [{ property: "BIC Since", direction: "ascending" }]);
        pendingRaw.push(...pages);
        await sleep(200);
      }

      // ── 3. Resolve all unique DT IDs in one pass (a handful of people, not per-submission) ──
      const allPages = [...Object.values(rawByStatus).flat(), ...pendingRaw];
      const dtIdSet  = new Set();
      for (const p of allPages) {
        const ids = getProp(p, "DT", "relation") || [];
        if (ids[0]) dtIdSet.add(ids[0]);
      }
      const dtCache = {}; // dtId → { name, email }
      for (const dtId of dtIdSet) {
        dtCache[dtId] = await resolveDT(notion, [dtId]);
        await sleep(100);
      }
      const getDT     = (dtIds) => dtCache[dtIds?.[0]] ?? { name: null, email: null };
      const getDTName = (dtIds) => getDT(dtIds).name;

      // ── 4. Map raw pages → submission objects ──
      const mapSub = (page, { hasComments = false } = {}) => {
        const title  = getProp(page, "Submission", "title");
        const stage  = getProp(page, "Stage",      "select");
        const dtIds  = getProp(page, "DT",         "relation");
        const { taskCode, drawingNo } = parseSubmissionTitle(title, stage);
        return {
          id: page.id, title, taskCode, drawingNo, stage,
          dtName:      getDTName(dtIds),
          revision:    getProp(page, "Revision",      "select"),
          qaRound:     getProp(page, "QA Round",      "number"),
          status:      getProp(page, "Status",        "select"),
          bic:         getProp(page, "Ball In Court", "select"),
          bicSince:    getProp(page, "BIC Since",     "date"),
          submitted:   getProp(page, "Submitted",     "date"),
          reviewed:    getProp(page, "Reviewed",      "date"),
          dropboxPath: getProp(page, "Dropbox Path",  "url"),
          shareLink:   getProp(page, "Share Link",    "url"),
          drawingIds:  getProp(page, "Drawing",       "relation"),
          taskIds:     getProp(page, "Item",          "relation"),
          blocked:     getProp(page, "Blocked",       "checkbox") ?? false,
          clientGrade: getProp(page, "Client Grade",  "select"),
          dtNotified:  getProp(page, "DT Notified",   "checkbox") ?? false,
          hasComments,
        };
      };

      // For issued submissions, check comment files on the related MDS drawing
      const issuedMapped = [];
      for (const page of rawByStatus["Issued"]) {
        let hasComments = false;
        const drawingIds = getProp(page, "Drawing", "relation");
        if (drawingIds?.length) {
          try {
            const dwg = await notion.pages.retrieve({ page_id: drawingIds[0] });
            const stage = getProp(page, "Stage", "select");
            hasComments = !!getProp(dwg, `${stage} Comment Files`, "rich_text");
          } catch { /* ignore */ }
          await sleep(100);
        }
        issuedMapped.push(mapSub(page, { hasComments }));
      }

      // Map pending-notification pages
      const folderGated = pendingRaw.filter((page) => {
        const status = getProp(page, "Status", "select");
        if (FOLDER_STATUSES.includes(status)) return !!getProp(page, "Folder Link", "url");
        return true;
      });
      const pending = folderGated.map((page) => {
        const dtIds      = getProp(page, "DT",         "relation");
        const title      = getProp(page, "Submission", "title");
        const stage      = getProp(page, "Stage",      "select");
        const { taskCode, drawingNo } = parseSubmissionTitle(title, stage);
        const rawPath    = getProp(page, "Dropbox Path", "url");
        const folderLink = getProp(page, "Folder Link",  "url");
        const folderPath = rawPath ? toFullDropboxPath(rawPath).split("/").slice(0, -1).join("/") : null;
        const folderSegs = folderPath ? folderPath.split("/").filter(Boolean) : [];
        return {
          id: page.id, title, taskCode, drawingNo, stage,
          dtName:    getDTName(dtIds),
          dtEmail:   getDT(dtIds).email,
          status:    getProp(page, "Status",     "select"),
          dmAction:  getProp(page, "DM Action",  "select"),
          revision:  getProp(page, "Revision",   "select"),
          qaRound:   getProp(page, "QA Round",   "number"),
          grade:     getProp(page, "Client Grade","select"),
          bicSince:  getProp(page, "BIC Since",  "date"),
          reviewed:  getProp(page, "Reviewed",   "date"),
          folderPath, folderLink,
          folderName: folderSegs.slice(-1).join("") || null,
        };
      });

      res.json({
        submitted:     rawByStatus["Submitted"].map(mapSub),
        rejected:      rawByStatus["Rejected"].map(mapSub),
        approved:      rawByStatus["Approved"].map(mapSub),
        awaitingIssue: rawByStatus["Awaiting Issue"].map(mapSub),
        issued:        issuedMapped,
        graded:        rawByStatus["Graded"].map(mapSub),
        pending,
      });
    } catch (err) {
      console.error("[queue]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/df/submissions
  // ?status=Submitted|Approved|Awaiting Issue|Issued|Rejected|Graded
  // ?status=pending-notification  → actioned items where DT Notified = false

  app.get("/api/df/submissions", async (req, res) => {
    const statusFilter = req.query.status || "Submitted";

    // ── pending-notification filter ────────────────────────────────────────
    // Returns actioned submissions (DT Notified = false) ready for the batch email.
    //
    // Gating logic:
    //   Approved / Rejected  → only shown once Make has written Folder Link back via
    //                          PATCH /api/df/submissions/:id/folder-link. This ensures
    //                          the Suffix/Rejected folder is live before the DM can send.
    //   Issued / Graded      → no folder involved, shown immediately (DT Notified = false).
    if (statusFilter === "pending-notification") {
      try {
        // Approved + Rejected: gate on Folder Link being populated
        const FOLDER_STATUSES  = ["Approved", "Rejected"];
        // Issued + Graded: no folder, show immediately
        const INSTANT_STATUSES = ["Issued", "Graded"];

        const [folderResults, instantResults] = await Promise.all([
          Promise.all(FOLDER_STATUSES.map((s) =>
            // Note: Notion API does not support is_not_empty filter on URL properties.
            // Fetch all with DT Notified=false and filter client-side for Folder Link presence.
            queryAll(notion, SUBMISSIONS_DB, {
              and: [
                { property: "Status",      select:   { equals: s     } },
                { property: "DT Notified", checkbox: { equals: false } },
              ]
            }, [{ property: "BIC Since", direction: "ascending" }])
          )).then((r) => r.flat()
            .filter((page) => !!getProp(page, "Folder Link", "url"))  // gate: Folder Link must be populated
          ),
          Promise.all(INSTANT_STATUSES.map((s) =>
            queryAll(notion, SUBMISSIONS_DB, {
              and: [
                { property: "Status",      select:   { equals: s     } },
                { property: "DT Notified", checkbox: { equals: false } },
              ]
            }, [{ property: "BIC Since", direction: "ascending" }])
          )).then((r) => r.flat()),
        ]);

        const results = [...folderResults, ...instantResults];

        // Dedupe DT lookups — a handful of DTs may own many of these submissions.
        const resolveCached = makeDTResolver(notion);

        const submissions = await Promise.all(results.map(async (page) => {
          const title    = getProp(page, "Submission", "title");
          const stage    = getProp(page, "Stage",      "select");
          const dtIds    = getProp(page, "DT",         "relation");
          const status   = getProp(page, "Status",     "select");
          const dmAction = getProp(page, "DM Action",  "select");
          const { taskCode, drawingNo } = parseSubmissionTitle(title, stage);
          const dt       = await resolveCached(dtIds);
          const dtName   = dt.name;
          const rawPath  = getProp(page, "Dropbox Path", "url");
          const folderLink = getProp(page, "Folder Link", "url");
          const folderPath = rawPath
            ? toFullDropboxPath(rawPath).split("/").slice(0, -1).join("/")
            : null;
          const folderSegs = folderPath ? folderPath.split("/").filter(Boolean) : [];
          const folderName = folderSegs.slice(-1).join("") || null;
          return {
            id: page.id, title, taskCode, drawingNo, dtName, dtEmail: dt.email, stage,
            status, dmAction,
            revision:    getProp(page, "Revision",     "select"),
            qaRound:     getProp(page, "QA Round",     "number"),
            grade:       getProp(page, "Client Grade", "select"),
            bicSince:    getProp(page, "BIC Since",    "date"),
            reviewed:    getProp(page, "Reviewed",     "date"),
            folderPath,
            folderName,
            folderLink,
          };
        }));

        return res.json({ submissions });
      } catch (err) {
        console.error("GET /api/df/submissions pending-notification", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── standard status filter ─────────────────────────────────────────────
    const validStatuses = ["Submitted", "Approved", "Awaiting Issue", "Issued", "Rejected", "Graded"];
    if (!validStatuses.includes(statusFilter)) return res.status(400).json({ error: `Invalid status: ${statusFilter}` });

    try {
      const results = await queryAll(notion, SUBMISSIONS_DB,
        { property: "Status", select: { equals: statusFilter } },
        [{ property: "BIC Since", direction: "ascending" }]
      );

      // Dedupe DT + drawing lookups across this status group — several submissions
      // can share the same DT or the same MDS drawing (multiple stages/revisions).
      const resolveCached = makeDTResolver(notion);
      const drawingCache  = new Map(); // drawingId -> Promise<page>
      const getDrawing = (id) => {
        if (!drawingCache.has(id)) drawingCache.set(id, withNotionRetry(() => notion.pages.retrieve({ page_id: id })));
        return drawingCache.get(id);
      };

      const submissions = await mapWithConcurrency(results, 4, async (page) => {
        const title = getProp(page, "Submission", "title");
        const stage = getProp(page, "Stage",      "select");
        const dtIds = getProp(page, "DT",         "relation");
        const { taskCode, drawingNo } = parseSubmissionTitle(title, stage);
        const dtName = (await resolveCached(dtIds)).name;

        // For the Issued queue, surface whether client comments have been ingested
        // onto the related MDS drawing for this stage (drives the cockpit comment badge).
        // Fast path: cr-ingest now flips Ball In Court -> "DM" on the submission itself
        // when a comment lands, so most rows can skip the extra drawing lookup entirely.
        let hasComments = getProp(page, "Ball In Court", "select") === "DM" && statusFilter === "Issued";
        if (statusFilter === "Issued" && !hasComments) {
          const drawingIds = getProp(page, "Drawing", "relation");
          if (drawingIds?.length) {
            try {
              const dwg = await getDrawing(drawingIds[0]);
              hasComments = !!getProp(dwg, `${stage} Comment Files`, "rich_text");
            } catch { /* drawing fetch failed — leave hasComments false */ }
          }
        }

        return {
          id: page.id, title, taskCode, drawingNo, dtName, stage,
          revision:    getProp(page, "Revision",     "select"),
          qaRound:     getProp(page, "QA Round",     "number"),
          status:      getProp(page, "Status",       "select"),
          bic:         getProp(page, "Ball In Court","select"),
          bicSince:    getProp(page, "BIC Since",    "date"),
          submitted:   getProp(page, "Submitted",    "date"),
          reviewed:    getProp(page, "Reviewed",     "date"),
          dropboxPath: getProp(page, "Dropbox Path", "url"),
          shareLink:   getProp(page, "Share Link",   "url"),
          drawingIds:  getProp(page, "Drawing",      "relation"),
          taskIds:     getProp(page, "Item",         "relation"),
          blocked:     getProp(page, "Blocked",      "checkbox") ?? false,
          clientGrade: getProp(page, "Client Grade", "select"),
          dtNotified:  getProp(page, "DT Notified",  "checkbox") ?? false,
          hasComments,
        };
      });

      res.json({ submissions });
    } catch (err) {
      console.error("GET /api/df/submissions", err);
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/df/submissions/:id/folder-link
  // Called by Make after it creates a Dropbox shared link for the Suffix/Rejected folder.
  // Writes the URL to Folder Link on this submission AND all siblings in the same folder
  // (same task + stage + DM action) so all drawings in a Suffix appear together in the
  // pending-notification queue once the folder is confirmed live.

  app.patch("/api/df/submissions/:id/folder-link", async (req, res) => {
    const { id } = req.params;
    const { folderLink } = req.body || {};
    if (!folderLink) return res.status(400).json({ ok: false, error: "Missing folderLink in body" });

    let submissionPage;
    try { submissionPage = await notion.pages.retrieve({ page_id: id }); }
    catch { return res.status(404).json({ ok: false, error: "Submission not found" }); }

    const stage    = getProp(submissionPage, "Stage",    "select");
    const dmAction = getProp(submissionPage, "DM Action","select");
    const taskIds  = getProp(submissionPage, "Item",     "relation");

    // Write to this submission first
    try {
      await notion.pages.update({ page_id: id, properties: {
        "Folder Link": { url: folderLink },
      }});
    } catch (err) {
      return res.status(500).json({ ok: false, error: "Notion update failed", detail: err.message });
    }

    // Write to all siblings in the same Suffix folder:
    // same task relation + same stage + same DM action + DT Notified = false
    let siblingsUpdated = 0;
    if (taskIds?.length) {
      try {
        const siblings = await queryAll(notion, SUBMISSIONS_DB, {
          and: [
            { property: "Item",        relation: { contains: taskIds[0] } },
            { property: "Stage",       select:   { equals: stage        } },
            { property: "DM Action",   select:   { equals: dmAction     } },
            { property: "DT Notified", checkbox: { equals: false        } },
          ]
        });
        const others = siblings.filter((p) => p.id !== id);
        await Promise.all(others.map((p) =>
          notion.pages.update({ page_id: p.id, properties: {
            "Folder Link": { url: folderLink },
          }}).catch((e) => console.warn(`[folder-link] sibling update failed ${p.id}:`, e.message))
        ));
        siblingsUpdated = others.length;
      } catch (err) {
        console.warn("[folder-link] sibling lookup failed:", err.message);
      }
    }

    console.log(`[folder-link] ${id} + ${siblingsUpdated} sibling(s) → ${folderLink}`);
    res.json({ ok: true, siblingsUpdated });
  });

  // POST /api/df/send-dt-emails
  // Groups all pending-notification submissions by DT, fires one webhook per DT
  // with the full list, then marks each submission DT Notified = true in Notion.

  app.post("/api/df/send-dt-emails", async (req, res) => {
    try {
      const NOTIFIABLE_STATUSES = ["Approved", "Rejected", "Issued", "Graded"];
      const results = (await Promise.all(
        NOTIFIABLE_STATUSES.map((s) =>
          queryAll(notion, SUBMISSIONS_DB, {
            and: [
              { property: "Status",       select:   { equals: s     } },
              { property: "DT Notified",  checkbox: { equals: false } },
            ]
          })
        )
      )).flat();

      if (!results.length) {
        return res.json({ ok: true, emailsSent: 0, submissionsNotified: 0, message: "Nothing pending" });
      }

      // Resolve DT info + build per-submission data
      const enriched = await Promise.all(results.map(async (page) => {
        const title    = getProp(page, "Submission", "title");
        const stage    = getProp(page, "Stage",      "select");
        const status   = getProp(page, "Status",     "select");
        const dmAction = getProp(page, "DM Action",  "select");
        const dtIds    = getProp(page, "DT",         "relation");
        const rawPath  = getProp(page, "Dropbox Path", "url");
        const folderLink = getProp(page, "Folder Link", "url");
        const { drawingNo } = parseSubmissionTitle(title, stage);
        const dt = await resolveDT(notion, dtIds);

        // Derive folder path and name
        const fullPath   = toFullDropboxPath(rawPath);
        const folderPath = fullPath ? fullPath.split("/").slice(0, -1).join("/") : null;
        const folderSegs = folderPath ? folderPath.split("/").filter(Boolean) : [];
        const folderName = folderSegs.slice(-1)[0] || null;

        // Human-readable action label
        const actionLabel = (() => {
          if (dmAction === "Bounce")     return "Bounced — returned for revision";
          if (dmAction === "Approve")    return status === "Issued" ? "Issued to client" : "QA Approved";
          if (dmAction === "Log Status") return `Grade: ${getProp(page, "Client Grade", "select") ?? "—"}`;
          return dmAction ?? status;
        })();

        return {
          pageId:    page.id,
          dtName:    dt.name,
          dtEmail:   dt.email,
          folderPath,
          folderName,
          folderLink,  // real Dropbox shared link written back by Make
          drawingNo,
          stage,
          status,
          dmAction,
          actionLabel,
          qaRound:   getProp(page, "QA Round",     "number"),
          grade:     getProp(page, "Client Grade", "select"),
          reviewed:  getProp(page, "Reviewed",     "date"),
        };
      }));

      // Group by DT → then by folder within each DT
      // Structure: byDT[dtEmail] = { dtName, dtEmail, folders: { folderKey: { folderName, folderLink, drawings[] } }, pageIds[] }
      const byDT = {};
      for (const item of enriched) {
        const dtKey = item.dtEmail || item.dtName || "unknown";
        if (!byDT[dtKey]) byDT[dtKey] = { dtName: item.dtName, dtEmail: item.dtEmail, folders: {}, pageIds: [] };

        // Folder key: use folderPath if available, else a per-action fallback key
        const folderKey = item.folderPath || `_no_folder_${item.dmAction}_${item.stage}`;
        if (!byDT[dtKey].folders[folderKey]) {
          byDT[dtKey].folders[folderKey] = {
            folderName:  item.folderName || null,
            folderLink:  item.folderLink || null,
            drawings:    [],
          };
        }
        byDT[dtKey].folders[folderKey].drawings.push({
          drawingNo:    item.drawingNo,
          stage:        item.stage,
          actionLabel:  item.actionLabel,
          qaRound:      item.qaRound,
          grade:        item.grade,
        });
        byDT[dtKey].pageIds.push(item.pageId);
      }

      // Build the folders array for each DT group, with pre-rendered folderHtml
      // and a drawingsHtml block listing all drawings under that folder.
      // All HTML is built here — the Text Aggregator receives a single folderBlockHtml token.
      for (const group of Object.values(byDT)) {
        group.folderBlocks = Object.values(group.folders).map((folder) => {
          const linkHtml = folder.folderLink
            ? `<a href="${folder.folderLink}" style="color:#4f7fff;font-weight:600;">${folder.folderName || "Open folder"}</a>`
            : folder.folderName
              ? `<strong>${folder.folderName}</strong>`
              : "<em>No folder</em>";

          const drawingRows = folder.drawings.map((d) =>
            `<tr>
              <td style="padding:4px 8px;color:#333;">${d.drawingNo || "—"}</td>
              <td style="padding:4px 8px;color:#555;">${d.stage}</td>
              <td style="padding:4px 8px;color:#555;">${d.actionLabel}</td>
            </tr>`
          ).join("");

          // Instruction row — derive from the first drawing's actionLabel (all drawings in a folder share the same action)
          const firstAction = folder.drawings[0]?.actionLabel ?? "";
          const instruction = firstAction === "QA Approved"
            ? "Upload dwg's to the Item folder link"
            : firstAction.startsWith("Bounced")
              ? "Commented drawings are in the Item folder link. Revise drawings to comments and re-upload PDF's to the 'Pending' folder for further review."
              : null;
          const instructionRow = instruction
            ? `<tr><td colspan="3" style="padding:4px 8px 10px;font-size:12px;color:#888;font-style:italic;">${instruction}</td></tr>`
            : "";

          return {
            folderHtml: linkHtml,
            drawingsHtml: drawingRows + instructionRow,
            drawingCount: folder.drawings.length,
          };
        });
      }

      // Fire one webhook per DT — awaited so we can log Make's response status
      let emailsSent = 0;
      const webhookResults = [];
      const webhookUrl = process.env.MAKE_ACTIONS_WEBHOOK;

      console.log(`[send-dt-emails] Webhook URL: ${webhookUrl ? webhookUrl.slice(0, 60) + "…" : "NOT SET"}`);
      console.log(`[send-dt-emails] DT groups: ${Object.keys(byDT).join(", ") || "none"}`);

      for (const group of Object.values(byDT)) {
        if (!group.dtEmail) {
          console.warn(`[send-dt-emails] Skipping DT "${group.dtName}" — no email address resolved`);
          webhookResults.push({ dtName: group.dtName, skipped: true, reason: "no email" });
          continue;
        }
        // Total drawing count across all folder groups for this DT
        const totalCount = group.folderBlocks.reduce((n, b) => n + b.drawingCount, 0);
        const payload = {
          action:       "dt-summary",
          dtName:       group.dtName,
          dtEmail:      group.dtEmail,
          folderBlocks: group.folderBlocks,  // array of { folderHtml, drawingsHtml, drawingCount }
          count:        totalCount,
        };
        console.log(`[send-dt-emails] Firing webhook → ${group.dtEmail} (${group.pageIds.length} submission(s))`);
        try {
          const r = await fetch(webhookUrl, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(payload),
          });
          const responseText = await r.text().catch(() => "");
          console.log(`[send-dt-emails] Make response: ${r.status} — "${responseText}"`);
          webhookResults.push({ dtEmail: group.dtEmail, status: r.status, response: responseText, ok: r.ok });
          if (r.ok) emailsSent++;
        } catch (err) {
          console.error(`[send-dt-emails] Webhook POST failed for ${group.dtEmail}:`, err.message);
          webhookResults.push({ dtEmail: group.dtEmail, error: err.message });
        }
      }

      // Mark all included submissions as DT Notified = true
      const allPageIds = Object.values(byDT).flatMap((g) => g.pageIds);
      await Promise.all(allPageIds.map((pid) =>
        notion.pages.update({ page_id: pid, properties: {
          "DT Notified": { checkbox: true },
        }}).catch((e) => console.warn(`[send-dt-emails] Notion update failed ${pid}:`, e.message))
      ));

      console.log(`[send-dt-emails] Done — ${emailsSent} webhook(s) accepted, ${allPageIds.length} submission(s) marked notified`);
      res.json({ ok: true, emailsSent, submissionsNotified: allPageIds.length, webhookResults });
    } catch (err) {
      console.error("[send-dt-emails]", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/df/send-grade-emails
  // Groups all Graded + DT Notified=false submissions by DT, fires one grade-summary
  // webhook per DT, then sets BIC→DT and DT Notified=true on each submission.

  app.post("/api/df/send-grade-emails", async (req, res) => {
    try {
      const results = await queryAll(notion, SUBMISSIONS_DB, {
        and: [
          { property: "Status",      select:   { equals: "Graded" } },
          { property: "DT Notified", checkbox: { equals: false    } },
        ],
      });

      if (!results.length) {
        return res.json({ ok: true, emailsSent: 0, submissionsNotified: 0, message: "Nothing pending" });
      }

      const enriched = await Promise.all(results.map(async (page) => {
        const title      = getProp(page, "Submission",   "title");
        const stage      = getProp(page, "Stage",        "select");
        const grade      = getProp(page, "Client Grade", "select") ?? "—";
        const revision   = getProp(page, "Revision",     "select") ?? "";
        const reviewed   = getProp(page, "Reviewed",     "date");
        const dtIds      = getProp(page, "DT",           "relation");
        const drawingIds = getProp(page, "Drawing",      "relation");
        const rawPath    = getProp(page, "Dropbox Path", "url");

        const { drawingNo } = parseSubmissionTitle(title, stage);
        const dt = await resolveDT(notion, dtIds);

        // Derive Grade Returns folder path from submission's Dropbox path
        // path: /Drawing Submissions/{project}/{stage}/Pending/{file}
        // Grade Returns: /Drawing Submissions/{project}/{stage}/Grade Returns/
        let gradeReturnsPath = null;
        if (rawPath) {
          const full   = toFullDropboxPath(rawPath);
          const segs   = full ? full.split("/").filter(Boolean) : [];
          // segs: ["Drawing Submissions", project, stage, "Pending", file]
          const stageIdx = segs.findIndex((s) => ["S3","S4","S5","A4.5","AB"].includes(s.toUpperCase()));
          if (stageIdx !== -1) {
            gradeReturnsPath = "/" + segs.slice(0, stageIdx + 1).join("/") + "/Grade Returns";
          }
        }

        // Action label based on grade and revision
        const isProductionRev = revision.toUpperCase().startsWith("C");
        const action = grade === "C"
          ? "Review this drawing with the DM — do not revise independently"
          : grade === "NA"
            ? "Not applicable — no action required"
            : isProductionRev
              ? "Update drawings for production"
              : "Update to next revision";

        // Completion date: return date + revision days from Projects DB
        // Falls back to today if "Reviewed" was never set on this submission (there is no
        // separate "graded date" property — this previously referenced an undefined
        // `gradedAt` variable, which threw inside Promise.all and 500'd the whole batch
        // whenever any pending submission was missing a Reviewed date).
        const returnDate    = reviewed || now();
        const revisionDays  = await getRevisionDays(notion, drawingIds);
        const completionDate = addWorkingDays(returnDate, revisionDays);

        return {
          pageId: page.id,
          dtName: dt.name,
          dtEmail: dt.email,
          gradeReturnsPath,
          drawingNo,
          stage,
          grade,
          revision,
          action,
          returnDate,
          completionDate,
          revisionDays,
        };
      }));

      // Group by DT → by gradeReturnsPath (project+stage bucket)
      const byDT = {};
      for (const item of enriched) {
        const dtKey = item.dtEmail || item.dtName || "unknown";
        if (!byDT[dtKey]) byDT[dtKey] = { dtName: item.dtName, dtEmail: item.dtEmail, buckets: {}, pageIds: [] };
        const bucketKey = item.gradeReturnsPath || "_no_path";
        if (!byDT[dtKey].buckets[bucketKey]) {
          byDT[dtKey].buckets[bucketKey] = { gradeReturnsPath: item.gradeReturnsPath, drawings: [] };
        }
        byDT[dtKey].buckets[bucketKey].drawings.push(item);
        byDT[dtKey].pageIds.push(item.pageId);
      }

      // Build folderBlocks per DT (matches dt-summary email structure)
      for (const group of Object.values(byDT)) {
        group.folderBlocks = Object.values(group.buckets).map((bucket) => {
          const pathText    = bucket.gradeReturnsPath || "Grade Returns folder";
          const folderHtml  = `<strong>${pathText}</strong>`;

          const filenameFormatNote =
            `<tr><td colspan="5" style="padding:4px 8px 10px;font-size:11px;color:#888;font-style:italic;">` +
            `Files in this folder are named: <code>{SuffixNo}_{DrawingNo}_{Rev}_{Grade}_{YYMMDD}.pdf</code>` +
            `</td></tr>`;

          const drawingRows = bucket.drawings.map((d) =>
            `<tr>
              <td style="padding:4px 8px;color:#333;">${d.drawingNo || "—"}</td>
              <td style="padding:4px 8px;color:#555;">${d.stage}</td>
              <td style="padding:4px 8px;color:#555;">${d.revision}</td>
              <td style="padding:4px 8px;font-weight:600;color:#333;">${d.grade}</td>
              <td style="padding:4px 8px;color:#555;">${d.action}</td>
              <td style="padding:4px 8px;color:#555;">${d.completionDate}</td>
            </tr>`
          ).join("") + filenameFormatNote;

          return {
            folderHtml,
            drawingsHtml: drawingRows,
            drawingCount: bucket.drawings.length,
          };
        });
      }

      // Fire one webhook per DT
      let emailsSent = 0;
      const webhookResults = [];
      const webhookUrl = process.env.MAKE_ACTIONS_WEBHOOK;

      for (const group of Object.values(byDT)) {
        if (!group.dtEmail) {
          console.warn(`[send-grade-emails] Skipping DT "${group.dtName}" — no email`);
          webhookResults.push({ dtName: group.dtName, skipped: true, reason: "no email" });
          continue;
        }
        const totalCount = group.folderBlocks.reduce((n, b) => n + b.drawingCount, 0);
        const payload = {
          action:       "grade-summary",
          dtName:       group.dtName,
          dtEmail:      group.dtEmail,
          folderBlocks: group.folderBlocks,
          count:        totalCount,
        };
        try {
          const r = await fetch(webhookUrl, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(payload),
          });
          const responseText = await r.text().catch(() => "");
          webhookResults.push({ dtEmail: group.dtEmail, status: r.status, ok: r.ok });
          if (r.ok) emailsSent++;
        } catch (err) {
          console.error(`[send-grade-emails] Webhook failed for ${group.dtEmail}:`, err.message);
          webhookResults.push({ dtEmail: group.dtEmail, error: err.message });
        }
      }

      // Mark notified: BIC → DT, DT Notified → true
      const allPageIds = Object.values(byDT).flatMap((g) => g.pageIds);
      const notifiedAt = now();
      await Promise.all(allPageIds.map((pid) =>
        notion.pages.update({ page_id: pid, properties: {
          "DT Notified":   { checkbox: true                    },
          "Ball In Court": { select:   { name: "DT"           } },
          "BIC Since":     { date:     { start: notifiedAt    } },
        }}).catch((e) => console.warn(`[send-grade-emails] Notion update failed ${pid}:`, e.message))
      ));

      console.log(`[send-grade-emails] Done — ${emailsSent} webhook(s), ${allPageIds.length} submission(s) notified`);
      res.json({ ok: true, emailsSent, submissionsNotified: allPageIds.length, webhookResults });
    } catch (err) {
      console.error("[send-grade-emails]", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // PATCH /api/df/submissions/:id/hold
  // Reads/writes the Blocked checkbox on a submission. The `DM Action` transition
  // (→ Unblock while held, reverting to its original state when cleared) is driven by a
  // Notion automation off the Blocked property — so it is intentionally NOT written here.
  //
  // blocked=true  → put on hold.
  // blocked=false → unblock ("coordinate the hold items"): hand the drawing back to the DT,
  //                 roll the related MDS drawing(s) status forward (Approval Updates, or
  //                 Production Updates for C-revisions) and clear Hold Notes.

  app.patch("/api/df/submissions/:id/hold", async (req, res) => {
    const { id } = req.params;
    const { blocked } = req.body;   // boolean
    try {
      const subProps = { "Blocked": { checkbox: !!blocked } };
      // On unblock, hand back to the DT.
      if (!blocked) subProps["Ball In Court"] = { select: { name: "DT" } };
      await notion.pages.update({ page_id: id, properties: subProps });

      // On unblock, roll the related MDS drawing(s) forward and clear Hold Notes.
      if (!blocked) {
        const submissionPage = await notion.pages.retrieve({ page_id: id });
        const drawingIds = getProp(submissionPage, "Drawing", "relation") || [];
        const revision   = getProp(submissionPage, "Revision", "select") ?? "";
        const nextStatus = revision.toUpperCase().startsWith("C") ? "Production Updates" : "Approval Updates";
        for (const drawingId of drawingIds) {
          try {
            await notion.pages.update({ page_id: drawingId, properties: {
              "Drawing Status": { select: { name: nextStatus } },
              "Hold Notes":     { rich_text: [] },
            }});
          } catch (err) {
            console.warn(`[hold:unblock] MDS update failed for ${drawingId}:`, err.message);
          }
        }
      }

      res.json({ ok: true, blocked: !!blocked });
    } catch (err) {
      console.error("[hold]", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/df/scan-comments
  // On-demand client-comment ingest. The DM uploads marked-up PDFs into the Dropbox
  // `Client Comments/` folders, then clicks the cockpit trigger. This fires the Make
  // "cr-ingest" action, which lists those folders, and for each new file POSTs to
  // /api/df/cr-ingest (below) to populate Notion. The file is NOT renamed at this point —
  // the filename only changes once a human has actually reviewed it. Re-running this scan is
  // safe: /api/df/cr-ingest dedupes by checking whether the filename is already recorded in
  // Notion's Comment Files field, independent of any `R_` prefix on disk. Replaces continuous
  // folder-watching (saves Make credits).

  app.post("/api/df/scan-comments", async (req, res) => {
    const webhookUrl = process.env.MAKE_CR_INGEST_WEBHOOK || process.env.MAKE_ACTIONS_WEBHOOK;
    if (!webhookUrl) return res.status(500).json({ ok: false, error: "MAKE_CR_INGEST_WEBHOOK / MAKE_ACTIONS_WEBHOOK env var not set" });
    await fireWebhook(webhookUrl, { action: "cr-ingest", requestedAt: now() });
    res.json({ ok: true });
  });

  // POST /api/df/cr-ingest
  // Called by the Make cr-ingest scenario once per new client-comment PDF.
  // Body: { filePath | dropboxPath, shareLink, filename }
  // Parses the filename + folder path, finds the MDS drawing, and appends the comment file
  // (hyperlinked) to `<stage> Comment Files` and the client acronym to `<stage> Client Reviewers`.
  // Existing values are preserved (multiple clients may comment on the same drawing/stage).

  app.post("/api/df/cr-ingest", async (req, res) => {
    try {
      const { filePath, dropboxPath, shareLink, filename } = req.body || {};
      const pathStr = (filePath || dropboxPath || "");
      const name = filename || pathStr.split("/").pop();
      if (!name) return res.status(400).json({ ok: false, error: "filename required" });

      // Parse {ClientAcronym}_{YYMMDD}_{DrawingNo}_{Rev}.pdf
      const baseName = name.replace(/\.pdf$/i, "");
      const parts = baseName.split("_");
      if (parts.length < 4) return res.status(400).json({ ok: false, error: `Could not parse filename: ${name}` });
      const clientAcronym = parts[0];
      const drawingNo     = parts.slice(2, parts.length - 1).join("_");

      // Stage from the folder path
      const norm  = pathStr.replace(/\\/g, "/");
      const stage = /\/A4\.5\//i.test(norm) ? "A4.5" : /\/S5\//i.test(norm) ? "S5" : "S4";
      const commentProp  = `${stage} Comment Files`;
      const reviewerProp = `${stage} Client Reviewers`;

      const matches = await queryAll(notion, DRAWINGS_DB, {
        property: "Drawing Number", title: { contains: drawingNo },
      });
      if (!matches.length) return res.json({ ok: true, matched: false, note: `No MDS drawing for ${drawingNo}` });
      const drawing = matches[0];

      // Append hyperlinked filename to the stage's Comment Files rich_text (preserve existing)
      const existingRT = drawing.properties?.[commentProp]?.rich_text ?? [];

      // Deduplicate — skip if this filename (with or without R_ prefix) is already recorded.
      // Case-insensitive: Dropbox/Make can return the same file's extension in a different
      // case on different list passes (seen in practice — "_P01.pdf" vs "_P01.PDF" for the
      // same file), which a case-sensitive check treats as a new, distinct filename and
      // appends a duplicate entry.
      const existingText = existingRT.map((r) => r.text?.content ?? "").join("").toLowerCase();
      const baseScanName = name.replace(/^R_/i, "").toLowerCase();
      if (existingText.includes(baseScanName)) {
        console.log(`[cr-ingest] already ingested, skipping: ${name}`);
        return res.json({ ok: true, matched: true, skipped: true, drawingId: drawing.id, stage, drawingNo });
      }

      const separator  = existingRT.length ? [{ type: "text", text: { content: ", " } }] : [];
      const newSegment = { type: "text", text: { content: name, link: shareLink ? { url: shareLink } : null } };

      // Add client acronym to the stage's Client Reviewers multi-select (preserve existing)
      const existingMS = drawing.properties?.[reviewerProp]?.multi_select ?? [];
      const multiSelect = existingMS.some((o) => o.name === clientAcronym)
        ? existingMS.map((o) => ({ name: o.name }))
        : [...existingMS.map((o) => ({ name: o.name })), { name: clientAcronym }];

      await notion.pages.update({ page_id: drawing.id, properties: {
        [commentProp]:  { rich_text: [...existingRT, ...separator, newSegment] },
        [reviewerProp]: { multi_select: multiSelect },
      }});

      // Hand the submission back to the DM for comment review. Status stays "Issued" —
      // receiving client comments doesn't change the ISO stage, just who needs to act next.
      // Ball In Court → DM is what the cockpit's "Review Client Comments" column is keyed off.
      let submissionId = null;
      try {
        const subs = await queryAll(notion, SUBMISSIONS_DB, {
          and: [
            { property: "Drawing", relation: { contains: drawing.id } },
            { property: "Stage",   select:   { equals: stage        } },
            { property: "Status",  select:   { equals: "Issued"     } },
          ],
        });
        if (subs.length) {
          // Most recent QA round wins if more than one Issued submission matches.
          const target = subs.sort(
            (a, b) => (getProp(b, "QA Round", "number") ?? 0) - (getProp(a, "QA Round", "number") ?? 0)
          )[0];
          submissionId = target.id;
          const receivedAt = now();
          await notion.pages.update({ page_id: target.id, properties: {
            "Ball In Court": { select: { name: BIC.COMMENTS_RECEIVED } },
            "BIC Since":     { date:   { start: receivedAt           } },
            // Unlike every other DM Action value (Approve/Bounce/Log Status — all stamped
            // as a record of an action already taken), this one is prescriptive: it flags
            // that reviewing the comments is the action now required. Chosen deliberately
            // over a separate field so it's visible in the same column as everything else.
            "DM Action":     { select: { name: "Review Comments"    } },
          }});
        } else {
          console.warn(`[cr-ingest] no Issued submission found for ${drawingNo} ${stage} — Comment Files written but Ball In Court not updated`);
        }
      } catch (err) {
        console.warn(`[cr-ingest] Ball In Court update failed for ${drawingNo} ${stage}:`, err.message);
      }

      console.log(`[cr-ingest] ${name} → ${drawingNo} ${stage} (${clientAcronym})`);
      res.json({ ok: true, matched: true, drawingId: drawing.id, submissionId, stage, clientAcronym, drawingNo });
    } catch (err) {
      console.error("[cr-ingest]", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/df/test-webhook
  // Diagnostic endpoint — fires a minimal dt-summary test payload to MAKE_ACTIONS_WEBHOOK
  // and returns Make's raw response. Use to confirm the webhook URL and Make route are working
  // independently of real submission data.
  // Usage: POST /api/df/test-webhook   (no body required)

  app.post("/api/df/test-webhook", async (req, res) => {
    const webhookUrl = process.env.MAKE_ACTIONS_WEBHOOK;
    if (!webhookUrl) return res.status(500).json({ ok: false, error: "MAKE_ACTIONS_WEBHOOK env var not set" });

    const testPayload = {
      action:       "dt-summary",
      dtName:       req.body?.testName  || "Test DT",
      dtEmail:      req.body?.testEmail || "test@example.com",
      folderBlocks: [
        {
          folderHtml:   "<a href=\"https://www.dropbox.com/sh/test\" style=\"color:#4f7fff;font-weight:600;\">Suffix 001</a>",
          drawingsHtml: "<tr><td style=\"padding:4px 8px;color:#333;\">A-101</td><td style=\"padding:4px 8px;color:#555;\">S4</td><td style=\"padding:4px 8px;color:#555;\">QA Approved</td></tr><tr><td style=\"padding:4px 8px;color:#333;\">A-102</td><td style=\"padding:4px 8px;color:#555;\">S4</td><td style=\"padding:4px 8px;color:#555;\">QA Approved</td></tr>",
          drawingCount: 2,
        },
        {
          folderHtml:   "<a href=\"https://www.dropbox.com/sh/test2\" style=\"color:#4f7fff;font-weight:600;\">Rejected/R1</a>",
          drawingsHtml: "<tr><td style=\"padding:4px 8px;color:#333;\">A-103</td><td style=\"padding:4px 8px;color:#555;\">S5</td><td style=\"padding:4px 8px;color:#555;\">Bounced — returned for revision</td></tr>",
          drawingCount: 1,
        },
      ],
      count: 3,
    };

    try {
      console.log(`[test-webhook] Firing test payload to ${webhookUrl.slice(0, 60)}…`);
      const r = await fetch(webhookUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(testPayload),
      });
      const responseText = await r.text().catch(() => "");
      console.log(`[test-webhook] Make response: ${r.status} — "${responseText}"`);
      res.json({ ok: r.ok, status: r.status, makeResponse: responseText, payloadSent: testPayload });
    } catch (err) {
      console.error("[test-webhook]", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // PATCH /api/df/submissions/:id/approve
  // DM passes QA review — moves to "Approved", DT gets instructions to produce PDF+DWG.
  // Dropbox move fires (PDF out of /Pending/). MDS updates happen at /issue instead.

  app.patch("/api/df/submissions/:id/approve", async (req, res) => {
    const { id } = req.params;
    let submissionPage;
    try { submissionPage = await notion.pages.retrieve({ page_id: id }); }
    catch { return res.status(404).json({ ok: false, error: "Submission not found" }); }

    const stage      = getProp(submissionPage, "Stage",        "select");
    const rawPath    = getProp(submissionPage, "Dropbox Path", "url");
    const reviewedAt = now();

    if (!VALID_STAGES.includes(stage)) return res.status(400).json({ ok: false, error: `Unknown stage: ${stage}` });

    try {
      await notion.pages.update({ page_id: id, properties: {
        "Status":        { select: { name: "Approved" } },
        "DM Action":     { select: { name: "Approve"        } },
        "Reviewed":      { date:   { start: reviewedAt      } },
        "Ball In Court": { select: { name: "DT"             } },
        "BIC Since":     { date:   { start: reviewedAt      } },
      }});
    } catch (err) {
      return res.status(500).json({ ok: false, error: "Submission update failed", detail: err.message });
    }

    const dropboxMove     = computeDropboxMove(rawPath, "approve", null);
    const submissionTitle = getProp(submissionPage, "Submission", "title");
    const dtIds           = getProp(submissionPage, "DT",         "relation");
    const taskIds         = getProp(submissionPage, "Item",        "relation");
    const dt              = await resolveDT(notion, dtIds);

    const { taskCode } = parseSubmissionTitle(submissionTitle, stage);
    const taskParts    = taskCode ? taskCode.split("-") : [];
    const projectNo    = taskParts.slice(0, -1).join("-");           // "24-367"
    const itemNo       = dropboxMove?.itemNo ?? taskParts[taskParts.length - 1]; // "022"
    const suffixRef    = projectNo && itemNo ? `${projectNo}-${itemNo}` : submissionTitle;
    const uploadPath   = projectNo && stage && itemNo
      ? `${DROPBOX_ROOT}/Drawing Submissions/${projectNo}/${stage}/Suffix ${itemNo}`
      : null;

    // Update Dropbox Path in Notion to reflect the new location after move
    if (dropboxMove?.to) {
      const newShortPath = dropboxMove.to.toLowerCase().startsWith(DROPBOX_ROOT.toLowerCase())
        ? dropboxMove.to.slice(DROPBOX_ROOT.length).replace(/^\//, "")
        : dropboxMove.to;
      notion.pages.update({ page_id: id, properties: {
        "Dropbox Path": { url: newShortPath }
      }}).catch(e => console.warn("[approve] Dropbox Path update failed:", e.message));
    }

    // Collect all drawing numbers approved so far in this suffix
    let approvedDrawingNos = [dropboxMove?.drawingNo].filter(Boolean);
    if (taskIds?.length) {
      try {
        const siblings = await notion.databases.query({
          database_id: SUBMISSIONS_DB,
          filter: {
            and: [
              { property: "Item",   relation: { contains: taskIds[0] } },
              { property: "Stage",  select:   { equals: stage        } },
              { property: "Status", select:   { equals: "Approved"   } },
            ]
          }
        });
        const siblingNos = siblings.results.map(page => {
          const t = getProp(page, "Submission", "title") ?? "";
          return parseSubmissionTitle(t, stage).drawingNo;
        }).filter(Boolean);
        // Merge with current drawing (Notion update may not be reflected yet)
        approvedDrawingNos = [...new Set([...siblingNos, ...(dropboxMove?.drawingNo ? [dropboxMove.drawingNo] : [])])];
      } catch (err) {
        console.warn("[approve] Drawing list lookup failed:", err.message);
      }
    }

    // Fire webhook so Make can: (1) move the file, (2) create shared link,
    // (3) POST the link back via /api/df/submissions/:id/folder-link.
    // Email is NOT sent here — handled by POST /api/df/send-dt-emails.
    await fireWebhook(process.env.MAKE_ACTIONS_WEBHOOK, {
      action:       "approve",
      submissionId: id,
      submissionTitle,
      stage,
      projectNo,
      itemNo,
      suffixRef,
      reviewedAt,
      approvedDrawingNos,
      suffixFolderPath: dropboxMove?.toFolder ?? null,
      ...(uploadPath  ? { uploadPath }  : {}),
      ...(dropboxMove ? { dropboxMove } : {}),
      dtName:  dt.name,
      dtEmail: dt.email,
    });

    const revision = getProp(submissionPage, "Revision", "select") ?? "";
    const approveDrawingNo = dropboxMove?.drawingNo ?? parseSubmissionTitle(submissionTitle, stage).drawingNo;
    await createActivityLogEntry(notion, {
      taskId: taskIds?.[0],
      source: "Drawing Flow",
      tag:    "#approval",
      author: "DM",
      entry:  `Drawing ${approveDrawingNo} Rev ${revision} approved by DM. Queued for issue.`,
    });

    console.log(`[approve] ${id} => Awaiting Issue (suffix ${suffixRef})`);
    res.json({ ok: true, reviewedAt, suffixRef, ...(dropboxMove ? { dropboxMove } : {}) });
  });

  // PATCH /api/df/submissions/:id/issue
  // DM has issued drawings to client externally — updates Notion + MDS, fires DT notification.

  app.patch("/api/df/submissions/:id/issue", async (req, res) => {
    const { id } = req.params;
    console.log(`[issue] retrieving page: ${id}`);
    let submissionPage;
    try { submissionPage = await notion.pages.retrieve({ page_id: id }); }
    catch (err) {
      console.error(`[issue] retrieve failed for ${id}:`, err?.status, err?.code, err?.message);
      return res.status(404).json({ ok: false, error: "Submission not found", detail: `${err?.code ?? ""}: ${err?.message ?? err}` });
    }

    const currentStatus = getProp(submissionPage, "Status", "select");
    console.log(`[issue] page retrieved, status: ${currentStatus}`);
    if (currentStatus !== "Awaiting Issue") {
      return res.status(400).json({ ok: false, error: `Expected Awaiting Issue, got: ${currentStatus}` });
    }

    const stage         = getProp(submissionPage, "Stage",   "select");
    const drawingIds    = getProp(submissionPage, "Drawing", "relation");
    const stageMap      = STAGE_APPROVE_MAP[stage];
    const drawingStatus = STAGE_APPROVE_DRAWING_STATUS[stage];
    const bicValue      = STAGE_APPROVE_BIC[stage];
    const issuedDate    = now();
    const errors        = [];

    if (!stageMap) return res.status(400).json({ ok: false, error: `Unknown stage: ${stage}` });

    try {
      await notion.pages.update({ page_id: id, properties: {
        "Status":        { select: { name: "Issued"    } },
        "DM Action":     { select: { name: "Approve"   } },
        "Issued":        { date:   { start: issuedDate } },
        "Ball In Court": { select: { name: bicValue    } },
        "BIC Since":     { date:   { start: issuedDate } },
      }});
    } catch (err) {
      return res.status(500).json({ ok: false, error: "Submission update failed", detail: err.message });
    }

    for (const drawingId of drawingIds) {
      try {
        await notion.pages.update({ page_id: drawingId, properties: {
          "Drawing Status":     { select: { name: drawingStatus } },
          [stageMap.dateField]: { date:   { start: issuedDate  } },
        }});
      } catch (err) {
        console.warn(`[issue] MDS update failed for ${drawingId}:`, err.message);
        errors.push(`MDS: ${drawingId}`);
      }
    }

    const submissionTitle = getProp(submissionPage, "Submission", "title");
    const taskIds  = getProp(submissionPage, "Item",     "relation");
    const revision = getProp(submissionPage, "Revision", "select") ?? "";
    const { drawingNo: issueDrawingNo } = parseSubmissionTitle(submissionTitle, stage);
    await createActivityLogEntry(notion, {
      taskId: taskIds?.[0],
      source: "Drawing Flow",
      tag:    "#approval",
      author: "DM",
      entry:  `Drawing ${issueDrawingNo} Rev ${revision} issued to client.`,
    });

    // NOTE: fireWebhook removed — DT email now batched via POST /api/df/send-dt-emails
    console.log(`[issue] ${id} => ${drawingStatus}`);
    res.json({ ok: true, issuedDate, drawingStatus, ...(errors.length ? { errors } : {}) });
  });

  // POST /api/df/stage-upload
  // Triggered by Make Scenario 1 when DT uploads DWG to the stage folder.
  // Finds "Approved" submissions with BIC=DT for that project/stage,
  // sets Status → "Awaiting Issue" and BIC → DM so the DM is notified to act.

  app.post("/api/df/stage-upload", async (req, res) => {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ ok: false, error: "Missing filePath" });

    const parts  = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
    const dsIdx  = parts.findIndex((p) => p.toLowerCase() === "drawing submissions");
    if (dsIdx < 0) return res.status(400).json({ ok: false, error: "Path not under Drawing Submissions" });

    const projectNo = parts[dsIdx + 1];
    const stage     = parts[dsIdx + 2]?.toUpperCase();  // path_lower from Dropbox/Make is all lowercase
    if (!projectNo || !stage) return res.status(400).json({ ok: false, error: "Could not parse project/stage" });
    if (!VALID_STAGES.includes(stage)) return res.status(400).json({ ok: false, error: `Unknown stage: ${stage}` });

    console.log(`[stage-upload] ${projectNo}/${stage} — BIC update DT → DM`);

    try {
      const results = await queryAll(notion, SUBMISSIONS_DB, {
        and: [
          { property: "Stage",         select: { equals: stage            } },
          { property: "Status",        select: { equals: "Approved" } },
          { property: "Ball In Court", select: { equals: "DT"             } },
        ],
      });

      const matching = results.filter((page) =>
        (getProp(page, "Submission", "title") ?? "").startsWith(projectNo)
      );

      if (!matching.length) {
        return res.json({ ok: true, updated: 0, message: "No matching submissions found" });
      }

      await Promise.all(matching.map((page) =>
        notion.pages.update({ page_id: page.id, properties: {
          "Status":        { select: { name: "Awaiting Issue" } },
          "Ball In Court": { select: { name: "DM"             } },
          "BIC Since":     { date:   { start: now()           } },
        }}).catch((e) => console.warn(`[stage-upload] update failed ${page.id}:`, e.message))
      ));

      console.log(`[stage-upload] Updated ${matching.length} submission(s) → Awaiting Issue, BIC: DM`);
      res.json({ ok: true, updated: matching.length });
    } catch (err) {
      console.error("[stage-upload]", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // PATCH /api/df/submissions/:id/bounce
  // After Notion writes: fires Make Scenario 2 (Dropbox move + Gmail share link to DT).
  //
  // Body: { annotatedDropboxPath, annotatedPdfFilename }
  //   annotatedDropboxPath: full Dropbox path of the pre-uploaded annotated PDF
  //   Make moves the file from that path to R{n}/, creates a share link, emails it to DT.
  //   No PDF bytes transmitted — works for any file size.
  // GET /api/df/submissions/:id/bounce-dest
  // Returns the computed Dropbox destination paths for a bounce without committing any changes.
  // Used by DT Checker to upload the annotated PDF directly to R{n}/ before calling /bounce.
  app.get("/api/df/submissions/:id/bounce-dest", async (req, res) => {
    const { id } = req.params;
    let submissionPage;
    try { submissionPage = await notion.pages.retrieve({ page_id: id }); }
    catch { return res.status(404).json({ ok: false, error: "Submission not found" }); }

    const qaRound    = getProp(submissionPage, "QA Round",     "number") ?? 1;
    const rawPath    = getProp(submissionPage, "Dropbox Path", "url");
    const dropboxMove = computeDropboxMove(rawPath, "bounce", qaRound);

    if (!dropboxMove) return res.status(400).json({ ok: false, error: "Could not compute bounce destination — check Dropbox Path in Notion" });

    res.json({ ok: true, dropboxMove });
  });

  app.patch("/api/df/submissions/:id/bounce", async (req, res) => {
    const { id } = req.params;
    const { annotatedPdfFilename,
            annotatedPdfBase64 } = req.body || {};  // base64 kept for legacy/small-file fallback
    let { annotatedDropboxPath } = req.body || {};

    let submissionPage;
    try { submissionPage = await notion.pages.retrieve({ page_id: id }); }
    catch { return res.status(404).json({ ok: false, error: "Submission not found" }); }

    const qaRound   = getProp(submissionPage, "QA Round",     "number") ?? 1;
    const rawPath   = getProp(submissionPage, "Dropbox Path", "url");

    // If DT Checker pre-uploaded the file but didn't send annotatedDropboxPath,
    // reconstruct it so Make receives hasAnnotatedPdf=true and doesn't overwrite the annotated file.
    if (!annotatedDropboxPath && !annotatedPdfBase64 && annotatedPdfFilename) {
      const dm = computeDropboxMove(rawPath, "bounce", qaRound);
      if (dm?.toFolder) annotatedDropboxPath = `${dm.toFolder}/${annotatedPdfFilename}`;
    }
    const hasAnnotatedPdf = !!(annotatedDropboxPath || annotatedPdfBase64);
    const bouncedAt = now();

    try {
      await notion.pages.update({ page_id: id, properties: {
        "Status":        { select: { name: "Rejected"  } },
        "DM Action":     { select: { name: "Bounce"    } },
        "Reviewed":      { date:   { start: bouncedAt  } },
        "Ball In Court": { select: { name: BIC.BOUNCED } },
        "BIC Since":     { date:   { start: bouncedAt  } },
      }});
    } catch (err) {
      return res.status(500).json({ ok: false, error: "Submission update failed", detail: err.message });
    }

    const dropboxMove     = computeDropboxMove(rawPath, "bounce", qaRound);
    const submissionTitle = getProp(submissionPage, "Submission", "title");
    const stage           = getProp(submissionPage, "Stage",      "select");
    const dtIds           = getProp(submissionPage, "DT",         "relation");
    const taskIds         = getProp(submissionPage, "Item",        "relation");
    const dt              = await resolveDT(notion, dtIds);

    // Update stored Dropbox Path to the annotated PDF destination (or original move target)
    const destPath = (() => {
      if (!dropboxMove?.toFolder) return dropboxMove?.to || null;
      const fname = annotatedPdfFilename || dropboxMove.to?.split("/").pop() || null;
      return fname ? `${dropboxMove.toFolder}/${fname}` : dropboxMove.to;
    })();
    if (destPath) {
      const short = destPath.startsWith(DROPBOX_ROOT)
        ? destPath.slice(DROPBOX_ROOT.length).replace(/^\//, "") : destPath;
      notion.pages.update({ page_id: id, properties: {
        "Dropbox Path": { url: short }
      }}).catch(e => console.warn("[bounce] Dropbox Path update failed:", e.message));
    }

    // Fetch Miro Board Link from the linked Task
    let miroLink = null;
    if (taskIds?.length) {
      try {
        const taskPage = await notion.pages.retrieve({ page_id: taskIds[0] });
        miroLink = getProp(taskPage, "Miro Board Link", "url");
      } catch { /* non-fatal */ }
    }

    // Fire webhook so Make can: (1) move the file, (2) create shared link on the Rejected folder,
    // (3) POST the link back via /api/df/submissions/:id/folder-link.
    // Email is NOT sent here — handled by POST /api/df/send-dt-emails.
    await fireWebhook(process.env.MAKE_ACTIONS_WEBHOOK, {
      action:           "bounce",
      submissionId:     id,
      submissionTitle,
      stage,
      qaRound,
      bouncedAt,
      hasAnnotatedPdf,
      bounceFolderPath: dropboxMove?.toFolder ?? null,
      ...(miroLink             ? { miroLink }                                   : {}),
      ...(annotatedDropboxPath ? { annotatedDropboxPath, annotatedPdfFilename } : {}),
      ...(annotatedPdfBase64 && !annotatedDropboxPath ? { annotatedPdfBase64, annotatedPdfFilename } : {}),
      ...(dropboxMove          ? { dropboxMove }                                : {}),
      dtName:  dt.name,
      dtEmail: dt.email,
    });

    const bounceRevision = getProp(submissionPage, "Revision", "select") ?? "";
    const bounceDrawingNo = dropboxMove?.drawingNo ?? parseSubmissionTitle(submissionTitle, stage).drawingNo;
    await createActivityLogEntry(notion, {
      taskId: taskIds?.[0],
      source: "Drawing Flow",
      tag:    "#issue",
      author: "DM",
      entry:  `Drawing ${bounceDrawingNo} Rev ${bounceRevision} bounced — QA Round ${qaRound}. BIC returned to ${dt.name || "DT"}.`,
    });

    console.log(`[bounce] ${id} (path: ${annotatedDropboxPath || "none"}, base64: ${annotatedPdfBase64 ? "yes" : "no"})`);
    res.json({ ok: true, bouncedAt, ...(dropboxMove ? { dropboxMove } : {}) });
  });

  // PATCH /api/df/submissions/:id/log-status
  // After Notion writes: fires Make Scenario 4 (Gmail to DT, routed by stage + grade).

  app.patch("/api/df/submissions/:id/log-status", async (req, res) => {
    const { id } = req.params;
    const { grade, returnDate } = req.body;   // returnDate = date filed on project system (YYYY-MM-DD)
    let submissionPage;
    try { submissionPage = await notion.pages.retrieve({ page_id: id }); }
    catch (_e) { return res.status(404).json({ ok: false, error: "Submission not found" }); }

    const stage    = getProp(submissionPage, "Stage",     "select");
    const revision = getProp(submissionPage, "Revision",  "select") ?? "";
    const stageMap = STAGE_LOG_STATUS_MAP[stage];

    if (!stageMap || !stageMap.supported) {
      return res.status(400).json({ ok: false, error: `Log Status not supported for stage: ${stage}` });
    }
    if (!stageMap.grades.includes(grade)) {
      return res.status(400).json({ ok: false, error: `Invalid grade "${grade}" for ${stage}. Valid: ${stageMap.grades.join(", ")}` });
    }

    const drawingIds       = getProp(submissionPage, "Drawing", "relation");
    const gradedAt         = now();
    const statusDate       = returnDate || gradedAt;   // prefer project-system date over today

    const isTerminalAB     = stage === "AB"   && grade === "Approved";
    const isA45Approved    = stage === "A4.5" && grade === "Approved";
    const isProductionRev  = revision.toUpperCase().startsWith("C");

    // Drawing Status: terminal stages override; otherwise use revision prefix
    const drawingStatus = isTerminalAB  ? "Complete"
                        : isA45Approved ? "Schedule"
                        : isProductionRev ? "Production Updates"
                        : "Approval Updates";

    // BIC: terminal AB → clear; A4.5 Approved → DM (for production sign-off); graded → DM until email fired
    const newBIC = isTerminalAB ? null : BIC.GRADED;   // BIC.GRADED is now "DM"

    const submissionStatus = isA45Approved ? "Schedule" : isTerminalAB ? "Complete" : "Graded";

    try {
      await notion.pages.update({ page_id: id, properties: {
        "Status":        { select: { name: submissionStatus } },
        "DM Action":     { select: { name: "Log Status"     } },
        "Client Grade":  { select: { name: grade            } },
        "Reviewed":      { date:   { start: gradedAt        } },
        "DT Notified":   { checkbox: false                   },
        "Ball In Court": newBIC ? { select: { name: newBIC    } } : { select: null },
        "BIC Since":     newBIC ? { date:   { start: gradedAt } } : { date:   null },
      }});
    } catch (err) {
      return res.status(500).json({ ok: false, error: "Submission update failed", detail: err.message });
    }

    for (const drawingId of drawingIds) {
      try {
        const mdsProps = { "Drawing Status": { select: { name: drawingStatus } } };
        if (stageMap.statusField) mdsProps[stageMap.statusField] = { select: { name: grade } };
        // Status Date uses the project-system return date (or today if not provided)
        // A4.5: only set C01 Sign Off date when Approved
        if (stageMap.dateField && !(stage === "A4.5" && grade !== "Approved")) {
          mdsProps[stageMap.dateField] = { date: { start: statusDate } };
        }
        await notion.pages.update({ page_id: drawingId, properties: mdsProps });
      } catch (err) {
        console.warn(`[log-status] MDS failed for ${drawingId}:`, err.message);
      }
    }

    const logStatusTitle = getProp(submissionPage, "Submission", "title");
    const taskIds = getProp(submissionPage, "Item", "relation");
    const { drawingNo: logStatusDrawingNo } = parseSubmissionTitle(logStatusTitle, stage);
    await createActivityLogEntry(notion, {
      taskId: taskIds?.[0],
      source: "Drawing Flow",
      tag:    "#response",
      author: "System",
      entry:  `Client grade ${grade} recorded for ${logStatusDrawingNo} Rev ${revision}.`,
    });

    console.log(`[log-status] ${id} => ${grade} (Rev ${revision}) => ${drawingStatus}`);
    res.json({ ok: true, grade, gradedAt, statusDate, drawingStatus, submissionStatus, isTerminal: isTerminalAB, isA45Approved });
  });

  // GET /api/df/drawings

  app.get("/api/df/drawings", async (req, res) => {
    const { taskId, stage, status } = req.query;
    const filters = [];
    if (taskId)  filters.push({ property: "Item",             relation: { contains: taskId } });
    if (stage)   filters.push({ property: "Submission Stage", select:   { equals: STAGE_LABEL[stage] ?? stage } });
    if (status)  filters.push({ property: "Drawing Status",   select:   { equals: status  } });

    const filter = filters.length === 1 ? filters[0] : filters.length > 1 ? { and: filters } : undefined;

    try {
      const results  = await queryAll(notion, DRAWINGS_DB, filter);
      const drawings = results.map((page) => ({
        id:              page.id,
        drawingNumber:   getProp(page, "Drawing Number",           "title"),
        drawingStatus:   getProp(page, "Drawing Status",           "select"),
        submissionStage: getProp(page, "Submission Stage",         "select"),
        revision:        getProp(page, "Rev",                      "select"),
        s5Status:        getProp(page, "S5 Status",                "select"),
        abStatus:        getProp(page, "AB Status",                "select"),
        s4SubmitActual:  getProp(page, "S4 Submit Date (Actual)",  "date"),
        s5SubmitActual:  getProp(page, "S5 Submit Date (Actual)",  "date"),
        c01SubmitActual: getProp(page, "C01 Submit Date (Actual)", "date"),
        abSubmitActual:  getProp(page, "AB Submit Date (Actual)",  "date"),
        taskIds:         getProp(page, "Item",                     "relation"),
      }));
      res.json({ drawings });
    } catch (err) {
      console.error("GET /api/df/drawings", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/df/inputs/:projectId

  app.get("/api/df/inputs/:projectId", async (req, res) => {
    const { projectId } = req.params;
    try {
      const page = await findInputsRow(notion, projectId, null);
      if (!page) return res.json({ inputs: null, id: null });
      res.json({ inputs: extractInputsFromPage(page), id: page.id });
    } catch (err) {
      console.error("GET /api/df/inputs/:projectId", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/df/inputs/:projectId/:taskId

  app.get("/api/df/inputs/:projectId/:taskId", async (req, res) => {
    const { projectId, taskId } = req.params;
    try {
      const [projectPage, taskPage] = await Promise.all([
        findInputsRow(notion, projectId, null),
        findInputsRow(notion, projectId, taskId),
      ]);
      const projectInputs = projectPage ? extractInputsFromPage(projectPage) : {};
      const taskInputs    = taskPage    ? extractInputsFromPage(taskPage)    : {};
      const resolved = {};
      for (const { key } of INPUTS_FIELDS) {
        resolved[key] = (taskInputs[key] !== null && taskInputs[key] !== undefined)
          ? taskInputs[key] : projectInputs[key] ?? null;
      }
      res.json({
        projectId: projectPage?.id ?? null,
        taskId:    taskPage?.id    ?? null,
        project:   projectInputs,
        task:      taskInputs,
        resolved,
      });
    } catch (err) {
      console.error("GET /api/df/inputs/:projectId/:taskId", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/df/inputs

  app.post("/api/df/inputs", async (req, res) => {
    const { projectId, taskId, scope, ...fieldData } = req.body;
    const db = INPUTS_DB();

    if (!db)        return res.status(503).json({ ok: false, error: "NOTION_DB_INPUTS not configured" });
    if (!projectId) return res.status(400).json({ ok: false, error: "projectId required" });

    const resolvedScope = scope ?? (taskId ? "Task" : "Project");
    if (resolvedScope === "Task" && !taskId) {
      return res.status(400).json({ ok: false, error: "taskId required for Task scope" });
    }

    try {
      const inputProps = buildInputsProps(fieldData);
      const existing   = await findInputsRow(notion, projectId, taskId ?? null);

      if (existing) {
        await notion.pages.update({ page_id: existing.id, properties: inputProps });
        return res.json({ ok: true, id: existing.id, created: false });
      }

      let projectName = projectId;
      try {
        const projPage = await notion.pages.retrieve({ page_id: projectId });
        projectName = getProp(projPage, "Project Name", "title") ?? projectId;
      } catch { /* fall back to ID */ }

      let rowName = `${projectName} — Project defaults`;
      if (resolvedScope === "Task" && taskId) {
        try {
          const taskPageData = await notion.pages.retrieve({ page_id: taskId });
          rowName = `${projectName} — ${getProp(taskPageData, "Item Name", "title") ?? taskId}`;
        } catch { rowName = `${projectName} — Task`; }
      }

      const createProps = {
        "Name":    { title:    [{ text: { content: rowName } }] },
        "Scope":   { select:   { name: resolvedScope } },
        "Project": { relation: [{ id: projectId }] },
        ...inputProps,
      };
      if (resolvedScope === "Task" && taskId) createProps["Task"] = { relation: [{ id: taskId }] };

      const newPage = await notion.pages.create({ parent: { database_id: db }, properties: createProps });
      return res.json({ ok: true, id: newPage.id, created: true });

    } catch (err) {
      console.error("POST /api/df/inputs", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/df/scan-pending
  // Triggers Make Scenario 1 (Ingest) to run immediately via the Make API.
  // Called by the cockpit "Scan Pending" button.

  app.post("/api/df/scan-pending", async (req, res) => {
    const scenarioId = process.env.MAKE_SCENARIO_ID;
    const apiKey     = process.env.MAKE_API_KEY;
    const apiZone    = process.env.MAKE_API_ZONE || "eu1";

    if (!scenarioId || !apiKey) {
      return res.status(503).json({ ok: false, error: "MAKE_SCENARIO_ID or MAKE_API_KEY not configured" });
    }

    try {
      const r = await fetch(`https://${apiZone}.make.com/api/v2/scenarios/${scenarioId}/run`, {
        method:  "POST",
        headers: { "Authorization": `Token ${apiKey}`, "Content-Type": "application/json" },
      });
      if (!r.ok) {
        const body = await r.text();
        let detail = body;
        try { detail = JSON.parse(body)?.message || JSON.parse(body)?.error || body; } catch (_e) {}
        return res.status(502).json({ ok: false, error: `Make ${r.status}: ${detail}` });
      }
      const data = await r.json();
      console.log(`[scan-pending] Triggered scenario ${scenarioId}`);
      return res.json({ ok: true, executionId: data.executionId ?? null });
    } catch (err) {
      console.error("[scan-pending]", err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/df/activity-log?taskId=&limit=50
  // Returns Item Activity Log entries for a Task, newest first. Sorts by "Event Date" when
  // set — that field only gets populated on backfilled/historical entries (old emails, past
  // events reconstructed after the fact) — otherwise falls back to Created (the live anchor
  // for entries logged in real time).

  app.get("/api/df/activity-log", async (req, res) => {
    if (!ACTIVITY_LOG_DB) return res.status(503).json({ ok: false, error: "NOTION_DB_ACTIVITY_LOG not configured" });
    const { taskId, limit } = req.query;
    if (!taskId) return res.status(400).json({ ok: false, error: "taskId required" });
    const pageSize = Math.min(Number(limit) || 50, 100);

    try {
      const result = await notion.databases.query({
        database_id: ACTIVITY_LOG_DB,
        filter:      { property: "Task", relation: { contains: taskId } },
        sorts:       [{ property: "Created", direction: "descending" }],
        page_size:   pageSize,
      });

      const entries = result.results
        .map((page) => ({
          id:        page.id,
          created:   page.created_time,
          eventDate: getProp(page, "Event Date", "date"),
          entry:     getProp(page, "Entry",   "title"),
          source:    getProp(page, "Source",  "select"),
          tag:       getProp(page, "Tag",     "select"),
          author:    getProp(page, "Author",  "rich_text"),
          detail:    getProp(page, "Detail",  "rich_text") ?? "",
          link:      getProp(page, "Link",    "url") ?? "",
        }))
        // Notion's own sort covers Created order; re-sort here so any row with an Event Date
        // (backfilled history) slots into true chronological position instead of clustering
        // at the top by its real Created (import) time.
        .sort((a, b) => new Date(b.eventDate || b.created) - new Date(a.eventDate || a.created));

      res.json({ entries });
    } catch (err) {
      console.error("GET /api/df/activity-log", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/df/activity-log
  // Manual quick-log entry from the cockpit Feed panel, and the general-purpose write path
  // for backfilling historical entries (old emails, past events). Author has no picker in
  // the UI yet, so the cockpit always sends author: 'DM' — see handoff doc.
  // Pass eventDate (YYYY-MM-DD) only when backfilling; omit it for real-time manual notes.

  app.post("/api/df/activity-log", async (req, res) => {
    if (!ACTIVITY_LOG_DB) return res.status(503).json({ ok: false, error: "NOTION_DB_ACTIVITY_LOG not configured" });
    const { taskId, tag, entry, author, source, detail, link, eventDate } = req.body || {};
    if (!entry) return res.status(400).json({ ok: false, error: "entry required" });
    if (!tag)   return res.status(400).json({ ok: false, error: "tag required" });

    try {
      const resolvedSource = source || "Manual";
      const properties = {
        "Entry":  { title:     [{ text: { content: entry } }] },
        "Source": { select:    { name: resolvedSource } },
        "Tag":    { select:    { name: tag } },
        "Author": { rich_text: [{ text: { content: author || "DM" } }] },
      };
      if (taskId)    properties["Task"]       = { relation: [{ id: taskId }] };
      if (detail)    properties["Detail"]     = { rich_text: [{ text: { content: detail } }] };
      if (link)      properties["Link"]       = { url: link };
      if (eventDate) properties["Event Date"] = { date: { start: eventDate } };

      const newPage = await notion.pages.create({ parent: { database_id: ACTIVITY_LOG_DB }, properties });
      res.json({
        ok: true,
        entry: {
          id:        newPage.id,
          created:   newPage.created_time,
          eventDate: eventDate ?? null,
          entry, tag, detail: detail || "", link: link || "",
          source: resolvedSource,
          author: author || "DM",
        },
      });
    } catch (err) {
      console.error("POST /api/df/activity-log", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

};
