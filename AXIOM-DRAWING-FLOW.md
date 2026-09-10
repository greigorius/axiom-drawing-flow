# Axiom Drawing Flow

**Owner:** Greig Fensome (Design Manager, Axiom DL)
**Repo:** `axiom-drawing-flow`
**Live URL:** https://axiom-drawing-flow.netlify.app
**Last updated:** September 2026

---

## Purpose

Axiom Drawing Flow is a drawing submission and QA automation system for Axiom DL, a UK joinery and fit-out company. The Design Manager (DM) oversees multiple remote Design Technicians (DTs) who submit architectural PDF drawings for staged ISO-19650 review. Without this tool, tracking submissions, QA rounds, file moves, and DT notifications was entirely manual.

**Review tool:** all drawing review — DM QA of DT submissions and DM review of client
comments — happens in **Drawboard PDF**, opened straight from Dropbox and synced back to the
same file. The Hub is where the DM then acts (Approve / Bounce / Grade); the backend and Make
rename and move the reviewed files. (The DT Drawing Checker, Client Comment Reviewer and Miro
are retired as of Sept 2026.)

The system automates:
- **Ingestion** — Make.com detects new PDFs in Dropbox and registers them in Notion
- **QA review** — the DM approves, bounces, or logs a client grade via a browser cockpit
- **File management** — Make.com moves files in Dropbox (01_Pending → 02_Rejected / 03_Ready For Issue → 04_Issued) based on backend instructions
- **Notifications** — batch email to DTs on review outcomes, and grade notifications after client sign-off
- **Master Drawing Schedule (MDS) sync** — all submission events automatically update the Notion drawings database

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Babel Standalone (no build step — JSX transpiled in-browser) |
| Backend | Express.js (Node 18+), wrapped as a Netlify serverless function |
| Database | Notion (via `@notionhq/client` SDK) |
| Automation | Make.com (formerly Integromat) for Dropbox watch + file moves + email dispatch |
| Deployment | Netlify (auto-deploys from GitHub `main` branch) |
| Source control | GitHub → `push-to-github.bat` for Windows |

All `.jsx` files live in `public/` and are loaded as `<script type="text/babel">` tags in `index.html`. There is no webpack, Vite, or bundler.

---

## File Structure

```
axiom-drawing-flow/
├── app.js                      ← Express app; mounts drawing-flow routes + static files
├── server.js                   ← Local dev launcher (node server.js on port 3000)
├── drawing-flow.js             ← All API routes (the main backend module)
├── netlify.toml                ← Netlify config; routes /api/* to the Lambda function
├── netlify/
│   └── functions/api.js        ← Serverless wrapper (serverless-http@3.2.0)
├── public/
│   ├── index.html              ← SPA shell; loads React + Babel + all JSX files
│   ├── app.jsx                 ← Client-side router (hash-based)
│   ├── cockpit.jsx             ← Main DM view — Kanban queue + all actions
│   ├── inputs.jsx              ← Programme Inputs form (per-project schedule settings)
│   ├── styles.css              ← Global dark-theme styles
│   └── cockpit-kanban.css      ← Kanban-specific styles
├── docs/                       ← Architecture and spec documents
├── push-to-github.bat          ← Windows git commit + push helper
└── package.json
```

---

## The Cockpit (Main UI)

Accessed at the app root (`/`). Designed to sit open permanently on the DM's desktop.

### Kanban Columns (left → right)

| Column | Source | Description |
|--------|--------|-------------|
| **Bounced — With DT** | `Status = Rejected`, `DT Notified = true` | Latest bounced drawings awaiting DT resubmission. Only shows the most recent QA round per drawing (hides older bounces once resubmitted). |
| **For Review** | `Status = Submitted` | New submissions awaiting DM QA. Longest waiting shown first (BIC Since). Grouped by task/item. |
| **Awaiting Issue** | `Status = Approved` + `Status = Awaiting Issue` | Approved drawings waiting for DM to confirm official issue to client. |
| **Issued** | `Status = Issued` | Drawings issued to client, awaiting client grade (A/B/C/NA). Shows comment file indicator. |
| **Graded** | `Status = Graded`, `DT Notified = false` | Client grades logged but DT not yet notified. |

### Actions

| Action | Trigger | What it does |
|--------|---------|-------------|
| **Approve** | Button on For Review card | Status → Approved; Make moves the (Drawboard-reviewed) PDF to `{Project}/03_Ready For Issue/`, name unchanged |
| **Bounce** | Button on For Review card | Confirm modal → status Rejected, BIC → DT; Make moves the marked-up PDF to `{Project}/02_Rejected/{name}_R{n}.pdf` |
| **Issue** | Button on Awaiting Issue card | Sets status to Issued, updates MDS, fires Make.com issue webhook |
| **Grade (Log Status)** | Button on any Issued card, incl. Review Client Comments | Records the client grade (A/B/C/NA for S4/S5, Approved/Rejected for A4.5/AB). Moves logged client comment PDFs to `Client Comments/Reviewed/R_…`; A4.5 Rejected moves the C01 PDF to `05_Client Comments/Grade Returns/` |
| **Send DT Emails** | Batch button | Fires one summary email per DT covering all their pending notifications |
| **Send Grade Emails** | Batch button | Fires grade notification emails to DTs for all graded submissions |
| **Scan Comments** | Button | Triggers Make Scenario 3 to find new client comment PDFs in `Client Comments/` folders → MDS comment files + card moves to Review Client Comments |
| **Scan Pending** | Button | Triggers Make.com Scenario 1 to re-process any missed Dropbox uploads |

### Other UI Features

- **Search** — filters all columns by drawing number, task code, or DT name
- **Density toggle** — compact / comfortable card spacing
- **Auto-refresh** — polls every 30 seconds; backs off to 5-minute intervals after 3 consecutive API errors
- **Desktop notifications** — browser push notification when new submissions arrive
- **Multi-select** — select cards across sections for batch actions

---

## Backend API Routes

All routes are mounted from `drawing-flow.js` under `/api/df/`.

### Queue

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/df/queue` | Single endpoint fetching all queue data in one Lambda invocation. Returns: `submitted`, `rejected`, `approved`, `awaitingIssue`, `issued`, `graded`, `pending`. Runs all Notion queries sequentially to avoid rate limiting. |

### Submissions

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/df/ingest` | Called by Make.com when a new PDF lands in a project's `01_Pending/`. Parses the file path and filename, creates a Submission row in Notion, and updates the MDS. |
| `PATCH` | `/api/df/submissions/:id/approve` | Approves a submission. Updates Notion status + MDS, returns Dropbox move instructions. |
| `PATCH` | `/api/df/submissions/:id/issue` | Confirms official issue. Updates status to Issued and fires `move-files` to move the PDF from `03_Ready For Issue/` to `04_Issued/` (name unchanged). |
| `PATCH` | `/api/df/submissions/:id/bounce` | Bounces a submission back to DT. Increments QA round, returns Dropbox move instructions. |
| `PATCH` | `/api/df/submissions/:id/log-status` | Logs client grade. Updates MDS grade fields; fires `move-files` for client comments (→ Reviewed/R_) and A4.5 Rejected (→ 05_Client Comments/Grade Returns). |
| `POST` | `/api/df/cr-ingest` | Called by Make Scenario 3 per client comment PDF. Stage from the Issued submission (or legacy stage folder); stores the path in `Comment Paths`. |

### Notifications

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/df/send-dt-emails` | Fires batch DT notification webhook to Make.com — one `dt-summary` action per DT covering all their pending items. |
| `POST` | `/api/df/send-grade-emails` | Fires grade notification emails to DTs via Make.com webhook. |

### Drawings & Inputs

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/df/drawings` | Query MDS drawings. Accepts `?taskId`, `?stage`, `?status`. |
| `GET` | `/api/df/inputs/:projectId` | Fetch project-level programme inputs (schedule settings). |
| `GET` | `/api/df/inputs/:projectId/:taskId` | Fetch task-level inputs with project defaults as fallback. |
| `POST` | `/api/df/inputs` | Create or update a programme inputs row. |

### Utilities

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/df/scan-pending` | Triggers Make.com Scenario 1 to re-process the Dropbox Pending folder. |

---

## Notion Databases

### Database IDs

| Env Variable | Database ID | Purpose |
|-------------|-------------|---------|
| `NOTION_DB_SUBMISSIONS` | `36f210e4-582e-80ed-8b2c-e9e245bda433` | One row per submission/QA event (the core log) |
| `NOTION_DB_DRAWINGS` | `13b210e4-582e-8168-923f-f79fa8628b59` | Master Drawing Schedule (MDS) |
| `NOTION_DB_TASKS` | `bb783a35-a407-4637-89c6-78ebc76c8699` | Task/item packages |
| `NOTION_DB_TEAM` | `348210e4-582e-8050-ac70-fd18982185cc` | DT profiles (name, email, initials) |
| `NOTION_DB_PROJECTS` | `5c689434-c2b0-4766-9831-d2b31ef0f8de` | Projects |
| `NOTION_DB_INPUTS` | (set in env) | Programme inputs / schedule settings per project |

### Submissions DB — Key Properties

| Property | Type | Notes |
|----------|------|-------|
| `Submission` | title | Format: `{TaskCode}_{DrawingNo}_{Stage}_{Rev}_{R1}` e.g. `CLG-001_A-101_S4_P01_R1` |
| `Status` | select | `Submitted` → `Approved` / `Rejected` → `Awaiting Issue` → `Issued` → `Graded` |
| `Stage` | select | `S3`, `S4`, `S5`, `A4.5`, `AB` |
| `QA Round` | number | Increments on each bounce; resets when entering a new stage |
| `DT` | relation | Links to Team DB |
| `DT Notified` | checkbox | Set true after batch email sent; used to filter Pending Notification section |
| `Ball In Court` | select | Who currently holds the drawing: `DM`, `DT`, `Architect`, `Contractor`, etc. |
| `BIC Since` | date | When BIC last changed — drives the age indicator and sort order |
| `DM Action` | select | `Approve`, `Bounce`, `Log Status` — records what the DM did |
| `Client Grade` | select | `A`, `B`, `C`, `NA`, `Approved`, `Rejected` |
| `Dropbox Path` | url | Relative path (from `Drawing Submissions/`) — backend reconstructs full path |
| `Folder Link` | url | Dropbox shared folder link — required before DT can be notified of Approved/Rejected |
| `Blocked` | checkbox | Manually flag a submission as blocked (excluded from normal queue logic) |
| `Comment Paths` | rich text | Dropbox paths of client comment PDFs logged by cr-ingest (one per line); rewritten to their `Reviewed/R_…` paths at Log Status |

### MDS (Drawings DB) — Fields Written by the Backend

The backend writes to these MDS properties on Approve, Bounce, and Log Status:

| Property | Written on |
|----------|-----------|
| `S4 Submit Date (Actual)` | Approve (S4) |
| `S5 Submit Date (Actual)` | Approve (S5) |
| `C01 Submit Date (Actual)` | Approve (A4.5) |
| `Model Submit Date` | Approve (S3) |
| `AB Submit Date (Actual)` | Approve (AB) |
| `S4 Status` / `S5 Status` / `AB Status` | Log Status |
| `S4 Status Date` / `S5 Status Date` / `AB Status Date` | Log Status |
| `C01 Sign Off` | Log Status (A4.5) |
| Drawing Status | All actions |

**Critical:** Never write to `(Plan)`, `(Adj)`, or formula properties — these will throw Notion API errors.

---

## Submission Stages

| Stage | Label | Approval BIC | Drawing Status on Approve |
|-------|-------|-------------|--------------------------|
| `S3` | S3 - For Coordination | Architect | Client Review |
| `S4` | S4 - For Review and Authorisation | Contractor | Client Review |
| `S5` | S5 - For Review and Acceptance | Architect | Client Review |
| `A4.5` | A4.5 - Authorised Mfg. & Constr. Design | Contractor | Production Updates |
| `AB` | AB - As Built Record Drawings | Project Team | Client Review |

---

## Dropbox & Make.com Integration

### Dropbox Folder Structure (Sept 2026 — project-level Pending)

```
/DESIGN KNOW HOW/TMJ Interiors/
  └── Drawing Submissions/
        └── {ProjectNo}/            e.g. 24-367
              ├── 01_Pending/           ← DTs upload ALL stages here: {Item}_{Stage}_{Rev}_{DrawingNo}_{Initials}.pdf
              ├── 02_Rejected/          ← Bounce moves the PDF here as {original name}_R{n}.pdf
              ├── 03_Ready For Issue/   ← Approve moves the PDF here (filename unchanged); DT email links here; DTs add DWGs here
              ├── 04_Issued/            ← Issue (cockpit) moves the PDF here, filename unchanged (DWGs stay in 03)
              └── 05_Client Comments/   ← DM drops client comment PDFs here: {Client}_{YYMMDD}_{DrawingNo}_{Rev}.pdf
                    ├── Reviewed/       ← graded comment PDFs moved here as R_{original name}
                    └── Grade Returns/  ← A4.5 (C01) Rejected returns, moved here at Log Status (not scanned as comments)
```

Folder matching ignores the `NN_` prefix, so un-numbered folders (`Pending`, `Rejected`, …) still work.
If a Pending folder is renamed, files that re-surface at the new path are matched to their existing
Submitted row by filename and repointed — not ingested twice.

Grade Returns file name: `{Item}_{Stage}_{Rev}_{DrawingNo}_{Grade}_{YYMMDD}.pdf`.
Legacy stage-level `{Project}/{Stage}/Client Comments/` folders still work (stage taken from the folder).

`01_Pending/`, `02_Rejected/` and `05_Client Comments/` are set up per project by hand (the Bounce
route moves straight into `02_Rejected/` without creating it). `03_Ready For Issue/`, `04_Issued/`,
`05_Client Comments/Grade Returns/` and `Reviewed/` are created by Make on first use if missing.

The `DROPBOX_ROOT` constant in `drawing-flow.js` is set to `/DESIGN KNOW HOW/TMJ Interiors`. Notion stores only the relative path from `Drawing Submissions/` onward; the backend reconstructs the full path when returning move instructions.

**Legacy:** the old per-stage layout (`{ProjectNo}/{Stage}/Pending/`, approved files in
`{ProjectNo}/{Stage}/Suffix NNN/`) is still understood by the backend so drawings already in
flight keep working. In-flight legacy files are moved to the new project-level `03_Ready For Issue/` /
`02_Rejected/` folders when actioned. Legacy branches are marked `LEGACY` in `drawing-flow.js`.

### Filename Convention

```
{Item}_{Stage}_{Rev}_{DrawingNo}_{Initials}.pdf     e.g. 003_S4_P01_EIT-TMJ-AA-B2-D-I-45120_GF.pdf
```

- `Item` — item number in digits, matching "Suffix NNN" in the Tasks DB (e.g. `003`)
- `Stage` — `S3`, `S4`, `S5`, `A4.5` or `AB` (case-insensitive)
- `Rev` — e.g. `P01`–`P03` (preliminary) or `C01`–`C03` (construction)
- `DrawingNo` — full drawing number; hyphens only, **no underscores**
- `Initials` — **required**; the DT's initials, matched against the Team DB name (e.g. Greig
  Fensome → `GF`) to set the `DT` relation on the Submission. A file without initials is rejected.
  If the initials don't match anyone, the DT falls back to the Item's `Person` (Tasks DB) and the
  cockpit feed flags it; if that's empty too, the Submission is created with no DT and flagged.
- Bounced files keep the full name plus `_R{n}`, e.g. `003_S4_P01_…_GF_R1.pdf`.

Files that don't match are rejected at ingest with a specific reason in the cockpit feed
(wrong section count, unknown stage, bad rev, old-style name, etc.).

### Make.com Scenarios

| Scenario | Trigger | What it does |
|----------|---------|-------------|
| **Scenario 1 — Ingest** | New PDF in any project `01_Pending/` folder (filter: path contains `pending/`) (recursive watch on `Drawing Submissions`) | Calls `POST /api/df/ingest`; backend parses path and filename, creates Submission row |
| **Scenario 2 — Actions Hub** | Webhook from backend (`MAKE_ACTIONS_WEBHOOK`) | Handles Dropbox file moves (approve/bounce), sends DT notification emails, triggers client review ingest |

### Make.com Webhook Actions

The backend fires `MAKE_ACTIONS_WEBHOOK` with an `action` field. Make.com routes based on this:

| Action | Triggered by | Payload |
|--------|-------------|---------|
| `approve` | Approve endpoint | `dropboxMove` (`from`, `toFolderParent`, `toFolderName`, `toFolder`, `newFilename`) |
| `bounce` | Bounce endpoint | `dropboxMove` (same shape — Make **moves**, never deletes) |
| `move-files` | Log Status, Issue | `moves[]` of the same shape — client comments → Reviewed/R_, A4.5 Rejected → 05_Client Comments/Grade Returns, Issue → 04_Issued |
| `dt-summary` | Send DT Emails button | Per-DT summary of actioned submissions for email |
| `issue` | Issue endpoint | Submission details for issue notification |
| `grade-summary` | Send Grade Emails button | Per-DT summary; folder block per return folder (Reviewed or Grade Returns) |
| `cr-ingest` | Client Review ingest | Triggers Scenario 1 equivalent for comment PDFs |

---

## Environment Variables

Set these in Netlify → Site Settings → Environment Variables, and in a local `.env` file for development.

```env
# Notion
NOTION_TOKEN=ntn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Notion Database IDs
NOTION_DB_SUBMISSIONS=36f210e4-582e-80ed-8b2c-e9e245bda433
NOTION_DB_DRAWINGS=13b210e4-582e-8168-923f-f79fa8628b59
NOTION_DB_TASKS=bb783a35-a407-4637-89c6-78ebc76c8699
NOTION_DB_TEAM=348210e4-582e-8050-ac70-fd18982185cc
NOTION_DB_PROJECTS=5c689434-c2b0-4766-9831-d2b31ef0f8de
NOTION_DB_INPUTS=                              # Set once Inputs DB is created in Notion

# Make.com
MAKE_ACTIONS_WEBHOOK=                          # Scenario 2 webhook URL
MAKE_CR_INGEST_WEBHOOK=https://hook.eu1.make.com/xxxx      # Client-review ingest webhook URL
MAKE_SCENARIO_ID=                              # Scenario 1 ID (for Scan Pending button)
MAKE_API_KEY=                                  # Make.com API key
MAKE_API_ZONE=eu1                              # Make.com region

# Local dev only
PORT=3000
```

---

## Deployment

**Platform:** Netlify
**Auto-deploy:** Yes — any push to GitHub `main` branch triggers a build

### Netlify Configuration (`netlify.toml`)

```toml
[build]
  functions = "netlify/functions"
  publish   = "public"

[[redirects]]
  from = "/api/*"
  to   = "/.netlify/functions/api/:splat"
  status = 200

[[redirects]]
  from = "/*"
  to   = "/index.html"
  status = 200
```

All `/api/*` requests are routed to the single Lambda function at `netlify/functions/api.js`, which wraps the Express app via `serverless-http@3.2.0`. The `public/` folder is served as static files.

### Local Development

```bash
# Install dependencies
npm install

# Start local server (port 3000)
node server.js
# or
start.bat
```

### Deploy to Production

```bat
# From Windows — commits and pushes to GitHub (Netlify auto-deploys)
push-to-github.bat
```

---

## Rate Limiting Notes

Notion's API is limited to approximately 3 requests/second per integration token. The `GET /api/df/queue` endpoint is designed to handle this:

1. All 6 status group queries run sequentially with 200ms gaps
2. All unique DT IDs are resolved in one pass (cached in memory per request)
3. The issued-comment check runs sequentially with 100ms gaps
4. Total Notion API calls per queue load: ~10–15 (regardless of submission volume)

If the cockpit gets repeated 502 errors (Lambda crash), check for syntax errors in `drawing-flow.js` first — the file is vulnerable to tail truncation when large edits are made via AI tooling. Always run `node --check drawing-flow.js` before pushing.

---

## Key Business Logic

### QA Round Counter

Each time a drawing is bounced, `QA Round` increments. It resets to 1 when a drawing enters a new stage (S3 → S4 → S5 etc.). This means a drawing can be R3 in S4 and R1 in S5 simultaneously.

### Bounced Column Filter

The "Bounced — With DT" cockpit column only shows the latest bounced submission per drawing. If a DT resubmits (creating a new `Submitted` row with a higher QA Round), the old bounce disappears from the column automatically. Logic: a rejected submission is shown only if its `QA Round` is ≥ the highest round seen for that drawing across all statuses.

### Revision Days

On Approve, the backend calculates a due date for the client review period using working days. The number of revision days is read from the Project record in Notion (defaults to 7 working days if not set).

### Drawing Type Inference

The backend infers the drawing type (Drawing / Sketch / Model / Schedule) from the drawing number pattern: `-D-`, `-SK-`, `-M-`, `-L-`. This is written to the MDS `Dwg No. Assigned` field on first submission.

---

## Future Development

- **Workflow 2 (commercial control)** — contract hours vs allocated vs actual, variation handling — see `docs/WORKFLOW-2-BRIEFING.md`. Do not build until explicitly scoped.
- **Programme Inputs form** — the `/inputs` route has placeholder UI; backend routes exist but the form UI (`inputs.jsx`) is not fully wired

Tests: `node tests/parsing.test.js` and `node tests/routes.test.js` (no dependencies — Notion, Make and
Netlify Blobs are mocked). Run both plus `node --check drawing-flow.js` before every push.

When extending the backend, mount new routes in `drawing-flow.js` following the existing pattern. All routes receive `(app, notion)` via the module export. Never add routes directly to `app.js` — that file only mounts the drawing-flow module and the static file server.
