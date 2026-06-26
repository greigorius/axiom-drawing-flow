# Client Comment Reviewer — Full Specification

**Project:** `axiom-client-comment-reviewer` (new separate app)
**Author:** Greig Fensome / Axiom DL
**Version:** 1.2 — 2026-06-25
**Status:** Spec — revised after workflow review

---

## 1. Overview and Workflow

### Where this sits in the process

The client comment review phase begins only after a drawing has been **issued** — that is,
the DT submission has passed DM QA and been approved and sent to the client. At that point
the drawing enters `Status = Client Review` in the MDS. The DT submission QA round is
complete and irrelevant from this point on.

Clients (one or both of the following) review the issued drawing and return comments:

| Client | Stage | Role |
|--------|-------|------|
| Main Contractor (MC) | S4 | Coordination review |
| Architect | S5 | Primary client representative (authorisation) |

A4.5 is a lighter sign-off — handled by the same app.

Comments come back as a marked-up PDF, or occasionally as email notes. **All comments must
be captured in the app** — whether from a PDF mark-up or transcribed from email/other channels.

### The DM's review action

The DM reviews comments manually (AI auto-extraction is not reliable for complex drawings).
They place a numbered pin on each comment, assign it a category, and work through the drawing.

The outcome is one of:
- **On Hold** — one or more Change-category pins exist. DT is notified but must NOT
  update the drawing until the hold is resolved. All items in the same suffix group are
  frozen until the DM clears the hold.
- **Revise** — grade B or C, no hold. DT updates drawing content to the next revision and
  resubmits through the normal DT submission workflow.
- **Title Block Update Only** — grade A. No drawing content changes required, but the DT
  still updates the title block (revision, date, status) and resubmits. Drawing is then
  complete at this stage once issued.

### Email to DT (on "Send DT Email")

The email includes:
- Link to the issued drawing (Dropbox)
- Link to the reviewed/annotated comment PDF (Dropbox, once exported)
- Grade and date
- On-hold summary if applicable (items frozen, reason)
- Pin summary grouped by category
- Revision due date (if revise action)

### Relationship to existing Submission records

The comment review does **not** create new Submission records. It updates the **existing**
Submission record that was created when the drawing was issued (`Status = Issued`).

The ingest route finds the existing record by matching drawingNo + stage + rev from the
comment filename. The comment PDF link and grade are then written back to that same record.

### Previous app

`C:\Users\greig\Documents\ClaudeProjects\DrawingCommentReviewer` was a previous attempt
(Vite + React, pdfjs-dist, pin overlay system, RFI form, Notion routes). The PDF rendering
and pin overlay approach are sound and should be ported. The AI auto-extraction route
(`/extract-comments`) is abandoned — manual pin placement replaces it entirely.

---

## 2. Tech Stack

**Differs from axiom-drawing-flow** — this app uses Vite + React (matching the existing
DrawingCommentReviewer), not the no-build Babel pattern. The PDF rendering, drag-drop pins,
and markup tools require proper module bundling and the HMR dev loop Vite provides.
The no-build Babel pattern is fine for queue/form UIs but too limiting here.

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite (`@vitejs/plugin-react`) |
| Backend | Express.js (Node 18+) — separate `server/` directory |
| Notion client | `@notionhq/client` SDK |
| PDF render | `pdfjs-dist` (ported from DrawingCommentReviewer) |
| PDF export | `pdf-lib` (ported from DrawingCommentReviewer) |
| Deployment | Netlify (static site + serverless functions) |
| Styling | Plain CSS — dark theme, matching DM Tracker Hub aesthetic |
| Dev runner | `concurrently` — Vite client + Express server |

**Key packages** (from existing DrawingCommentReviewer `package.json`, all confirmed working):
```
pdfjs-dist, pdf-lib, @notionhq/client, @anthropic-ai/sdk, express, multer, cors, dotenv, fflate
```

Project folder: `C:\Users\greig\Documents\ClaudeProjects\axiom-client-comment-reviewer\`

---

## 3. Dropbox Folder Structure

Client comment files are received and stored **inside** each Stage folder. This keeps
all S4 files together (issued drawings alongside comments received back).

```
/DESIGN KNOW HOW/TMJ Interiors/
  └── {ProjectNo}/                    e.g. 24-367
        ├── S4/
        │     ├── Pending/            ← DT uploads (unchanged — Make.com watches this)
        │     ├── Rejected/
        │     │     └── R{N}/
        │     ├── Suffix {itemNo}/    ← Approved issued files
        │     └── Client Comments/   ← NEW: DM places received client mark-ups here
        ├── S5/
        │     └── Client Comments/
        └── A4.5/
              └── Client Comments/
```

**File naming convention for received client comments:**

```
{ClientAcronym}_{YYMMDD}_{DrawingNo}_{Rev}.pdf
```

| Segment | Example | Notes |
|---------|---------|-------|
| ClientAcronym | `MC`, `ARCH`, `PM` | Short codes — see client register below |
| YYMMDD | `260625` | Date received from client |
| DrawingNo | `A-SK-101` | Full drawing number without project prefix |
| Rev | `P01` | Revision of the drawing being commented on |

**Examples:**
- `MC_260625_A-SK-101_P01.pdf` — Main Contractor comment on drawing A-SK-101 Rev P01
- `ARCH_260701_A-D-205_C01.pdf` — Architect comment on A-D-205 Rev C01

**Multiple comment sets per stage:**
More than one client may comment on the same drawing at the same stage (e.g. both MC and
Architect at S4). Each file lands in the same `Client Comments/` folder with its own
`ClientAcronym` prefix. The app queues each as a separate review session.

In Notion, comment file links accumulate on the MDS row as rich_text (one hyperlinked
line appended per ingest — see section 9.2). The `S4 Client Reviewers` multi-select
property records which clients have commented, without overwriting previous entries.

**Client acronym register** (maintained in `clients.json` — add new clients without code changes):

| Acronym | Full name |
|---------|-----------|
| MC | Main Contractor |
| ARCH | Architect |
| PM | Project Manager |
| ENG | Engineer |
| ID | Interior Designer |

The `ClientAcronym` from the filename is written to Notion on ingest (see section 9.2).

---

## 4. Comment Pin System

### 4.1 Categories

Pins are placed manually by the DM (or reviewer). Each pin is numbered sequentially
per drawing session (1, 2, 3…) and assigned a category. The category determines
colour and drives Notion actions.

| # | Category | Sub-type | Action Owner | On-Hold Trigger |
|---|----------|----------|-------------|-----------------|
| — | Change | Awaiting Instruction | DM | **YES** |
| — | Change | Instruction Required | DM | **YES** |
| — | Change | Raise RFI | DM | **YES** |
| — | Design Development | Coordination Required | DT / DM | No |
| — | Design Development | Update | DT | No |
| — | Design Intent | Update | DT | No |
| — | Other | *(custom text field)* | DT / DM | No |

Pins in category rows 1–3 (Change sub-types) set the drawing to **On Hold** as soon as
the first one is placed.

### 4.2 Colour Coding (Accessibility-first)

Uses the Okabe-Ito palette — designed for deuteranopia/protanopia (most common forms of
colour blindness). All colours achieve ≥ 4.5:1 contrast against white on a white
background and remain distinguishable in greyscale.

| Category | Colour | Hex | Accessibility note |
|----------|--------|-----|--------------------|
| Change — Awaiting Instruction | Vermillion | `#D55E00` | Red-orange; safe for red-green CB |
| Change — Instruction Required | Amber | `#E69F00` | Yellow-orange |
| Change — Raise RFI | Pink/Mauve | `#CC79A7` | Distinguishable from all others |
| Design Dev — Coordination Required | Blue | `#0072B2` | Deep blue |
| Design Dev — Update | Teal | `#009E73` | Green-safe; distinguishable from blue |
| Design Intent — Update | Sky Blue | `#56B4E9` | Light blue; different lightness to Blue |
| Other | Grey | `#888888` | Neutral |

**Pin visual spec (initial — to be reviewed once rendered):**
- Circle shape, ~24px diameter on screen as a starting point
- Number inside the circle (white text, bold)
- Thin white border (1.5px) for visibility on dark drawing backgrounds
- Drop shadow for legibility on complex drawing content
- On hover: tooltip shows the category label + any custom text (for "Other" pins)
- On click: opens the pin detail drawer (edit category, add note)
- **Pin size is TBD** — start at 24px, review against real drawings after first render.
  The pin toolbar should include a size slider (small/medium/large) for per-session adjustment.

### 4.3 Pin Numbering

Pins are numbered **sequentially** starting at 1, in order of placement. Numbers do NOT
reset when category changes. If a pin is deleted, numbers recompact (like the DT Drawing
Checker).

Each pin stores:
```json
{
  "id": "pin-uuid",
  "number": 4,
  "category": "change-rfi",
  "customText": "",
  "note": "Column centreline conflicts with proposed joinery unit",
  "x": 0.312,
  "y": 0.487,
  "page": 2
}
```

`x` and `y` are stored as fractions of the rendered page width/height (0–1) so they
scale correctly when zoomed or exported.

---

## 5. Legend / Key Stamp

A placeable "stamp" element — the DM can drag it anywhere on the page (or the app
auto-places it in a corner with a nudge option).

**Legend stamp contents:**
- Title: **Comment Key**
- One row per category that has at least one pin — colour swatch + category label + count
- Separator line
- **Reviewer:** `{name}` (auto-filled from right panel, editable inline)
- **Date:** `{DD/MM/YYYY}` (auto-filled to today, editable)
- **Drawing:** `{drawingNo}` (auto-filled)
- **Rev:** `{rev}`

The stamp is rendered as an overlay div positioned absolutely over the PDF canvas —
it exports as part of the PDF output.

**Multiple pages:** if comments span multiple pages, one stamp appears on each page that
has pins (or optionally a master stamp on page 1 only — DM choice in settings).

---

## 6. Mark-up Tools

Full suite matching DTDrawingChecker:

| Tool | Shortcut |
|------|----------|
| Pin drop (current category) | `P` |
| Arrow annotation | `A` |
| Rectangle / cloud highlight | `R` |
| Freehand draw | `F` |
| Text label | `T` |
| Dimension line | `D` |
| Erase mark-up | `E` |
| Select / move | `V` or `Esc` |
| Zoom in / out | `Ctrl + scroll wheel` or `+` / `-` |
| Fit to window | `0` |
| Pan | `Space + drag` |
| Undo | `Ctrl+Z` |
| Redo | `Ctrl+Shift+Z` |

Category selector is a floating toolbar showing all 7 categories as coloured chips.
Clicking a chip sets the active category for the next pin drop.

---

## 7. Application Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Logo]  Client Comment Reviewer         [Project: 24-367 — TMJ Shoreditch]  │
├──────────────┬─────────────────────────────────────┬───────────────────────  ┤
│  LEFT PANEL  │         PDF VIEWER                  │    RIGHT PANEL          │
│  (280px)     │                                     │    (320px)              │
│              │   ┌──────────────────────────┐      │                         │
│  ◉ Queue     │   │                          │      │  Project: 24-367        │
│              │   │  [Rendered PDF page]     │      │  Item: 003              │
│  ─────────── │   │                          │      │  Drawing: A-SK-101      │
│  MC_260625   │   │  ②      ①               │      │  Stage: S4              │
│  A-SK-101    │   │        ④                 │      │  Rev: P01               │
│  P01  [MC]   │   │   ③                     │      │  DT: GM                 │
│  ✓ Reviewed  │   │         ⑤               │      │  Client: MC             │
│              │   │                          │      │  Received: 25/06/2026   │
│  ─────────── │   └──────────────────────────┘      │                         │
│  MC_260625   │                                     │  ─────────────────────  │
│  A-D-205     │   Page 1 of 4   ◁  ▷               │  GRADING                │
│  P01  [MC]   │                                     │  Grade: [A ▼]           │
│  ○ Pending   │   [Markup toolbar: P A R F T D E]   │  Date: [25/06/2026  ]   │
│              │                                     │                         │
│  ─────────── │   Category: ● Chg-Await ● Chg-Instr │  ─────────────────────  │
│  ARCH_260702 │             ● Chg-RFI  ● DD-Coord  │  COMMENTS (6 pins)      │
│  A-D-109     │             ● DD-Upd   ● DI-Upd    │                         │
│  C01  [ARCH] │             ● Other                 │  ① Change — Await.      │
│  ○ Pending   │                                     │  ② DD — Update          │
│              │                                     │  ③ Change — RFI  [RFI▸] │
│              │                                     │  ④ Design Intent        │
│              │                                     │  ⑤ DD — Coord.          │
│              │                                     │  ⑥ Change — Await.      │
│              │                                     │                         │
│              │                                     │  ─────────────────────  │
│              │                                     │  STATUS                 │
│              │                                     │  ⚠ ON HOLD              │
│              │                                     │  (3 hold pins)          │
│              │                                     │                         │
│              │                                     │  [Save & Close]         │
│              │                                     │  [Export PDF]           │
│              │                                     │  [Send DT Email]        │
└──────────────┴─────────────────────────────────────┴─────────────────────────┘
```

### Left Panel — File Queue

- Lists all PDFs found in `Client Comments/` folders across all stage folders for the
  active project
- Sourced from Make.com ingest (see section 11) — same pattern as DT submissions queue
- Each item shows: client acronym badge, drawing number, rev, stage, received date,
  status badge (Pending / In Review / Reviewed)
- Click to load into the viewer
- Files that are "On Hold" show a ⚠ badge
- Reviewed files are greyed / struck through

### Centre — PDF Viewer

- Renders via `pdfjs-dist`, same implementation as DTDrawingChecker
- Pins overlay the canvas as positioned DOM elements (not drawn on canvas — enables
  click-to-edit without re-rendering)
- Mark-up shapes (arrows, rectangles, freehand) drawn on a transparent SVG overlay
- `Ctrl+scroll` zoom updates a scale factor; pins and overlays scale with it
- Page navigation via `◁ ▷` or keyboard arrows
- Legend stamp is a draggable positioned div

### Right Panel — Metadata + Actions

Auto-populated from filename parse + Notion lookup on file load:

| Field | Source |
|-------|--------|
| Project | Parsed from folder path → Projects DB |
| Item No. | Filename → Tasks DB lookup |
| Drawing No. | Filename |
| Stage | Folder name |
| Rev | Filename |
| DT | Filename initials → Team DB lookup |
| Client | Filename acronym → clients register |
| Received Date | Filename YYMMDD → formatted |

**Grading section** (moved from cockpit — grade is logged here during review):

- Grade select: A / B / C / NA (for S4/S5) or Approved / Rejected (for A4.5)
- Date received: pre-filled from filename, editable
- On save: writes to the Submission record in Notion (see section 9)

**Comments list:** scrollable list of all pins in placement order. Each row:
- Pin number + colour swatch + category label
- For RFI pins: a `[RFI ▸]` button opens the RFI popup (section 9.3)
- Click to jump to that pin in the viewer

**Status banner:** if any hold-category pins exist, shows ⚠ ON HOLD with count.

---

## 8. PDF Export

"Export PDF" produces a single-file PDF:
- All pages of the original PDF
- Mark-up shapes and pins rendered flat on each page (not as interactive overlays)
- Legend stamp on each page that has pins (or page 1 only — per DM preference)
- Export filename: `{original filename}_R.pdf`
  e.g. `MC_260625_A-SK-101_P01_R.pdf`
- Exported file is auto-saved to the same `Client Comments/` folder in Dropbox
  (via a Make.com file-upload webhook, same pattern as existing approve/bounce moves)
- All mark-up must be clearly visible / readable in the exported PDF —
  use sufficient font size (min 8pt for pin numbers, 7pt for legend text)

---

## 9. Notion Integration

### 9.1 Data Model Principle

The comment review does **not** create new Notion records — it updates existing ones.
The anchor is the **Submission record** that was created when the drawing was issued
(`Status = Issued`). All comment data is written back to this record and to the MDS row.

This keeps the DBs lean. A "Comment Status" property is not needed — the Submission `Status`
field (Issued → Graded) and `Blocked` checkbox carry all necessary state.

### 9.2 New / Updated Notion Properties Required

#### Submissions DB — existing properties used (no new properties needed)

The Submission record serves as the event-log anchor. All comment review outcomes are
written back here alongside the MDS direct writes. Keeping `Client Grade` on Submissions
preserves per-revision history (e.g. P01 graded C, P02 graded A at S4) that would be
lost on MDS which only shows the latest grade.

| Property | Already exists | Usage during comment review |
|----------|---------------|----------------------------|
| `Client Grade` | ✓ | Written when DM grades (A/B/C/NA or Approved/Rejected) |
| `Reviewed` date | ✓ | Set to today when DM saves review |
| `Blocked` checkbox | ✓ | Checked if any hold-category pins present |
| `Ball In Court` | ✓ | Set to DM (if blocked) or DT (if not) |
| `Status` | ✓ | Updated from Issued → Graded on save |

#### MDS (Master Drawing Schedule) — new properties

URL properties can only hold a single link. Because multiple clients may comment on the
same drawing at the same stage, comment file links are stored as **rich_text** (one
hyperlinked line per file, appended on each ingest — never overwritten). A multi-select
tracks which clients have commented.

| Property | Type | Notes |
|----------|------|-------|
| `S4 Comment Files` | rich_text | Appended hyperlinks: one line per file e.g. `MC_260625_A-SK-101_P01.pdf` |
| `S5 Comment Files` | rich_text | Same pattern for S5 |
| `A4.5 Comment Files` | rich_text | Same pattern for A4.5 |
| `S4 Client Reviewers` | multi-select | Options from `clients.json`; new acronym appended on each ingest |
| `S5 Client Reviewers` | multi-select | Same for S5 |
| `A4.5 Client Reviewers` | multi-select | Same for A4.5 |
| `Hold Notes` | rich_text | Written on save when Blocked = true. Format: `#3 Change–RFI: [note] · #6 Change–Await: [note]`. Cleared when Blocked is unchecked. Visible in MDS table view without opening record. |

**Ingest append pattern** for `S4 Comment Files`:
- Read existing value of the rich_text property
- Append a new line: `{ClientAcronym}_{YYMMDD}_{DrawingNo}_{Rev}.pdf` linked to the Dropbox URL
- Write back the full updated text (Notion rich_text supports inline hyperlinks via API)

Existing MDS properties written during grading (unchanged from cockpit log-status flow):

| Property | Stage | Notes |
|----------|-------|-------|
| `S4 Status` | S4 | A / B / C / NA |
| `S4 Status Date` | S4 | Grade received date |
| `S5 Status` | S5 | A / B / C / NA |
| `S5 Status Date` | S5 | Grade received date |
| `C01 Sign Off` | A4.5 | Date (if Approved) |
| `Drawing Status` | All | On Hold / Being Revised / Production Updates / Complete |

#### RFI DB — confirmed property names (from existing DrawingCommentReviewer routes)

The Submission relation is not added here — the drawing has been issued and the Submission
record has effectively been superseded as the primary reference. The MDS Drawing relation
is sufficient to trace back to all stage history.

| Property | Type | Status | Notes |
|----------|------|--------|-------|
| `RFI Description` | title | ✓ exists | The RFI title — AI-generated, editable |
| `RFI Status` | select | ✓ exists | Options: To Raise / Raised / Response Received / Closed |
| `TBC by` | select | ✓ exists | **exact casing: lowercase 'b'** — critical for API calls |
| `Date Raised` | date | ✓ exists | |
| `Related Item(s)` | relation → Tasks | ✓ exists | |
| `Question` | rich_text | **ADD** | Raw DM question text (separate from AI-generated description) |
| `Drawing` | relation → MDS | **ADD** | Link to the MDS drawing page |
| `Snippets` | files & media | **ADD** | File attachments (for links) |

**Snippet embedding:** Images pasted into the RFI popup are stored two ways:
1. As Notion page **body blocks** (`image` type via the blocks API) — inline, visible when
   the RFI page is opened in Notion
2. As file attachments on the `Snippets` files & media property — for bulk access/download

Both are written in a single API call sequence: `pages.create` first, then
`blocks.children.append` to add image blocks to the new page body.

### 9.3 On-Hold Logic

Triggered in the UI as soon as the first Category 1, 2, or 3 (Change) pin is placed
(banner shown immediately). Written to Notion on "Save & Close":

1. **Submission record:** `Blocked` checkbox → `true`
2. **Submission record:** `Ball In Court` → `DM`
3. **MDS record:** `Drawing Status` → `On Hold`
4. **MDS record:** `Hold Notes` → structured summary of all hold pins

If **no** hold pins: `Blocked` → `false`, `Ball In Court` → `DT`, `Hold Notes` → cleared.

**Cockpit reversal:** The cockpit already reads `Blocked` from Notion and reflects it
visually. The existing `/api/df/submissions/:id/hold` endpoint (PATCH, `{ blocked: false }`)
reverses the on-hold state. The cockpit "Unblock" button fires this and should also:
- Set `Ball In Court` → `DT`
- Set `Drawing Status` → `Being Revised` (or the appropriate next status)
- Clear `Hold Notes`

This means the cockpit is where the DM formally clears a hold once the instruction/RFI/
change is resolved — without needing to touch Notion directly.

### 9.4 RFI Popup

Triggered when a Category 3 (Raise RFI) pin is placed, or clicking `[RFI ▸]` in the
comments list for an existing Cat 3 pin.

**No RFI number is assigned here** — the number is assigned manually in Notion after
cross-referencing with the project system. The app just creates the Notion record.

```
┌──────────────────────────────────────────────────────┐
│  New RFI — Drawing A-SK-101                          │
│                                                      │
│  TBC by:  [ DM ▼ ]                                  │
│                                                      │
│  Question (your notes):                              │
│  ┌──────────────────────────────────────────────┐   │
│  │  Column centreline at gridline E conflicts    │   │
│  │  with joinery unit 003-JU-04...              │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  RFI Description (AI draft — click to edit):         │
│  ┌──────────────────────────────────────────────┐   │
│  │  [Generating…]                               │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  Snippets:                                           │
│  [ Paste image ]  [ Attach file(s) ]                │
│  ┌─────┐                                            │
│  │ img │  × clip1.png                               │
│  └─────┘                                            │
│                                                      │
│  [ Cancel ]                          [ Save RFI ]   │
└──────────────────────────────────────────────────────┘
```

**On Save RFI:**
- Creates RFI page in `NOTION_DB_RFIS` (`22d210e4582e80189f63f2cee93be4b3`)
- `RFI Description` (title) → AI-generated text (editable)
- `Question` → raw DM notes
- `TBC by` → selected option
- `Date Raised` → today
- `Related Item(s)` → Task relation (from active drawing's Item)
- `Drawing` → MDS relation
- `RFI Status` = `To Raise`
- **Snippets:** each image is:
  1. Added to `Snippets` files & media property (for links/download)
  2. Appended as an inline `image` block to the RFI page body (visible on open in Notion)
- Pin in session updated to show `[RFI ✓]` badge; Notion page ID stored on pin

**AI description generation:**
- `POST /api/cr/rfi-description` — backend calls Claude Haiku
- Returns a concise, professional description from the raw question text
- Populates the description field; user can edit before saving

### 9.5 Grading Write-back

On "Save & Close" with a grade selected:

**Submission record** (existing `Status = Issued` record):
- `Client Grade` → grade (A/B/C/NA or Approved/Rejected)
- `Reviewed` → today's date
- `Status` → `Graded`
- `Blocked` → true/false (per 9.3)
- `Ball In Court` → DM or DT (per 9.3)

**MDS record:**
- `S4 Status` + `S4 Status Date` (S4), `S5 Status` + `S5 Status Date` (S5),
  `C01 Sign Off` (A4.5 if Approved) — same logic as existing `log-status` route
- `Drawing Status`:
  - Hold pins present → `On Hold`
  - Grade B/C or Rejected, no hold → `Being Revised`
  - Grade A or A4.5 Approved → `Production Updates` (A4.5) or `Complete` (S5 grade A)
  - S4 grade A → remains as next stage will follow (DM to determine)

---

## 10. Email Integration

### 10.1 DT Notification Email ("Send DT Email" button)

This replaces the current graded email sent from the cockpit. Triggered once the DM has
saved the review and is ready to instruct the DT.

**Email contents (to DT):**

```
Subject: Drawing Review Complete — {DrawingNo} {Stage} {Rev} — {Project}

Hi {DT Name},

Client comments on {DrawingNo} (Rev {Rev}, {Stage}) have been reviewed.

Grade: {grade}
Reviewed: {date}

Issued drawing:  {Dropbox link to issued drawing}
Reviewed comments: {Dropbox link to _R.pdf in Client Comments folder}

[if On Hold]
⚠ This drawing is currently ON HOLD. Do not update until the DM has
cleared the hold and confirmed the action required.

[if grade B or C, not on hold]
Action: Please update to the next revision and resubmit for {Stage}.
Revision due by: {today + revisionDays working days}

[if grade A]
Action: Title block update only — update revision, date and status,
then resubmit for {Stage}.

Please refer to the reviewed comments PDF linked above for reference.

Regards
Greig Fensome
```

**On send:**
- Fires `MAKE_ACTIONS_WEBHOOK` with `action = cr-dt-notify`
- Payload: grade, drawingNo, stage, rev, DT email, on-hold flag, issued drawing link,
  reviewed comment PDF link, revision due date
- Make.com sends via Gmail (same credential as existing hub)

### 10.2 Cockpit Integration

The cockpit's existing "Log Status" action (A/B/C grade) for `Status = Issued` submissions:
- Is **retired** once the Comment Reviewer is fully deployed
- Replaced by the grading flow in the Comment Reviewer
- Until then, both paths coexist — cockpit grade takes priority if set before Comment
  Reviewer grade

---

## 11. Make.com (Automation) Scenarios

### Scenario: Client Comment Ingest

**Trigger:** Make.com watches `Client Comments/` subfolders in all Stage folders.

```
Watch folder: /DESIGN KNOW HOW/TMJ Interiors/*/S*/Client Comments/
Filter: filename ends with .pdf AND does NOT end with _R.pdf
```

**Action:** HTTP webhook POST → `POST /api/cr/ingest`

**Payload:**
```json
{
  "filePath": "{{file path}}",
  "dropboxPath": "{{file path}}",
  "dropboxLink": "{{file shared link}}",
  "filename": "{{filename}}"
}
```

The backend parses filename and folder path to:
1. Identify project, stage, client, drawingNo, rev, received date
2. Find or create the Submission record in Notion
3. Update `Comment File Path`, `Comment File Link`, `Comment Status = Pending`
4. Enqueue the file in the Comment Reviewer left panel

### Scenario: Export Upload

When "Export PDF" is clicked, the reviewed PDF is returned from the frontend and the
backend fires:

**Action:** Make.com `MAKE_ACTIONS_WEBHOOK` with `action = cr-upload`

**Payload:**
```json
{
  "action": "cr-upload",
  "dropboxFolder": "/DESIGN KNOW HOW/.../Client Comments/",
  "filename": "MC_260625_A-SK-101_P01_REVIEWED.pdf",
  "fileBase64": "..."
}
```

Make.com uploads the file to the specified Dropbox folder.

---

## 12. Backend API Routes

New module: `server/routes/comment-review.js`.

### Ingest (called by Make.com on new file in Client Comments folder)

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/api/cr/ingest` | `{ filePath, dropboxPath, dropboxLink, filename }` | Submission found + MDS comment file URL written |

**Ingest logic:**
1. Parse filename → `clientAcronym`, `receivedDate`, `drawingNo`, `rev`
2. Parse path → `stage` (from folder name)
3. Query Submissions DB: `Status = Issued` + `Stage = stage` + drawing matching `drawingNo` + `Revision = rev`
4. If found: update MDS `S4/S5/A4.5 Comment File` → dropboxLink; queue entry created
5. If not found: log warning — DM should be notified (file may have wrong name or arrived before issue)

### Queue and review

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET | `/api/cr/queue` | `?projectId` | All Submissions with comment file URL set but not yet Graded, for the project |
| GET | `/api/cr/submission/:id` | — | Submission data + drawing metadata + MDS properties |

### Save review (grade + on-hold + MDS write)

| Method | Path | Body | Returns |
|--------|------|------|---------|
| PATCH | `/api/cr/submission/:id/save` | `{ grade, gradeDate, pins, onHold }` | Writes to Submission + MDS (see 9.5) |

The `pins` array is stored session-side only (not persisted to Notion — no pin database).
The structured pin data is sent in the DT email payload.

### RFI

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/api/cr/rfi` | `{ submissionId, drawingId, taskId, pinNumber, tbcBy, question, description, snippets }` | RFI page created in Notion |
| POST | `/api/cr/rfi-description` | `{ question }` | `{ description }` — Claude Haiku generation |

### Email + export

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/api/cr/notify-dt` | `{ submissionId, pins, grade, onHold, exportLink }` | Make webhook fired (action = cr-dt-notify) |
| POST | `/api/cr/export-upload` | `{ submissionId, fileBase64, filename, dropboxFolder }` | Make upload webhook fired (action = cr-upload) |

### Lookups

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/cr/clients` | Client acronym register from `clients.json` |
| GET | `/api/projects` | Projects list (same endpoint as axiom-drawing-flow) |
| GET | `/api/rfi-options` | `{ rfiStatus, tbcBy }` — options from RFI DB schema (ported from old app) |

---

## 13. File Structure (new project)

```
axiom-client-comment-reviewer/
├── comment-review.js      ← Backend routes
├── app.js                 ← Express app
├── server.js              ← Local dev launcher
├── package.json
├── netlify.toml
├── netlify/
│   └── functions/api.js
├── clients.json           ← Client acronym register (configurable)
├── .env.example
└── public/
    ├── index.html
    ├── styles.css
    ├── app.jsx            ← Shell + routing
    ├── comment-reviewer.jsx  ← Main reviewer UI (left panel + viewer + right panel)
    ├── pin-toolbar.jsx    ← Category selector floating toolbar
    ├── rfi-modal.jsx      ← RFI popup
    └── legend-stamp.jsx   ← Draggable legend overlay
```

---

## 14. Notion — New Properties Checklist (DM action required)

### Submissions DB — no new properties needed
All required properties already exist. Verify the following are present and options are correct:
- [ ] `Client Grade` — select, options include: A / B / C / NA / Approved / Rejected
- [ ] `Blocked` — checkbox (already used by cockpit)
- [ ] `Reviewed` — date
- [ ] `Ball In Court` — select, options include: DM / DT

### MDS — 7 new properties
- [ ] `S4 Comment Files` — rich_text (accumulates hyperlinked file names, one per line)
- [ ] `S5 Comment Files` — rich_text
- [ ] `A4.5 Comment Files` — rich_text
- [ ] `S4 Client Reviewers` — multi-select, options from `clients.json` (MC / ARCH / PM / ENG / ID)
- [ ] `S5 Client Reviewers` — multi-select, same options
- [ ] `A4.5 Client Reviewers` — multi-select, same options
- [ ] `Hold Notes` — rich_text (written on save when Blocked; cleared on unblock)

### Cockpit — update existing hold route
The `/api/df/submissions/:id/hold` route already exists. It needs to be extended to also:
- [ ] Update `Drawing Status` on MDS when unblocking (→ `Being Revised`)
- [ ] Clear `Hold Notes` on MDS when unblocking
- [ ] Update `Ball In Court` → `DT` when unblocking

### RFI DB — 3 new properties
- [ ] `Question` — rich_text
- [ ] `Drawing` — relation → MDS database
- [ ] `Snippets` — files & media

Existing RFI properties to verify (confirmed from previous app — check exact name/casing):
- [ ] `RFI Description` — title (this IS the title field, not a separate property)
- [ ] `RFI Status` — select, options: To Raise / Raised / Response Received / Closed
- [ ] `TBC by` — select (**exact casing: lowercase 'b'** — will fail silently if wrong)
- [ ] `Date Raised` — date
- [ ] `Related Item(s)` — relation → Tasks

### RFI DB — confirm or add
- [ ] `RFI Status` — status, options: To Raise / Raised / Response Received / Closed
- [ ] `TBC By` — select
- [ ] `Question` — rich_text
- [ ] `RFI Description` — rich_text
- [ ] `Drawing` — relation → MDS
- [ ] `Submission` — relation → Submissions DB
- [ ] `Snippets` — files & media

---

## 15. Dropbox Folder Setup (DM action required)

Create `Client Comments/` subfolder inside each stage folder for all active projects:

```
/DESIGN KNOW HOW/TMJ Interiors/24-367/S4/Client Comments/
/DESIGN KNOW HOW/TMJ Interiors/24-367/S5/Client Comments/
/DESIGN KNOW HOW/TMJ Interiors/24-367/A4.5/Client Comments/
```

The Make.com scenario will then automatically watch these folders once configured.

---

## 16. Build Sequence

Follow this order strictly. Do not skip ahead.

```
Step 1  ← Notion setup (DM) — section 14
         Add 3 MDS URL properties (S4/S5/A4.5 Comment File)
         Add 4 RFI DB properties (Question, Drawing, Submission, Snippets)
         Verify existing Submissions DB properties match spec
         Verify RFI DB: exact casing of 'TBC by', 'RFI Description', etc.

Step 2  ← Dropbox setup (DM)
         Create Client Comments/ subfolder in S4, S5, A4.5 for all active projects

Step 3  ← Scaffold new app (Vite + React pattern)
         package.json — port from DrawingCommentReviewer, bump versions as needed
         vite.config.js, server/index.js, src/App.jsx, src/index.css
         Create clients.json with initial acronym register
         Set up .env.example with all required vars

Step 4  ← Backend: ingest route
         Parse filename → drawingNo, rev, stage, clientAcronym, receivedDate
         Find existing Issued Submission record
         Write S4/S5/A4.5 Comment File URL to MDS
         Test: drop real file → verify MDS property updated

Step 5  ← Backend: queue + submission detail routes
         Returns Submitted records with comment file URL set (not yet Graded)
         Includes MDS properties for right panel auto-population

Step 6  ← Frontend: shell + left panel
         Queue list from /api/cr/queue
         Status badges, client badge, date received
         Click to load into viewer

Step 7  ← Frontend: right panel
         Auto-populated from submission detail
         Grading section (grade select + date)

Step 8  ← Frontend: PDF viewer
         Port PDFViewer.jsx from DrawingCommentReviewer
         Zoom (ctrl+scroll), pan (space+drag), page navigation

Step 9  ← Frontend: pin system
         Category toolbar (7 categories, Okabe-Ito colours)
         Pin placement, numbering, drag-to-move
         On-hold banner when hold-category pin placed
         Port Pin/PinOverlay.jsx from DrawingCommentReviewer, update categories

Step 10 ← Frontend: mark-up tools
         Arrows, rectangles, freehand, text, dimension line
         SVG overlay, undo/redo stack

Step 11 ← Frontend: legend stamp
         Draggable stamp, auto-placed bottom-right
         Shows category counts + reviewer + date + drawing info

Step 12 ← Backend + Frontend: save review
         PATCH /api/cr/submission/:id/save
         Writes grade + on-hold to Submission + MDS
         Wires "Save & Close" button

Step 13 ← Backend + Frontend: RFI popup
         Port RFIForm.jsx from DrawingCommentReviewer
         Add Question field, AI description generation (Claude Haiku)
         Wire to /api/cr/rfi

Step 14 ← Frontend + Backend: PDF export
         pdf-lib: flatten pins + mark-up onto PDF pages
         Legend stamp baked in
         /api/cr/export-upload → Make.com upload webhook

Step 15 ← Backend + Frontend: DT notify email
         "Send DT Email" button fires /api/cr/notify-dt
         Make.com action = cr-dt-notify → Gmail
         Email includes issued drawing link + comment PDF link + pin summary

Step 16 ← Make.com: configure two new scenarios
         Scenario A: Watch Client Comments folders → POST /api/cr/ingest
         Scenario B: Handle cr-dt-notify and cr-upload action types in Actions Hub

Step 17 ← Integration test: end-to-end
         Drop file → ingest → queue → review → pin → grade → export → email

Step 18 ← Retire cockpit "Log Status" for S4/S5 (after stable deployment)
```

---

## 17. Key Decisions

| Decision | Rationale |
|----------|-----------|
| Manual pin placement (not AI extraction) | Complex mark-up PDFs not linearly parseable — AI extraction unreliable |
| No new Submission records on comment receipt | Comments update the existing Issued record — avoids duplication |
| Comment link on MDS (not Submissions DB) | Drawing-level property; one URL per stage, not per submission event |
| Numbered pins, not category codes | Consistent with DT Drawing Checker — reviewer familiar with the pattern |
| Pins as DOM overlays, not canvas draws | Click-to-edit without re-rendering; scales naturally with zoom |
| Okabe-Ito colour palette | Designed for colour-blind accessibility; all 7 colours distinguishable |
| Hold written on Save (not on pin drop) | Avoids mid-review API chatter; single atomic write on completion |
| Grade logged in Comment Reviewer (not cockpit) | Grade is set as part of reviewing comments — logical coupling |
| On-hold triggered by pin category | Automatic — reduces error; cleared manually in Notion |
| Client Comments inside Stage folder | All S4 files together — issued + received in one place |
| `_R.pdf` suffix on export | Make.com filter excludes it — prevents re-ingest loop |
| Vite + React (not no-build Babel) | PDF rendering / drag-drop / state complexity requires proper bundling |
| Separate app from axiom-drawing-flow | Different interaction pattern; independent deployment; PDF deps are heavy |
| `clients.json` configurable register | New clients added without code change |

---

## 18. Environment Variables (new app)

```env
NOTION_TOKEN=ntn_xxxx

# Shared DB IDs
NOTION_DB_DRAWINGS=13b210e4582e8168923ff79fa8628b59
NOTION_DB_SUBMISSIONS=36f210e4582e80ed8b2ce9e245bda433
NOTION_DB_TEAM=348210e4582e8005bb58d4aa963dd101
NOTION_DB_TASKS=bb783a35-a407-4637-89c6-78ebc76c8699
NOTION_DB_PROJECTS=5c689434c2b047669831d2b31ef0f8de
NOTION_DB_RFIS=22d210e4582e80189f63f2cee93be4b3

# Make.com
MAKE_ACTIONS_WEBHOOK=https://hook.eu2.make.com/xxxx

# Anthropic (for RFI description generation — same key as DrawingCommentReviewer)
ANTHROPIC_API_KEY=

# Optional
PORT=3001
```

---

## 19. Open Questions (resolve before relevant build step)

**Before Step 1 (Notion setup):**
1. **RFI number convention** — is there an existing project system format (e.g. `24-367-RFI-001`)?
   RFI numbers are assigned manually in Notion post-creation. If a formula property is needed
   to auto-generate a reference, flag this before the RFI DB properties are added.
2. **Snippet file size** — Notion files API has a 5MB cap per file. Large annotated screenshots
   may exceed this. If needed, the fallback is to upload to Dropbox and store the URL in the
   Snippets property instead of embedding. To be confirmed when tested.

**Before Step 16 (Make.com):**
3. **Make.com Actions Hub** — `cr-dt-notify` and `cr-upload` action types need to be added
   as new branches in the existing Actions Hub scenario. This should be done in the same
   session as Step 16, not deferred.

**Before Step 18 (Retire cockpit Log Status):**
4. **Cockpit coexistence** — while both paths are live, Comment Reviewer grade takes
   precedence (it's more complete). Cockpit Log Status for S4/S5 will be hidden once
   Comment Reviewer is confirmed stable.

**Future (separate session):**
5. **Design Change / Variation workflow** — Category 1 (Awaiting Instruction) and
   Category 2 (Instruction Required) pins will eventually trigger this workflow.
   Explicitly out of scope here — captured as a future integration point.
