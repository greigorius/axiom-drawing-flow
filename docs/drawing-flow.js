// drawing-flow.js — Axiom Drawing Flow API routes
// Mounted into the main Express app via:  require('./drawing-flow')(app, notion)
//
// Routes added:
//   POST   /api/df/ingest            Zapier → new file in /Pending/
//   GET    /api/df/submissions        Cockpit queue poll (status = Submitted)
//   PATCH  /api/df/submissions/:id/approve
//   PATCH  /api/df/submissions/:id/bounce
//   PATCH  /api/df/submissions/:id/log-status
//   GET    /api/df/drawings           MDS drawing-level view

"use strict";

// ─── DB IDs (from env) ────────────────────────────────────────────────────────
// Add to your .env:
//   NOTION_DB_DRAWINGS=13b210e4582e8168923ff79fa8628b59   # = your MDS
//   NOTION_DB_SUBMISSIONS=36f210e4582e80ed8b2ce9e245bda433
//   NOTION_DB_TEAM=348210e4582e8050ac70fd18982185cc
//   NOTION_DB_TASKS=<already set in app.js — reused here>

const DRAWINGS_DB    = process.env.NOTION_DB_DRAWINGS;    // MDS
const SUBMISSIONS_DB = process.env.NOTION_DB_SUBMISSIONS;
const TEAM_DB        = process.env.NOTION_DB_TEAM;
const TASKS_DB       = process.env.NOTION_DB_TASKS;       // already set

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_STAGES = ["S3", "S4", "S5", "A4.5"];

// Maps short stage code → MDS Submission Stage select value (verbose)
const STAGE_LABEL = {
  "S3":   "S3 - For Coordination",
  "S4":   "S4 - For Review and Authorisation",
  "S5":   "S5 - For Review and Acceptance",
  "A4.5": "A4.5 - Authorised for Manufacture and Construction",
};

// On Approve: which MDS date field and checkbox does each stage write?
const STAGE_APPROVE_MAP = {
  "S3":   { dateField: "Model Submit Date",          checkbox: null },
  "S4":   { dateField: "S4 Submit Date (Actual)",    checkbox: null },
  "S5":   { dateField: "S5 Submit Date (Actual)",    checkbox: null },
  "A4.5": { dateField: "C01 Submit Date (Actual)",   checkbox: null },
  // Checkboxes are being retired per NOTION-MIGRATION-CHECKLIST.md section 4.
  // Set to null here; enable temporarily if you still rely on them.
};

// On Log Status: which MDS status field and date field does each stage write?
const STAGE_LOG_STATUS_MAP = {
  "S3":   { statusField: null,        dateField: null              },
  "S4":   { statusField: "S4 Status", dateField: "S4 Status Date"  },
  "S5":   { statusField: "S5 Status", dateField: "S5 Status Date"  },
  "A4.5": { statusField: null,        dateField: "C01 Sign Off"    },
};

// BIC value written at each lifecycle transition
const BIC = {
  SUBMITTED: "DM",
  BOUNCED:   "DT",
  ISSUED:    "Architect",   // adjust to Contractor if needed per project
  GRADED_BC: "DT",
};

// ─── Dropbox path helpers ─────────────────────────────────────────────────────

/**
 * Compute a Dropbox move instruction for Zapier.
 * action: "bounce" → /Rejected/R{qaRound}/
 * action: "approve" → stage root (removes /Pending/)
 *
 * rawPath must be the original /Pending/ file path stored on the Submission.
 * Returns null if rawPath is missing or doesn't contain /Pending/.
 */
function computeDropboxMove(rawPath, action, qaRound) {
  if (!rawPath || !rawPath.includes("/Pending/")) return null;
  if (action === "bounce") {
    return {
      from: rawPath,
      to: rawPath.replace("/Pending/", `/Rejected/R${qaRound}/`),
    };
  }
  if (action === "approve") {
    return {
      from: rawPath,
      to: rawPath.replace("/Pending/", "/"),
    };
  }
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse the file path Zapier sends.
 * Expected: /DESIGN KNOW HOW/TMJ Interiors/Drawing Submissions/{ProjectNo}/{Stage}/Pending/{filename}
 * Returns null if the path doesn't match the expected protocol.
 */
function parsePath(filePath) {
  // Normalise separators
  const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  // Expect: ["DESIGN KNOW HOW/TMJ Interiors/Drawing Submissions", projectNo, stage, "Pending", filename]
  // Allow the root folder to have any capitalisation / spacing
  const pendingIdx = parts.findIndex((p) => p.toLowerCase() === "pending");
  if (pendingIdx < 3 || pendingIdx >= parts.length - 1) return null;

  const projectNo = parts[pendingIdx - 2];
  const stage     = parts[pendingIdx - 1];
  const filename  = parts[pendingIdx + 1];

  if (!VALID_STAGES.includes(stage)) return null;

  return { projectNo, stage, filename };
}

/**
 * Parse the filename into its constituent parts.
 * Convention: {ItemNo}_{DrawingNo}_{Rev}_{DTinitials}.pdf
 * e.g.        003_A-101_P01_GM.pdf
 * Returns null if the filename doesn't conform.
 */
function parseFilename(filename) {
  // Strip extension — only .pdf accepted (DWG submitted post-approval, not here)
  const ext = filename.split(".").pop().toLowerCase();
  if (ext !== "pdf") return null;

  const base   = filename.slice(0, -(ext.length + 1));
  const parts  = base.split("_");
  if (parts.length < 4) return null;

  const [itemNo, drawingNo, revision, ...dtParts] = parts;
  const dtInitials = dtParts.join("_"); // handle initials with underscores if ever needed

  if (!itemNo || !drawingNo || !revision || !dtInitials) return null;

  return { itemNo, drawingNo, revision, dtInitials };
}

/**
 * Paginate through a Notion database query, collecting all results.
 */
async function queryAll(notion, database_id, filter, sorts = []) {
  const results = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id,
      filter,
      sorts,
      ...(cursor ? { start_cursor: cursor } : {}),
      page_size: 100,
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

/**
 * Get a property value from a Notion page object, safely.
 * Covers the property types used across MDS, Tasks, Submissions, and Team.
 */
function getProp(page, name, type) {
  const prop = page.properties?.[name];
  if (!prop) return null;
  switch (type) {
    case "title":       return prop.title?.[0]?.plain_text ?? null;
    case "rich_text":   return prop.rich_text?.[0]?.plain_text ?? null;
    case "select":      return prop.select?.name ?? null;
    case "number":      return prop.number ?? null;
    case "date":        return prop.date?.start ?? null;
    case "checkbox":    return prop.checkbox ?? false;
    case "email":       return prop.email ?? null;
    case "url":         return prop.url ?? null;
    case "relation":    return prop.relation?.map((r) => r.id) ?? [];
    case "rollup":      return prop.rollup ?? null;
    default:            return null;
  }
}

/**
 * ISO timestamp for right now.
 */
function now() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (Notion date format)
}

// ─── Notion lookups ───────────────────────────────────────────────────────────

/**
 * Find a Task page by Item No. and Project No.
 * Item No. is a short code (e.g. "003") stored as a number or rich_text on the Task.
 * We search by the title / Drawing Ref and match projectNo via the Projects relation.
 * Returns the Notion page object or null.
 */
async function findTask(notion, projectNo, itemNo) {
  // Try matching on "Item No." number property first, then fall back to title scan.
  // Adjust the filter property name to match your actual Tasks DB schema.
  const res = await notion.databases.query({
    database_id: TASKS_DB,
    filter: {
      and: [
        {
          property: "Item No.",  // ← confirm this is the correct property name
          number: { equals: parseInt(itemNo, 10) },
        },
      ],
    },
    page_size: 50,
  });

  if (!res.results.length) return null;

  // Filter by project if multiple items share the same number across projects
  // (Item No. should be unique per project, but validate via Projects rollup)
  for (const page of res.results) {
    const projectsRollup = getProp(page, "Projects", "rollup");
    // Projects rollup returns an array of rich_text entries in this schema
    const projectNames = projectsRollup?.array?.map((r) => r.rich_text?.[0]?.plain_text) ?? [];
    if (projectNames.some((n) => n?.includes(projectNo))) return page;
  }

  // If rollup match fails, return first result (single-project setups)
  return res.results[0] ?? null;
}

/**
 * Find a Drawing (MDS row) by Drawing No., scoped to a Task.
 * Drawing No. in the MDS is stored without the project prefix per the Dropbox convention.
 * e.g. "A-101" in the filename maps to the MDS title which may be "24-367-A-101"
 * — we match on contains rather than exact to handle the prefix.
 */
async function findDrawing(notion, drawingNo, taskPageId) {
  const res = await notion.databases.query({
    database_id: DRAWINGS_DB,
    filter: {
      and: [
        {
          property: "Drawing Number", // ← MDS title property name
          title: { contains: drawingNo },
        },
        {
          property: "Item",           // ← relation to Tasks DB
          relation: { contains: taskPageId },
        },
      ],
    },
    page_size: 10,
  });
  return res.results[0] ?? null;
}

/**
 * Find a Team member by their initials.
 * Team DB should have an "Initials" text property.
 */
async function findDT(notion, initials) {
  const res = await notion.databases.query({
    database_id: TEAM_DB,
    filter: {
      property: "Initials",    // ← confirm property name in your Team DB
      rich_text: { equals: initials.toUpperCase() },
    },
    page_size: 5,
  });
  return res.results[0] ?? null;
}

/**
 * Find an open Submission for this drawing + stage (Status = Submitted).
 * Used to detect resubmissions and increment QA Round.
 */
async function findOpenSubmission(notion, drawingPageId, stage) {
  const res = await notion.databases.query({
    database_id: SUBMISSIONS_DB,
    filter: {
      and: [
        {
          property: "Drawing",
          relation: { contains: drawingPageId },
        },
        {
          property: "Stage",
          select: { equals: stage },
        },
        {
          property: "Status",
          status: { equals: "Submitted" },
        },
      ],
    },
    page_size: 10,
  });
  return res.results[0] ?? null;
}

// ─── Route factory ────────────────────────────────────────────────────────────

module.exports = function mountDrawingFlow(app, notion) {

  // ── POST /api/df/ingest ────────────────────────────────────────────────────
  // Called by Zapier when a new PDF lands in /Pending/.
  // Body (from Zapier): { filePath, dropboxLink }
  //
  // Steps:
  //  1. Parse path and filename → extract projectNo, stage, itemNo, drawingNo, rev, dt
  //  2. Validate stage, extension, filename format
  //  3. Look up Task, Drawing, DT in Notion
  //  4. Check for open Submission (resubmission vs first submit)
  //  5. Create Submission row
  //  6. Update MDS Drawing Status → "DM Review"
  //  7. Return result to Zapier (200 = success, 4xx = parse error, 5xx = Notion error)

  app.post("/api/df/ingest", async (req, res) => {
    const { filePath, dropboxLink, dropboxPath } = req.body;

    if (!filePath) {
      return res.status(400).json({ ok: false, error: "Missing filePath in request body" });
    }

    // ── 1. Parse path ──────────────────────────────────────────────────────
    const pathParts = parsePath(filePath);
    if (!pathParts) {
      return res.status(400).json({
        ok: false,
        error: "File path does not match expected protocol",
        expected: "/DESIGN KNOW HOW/TMJ Interiors/Drawing Submissions/{ProjectNo}/{Stage}/Pending/{filename}",
        received: filePath,
      });
    }
    const { projectNo, stage, filename } = pathParts;

    // ── 2. Parse filename ──────────────────────────────────────────────────
    const fileParts = parseFilename(filename);
    if (!fileParts) {
      return res.status(400).json({
        ok: false,
        error: "Filename does not match expected convention",
        expected: "{ItemNo}_{DrawingNo}_{Rev}_{DTinitials}.pdf",
        received: filename,
      });
    }
    const { itemNo, drawingNo, revision, dtInitials } = fileParts;

    console.log(`[ingest] ${projectNo}/${stage}/${filename} → item=${itemNo} drawing=${drawingNo} rev=${revision} dt=${dtInitials}`);

    // ── 3. Notion lookups ──────────────────────────────────────────────────
    let taskPage, drawingPage, dtPage;

    try {
      taskPage = await findTask(notion, projectNo, itemNo);
    } catch (err) {
      console.error("[ingest] Task lookup failed", err);
      return res.status(500).json({ ok: false, error: "Task lookup failed", detail: err.message });
    }

    if (!taskPage) {
      return res.status(422).json({
        ok: false,
        error: "Task not found",
        detail: `No Task with Item No. "${itemNo}" found in project ${projectNo}. Check the Item No. in the filename.`,
      });
    }

    try {
      drawingPage = await findDrawing(notion, drawingNo, taskPage.id);
    } catch (err) {
      console.error("[ingest] Drawing lookup failed", err);
      return res.status(500).json({ ok: false, error: "Drawing lookup failed", detail: err.message });
    }

    if (!drawingPage) {
      return res.status(422).json({
        ok: false,
        error: "Drawing not found in MDS",
        detail: `No MDS row found matching drawing "${drawingNo}" on Task "${getProp(taskPage, "Item Name", "title")}". Create the drawing row in Notion first.`,
      });
    }

    try {
      dtPage = await findDT(notion, dtInitials);
    } catch (err) {
      // DT lookup failure is non-fatal — we log the warning and continue without the relation
      console.warn(`[ingest] DT lookup failed for initials "${dtInitials}":`, err.message);
    }

    // ── 4. Resubmission check ──────────────────────────────────────────────
    let qaRound = 1;
    let previousSubmission = null;

    try {
      previousSubmission = await findOpenSubmission(notion, drawingPage.id, stage);
    } catch (err) {
      console.warn("[ingest] Open submission check failed:", err.message);
    }

    if (previousSubmission) {
      const prevRound = getProp(previousSubmission, "QA Round", "number") ?? 1;
      qaRound = prevRound + 1;
      console.log(`[ingest] Resubmission detected — previous round: ${prevRound}, new round: ${qaRound}`);

      // Mark the previous open Submission as superseded (Rejected)
      // so findOpenSubmission won't pick it up again on the next resubmit
      try {
        await notion.pages.update({
          page_id: previousSubmission.id,
          properties: {
            "Status": { status: { name: "Rejected" } },
          },
        });
      } catch (err) {
        console.warn("[ingest] Could not mark previous submission as superseded:", err.message);
        // Non-fatal — continue with creating the new submission
      }
    }

    // ── 5. Create Submission row ───────────────────────────────────────────
    const submissionTitle = `${projectNo}-${itemNo.padStart(3, "0")}_${drawingNo}_${stage}_R${qaRound}`;

    const submissionProps = {
      "Submission": {
        title: [{ text: { content: submissionTitle } }],
      },
      "Drawing": {
        relation: [{ id: drawingPage.id }],
      },
      "Task": {
        relation: [{ id: taskPage.id }],
      },
      "Stage": {
        select: { name: stage },
      },
      "Revision": {
        select: { name: revision },
      },
      "QA Round": {
        number: qaRound,
      },
      "Status": {
        status: { name: "Submitted" },
      },
      "Submitted": {
        date: { start: now() },
      },
      "Ball In Court": {
        select: { name: BIC.SUBMITTED },
      },
      "BIC Since": {
        date: { start: now() },
      },
    };

    // Store the raw file path (for move instructions) and the shareable link separately.
    // Zapier body should send both: { filePath, dropboxLink, dropboxPath }
    // dropboxPath = raw path e.g. /DESIGN KNOW HOW/TMJ Interiors/Drawing Submissions/24-367/S4/Pending/003_A-101_P01_GM.pdf
    // dropboxLink = shareable URL (for human reference)
    const { dropboxLink, dropboxPath } = req.body;
    if (dropboxLink) {
      submissionProps["Dropbox Link"] = { url: dropboxLink };
    }
    // Store the raw path in a rich_text property "Dropbox Path" on the Submission DB.
    // This is what the bounce/approve routes read to compute move instructions for Zapier.
    if (dropboxPath || filePath) {
      submissionProps["Dropbox Path"] = {
        rich_text: [{ text: { content: dropboxPath ?? filePath } }],
      };
    }

    // Link DT if found
    if (dtPage) {
      submissionProps["DT"] = { relation: [{ id: dtPage.id }] };
    }

    let newSubmission;
    try {
      newSubmission = await notion.pages.create({
        parent: { database_id: SUBMISSIONS_DB },
        properties: submissionProps,
      });
    } catch (err) {
      console.error("[ingest] Failed to create Submission row", err);
      return res.status(500).json({ ok: false, error: "Failed to create Submission", detail: err.message });
    }

    // ── 6. Update MDS Drawing Status ───────────────────────────────────────
    try {
      await notion.pages.update({
        page_id: drawingPage.id,
        properties: {
          "Drawing Status":   { select: { name: "DM Review" } },
          "Submission Stage": { select: { name: STAGE_LABEL[stage] } },
          "Rev":              { select: { name: revision } },
        },
      });
    } catch (err) {
      // Non-fatal — Submission already created; log and continue
      console.warn("[ingest] MDS update failed (submission row exists):", err.message);
    }

    // ── 7. Respond ─────────────────────────────────────────────────────────
    console.log(`[ingest] ✅ Created submission ${submissionTitle} (id: ${newSubmission.id})`);
    return res.json({
      ok: true,
      submissionId:    newSubmission.id,
      submissionTitle,
      qaRound,
      isResubmission:  qaRound > 1,
      drawingId:       drawingPage.id,
      taskId:          taskPage.id,
    });
  });

  // ── GET /api/df/submissions ────────────────────────────────────────────────
  // Cockpit queue — returns all Submissions with Status = Submitted,
  // sorted by BIC Since ascending (longest-waiting first).

  app.get("/api/df/submissions", async (req, res) => {
    try {
      const results = await queryAll(notion, SUBMISSIONS_DB, {
        property: "Status",
        status: { equals: "Submitted" },
      }, [
        { property: "BIC Since", direction: "ascending" },
      ]);

      const submissions = results.map((page) => ({
        id:           page.id,
        title:        getProp(page, "Submission",   "title"),
        stage:        getProp(page, "Stage",        "select"),
        revision:     getProp(page, "Revision",     "select"),
        qaRound:      getProp(page, "QA Round",     "number"),
        status:       getProp(page, "Status",       "select"),
        bic:          getProp(page, "Ball In Court","select"),
        bicSince:     getProp(page, "BIC Since",   "date"),
        submitted:    getProp(page, "Submitted",   "date"),
        dropboxLink:  getProp(page, "Dropbox Link", "url"),
        dropboxPath:  getProp(page, "Dropbox Path", "rich_text"),
        drawingIds:   getProp(page, "Drawing",     "relation"),
        taskIds:      getProp(page, "Task",        "relation"),
      }));

      res.json({ submissions });
    } catch (err) {
      console.error("GET /api/df/submissions", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── PATCH /api/df/submissions/:id/approve ─────────────────────────────────
  // DM Approve button (internal QA gate passed).
  // Writes MDS stage date + Drawing Status = Client Review.
  // Sends Gmail confirmation to DT (stub — wire up Gmail transport separately).

  app.patch("/api/df/submissions/:id/approve", async (req, res) => {
    const { id } = req.params;

    let submissionPage;
    try {
      submissionPage = await notion.pages.retrieve({ page_id: id });
    } catch (err) {
      return res.status(404).json({ ok: false, error: "Submission not found" });
    }

    const stage      = getProp(submissionPage, "Stage",        "select");
    const revision   = getProp(submissionPage, "Revision",     "select");
    const drawingIds = getProp(submissionPage, "Drawing",      "relation");
    const taskIds    = getProp(submissionPage, "Task",         "relation");
    const rawPath    = getProp(submissionPage, "Dropbox Path", "rich_text");

    const stageMap = STAGE_APPROVE_MAP[stage];
    if (!stageMap) {
      return res.status(400).json({ ok: false, error: `Unknown stage: ${stage}` });
    }

    const issuedDate = now();
    const errors = [];

    // ── Update Submission ──────────────────────────────────────────────────
    try {
      await notion.pages.update({
        page_id: id,
        properties: {
          "Status":        { status: { name: "Issued" } },
          "DM Action":     { select: { name: "Approve" } },
          "Issued":        { date: { start: issuedDate } },
          "Reviewed":      { date: { start: issuedDate } },
          "Ball In Court": { select: { name: BIC.ISSUED } },
          "BIC Since":     { date: { start: issuedDate } },
        },
      });
    } catch (err) {
      console.error("[approve] Submission update failed", err);
      return res.status(500).json({ ok: false, error: "Submission update failed", detail: err.message });
    }

    // ── Update MDS Drawing ─────────────────────────────────────────────────
    for (const drawingId of drawingIds) {
      const mdsProps = {
        "Drawing Status": { select: { name: "Client Review" } },
        [stageMap.dateField]: { date: { start: issuedDate } },
      };
      try {
        await notion.pages.update({ page_id: drawingId, properties: mdsProps });
      } catch (err) {
        console.warn(`[approve] MDS update failed for drawing ${drawingId}:`, err.message);
        errors.push(`MDS update failed: ${drawingId}`);
      }
    }

    // ── TODO: send Gmail confirmation to DT ───────────────────────────────
    // Wire up Gmail transport in a separate gmailService.js module.
    // sendApprovalEmail({ dtPageId, submissionTitle, stage, revision, issuedDate });

    // ── Compute Dropbox move instruction for Zapier ────────────────────────
    // Approved file promotes from /Pending/ to the stage root — the clean "issued" record.
    const dropboxMove = computeDropboxMove(rawPath, "approve", null);

    console.log(`[approve] ✅ Submission ${id} approved — stage: ${stage}, issued: ${issuedDate}`);
    res.json({ ok: true, issuedDate, ...(dropboxMove ? { dropboxMove } : {}), errors: errors.length ? errors : undefined });
  });

  // ── PATCH /api/df/submissions/:id/bounce ──────────────────────────────────
  // DM Bounce button (internal QA gate failed).
  // Marks Submission Rejected, notifies DT to revise and resubmit.
  // Body: { comments: string }

  app.patch("/api/df/submissions/:id/bounce", async (req, res) => {
    const { id } = req.params;
    const { comments } = req.body;

    let submissionPage;
    try {
      submissionPage = await notion.pages.retrieve({ page_id: id });
    } catch (err) {
      return res.status(404).json({ ok: false, error: "Submission not found" });
    }

    const drawingIds  = getProp(submissionPage, "Drawing",      "relation");
    const qaRound     = getProp(submissionPage, "QA Round",     "number") ?? 1;
    const rawPath     = getProp(submissionPage, "Dropbox Path", "rich_text");
    const bouncedAt   = now();

    // ── Update Submission ──────────────────────────────────────────────────
    try {
      const props = {
        "Status":        { status: { name: "Rejected" } },
        "DM Action":     { select: { name: "Bounce" } },
        "Reviewed":      { date: { start: bouncedAt } },
        "Ball In Court": { select: { name: BIC.BOUNCED } },
        "BIC Since":     { date: { start: bouncedAt } },
      };
      if (comments) {
        props["DM Comments"] = {
          rich_text: [{ text: { content: comments } }],
        };
      }
      await notion.pages.update({ page_id: id, properties: props });
    } catch (err) {
      console.error("[bounce] Submission update failed", err);
      return res.status(500).json({ ok: false, error: "Submission update failed", detail: err.message });
    }

    // ── Update MDS Drawing Status (stays DM Review — drawing not yet issued) ─
    // No status change needed; Drawing Status remains "DM Review".
    // The next resubmission's ingest will handle any further updates.

    // ── TODO: send Gmail revision request to DT ───────────────────────────
    // sendBounceEmail({ dtPageId, submissionTitle, stage, revision, comments });

    // ── Compute Dropbox move instruction for Zapier ────────────────────────
    // Zapier reads dropboxMove from this response and runs a "Move File" action.
    // File moves from /Pending/ to /Rejected/R{N}/ for audit trail.
    const dropboxMove = computeDropboxMove(rawPath, "bounce", qaRound);

    console.log(`[bounce] ✅ Submission ${id} bounced — comments: ${comments?.slice(0, 60) ?? "(none)"}`);
    res.json({ ok: true, bouncedAt, ...(dropboxMove ? { dropboxMove } : {}) });
  });

  // ── PATCH /api/df/submissions/:id/log-status ──────────────────────────────
  // External gate — record client's A/B/C grading after issue.
  // Body: { grade: "A" | "B" | "C" | "NA" }

  app.patch("/api/df/submissions/:id/log-status", async (req, res) => {
    const { id } = req.params;
    const { grade } = req.body;

    const validGrades = ["A", "B", "C", "NA"];
    if (!validGrades.includes(grade)) {
      return res.status(400).json({ ok: false, error: `Invalid grade "${grade}". Must be A, B, C, or NA.` });
    }

    let submissionPage;
    try {
      submissionPage = await notion.pages.retrieve({ page_id: id });
    } catch (err) {
      return res.status(404).json({ ok: false, error: "Submission not found" });
    }

    const stage      = getProp(submissionPage, "Stage",   "select");
    const drawingIds = getProp(submissionPage, "Drawing", "relation");
    const gradedAt   = now();
    const isRevision = ["B", "C"].includes(grade);

    const stageMap = STAGE_LOG_STATUS_MAP[stage];
    if (!stageMap) {
      return res.status(400).json({ ok: false, error: `Unknown stage: ${stage}` });
    }

    // ── Update Submission ──────────────────────────────────────────────────
    try {
      await notion.pages.update({
        page_id: id,
        properties: {
          "Status":         { status: { name: "Graded" } },
          "DM Action":      { select: { name: "Log Status" } },
          "Client Grade":   { select: { name: grade } },
          "Reviewed":       { date: { start: gradedAt } },
          "Ball In Court":  { select: { name: isRevision ? BIC.GRADED_BC : null } },
          "BIC Since":      isRevision ? { date: { start: gradedAt } } : { date: null },
        },
      });
    } catch (err) {
      console.error("[log-status] Submission update failed", err);
      return res.status(500).json({ ok: false, error: "Submission update failed", detail: err.message });
    }

    // ── Update MDS Drawing ─────────────────────────────────────────────────
    for (const drawingId of drawingIds) {
      const mdsProps = {};

      // Drawing Status
      mdsProps["Drawing Status"] = {
        select: { name: isRevision ? "Being Revised" : "Production Update" },
      };

      // Stage-specific status field (S4 Status, S5 Status)
      if (stageMap.statusField) {
        mdsProps[stageMap.statusField] = { select: { name: grade } };
      }

      // Stage-specific date field
      if (stageMap.dateField) {
        mdsProps[stageMap.dateField] = { date: { start: gradedAt } };
      }

      try {
        await notion.pages.update({ page_id: drawingId, properties: mdsProps });
      } catch (err) {
        console.warn(`[log-status] MDS update failed for drawing ${drawingId}:`, err.message);
      }
    }

    // ── TODO: send Gmail to DT notifying of grade ─────────────────────────
    // sendGradeEmail({ dtPageId, submissionTitle, stage, grade, isRevision });

    console.log(`[log-status] ✅ Submission ${id} graded ${grade} — stage: ${stage}`);
    res.json({ ok: true, grade, gradedAt, requiresRevision: isRevision });
  });

  // ── GET /api/df/drawings ──────────────────────────────────────────────────
  // MDS drawing-level view — all drawings with a current status, for the cockpit.

  app.get("/api/df/drawings", async (req, res) => {
    const { taskId, stage, status } = req.query;

    const filters = [];

    if (taskId) {
      filters.push({ property: "Item", relation: { contains: taskId } });
    }
    if (stage) {
      filters.push({ property: "Submission Stage", select: { equals: STAGE_LABEL[stage] ?? stage } });
    }
    if (status) {
      filters.push({ property: "Drawing Status", select: { equals: status } });
    }

    const filter = filters.length === 1
      ? filters[0]
      : filters.length > 1
        ? { and: filters }
        : undefined;

    try {
      const results = await queryAll(notion, DRAWINGS_DB, filter);

      const drawings = results.map((page) => ({
        id:              page.id,
        drawingNumber:   getProp(page, "Drawing Number",    "title"),
        drawingStatus:   getProp(page, "Drawing Status",    "select"),
        submissionStage: getProp(page, "Submission Stage",  "select"),
        revision:        getProp(page, "Rev",               "select"),
        s4Status:        getProp(page, "S4 Status",         "select"),
        s5Status:        getProp(page, "S5 Status",         "select"),
        s4SubmitActual:  getProp(page, "S4 Submit Date (Actual)", "date"),
        s5SubmitActual:  getProp(page, "S5 Submit Date (Actual)", "date"),
        taskIds:         getProp(page, "Item",              "relation"),
      }));

      res.json({ drawings });
    } catch (err) {
      console.error("GET /api/df/drawings", err);
      res.status(500).json({ error: err.message });
    }
  });

};
