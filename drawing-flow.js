// drawing-flow.js — Axiom Drawing Flow API routes
// Mounted into the main Express app via:  require('./drawing-flow')(app, notion)
//
// Routes:
//   POST   /api/df/ingest
//   GET    /api/df/submissions          ?status=Submitted|Issued|Graded|Rejected (default: Submitted)
//   PATCH  /api/df/submissions/:id/approve
//   PATCH  /api/df/submissions/:id/bounce
//   PATCH  /api/df/submissions/:id/log-status
//   GET    /api/df/drawings             ?taskId&stage&status
//   GET    /api/df/inputs/:projectId
//   GET    /api/df/inputs/:projectId/:taskId
//   POST   /api/df/inputs
//
// Make.com integration:
//   Scenario 1 (Ingest):      Make watches Dropbox /Pending/ and calls POST /api/df/ingest
//   Scenario 2 (Actions Hub): backend fires MAKE_ACTIONS_WEBHOOK with action=approve|bounce|log-status
//                             Make Router branches by action → Dropbox move + Gmail

"use strict";

// --- DB IDs ---
const DRAWINGS_DB    = process.env.NOTION_DB_DRAWINGS;
const SUBMISSIONS_DB = process.env.NOTION_DB_SUBMISSIONS;
const TEAM_DB        = process.env.NOTION_DB_TEAM;
const TASKS_DB       = process.env.NOTION_DB_TASKS;
const INPUTS_DB      = () => process.env.NOTION_DB_INPUTS;

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
  "S4":   "Architect",
  "S5":   "Architect",
  "A4.5": "Contractor",
  "AB":   "Project Team",
};

const STAGE_LOG_STATUS_MAP = {
  "S3":   { supported: false, statusField: null,        dateField: null,             grades: []                       },
  "S4":   { supported: true,  statusField: "S4 Status", dateField: "S4 Status Date", grades: ["A","B","C","NA"]      },
  "S5":   { supported: true,  statusField: "S5 Status", dateField: "S5 Status Date", grades: ["A","B","C","NA"]      },
  "A4.5": { supported: false, statusField: null,        dateField: null,             grades: []                       },
  "AB":   { supported: true,  statusField: "AB Status", dateField: "AB Status Date", grades: ["Approved","Rejected"] },
};

const BIC = {
  SUBMITTED: "DM",
  BOUNCED:   "DT",
  GRADED:    "DT",
};

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
  if (rawPath.startsWith(DROPBOX_ROOT)) return rawPath;
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
    const toFolder = `${before}/Rejected/R${qaRound}`;
    const to       = `${toFolder}/${filename}`;
    return { from: fullPath, to, toFolder };
  }
  if (action === "approve") {
    const toFolder = before;
    const to       = `${toFolder}/${filename}`;
    return { from: fullPath, to, toFolder };
  }
  return null;
}

// --- Path / filename parsers ---

function parsePath(filePath) {
  const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const pendingIdx = parts.findIndex((p) => p.toLowerCase() === "pending");
  if (pendingIdx < 3 || pendingIdx >= parts.length - 1) return null;
  const projectNo = parts[pendingIdx - 2];
  const stage     = parts[pendingIdx - 1];
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
  const [itemNo, drawingNo, revision, ...dtParts] = parts;
  const dtInitials = dtParts.join("_");
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

async function queryAll(notion, database_id, filter, sorts) {
  const results = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id, filter, sorts,
      ...(cursor ? { start_cursor: cursor } : {}),
      page_size: 100,
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
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

async function findOpenSubmission(notion, drawingPageId, stage) {
  const res = await notion.databases.query({
    database_id: SUBMISSIONS_DB,
    filter: {
      and: [
        { property: "Drawing", relation: { contains: drawingPageId } },
        { property: "Stage",   select:   { equals: stage }          },
        { property: "Status",  select:   { equals: "Submitted" }    },
      ],
    },
    page_size: 10,
  });
  return res.results[0] ?? null;
}

// Resolve DT name and email from the Team DB.
async function resolveDT(notion, dtIds) {
  if (!dtIds?.length) return { name: null, email: null };
  try {
    const dtPage = await notion.pages.retrieve({ page_id: dtIds[0] });
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

// Fire-and-forget POST to a Make.com webhook URL.
// Non-blocking — logged on error but never throws.
function fireWebhook(url, payload) {
  if (!url) return;
  fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  }).then((r) => {
    if (!r.ok) console.warn(`[make] Webhook returned ${r.status} — ${url}`);
  }).catch((err) => {
    console.warn(`[make] Webhook POST failed:`, err.message);
  });
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
    const { filePath, dropboxLink, dropboxPath } = req.body;
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
      const prev = await findOpenSubmission(notion, drawingPage.id, stage);
      if (prev) {
        qaRound = (getProp(prev, "QA Round", "number") ?? 1) + 1;
        notion.pages.update({ page_id: prev.id, properties: { "Status": { select: { name: "Rejected" } } } })
          .catch((e) => console.warn("[ingest] Supersede failed:", e.message));
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
      const fullRaw = dropboxPath ?? filePath;
      const shortPath = fullRaw.startsWith(DROPBOX_ROOT)
        ? fullRaw.slice(DROPBOX_ROOT.length).replace(/^\//, "")
        : fullRaw;
      submissionProps["Dropbox Path"] = { url: shortPath };
    }
    if (dtPage) submissionProps["DT"] = { relation: [{ id: dtPage.id }] };

    let newSubmission;
    try {
      newSubmission = await notion.pages.create({ parent: { database_id: SUBMISSIONS_DB }, properties: submissionProps });
    } catch (err) {
      return res.status(500).json({ ok: false, error: "Failed to create Submission", detail: err.message });
    }

    try {
      await notion.pages.update({
        page_id: drawingPage.id,
        properties: {
          "Drawing Status":   { select: { name: "DM Review"       } },
          "Submission Stage": { select: { name: STAGE_LABEL[stage] } },
          "Rev":              { select: { name: revision           } },
        },
      });
    } catch (err) { console.warn("[ingest] MDS update failed:", err.message); }

    console.log(`[ingest] created ${submissionTitle} (${newSubmission.id})`);
    return res.json({ ok: true, submissionId: newSubmission.id, submissionTitle, qaRound, isResubmission: qaRound > 1 });
  });

  // GET /api/df/submissions

  app.get("/api/df/submissions", async (req, res) => {
    const statusFilter = req.query.status || "Submitted";
    const validStatuses = ["Submitted", "Approved", "Awaiting Issue", "Issued", "Rejected", "Graded"];
    if (!validStatuses.includes(statusFilter)) return res.status(400).json({ error: `Invalid status: ${statusFilter}` });

    try {
      const results = await queryAll(notion, SUBMISSIONS_DB,
        { property: "Status", select: { equals: statusFilter } },
        [{ property: "BIC Since", direction: "ascending" }]
      );

      const submissions = await Promise.all(results.map(async (page) => {
        const title = getProp(page, "Submission", "title");
        const stage = getProp(page, "Stage",      "select");
        const dtIds = getProp(page, "DT",         "relation");
        const { taskCode, drawingNo } = parseSubmissionTitle(title, stage);
        const dtName = await resolveDTName(notion, dtIds);
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
          drawingIds:  getProp(page, "Drawing",      "relation"),
          taskIds:     getProp(page, "Item",         "relation"),
        };
      }));

      res.json({ submissions });
    } catch (err) {
      console.error("GET /api/df/submissions", err);
      res.status(500).json({ error: err.message });
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
    const dt              = await resolveDT(notion, dtIds);

    // Compute upload path so the DT knows where to save production files
    const { taskCode }  = parseSubmissionTitle(submissionTitle, stage);
    const projectNo     = taskCode ? taskCode.split("-").slice(0, 2).join("-") : "";
    const uploadPath    = projectNo ? `${DROPBOX_ROOT}/Drawing Submissions/${projectNo}/${stage}/` : null;

    // Make Scenario 2 (Actions Hub): Dropbox move + Gmail to DT with production instructions
    fireWebhook(process.env.MAKE_ACTIONS_WEBHOOK, {
      action: "approve",
      submissionId: id,
      submissionTitle,
      stage,
      reviewedAt,
      ...(uploadPath    ? { uploadPath }    : {}),
      ...(dropboxMove   ? { dropboxMove }   : {}),
      dtName:  dt.name,
      dtEmail: dt.email,
    });

    console.log(`[approve] ${id} => Awaiting Issue`);
    res.json({ ok: true, reviewedAt, ...(dropboxMove ? { dropboxMove } : {}) });
  });

  // PATCH /api/df/submissions/:id/issue
  // DM has issued drawings to client externally — updates Notion + MDS, fires DT notification.

  app.patch("/api/df/submissions/:id/issue", async (req, res) => {
    const { id } = req.params;
    let submissionPage;
    try { submissionPage = await notion.pages.retrieve({ page_id: id }); }
    catch { return res.status(404).json({ ok: false, error: "Submission not found" }); }

    const currentStatus = getProp(submissionPage, "Status", "select");
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
    const dtIds           = getProp(submissionPage, "DT",         "relation");
    const dt              = await resolveDT(notion, dtIds);

    fireWebhook(process.env.MAKE_ACTIONS_WEBHOOK, {
      action: "issue",
      submissionId: id,
      submissionTitle,
      stage,
      issuedDate,
      drawingStatus,
      dtName:  dt.name,
      dtEmail: dt.email,
    });

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
    const stage     = parts[dsIdx + 2];
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
  // After Notion writes: fires Make Scenario 3 (Dropbox move + Gmail to DT with comments).

  app.patch("/api/df/submissions/:id/bounce", async (req, res) => {
    const { id } = req.params;
    let submissionPage;
    try { submissionPage = await notion.pages.retrieve({ page_id: id }); }
    catch { return res.status(404).json({ ok: false, error: "Submission not found" }); }

    const qaRound   = getProp(submissionPage, "QA Round",     "number") ?? 1;
    const rawPath   = getProp(submissionPage, "Dropbox Path", "url");
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

    // Update Dropbox Path in Notion to reflect the new location after move
    if (dropboxMove?.to) {
      const newShortPath = dropboxMove.to.startsWith(DROPBOX_ROOT)
        ? dropboxMove.to.slice(DROPBOX_ROOT.length).replace(/^\//, "")
        : dropboxMove.to;
      notion.pages.update({ page_id: id, properties: {
        "Dropbox Path": { url: newShortPath }
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

    // Make Scenario 2 (Actions Hub): Dropbox move to /Rejected/R{n}/ + Gmail to DT with Miro link
    fireWebhook(process.env.MAKE_ACTIONS_WEBHOOK, {
      action: "bounce",
      submissionId: id,
      submissionTitle,
      stage,
      qaRound,
      bouncedAt,
      ...(miroLink ? { miroLink } : {}),
      dtName:  dt.name,
      dtEmail: dt.email,
      ...(dropboxMove ? { dropboxMove } : {}),
    });

    console.log(`[bounce] ${id}`);
    res.json({ ok: true, bouncedAt, ...(dropboxMove ? { dropboxMove } : {}) });
  });

  // PATCH /api/df/submissions/:id/log-status
  // After Notion writes: fires Make Scenario 4 (Gmail to DT, routed by stage + grade).

  app.patch("/api/df/submissions/:id/log-status", async (req, res) => {
    const { id } = req.params;
    const { grade } = req.body;
    let submissionPage;
    try { submissionPage = await notion.pages.retrieve({ page_id: id }); }
    catch { return res.status(404).json({ ok: false, error: "Submission not found" }); }

    const stage    = getProp(submissionPage, "Stage",   "select");
    const stageMap = STAGE_LOG_STATUS_MAP[stage];

    if (!stageMap || !stageMap.supported) {
      return res.status(400).json({ ok: false, error: `Log Status not supported for stage: ${stage}` });
    }
    if (!stageMap.grades.includes(grade)) {
      return res.status(400).json({ ok: false, error: `Invalid grade "${grade}" for ${stage}. Valid: ${stageMap.grades.join(", ")}` });
    }

    const drawingIds    = getProp(submissionPage, "Drawing", "relation");
    const gradedAt      = now();
    const isTerminal    = stage === "AB" && grade === "Approved";
    const returnsToDT   = !isTerminal;
    const drawingStatus = isTerminal ? "Complete" : "Approval Updates";

    try {
      await notion.pages.update({ page_id: id, properties: {
        "Status":        { select: { name: "Graded"     } },
        "DM Action":     { select: { name: "Log Status" } },
        "Client Grade":  { select: { name: grade        } },
        "Reviewed":      { date:   { start: gradedAt    } },
        "Ball In Court": returnsToDT ? { select: { name: BIC.GRADED } } : { select: null },
        "BIC Since":     returnsToDT ? { date:   { start: gradedAt  } } : { date:   null },
      }});
    } catch (err) {
      return res.status(500).json({ ok: false, error: "Submission update failed", detail: err.message });
    }

    for (const drawingId of drawingIds) {
      try {
        const mdsProps = { "Drawing Status": { select: { name: drawingStatus } } };
        if (stageMap.statusField) mdsProps[stageMap.statusField] = { select: { name: grade     } };
        if (stageMap.dateField)   mdsProps[stageMap.dateField]   = { date:   { start: gradedAt } };
        await notion.pages.update({ page_id: drawingId, properties: mdsProps });
      } catch (err) {
        console.warn(`[log-status] MDS failed for ${drawingId}:`, err.message);
      }
    }

    const submissionTitle = getProp(submissionPage, "Submission", "title");
    const dtIds           = getProp(submissionPage, "DT",         "relation");
    const dt              = await resolveDT(notion, dtIds);

    // Make Scenario 2 (Actions Hub): Gmail to DT — router branches by stage + grade
    fireWebhook(process.env.MAKE_ACTIONS_WEBHOOK, {
      action: "log-status",
      submissionId: id,
      submissionTitle,
      stage,
      grade,
      gradedAt,
      drawingStatus,
      isTerminal,
      dtName:  dt.name,
      dtEmail: dt.email,
    });

    console.log(`[log-status] ${id} => ${grade} => ${drawingStatus}`);
    res.json({ ok: true, grade, gradedAt, drawingStatus, isTerminal });
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
        s4Status:        getProp(page, "S4 Status",                "select"),
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

};
