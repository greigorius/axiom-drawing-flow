# Inputs Architecture — Axiom Drawing Flow

**Status:** v1, build-ready
**Purpose:** Resolve the date/hours overload across MDS and Tasks by separating *inputs*
(manually-entered parameters) from *outputs* (actuals + projections). Inputs live in one
dedicated DB, edited through one form, read by two engines. The MDS and Tasks become
display-only for these values.

---

## 1. The three kinds of value

The current confusion comes from mixing three categorically different things in the same
columns. The architecture separates them:

| Kind | Definition | Source | Lives in |
|------|------------|--------|----------|
| **Input** | Manually-entered parameter (a seed) | You, via the form | **Inputs DB** (new) |
| **Actual** | What happened (an event) | Submissions log / Timesheets | Event databases; surfaced via rollup |
| **Projection** | What's forecast (computed) | Scheduling Tool | Written to MDS/Tasks for display |

Editing rule: **you only ever type into the Inputs form**. Everything else is either an
event you log (via Submissions/Timesheets) or a derivation you read.

---

## 2. The Inputs DB

One database, `NOTION_DB_INPUTS`. Narrow. Two row types distinguished by a `Scope` select.

### Common properties

| Property | Type | Notes |
|----------|------|-------|
| `Name` | Title | e.g. `24-367 — Project defaults` or `24-367-A — Joinery Pkg A` |
| `Scope` | Select | `Project` or `Task` |
| `Project` | Relation → Projects | Required on both row types |
| `Task` | Relation → Tasks | Required only on Task-scoped rows |

### Programme section (cycle parameters)

| Property | Type | Notes |
|----------|------|-------|
| `Programme Start` | Date | Start anchor for the schedule |
| `S3 Lead Time (days)` | Number | Model submission lead (working days) |
| `S4 Lead Time (days)` | Number | First-issue lead |
| `S4 QA Days` | Number | DM review window |
| `S4 Client Review Days` | Number | Time client has to grade |
| `S5 Lead Time (days)` | Number | Revision-issue lead |
| `S5 QA Days` | Number | |
| `S5 Client Review Days` | Number | |
| `C01 Lead Time (days)` | Number | Production-issue lead |
| `C01 Sign Off Days` | Number | |

> **Commercial inputs (Contract Hrs, Allocated Hours) are deliberately NOT in this DB.**
> Hours-tracking is its own workflow (commercial control loop — Workflow 2) with different
> ownership, lifecycle, and an over-allocation flag that drives variation handling. The
> Inputs DB for v1 is programme-only. Allocated and Contract Hrs stay on the Tasks DB
> until Workflow 2 designs their proper home.

### Override semantics

A **Project row** holds defaults. A **Task row** holds *only* the fields the Task overrides
— null elsewhere. Effective value resolution is: Task row's field if set, else Project
row's field, else (last resort) the Scheduling Tool's hard-coded default.

This rule keeps overrides honest. If a Project's default S4 Lead Time changes, every Task
that didn't override that field updates automatically. Tasks that *did* override see no
change — which is the correct behaviour, since the override was deliberate.

---

## 3. The Inputs form

Route in the Workflow Tracker app: `/inputs/:projectId` (Project scope) and
`/inputs/:projectId/:taskId` (Task scope).

### Single screen, two sections

```
┌───────────────────────────────────────────────────┐
│  24-367 — Joinery Pkg A      [Project] [Task ↓]   │
├───────────────────────────────────────────────────┤
│  ⏱  PROGRAMME                                      │
│                                                   │
│   Programme Start       [ 2026-02-10  ]           │
│   S4 Lead Time          [ 10        ] days        │
│   S4 QA Days            [ 3         ] days        │
│   S4 Client Review Days [ 10        ] days        │
│   S5 Lead Time          [  7        ] days        │
│   ...                                             │
│                                                   │
│              [ Save ]   [ Reset overrides ]       │
└───────────────────────────────────────────────────┘
```

> Commercial inputs get their own form in Workflow 2.

### Override visual fence

On a Task-scope screen:
- Each field's placeholder shows the inherited Project value, faint/italic.
- An untouched field stays null and inherits.
- Typing a value "activates" the override — field renders bold/active.
- A small `↩ inherit` link beside any overridden field clears it back to inherit.

This gives you instant visibility of *what's actually been customised* without having to
diff anything mentally.

### Validation

Numbers must be positive integers. Programme Start must be a date. Server-side validation
on save (the same `app.js` pattern as your existing `/property` route).

---

## 4. What the engines read

### Scheduling Tool

Reads all `Programme` fields, resolves Task vs Project precedence per Task, computes
projections, writes Plan/Adj dates back to MDS and Tasks (per `NOTION-MIGRATION-CHECKLIST.md`
Section 2).

### Hours-tracking (Workflow 2 — out of scope here)

Hours-tracking is its own commercial-control loop, designed separately. It reads from
Tasks/Timesheets/To Do, not from this Inputs DB. The boundary is firm: programme = here,
commercial = Workflow 2.

---

## 5. What migrates out of MDS / Tasks

Per the migration checklist, but to be specific:

### Migrate FROM Tasks → Inputs DB

| Tasks field | Becomes | In Inputs row |
|-------------|---------|---------------|
| `1st DT Start (Plan)`, `(Adj)` | Programme input → projection | computed by Scheduling Tool |
| All `(Plan)` / `(Adj)` date families | Programme inputs → projections | as above |

> Hours fields (`Original Allocation`, `Contract Hrs`, etc.) are **not** migrated here.
> Workflow 2 handles them separately.

### What stays on Tasks

Actuals (rollups from MDS/Submissions/Timesheets), workflow state (`DM Phase`,
`Item Status`, `Ball In Court`, `Priority`, `Blocker`), relations (`Drawing No(s)`,
`Related RFI`, etc.), descriptive metadata (`Item Name`, `Original Scope`, `Date of Instruction`),
**and all hours fields pending Workflow 2**.

### What stays on MDS

Actuals (the `(Actual)` dates, `Drawing Status`, S-stage statuses), descriptive metadata
(drawing titles, area, location), all relations and rollups.

---

## 6. Not in v1

- Migrating *existing* programme inputs from Tasks into the new Inputs DB (one-time data
  move to plan separately — likely a script).
- Bulk-edit / multi-task input changes (form is single-scope for v1).
- History/audit of input changes (Notion gives basic page history; defer richer audit).
- Hours and commercial parameters — see Workflow 2.
