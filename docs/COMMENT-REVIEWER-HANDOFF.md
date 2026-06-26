# Client Comment Reviewer — Claude Code Build Handoff

**Date:** 2026-06-25
**Spec:** `axiom-drawing-flow/docs/CLIENT-COMMENT-REVIEWER-SPEC.md` (full detail)
**New project folder:** `C:\Users\greig\Documents\ClaudeProjects\axiom-client-comment-reviewer\`
**Port from (do not modify):** `C:\Users\greig\Documents\ClaudeProjects\DrawingCommentReviewer\`
**Related backend:** `C:\Users\greig\Documents\ClaudeProjects\axiom-drawing-flow\`

---

## 1. What you are building

A new standalone web app (`axiom-client-comment-reviewer`) used by the DM (Greig) to
review marked-up PDFs returned from clients after drawings are issued. The DM places
numbered pins on each comment, assigns a category, grades the drawing, and sends a
notification email to the DT.

**This is NOT the DT submission checker.** It sits downstream of that — clients return
comments on already-issued drawings. The DT submission QA flow is handled in a separate app.

**Key behaviours:**
- PDF viewer (client's marked-up drawing) with pin drop overlay
- 7 pin categories, colour-coded, numbered sequentially
- Categories 1–3 (Change sub-types) trigger an On Hold flag written to Notion
- DM grades the drawing (A/B/C/NA) in the right panel
- "Save & Close" writes grade + on-hold state to Notion (Submissions DB + MDS)
- "Send DT Email" fires a Make.com webhook → Gmail to the DT
- RFI popup on Cat 3 pins → creates RFI record in Notion
- Export: flattens pins onto PDF, saves as `{original}_R.pdf`

---

## 2. Tech Stack

**Use Vite + React — NOT the no-build Babel pattern from axiom-drawing-flow.**

The DrawingCommentReviewer (port source) uses Vite and it works well. The PDF
rendering, drag-drop pins, and state complexity require proper bundling.

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite (`@vitejs/plugin-react`) |
| Backend | Express.js (Node 18+) in `server/` directory |
| Notion client | `@notionhq/client` SDK |
| PDF render | `pdfjs-dist` |
| PDF export | `pdf-lib` |
| Dev runner | `concurrently` (Vite + Express together) |
| Styling | Plain CSS — dark theme |

**vite.config.js** — copy from DrawingCommentReviewer exactly:
```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3001' } },
  optimizeDeps: { exclude: ['pdfjs-dist'] },
  build: {
    rollupOptions: {
      output: {
        manualChunks: { pdfjs: ['pdfjs-dist'], 'pdf-lib': ['pdf-lib'], vendor: ['react','react-dom','fflate'] },
      },
    },
  },
});
```

**package.json scripts:**
```json
{
  "dev": "concurrently \"vite\" \"node server/index.js\"",
  "build": "vite build",
  "preview": "vite preview"
}
```

---

## 3. Project Structure (build this)

```
axiom-client-comment-reviewer/
├── vite.config.js
├── index.html
├── package.json
├── clients.json                  ← client acronym register (see section 5)
├── .env.example
├── server/
│   ├── index.js                  ← Express app + route mounting
│   ├── .env                      ← copy from .env.example, fill in keys
│   └── routes/
│       ├── comment-review.js     ← main backend module (build this)
│       └── notion.js             ← Notion lookups (port + extend from DrawingCommentReviewer)
└── src/
    ├── main.jsx
    ├── index.css
    ├── App.jsx                   ← shell: left panel + viewer + right panel
    ├── utils/
    │   ├── nanoid.js             ← port from DrawingCommentReviewer unchanged
    │   ├── exportPDF.js          ← port + update pin colours/legend (see section 7)
    │   └── exportPNG.js          ← port unchanged if needed
    └── components/
        ├── PDFViewer.jsx         ← port from DrawingCommentReviewer (minimal changes)
        ├── PinOverlay.jsx        ← port + REPLACE category logic (see section 7)
        ├── CategoryToolbar.jsx   ← NEW: 7-category floating selector
        ├── RightPanel.jsx        ← NEW: metadata + grading section
        ├── FileQueue.jsx         ← NEW: left panel file list
        ├── RFIModal.jsx          ← port RFIForm.jsx + update fields (see section 7)
        ├── LegendStamp.jsx       ← NEW: draggable legend overlay
        └── TopBar.jsx            ← port from DrawingCommentReviewer (minor changes)
```

**Do NOT copy these from DrawingCommentReviewer:**
- `server/routes/extract.js` — AI auto-extraction is abandoned
- `server/routes/transcribe.js` — not needed
- `src/hooks/useCommentExtraction.js` — not needed
- `src/utils/extractAnnotations.js`, `extractWithAI.js` — not needed
- `src/components/CommentBadge.jsx`, `CommentRow.jsx`, `CommentList.jsx`, `DMForm.jsx`,
  `ExportMenu.jsx`, `ProjectSelector.jsx` — not ported; new components replace these

---

## 4. Environment Variables

Create `server/.env` (never commit):

```env
# Notion
NOTION_API_KEY=secret_...          ← same token as other Axiom projects

# Make.com
MAKE_ACTIONS_WEBHOOK=https://hook.eu2.make.com/...   ← same webhook as axiom-drawing-flow

# Anthropic (RFI description generation — same key as DrawingCommentReviewer)
ANTHROPIC_API_KEY=sk-ant-...

PORT=3001
```

The Vite dev server runs on port 5173 and proxies `/api` → port 3001.

---

## 5. clients.json

Create at project root:
```json
{
  "clients": [
    { "acronym": "MC",   "name": "Main Contractor" },
    { "acronym": "ARCH", "name": "Architect" },
    { "acronym": "PM",   "name": "Project Manager" },
    { "acronym": "ENG",  "name": "Engineer" },
    { "acronym": "ID",   "name": "Interior Designer" }
  ]
}
```

---

## 6. Notion Databases

### DB IDs

```
NOTION_DB_DRAWINGS    = 13b210e4582e8168923ff79fa8628b59   ← MDS (Master Drawing Schedule)
NOTION_DB_SUBMISSIONS = 36f210e4582e80ed8b2ce9e245bda433   ← Submissions event log
NOTION_DB_TEAM        = 348210e4582e8005bb58d4aa963dd101   ← DT profiles
NOTION_DB_TASKS       = bb783a35-a407-4637-89c6-78ebc76c8699
NOTION_DB_PROJECTS    = 5c689434c2b047669831d2b31ef0f8de
NOTION_DB_RFIS        = 22d210e4582e80189f63f2cee93be4b3
```

### Confirmed Submissions DB properties (all existing — no new ones needed)

| Property | Type | Notes |
|----------|------|-------|
| `Submission` | title | e.g. `24-367-003_A-101_S4_R1` |
| `Drawing` | relation → MDS | |
| `Task` | relation → Tasks | |
| `Stage` | select | S3 / S4 / S5 / A4.5 / AB |
| `Revision` | select | P01–P03 / C01–C03 |
| `DT` | relation → Team | |
| `Ball In Court` | select | DM / DT / Architect / Contractor / etc. |
| `Status` | status | Submitted / Approved / Issued / Rejected / Graded |
| `Client Grade` | select | A / B / C / NA / Approved / Rejected |
| `Reviewed` | date | Set when DM saves review |
| `Blocked` | checkbox | True when on hold |
| `Dropbox Path` | rich_text | Path of original DT submission PDF |

**Query for the comment reviewer queue:** find Submissions where `Status = Issued` and
the relevant MDS drawing has an `S4 Comment Files` (or S5/A4.5) property set.

### MDS properties — existing (written during grade save)

| Property | Stage | Type |
|----------|-------|------|
| `Drawing Number` | — | title |
| `Drawing Status` | — | select: First Issue / DM Review / Client Review / Approval Updates / Production Updates / On Hold / Complete |
| `Item` | — | relation → Tasks |
| `S4 Status` | S4 | select: A / B / C / NA |
| `S4 Status Date` | S4 | date |
| `S5 Status` | S5 | select: A / B / C / NA |
| `S5 Status Date` | S5 | date |
| `C01 Sign Off` | A4.5 | date |

### MDS properties — NEW (DM must add these before Step 1 of build)

| Property | Type | Notes |
|----------|------|-------|
| `S4 Comment Files` | rich_text | Accumulates hyperlinked file names, appended per ingest |
| `S5 Comment Files` | rich_text | Same for S5 |
| `A4.5 Comment Files` | rich_text | Same for A4.5 |
| `S4 Client Reviewers` | multi-select | Options: MC / ARCH / PM / ENG / ID |
| `S5 Client Reviewers` | multi-select | Same options |
| `A4.5 Client Reviewers` | multi-select | Same options |
| `Hold Notes` | rich_text | Written on save when blocked; cleared on unblock |

**Ingest append pattern for Comment Files:**
- Read existing `S4 Comment Files` rich_text value
- Append a new hyperlinked segment: filename as display text, Dropbox URL as href
- Use Notion's rich_text `link` object: `{ text: { content: filename, link: { url: dropboxLink } } }`
- Write back the full array (existing segments + new one)

### RFI DB — confirmed property names (CRITICAL: exact casing required)

| Property | Type | Notes |
|----------|------|-------|
| `RFI Description` | **title** | This IS the title field — do not use `title` key separately |
| `RFI Status` | select | To Raise / Raised / Response Received / Closed |
| `TBC by` | select | **lowercase 'b'** — will silently fail if cased differently |
| `Date Raised` | date | |
| `Related Item(s)` | relation → Tasks | |
| `Question` | rich_text | **NEW — DM must add** |
| `Drawing` | relation → MDS | **NEW — DM must add** |
| `Snippets` | files & media | **NEW — DM must add** |

When creating an RFI page, use `pages.create` then `blocks.children.append` to add
images as `image` blocks in the page body (in addition to the `Snippets` files property).

---

## 7. What to Port and How to Change It

### `src/hooks/usePDF.js` → port unchanged
Works perfectly as-is. Do not modify.

### `src/components/PDFViewer.jsx` → port, minor changes
- Remove `captureMode` / `captureRect` / capture mouse handler props — not needed
- Keep: zoom, page nav, drag-drop file open, DPR-aware canvas render
- Add: `onCanvasClick(x, y)` prop — called when user clicks canvas in pin-drop mode
  (fractional coordinates 0–1, page number)

### `src/components/PinOverlay.jsx` → port, replace category logic

The existing `PinOverlay` uses 3 statuses (rfi / action / dm) mapped to 3 colours.
**Replace entirely** with 7 categories using the Okabe-Ito palette:

```js
export const CATEGORIES = [
  { id: 'change-await',   label: 'Change — Awaiting Instruction', color: '#D55E00', onHold: true  },
  { id: 'change-instr',   label: 'Change — Instruction Required', color: '#E69F00', onHold: true  },
  { id: 'change-rfi',     label: 'Change — Raise RFI',            color: '#CC79A7', onHold: true  },
  { id: 'dd-coord',       label: 'Design Dev — Coordination',     color: '#0072B2', onHold: false },
  { id: 'dd-update',      label: 'Design Dev — Update',           color: '#009E73', onHold: false },
  { id: 'di-update',      label: 'Design Intent — Update',        color: '#56B4E9', onHold: false },
  { id: 'other',          label: 'Other',                         color: '#888888', onHold: false },
];
```

Pin data shape:
```js
{
  id: 'uuid',
  number: 4,             // sequential, recompacts on delete
  categoryId: 'change-rfi',
  note: '',              // free text; required for 'other' category
  x: 0.312,             // fraction of canvas width
  y: 0.487,             // fraction of canvas height
  page: 2,
  rfiNotionPageId: null, // set after RFI saved
}
```

Pin visual: circle with white number. Initial size ~24px — build with a CSS variable
`--pin-size: 24px` so it can be adjusted via a size control without code changes.
Include a size slider (S/M/L: 18/24/32px) in the `CategoryToolbar`.

### `src/utils/exportPDF.js` → port, update colours + add legend stamp

Replace the 3-colour `pinColor()` function with a lookup from `CATEGORIES`:
```js
import { CATEGORIES } from '../components/PinOverlay.jsx';
function pinColor(categoryId) {
  const cat = CATEGORIES.find((c) => c.id === categoryId);
  if (!cat) return rgb(0.5, 0.5, 0.5);
  const hex = cat.color.replace('#', '');
  return rgb(parseInt(hex.slice(0,2),16)/255, parseInt(hex.slice(2,4),16)/255, parseInt(hex.slice(4,6),16)/255);
}
```

Change export filename suffix from `_reviewed.pdf` to `_R.pdf`.

Also add a **legend stamp** drawn onto the page. The legend should:
- List each category that has ≥1 pin: colour swatch (small filled circle) + label + count
- Show reviewer name, date (DD/MM/YYYY), drawing number, rev
- Position: bottom-right corner by default, but respect a `legendPosition: {x, y}` prop
  if the user has dragged the stamp (store as fraction of page dimensions)
- Use a light background box (white fill, 0.9 opacity) so it's readable over dark drawings
- Font: HelveticaBold from pdf-lib StandardFonts; minimum 7pt for legend text

### `server/routes/notion.js` → port, extend

Port the `/api/notion/rfi-options` and `/api/notion/rfi` endpoints.
Update `/api/notion/rfi` to include the new `Question`, `Drawing`, and `Snippets` fields.
Add snippet upload: for each image in `snippets[]` (base64), call `notion.pages.update`
to append an `image` block, and add to `Snippets` files property.

Add new endpoints:
- `GET /api/notion/submission/:id` — returns Submission data + related MDS drawing data
- `GET /api/notion/queue?projectId=` — Issued Submissions with S4/S5/A4.5 Comment Files set
- `PATCH /api/notion/submission/:id/save` — grade + on-hold write-back
- `GET /api/projects` — projects list (same as axiom-drawing-flow)

---

## 8. Backend Routes (server/routes/comment-review.js)

Build these in order:

### POST /api/cr/ingest
Called by Make.com when a new PDF appears in a `Client Comments/` folder.

```
Body: { filePath, dropboxPath, dropboxLink, filename }
```

Parse filename: `{ClientAcronym}_{YYMMDD}_{DrawingNo}_{Rev}.pdf`
- `clientAcronym` = first segment (e.g. `MC`)
- `receivedDate` = `YYMMDD` → `20{YY}-{MM}-{DD}` (ISO date)
- `drawingNo` = third segment (e.g. `A-SK-101`)
- `rev` = fourth segment (e.g. `P01`)

Parse path for `stage` (folder name containing the file — `S4`, `S5`, `A4.5`).

Then:
1. Find MDS drawing: `databases.query` on DRAWINGS DB where title contains `drawingNo`
2. If found: append to `S{stage} Comment Files` rich_text + add to `S{stage} Client Reviewers` multi-select
3. Find Submission: query SUBMISSIONS DB where `Status = Issued`, `Stage = stage`,
   `Revision = rev`, relation `Drawing` matches the MDS page found above
4. If Submission not found: log warning (file may be premature or wrongly named)
5. Return `{ ok, drawingId, submissionId }`

### GET /api/cr/queue?projectId=

Returns all Issued Submissions for the project where the MDS drawing has a non-empty
`S4 Comment Files` (or S5/A4.5) property AND `Status != Graded`.

Response shape per item:
```json
{
  "id": "submission-notion-page-id",
  "title": "24-367-003_A-SK-101_S4_R1",
  "drawingNo": "A-SK-101",
  "stage": "S4",
  "revision": "P01",
  "dtName": "Greig M",
  "clientAcronyms": ["MC"],
  "commentFilesText": "MC_260625_A-SK-101_P01.pdf",
  "commentLinks": [{ "label": "MC_260625_...", "url": "https://dropbox..." }],
  "issuedDropboxLink": "https://...",
  "receivedDate": "2026-06-25",
  "blocked": false
}
```

### PATCH /api/cr/submission/:id/save

```
Body: { grade, gradeDate, onHold, holdNotes, pins }
```

Writes to Submission record:
- `Client Grade` → grade
- `Reviewed` → gradeDate
- `Status` → Graded
- `Blocked` → onHold (boolean)
- `Ball In Court` → onHold ? 'DM' : 'DT'

Writes to MDS drawing (found via Submission's `Drawing` relation):
- Stage-appropriate status + date (S4 Status + S4 Status Date, etc.)
- `Drawing Status` → `On Hold` / `Being Revised` / `Production Updates` / `Complete`
  (see full logic in spec section 9.5)
- `Hold Notes` → holdNotes string (empty string clears it) — only if onHold

### POST /api/cr/rfi-description

```
Body: { question }
Returns: { description }
```

Uses Anthropic SDK (Claude Haiku) to generate a concise, professional RFI description
from the DM's raw question notes. Keep the prompt tight:

```
"You are a construction project RFI writer. Convert the following site/design query into
a concise, professional RFI description suitable for a formal RFI document. One paragraph,
no more than 60 words. Do not add preamble. Input: {question}"
```

### POST /api/cr/rfi

Creates RFI in Notion. Body:
```json
{
  "submissionId": "...",
  "drawingId": "...",
  "taskId": "...",
  "tbcBy": "DM",
  "question": "Raw DM notes...",
  "description": "AI-generated text...",
  "snippets": [{ "name": "clip1.png", "base64": "...", "mimeType": "image/png" }]
}
```

1. `pages.create` in RFI DB with all text properties
2. `blocks.children.append` on new page: one `image` block per snippet (external URL or
   uploaded file — see note below)
3. Return `{ ok, rfiPageId }`

**Snippet note:** Notion's `image` block can use an `external` URL type. If snippets are
base64, either:
(a) Upload to a temp URL (complex), or
(b) Save to a temp file in `/tmp`, serve it from Express briefly, pass the URL to Notion
    (but this won't survive serverless)
(c) **Simplest for now:** Store snippets as base64 data URIs in the `Snippets` property
    description field (not ideal), and revisit if Notion adds direct upload support.

Actually best approach: just attach to `Snippets` files & media property via the API.
Notion's files property accepts `{ type: "external", external: { url: "..." } }` —
so the Dropbox upload path (Make.com webhook) is required before the RFI can embed images.
For the MVP, store snippet references in `Question` as `[image attached]` and implement
the full embed after the export upload route is working.

### POST /api/cr/notify-dt

Fires Make.com webhook with DT email payload:
```json
{
  "action": "cr-dt-notify",
  "dtEmail": "...",
  "dtName": "...",
  "drawingNo": "...",
  "stage": "S4",
  "revision": "P01",
  "project": "...",
  "grade": "B",
  "gradeDate": "2026-06-25",
  "onHold": false,
  "issuedDropboxLink": "https://...",
  "reviewedCommentLink": "https://...",
  "revisionDueDate": "2026-07-04"
}
```

### POST /api/cr/export-upload

Fires Make.com webhook to upload the reviewed PDF to Dropbox:
```json
{
  "action": "cr-upload",
  "dropboxFolder": "/DESIGN KNOW HOW/TMJ Interiors/24-367/S4/Client Comments/",
  "filename": "MC_260625_A-SK-101_P01_R.pdf",
  "fileBase64": "..."
}
```

---

## 9. Frontend: Key Components to Build

### App.jsx — three-panel layout

```
┌─────────────┬──────────────────────────┬──────────────────┐
│ FileQueue   │     PDF Viewer           │   RightPanel     │
│ (280px)     │                          │   (320px)        │
│             │  + CategoryToolbar       │                  │
│             │  + PinOverlay            │                  │
│             │  + LegendStamp           │                  │
└─────────────┴──────────────────────────┴──────────────────┘
```

State lives in App.jsx:
- `pins[]` — all pins for current session
- `activeCategory` — currently selected category id
- `selectedPinId`
- `submission` — loaded submission + drawing metadata
- `showRFIModal` / `rfiTargetPin`
- `legendPosition` — `{ x, y }` as page fractions, null = auto
- `onHold` — derived: `pins.some(p => CATEGORIES.find(c=>c.id===p.categoryId)?.onHold)`

### FileQueue.jsx

- Fetches from `GET /api/cr/queue?projectId=`
- Each item: client acronym badge, drawing number, stage, rev, received date, status
  (Pending / Reviewed), Blocked indicator (⚠)
- Click to load — fetches full submission via `GET /api/notion/submission/:id`
  then opens the comment PDF from the Dropbox link in the viewer

### CategoryToolbar.jsx

Floating toolbar (position: fixed, bottom-right of viewer area):
- 7 coloured chips, one per category
- Active category highlighted with white ring
- Size slider: S / M / L (maps to 18 / 24 / 32px `--pin-size`)
- Keyboard shortcut `P` activates pin-drop mode with current category

### RightPanel.jsx

Fields (all read-only, auto-populated):
- Project, Item No., Drawing No., Stage, Rev, DT name
- Client(s) who have commented (from `clientAcronyms`)
- Received date

Grading section:
- Grade select (options depend on stage: A/B/C/NA for S4/S5, Approved/Rejected for A4.5)
- Grade date (pre-filled today, editable)

Status section:
- If `onHold`: ⚠ **ON HOLD** banner (red)
- Count of hold-category pins

Buttons:
- **Save & Close** → `PATCH /api/cr/submission/:id/save` → marks item reviewed in queue
- **Export PDF** → runs `exportToPDF`, then `POST /api/cr/export-upload`
- **Send DT Email** → `POST /api/cr/notify-dt` (only enabled after Save & Close)

### RFIModal.jsx (port from DrawingCommentReviewer/src/components/RFIForm.jsx)

Changes from the original:
- Remove project/item selectors (already known from active submission)
- Remove RFI number field (assigned manually in Notion later)
- Add `Question` textarea (raw DM notes)
- Keep `TBC by` select (fetch options from `/api/notion/rfi-options`)
- Keep AI description field — triggers `POST /api/cr/rfi-description` on Question blur/button
- Keep snippet paste (`Ctrl+V` pastes clipboard image) and file attach
- On Save: `POST /api/cr/rfi`

### LegendStamp.jsx

Positioned absolutely over the PDF viewer (not inside the canvas — DOM overlay like pins).
- Draggable (mousedown → track delta → update position state)
- Auto-placed bottom-right at first render
- Contents: title "Comment Key", coloured row per category with ≥1 pin, reviewer + date + drawing

Position is passed to `exportToPDF` as `legendPosition: { x, y }` (fractions) so the
export renders the stamp in the same location.

---

## 10. Make.com Configuration (Step 16)

Two things to add to the existing Actions Hub scenario in Make.com:

**New branch: `action = cr-dt-notify`**
- Extract payload fields
- Send email via Gmail module with the fields formatted into the email template (see spec 10.1)
- Use same Gmail credential as existing grade-summary emails

**New branch: `action = cr-upload`**
- Take `fileBase64` + `filename` + `dropboxFolder` from payload
- Decode base64
- Upload to Dropbox using the Dropbox module: `Upload a File` to `dropboxFolder/filename`

**New separate scenario: Client Comment Ingest**
- Trigger: Dropbox → Watch Files in Folder
- Folder: `/DESIGN KNOW HOW/TMJ Interiors/` — watch subfolders
- Filter: path contains `/Client Comments/` AND filename ends with `.pdf`
  AND filename does NOT end with `_R.pdf`
- Action: HTTP → POST `https://your-app.netlify.app/api/cr/ingest`
  Body: `{ filePath, dropboxPath, dropboxLink: {{shareable link}}, filename }`

---

## 11. Build Sequence (strict order)

```
Step 1   DM: Add 7 MDS properties + 3 RFI DB properties in Notion (section 6)
         DM: Create Client Comments/ subfolder in S4/S5/A4.5 for all active projects

Step 2   Scaffold project
         package.json, vite.config.js, index.html, server/index.js
         Copy clients.json, .env.example
         Confirm dev server runs: vite on 5173, express on 3001

Step 3   Backend: ingest route
         Parse filename + path, find MDS drawing, append comment file link
         Test: manually POST to /api/cr/ingest with a real filename

Step 4   Backend: queue route
         Return Issued Submissions with comment files set
         Test: confirm data shape matches what FileQueue needs

Step 5   Frontend: FileQueue + RightPanel
         File list renders, click loads submission metadata into right panel
         No PDF viewer yet — just verify data flow

Step 6   Frontend: PDF viewer
         Port PDFViewer.jsx
         Drag-drop PDF opens and renders
         Zoom (ctrl+scroll), page navigation

Step 7   Frontend: pin system
         CategoryToolbar (7 categories)
         Click canvas → drop pin at position
         PinOverlay renders, pins are draggable
         Sequential numbering with recompaction on delete
         On-hold banner in RightPanel when hold-category pin dropped

Step 8   Frontend: legend stamp
         LegendStamp renders over PDF
         Draggable, updates position state

Step 9   Backend + Frontend: save review
         "Save & Close" writes to Notion
         Verify Submission + MDS updates in Notion

Step 10  Frontend: mark-up tools
         Arrow, rectangle, freehand, text overlays (SVG layer)
         Undo/redo (simple stack)

Step 11  Frontend + Backend: PDF export
         Flatten pins + legend to PDF using pdf-lib
         _R.pdf filename suffix
         POST /api/cr/export-upload → Make.com upload

Step 12  Frontend + Backend: RFI modal
         Cat 3 pin triggers modal
         AI description generation
         Snippet paste
         POST /api/cr/rfi creates Notion record

Step 13  Backend + Frontend: DT email
         "Send DT Email" fires /api/cr/notify-dt
         Make.com delivers via Gmail

Step 14  Make.com: configure ingest scenario + Actions Hub branches

Step 15  Integration test: drop file → queue → review → grade → export → email

Step 16  Retire cockpit "Log Status" for S4/S5 once Comment Reviewer is stable
         Also extend /api/df/submissions/:id/hold in axiom-drawing-flow to clear
         Hold Notes + update Drawing Status + BIC on unblock
```

---

## 12. Critical Decisions — Do Not Re-litigate

| Decision | Rationale |
|----------|-----------|
| Vite + React, not no-build Babel | PDF complexity requires bundler; pattern from DrawingCommentReviewer |
| No new Submission records on ingest | Updates existing Issued record; no duplication |
| Comment file links as rich_text (not URL prop) | Supports multiple files per stage per drawing |
| Hold written on Save, not on pin drop | Single atomic Notion write; no mid-review API calls |
| No RFI number assigned in app | Assigned manually in Notion after project system cross-check |
| Pins as fractional DOM overlays (not canvas) | Click-to-edit, scales with zoom, exportable |
| Snippet images in page body + Snippets property | Both inline (readable) and attached (downloadable) |
| `_R.pdf` export suffix | Make.com ingest filter excludes it; prevents re-ingest loop |
| Anthropic: Claude Haiku for RFI descriptions | Cost-efficient; same API key as DrawingCommentReviewer |
| Design Change / Variation workflow | Out of scope — future build |

---

## 13. Full Spec Reference

All detailed context, UI wireframes, colour palette spec, Notion schema details, email
template, and open questions are in:

```
C:\Users\greig\Documents\ClaudeProjects\axiom-drawing-flow\docs\CLIENT-COMMENT-REVIEWER-SPEC.md
```

If something is ambiguous in this handoff, the spec is the source of truth.

---

## 14. Pre-Build Checklist (DM must complete before Step 2)

- [ ] Add `S4/S5/A4.5 Comment Files` (rich_text) to MDS in Notion
- [ ] Add `S4/S5/A4.5 Client Reviewers` (multi-select, options: MC/ARCH/PM/ENG/ID) to MDS
- [ ] Add `Hold Notes` (rich_text) to MDS
- [ ] Add `Question` (rich_text) to RFI DB
- [ ] Add `Drawing` (relation → MDS) to RFI DB
- [ ] Add `Snippets` (files & media) to RFI DB
- [ ] Verify `TBC by` exists in RFI DB (exact casing — lowercase b)
- [ ] Verify `RFI Description` is the title property in RFI DB
- [ ] Create `Client Comments/` subfolders in Dropbox for all active projects / stages
- [ ] Confirm Anthropic API key from DrawingCommentReviewer is available
- [ ] Confirm Make.com webhook URL (same as axiom-drawing-flow `MAKE_ACTIONS_WEBHOOK`)
