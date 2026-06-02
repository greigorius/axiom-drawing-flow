# Axiom Drawing Flow — Claude Code Handoff

**Project:** `axiom-drawing-flow`
**Handoff date:** 2026-05-29
**Status:** Architecture complete, specs signed off, Phase 1 backend route written.
Notion databases being set up in parallel by the DM.

---

## 1. What this project is

A drawing submission and QA review automation for Axiom DL (a UK joinery and fit-out
company). The DM (Design Manager, Greig) manages multiple remote DTs (Design Technicians)
who submit architectural drawings for review at various ISO-19650 submission stages.

The system automates:
- Detecting new drawing submissions (via Dropbox → Zapier → backend)
- Creating event-log records in Notion (the Submissions DB)
- Driving the DM's QA review (Approve / Bounce / Log Status)
- Updating the Master Drawing Schedule (MDS) in Notion automatically
- Notifying DTs via Gmail
- Moving files in Dropbox via Zapier instructions

---

## 2. Repository and project structure

**This project is NEW and SEPARATE** from Greig's other tools. It lives at:
```
C:\Users\greig\Documents\ClaudeProjects\axiom-drawing-flow\
```

It is forked from the `workflow-tracker` project pattern but is a clean project.
Do NOT modify the existing `workflow-tracker` project at any point.

**Current files in this project:**
```
axiom-drawing-flow/
├── drawing-flow.js        ← Phase 1 backend routes (WRITTEN — see section 5)
├── README.md              ← Full setup and API reference
└── docs/
    ├── DATA-MODEL.md          ← Three-tier Notion data model
    ├── INPUTS-ARCHITECTURE.md ← Programme Inputs DB + form design
    ├── STREAMLINING.md        ← MDS/Tasks deduplication analysis
    ├── NOTION-MIGRATION-CHECKLIST.md ← Manual Notion changes (DM does these)
    ├── WORKFLOW-2-BRIEFING.md ← Commercial/hours loop (future — DO NOT BUILD YET)
    └── HANDOFF.md             ← This document
```

**Files still needed (to be scaffolded):**
```
axiom-drawing-flow/
├── app.js                 ← Express app (copy pattern from workflow-tracker/app.js)
├── server.js              ← Local dev launcher
├── package.json
├── netlify.toml
├── netlify/
│   └── functions/api.js   ← Serverless wrapper
├── public/
│   ├── index.html         ← Shell
│   ├── app.jsx            ← App shell + routing
│   ├── cockpit.jsx        ← Submissions queue (the main DM view)
│   ├── inputs.jsx         ← Programme Inputs form
│   └── styles.css
└── .env.example
```

---

## 3. Technology stack

Identical to `workflow-tracker`. Do not deviate.

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Babel Standalone (NO build step — JSX transpiled in-browser) |
| Backend | Express.js (Node 18+) |
| Notion client | `@notionhq/client` SDK (NOT raw fetch — this project uses the SDK) |
| Deployment | Netlify (serverless functions) |
| Styling | Plain CSS (no Tailwind — match workflow-tracker's CSS approach) |

**Frontend pattern:** All `.jsx` files live in `public/` and are loaded as `<script type="text/babel">` tags in `index.html`. No webpack, no Vite, no bundler.

**Critical Express rule:** All `/api/*` routes must be registered BEFORE `app.use(express.static(...))` or Vite/static middleware, or Express will not reach the API routes.

---

## 4. Notion databases

### Existing databases (DO NOT restructure — read-only context for the backend)

| Variable | ID | Purpose |
|----------|----|---------|
| `NOTION_DB_TASKS` | `bb783a35-a407-4637-89c6-78ebc76c8699` | Task packages (items/drawing sets) |
| `NOTION_DB_DRAWINGS` | `13b210e4582e8168923ff79fa8628b59` | Master Drawing Schedule (MDS) — IS the drawings tier |
| `NOTION_DB_PROJECTS` | `5c689434c2b047669831d2b31ef0f8de` | Projects |
| `NOTION_DB_RFIS` | `22d210e4582e80189f63f2cee93be4b3` | RFIs |
| `NOTION_DB_TIMESHEETS` | `197210e4-582e-8087-81be-000b8525577a` | Timesheets |

### New databases (being created by DM now)

| Variable | ID | Purpose |
|----------|----|---------|
| `NOTION_DB_SUBMISSIONS` | `36f210e4582e80ed8b2ce9e245bda433` | Event log, one row per submit/QA event |
| `NOTION_DB_TEAM` | `348210e4582e8050ac70fd18982185cc` | DT profiles, initials, email |

### Submissions DB — exact property schema

The DM is creating this. Verify every property name matches exactly before
making API calls. These are the required properties:

| Property | Notion type | Notes |
|----------|------------|-------|
| `Submission` | title | e.g. `24-367-003_A-101_S4_R1` |
| `Drawing` | relation → MDS | |
| `Task` | relation → Tasks | |
| `Stage` | select | Options: S3, S4, S5, A4.5 |
| `Revision` | select | Options: P01, P02, P03, C01, C02, C03 |
| `DT` | relation → Team | |
| `Ball In Court` | select | Options: Supplier, DT, DM, Architect, Project Team, Contractor, Production, Site |
| `BIC Since` | date | Chase metric |
| `QA Round` | number | |
| `Status` | status | Options: Submitted, Approved, Issued, Rejected, Graded |
| `DM Action` | select | Options: Approve, Bounce, Log Status |
| `Client Grade` | select | Options: A, B, C, NA |
| `DM Comments` | rich_text | Bounce-back notes |
| `Submitted` | date | |
| `Reviewed` | date | |
| `Issued` | date | |
| `Dropbox Link` | url | Shareable link |
| `Dropbox Path` | rich_text | Raw file path for move instructions |

### MDS fields the cascade writes (existing properties — confirm names match)

The backend writes to these existing MDS properties:
- `Drawing Status` (select): DM Review / Client Review / Being Revised / Production Update
- `Submission Stage` (select): verbose S-stage labels
- `Rev` (select): P01–P03, C01–C03
- `S4 Status` (select): A / B / C
- `S5 Status` (select): A / B / C / NA
- `S4 Submit Date (Actual)` (date)
- `S5 Submit Date (Actual)` (date)
- `C01 Submit Date (Actual)` (date)
- `Model Submit Date` (date)
- `S4 Status Date` (date)
- `S5 Status Date` (date)
- `C01 Sign Off` (date) ← note: no "(Actual)" suffix

**CRITICAL write rule:** NEVER write to `(Plan)`, `(Adj)`, or formula properties.
Only write `(Actual)` dates and status selects. Formula fields throw API errors.

### Tasks DB — new property being added by DM

| Property | Type | Notes |
|----------|------|-------|
| `Miro Board` | url | Link to the item's Miro board — added by DM now |

### Programme Inputs DB — schema

| Property | Type | Notes |
|----------|------|-------|
| `Name` | title | e.g. `24-367 — Project defaults` |
| `Scope` | select | Project / Task |
| `Project` | relation → Projects | |
| `Task` | relation → Tasks | Task-scoped rows only |
| `Programme Start` | date | |
| `S3 Lead Time (days)` | number | |
| `S4 Lead Time (days)` | number | |
| `S4 QA Days` | number | |
| `S4 Client Review Days` | number | |
| `S5 Lead Time (days)` | number | |
| `S5 QA Days` | number | |
| `S5 Client Review Days` | number | |
| `C01 Lead Time (days)` | number | |
| `C01 Sign Off Days` | number | |

---

## 5. The backend module — drawing-flow.js

**This file is WRITTEN and should not be recreated from scratch.**
It lives at `axiom-drawing-flow/drawing-flow.js`.

### How to mount it

Add these two lines to `app.js` BEFORE the static file middleware:
```js
const mountDrawingFlow = require("./drawing-flow");
mountDrawingFlow(app, notion);
```

### API routes provided

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/api/df/ingest` | `{ filePath, dropboxPath, dropboxLink }` | Submission created |
| GET | `/api/df/submissions` | — | Queue of Status=Submitted |
| PATCH | `/api/df/submissions/:id/approve` | — | `{ ok, issuedDate, dropboxMove? }` |
| PATCH | `/api/df/submissions/:id/bounce` | `{ comments }` | `{ ok, bouncedAt, dropboxMove? }` |
| PATCH | `/api/df/submissions/:id/log-status` | `{ grade }` | `{ ok, grade, requiresRevision }` |
| GET | `/api/df/drawings` | `?taskId&stage&status` | MDS drawing rows |

### Property names to verify before first run

Open `drawing-flow.js` and search for `← confirm`. These assumed property
names must be checked against the actual Notion DBs:

| Property | DB | Location in code |
|----------|----|-----------------|
| `Item No.` | Tasks | `findTask()` — assumed number type |
| `Item Name` | Tasks | error messages — assumed title |
| `Drawing Number` | MDS | `findDrawing()` — assumed title |
| `Item` | MDS | `findDrawing()` — relation to Tasks |
| `Initials` | Team | `findDT()` — assumed rich_text |
| `Projects` | Tasks | `findTask()` — rollup, rich_text array |
| `Dropbox Path` | Submissions | bounce/approve routes — rich_text |

### Gmail stubs

The three notification emails are stubbed with `// TODO:` comments.
When wiring Gmail:
1. Create `gmailService.js` exporting `sendApprovalEmail`, `sendBounceEmail`, `sendGradeEmail`
2. Import at top of `drawing-flow.js`
3. Replace the TODO comments with the function calls
4. Add Gmail credentials to `.env`:
   ```
   GMAIL_USER=
   GMAIL_APP_PASSWORD=
   GMAIL_FROM=
   ```

---

## 6. Dropbox and Zapier setup

### Folder structure

```
/Axiom Submissions/
  ├── _DT Submission Guide.pdf         ← mandate PDF (see section 8)
  └── {ProjectNo}/                     ← e.g. 24-367
        └── {Stage}/                   ← S3 | S4 | S5 | A4.5
              ├── Pending/             ← DTs upload here. Zapier watches ONLY this.
              ├── Rejected/
              │     └── R{N}/          ← bounced files, one subfolder per QA round
              └── {approved PDFs}      ← approved files promoted here on Approve
```

### Filename convention

```
{ItemNo}_{DrawingNo}_{Rev}_{DTinitials}.pdf
e.g.  003_A-101_P01_GM.pdf
```

- `ItemNo`: short numeric code matching Tasks DB `Item No.` property (e.g. `003`)
- `DrawingNo`: drawing number WITHOUT project prefix (e.g. `A-101` not `24-367-A-101`)
- `Rev`: revision label (P01–P03, C01–C03)
- `DTinitials`: must match Team DB `Initials` property exactly

DWG files are NOT submitted — issued by DT directly after Approve notification.

### Zapier Zaps required

**Zap 1 — Ingest**
- Trigger: Dropbox → New File in Folder (`/Axiom Submissions`, watch subfolders)
- Filter step: path contains `/Pending/` AND filename ends with `.pdf`
- Action: Webhooks by Zapier → POST to `/api/df/ingest`
- Body: `{ "filePath": "{{file path}}", "dropboxPath": "{{file path}}", "dropboxLink": "{{file link}}" }`

**Zap 2 — Bounce file move**
- Trigger: poll `GET /api/df/submissions?status=Rejected` for rows where dropboxPath exists but file not yet moved
- OR: Catch Hook triggered by bounce route
- Action: Dropbox → Move File using `dropboxMove.from` and `dropboxMove.to` from response

**Zap 3 — Approve file move**
- Same pattern as Zap 2 but for Approve → promotes file to stage root

---

## 7. The cockpit UI (to build)

The main DM-facing view. Sits open on the DM's desktop as a permanent tab.
Route: `/` (root, or `/cockpit`)

### Behaviour

- Polls `GET /api/df/submissions` every 30 seconds
- Shows a queue of Submissions with `Status = Submitted`, sorted by `BIC Since` ascending
  (longest-waiting first — the chase metric)
- Groups by Task/Item for visual clarity
- Each row shows: Drawing No., Stage, Revision, QA Round, BIC Since, DT name, Dropbox link
- Each row has two buttons: **Approve** and **Bounce**
- Bounce opens a comments input before firing
- A separate **Log Status** action (A/B/C grade) appears on `Status = Issued` submissions
- Desktop notification (browser Notification API) when new submissions arrive

### Design reference

Look at `workflow-tracker/public/focus-queue.jsx` for the queue/inbox pattern to follow.
The cockpit is conceptually similar — a sorted actionable list — but simpler (two actions
per row, not a multi-step phase advance).

Dark theme preferred (consistent with the DM Tracker Hub aesthetic).

---

## 8. The Programme Inputs form (to build)

Route: `/inputs`

### Behaviour

- Select a Project from a dropdown (fetches from `GET /api/projects`)
- Optionally select a Task within that project (fetches Tasks for that project)
- Shows all Programme Inputs fields (see schema in section 4)
- Task-scope rows show the Project default as a faint placeholder in each field
- Typing a value "activates" an override (shown bold); a small `↩` link clears it back
- Save button writes to `NOTION_DB_INPUTS` via a new `POST /api/df/inputs` route
- Reset overrides button clears the Task-scope row back to all nulls

### API routes needed for this form

```
GET  /api/df/inputs/:projectId              → project-scope row
GET  /api/df/inputs/:projectId/:taskId      → task-scope row (with inherited values resolved)
POST /api/df/inputs                         → create or update a row
```

---

## 9. DT mandate PDF (to generate)

A PDF that lives at the root of `/Axiom Submissions/` in Dropbox.
DTs must read this before submitting anything.

**Contents:**
1. Folder structure diagram — where to upload
2. Filename convention with worked examples
3. What happens after submission (the DM reviews, you get notified)
4. What a bounce means and what to do (revise source file, re-export PDF, re-upload to `/Pending/`)
5. What NOT to do (rename after upload, move files, upload DWG to Pending, upload to wrong stage folder)
6. The revision number rule — the revision (P01/P02 etc.) only changes on official client issue, NOT during internal review rounds
7. Contact for errors (filename wrong, wrong folder, etc.)

**Format:** Clean, professional PDF. Axiom DL branding if available.
Use the pdf skill (`/mnt/skills/public/pdf/SKILL.md`) when generating.

---

## 10. Parallel workstream — DT Drawing Checker rework

**DO NOT start this until the ingest route is tested end-to-end.**

The DT Drawing Checker is a separate app at:
```
C:\Users\greig\Documents\ClaudeProjects\DTDrawingChecker
```

It currently has: PDF rendering (pdfjs-dist), manual capture mode, drag-rectangle
transcription, colour-coded annotation pins, Notion write-back for RFIs and DM tasks,
batch save, merged PDF export, PNG export.

**What needs adding:**
1. Per-page Approve / Bounce buttons connected to `/api/df/submissions/:id/approve|bounce`
2. Bounce triggers a comments input → passes to the bounce route body
3. On Bounce: the Checker exports the merged marked-up PDF → fires to DT via Gmail
4. On Bounce: the Checker exports PNGs → pushes to the Item's Miro board via Miro API
5. The Checker needs to know the Submission ID for each drawing page —
   fetch from `GET /api/df/submissions` filtered by drawing number

**Miro API notes:**
- Requires OAuth2 (not just API key) — Greig needs to create a Miro developer app
- Endpoint for adding images to a board: `POST /v2/boards/{boardId}/images`
- Board URL comes from the `Miro Board` property on the Task (new URL property)
- PNGs should land in a new Miro frame per QA round: label `{DrawingNo} — R{N} — {date}`

---

## 11. Future workstream — Workflow 2 (commercial control)

**DO NOT build any of this. It is captured for future reference only.**

See `docs/WORKFLOW-2-BRIEFING.md` for the full briefing.

Summary: a three-layer commercial model (Contract Hrs → Allocated → Estimated/Actual)
with an over-allocation flag that triggers variation handling. Involves the Timesheets,
To Do, and Variations databases. Entirely separate from Workflow 1 (drawing submissions).

---

## 12. Build sequence

Follow this order. Do not skip ahead.

```
Step 1  ← Notion setup (DM doing this now, in parallel)
         Create Submissions DB with all properties from section 4
         Create Team DB (if not existing) with Initials property
         Create Inputs DB with properties from section 4
         Add Miro Board URL property to Tasks DB

Step 2  ← Scaffold app.js, server.js, package.json, netlify.toml
         Copy structure from workflow-tracker exactly
         Mount drawing-flow.js (two lines — see section 5)
         Set up .env with all DB IDs once DM provides them

Step 3  ← Verify property names
         Run each Notion lookup manually (or via a /api/df/test route)
         Fix any ← confirm property names in drawing-flow.js

Step 4  ← Set up Zapier Zap 1 (ingest)
         Test with a real PDF drop into /Pending/
         Verify Submission row created in Notion
         Verify MDS Drawing Status → DM Review

Step 5  ← Build cockpit UI (cockpit.jsx)
         Polls /api/df/submissions
         Approve and Bounce buttons wired
         Desktop notification on new arrival

Step 6  ← Wire Zapier Zaps 2 and 3 (file moves)
         Test bounce → file appears in /Rejected/R1/
         Test approve → file promoted to stage root

Step 7  ← Build Programme Inputs form (inputs.jsx + /api/df/inputs routes)

Step 8  ← Wire Gmail notifications (gmailService.js)

Step 9  ← Generate DT mandate PDF

Step 10 ← DT Drawing Checker rework (separate workstream)
```

---

## 13. Key decisions and constraints (do not re-litigate)

These were resolved through extensive design discussion. Do not change them
without flagging to Greig first.

| Decision | Rationale |
|----------|-----------|
| `@notionhq/client` SDK (not raw fetch) | Consistent with workflow-tracker fork base |
| MDS IS the Drawings tier | Existing MDS already models submission stages richly |
| Zapier for Dropbox trigger only | Logic lives in backend; Zapier does one dumb thing |
| Zapier handles file moves (via response instructions) | No Dropbox credentials in backend |
| Stage in folder, drawing detail in filename | Folders reliable, filenames get fat-fingered |
| Revision number only changes on official client issue | NOT during internal DM QA rounds |
| Permanent retention of Rejected files | Audit trail for construction disputes |
| BIC + BIC Since on Submission rows | Chase metric — who holds it, since when |
| QA Round counter per S-stage | Resets on entering a new stage |
| `/Pending/` intake subfolder per stage | Zapier watches only this; approved/rejected files elsewhere |
| Commercial hours = Workflow 2 (not built here) | Different ownership, lifecycle, trigger |

---

## 14. Environment variables

```env
# Existing (from workflow-tracker)
NOTION_TOKEN=ntn_xxxx

# Existing — reused
NOTION_DB_TASKS=bb783a35-a407-4637-89c6-78ebc76c8699
NOTION_DB_PROJECTS=5c689434c2b047669831d2b31ef0f8de

# New — IDs provided by DM after Notion setup
NOTION_DB_DRAWINGS=13b210e4582e8168923ff79fa8628b59
NOTION_DB_SUBMISSIONS=36f210e4582e80ed8b2ce9e245bda433
NOTION_DB_TEAM=348210e4582e8050ac70fd18982185cc

# Gmail — add when wiring notifications
GMAIL_USER=
GMAIL_APP_PASSWORD=
GMAIL_FROM=

PORT=3000
```

---

## 15. Contact / clarification

All design decisions are documented in `docs/`. If something is ambiguous or seems
inconsistent, read the relevant spec doc before making assumptions:

- Data model questions → `DATA-MODEL.md`
- Inputs form questions → `INPUTS-ARCHITECTURE.md`
- What to keep/delete in Notion → `STREAMLINING.md` + `NOTION-MIGRATION-CHECKLIST.md`
- Hours / commercial questions → `WORKFLOW-2-BRIEFING.md` (and don't build it)
