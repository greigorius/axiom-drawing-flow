# Axiom Drawing Flow

**Owner:** Greig Fensome (Design Manager, Axiom DL)
**Repo:** `axiom-drawing-flow`
**Live URL:** https://axiom-drawing-flow.netlify.app
**Last updated:** July 2026

---

## Purpose

Axiom Drawing Flow is a drawing submission and QA automation system for Axiom DL, a UK joinery and fit-out company. The Design Manager (DM) oversees multiple remote Design Technicians (DTs) who submit architectural PDF drawings for staged ISO-19650 review. Without this tool, tracking submissions, QA rounds, file moves, and DT notifications was entirely manual.

The system automates:
- **Ingestion** — Make.com detects new PDFs in Dropbox and registers them in Notion
- **QA review** — the DM approves, bounces, or logs a client grade via a browser cockpit
- **File management** — Make.com moves files in Dropbox (Pending → Rejected/Approved folders) based on backend instructions
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
| **Approve** | Button on For Review card | Sets status to Approved, updates MDS submit date + drawing status, sends Dropbox move instruction to Make.com |
| **Bounce** | Button on For Review card | Opens confirm modal → sets status to Rejected, increments QA round, sets BIC back to DT, sends Dropbox move instruction to Make.com |
| **Issue** | Button on Awaiting Issue card | Sets status to Issued, updates MDS, fires Make.com issue webhook |
| **Log Status** | Button on Issued card | Records client grade (A/B/C/NA or Approved/Rejected) on the submission and MDS row |
| **Send DT Emails** | Batch button | Fires one summary email per DT covering all their pending notifications |
| **Send Grade Emails** | Batch button | Fires grade notification emails to DTs for all graded submissions |
| **Scan Comments** | Button | Triggers Make.com to scan Dropbox for comment PDFs and link them to MDS rows |
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
| `POST` | `/api/df/ingest` | Called by Make.com when a new PDF lands in Dropbox `/Pending/`. Parses the file path and filename, creates a Submission row in Notion, and updates the MDS. |
| `PATCH` | `/api/df/submissions/:id/approve` | Approves a submission. Updates Notion status + MDS, returns Dropbox move instructions. |
| `PATCH` | `/api/df/submissions/:id/issue` | Confirms official issue. Updates status to Issued. |
| `PATCH` | `/api/df/submissions/:id/bounce` | Bounces a submission back to DT. Increments QA round, returns Dropbox move instructions. |
| `PATCH` | `/api/df/submissions/:id/log-status` | Logs client grade (A/B/C/NA). Updates MDS grade fields. |

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

### Dropbox Folder Structure

```
/DESIGN KNOW HOW/TMJ Interiors/
  └── Drawing Submissions/
        └── {ProjectNo}/          e.g. 24-367
              └── {Stage}/        e.g. S4
                    ├── Pending/  ← DTs upload here; Make.com watches this
                    ├── Rejected/
                    │     └── R{N}/  ← bounced files per QA round
                    └── {approved PDFs live at this level}
```

The `DROPBOX_ROOT` constant in `drawing-flow.js` is set to `/DESIGN KNOW HOW/TMJ Interiors`. Notion stores only the relative path from `Drawing Submissions/` onward; the backend reconstructs the full path when returning move instructions.

### Filename Convention

```
{ItemNo}_{DrawingNo}_{Revision}_{DTInitials}.pdf
e.g. 003_A-101_P01_GM.pdf
```

- `ItemNo` — numeric suffix matching the Tasks DB item (e.g. `003` for "Suffix 003")
- `DrawingNo` — drawing number without project prefix (e.g. `A-101`)
- `Revision` — `P01`–`P03` (preliminary) or `C01`–`C03` (construction)
- `DTInitials` — must exactly match the `Initials` field in the Team DB

### Make.com Scenarios

| Scenario | Trigger | What it does |
|----------|---------|-------------|
| **Scenario 1 — Ingest** | New PDF in any `/Pending/` folder | Calls `POST /api/df/ingest`; backend parses path and filename, creates Submission row |
| **Scenario 2 — Actions Hub** | Webhook from backend (`MAKE_ACTIONS_WEBHOOK`) | Handles Dropbox file moves (approve/bounce), sends DT notification emails, triggers client review ingest |

### Make.com Webhook Actions

The backend fires `MAKE_ACTIONS_WEBHOOK` with an `action` field. Make.com routes based on this:

| Action | Triggered by | Payload |
|--------|-------------|---------|
| `approve` | Approve endpoint | `dropboxMove` object with `from`/`to` paths |
| `bounce` | Bounce endpoint | `dropboxMove` object with `from`/`to`/`toFolder` paths |
| `dt-summary` | Send DT Emails button | Per-DT summary of actioned submissions for email |
| `issue` | Issue endpoint | Submission details for issue notification |
| `grade` | Log Status endpoint | Grade details for DT grade notification |
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
MAKE_CR_INGEST_WEBHOOK=https://hook.eu1.make.com/vge6mxe63qh8ucq44e55bz8bygd19q5d
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

The following workstreams are documented in `docs/` but not yet built:

- **DT Drawing Checker integration** — Approve/Bounce buttons from within the PDF review tool, exporting marked-up PDFs and pushing PNGs to Miro boards
- **Workflow 2 (commercial control)** — contract hours vs allocated vs actual, variation handling — see `docs/WORKFLOW-2-BRIEFING.md`. Do not build until explicitly scoped.
- **Programme Inputs form** — the `/inputs` route has placeholder UI; backend routes exist but the form UI (`inputs.jsx`) is not fully wired

When extending the backend, mount new routes in `drawing-flow.js` following the existing pattern. All routes receive `(app, notion)` via the module export. Never add routes directly to `app.js` — that file only mounts the drawing-flow module and the static file server.
