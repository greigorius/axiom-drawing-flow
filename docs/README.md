# Axiom Drawing Flow

Drawing submission and QA review automation for Axiom DL.
Extends the Workflow Tracker (`workflow-tracker`) with a three-tier
submission event log (Tasks → MDS drawings → Submissions).

---

## Architecture

```
Dropbox /Pending/  →  Zapier (trigger only)  →  POST /api/df/ingest
                                                       ↓
                                              drawing-flow.js (this module)
                                                       ↓
                                         Notion: Submissions + MDS + Tasks
                                                       ↑
Workflow Tracker cockpit  ←  GET /api/df/submissions (poll)
DT Drawing Checker        →  PATCH /api/df/submissions/:id/approve|bounce|log-status
```

---

## Mounting into app.js

Add **two lines** to the existing `app.js`, before the catch-all `app.get("*", ...)`:

```js
// Drawing Flow routes
const mountDrawingFlow = require("./drawing-flow");
mountDrawingFlow(app, notion);
```

That's it. All routes are prefixed `/api/df/` so they can't collide with existing `/api/` routes.

---

## Environment variables

Add to your `.env` (the `NOTION_TOKEN` and `NOTION_DB_TASKS` already exist):

```env
NOTION_DB_DRAWINGS=13b210e4582e8168923ff79fa8628b59
NOTION_DB_SUBMISSIONS=36f210e4582e80ed8b2ce9e245bda433
NOTION_DB_TEAM=348210e4582e8050ac70fd18982185cc
```

Gmail credentials (for the notification stubs — add when wiring up email):
```env
GMAIL_USER=
GMAIL_APP_PASSWORD=
GMAIL_FROM=
```

---

## Dropbox folder structure

```
/Axiom Submissions/
  ├── _DT Submission Guide.pdf           ← DT mandate — see docs/DT-MANDATE.pdf
  └── {ProjectNo}/                       ← e.g. 24-367
        └── {Stage}/                     ← S3 | S4 | S5 | A4.5
              ├── Pending/               ← DTs upload here. Zapier watches ONLY this folder.
              ├── Rejected/              ← Bounced files moved here by cascade on Bounce.
              └── {approved files}/      ← Approved PDFs promoted here on Approve.
```

## Filename convention

```
{ItemNo}_{DrawingNo}_{Rev}_{DTinitials}.pdf
e.g.  003_A-101_P01_GM.pdf
```

| Part | Example | Source |
|------|---------|--------|
| ItemNo | `003` | Short code from Task "Item No." property |
| DrawingNo | `A-101` | Drawing number without project prefix |
| Rev | `P01` | Revision label (P01–P03, C01–C03) |
| DTinitials | `GM` | DT's initials (must match Team DB "Initials" property) |

DWG files are **not** submitted here — they are issued by the DT directly after Approve notification.

---

## Zapier setup

### Zap 1 — Ingest (new file → Submission)

**Trigger:** Dropbox → New File in Folder
- Folder: `/Axiom Submissions` (watch subfolders: yes)
- Filter (Zapier filter step): path contains `/Pending/` AND filename ends with `.pdf`

**Action 1:** Webhooks by Zapier → POST
- URL: `https://your-app.netlify.app/api/df/ingest`
- Body (JSON):
  ```json
  {
    "filePath":    "{{file path}}",
    "dropboxPath": "{{file path}}",
    "dropboxLink": "{{file link}}"
  }
  ```
  > `filePath` drives the parser. `dropboxPath` is stored on the Submission for later
  > move instructions. `dropboxLink` is the human-readable shareable URL.

---

### Zap 2 — Bounce file move (Bounce → /Rejected/R{N}/)

**Trigger:** Webhooks by Zapier → Catch Hook
- Zapier listens for the Drawing Flow backend to call this hook *after* a Bounce.

**Alternative (simpler):** Poll-based — poll `GET /api/df/submissions?status=Rejected&unMoved=true`
every 15 minutes and move any unmoved rejected files.

**Action:** Dropbox → Move File
- From: `{{dropboxMove.from}}` (returned in the Bounce response)
- To:   `{{dropboxMove.to}}`

> The backend returns `dropboxMove: { from, to }` in the Bounce response.
> Wire Zapier to read this and act on it. If `dropboxMove` is absent (no path stored),
> the action is skipped gracefully.

---

### Zap 3 — Approve file move (Approve → stage root)

Same pattern as Zap 2 but triggered by an Approve action.
- From: `/Pending/003_A-101_P01_GM.pdf`
- To:   `/003_A-101_P01_GM.pdf` (stage root — the clean issued record)

---

### Submissions DB: add Dropbox Path property

Add a `Dropbox Path` **rich text** property to your Submissions Notion DB.
The ingest route writes the raw file path here so the bounce/approve routes
can construct accurate move instructions without re-parsing.

---

## Spec documents

All design decisions are in `docs/`:

| File | Contents |
|------|---------|
| `DATA-MODEL.md` | Three-tier model, MDS field mapping, Submissions schema |
| `INPUTS-ARCHITECTURE.md` | Programme Inputs DB + form design |
| `STREAMLINING.md` | MDS/Tasks deduplication analysis |
| `NOTION-MIGRATION-CHECKLIST.md` | Manual Notion changes worklist |
| `WORKFLOW-2-BRIEFING.md` | Commercial/hours loop (future workstream) |

---

## Property names to verify

A few property names in `drawing-flow.js` are marked with `← confirm` comments.
Check these against your actual Notion database before first run:

| Property | Database | Used in | Default assumed |
|----------|----------|---------|-----------------|
| `Item No.` | Tasks | `findTask()` | number type |
| `Item Name` | Tasks | error messages | title type |
| `Drawing Number` | MDS | `findDrawing()` | title type |
| `Item` | MDS | `findDrawing()` relation filter | relation to Tasks |
| `Initials` | Team | `findDT()` | rich_text type |
| `Projects` | Tasks | project scoping rollup | rollup → rich_text array |
| `Dropbox Path` | Submissions | bounce/approve move | rich_text (add to Submissions DB) |

---

## API reference

| Method | Path | Body | Action |
|--------|------|------|--------|
| POST | `/api/df/ingest` | `{ filePath, dropboxLink }` | Zapier → create Submission |
| GET | `/api/df/submissions` | — | Cockpit queue (Status=Submitted) |
| PATCH | `/api/df/submissions/:id/approve` | — | Issue cascade + (Gmail stub) |
| PATCH | `/api/df/submissions/:id/bounce` | `{ comments }` | Reject cascade + (Gmail stub) |
| PATCH | `/api/df/submissions/:id/log-status` | `{ grade }` | A/B/C cascade + (Gmail stub) |
| GET | `/api/df/drawings` | `?taskId&stage&status` | MDS drawing view |
