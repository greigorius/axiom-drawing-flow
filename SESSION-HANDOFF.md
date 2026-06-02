# Axiom Drawing Flow — Session Handoff

**Date:** 2026-06-01  
**Previous handoff:** `HANDOFF.md` (initial architecture, pre-build)  
**Status:** Steps 1–3 complete. Step 4 in progress — Make.com scenarios being configured.

---

## 1. What was built this session

All files are written and verified at:
```
C:\Users\greig\Documents\ClaudeProjects\axiom-drawing-flow\
├── drawing-flow.js        ← Backend routes — fully corrected, Make webhooks wired
├── app.js                 ← Express app — mounts drawing-flow, /api/projects, /api/tasks
├── server.js              ← Local dev launcher
├── package.json
├── netlify.toml
├── netlify/functions/api.js
├── .env.example           ← All vars including MAKE_*_WEBHOOK
└── public/
    ├── index.html
    ├── styles.css
    ├── app.jsx            ← Hash router shell (#cockpit / #inputs)
    ├── cockpit.jsx        ← DM submissions queue (polls every 30s)
    └── inputs.jsx         ← Programme Inputs form (7 fields)
```

Syntax verified clean. `npm install` not yet run (no `node_modules`).

---

## 2. Confirmed Notion DB IDs

| Variable | ID | Notes |
|---|---|---|
| `NOTION_DB_TASKS` | `bb783a35-a407-4637-89c6-78ebc76c8699` | Confirmed |
| `NOTION_DB_PROJECTS` | `5c689434c2b047669831d2b31ef0f8de` | Confirmed |
| `NOTION_DB_DRAWINGS` | `13b210e4582e8168923ff79fa8628b59` | Confirmed (MDS) |
| `NOTION_DB_TEAM` | `348210e4582e8005bb58d4aa963dd101` | **Corrected** — handoff had wrong ID |
| `NOTION_DB_SUBMISSIONS` | `36f210e4582e80ed8b2ce9e245bda433` | Set up by DM — not yet verified via fetch |
| `NOTION_DB_INPUTS` | **TBD** | DM still to create and provide ID |

---

## 3. Confirmed property names (all ← confirm markers resolved)

### Tasks DB
| Property | Type | Notes |
|---|---|---|
| `Item Name` | title | The task title |
| `Item No.` | **formula** | ⚠️ Cannot filter — reads as string, extracts 3-digit number from "Suffix NNN" in Item Name |
| `Projects` | relation | To Projects DB |
| `Drawing No(s)` | relation | To MDS |
| `Miro Board Link` | url | Already exists — no need to add |

**Formula lookup workaround:** `findTask()` filters by `Item Name title contains paddedItemNo`, then verifies `Item No.` formula value in JS. See drawing-flow.js.

### Team DB
| Property | Type | Notes |
|---|---|---|
| `Name` | title | |
| `Email` | email | Used in Make webhook payloads |
| `Initials` | **formula** | ⚠️ Cannot filter — `findDT()` fetches all team members and matches in JS |

### MDS (Master Drawing Schedule)
All properties confirmed via Notion fetch. Key ones:

| Property | Type | Select options |
|---|---|---|
| `Drawing Number` | title | |
| `Item` | relation | → Tasks |
| `Drawing Status` | select | First Issue / DM Review / Client Review / Approval Updates / Production Updates / On Hold / **Complete** |
| `Submission Stage` | select | S3 - For Coordination / S4 - For Review and Authorisation / S5 - For Review and Acceptance / **A4.5 - Authorised Mfg. & Constr. Design** / **AB - As Built Record Drawings** |
| `Rev` | select | P01 / P02 / P03 / C01 / C02 / C03 |
| `S4 Status` | select | A / B / C |
| `S4 Status Date` | date | |
| `S4 Submit Date (Actual)` | date | |
| `S5 Status` | select | A / B / C / NA |
| `S5 Status Date` | date | |
| `S5 Submit Date (Actual)` | date | |
| `C01 Submit Date (Actual)` | date | |
| `C01 Sign Off` | date | MC sign-off date |
| `AB Status` | select | Approved / Rejected |
| `AB Status Date` | date | |
| `AB Submit Date (Actual)` | date | |
| `Model Submit Date` | date | S3 stage |

**Critical:** `A4.5` Submission Stage label is `"A4.5 - Authorised Mfg. & Constr. Design"` — NOT "Authorised for Manufacture and Construction". This is hardcoded correctly in `STAGE_LABEL` in drawing-flow.js.

### Projects DB
| Property | Type | Notes |
|---|---|---|
| `Project Name` | title | |
| `Approval Days` | number | 14 — contractual review period (S4 and S5) |
| `Revision Days` | number | 7 — DT's revision window to produce S5 after S4 grade |
| `C01 Sign Off Days` | number | MC sign-off period for C01 |

---

## 4. The corrected drawing lifecycle (key decisions)

### Stage flow
```
S4 → S5 → A4.5 (C01) → [production + install] → AB
```

### S4 stage
- DT submits PDF to `/Pending/`
- DM reviews internally (S4 QA Days from Inputs DB)
- DM Approve → issues to Architect/MC/M&E
- **Approval Days (14)** for Architect/MC/M&E to review and grade A/B/C
- Grade received → DT starts S5 immediately (no wait)
- **Revision Days (7)** = DT's production window to complete S5
- ALL grades (A/B/C) proceed to S5 — no branching at S4

### S5 stage
- DT submits → DM reviews → DM Approve → issues to Client
- **Approval Days (14)** for Client to grade A/B/C/NA
- Grade A/B/NA → DT updates for C01 immediately
- Grade C → resubmit S5 (new cycle)
- NA = client has no comment, proceeds same as A/B

### C01 / A4.5 stage
- DT develops supply/production drawings
- DM reviews → DM Approve → issues to MC for sign-off
- **C01 Sign Off Days** = MC's sign-off period
- DM Approve sets `Drawing Status = Production Updates`
- **No Log Status action** — DM Approve is the only gate

### AB stage
- After production + install
- DT submits As Built drawings
- DM reviews → DM Approve → issues to Document Control
- DC grades: **Approved** → `Drawing Status = Complete` + BIC cleared
- DC grades: **Rejected** → `Drawing Status = Approval Updates` + BIC → DT

### Grade → cascade logic (ALL stages)

| Stage | Any grade | Drawing Status | BIC |
|---|---|---|---|
| S4 | A / B / C | Approval Updates | DT |
| S5 | A / B / NA | Approval Updates | DT (proceeds to C01) |
| S5 | C | Approval Updates | DT (resubmits S5) |
| AB | Approved | **Complete** | Cleared |
| AB | Rejected | Approval Updates | DT |

**Critical:** A4.5 does NOT support Log Status (Approve/Bounce only).

### QA Round counter
Resets to 1 each time a new stage begins. Increments within a stage on each Bounce + resubmit.

---

## 5. Make.com integration (Step 4 — in progress)

**Why Make over Zapier:** Router module handles conditional branching natively. One scenario covers the full approve/bounce/grade flow including file moves and Gmail, without needing multiple Zaps per action.

### Scenario 1 — Ingest (Dropbox → backend)
**Trigger:** Dropbox — Watch Files in a Folder  
- Folder: `/DESIGN KNOW HOW/TMJ Interiors/Drawing Submissions` (watch subfolders: yes)  

**Module 2:** Filter  
- Condition 1: `{{1.path}}` contains `/Pending/`  
- Condition 2: `{{1.name}}` ends with `.pdf`  

**Module 3:** HTTP — Make a request  
- Method: POST  
- URL: `https://your-app.netlify.app/api/df/ingest`  
- Body type: application/json  
- Body:
```json
{
  "filePath": "{{1.path}}",
  "dropboxPath": "{{1.path}}",
  "dropboxLink": "{{1.webViewLink}}"
}
```

### Scenario 2 — Approve (backend webhook → Dropbox move + Gmail)
**Trigger:** Webhooks — Custom webhook (copy URL → `MAKE_APPROVE_WEBHOOK` in .env)

**Module 2:** Router  
- Route A: Dropbox — Move a File  
  - Condition: `{{1.dropboxMove}}` exists  
  - From: `{{1.dropboxMove.from}}`  
  - To: `{{1.dropboxMove.to}}`  
- Route B: Gmail — Send an Email  
  - To: `{{1.dtEmail}}`  
  - Subject: `Drawing Issued — {{1.submissionTitle}}`  
  - Body: Drawing `{{1.submissionTitle}}` has been issued to the client for review. Stage: `{{1.stage}}`. Issued: `{{1.issuedDate}}`.

### Scenario 3 — Bounce (backend webhook → Dropbox move + Gmail)
**Trigger:** Webhooks — Custom webhook (copy URL → `MAKE_BOUNCE_WEBHOOK` in .env)

**Module 2:** Router  
- Route A: Dropbox — Move a File  
  - Condition: `{{1.dropboxMove}}` exists  
  - From: `{{1.dropboxMove.from}}`  
  - To: `{{1.dropboxMove.to}}`  
- Route B: Gmail — Send an Email  
  - To: `{{1.dtEmail}}`  
  - Subject: `Drawing Bounced — {{1.submissionTitle}}` (QA Round {{1.qaRound}})  
  - Body: Your drawing has been returned for revision. DM comments: `{{1.comments}}`

### Scenario 4 — Grade (backend webhook → Gmail, routed by stage + grade)
**Trigger:** Webhooks — Custom webhook (copy URL → `MAKE_GRADE_WEBHOOK` in .env)

**Module 2:** Router with 5 routes (filter on stage + grade combinations):

| Route | Filter | Gmail subject / message |
|---|---|---|
| S4 any | `stage = S4` | "S4 Comments Received — please address and submit S5 within 7 days" |
| S5 A/B/NA | `stage = S5 AND grade != C` | "S5 Approved — please update for C01 and resubmit" |
| S5 C | `stage = S5 AND grade = C` | "S5 Resubmission Required — comments attached" |
| AB Approved | `stage = AB AND grade = Approved` | "As Built Approved — drawing complete" |
| AB Rejected | `stage = AB AND grade = Rejected` | "As Built Revision Required" |

### Environment variables for Make
```env
MAKE_APPROVE_WEBHOOK=https://hook.eu2.make.com/...  ← paste from Scenario 2
MAKE_BOUNCE_WEBHOOK=https://hook.eu2.make.com/...   ← paste from Scenario 3
MAKE_GRADE_WEBHOOK=https://hook.eu2.make.com/...    ← paste from Scenario 4
```

### Make webhook payload fields (what backend sends)

**Approve:**
```json
{
  "action": "approve",
  "submissionId": "notion-page-id",
  "submissionTitle": "24-367-003_A-101_S4_R1",
  "stage": "S4",
  "drawingStatus": "Client Review",
  "issuedDate": "2026-06-01",
  "dtName": "Greig MacLeod",
  "dtEmail": "dt@axiom.co.uk",
  "dropboxMove": { "from": "/DESIGN KNOW HOW/TMJ Interiors/Drawing Submissions/24-367/S4/Pending/003_A-101_P01_GM.pdf", "to": "/DESIGN KNOW HOW/TMJ Interiors/Drawing Submissions/24-367/S4/003_A-101_P01_GM.pdf" }
}
```

**Bounce:**
```json
{
  "action": "bounce",
  "submissionId": "notion-page-id",
  "submissionTitle": "24-367-003_A-101_S4_R1",
  "stage": "S4",
  "qaRound": 1,
  "bouncedAt": "2026-06-01",
  "comments": "Title block incomplete. Section AA missing.",
  "dtName": "Greig MacLeod",
  "dtEmail": "dt@axiom.co.uk",
  "dropboxMove": { "from": "...", "to": "..../Rejected/R1/..." }
}
```

**Grade:**
```json
{
  "action": "log-status",
  "submissionId": "notion-page-id",
  "submissionTitle": "24-367-003_A-101_S4_R1",
  "stage": "S4",
  "grade": "A",
  "gradedAt": "2026-06-01",
  "drawingStatus": "Approval Updates",
  "isTerminal": false,
  "dtName": "Greig MacLeod",
  "dtEmail": "dt@axiom.co.uk"
}
```

---

## 6. Build sequence status

```
Step 1  ✅  Notion setup (DM completed — all DBs created, properties confirmed)
Step 2  ✅  Backend scaffold (app.js, server.js, package.json, netlify.toml, etc.)
Step 3  ✅  Property name verification (all ← confirm markers resolved)
Step 4  ✅  Make.com scenarios — COMPLETE (consolidated to 2 scenarios)
             Scenario 1 (Ingest):      ID 5993712 — INACTIVE (needs Netlify URL)
             Scenario 2 (Actions Hub): ID 5993716 — ACTIVE
Step 5  ⏳  Cockpit UI — BUILT, awaiting live test
Step 6  ✅  Dropbox file moves — handled by Scenario 2 Router
Step 7  ⏳  Programme Inputs form — BUILT, awaiting NOTION_DB_INPUTS ID
Step 8  ✅  Gmail notifications — handled by Scenario 2 Router
Step 9  ⏳  DT mandate PDF
Step 10 ⏳  DT Drawing Checker rework (separate workstream — DO NOT START YET)
```

**Scenario consolidation:** Free Make plan = 2 scenario limit (both slots used). Originally planned 4;
consolidated to 2 by routing all backend webhooks through single `MAKE_ACTIONS_WEBHOOK`, branched
in Make by `action` field (approve / bounce / log-status).

---

## 7. Immediate next actions (new session)

1. **Deploy to Netlify** — run `npm install` then deploy
2. **Update Scenario 1 URL** — open Make, edit Scenario 1 module 2 (HTTP), replace placeholder URL
   with `https://YOUR-SITE.netlify.app/api/df/ingest`, then activate the scenario
3. **Set Netlify env vars** — paste all vars from `.env.example` into Netlify dashboard
   Key ones: `NOTION_TOKEN`, all `NOTION_DB_*`, `MAKE_ACTIONS_WEBHOOK`
4. **Test end-to-end** — drop a PDF into Dropbox `/Pending/`, verify chain fires
5. **Get `NOTION_DB_INPUTS`** — DM to create Inputs DB and provide ID

---

## 8. Outstanding items before full go-live

- [ ] `NOTION_DB_INPUTS` — DM to create Inputs DB and provide ID
- [ ] `STAGE_APPROVE_BIC["AB"]` — change from `"Project Team"` to `"Document Control"` in drawing-flow.js once that option is added to Submissions DB Ball In Court select
- [ ] Submissions DB `Stage` select — verify `AB` option exists (DM should add if not)
- [ ] Submissions DB `Client Grade` select — verify `Approved` and `Rejected` options exist (for AB Log Status)
- [ ] `npm install` — not yet run, do before deploy
- [ ] Netlify env vars — paste all from `.env` into Netlify dashboard

---

## 9. Key architectural decisions (do not re-litigate)

| Decision | Rationale |
|---|---|
| Make.com over Zapier | Router handles all branching in one scenario; cheaper; better file handling |
| Make fires backend; backend fires Make | Clean separation — Notion state owned by backend, file moves + email owned by Make |
| All S4 grades → S5 (no branching at S4) | Architect/MC/M&E grade is for feedback only; 7-day revision window always runs |
| All S5 grades → Approval Updates + BIC DT | Even A/B/NA go back to DT for title block + C01 development; C resubmits S5 |
| C01 = Approve/Bounce only, no Log Status | DM is the only gate; MC sign-off period tracked by scheduling tool, not backend |
| AB Log Status = Approved/Rejected (not A/B/C) | Document Control binary sign-off, not a grading system |
| `Item No.` and `Initials` are formula properties | Cannot filter in Notion API — findTask() and findDT() use JS matching instead |
| `Revision Days` from Projects DB = DT's S5 window | Contractual baseline; Inputs DB `S5 Lead Time` overrides per task |
| S4/S5 Client Review Days removed from Inputs DB | Those periods come from Projects DB `Approval Days` |
| MDS `(Plan)` and `(Adj)` dates = Scheduling Tool only | Never write to these from drawing-flow.js |
| `Programme Start` in Inputs DB = `1st DT Start (Plan)` | Single anchor date; scheduling tool projects forward from this |
