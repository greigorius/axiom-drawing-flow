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
//   GET    /api/df/activity-log        ?taskId&projectId&days&limit&tag&source&from&to — Item Activity Feed
//   GET    /api/df/activity-position   ?projectId&taskId — live state from A&I + RFIs (not the log)
//   GET    /api/df/activity-export     ?<same filters as activity-log> — XLSX of exactly what's on screen
//   GET    /api/df/notifications        cockpit ingest-run feed (created/skipped/error), newest first
//   POST   /api/df/notifications/clear  clears the feed once reviewed
//
// Make.com integration:
//   Scenario 1 (Ingest):      Make watches Dropbox Drawing Submissions (recursive), filters /pending/,
//                             and calls POST /api/df/ingest. One Pending folder per project;
//                             filename = {Item}_{Stage}_{Rev}_{DrawingNo}_{Initials}.pdf
//   Scenario 2 (Actions Hub): backend fires MAKE_ACTIONS_WEBHOOK with action=dt-summary|grade-summary
//                             (batch emails), action=approve|bounce (Dropbox move + folder link), or
//                             action=move-files (client comments → Reviewed/R_, A4.5/PRD Rejected → 05_Client Comments,
//                             A4.5/PRD Approved → 06_Signed Off, Issue → 04_Issued)
//   Review happens in Drawboard PDF, synced back to the same Dropbox file before the DM acts.
//                             See docs/MAKE-CONFIG-GUIDE.md for full configuration steps

"use strict";

const { getStore } = require("@netlify/blobs");

// --- DB IDs ---
const DRAWINGS_DB    = process.env.NOTION_DB_DRAWINGS;
const SUBMISSIONS_DB = process.env.NOTION_DB_SUBMISSIONS;
const TEAM_DB        = process.env.NOTION_DB_TEAM;
const TASKS_DB       = process.env.NOTION_DB_TASKS;
const INPUTS_DB      = () => process.env.NOTION_DB_INPUTS;
const ACTIVITY_LOG_DB = process.env.NOTION_DB_ACTIVITY_LOG;
const ACTIONS_INFO_DB = process.env.NOTION_DB_ACTIONS_INFO;
const RFIS_DB         = process.env.NOTION_DB_RFIS;

// Whether an RFI sitting at Raise/Open counts as a blocker on its item. Provisional: on by
// default so the blocker strip has real content from day one, but whether *every* open RFI
// genuinely blocks is a call to make from live data, not in advance (handoff doc §13).
// Flip this one line to drop RFIs out of the blocked count and the blocker strip.
const OPEN_RFIS_BLOCK = true;

// --- Stage constants ---

const VALID_STAGES = ["S3", "S4", "S5", "A4.5", "PRD", "AB"];

const STAGE_LABEL = {
  "S3":   "S3 - For Coordination",
  "S4":   "S4 - For Review and Authorisation",
  "S5":   "S5 - For Review and Acceptance",
  "A4.5": "A4.5 - Authorised Mfg. & Constr. Design",
  "PRD":  "PRD - For Production",
  "AB":   "AB - As Built Record Drawings",
};

const STAGE_APPROVE_MAP = {
  "S3":   { dateField: "Model Submit Date"            },
  "S4":   { dateField: "S4 Submit Date (Actual)"      },
  "S5":   { dateField: "S5 Submit Date (Actual)"      },
  "A4.5": { dateField: "C01 Submit Date (Actual)"     },
  // PRD reuses the existing production milestone date rather than a new column.
  "PRD":  { dateField: "Schedule Production (Actual)" },
  "AB":   { dateField: "AB Submit Date (Actual)"      },
};

// PRD sits with the factory, not the client — "Client Review" is the generic
// "issued, awaiting a response" bucket; Ball In Court below says who holds it.
const STAGE_APPROVE_DRAWING_STATUS = {
  "S3":   "Client Review",
  "S4":   "Client Review",
  "S5":   "Client Review",
  "A4.5": "Client Review",
  "PRD":  "Client Review",
  "AB":   "Client Review",
};

// NOTE: Add "Document Control" to Submissions DB BIC select options,
//       then change "AB" entry from "Project Team" to "Document Control".
const STAGE_APPROVE_BIC = {
  "S3":   "Architect",
  "S4":   "Contractor",   // MC & consultants review
  "S5":   "Architect",    // Client review
  "A4.5": "Contractor",   // MC sign-off
  "PRD":  "Production",   // factory reviews production drawings
  "AB":   "Project Team",
};

const STAGE_LOG_STATUS_MAP = {
  "S3":   { supported: false, statusField: null,        dateField: null,             grades: []                       },
  "S4":   { supported: true,  statusField: "S4 Status", dateField: "S4 Status Date", grades: ["A","B","C","NA"]      },
  "S5":   { supported: true,  statusField: "S5 Status", dateField: "S5 Status Date", grades: ["A","B","C","NA"]      },
  "A4.5": { supported: true,  statusField: null,         dateField: "C01 Sign Off",    grades: ["Approved","Rejected"] },
  // PRD is graded by the factory. Rejected restarts the flow at the next revision,
  // so unlike A4.5's sign-off date, PRD Status Date is written for both outcomes.
  "PRD":  { supported: true,  statusField: "PRD Status", dateField: "PRD Status Date", grades: ["Approved","Rejected"] },
  "AB":   { supported: true,  statusField: "AB Status",  dateField: "AB Status Date",  grades: ["Approved","Rejected"] },
};

// Stages where grading moves the submitted PDF itself:
//   Rejected → {ProjectNo}/05_Client Comments/{...}_Rejected_{YYMMDD}.pdf
//   Approved → {ProjectNo}/06_Signed Off/{filename}
// A4.5 is signed off by the contractor, PRD by the factory; the mechanics are identical.
// These stages also defer their Drawing Status write to POST /api/df/send-grade-emails,
// where Ball In Court actually flips from DM to DT.
const GRADE_MOVE_STAGES = ["A4.5", "PRD"];
const movesPdfOnGrade = (stage) => GRADE_MOVE_STAGES.includes(stage);

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

// Project-level folder layout (Sept 2026 restructure). Every submission for a project
// goes into ONE Pending folder — the stage travels in the filename, not the folder.
// Folders are numbered so they sort in workflow order:
//
//   Drawing Submissions/{ProjectNo}/
//     01_Pending/            ← DTs upload here: {Item}_{Stage}_{Rev}_{DrawingNo}_{Initials}.pdf
//     02_Rejected/           ← Bounce moves the file here as {original name}_R{n}.pdf
//     03_Ready For Issue/    ← Approve moves the file here, filename unchanged; DTs add DWGs here
//     04_Issued/             ← Issue (cockpit) moves the PDF here, filename unchanged
//     05_Client Comments/    ← all client returns, told apart by filename:
//                               client comment PDFs  {YYMMDD}_{Commenter}_{Item}_{Stage}_{Rev}_{DrawingNo}.pdf  (graded → Reviewed/R_{name})
//                               A4.5 (C01) & PRD Rejected  {Item}_{Stage}_{Rev}_{DrawingNo}_Rejected_{YYMMDD}.pdf
//     06_Signed Off/         ← A4.5 (C01) & PRD Approved: the PDF moves here from 04_Issued, filename unchanged
//
// Folder matching ignores the "NN_" prefix, so un-numbered folders (Pending, Rejected …)
// from before the numbering still work.
//
// LEGACY: the old per-stage layout — Drawing Submissions/{ProjectNo}/{Stage}/Pending/ with
// {Item}_{DrawingNo}_{Rev}_{Initials}.pdf filenames — is still understood, so drawings that
// were already in flight when the restructure landed keep working. Once nothing is left in
// the old stage Pending folders, the legacy branches below can be deleted.
const FOLDER = {
  PENDING:         "01_Pending",
  REJECTED:        "02_Rejected",
  READY_FOR_ISSUE: "03_Ready For Issue",
  ISSUED:          "04_Issued",
  CLIENT_COMMENTS: "05_Client Comments",
  SIGNED_OFF:      "06_Signed Off",     // A4.5 (C01) & PRD Approved
  GRADE_RETURNS:   "Grade Returns",     // LEGACY stage-folder layout only: {ProjectNo}/{Stage}/Grade Returns
  REVIEWED:        "Reviewed",          // …/Client Comments/Reviewed/R_{name} once the DM has graded
};
const REVIEWED_PREFIX = "R_";

// Bounce appends _R1/_R2 to the rejected PDF. The DT keeps the rest of the name, so strip only
// that suffix when matching a name back to its submission (e.g. a DWG uploaded after approval).
const BOUNCE_SUFFIX_RE = /_R\d+$/i;
function stripBounceSuffix(baseName) {
  return (baseName || "").replace(BOUNCE_SUFFIX_RE, "");
}

// "01_Pending", "Pending", "pending" all match FOLDER.PENDING.
function folderBase(seg) {
  return (seg || "").trim().replace(/^\d+_/, "").toLowerCase();
}
function isFolder(seg, name) {
  return folderBase(seg) === folderBase(name);
}

function toFullDropboxPath(rawPath) {
  if (!rawPath) return null;
  // Case-insensitive check — path_lower from Make will be lowercase
  if (rawPath.toLowerCase().startsWith(DROPBOX_ROOT.toLowerCase())) return rawPath;
  return `${DROPBOX_ROOT}/${rawPath.replace(/^\//, "")}`;
}

// Inverse of toFullDropboxPath — the form stored in Notion's "Dropbox Path" property.
function toShortDropboxPath(fullPath) {
  if (!fullPath) return null;
  return fullPath.toLowerCase().startsWith(DROPBOX_ROOT.toLowerCase())
    ? fullPath.slice(DROPBOX_ROOT.length).replace(/^\//, "")
    : fullPath;
}

// DTs type the A4.5 stage various ways ("A45", "A4-5") because dots read oddly in filenames.
// Everything downstream uses the canonical "A4.5".
const STAGE_ALIASES = { "A45": "A4.5", "A4-5": "A4.5" };
function normalizeStage(seg) {
  const raw = (seg || "").trim().toUpperCase();
  return STAGE_ALIASES[raw] || raw;
}
function isStage(seg) {
  return VALID_STAGES.includes(normalizeStage(seg));
}

// Finds the Drawing Submissions/{ProjectNo} anchor in any Dropbox path.
//   projectRoot — full path to the {ProjectNo} folder (move destinations hang off this)
//   stageSeg    — set only for LEGACY paths, where a stage folder sits directly under the project
function locateProject(rawPath) {
  const full = toFullDropboxPath(rawPath);
  if (!full) return null;
  const segs  = full.replace(/\\/g, "/").split("/").filter(Boolean);
  const dsIdx = segs.findIndex((s) => s.toLowerCase() === "drawing submissions");
  if (dsIdx < 0 || dsIdx + 1 >= segs.length) return null;
  const next = segs[dsIdx + 2];
  return {
    fullPath:    "/" + segs.join("/"),
    segs,
    projectNo:   segs[dsIdx + 1],
    projectRoot: "/" + segs.slice(0, dsIdx + 2).join("/"),
    stageSeg:    isStage(next) ? next : null,
  };
}

// Where C01 (A4.5) Rejected returns for this submission live.
// New layout → {ProjectNo}/05_Client Comments itself — architect or principal contractor, it's all
// "the client". No subfolder: the filename tells a C01 return apart from a client comment PDF.
// Legacy stage-folder paths keep {ProjectNo}/{Stage}/Grade Returns.
function gradeReturnsFolder(rawPath) {
  const loc = locateProject(rawPath);
  if (!loc) return null;
  return loc.stageSeg
    ? `${loc.projectRoot}/${loc.stageSeg}/${FOLDER.GRADE_RETURNS}`
    : `${loc.projectRoot}/${FOLDER.CLIENT_COMMENTS}`;
}

// {Item}_{Stage}_{Rev}_{DrawingNo}_{Grade}_{YYMMDD}.pdf — a C01 return written by Log Status.
// Scan Comments skips these: they sit in 05_Client Comments but aren't client comment PDFs.
const GRADE_RETURN_NAME_RE = /_(Rejected|Approved)_\d{6}\.pdf$/i;
function isGradeReturnName(name) {
  return GRADE_RETURN_NAME_RE.test(name || "");
}

// Client comment PDF → {its Client Comments folder}/Reviewed/R_{name}, fired when the DM logs
// the grade in the Hub (after reviewing the PDF in Drawboard). Works for both the new
// {ProjectNo}/Client Comments/ and legacy {ProjectNo}/{Stage}/Client Comments/ locations.
// Returns null for anything already reviewed (in Reviewed/ or R_-prefixed).
function computeReviewedMove(rawPath) {
  const full = toFullDropboxPath(rawPath);
  if (!full) return null;
  const segs     = full.split("/").filter(Boolean);
  const filename = segs[segs.length - 1];
  const parent   = segs[segs.length - 2] || "";
  if (isFolder(parent, FOLDER.REVIEWED)) return null;
  if (filename.toUpperCase().startsWith(REVIEWED_PREFIX)) return null;
  const toFolderParent = "/" + segs.slice(0, -1).join("/");
  const toFolder       = `${toFolderParent}/${FOLDER.REVIEWED}`;
  const newFilename    = `${REVIEWED_PREFIX}${filename}`;
  return { from: "/" + segs.join("/"), to: `${toFolder}/${newFilename}`, toFolder, toFolderParent,
           toFolderName: FOLDER.REVIEWED, newFilename };
}

// A4.5 (C01) & PRD Rejected: the issued copy moves out of 04_Issued/ into 05_Client Comments/, renamed in
// the submission order with the grade and date appended:
//   {Item}_{Stage}_{Rev}_{DrawingNo}_{Grade}_{YYMMDD}.pdf
function computeGradeReturnMove(rawPath, { itemNo, stage, revision, drawingNo, grade, date }) {
  const full     = toFullDropboxPath(rawPath);
  const toFolder = gradeReturnsFolder(rawPath);
  if (!full || !toFolder || !itemNo || !drawingNo) return null;
  const parent = full.split("/").filter(Boolean).slice(-2, -1)[0] || "";
  // Already returned (re-grade) — nothing to move.
  if (isFolder(parent, FOLDER.CLIENT_COMMENTS) || isFolder(parent, FOLDER.GRADE_RETURNS)) return null;
  const dateTag     = (date || now()).replace(/-/g, "").slice(2);   // YYYY-MM-DD → YYMMDD
  const newFilename = `${itemNo}_${stage}_${revision}_${drawingNo}_${grade}_${dateTag}.pdf`;
  const toFolderParts  = toFolder.split("/");
  const toFolderParent = toFolderParts.slice(0, -1).join("/");
  return { from: full, to: `${toFolder}/${newFilename}`, toFolder, toFolderParent,
           toFolderName: toFolderParts[toFolderParts.length - 1], newFilename };
}

// A4.5 (C01) & PRD Approved: the issued PDF moves to {ProjectNo}/06_Signed Off/, filename unchanged.
// Only a project-level copy moves (04_Issued, or 03_Ready For Issue / "Approved" if it was never
// issued through the cockpit). Legacy {Stage}/… copies and anything already signed off stay put.
function computeSignedOffMove(rawPath) {
  const loc = locateProject(rawPath);
  if (!loc) return null;
  const { segs, fullPath, projectRoot } = loc;
  const parent = segs[segs.length - 2];
  const fromOk = isFolder(parent, FOLDER.ISSUED) || isFolder(parent, FOLDER.READY_FOR_ISSUE) || isFolder(parent, "Approved");
  if (!fromOk) return null;
  if (segs.length - 2 !== segs.findIndex((s) => s.toLowerCase() === "drawing submissions") + 2) return null;
  const filename = segs[segs.length - 1];
  const toFolder = `${projectRoot}/${FOLDER.SIGNED_OFF}`;
  return { from: fullPath, to: `${toFolder}/${filename}`, toFolder, toFolderParent: projectRoot,
           toFolderName: FOLDER.SIGNED_OFF, newFilename: filename };
}

// Notion rich_text segments are capped at 2000 chars — split long newline lists across segments.
function richTextChunks(str, max = 1900) {
  const out = [];
  for (let i = 0; i < (str || "").length; i += max) out.push({ type: "text", text: { content: str.slice(i, i + max) } });
  return out;
}
function readPathList(page, prop) {
  return (getProp(page, prop, "rich_text") || "").split("\n").map((p) => p.trim()).filter(Boolean);
}

// Issue: the approved PDF moves from 03_Ready For Issue/ to 04_Issued/, filename unchanged.
// Only files sitting in the Ready For Issue folder (or the short-lived un-numbered "Approved"
// folder) move — legacy {Stage}/Suffix NNN/ copies are left where they are.
function computeIssueMove(rawPath) {
  const loc = locateProject(rawPath);
  if (!loc) return null;
  const { segs, fullPath, projectRoot } = loc;
  const parent = segs[segs.length - 2];
  if (!isFolder(parent, FOLDER.READY_FOR_ISSUE) && !isFolder(parent, "Approved")) return null;
  if (segs.length - 2 !== segs.findIndex((s) => s.toLowerCase() === "drawing submissions") + 2) return null;
  const filename = segs[segs.length - 1];
  const toFolder = `${projectRoot}/${FOLDER.ISSUED}`;
  return { from: fullPath, to: `${toFolder}/${filename}`, toFolder, toFolderParent: projectRoot,
           toFolderName: FOLDER.ISSUED, newFilename: filename };
}

// Dropbox move instruction for approve / bounce. Only a file still sitting directly in a
// Pending folder can be moved — anything else returns null (as before).
//   approve → {ProjectNo}/03_Ready For Issue/{filename}  (filename unchanged)
//   bounce  → {ProjectNo}/Rejected/{name}_R{qaRound}.pdf
// Legacy stage-folder files go to the same project-level folders, so there's one place to look.
// Field names match what the Make Actions Hub routes already map (toFolderParent/toFolderName
// for Create Folder, from/toFolder/newFilename for Move).
function computeDropboxMove(rawPath, action, qaRound) {
  const loc = locateProject(rawPath);
  if (!loc) return null;
  const { segs, fullPath, projectRoot } = loc;
  if (!isFolder(segs[segs.length - 2], FOLDER.PENDING)) return null;

  const filename  = segs[segs.length - 1];
  // Lenient parse — the file is already ingested; we only want item/drawing/stage for the payload.
  const dotIdx    = filename.lastIndexOf(".");
  const parsed    = parseSubmissionName(dotIdx > 0 ? filename.slice(0, dotIdx) : filename, { requireInitials: false });
  const itemNo    = parsed.ok ? parsed.itemNo    : (filename.split("_")[0] ?? "");
  const drawingNo = parsed.ok ? parsed.drawingNo : null;
  const stage     = (parsed.ok && parsed.stage) || (loc.stageSeg ? loc.stageSeg.toUpperCase() : null);
  const toFolderParent = projectRoot;

  if (action === "approve") {
    const toFolderName = FOLDER.READY_FOR_ISSUE;
    const toFolder     = `${toFolderParent}/${toFolderName}`;
    const newFilename  = filename;
    return { from: fullPath, to: `${toFolder}/${newFilename}`, toFolder, toFolderParent, toFolderName,
             newFilename, itemNo, drawingNo, stage };
  }
  if (action === "bounce") {
    const round        = qaRound ?? 1;
    const toFolderName = FOLDER.REJECTED;
    const toFolder     = `${toFolderParent}/${toFolderName}`;
    const dot          = filename.lastIndexOf(".");
    const newFilename  = dot > 0
      ? `${filename.slice(0, dot)}_R${round}${filename.slice(dot)}`
      : `${filename}_R${round}`;
    return { from: fullPath, to: `${toFolder}/${newFilename}`, toFolder, toFolderParent, toFolderName,
             rFolder: toFolder, newFilename, itemNo, drawingNo, stage, qaRound: round };
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

// Accepts a file sitting DIRECTLY inside a Pending folder under Drawing Submissions:
//   new:    Drawing Submissions/{ProjectNo}/Pending/{file}
//   legacy: Drawing Submissions/{ProjectNo}/{Stage}/Pending/{file}
// Returns { projectNo, folderStage (legacy only, else null), filename, layout } or null.
function parsePath(filePath) {
  const parts      = (filePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  const pendingIdx = parts.findIndex((p) => isFolder(p, FOLDER.PENDING));
  if (pendingIdx < 2 || pendingIdx !== parts.length - 2) return null;   // file must sit directly in Pending/
  const filename = parts[pendingIdx + 1];
  const above    = parts[pendingIdx - 1];

  if (isStage(above)) {
    if (pendingIdx < 3 || parts[pendingIdx - 3].toLowerCase() !== "drawing submissions") return null;
    return { projectNo: parts[pendingIdx - 2].toUpperCase(), folderStage: above.toUpperCase(), filename, layout: "legacy" };
  }
  if (parts[pendingIdx - 2].toLowerCase() !== "drawing submissions") return null;
  return { projectNo: above.toUpperCase(), folderStage: null, filename, layout: "project" };
}

// Items can have derivatives in Notion — "Suffix 200" and "Suffix 200_1" are different items.
// Filenames carry the derivative the same way: 200_1_S4_P01_{DrawingNo}_{Initials}.pdf
const ITEM_RE     = /^\d{1,4}(?:_\d{1,2})?$/;   // 003, 112, 200_1
function padItemNo(itemNo) {
  const [base, sub] = String(itemNo ?? "").trim().split("_");
  const padded = (base || "").padStart(3, "0");
  return sub ? `${padded}_${sub}` : padded;
}
// "Suffix 200_1 - LIN-804 …" → "200_1"; "Suffix 22 - …" → "022". Anything else → null.
// getProp(…, "title") concatenates Notion's rich-text runs and re-encodes bold/italic as
// markdown, so a task titled with "Suffix 112 - " in bold reads back as
// "**Suffix 112 - **B2 Glazed Screen Bulkhead". The item-number regex below is anchored at
// the start of the string, so those markers made it miss and findTask() returned "Task not
// found" for a task that plainly exists. Strip emphasis markers first.
// Asterisks never appear in an item number. Underscores do — but only between digits
// ("200_1"), so only underscores that aren't digit-flanked are emphasis and get dropped.
function stripMarkdownEmphasis(text) {
  return String(text ?? "").replace(/\*/g, "").replace(/(?<!\d)_|_(?!\d)/g, "");
}

function itemNoFromTaskName(taskName) {
  const m = /^\s*suffix\s*(\d{1,4}(?:_\d{1,2})?)(?![\d_])/i.exec(stripMarkdownEmphasis(taskName));
  return m ? padItemNo(m[1]) : null;
}
const REV_RE      = /^[A-Z]{1,2}\d{1,3}[A-Z]?$/; // P01, C01, P01A
const INITIALS_RE = /^[A-Z]{2,4}$/;              // GF, AI
const DRAWING_NO_RE = /^[A-Z0-9][A-Z0-9.\-]*$/i;  // EIT-TMJ-AA-B2-D-I-45120

// Client comment PDF names (dropped into {ProjectNo}/05_Client Comments by the DM):
//   current: {YYMMDD}_{Commenter}_{Item}_{Stage}_{Rev}_{DrawingNo}   e.g. 260604_F&P_200_S4_P01_EIT-TMJ-AA-B3-D-I-24217
//            Rev may be left out, or put after the drawing number — the Issued submission fills it in.
//   older:   {Commenter}_{YYMMDD}_{DrawingNo}_{Rev}                  e.g. MC_260910_EIT-TMJ-AA-B2-D-I-45120_P02
// Returns { ok: true, format, date, commenter, itemNo, stage, revision, drawingNo } or { ok: false, error }.
const CLIENT_COMMENT_NAME_HINT = "{YYMMDD}_{Commenter}_{Item}_{Stage}_{Rev}_{DrawingNo}.pdf";
function parseClientCommentName(baseName) {
  const parts = (baseName || "").trim().split("_").filter((x) => x !== "");
  const isDate = (x) => /^\d{6}$/.test(x || "");
  const isRev  = (x) => REV_RE.test((x || "").toUpperCase());
  const bad = (error) => ({ ok: false, error });

  if (isDate(parts[0])) {
    if (parts.length < 5) return bad(`Too few sections — expected ${CLIENT_COMMENT_NAME_HINT}`);
    // Derivative item ("200_1") — glue it back together, as in submission filenames.
    if (parts.length >= 6 && !isStage(parts[3]) && /^\d{1,4}$/.test(parts[2]) && /^\d{1,2}$/.test(parts[3]) && isStage(parts[4])) {
      parts.splice(2, 2, `${parts[2]}_${parts[3]}`);
    }
    const [date, commenter, itemNo, stageRaw, ...rest] = parts;
    const stage = normalizeStage(stageRaw);
    if (!ITEM_RE.test(itemNo)) return bad(`"${itemNo}" isn't an item number — expected ${CLIENT_COMMENT_NAME_HINT}`);
    if (!VALID_STAGES.includes(stage)) return bad(`"${stageRaw}" isn't a stage (${VALID_STAGES.join(" / ")}) — expected ${CLIENT_COMMENT_NAME_HINT}`);
    let revision = null, dwgParts = rest;
    if (rest.length >= 2 && isRev(rest[0]))                    { revision = rest[0].toUpperCase();               dwgParts = rest.slice(1); }
    else if (rest.length >= 2 && isRev(rest[rest.length - 1])) { revision = rest[rest.length - 1].toUpperCase(); dwgParts = rest.slice(0, -1); }
    if (dwgParts.length !== 1 || !DRAWING_NO_RE.test(dwgParts[0])) {
      return bad(`Couldn't read the drawing number from "${dwgParts.join("_")}" — expected ${CLIENT_COMMENT_NAME_HINT}`);
    }
    return { ok: true, format: "current", date, commenter, itemNo, stage, revision, drawingNo: dwgParts[0] };
  }

  if (parts.length >= 4 && isDate(parts[1])) {
    return { ok: true, format: "older", date: parts[1], commenter: parts[0], itemNo: null, stage: null,
             revision: parts[parts.length - 1].toUpperCase(), drawingNo: parts.slice(2, -1).join("_") };
  }
  return bad(`Client comment filename should be ${CLIENT_COMMENT_NAME_HINT}`);
}

// Stages whose client comments are tracked on the MDS (`<stage> Comment Files` / `<stage> Client Reviewers`).
// PRD is deliberately absent: the factory grades Approved/Rejected in the Hub rather than
// returning marked-up PDFs, so there are no `PRD Comment Files` / `PRD Client Reviewers`
// properties. A PRD comment PDF dropped into 05_Client Comments is rejected by cr-ingest
// with a clear message. Add "PRD" here (and both MDS properties) if that changes.
// PRD grade returns written by log-status are unaffected — isGradeReturnName() skips them.
const COMMENT_STAGES = ["S4", "S5", "A4.5"];

// Parses a submission name WITHOUT caring about the extension (so it also works for DWGs).
//   new:    {Item}_{Stage}_{Rev}_{DrawingNo}_{DTInitials}   e.g. 003_S4_P01_EIT-TMJ-AA-B2-D-I-45120_GF
//           (initials are required for PDF submissions — they set the DT on the Notion row;
//            pass { requireInitials: false } for DWGs, which may omit them)
//   legacy: {Item}_{DrawingNo}_{Rev}_{DTInitials}           e.g. 003_A-101_P01_GF   (no stage — comes from folder)
// Returns { ok: true, format, itemNo, stage, revision, drawingNo, dtInitials }
//      or { ok: false, error } with a message written for the DT, shown in the cockpit feed.
function parseSubmissionName(baseName, { requireInitials = true } = {}) {
  const fail  = (error) => ({ ok: false, error });
  // Dropbox / Drawboard duplicate copies: "… (1)", "… (Greig's conflicted copy 2026-09-10)".
  if (/\((?:\d+|[^)]*conflicted copy[^)]*|[^)]*copy)\)\s*$/i.test(baseName || "")) {
    return fail("Looks like a duplicate copy (\"(1)\" / \"conflicted copy\") — check which version is current, then delete or rename it");
  }
  const parts = (baseName || "").trim().split("_").map((s) => s.trim());
  if (parts.length < 2 || parts.some((p) => !p)) {
    return fail("Filename should be {Item}_{Stage}_{Rev}_{DrawingNo}_{Initials} — check for missing sections or double/trailing underscores");
  }
  // Derivative item ("200_1"): the underscore inside it looks like a separator, so glue the
  // first two sections back together when the stage turns up one section later than expected.
  if (parts.length >= 5 && !isStage(parts[1]) && /^\d{1,4}$/.test(parts[0]) && /^\d{1,2}$/.test(parts[1]) && isStage(parts[2])) {
    parts.splice(0, 2, `${parts[0]}_${parts[1]}`);
  }

  // New convention — the stage is the 2nd section.
  if (isStage(parts[1])) {
    if (parts.length < 4) return fail(`Only ${parts.length} sections — expected {Item}_{Stage}_{Rev}_{DrawingNo}_{Initials}`);
    if (parts.length === 4 && requireInitials) return fail("DT initials missing — add them at the end: {Item}_{Stage}_{Rev}_{DrawingNo}_{Initials}.pdf (e.g. …_GF.pdf)");
    if (parts.length > 5) return fail("Too many underscores — use hyphens inside the drawing number; the 5th section is your initials");
    const [itemNo, stageRaw, revRaw, drawingRaw, initialsRaw] = parts;
    if (!ITEM_RE.test(itemNo)) return fail(`Item "${itemNo}" should be the item number in digits, e.g. 003 (or 200_1 for a derivative item)`);
    const revision = revRaw.toUpperCase();
    if (!REV_RE.test(revision)) return fail(`Rev "${revRaw}" not recognised — expected e.g. P01 or C01`);
    if (!DRAWING_NO_RE.test(drawingRaw)) return fail(`Drawing number "${drawingRaw}" has spaces or odd characters — letters, digits, hyphens and dots only`);
    let dtInitials = null;
    if (initialsRaw !== undefined) {
      dtInitials = initialsRaw.toUpperCase();
      if (!INITIALS_RE.test(dtInitials)) return fail(`5th section "${initialsRaw}" should be your initials (2–4 letters, e.g. GF)`);
    }
    return { ok: true, format: "v2", itemNo, stage: normalizeStage(stageRaw), revision, drawingNo: drawingRaw.toUpperCase(), dtInitials };
  }

  // Legacy convention — only valid in the old per-stage Pending folders (ingest enforces that).
  if (parts.length >= 4) {
    const [itemNo, drawingNoRaw, revisionRaw, ...dtParts] = parts;
    const revision = revisionRaw.toUpperCase();
    // Drawing numbers always contain hyphens — this stops a mistyped stage (e.g. "S6") being
    // read as an old-style drawing number.
    if (ITEM_RE.test(itemNo) && drawingNoRaw.includes("-") && REV_RE.test(revision)) {
      return { ok: true, format: "legacy", itemNo, stage: null, revision,
               drawingNo: drawingNoRaw.toUpperCase(), dtInitials: dtParts.join("_").toUpperCase() || null };
    }
  }
  return fail(`2nd section "${parts[1]}" isn't a stage — expected {Item}_{Stage}_{Rev}_{DrawingNo}_{Initials} with stage ${VALID_STAGES.join("/")}`);
}

function parseFilename(filename) {
  const name = (filename || "").trim();
  const dot  = name.lastIndexOf(".");
  const ext  = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (ext !== "pdf") return { ok: false, error: "Not a PDF" };
  return parseSubmissionName(name.slice(0, dot));
}

// Titles are {ProjectNo}-{Item}_{DrawingNo}_{Stage}_R{n}. The item can itself contain an
// underscore ("200_1"), so work back from the stage marker instead of forward from the first
// underscore; fall back to the old forward read when the stage isn't in the title.
function parseSubmissionTitle(title, stage) {
  if (!title) return { taskCode: null, drawingNo: null };
  const firstUnder = title.indexOf("_");
  if (firstUnder < 0) return { taskCode: title, drawingNo: null };
  const stageIdx = stage ? title.lastIndexOf(`_${stage}_`) : -1;
  if (stageIdx > 0) {
    const head      = title.slice(0, stageIdx);        // {ProjectNo}-{Item}_{DrawingNo}
    const lastUnder = head.lastIndexOf("_");
    if (lastUnder > 0) return { taskCode: head.slice(0, lastUnder), drawingNo: head.slice(lastUnder + 1) };
  }
  const taskCode = title.slice(0, firstUnder);
  const rest     = title.slice(firstUnder + 1);
  const restIdx  = stage ? rest.lastIndexOf(`_${stage}_`) : -1;
  return { taskCode, drawingNo: restIdx >= 0 ? rest.slice(0, restIdx) : rest.split("_")[0] };
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

// Notion's REST API represents bold, italic, etc. as an `annotations` flag on each
// rich_text segment — never as literal characters. Wrap bold segments in "**...**" here
// so the frontend's lightweight markdown renderer (which just looks for "**text**") can
// show real Notion bold formatting without needing a separate structured text format.
// Real line breaks need no special handling — Notion preserves them as literal "\n"
// inside a segment's plain_text, and that comes straight through the join below.
function richTextToMarkdown(t) {
  const text = t.plain_text ?? "";
  return t.annotations?.bold ? `**${text}**` : text;
}

function getProp(page, name, type) {
  const prop = page.properties?.[name];
  if (!prop) return null;
  switch (type) {
    // Notion splits title/rich_text into multiple array segments whenever formatting
    // changes (bold, links, etc.) — reading only [0] silently truncates at the first
    // formatting run. Concatenate every segment instead (via richTextToMarkdown, which
    // also re-encodes bold annotations as "**...**" for the frontend to parse).
    case "title":     return prop.title?.map(richTextToMarkdown).join("") || null;
    case "rich_text": return prop.rich_text?.map(richTextToMarkdown).join("") || null;
    case "select":    return prop.select?.name ?? null;
    case "status":    return prop.status?.name ?? null;
    case "number":    return prop.number ?? null;
    case "date":      return prop.date?.start ?? null;
    case "checkbox":  return prop.checkbox ?? false;
    case "email":     return prop.email ?? null;
    case "url":       return prop.url ?? null;
    case "relation":  return prop.relation?.map((r) => r.id) ?? [];
    case "rollup":    return prop.rollup ?? null;
    // Internal Notion-hosted files ("file") carry a presigned S3 URL that expires after
    // ~1hr — fine for opening right after a fresh API fetch (which is all this app does),
    // but the URL must not be cached or reused past that window. External files (pasted
    // links) don't expire.
    case "files":
      return prop.files?.map((f) => ({
        name: f.name ?? null,
        url:  f.type === "external" ? (f.external?.url ?? null) : (f.file?.url ?? null),
      })).filter((f) => f.url) ?? [];
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
  const paddedItemNo = padItemNo(itemNo);
  const res = await notion.databases.query({
    database_id: TASKS_DB,
    filter: { property: "Item Name", title: { contains: `Suffix ${paddedItemNo}` } },
    page_size: 50,
  });
  if (!res.results.length) return null;

  // "Suffix 200" must not match "Suffix 200_1" — they're separate items, and the Item No.
  // formula reads the same for both. Read the number off the title instead, and only fall
  // back to the formula when the title doesn't follow the convention at all.
  const byName = res.results.filter(
    (page) => itemNoFromTaskName(getProp(page, "Item Name", "title")) === paddedItemNo
  );
  // "Item No." is a formula: it can come back as a number (112) rather than a string,
  // so normalise both sides before comparing — a strict === against "112" never matched.
  const byFormula = res.results.filter(
    (page) => padItemNo(getProp(page, "Item No.", "formula")) === paddedItemNo
  );
  const candidates = byName.length ? byName : byFormula.length ? byFormula : [];
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  for (const page of candidates) {
    const roll  = getProp(page, "Projects", "rollup");
    const names = roll?.array?.map((r) => r.rich_text?.[0]?.plain_text) ?? [];
    if (names.some((n) => n?.includes(projectNo))) return page;
  }
  return candidates[0] ?? null;
}

// Email subjects only ever give us an item number, never a project — unlike findTask()
// above (used by Drawing Flow, which always knows the project from the Dropbox folder
// path already), so there's no way to disambiguate if the same item number happens to
// exist in more than one project. Guessing wrong would mis-link an email to someone
// else's item, which is worse than leaving it unlinked for manual review — so, unlike
// findTask(), this returns null whenever the match isn't unique instead of falling back
// to a best guess.
async function findTaskByItemNo(notion, itemNo) {
  const paddedItemNo = padItemNo(itemNo);
  const res = await notion.databases.query({
    database_id: TASKS_DB,
    filter: { property: "Item Name", title: { contains: `Suffix ${paddedItemNo}` } },
    page_size: 50,
  });
  if (!res.results.length) return null;
  const byName = res.results.filter(
    (page) => itemNoFromTaskName(getProp(page, "Item Name", "title")) === paddedItemNo
  );
  // "Item No." is a formula: it can come back as a number (112) rather than a string,
  // so normalise both sides before comparing — a strict === against "112" never matched.
  const byFormula = res.results.filter(
    (page) => padItemNo(getProp(page, "Item No.", "formula")) === paddedItemNo
  );
  const candidates = byName.length ? byName : byFormula.length ? byFormula : [];
  return candidates.length === 1 ? candidates[0] : null;
}

// Looks for an item number the same way Drawing Flow filenames already encode one
// ("Suffix 022") — the one convention already used consistently across this codebase.
// Bare numbers, drawing numbers, or client references aren't attempted; a false-positive
// match is worse than no match, so this is deliberately conservative.
function parseItemNoFromSubject(subject) {
  const m = /suffix\s*0*(\d{1,4}(?:_\d{1,2})?)/i.exec(subject || "");
  return m ? m[1] : null;
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

// Finds an existing Submission whose Dropbox Path exactly matches — used by ingest to guard
// against re-processing the same physical file. Make's Watch Files trigger can re-surface a
// file still sitting in Pending (a manual "Run once", a trigger reset, an at-least-once
// retry); without this check that would mint a brand-new Submission — and QA Round — every
// time, even though nothing about the file changed. A genuine resubmission after a bounce
// always carries a new revision code in its filename, so its Dropbox Path always differs
// from the previous one — this only catches true re-sends of the identical file.
async function findSubmissionByDropboxPath(notion, shortPath) {
  if (!shortPath) return null;
  const res = await notion.databases.query({
    database_id: SUBMISSIONS_DB,
    filter: { property: "Dropbox Path", url: { equals: shortPath } },
    page_size: 1,
  });
  return res.results[0] ?? null;
}

// Same file, new path: if a Pending folder was renamed (e.g. "Pending" → "01_Pending"),
// Make re-surfaces every file in it at its new path and the exact-path check above misses.
// A still-Submitted row in the same project whose file has the same name and also sat in a
// Pending folder is that file — return it so ingest can repoint it instead of duplicating it.
async function findMovedPendingSubmission(notion, shortPath) {
  const loc = locateProject(shortPath);
  if (!loc) return null;
  const filename = loc.segs[loc.segs.length - 1];
  const res = await notion.databases.query({
    database_id: SUBMISSIONS_DB,
    filter: { and: [
      { property: "Dropbox Path", url:    { ends_with: `/${filename}` } },
      { property: "Status",       select: { equals: "Submitted" } },
    ] },
    page_size: 10,
  });
  return res.results.find((page) => {
    const other = locateProject(getProp(page, "Dropbox Path", "url"));
    return other
      && other.projectNo.toLowerCase() === loc.projectNo.toLowerCase()
      && isFolder(other.segs[other.segs.length - 2], FOLDER.PENDING);
  }) ?? null;
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

// --- Activity Log lookups ---

// Resolve all Task page IDs belonging to a Project — the Activity Log DB only relates
// to Tasks, not Projects directly, so "all activity for this project" is built by first
// finding its tasks, then OR-ing the Task relation filter across all of their IDs.
async function findTaskIdsForProject(notion, projectId) {
  // Tasks DB's relation to Projects DB is named "Project" (singular) — confirmed by
  // getRevisionDays above, which walks this same relation. There's a separate rollup
  // property named "Projects" (plural, used elsewhere to search project names as text),
  // which isn't relation-filterable and would 400 if used here.
  const results = await queryAll(notion, TASKS_DB, { property: "Project", relation: { contains: projectId } });
  return results.map((p) => p.id);
}

// Request-scoped Task/Project resolver — dedupes repeated lookups so a feed spanning many
// entries against the same handful of items (a global or project-scoped view) only hits
// Notion once per unique Task and once per unique Project, not once per entry. Same
// pattern as makeDTResolver above. Returns { taskName, projectName } per Task id.
function makeTaskNameResolver(notion) {
  const taskCache    = new Map(); // taskId -> Promise<{taskName, projectName}>
  const projectCache = new Map(); // projectId -> Promise<string|null>

  function resolveProjectName(projectId) {
    if (!projectId) return Promise.resolve(null);
    if (!projectCache.has(projectId)) {
      projectCache.set(projectId, withNotionRetry(() => notion.pages.retrieve({ page_id: projectId }))
        .then((page) => getProp(page, "Project Name", "title"))
        .catch(() => null));
    }
    return projectCache.get(projectId);
  }

  return function resolveCached(taskId) {
    if (!taskId) return Promise.resolve({ taskName: null, projectName: null });
    if (!taskCache.has(taskId)) {
      taskCache.set(taskId, withNotionRetry(() => notion.pages.retrieve({ page_id: taskId }))
        .then(async (page) => {
          const taskName    = getProp(page, "Item Name", "title");
          const projectId   = getProp(page, "Project", "relation")?.[0] ?? null;
          const projectName = await resolveProjectName(projectId);
          return { taskName, projectName };
        })
        .catch(() => ({ taskName: null, projectName: null })));
    }
    return taskCache.get(taskId);
  };
}

// --- Activity Log helper ---

// Notion hard-limits a single rich_text `text.content` string to 2000 characters — every
// entry every existing call site produces is short (code-generated summaries), so this
// never mattered before. Email bodies routinely will exceed it, and Notion 400s on the
// whole request if it's over, which createActivityLogEntry's catch below would otherwise
// swallow silently (entry just never gets written, no visible error anywhere).
function truncateForNotion(str, max = 1900) {
  if (!str) return str;
  return str.length > max ? str.slice(0, max) + "… (truncated)" : str;
}

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
      "Entry":  { title:    [{ text: { content: truncateForNotion(entry) } }] },
      "Source": { select:   { name: source } },
      "Tag":    { select:   { name: tag } },
      "Author": { rich_text: [{ text: { content: truncateForNotion(author || "System") } }] },
    };
    if (taskId) properties["Task"]   = { relation: [{ id: taskId }] };
    if (detail) properties["Detail"] = { rich_text: [{ text: { content: truncateForNotion(detail) } }] };
    if (link)   properties["Link"]   = { url: link };

    await notion.pages.create({ parent: { database_id: ACTIVITY_LOG_DB }, properties });
  } catch (err) {
    console.warn("[activity-log] write failed:", err.message);
  }
}

// --- Cockpit notifications ---
//
// A separate, disposable feed from the Activity Log above — this is not project history,
// it's an operational heads-up so whoever has the cockpit open knows the ingest trigger
// actually ran and what it did (created / skipped / errored), without having to go digging
// through Make execution logs or Netlify function logs. The cockpit polls this, toasts new
// entries, and lets the user clear the list once they're happy everything's been reviewed.
//
// Backed by Netlify Blobs (zero setup — auto-provisioned per site) rather than a new Notion
// database, since this is deliberately ephemeral and shouldn't need sharing/schema work.
// getStore() only resolves automatically inside a deployed Netlify Function or `netlify dev`
// — plain `node server.js` locally has no Blobs context, so every call is wrapped and just
// warns rather than breaking ingest if it fails.
const NOTIFICATIONS_STORE = "cockpit-notifications";
const NOTIFICATIONS_KEY   = "feed";
const NOTIFICATIONS_MAX   = 200;

// type: "success" | "skip" | "error"
async function addNotification({ type, filename, message }) {
  try {
    const store   = getStore(NOTIFICATIONS_STORE);
    const current = (await store.get(NOTIFICATIONS_KEY, { type: "json" })) || [];
    const entry = {
      id:       `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts:       new Date().toISOString(),
      type,
      filename: filename ?? null,
      message,
    };
    // Simple read-modify-write — fine at this volume (a handful of ingests per poll window);
    // not worth adding locking for the rare case two land in the same instant.
    await store.setJSON(NOTIFICATIONS_KEY, [entry, ...current].slice(0, NOTIFICATIONS_MAX));
  } catch (err) {
    console.warn("[notifications] write failed:", err.message);
  }
}

async function getNotifications() {
  try {
    const store = getStore(NOTIFICATIONS_STORE);
    return (await store.get(NOTIFICATIONS_KEY, { type: "json" })) || [];
  } catch (err) {
    console.warn("[notifications] read failed:", err.message);
    return [];
  }
}

async function clearNotifications() {
  const store = getStore(NOTIFICATIONS_STORE);
  await store.setJSON(NOTIFICATIONS_KEY, []);
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
    if (!filePath) {
      await addNotification({ type: "error", filename: null, message: "Ingest call missing filePath" });
      return res.status(400).json({ ok: false, error: "Missing filePath" });
    }

    const pathParts = parsePath(filePath);
    if (!pathParts) {
      await addNotification({ type: "error", filename: filePath, message: "Not directly inside a project 01_Pending folder (Drawing Submissions/{Project}/01_Pending/)" });
      return res.status(400).json({ ok: false, error: "Path does not match protocol", received: filePath });
    }
    const { projectNo, folderStage, filename, layout } = pathParts;

    // Duplicate guard runs BEFORE filename validation, so a Drawboard re-save of a file that's
    // already recorded (even one named under an older convention) is skipped quietly.
    // Strip DROPBOX_ROOT prefix up front — used both by the duplicate-ingest guard below and
    // for the Dropbox Path property written on create. Case-insensitive comparison since
    // path_lower from Make will be lowercase.
    const shortPath = toShortDropboxPath(dropboxPath ?? filePath);

    try {
      const dupe = await findSubmissionByDropboxPath(notion, shortPath);
      if (dupe) {
        console.log(`[ingest] Duplicate ingest for ${shortPath} — already recorded as ${dupe.id}, skipping.`);
        // A still-Submitted duplicate is expected: saving Drawboard markup back to Pending
        // modifies the file and Make re-surfaces it. Don't clutter the feed with those.
        if (getProp(dupe, "Status", "select") !== "Submitted") {
          await addNotification({ type: "skip", filename, message: "Duplicate ingest — already recorded as an existing Submission, skipped." });
        }
        return res.json({ ok: true, skipped: true, duplicate: true, submissionId: dupe.id });
      }
      const moved = await findMovedPendingSubmission(notion, shortPath);
      if (moved) {
        await notion.pages.update({ page_id: moved.id, properties: { "Dropbox Path": { url: shortPath } } });
        console.log(`[ingest] ${filename}: Pending folder renamed/moved — repointed ${moved.id} to ${shortPath}`);
        return res.json({ ok: true, skipped: true, duplicate: true, repointed: true, submissionId: moved.id });
      }
    } catch (err) { console.warn("[ingest] Duplicate check failed:", err.message); }

    const fileParts = parseFilename(filename);
    if (!fileParts.ok) {
      await addNotification({ type: "error", filename, message: fileParts.error });
      return res.status(400).json({ ok: false, error: "Filename does not match convention", detail: fileParts.error, received: filename });
    }
    // Old-style names carry no stage, so they only work in the legacy per-stage Pending folders.
    if (fileParts.format === "legacy" && !folderStage) {
      const message = "Old-style filename — rename to {Item}_{Stage}_{Rev}_{DrawingNo}_{Initials}.pdf (e.g. 003_S4_P01_A-101_GF.pdf)";
      await addNotification({ type: "error", filename, message });
      return res.status(400).json({ ok: false, error: "Filename does not match convention", detail: message, received: filename });
    }
    const { itemNo, drawingNo, revision, dtInitials } = fileParts;
    // Filename stage wins; the legacy folder stage is only a fallback for old-style names.
    const stage = fileParts.stage || folderStage;
    if (fileParts.stage && folderStage && fileParts.stage !== folderStage) {
      console.warn(`[ingest] ${filename}: filename stage ${fileParts.stage} differs from legacy folder ${folderStage} — using filename`);
    }

    console.log(`[ingest] ${projectNo}/${stage}/${filename} (${layout} layout, ${fileParts.format} name)`);

    let taskPage, drawingPage, dtPage;

    try { taskPage = await findTask(notion, projectNo, itemNo); }
    catch (err) {
      await addNotification({ type: "error", filename, message: `Task lookup failed: ${err.message}` });
      return res.status(500).json({ ok: false, error: "Task lookup failed", detail: err.message });
    }
    if (!taskPage) {
      await addNotification({ type: "error", filename, message: `Task not found for item "${itemNo}" in ${projectNo}` });
      return res.status(422).json({ ok: false, error: "Task not found", detail: `No Task for item "${itemNo}" in ${projectNo}` });
    }

    try { drawingPage = await findDrawing(notion, drawingNo, taskPage.id); }
    catch (err) {
      await addNotification({ type: "error", filename, message: `Drawing lookup failed: ${err.message}` });
      return res.status(500).json({ ok: false, error: "Drawing lookup failed", detail: err.message });
    }
    if (!drawingPage) {
      await addNotification({ type: "error", filename, message: `Drawing not found in MDS for "${drawingNo}"` });
      return res.status(422).json({ ok: false, error: "Drawing not found in MDS", detail: `No MDS row for "${drawingNo}"` });
    }

    // DT: the initials in the (required) 5th filename section set the DT. If they don't match
    // anyone in the Team DB, fall back to the Person assigned on the Item and flag it.
    let dtSource = null;
    if (dtInitials) {
      try { dtPage = await findDT(notion, dtInitials); if (dtPage) dtSource = "initials"; }
      catch (err) { console.warn(`[ingest] DT lookup failed for "${dtInitials}":`, err.message); }
    }
    if (!dtPage) {
      const personIds = getProp(taskPage, "Person", "relation");
      if (personIds?.length) {
        try {
          dtPage = await withNotionRetry(() => notion.pages.retrieve({ page_id: personIds[0] }));
          dtSource = "item";
        } catch (err) { console.warn("[ingest] Item Person lookup failed:", err.message); }
      }
    }

    let qaRound = 1;
    let sameRevNote = "";
    try {
      const prev = await findLatestSubmission(notion, drawingPage.id, stage);
      if (prev) {
        qaRound = (getProp(prev, "QA Round", "number") ?? 1) + 1;
        // Same rev as last time is either a DT resubmitting without bumping the rev, or a
        // Drawboard sync recreating a file that Approve/Bounce already moved out of Pending.
        const prevRev = getProp(prev, "Revision", "select");
        if (prevRev && prevRev.toUpperCase() === revision) {
          sameRevNote = ` — ⚠ same Rev as QA R${qaRound - 1} (${getProp(prev, "Status", "select") ?? "?"}); if that was just actioned, this may be a Drawboard re-sync`;
        }
        // Only supersede a still-open submission — a Rejected one is already closed
        const prevStatus = getProp(prev, "Status", "select");
        if (prevStatus === "Submitted") {
          notion.pages.update({ page_id: prev.id, properties: { "Status": { select: { name: "Rejected" } } } })
            .catch((e) => console.warn("[ingest] Supersede failed:", e.message));
        }
      }
    } catch (err) { console.warn("[ingest] Resubmission check:", err.message); }

    const submissionTitle = `${projectNo}-${padItemNo(itemNo)}_${drawingNo}_${stage}_R${qaRound}`;

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
    submissionProps["Dropbox Path"] = { url: shortPath };
    if (dtPage) submissionProps["DT"] = { relation: [{ id: dtPage.id }] };
    if (shareLink) submissionProps["Share Link"] = { url: shareLink };

    let newSubmission;
    try {
      newSubmission = await notion.pages.create({ parent: { database_id: SUBMISSIONS_DB }, properties: submissionProps });
    } catch (err) {
      await addNotification({ type: "error", filename, message: `Failed to create Submission: ${err.message}` });
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

    const dtName = dtPage ? (getProp(dtPage, "Name", "title") ?? dtInitials) : (dtInitials || "Unknown DT");
    await createActivityLogEntry(notion, {
      taskId: taskPage.id,
      source: "Drawing Flow",
      tag:    "#info",
      author: dtName || "System",
      entry:  `Drawing ${drawingNo} Rev ${revision} submitted by ${dtName}. (QA Round ${qaRound})`,
    });

    console.log(`[ingest] created ${submissionTitle} (${newSubmission.id})`);
    const dtNote = dtPage
      ? (dtInitials && dtSource === "item"
          ? ` — no DT matched initials "${dtInitials}"; used the Item's Person (${getProp(dtPage, "Name", "title") ?? "?"}) — check the initials`
          : "")
      : dtInitials
        ? ` — no DT matched initials "${dtInitials}" and no Person on the Item; set DT manually`
        : " — no DT assigned (no initials in filename, no Person on the Item); set DT manually";
    await addNotification({ type: "success", filename, message: `Created ${submissionTitle} (QA Round ${qaRound})${dtNote}${sameRevNote}` });
    return res.json({ ok: true, submissionId: newSubmission.id, submissionTitle, qaRound, isResubmission: qaRound > 1, dtSource });
  });

  // GET /api/df/notifications
  // Cockpit ingest-run feed — newest first. Purely operational, not project history.
  app.get("/api/df/notifications", async (req, res) => {
    try {
      const notifications = await getNotifications();
      res.json({ ok: true, notifications });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/df/notifications/clear
  app.post("/api/df/notifications/clear", async (req, res) => {
    try {
      await clearNotifications();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
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
          const folderLink = status === "Issued" ? null : getProp(page, "Folder Link", "url");
          const folderPath = rawPath
            ? toFullDropboxPath(rawPath).split("/").slice(0, -1).join("/")
            : null;
          const folderSegs = folderPath ? folderPath.split("/").filter(Boolean) : [];
          const folderName = folderSegs.slice(-2).join(" / ") || null;   // e.g. "24-367 / Approved"
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
      // Optional: scope to a specific selection from the cockpit (checkbox-selected cards).
      // Without this, the button processed every eligible submission regardless of what
      // was checked — checkboxes existed in the UI but nothing downstream read them.
      const { submissionIds } = req.body || {};
      const idFilter = Array.isArray(submissionIds) && submissionIds.length ? new Set(submissionIds) : null;

      const NOTIFIABLE_STATUSES = ["Approved", "Rejected", "Issued", "Graded"];
      let results = (await Promise.all(
        NOTIFIABLE_STATUSES.map((s) =>
          queryAll(notion, SUBMISSIONS_DB, {
            and: [
              { property: "Status",       select:   { equals: s     } },
              { property: "DT Notified",  checkbox: { equals: false } },
            ]
          })
        )
      )).flat();
      if (idFilter) results = results.filter((page) => idFilter.has(page.id));

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
        // Folder Link is the Ready For Issue / Rejected link Make wrote back at approve/bounce —
        // once a drawing is Issued its PDF has moved on to 04_Issued, so don't reuse that link.
        const folderLink = status === "Issued" ? null : getProp(page, "Folder Link", "url");
        const { drawingNo } = parseSubmissionTitle(title, stage);
        const dt = await resolveDT(notion, dtIds);

        // Derive folder path and name
        const fullPath   = toFullDropboxPath(rawPath);
        // The DT needs the exact filename to find it in the folder — including the _R1/_R2
        // suffix bounce adds, since every project's files now sit in one folder per status.
        const fileName   = fullPath ? fullPath.split("/").pop() : null;
        const folderPath = fullPath ? fullPath.split("/").slice(0, -1).join("/") : null;
        const folderSegs = folderPath ? folderPath.split("/").filter(Boolean) : [];
        const folderName = folderSegs.slice(-2).join(" / ") || null;   // e.g. "24-367 / Approved"

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
          fileName,
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
          fileName:     item.fileName,
          drawingNo:    item.drawingNo,
          stage:        item.stage,
          actionLabel:  item.actionLabel,
          qaRound:      item.qaRound,
          grade:        item.grade,
        });
        byDT[dtKey].pageIds.push(item.pageId);
      }

      // A folder's link is written back by Make after the approve/bounce move. If that run
      // failed (a stale path, say), the property is empty and the DT gets plain text instead of
      // a link — so borrow the link from any other submission sitting in the same folder.
      const folderLinkCache = new Map();
      async function folderLinkFor(folderPath) {
        const shortPath = toShortDropboxPath(folderPath);
        if (!shortPath) return null;
        if (folderLinkCache.has(shortPath)) return folderLinkCache.get(shortPath);
        let link = null;
        try {
          const res = await withNotionRetry(() => notion.databases.query({
            database_id: SUBMISSIONS_DB,
            filter: { and: [
              { property: "Dropbox Path", url: { contains: `${shortPath}/` } },
              { property: "Folder Link",  url: { is_not_empty: true      } },
            ]},
            page_size: 1,
          }));
          link = res.results.length ? getProp(res.results[0], "Folder Link", "url") : null;
        } catch (err) {
          console.warn(`[send-dt-emails] Folder link lookup failed for ${shortPath}:`, err.message);
        }
        folderLinkCache.set(shortPath, link);
        return link;
      }
      for (const group of Object.values(byDT)) {
        for (const [folderPath, folder] of Object.entries(group.folders)) {
          if (!folder.folderLink && folderPath.startsWith("/")) folder.folderLink = await folderLinkFor(folderPath);
        }
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

          // Column 1 is the file as it is named in that folder (bounced files keep their _R#),
          // with the drawing number underneath for scanning.
          const drawingRows = folder.drawings.map((d) =>
            `<tr>
              <td style="padding:4px 8px;color:#333;">
                <code style="font-size:12px;">${d.fileName || d.drawingNo || "—"}</code>
                ${d.fileName && d.drawingNo ? `<div style="font-size:11px;color:#888;">${d.drawingNo}</div>` : ""}
              </td>
              <td style="padding:4px 8px;color:#555;">${d.stage}</td>
              <td style="padding:4px 8px;color:#555;">${d.actionLabel}</td>
            </tr>`
          ).join("");

          // Instruction row — derive from the first drawing's actionLabel (all drawings in a folder share the same action)
          const firstAction = folder.drawings[0]?.actionLabel ?? "";
          const instruction = firstAction === "QA Approved"
            ? "Upload the DWGs (and any other approved files) to the 03_Ready For Issue folder link above. Keep the filename exactly as listed, dropping only a <code>_R1</code>/<code>_R2</code> suffix if the drawing was bounced along the way."
            : firstAction.startsWith("Bounced")
              ? "Your marked-up drawings are in the 02_Rejected folder link above, under the filenames listed. Revise to the DM comments and upload the revised PDF to the project's 01_Pending folder, named {Item}_{Stage}_{Rev}_{DrawingNo}_{Initials}.pdf (no _R# suffix)."
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
      // Optional: scope to a specific selection from the cockpit (checkbox-selected cards).
      // Without this, the button processed every eligible submission regardless of what
      // was checked — checkboxes existed in the UI but nothing downstream read them.
      const { submissionIds } = req.body || {};
      const idFilter = Array.isArray(submissionIds) && submissionIds.length ? new Set(submissionIds) : null;

      let results = await queryAll(notion, SUBMISSIONS_DB, {
        and: [
          { property: "Status",      select:   { equals: "Graded" } },
          { property: "DT Notified", checkbox: { equals: false    } },
        ],
      });
      if (idFilter) results = results.filter((page) => idFilter.has(page.id));

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

        // Where the DT finds the returned file:
        //   A4.5/PRD Rejected → {ProjectNo}/05_Client Comments/ (moved there at Log Status)
        //   A4.5/PRD Approved → {ProjectNo}/06_Signed Off/ (if the PDF was moved there at Log Status)
        //   S4/S5 etc.       → the Reviewed/ folder the client comment PDFs were moved into
        //   otherwise        → no file (e.g. graded without client comments)
        let returnFolder = null, returnKind = null;
        if (movesPdfOnGrade(stage)) {
          if (grade === "Rejected") { returnFolder = gradeReturnsFolder(rawPath); returnKind = "grade-returns"; }
          if (grade === "Approved") {
            const segs = (toFullDropboxPath(rawPath) || "").split("/");
            if (isFolder(segs[segs.length - 2], FOLDER.SIGNED_OFF)) {
              returnFolder = segs.slice(0, -1).join("/"); returnKind = "signed-off";
            }
          }
        } else {
          const reviewedPath = readPathList(page, "Comment Paths").find((p) => /\/reviewed\//i.test(p));
          if (reviewedPath) {
            returnFolder = toFullDropboxPath(reviewedPath).split("/").slice(0, -1).join("/");
            returnKind   = "reviewed";
          }
        }

        // Action label based on grade and revision
        const isProductionRev = revision.toUpperCase().startsWith("C");
        const action = grade === "C"
          ? "Review this drawing with the DM — do not revise independently"
          : grade === "NA"
            ? "Not applicable — no action required"
            : grade === "Rejected"
              ? "Revise to the returned comments and resubmit"
              : grade === "Approved" && movesPdfOnGrade(stage)
                ? "Approved — proceed with production"
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
          returnFolder,
          returnKind,
          drawingNo,
          stage,
          grade,
          revision,
          action,
          returnDate,
          completionDate,
          revisionDays,
          drawingIds,
        };
      }));

      // Group by DT → by the folder the returned files are in
      const byDT = {};
      for (const item of enriched) {
        const dtKey = item.dtEmail || item.dtName || "unknown";
        if (!byDT[dtKey]) byDT[dtKey] = { dtName: item.dtName, dtEmail: item.dtEmail, buckets: {}, pageIds: [] };
        const bucketKey = item.returnFolder || "_no_file";
        if (!byDT[dtKey].buckets[bucketKey]) {
          byDT[dtKey].buckets[bucketKey] = { returnFolder: item.returnFolder, returnKind: item.returnKind, drawings: [] };
        }
        byDT[dtKey].buckets[bucketKey].drawings.push(item);
        byDT[dtKey].pageIds.push(item.pageId);
      }

      // Build folderBlocks per DT (matches dt-summary email structure)
      for (const group of Object.values(byDT)) {
        group.folderBlocks = Object.values(group.buckets).map((bucket) => {
          const shortFolder = bucket.returnFolder
            ? toShortDropboxPath(bucket.returnFolder).replace(/^Drawing Submissions\//i, "")
            : null;
          const folderHtml  = shortFolder ? `<strong>${shortFolder}</strong>` : "<strong>No return file</strong>";

          const note = bucket.returnKind === "grade-returns"
            ? "Returned C01 drawings sit with the client comments, named <code>{Item}_{Stage}_{Rev}_{DrawingNo}_{Grade}_{YYMMDD}.pdf</code>"
            : bucket.returnKind === "signed-off"
            ? "Signed-off C01 drawings — filename unchanged"
            : bucket.returnKind === "reviewed"
              ? "Client comments reviewed by the DM — files prefixed <code>R_</code>, named <code>R_{YYMMDD}_{Commenter}_{Item}_{Stage}_{Rev}_{DrawingNo}.pdf</code>"
              : "No marked-up file for these — see the grade and action.";
          const filenameFormatNote =
            `<tr><td colspan="6" style="padding:4px 8px 10px;font-size:11px;color:#888;font-style:italic;">${note}</td></tr>`;

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

      // A4.5's and PRD's Drawing Status is finalized here, at the same moment Ball In Court
      // above actually flips to DT. Rejected → DT Review for both (the drawing starts its
      // submission journey again at the next revision). Approved differs by stage:
      //   A4.5 → Production Updates — contractor has signed off, DT now draws the PRD set
      //   PRD  → Schedule — factory has signed off, the item is scheduled for production
      //                     (procurement / production supporting docs), then As Built Updates
      // Every other stage already got its Drawing Status written immediately at log-status.
      const gradeDrawingStatus = (stage, grade) =>
        grade !== "Approved" ? "DT Review"
        : stage === "PRD"    ? "Schedule"
        : "Production Updates";
      await Promise.all(
        enriched
          .filter((item) => movesPdfOnGrade(item.stage))
          .flatMap((item) => (item.drawingIds || []).map((drawingId) =>
            notion.pages.update({ page_id: drawingId, properties: {
              "Drawing Status": { select: { name: gradeDrawingStatus(item.stage, item.grade) } },
            }}).catch((e) => console.warn(`[send-grade-emails] ${item.stage} MDS update failed ${drawingId}:`, e.message))
          ))
      );

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
  // Called by the Make cr-ingest scenario (Scenario 3) once per client-comment PDF found in a
  // Client Comments/ folder. Body: { filePath | dropboxPath, shareLink, filename }
  //
  // Filename: {YYMMDD}_{Commenter}_{Item}_{Stage}_{Rev}_{DrawingNo}.pdf  — stage (and rev) from the name
  //           {Commenter}_{YYMMDD}_{DrawingNo}_{Rev}.pdf                  — older names still work
  // Folder:   {ProjectNo}/05_Client Comments/         (stage from the filename, else the Issued submission)
  //           {ProjectNo}/{Stage}/Client Comments/    (legacy — stage from the folder)
  //
  // Effects:
  //   MDS drawing   → appends the file (hyperlinked) to `<stage> Comment Files` and the client to
  //                   `<stage> Client Reviewers` (existing values preserved)
  //   Submission    → Ball In Court = DM, DM Action = "Review Comments" (drives the cockpit's
  //                   Review Client Comments column), and the file's Dropbox path is added to
  //                   `Comment Paths` so Log Status can move it to Reviewed/R_… afterwards.
  // The DM reviews the PDF in Drawboard (synced back in place), then grades in the Hub.

  app.post("/api/df/cr-ingest", async (req, res) => {
    try {
      const { filePath, dropboxPath, shareLink, filename } = req.body || {};
      const pathStr = (filePath || dropboxPath || "").replace(/\\/g, "/");
      const name = filename || pathStr.split("/").pop();
      if (!name) return res.status(400).json({ ok: false, error: "filename required" });

      // Already-reviewed files (moved to Reviewed/ with R_) are never re-ingested, and C01 returns
      // ({Item}_{Stage}_{Rev}_{DrawingNo}_{Grade}_{YYMMDD}.pdf in 05_Client Comments, or a legacy
      // Grade Returns/ folder) aren't client comments at all.
      if (name.toUpperCase().startsWith(REVIEWED_PREFIX) || /\/reviewed\//i.test(pathStr)) {
        return res.json({ ok: true, skipped: true, reason: "already reviewed" });
      }
      if (isGradeReturnName(name) || /\/grade returns\//i.test(pathStr)) {
        return res.json({ ok: true, skipped: true, reason: "grade return, not a client comment" });
      }

      const parsed = parseClientCommentName(name.replace(/\.pdf$/i, ""));
      if (!parsed.ok) {
        await addNotification({ type: "error", filename: name, message: parsed.error });
        return res.status(400).json({ ok: false, error: `Could not parse filename: ${name} — ${parsed.error}` });
      }
      const { drawingNo, revision, itemNo } = parsed;
      const clientAcronym = parsed.commenter;

      const matches = await queryAll(notion, DRAWINGS_DB, {
        property: "Drawing Number", title: { contains: drawingNo },
      });
      // "contains" also matches longer numbers (…-2421 inside …-24217) — prefer the exact one.
      const drawing = matches.find((m) => (getProp(m, "Drawing Number", "title") || "").trim().toUpperCase() === drawingNo.toUpperCase())
                   ?? (matches.length === 1 ? matches[0] : null);
      if (!drawing) {
        const message = matches.length ? `${matches.length} MDS drawings partly match ${drawingNo}, none exactly — check the drawing number` : `No MDS drawing for ${drawingNo}`;
        await addNotification({ type: "error", filename: name, message });
        return res.json({ ok: true, matched: false, note: message });
      }

      // Stage: the filename says (current naming); else a legacy stage folder; else the drawing's
      // Issued submission (matching the comment's rev when there's more than one).
      const loc         = locateProject(pathStr);
      const folderStage = loc?.stageSeg ? normalizeStage(loc.stageSeg) : null;
      const knownStage  = parsed.stage || folderStage;
      if (knownStage && !COMMENT_STAGES.includes(knownStage)) {
        const message = `Client comments aren't tracked for ${knownStage} — only ${COMMENT_STAGES.join(" / ")}`;
        await addNotification({ type: "error", filename: name, message });
        return res.json({ ok: true, matched: false, note: message });
      }
      const issued = await queryAll(notion, SUBMISSIONS_DB, {
        and: [
          { property: "Drawing", relation: { contains: drawing.id } },
          { property: "Status",  select:   { equals: "Issued"     } },
          ...(knownStage ? [{ property: "Stage", select: { equals: knownStage } }] : []),
        ],
      });
      const byRound  = (a, b) => (getProp(b, "QA Round", "number") ?? 0) - (getProp(a, "QA Round", "number") ?? 0);
      const revMatch = revision ? issued.filter((p) => (getProp(p, "Revision", "select") || "").toUpperCase() === revision) : [];
      const target   = (revMatch.length ? revMatch : issued).sort(byRound)[0] ?? null;
      const stage    = knownStage || (target ? getProp(target, "Stage", "select") : null);

      if (!stage) {
        const message = `No Issued submission for ${drawingNo} — can't tell which stage these comments belong to`;
        await addNotification({ type: "error", filename: name, message });
        return res.json({ ok: true, matched: false, note: message });
      }
      if (!COMMENT_STAGES.includes(stage)) {
        const message = `Client comments aren't tracked for ${stage} — only ${COMMENT_STAGES.join(" / ")}`;
        await addNotification({ type: "error", filename: name, message });
        return res.json({ ok: true, matched: false, note: message });
      }

      const commentProp  = `${stage} Comment Files`;
      const reviewerProp = `${stage} Client Reviewers`;

      // Deduplicate — skip if this filename (with or without R_ prefix) is already recorded.
      // Case-insensitive: Dropbox/Make can return the same file's extension in a different
      // case on different list passes ("_P01.pdf" vs "_P01.PDF").
      const existingRT   = drawing.properties?.[commentProp]?.rich_text ?? [];
      const existingText = existingRT.map((r) => r.text?.content ?? "").join("").toLowerCase();
      const baseScanName = name.replace(/^R_/i, "").toLowerCase();
      if (existingText.includes(baseScanName)) {
        console.log(`[cr-ingest] already ingested, skipping: ${name}`);
        return res.json({ ok: true, matched: true, skipped: true, drawingId: drawing.id, stage, drawingNo });
      }

      const separator  = existingRT.length ? [{ type: "text", text: { content: ", " } }] : [];
      const newSegment = { type: "text", text: { content: name, link: shareLink ? { url: shareLink } : null } };

      const existingMS  = drawing.properties?.[reviewerProp]?.multi_select ?? [];
      const multiSelect = existingMS.some((o) => o.name === clientAcronym)
        ? existingMS.map((o) => ({ name: o.name }))
        : [...existingMS.map((o) => ({ name: o.name })), { name: clientAcronym }];

      await notion.pages.update({ page_id: drawing.id, properties: {
        [commentProp]:  { rich_text: [...existingRT, ...separator, newSegment] },
        [reviewerProp]: { multi_select: multiSelect },
      }});

      // Hand the submission back to the DM for comment review. Status stays "Issued".
      let submissionId = null;
      if (target) {
        submissionId = target.id;
        const shortPath = toShortDropboxPath(pathStr);
        const paths = readPathList(target, "Comment Paths");
        if (shortPath && !paths.some((p) => p.toLowerCase() === shortPath.toLowerCase())) paths.push(shortPath);
        const receivedAt = now();
        try {
          await notion.pages.update({ page_id: target.id, properties: {
            "Ball In Court": { select: { name: BIC.COMMENTS_RECEIVED } },
            "BIC Since":     { date:   { start: receivedAt           } },
            // Prescriptive, unlike Approve/Bounce/Log Status: flags that reviewing the
            // comments is the action now required. Cleared when the DM logs the grade.
            "DM Action":     { select: { name: "Review Comments"    } },
            "Comment Paths": { rich_text: richTextChunks(paths.join("\n")) },
          }});
        } catch (err) {
          console.warn(`[cr-ingest] Submission update failed for ${drawingNo} ${stage}:`, err.message);
        }
      } else {
        console.warn(`[cr-ingest] no Issued submission found for ${drawingNo} ${stage} — Comment Files written but Ball In Court not updated`);
      }

      console.log(`[cr-ingest] ${name} → ${drawingNo} ${stage} (${clientAcronym})`);
      const noCard = target ? "" : ` — no Issued ${stage} submission${revision ? ` at ${revision}` : ""}, so no card moved; check the stage/rev in the filename`;
      await addNotification({ type: target ? "success" : "error", filename: name,
        message: `Client comments (${clientAcronym}) logged against ${drawingNo} ${stage}${noCard}` });
      res.json({ ok: true, matched: true, drawingId: drawing.id, submissionId, stage, clientAcronym, drawingNo, itemNo, revision });
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
          folderHtml:   "<a href=\"https://www.dropbox.com/sh/test\" style=\"color:#4f7fff;font-weight:600;\">24-367 / Approved</a>",
          drawingsHtml: "<tr><td style=\"padding:4px 8px;color:#333;\">A-101</td><td style=\"padding:4px 8px;color:#555;\">S4</td><td style=\"padding:4px 8px;color:#555;\">QA Approved</td></tr><tr><td style=\"padding:4px 8px;color:#333;\">A-102</td><td style=\"padding:4px 8px;color:#555;\">S4</td><td style=\"padding:4px 8px;color:#555;\">QA Approved</td></tr>",
          drawingCount: 2,
        },
        {
          folderHtml:   "<a href=\"https://www.dropbox.com/sh/test2\" style=\"color:#4f7fff;font-weight:600;\">24-367 / Rejected</a>",
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
    const currentStatus = getProp(submissionPage, "Status", "select");
    if (currentStatus !== "Submitted") {
      return res.status(409).json({ ok: false, error: `Only Submitted drawings can be approved (this one is ${currentStatus})` });
    }

    // The file Make moves is whatever sits at the Pending path — i.e. the Drawboard-marked
    // copy, provided Drawboard has synced before Approve is clicked.
    const dropboxMove = computeDropboxMove(rawPath, "approve", null);

    try {
      await notion.pages.update({ page_id: id, properties: {
        "Status":        { select: { name: "Approved" } },
        "DM Action":     { select: { name: "Approve"        } },
        "Reviewed":      { date:   { start: reviewedAt      } },
        "Ball In Court": { select: { name: "DT"             } },
        "BIC Since":     { date:   { start: reviewedAt      } },
        // Same awaited call as the status write (see /bounce for why).
        ...(dropboxMove ? { "Dropbox Path": { url: toShortDropboxPath(dropboxMove.to) } } : {}),
      }});
    } catch (err) {
      return res.status(500).json({ ok: false, error: "Submission update failed", detail: err.message });
    }

    const submissionTitle = getProp(submissionPage, "Submission", "title");
    const dtIds           = getProp(submissionPage, "DT",         "relation");
    const taskIds         = getProp(submissionPage, "Item",        "relation");
    const dt              = await resolveDT(notion, dtIds);

    const { taskCode } = parseSubmissionTitle(submissionTitle, stage);
    const taskParts    = taskCode ? taskCode.split("-") : [];
    const projectNo    = taskParts.slice(0, -1).join("-");           // "24-367"
    const itemNo       = dropboxMove?.itemNo ?? taskParts[taskParts.length - 1]; // "022"
    const suffixRef    = projectNo && itemNo ? `${projectNo}-${itemNo}` : submissionTitle;
    // Approved drawings (and the DT's DWGs) live in the project's 03_Ready For Issue folder.
    const uploadPath   = dropboxMove?.toFolder
      ?? (projectNo ? `${DROPBOX_ROOT}/Drawing Submissions/${projectNo}/${FOLDER.READY_FOR_ISSUE}` : null);


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
      suffixFolderPath: dropboxMove?.toFolder ?? null,   // now {ProjectNo}/Approved — name kept for the Make mapping
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

    // Everything for this drawing moves 03_Ready For Issue/ → 04_Issued/, filenames unchanged:
    // the PDF (which Notion tracks) plus the DWGs and anything else the DT uploaded alongside it.
    // The PDF's new path is written in the same Notion call; Make matches the rest by drawing number.
    const issueMove       = computeIssueMove(getProp(submissionPage, "Dropbox Path", "url"));
    const issueFilesHook  = process.env.MAKE_ISSUE_FILES_WEBHOOK;
    const issueDrawingNo  = parseSubmissionTitle(getProp(submissionPage, "Submission", "title"), stage).drawingNo;

    try {
      await notion.pages.update({ page_id: id, properties: {
        "Status":        { select: { name: "Issued"    } },
        "DM Action":     { select: { name: "Approve"   } },
        "Issued":        { date:   { start: issuedDate } },
        "Ball In Court": { select: { name: bicValue    } },
        "BIC Since":     { date:   { start: issuedDate } },
        ...(issueMove ? { "Dropbox Path": { url: toShortDropboxPath(issueMove.to) } } : {}),
      }});
    } catch (err) {
      return res.status(500).json({ ok: false, error: "Submission update failed", detail: err.message });
    }

    if (issueMove && issueFilesHook && issueDrawingNo) {
      // Scenario 4 lists the Ready For Issue folder and moves every file whose name carries
      // this drawing number — PDF, DWGs, anything else the DT put beside it.
      await fireWebhook(issueFilesHook, {
        action:         "issue-files",
        submissionId:   id,
        drawingNo:      issueDrawingNo,
        fromFolder:     issueMove.from.split("/").slice(0, -1).join("/"),
        toFolder:       issueMove.toFolder,
        toFolderParent: issueMove.toFolderParent,
        toFolderName:   issueMove.toFolderName,
      });
    } else if (issueMove) {
      // No issue-files webhook configured — fall back to moving the PDF on its own.
      if (!issueFilesHook) console.warn("[issue] MAKE_ISSUE_FILES_WEBHOOK not set — moving the PDF only, DWGs stay in Ready For Issue");
      await fireWebhook(process.env.MAKE_ACTIONS_WEBHOOK, {
        action:       "move-files",
        reason:       "issue",
        submissionId: id,
        moves:        [issueMove],
      });
    } else {
      console.warn(`[issue] ${id}: PDF not in a Ready For Issue folder — no file move`);
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
    await createActivityLogEntry(notion, {
      taskId: taskIds?.[0],
      source: "Drawing Flow",
      tag:    "#approval",
      author: "DM",
      entry:  `Drawing ${issueDrawingNo} Rev ${revision} issued to client.`,
    });

    // DT email is batched via POST /api/df/send-dt-emails
    console.log(`[issue] ${id} => ${drawingStatus}${issueMove ? ` · moved to ${issueMove.to}` : ""}`);
    res.json({ ok: true, issuedDate, drawingStatus, ...(issueMove ? { movedTo: issueMove.to } : {}), ...(errors.length ? { errors } : {}) });
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
    if (!projectNo) return res.status(400).json({ ok: false, error: "Could not parse project" });

    // Stage: legacy DWGs sat in a {ProjectNo}/{Stage}/... folder; in the new layout DWGs go
    // into {ProjectNo}/03_Ready For Issue/, so take the stage from the filename if it follows
    // {Item}_{Stage}_{Rev}_{DrawingNo}[_{Initials}]. If neither gives a stage, match every Approved
    // submission with BIC=DT for the project.
    let stage = isStage(parts[dsIdx + 2]) ? normalizeStage(parts[dsIdx + 2]) : null;
    if (!stage) {
      const fname = parts[parts.length - 1] || "";
      const dot   = fname.lastIndexOf(".");
      const named = parseSubmissionName(stripBounceSuffix(dot > 0 ? fname.slice(0, dot) : fname), { requireInitials: false });
      if (named.ok && named.stage) stage = named.stage;
    }

    console.log(`[stage-upload] ${projectNo}/${stage || "any stage"} — BIC update DT → DM`);

    try {
      const results = await queryAll(notion, SUBMISSIONS_DB, {
        and: [
          ...(stage ? [{ property: "Stage", select: { equals: stage } }] : []),
          { property: "Status",        select: { equals: "Approved" } },
          { property: "Ball In Court", select: { equals: "DT"       } },
        ],
      });

      // Titles are "{ProjectNo}-{Item}_..." — match on "{ProjectNo}-" so 24-36 doesn't catch 24-367.
      const matching = results.filter((page) =>
        (getProp(page, "Submission", "title") ?? "").toUpperCase().startsWith(`${projectNo.toUpperCase()}-`)
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
  // DM has marked up the PDF in Drawboard (synced back to the same file in Pending) and
  // bounces it. Make moves that marked-up file to {ProjectNo}/Rejected/{name}_R{n}.pdf,
  // creates a shared link on Rejected/ and PATCHes it back via /folder-link. The DT email
  // is batched later via POST /api/df/send-dt-emails.
  //
  // (Sept 2026: the DT Drawing Checker's annotated-PDF upload path, /bounce-dest and the
  // Miro link were removed — the markup now lives in the PDF itself.)

  app.patch("/api/df/submissions/:id/bounce", async (req, res) => {
    const { id } = req.params;

    let submissionPage;
    try { submissionPage = await notion.pages.retrieve({ page_id: id }); }
    catch { return res.status(404).json({ ok: false, error: "Submission not found" }); }

    const currentStatus = getProp(submissionPage, "Status", "select");
    if (currentStatus !== "Submitted") {
      return res.status(409).json({ ok: false, error: `Only Submitted drawings can be bounced (this one is ${currentStatus})` });
    }

    const qaRound     = getProp(submissionPage, "QA Round",     "number") ?? 1;
    const rawPath     = getProp(submissionPage, "Dropbox Path", "url");
    const dropboxMove = computeDropboxMove(rawPath, "bounce", qaRound);
    const bouncedAt   = now();

    try {
      await notion.pages.update({ page_id: id, properties: {
        "Status":        { select: { name: "Rejected"  } },
        "DM Action":     { select: { name: "Bounce"    } },
        "Reviewed":      { date:   { start: bouncedAt  } },
        "Ball In Court": { select: { name: BIC.BOUNCED } },
        "BIC Since":     { date:   { start: bouncedAt  } },
        // Written in the same (awaited) call — Netlify freezes un-awaited promises once the
        // response is sent, which could silently drop a separate path update.
        ...(dropboxMove ? { "Dropbox Path": { url: toShortDropboxPath(dropboxMove.to) } } : {}),
      }});
    } catch (err) {
      return res.status(500).json({ ok: false, error: "Submission update failed", detail: err.message });
    }
    if (!dropboxMove) console.warn(`[bounce] ${id}: no Dropbox move — Dropbox Path "${rawPath}" is not in a Pending folder`);

    const submissionTitle = getProp(submissionPage, "Submission", "title");
    const stage           = getProp(submissionPage, "Stage",      "select");
    const dtIds           = getProp(submissionPage, "DT",         "relation");
    const taskIds         = getProp(submissionPage, "Item",        "relation");
    const dt              = await resolveDT(notion, dtIds);

    await fireWebhook(process.env.MAKE_ACTIONS_WEBHOOK, {
      action:           "bounce",
      submissionId:     id,
      submissionTitle,
      stage,
      qaRound,
      bouncedAt,
      bounceFolderPath: dropboxMove?.toFolder ?? null,
      ...(dropboxMove ? { dropboxMove } : {}),
      dtName:  dt.name,
      dtEmail: dt.email,
    });

    const bounceRevision  = getProp(submissionPage, "Revision", "select") ?? "";
    const bounceDrawingNo = dropboxMove?.drawingNo ?? parseSubmissionTitle(submissionTitle, stage).drawingNo;
    await createActivityLogEntry(notion, {
      taskId: taskIds?.[0],
      source: "Drawing Flow",
      tag:    "#issue",
      author: "DM",
      entry:  `Drawing ${bounceDrawingNo} Rev ${bounceRevision} bounced — QA Round ${qaRound}. BIC returned to ${dt.name || "DT"}.`,
    });

    console.log(`[bounce] ${id} → ${dropboxMove?.to ?? "no move"}`);
    res.json({ ok: true, bouncedAt, ...(dropboxMove ? { dropboxMove } : {}) });
  });

  // PATCH /api/df/submissions/:id/log-status
  // DM logs the client grade in the Hub — A/B/C/NA for S4/S5, Approved/Rejected for A4.5/AB.
  // Client comments are reviewed in Drawboard first (no separate reviewer app any more).
  //
  // File moves (one Make "move-files" webhook, only if there's something to move):
  //   • every client comment PDF logged on this submission (Comment Paths)
  //       → {its Client Comments folder}/Reviewed/R_{name}
  //   • A4.5 Rejected: the issued copy in 04_Issued/
  //       → {ProjectNo}/05_Client Comments/{Item}_{Stage}_{Rev}_{DrawingNo}_Rejected_{YYMMDD}.pdf
  //   • A4.5 Approved: the issued copy in 04_Issued/ → {ProjectNo}/06_Signed Off/{filename}

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
    const isA45Approved    = movesPdfOnGrade(stage) && grade === "Approved";
    const isProductionRev  = revision.toUpperCase().startsWith("C");

    // A4.5's and PRD's Drawing Status is finalized later, in POST /api/df/send-grade-emails,
    // at the same moment Ball In Court actually flips to DT (Approved → Production Updates,
    // Rejected → DT Review) — not here, since BIC sits with DM until the notify email
    // fires. Skip writing Drawing Status at this step for those stages; every other stage
    // keeps the immediate write.
    const deferDrawingStatus = movesPdfOnGrade(stage);

    // Drawing Status: terminal stages override; otherwise use revision prefix
    const drawingStatus = isTerminalAB  ? "Complete"
                        : isProductionRev ? "Production Updates"
                        : "Approval Updates";

    // BIC: terminal AB → clear; graded → DM until email fired
    const newBIC = isTerminalAB ? null : BIC.GRADED;   // BIC.GRADED is now "DM"

    const submissionStatus = isTerminalAB ? "Complete" : "Graded";

    const logStatusTitle = getProp(submissionPage, "Submission", "title");
    const taskIds = getProp(submissionPage, "Item", "relation");
    const { taskCode: logStatusTaskCode, drawingNo: logStatusDrawingNo } = parseSubmissionTitle(logStatusTitle, stage);
    const taskParts = logStatusTaskCode ? logStatusTaskCode.split("-") : [];
    const itemNo    = taskParts[taskParts.length - 1] ?? "";

    // ── Work out the Dropbox moves up front so their new paths go into the same Notion write.
    const commentPaths  = readPathList(submissionPage, "Comment Paths");
    const commentMoves  = commentPaths.map((p) => ({ p, move: computeReviewedMove(p) }));
    const moves         = commentMoves.map((c) => c.move).filter(Boolean);
    const newCommentPaths = commentMoves.map((c) => c.move ? toShortDropboxPath(c.move.to) : c.p);

    // A4.5 / PRD: the submitted PDF itself moves — Rejected → 05_Client Comments (renamed),
    // Approved → 06_Signed Off.
    let pdfMove = null;
    if (movesPdfOnGrade(stage)) {
      const pdfPath = getProp(submissionPage, "Dropbox Path", "url");
      pdfMove = grade === "Rejected"
        ? computeGradeReturnMove(pdfPath, { itemNo, stage, revision, drawingNo: logStatusDrawingNo, grade, date: gradedAt })
        : computeSignedOffMove(pdfPath);
      if (pdfMove) moves.push(pdfMove);
      else console.warn(`[log-status] No ${stage} PDF move for submission ${id} (${grade}) — path: ${pdfPath || "none"}`);
    }

    try {
      await notion.pages.update({ page_id: id, properties: {
        "Status":        { select: { name: submissionStatus } },
        // Also clears a "Review Comments" DM Action set by cr-ingest.
        "DM Action":     { select: { name: "Log Status"     } },
        "Client Grade":  { select: { name: grade            } },
        "Reviewed":      { date:   { start: gradedAt        } },
        "DT Notified":   { checkbox: false                   },
        "Ball In Court": newBIC ? { select: { name: newBIC    } } : { select: null },
        "BIC Since":     newBIC ? { date:   { start: gradedAt } } : { date:   null },
        ...(commentPaths.length ? { "Comment Paths": { rich_text: richTextChunks(newCommentPaths.join("\n")) } } : {}),
        ...(pdfMove ? { "Dropbox Path": { url: toShortDropboxPath(pdfMove.to) } } : {}),
      }});
    } catch (err) {
      return res.status(500).json({ ok: false, error: "Submission update failed", detail: err.message });
    }

    for (const drawingId of drawingIds) {
      try {
        const mdsProps = {};
        if (!deferDrawingStatus) mdsProps["Drawing Status"] = { select: { name: drawingStatus } };
        if (stageMap.statusField) mdsProps[stageMap.statusField] = { select: { name: grade } };
        // Status Date uses the project-system return date (or today if not provided).
        // A4.5 is the exception: C01 Sign Off is a sign-off date, so it is only set when
        // Approved. PRD Status Date is a plain status date and writes on both outcomes.
        if (stageMap.dateField && !(stage === "A4.5" && grade !== "Approved")) {
          mdsProps[stageMap.dateField] = { date: { start: statusDate } };
        }
        if (Object.keys(mdsProps).length) {
          await notion.pages.update({ page_id: drawingId, properties: mdsProps });
        }
      } catch (err) {
        console.warn(`[log-status] MDS failed for ${drawingId}:`, err.message);
      }
    }

    if (moves.length) {
      await fireWebhook(process.env.MAKE_ACTIONS_WEBHOOK, {
        action:       "move-files",
        reason:       "log-status",
        submissionId: id,
        moves,        // [{ from, to, toFolder, toFolderParent, toFolderName, newFilename }]
      });
    }

    await createActivityLogEntry(notion, {
      taskId: taskIds?.[0],
      source: "Drawing Flow",
      tag:    "#response",
      author: "System",
      entry:  `${stage === "PRD" ? "Factory" : "Client"} grade ${grade} recorded for ${logStatusDrawingNo} Rev ${revision}.`,
    });

    console.log(`[log-status] ${id} => ${grade} (Rev ${revision}) => ${drawingStatus}; ${moves.length} file move(s)`);
    res.json({ ok: true, grade, gradedAt, statusDate, drawingStatus, submissionStatus, isTerminal: isTerminalAB, isA45Approved,
               filesMoved: moves.map((m) => m.to) });
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

  // Scope a query to one or many Task ids. Notion caps filter nesting at two levels, so
  // this returns a bare property filter for the single-id case rather than a pointless
  // one-element `or` that would burn a level when nested inside an `and`.
  const taskScopeFilter = (prop, ids) => ids.length === 1
    ? { property: prop, relation: { contains: ids[0] } }
    : { or: ids.map((id) => ({ property: prop, relation: { contains: id } })) };

  // Comma-separated multi-value select filter ("#issue,#query"), same nesting care.
  const selectAnyOf = (prop, raw) => {
    const vals = String(raw || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!vals.length) return null;
    return vals.length === 1
      ? { property: prop, select: { equals: vals[0] } }
      : { or: vals.map((v) => ({ property: prop, select: { equals: v } })) };
  };

  // A date arrives as YYYY-MM-DD from the UI's range picker. Anchor both ends to the whole
  // day, or "to = today" silently drops everything logged today.
  const dayStart = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00.000Z`).getTime();
  const dayEnd   = (d) => new Date(`${String(d).slice(0, 10)}T23:59:59.999Z`).getTime();

  // An entry's effective date is Event Date when set (backfilled history), else Created.
  const effectiveDate = (e) => e.eventDate || e.created;

  const daysOpen = (since) => since
    ? Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86400000))
    : null;

  // --- Shared fetchers -------------------------------------------------------
  //
  // The feed, the position header and the export must never be three different queries —
  // "the export is exactly what is on screen" is a hard requirement (handoff doc §7.5), and
  // the only way to keep it true as the filters grow is for all three routes to go through
  // the same two functions. Add a filter here, not in a route.

  // Date range is deliberately split between Notion and here. Event Date is always <=
  // Created — you can backfill the past, not the future — so `Created >= from` is a safe
  // superset of `effective >= from` and can go to Notion. The upper bound cannot: an entry
  // created today can carry an Event Date from last month and must still fall inside a
  // range that ended last month. Both bounds are therefore re-applied exactly, below.
  async function fetchActivityEntries(q = {}) {
    const { taskId, projectId, days, limit, tag, source, from, to } = q;
    const pageSize = Math.min(Number(limit) || (taskId || projectId ? 50 : 100), 200);
    const clauses = [];

    if (taskId) {
      clauses.push({ property: "Task", relation: { contains: taskId } });
    } else if (projectId) {
      const projectTaskIds = await findTaskIdsForProject(notion, projectId);
      if (!projectTaskIds.length) return [];
      clauses.push(taskScopeFilter("Task", projectTaskIds));
    } else if (!from && !to) {
      const windowDays = Number(days) || 7;
      clauses.push({ property: "Created", created_time: {
        on_or_after: new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString() } });
    }

    const tagFilter    = selectAnyOf("Tag", tag);
    const sourceFilter = selectAnyOf("Source", source);
    if (tagFilter)    clauses.push(tagFilter);
    if (sourceFilter) clauses.push(sourceFilter);
    if (from) clauses.push({ property: "Created", created_time: { on_or_after: new Date(dayStart(from)).toISOString() } });

    const filter = clauses.length === 0 ? undefined
                 : clauses.length === 1 ? clauses[0]
                 : { and: clauses };

    const result = await notion.databases.query({
      database_id: ACTIVITY_LOG_DB,
      ...(filter ? { filter } : {}),
      sorts:     [{ property: "Created", direction: "descending" }],
      page_size: pageSize,
    });

    // Enrich with which item each entry belongs to — needed once a feed can span more than
    // one Task. Cached per unique Task id, so a feed full of entries from the same handful
    // of items costs one lookup each, not one per entry.
    const resolveTaskName = makeTaskNameResolver(notion);
    let entries = await Promise.all(result.results.map(async (page) => {
      const entryTaskId = getProp(page, "Task", "relation")?.[0] ?? null;
      const { taskName, projectName } = entryTaskId
        ? await resolveTaskName(entryTaskId)
        : { taskName: null, projectName: null };
      return {
        id:        page.id,
        created:   page.created_time,
        eventDate: getProp(page, "Event Date", "date"),
        entry:     getProp(page, "Entry",  "title"),
        source:    getProp(page, "Source", "select"),
        tag:       getProp(page, "Tag",    "select"),
        author:    getProp(page, "Author", "rich_text"),
        detail:    getProp(page, "Detail", "rich_text") ?? "",
        link:      getProp(page, "Link",   "url") ?? "",
        files:     getProp(page, "Files & media", "files") ?? [],
        taskId:    entryTaskId,
        taskName,
        projectName,
      };
    }));

    if (from || to) {
      const lo = from ? dayStart(from) : -Infinity;
      const hi = to   ? dayEnd(to)     :  Infinity;
      entries = entries.filter((e) => {
        const t = new Date(effectiveDate(e)).getTime();
        return t >= lo && t <= hi;
      });
    }

    // Notion's own sort covers Created order; re-sort here so any row with an Event Date
    // slots into true chronological position instead of clustering at the top by the time
    // it happened to be typed up.
    entries.sort((a, b) => new Date(effectiveDate(b)) - new Date(effectiveDate(a)));
    return entries;
  }

  // Current state, not history. Reads the trackers live and never touches the Activity Log:
  // the feed answers "how did we get here", this answers "where are we now", and deriving
  // either from the other makes both wrong (handoff doc §7.2).
  //
  // Reads TWO sources, not three. Every submission carries its own A&I action row (§6.1),
  // so querying the Submissions DB as well would count every submission twice.
  async function fetchPosition(q = {}) {
    const { projectId, taskId } = q;
    const errors = [];
    const empty = { open: 0, blocked: 0, withDM: 0, unassigned: 0, blockers: [], items: { ai: [], rfis: [] } };

    // null scope = global (no relation filter at all).
    let scopeIds = null;
    if (taskId) {
      scopeIds = [taskId];
    } else if (projectId) {
      scopeIds = await findTaskIdsForProject(notion, projectId);
      if (!scopeIds.length) return empty;
    }

    const aiClauses = [
      { property: "Tags",     multi_select: { contains: "Track" } },
      { property: "Archived", checkbox:     { equals: false } },
    ];
    if (scopeIds) aiClauses.push(taskScopeFilter("Items", scopeIds));
    const aiRows = await queryAll(notion, ACTIONS_INFO_DB, { and: aiClauses });

    // A failing RFI query degrades to A&I-only rather than blanking the whole header — a
    // partial blocker strip beats an error page.
    let rfiRows = [];
    if (RFIS_DB) {
      const rfiClauses = [{ or: [
        { property: "RFI Status", select: { equals: "Raise" } },
        { property: "RFI Status", select: { equals: "Open"  } },
      ]}];
      if (scopeIds) rfiClauses.push(taskScopeFilter("Related Item(s)", scopeIds));
      try {
        rfiRows = await queryAll(notion, RFIS_DB, { and: rfiClauses });
      } catch (err) {
        console.warn("[activity-position] RFI query failed:", err.message);
        errors.push(`RFIs unavailable: ${err.message}`);
      }
    }

    const resolveTaskName = makeTaskNameResolver(notion);

    const ai = await Promise.all(aiRows.map(async (page) => {
      const itemId = getProp(page, "Items", "relation")?.[0] ?? null;
      const { taskName, projectName } = itemId
        ? await resolveTaskName(itemId)
        : { taskName: null, projectName: null };
      // "—" is the explicit "looked at it, nothing is holding it up" option, a different
      // statement from a blank Blocker ("not assessed"). Neither is a blocker.
      const blocker = getProp(page, "Blocker", "select");
      return {
        id:       page.id,
        title:    getProp(page, "Note", "title"),
        status:   getProp(page, "Track Status",  "select"),
        bic:      getProp(page, "Ball in Court", "select"),
        category: getProp(page, "Category",      "select"),
        blocker:  blocker && blocker !== "—" ? blocker : null,
        created:  page.created_time,
        // When the Email Tracker set a Received date, that — not the row's creation time —
        // is when the clock started on this action.
        received: getProp(page, "Received", "date"),
        url:      page.url,
        taskId:   itemId,
        taskName,
        projectName,
      };
    }));

    const rfis = await Promise.all(rfiRows.map(async (page) => {
      const itemId = getProp(page, "Related Item(s)", "relation")?.[0] ?? null;
      const { taskName, projectName } = itemId
        ? await resolveTaskName(itemId)
        : { taskName: null, projectName: null };
      const n = getProp(page, "RFI Number", "number");
      return {
        id:      page.id,
        ref:     (n === null || n === undefined) ? "RFI-?" : `RFI-${String(n).padStart(3, "0")}`,
        title:   getProp(page, "RFI Description", "title"),
        status:  getProp(page, "RFI Status", "select"),
        bic:     getProp(page, "TBC by",     "select"),
        raised:  getProp(page, "Date Raised", "date"),
        created: page.created_time,
        url:     page.url,
        taskId:  itemId,
        taskName,
        projectName,
      };
    }));

    const blockers = [
      ...ai.filter((r) => r.blocker).map((r) => ({
        source: "A&I", ref: null, id: r.id, title: r.title,
        item: r.taskName, reason: r.blocker, bic: r.bic || "—", url: r.url,
      })),
      ...(OPEN_RFIS_BLOCK ? rfis.map((r) => ({
        source: "RFI", ref: r.ref, id: r.id, title: r.title,
        item: r.taskName, reason: "Awaiting RFI response", bic: r.bic || "—", url: r.url,
      })) : []),
    ];

    // An untethered tracked row can never reach an item feed. Surfaced, not swallowed — it
    // is a data-quality problem and hiding it is worse than showing it (§6.4).
    const unassigned = [...ai, ...rfis].filter((r) => !r.taskId).length;

    return {
      open:    ai.length + rfis.length,
      blocked: blockers.length,
      withDM:  ai.filter((r) => r.bic === "Me").length,
      unassigned,
      blockers,
      items: { ai, rfis },
      ...(errors.length ? { errors } : {}),
    };
  }

  // GET /api/df/activity-log?taskId=&projectId=&days=&limit=&tag=&source=&from=&to=
  // Scope, in priority order:
  //   taskId given    -> full history for that one item, unbounded by date.
  //   projectId given -> all activity across every item in that project, unbounded by date.
  //   neither given   -> global feed, capped to the last `days` (default 7) — the default
  //                      page-load view. Skipped when an explicit from/to supersedes it.
  // tag and source accept comma-separated lists and compose with the scope and each other.
  app.get("/api/df/activity-log", async (req, res) => {
    if (!ACTIVITY_LOG_DB) return res.status(503).json({ ok: false, error: "NOTION_DB_ACTIVITY_LOG not configured" });
    try {
      res.json({ entries: await fetchActivityEntries(req.query) });
    } catch (err) {
      console.error("GET /api/df/activity-log", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/df/activity-position?projectId=&taskId=
  app.get("/api/df/activity-position", async (req, res) => {
    if (!ACTIONS_INFO_DB) return res.status(503).json({ ok: false, error: "NOTION_DB_ACTIONS_INFO not configured" });
    try {
      res.json(await fetchPosition(req.query));
    } catch (err) {
      console.error("GET /api/df/activity-position", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/df/activity-export?<same filters as activity-log>
  // Streams an .xlsx built server-side. Goes through the same two fetchers as the feed and
  // the header, so what downloads is exactly what was on screen — if the UI shows 12
  // entries, Sheet 1 has 12 rows.
  //
  // exceljs, not SheetJS. The brief named SheetJS, but the free `xlsx` build writes neither
  // cell styles nor frozen panes (verified against the generated XML — styles are a Pro
  // feature), and a bold header row and frozen top row are both explicit requirements.
  app.get("/api/df/activity-export", async (req, res) => {
    if (!ACTIVITY_LOG_DB) return res.status(503).json({ ok: false, error: "NOTION_DB_ACTIVITY_LOG not configured" });
    try {
      const ExcelJS = require("exceljs");
      const [entries, position] = await Promise.all([
        fetchActivityEntries(req.query),
        ACTIONS_INFO_DB ? fetchPosition(req.query) : Promise.resolve(null),
      ]);

      const wb = new ExcelJS.Workbook();
      wb.creator = "Axiom Drawing Flow";
      wb.created = new Date();

      // Real Date cells with a UK number format, not pre-formatted strings — a string
      // column sorts alphabetically in Excel, which puts 01/12 before 02/03.
      const UK_DATETIME = "dd/mm/yyyy hh:mm";
      const UK_DATE     = "dd/mm/yyyy";

      const finish = (ws, widths) => {
        // Per cell, not ws.getRow(1).font — a row-level font is not what Excel stores and
        // does not survive a write/read round-trip.
        ws.getRow(1).eachCell((c) => { c.font = { bold: true }; });
        ws.views = [{ state: "frozen", ySplit: 1 }];
        ws.columns.forEach((c, i) => { c.width = widths[i]; });
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: widths.length } };
      };

      // ── Sheet 1: Activity Log ──────────────────────────────────────────
      const s1 = wb.addWorksheet("Activity Log");
      s1.addRow(["Date", "Project", "Item", "Tag", "Source", "Author", "Entry", "Detail", "Link"]);
      for (const e of entries) {
        const row = s1.addRow([
          new Date(effectiveDate(e)),
          e.projectName || "", e.taskName || "(unassigned)",
          e.tag || "", e.source || "", e.author || "",
          e.entry || "", e.detail || "", null,
        ]);
        row.getCell(1).numFmt = UK_DATETIME;
        if (e.link) row.getCell(9).value = { text: "Open", hyperlink: e.link };
      }
      finish(s1, [18, 20, 32, 14, 14, 14, 70, 60, 10]);

      // ── Sheet 2: Current Position ──────────────────────────────────────
      const s2 = wb.addWorksheet("Current Position");
      s2.addRow(["Source", "Ref", "Project", "Item", "Title", "Status", "Ball in Court", "Blocker", "Opened", "Days Open"]);
      if (position) {
        const rows = [
          ...position.items.ai.map((r) => ({
            source: "A&I", ref: "", project: r.projectName, item: r.taskName, title: r.title,
            status: r.status, bic: r.bic, blocker: r.blocker, since: r.received || r.created,
          })),
          ...position.items.rfis.map((r) => ({
            source: "RFI", ref: r.ref, project: r.projectName, item: r.taskName, title: r.title,
            status: r.status, bic: r.bic, blocker: OPEN_RFIS_BLOCK ? "Awaiting RFI response" : null,
            since: r.raised || r.created,
          })),
        ].sort((a, b) => new Date(a.since) - new Date(b.since)); // oldest first — what to chase
        for (const r of rows) {
          const row = s2.addRow([
            r.source, r.ref || "", r.project || "", r.item || "(unassigned)", r.title || "",
            r.status || "", r.bic || "", r.blocker || "",
            r.since ? new Date(r.since) : null, daysOpen(r.since),
          ]);
          row.getCell(9).numFmt = UK_DATE;
        }
      }
      finish(s2, [10, 10, 20, 32, 50, 14, 16, 24, 12, 11]);

      const buf = await wb.xlsx.writeBuffer();
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="activity-export_${stamp}.xlsx"`);
      res.send(Buffer.from(buf));
    } catch (err) {
      console.error("GET /api/df/activity-export", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

};
