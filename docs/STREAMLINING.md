# Axiom Drawing Flow — Database Streamlining Analysis

**Purpose:** Identify duplicate / redundant data across the MDS and Tasks databases once
the Submissions event log exists, so both (currently very heavy) databases can be slimmed.
**Method:** Every candidate field is classified A / B / C / D — see key. **Nothing is
deleted blindly**; some apparent duplicates are legitimate aggregates.

## Classification key

| Class | Meaning | Action |
|-------|---------|--------|
| **A — Redundant** | The event log now holds this truth | Safe to retire (or keep as cascade-written convenience) |
| **B — Reclassify** | Keep field, but stop hand-editing — cascade owns it | Governance change, not deletion |
| **C — Convert to rollup** | Duplicated across tiers; should be derived | Change from manual entry → rollup from MDS |
| **D — Keep as-is** | Looks duplicated but isn't (forward plan, or aggregate) | No change |

---

## MDS (Master Drawing Schedule)

| Field | Class | Notes |
|-------|-------|-------|
| `1st Issue Submitted` (checkbox) | A | = "an Issued S4 submission exists". Derivable from event log. |
| `2nd Issue Submitted` (checkbox) | A | = "an Issued S5 submission exists". |
| `Constr. Issue Submitted` (checkbox) | A | = "an Issued A4.5 submission exists". |
| `Model Submitted` (checkbox) | A | = "an Issued S3 submission exists". |
| `Drawing Status` (select) | B | Cascade drives it (DM Review → Client Review → Being Revised). Stop hand-editing. |
| `S3/S4/S5 Status` (select) | B | Cascade writes A/B/C via Log Status. |
| `Submission Stage` (select) | B | Cascade sets current S-stage. |
| `Rev` (select) | B | Cascade sets from filename. |
| `In Production` (checkbox) | B | Cascade sets at production hand-off. |
| `*_Submit Date (Actual)` etc. | B | Cascade writes (Actual) dates only. |
| `*(Plan)` / `*(Adj)` formulas | D | Forward programme dates — different purpose, KEEP. |
| Rollups (`Projects`,`Assigned To`,`Production Date`,`Install Date`) | D | Derive from Item relation, KEEP. |
| `Drawing Title 1/2/3` | D | Drawing metadata, not workflow. KEEP. |

---

## Tasks DB (the heavy one — 60+ props)

### The major duplication: submission dates at two granularities

| Tasks field | Duplicates MDS field | Class | Fix |
|-------------|---------------------|-------|-----|
| `1st Submission Date (Actual)` | `S4 Submit Date (Actual)` | C | Convert Task field → rollup (min or max) of MDS S4 dates |
| `2nd Submission Date (Actual)` | `S5 Submit Date (Actual)` | C | → rollup of MDS S5 dates |
| `Constr. Submission Date (Actual)` | `C01 Submit Date (Actual)` | C | → rollup of MDS C01 dates |
| `1st/2nd/Constr Submission (Plan)` | MDS `(Plan)` formulas | D | Package-level plan — keep, or rollup if you prefer one source |

> A Task can hold several drawings, so the Task date is an **aggregate** of its drawings'
> dates. Converting to a min/max rollup kills the hand-syncing while keeping the package view.

### Already-correct rollups (no action — these prove the pattern works)

`Drawing Status`, `Rev No.`, `Submittal Stage`, `Client Approved` (=S5 status),
`Contractor Approved` (=S4 status) are **already rollups** from the MDS via `Drawing No(s)`.
So writing to the MDS auto-updates the Task view. Class D — keep, no change.

### Ball In Court

| Field | Class | Notes |
|-------|-------|-------|
| `Ball In Court` (Tasks) | D | Package-level, 8 options. Keep. |
| `Ball In Court` (Submissions) | NEW | Per-event BIC, cascade-set each transition. Reuse same 8 options. |
| `BIC Since` (Submissions) | NEW | Date — enables "who do I chase, and how long has it sat". |
| `Ball In Court` (MDS) | OPTIONAL NEW | Per-drawing chase visibility, if wanted. |

### Candidate Task fields that are arguably drawing-level

| Field | Class | Notes |
|-------|-------|-------|
| `Drawing Ref` (text) | A? | Free-text dup of the `Drawing No(s)` relation. Review — likely retire. |
| `Rev No.` | D | Already a rollup. Keep. |
| `No Client Approval` (checkbox) | D | Package-level flag. Keep. |

### Keep firmly (NOT duplicated by Submissions)

Hours/timesheet fields (`Original Allocation`, `Est. Hours`, `Actual Hrs Spent`,
`Contract Hrs`, all the rollups to To Do/Timesheets), `DM Step`/`DM Phase`/`Item Status`
(the Task-level workflow your app drives), `Priority`, `Blocker`/`Blocked by`/`Blocking`,
all relations (`Related RFI`, `Finishes`, `Suppliers`, `Person`, `Variation`, etc.),
`Original Scope`, `Date of Instruction`. None of these are submission events. Class D.

---

## Recommended streamlining actions (summary)

1. **Retire** 4 MDS checkboxes (A) once cascade is live — or keep as cascade-written.
2. **Stop hand-editing** MDS status/date/select fields (B) — cascade owns them.
3. **Convert** 3 Task submission-date fields (C) to min/max rollups of MDS — biggest win,
   removes manual cross-tier syncing.
4. **Add** BIC + BIC Since to Submissions (and optionally MDS).
5. **Review** `Drawing Ref` free-text on Tasks for retirement.
6. **Keep** all (Plan)/(Adj) formulas, existing rollups, hours, relations.

Net: the MDS sheds ~4 manual checkboxes and stops needing manual status upkeep; the Tasks
DB stops needing manual submission-date entry on 3+ fields. Both get lighter to *maintain*
even where the column count barely drops.
