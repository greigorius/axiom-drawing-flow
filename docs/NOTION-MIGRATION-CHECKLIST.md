# Notion Migration Checklist — Axiom Drawing Flow

**How to use:** Each item is a single reviewable change to make manually in Notion. Action
them in order within each section. **Do the destructive items (deletes) LAST**, ideally
after the Submissions cascade is proven, so you're never mid-flight with half-migrated data.
Check the knock-on column before deleting — a saved view or formula may reference the field.

> Nothing here is executed automatically. This is your manual worklist.

Legend: ☐ = to do · ⚠ = has knock-on to check first · 🔴 = destructive (irreversible-ish)

---

## Section 1 — Renames (safe, do first)

| ☐ | Field | Database | Rename to | Why |
|---|-------|----------|-----------|-----|
| ☐ | `C01 Sign Off (Actual)` | MDS | `C01 Sign Off` | It's a discrete event, not a planned milestone with variance. Matches `S4/S5 Status Date`. |
| ☐ ⚠ | `1st Submission Date (Actual)` | Tasks | `S4 Submit Date (rollup)` | Will become a rollup (Section 3). Suffix shows it's derived. ⚠ check views/formulas referencing old name. |
| ☐ ⚠ | `2nd Submission Date (Actual)` | Tasks | `S5 Submit Date (rollup)` | As above. |
| ☐ ⚠ | `Constr. Submission Date (Actual)` | Tasks | `C01 Submit Date (rollup)` | As above. |

> Renaming in Notion preserves data and relations, but **formulas referencing the old name
> by text** break. Search your formulas for the old names before renaming.

---

## Section 2 — Type changes: formulas → plain dates (enables Scheduling Tool write-back)

The Scheduling Tool becomes the compute authority for projections and writes them back.
Each `(Plan)` / `(Adj)` field must change from `formula` to plain `date` so the tool can
write it via the API. **This deletes the formula logic** — make sure the Scheduling Tool
reproduces it before converting.

### MDS

| ☐ | Field | Current type | Change to |
|---|-------|-------------|-----------|
| ☐ 🔴 | `C01 Submit Date (Adj)` | formula | date |
| ☐ 🔴 | `C01 Updates (Adj)` | formula | date |
| ☐ 🔴 | `C01 Updates (Plan)` | formula | date |
| ☐ 🔴 | `S4 Submit Date (Adj)` | formula | date |
| ☐ 🔴 | `S4 Updates (Adj)` | formula | date |
| ☐ 🔴 | `S4 Updates (Plan)` | formula | date |
| ☐ 🔴 | `S4 Status Date (Adj)` | formula | date |
| ☐ 🔴 | `S4 Approval Period` | formula | (delete? — tool computes) |
| ☐ 🔴 | `S5 Submit Date (Adj)` | formula | date |
| ☐ 🔴 | `S5 Updates (Adj)` | formula | date |
| ☐ 🔴 | `S5 Updates (Plan)` | formula | date |
| ☐ 🔴 | `S5 Approval Period (F&P)` | formula | (delete? — tool computes) |
| ☐ 🔴 | `Schedule Production (Adj)` | formula | date |
| ☐ 🔴 | `Schedule Production (Plan)` | formula | date |

### Tasks (the (Plan)/(Adj) date families)

The Tasks DB has full Plan/Adj/Actual triplets for: `1st DT Start`, `1st DT Delivery`,
`2nd DT Start`, `2nd DT Delivery`, `Constr. DT Start`, `Constr. DT Delivery`, plus
`1st/2nd/Constr Submission Date`. The `(Adj)` ones are already plain dates in several cases —
**verify each** before changing. Convert any remaining `(Plan)`/`(Adj)` *formulas* to date.

| ☐ | Action |
|---|--------|
| ☐ ⚠ | Audit each `(Plan)`/`(Adj)` field's current type (formula vs date) — list which are already date |
| ☐ 🔴 | Convert the formula ones to plain date so the Scheduling Tool can write them |
| ☐ | Decide: does the tool write DT Start/Delivery projections too, or only submission dates? |

> ⚠ Sequencing: the Scheduling Tool must be writing a field BEFORE you strip its formula,
> or you'll have an empty column in between. Convert one family, confirm the tool fills it,
> then move to the next.

---

## Section 3 — Convert to rollups (kills manual cross-tier syncing)

| ☐ | Tasks field (renamed) | Becomes rollup of | Aggregation |
|---|----------------------|-------------------|-------------|
| ☐ | `S4 Submit Date (rollup)` | MDS `S4 Submit Date (Actual)` via `Drawing No(s)` | earliest or latest (pick) |
| ☐ | `S5 Submit Date (rollup)` | MDS `S5 Submit Date (Actual)` | earliest / latest |
| ☐ | `C01 Submit Date (rollup)` | MDS `C01 Submit Date (Actual)` | earliest / latest |

> Decide earliest vs latest per field: "when did the FIRST drawing in this package get
> submitted" (earliest) vs "are ALL drawings submitted" (latest). Likely latest for
> completion tracking.

---

## Section 4 — Deletions (destructive — do LAST, after cascade proven)

| ☐ | Field | Database | Knock-on to check |
|---|-------|----------|-------------------|
| ☐ 🔴 ⚠ | `1st Issue Submitted` | MDS | Re-point any view filtering on this → filter `S4 Submit Date is not empty` |
| ☐ 🔴 ⚠ | `2nd Issue Submitted` | MDS | → `S5 Submit Date is not empty` |
| ☐ 🔴 ⚠ | `Constr. Issue Submitted` | MDS | → `C01 Submit Date is not empty` |
| ☐ 🔴 ⚠ | `Model Submitted` | MDS | → `Model Submit Date is not empty` |
| ☐ 🔴 ⚠ | `Drawing Ref` (free text) | Tasks | Confirm `Drawing No(s)` relation covers all uses first |

> The principle: a populated date IS the boolean. Before deleting each checkbox, find every
> saved view / formula / rollup that references it and re-point to the date-not-empty test.

---

## Section 5 — Additions (the new layer)

| ☐ | Field | Database | Type | Notes |
|---|-------|----------|------|-------|
| ☐ | (new database) `Submissions` | — | — | Per the data model spec, section 5 |
| ☐ | (new database) `Inputs` | — | — | Per `INPUTS-ARCHITECTURE.md`. Holds all manual parameters. |
| ☐ | `Ball In Court` | Submissions | select | Same 8 options as Tasks BIC |
| ☐ | `BIC Since` | Submissions | date | Chase metric |
| ☐ | `Ball In Court` (optional) | MDS | select | Per-drawing chase visibility |
| ☐ | `S3 Status` (optional) | MDS | select | Only if you grade model submissions A/B/C |

---

## Section 6 — Migrate programme inputs into Inputs DB (data move)

Once the Inputs DB exists with its schema, any programme inputs (lead times, QA windows,
programme start dates) currently held on Tasks need to move into it. **This is a data
move, ideally scripted** (one-off Node script using the `app.js` Notion client pattern,
reading Tasks and writing Inputs rows).

| ☐ | From (Tasks field) | To (Inputs row) |
|---|--------------------|-----------------|
| ☐ | Any hand-entered programme inputs on Tasks | Inputs row → Programme |

> Hours fields (`Original Allocation`, `Contract Hrs`) are NOT moved here — Workflow 2
> handles them.

---

## Suggested order of operations

1. **Section 1 renames** (safe, reversible).
2. **Section 5 additions** (Submissions DB, Inputs DB, BIC fields) — non-destructive.
3. **Section 6 data move**: script any programme-input migration from Tasks into the Inputs
   DB. Build the input form alongside this.
4. Build & prove the **Drawing Flow cascade** against the new structure (Submissions
   → MDS writes).
5. Update the **Scheduling Tool to read from the Inputs DB**, then write projections back
   (Section 2). One field family at a time.
6. **Section 3 rollups** once cascade is writing MDS actuals reliably.
7. **Section 4 deletions** last, each with its knock-on re-pointed.
8. **Workflow 2 (commercial / hours)** — designed separately; any Task-field changes for
   hours wait for that pass.

> Principle: never without a working state. Actuals flow before projections are stripped;
> booleans aren't deleted until the dates that replace them are populating; hours stay on
> Tasks unchanged until Workflow 2.
