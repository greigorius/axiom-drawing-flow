# Axiom Drawing Flow — Data Model & Notion Schema

**Status:** v2 — rewritten to the real Master Drawing Schedule (MDS) schema
**Supersedes:** v1 generic draft
**Scope:** The three-tier model (Tasks → MDS drawings → Submissions), grounded in the
*actual* MDS schema (ISO-19650 S-stages, A/B/C gradings), and the exact field-writes the
Submissions cascade performs.

---

## 1. Core principle

The **MDS is the Drawings tier** (`NOTION_DB_DRAWINGS` → `13b210e4582e8168923ff79fa8628b59`).
It is already a rich submission-tracking register. Axiom Drawing Flow does **not** add a
parallel state layer — the Submissions event log acts as a *controller* that drives the
MDS's existing fields. The MDS stays the single register of drawing truth.

A separate, focused **Inputs DB** holds all manually-entered parameters (programme +
commercial) — see `INPUTS-ARCHITECTURE.md`. The MDS and Tasks become display-only for
those values: the Scheduling Tool writes projections back, and actuals come from event
logs (Submissions, Timesheets).

```
Project ─(rollup)─ Task (Item) ─1:N→ MDS Drawing ─1:N→ Submission ─N:1→ Team (DT)
                        ↑
                  Inputs DB (Project + Task scoped rows)
                  read by Scheduling Tool + app
```

The Drawing→Task link already exists: the MDS `Item` relation → Tasks DB. Projects,
Assigned To, Production Date all **rollup through `Item`** — no new relations needed on the MDS.

---

## 2. The two-gate lifecycle (per S-stage)

Each submission stage (**S3 model**, **S4**, **S5**, A4.5) runs its own cycle. The QA-round
counter resets per S-stage. Two distinct gates:

| Gate | Who | Action | When |
|------|-----|--------|------|
| **Internal QA** | DM (you) | **Approve / Bounce** | *Before* issue — reviewing the DT's work |
| **External status** | Client/reviewer | **Log Status: A / B / C** | *After* issue — the formal grading |

Approve/Bounce is the DT-facing internal gate (Bounce loops back, QA Round +1).
A/B/C is the post-issue external verdict (B/C kicks off a fresh S-cycle; A completes the stage).
**These are separate axes — never conflate them.**

---

## 3. MDS field mapping (what the cascade reads & writes)

### Status fields the cascade DRIVES (writable selects)

| MDS Property | Type | Driven to |
|--------------|------|-----------|
| `Drawing Status` | select | `DM Review` (on submit) → `Client Review` (on issue) → `Being Revised` (on B/C) → `Production Update` / `On Hold` as needed |
| `S4 Status` | select | `A` / `B` / `C` (via Log Status, S4 stage) |
| `S5 Status` | select | `A` / `B` / `C` / `NA` (via Log Status, S5 stage) |
| `Submission Stage` | select | current S-stage label (S2/S3/S4/S5/A4.5) |
| `Rev` | select | P01–P03, C01–C03 (from filename revision) |

### Date fields the cascade WRITES — plain dates only (✅ writable)

`S4 Submit Date (Actual)` · `S4 Status Date` · `S4 Updates (Actual)`
`S5 Submit Date (Actual)` · `S5 Status Date` · `S5 Updates (Actual)`
`C01 Submit Date (Actual)` · `C01 Sign Off` · `C01 Updates (Actual)`
`Schedule Production (Actual)` · `Model Submit Date`

### Projections are now Scheduling-Tool-owned (not Notion formulas)

The `(Plan)` and `(Adj)` fields are being converted from Notion formulas to plain dates,
**written back by the Axiom Scheduling Tool** (the compute authority for programme dates).
Notion becomes the system of *record* (actuals); the Scheduling Tool is the system of
*projection*. The Drawing Flow cascade still writes only actuals; the Scheduling Tool
writes the Plan/Adj dates on its own schedule. See `NOTION-MIGRATION-CHECKLIST.md`.

### Fields the cascade must NEVER write (owned by others)

Rollups (`Assigned To`, `Projects`, `Install Date`, `Production Date`) — derived.
`(Plan)`/`(Adj)` dates — owned by the Scheduling Tool, not the Drawing Flow cascade.

### Checkboxes the cascade may set (✅ writable)

`1st Issue Submitted` · `2nd Issue Submitted` · `Constr. Issue Submitted` ·
`Model Submitted` · `In Production` — set as the matching stage is issued.

---

## 4. Stage → field routing

The cascade picks which date/status fields to write based on the Submission's `Stage`:

| Submission Stage | On Issue (Approve) writes | On Log Status writes |
|------------------|---------------------------|----------------------|
| S3 — For Coordination (model) | `Model Submit Date`, `Model Submitted = ✓`, `Drawing Status = Client Review` | `S3 Status` if tracked, `Drawing Status` |
| S4 — Review & Authorisation | `S4 Submit Date (Actual)`, `Drawing Status = Client Review`, `1st Issue Submitted = ✓` | `S4 Status` (A/B/C), `S4 Status Date` |
| S5 — Review & Acceptance | `S5 Submit Date (Actual)`, `Drawing Status = Client Review`, `2nd Issue Submitted = ✓` | `S5 Status` (A/B/C/NA), `S5 Status Date` |
| A4.5 — Authorised Mfg/Constr | `C01 Submit Date (Actual)`, `Constr. Issue Submitted = ✓` | `C01 Sign Off` |
| S2 / S3 (optional) | `Model Submit Date` / `Drawing Status` | — |

---

## 5. Submissions database (the ONE new database)

Append-only event log. `NOTION_DB_SUBMISSIONS`.

| Property | Type | Purpose | Written by |
|----------|------|---------|-----------|
| `Submission` | Title | e.g. `24-367-A-101 · S4 · R1` | Ingest |
| `Drawing` | Relation → MDS | The drawing | Ingest |
| `Task` | Relation → Tasks | Denormalised for rollup | Ingest |
| `Stage` | Select | S3 / S4 / S5 / A4.5 | Ingest (from folder) |
| `Revision` | Select | P01–P03, C01–C03 | Ingest (from filename) |
| `DT` | Relation → Team | Submitter (filename initials) | Ingest |
| `Ball In Court` | Select | Who holds it now (8 opts, same as Tasks) | Cascade (each transition) |
| `BIC Since` | Date | When it landed with the current holder | Cascade |
| `QA Round` | Number | 1, +1 per bounce within this S-stage | Ingest |
| `Status` | Select | Submitted / Approved / Issued / Rejected / Graded | Ingest + cascade |
| `DM Action` | Select | (trigger) Approve / Bounce / Log Status / empty | Button → cascade |
| `Client Grade` | Select | A / B / C / NA (when DM Action = Log Status) | Button |
| `DM Comments` | Rich text | Bounce-back notes | Button |
| `Submitted` | Date | File landed | Ingest |
| `Reviewed` | Date | Approve/Bounce pressed | Cascade |
| `Issued` | Date | Issue timestamp | Cascade |
| `Dropbox Link` | URL | The file | Ingest |

`Status` options: `Submitted`, `Approved`, `Issued`, `Rejected`, `Graded`.
`DM Action` options: `Approve`, `Bounce`, `Log Status` (empty until you act).

---

## 6. Dropbox data contract

```
/Axiom Submissions/{ProjectNo}/{S-Stage}/{DrawingNo}_{Rev}_{DTinitials}.pdf
example: /Axiom Submissions/24-367/S4/24-367-A-101_P01_GM.pdf
```

| Source | Fills |
|--------|-------|
| Folder L1 | ProjectNo (→ resolve via Item/Projects rollup) |
| Folder L2 | `Stage` (S2/S3/S4/S5/A4.5) |
| Filename 1 | `Drawing No` → match MDS `Drawing Number` title |
| Filename 2 | `Revision` → MDS `Rev` |
| Filename 3 | DT initials → Team relation |

Stage lives in the **folder** (reliable); drawing detail in the **filename**.

---

## 7. QA Round logic (per S-stage)

On ingest: search Submissions for an open row (`Status = Submitted`) matching the same
`Drawing` + `Stage`. Found → resubmission → new row `QA Round = prev + 1`, mark prior
`Rejected`. None → first submit this stage → `QA Round = 1`. **Counter is per-S-stage** —
entering S5 starts a fresh QA Round 1 even if S4 took three rounds.

---

## 8. Three actions (cockpit buttons)

| Action | Internal/External | Writes | Gmail |
|--------|-------------------|--------|-------|
| **Approve** | Internal gate pass | `Drawing Status = Client Review`, stage `Submit Date (Actual)`, issue checkbox, Submission `Issued` | Confirm to DT |
| **Bounce** | Internal gate fail | Submission `Rejected` + comments, `Drawing Status` stays DM Review | Revision request to DT |
| **Log Status** | External grade | `S4/S5 Status` = A/B/C, `Status Date`; on B/C → `Drawing Status = Being Revised` | Notify DT of grade |

---

## 8.5 Ball In Court (chase visibility)

BIC answers "who holds this, and how long has it sat there." It moves automatically with
each lifecycle transition. Reuses the existing Tasks 8-option set: Supplier, DT, DM,
Architect, Project Team, Contractor, Production, Site.

| Lifecycle state | Ball In Court | `BIC Since` set to |
|-----------------|---------------|--------------------|
| Submitted (awaiting QA) | DM | submission time |
| Bounced | DT | bounce time |
| Issued (awaiting client) | Architect / Contractor | issue time |
| Graded B/C (revise) | DT | grade time |
| Graded A (complete) | — (cleared) | — |

`BIC Since` + today = "days waiting" — the chase metric. The cockpit can sort the queue by
it so the longest-waiting items surface first. Tasks-level `Ball In Court` stays for
package view; this is the per-submission/per-drawing layer.

## 9. app.js integration

Reuse exactly: `@notionhq/client` SDK, `do/while(cursor)` pagination, `getProjectsMap`
cache, the `notionPageToItem` mapper pattern (add `notionPageToDrawing`,
`notionPageToSubmission`), `PROP_KEY_MAP`/`buildPropPatch` (extend for MDS date+select
writes), and `ensureNotionSchema` (only the new Submissions DB needs option seeding — the
MDS already has every select option required).

### New API verbs

| Method | Path | Action |
|--------|------|--------|
| `POST` | `/api/ingest` | Zapier → on new Dropbox file: parse, find-or-create Submission, set `Drawing Status = DM Review` |
| `GET` | `/api/submissions` | Cockpit polls for `Status = Submitted` (awaiting QA) |
| `PATCH` | `/api/submissions/:id/approve` | Issue cascade + Gmail |
| `PATCH` | `/api/submissions/:id/bounce` | Reject cascade + Gmail |
| `PATCH` | `/api/submissions/:id/log-status` | A/B/C cascade + Gmail |
| `GET` | `/api/drawings` | MDS drawing-level view |

### New env

```
NOTION_DB_DRAWINGS=13b210e4582e8168923ff79fa8628b59   # = MDS
NOTION_DB_SUBMISSIONS=...                              # new (event log)
NOTION_DB_INPUTS=...                                   # new (manual inputs)
NOTION_DB_TEAM=...                                     # DT email lookup
GMAIL_...                                              # backend Gmail send
```

---

## 10. Not in v1

Timesheets / To Do integration · S2/S3 cycles (start with S4, S5, A4.5) ·
multi-round escalation (simple counter only) · auto stage-routing (folder-driven).
