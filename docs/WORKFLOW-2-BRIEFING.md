# Workflow 2 — Commercial Control Loop (Briefing)

**Status:** Briefing only. Captures what's known to date so it isn't lost. Full design
deferred to a dedicated pass.

**Scope boundary:** Anything to do with hours, contract budget, allocation, time-spent
tracking, and variation triggering. Distinct from Workflow 1 (Drawing Flow / submissions),
which is design-management.

---

## The three-layer commercial model

| Layer | What it is | Who sets it | Lifecycle |
|-------|------------|-------------|-----------|
| **Contract Hrs** | Total hours sold to the customer / their end client, broken down by package or cost line, with a Project rollup | DM or customer at contract sign | Fixed (guardrail) |
| **Allocated Hours** | DM's distribution of contract budget per Task — the working budget | DM at Task scope | Set once, rare adjusts |
| **Estimated / Actual** | Live picture: To Do estimates what's left; Timesheets log what's spent | Automatic (rollups) | Live |

## The core business rule

**Actual > Allocated = variation territory.** Going over the allocation isn't a budget
overrun to be absorbed — it's a *scope event* that should be flagged and converted into a
chargeable Variation. This is what makes hours-tracking active, not passive.

## Confirmed design decisions

- **Contract Hrs is per package / cost-line with a Project rollup**, not a single Project
  figure. The contract is structurally a small breakdown table, not one number. This
  raises the open question (Workflow 2) of how Tasks relate to cost lines — 1:1 or N:1.
- **Start with the passive flag, add active behaviour later.** v1 of Workflow 2 surfaces
  `Over Allocation?` as a derived flag on Tasks views. Later iterations can fire
  notifications or auto-draft Variation records when the threshold is crossed.

## Data sources Workflow 2 will touch

- **Tasks DB** — holds Allocated Hours (where it currently lives, undisturbed by Workflow 1).
- **Timesheets DB** (`197210e4...`) — actual time spent, rolled up to Tasks.
- **To Do DB** (`fc05f861...`) — estimated remaining, rolled up to Tasks.
- **Variations DB** — destination for over-allocation events that get raised as variations.
- A possible new **Cost Lines DB** (or contract-breakdown table) — TBD, depends on
  Tasks↔cost-line relationship.

## Likely derived Task fields (TBD)

- `Over Allocation?` (formula or derived: Actual > Allocated)
- `Overrun Hrs` (Actual − Allocated, when positive)
- `% Used` (Actual / Allocated)
- `Variance to Contract` (sum of Allocated across Tasks vs Contract Hrs at package level)

## Open questions for the Workflow 2 design pass

1. **Tasks ↔ cost lines** — 1:1, N:1, or something else? Determines whether cost lines
   need their own DB.
2. **Cost line structure** — package-based, trade-based, phase-based, or mixed?
3. **Where the Over Allocation flag is shown** — Tasks view filter? Dashboard widget?
   Inputs form? All?
4. **Estimated vs Allocated** — should Estimated also be flagged when it exceeds
   Allocated (a leading indicator of overrun)?
5. **The active layer (later)** — when crossing the threshold, what fires? A To Do
   landing in the DM's queue? An auto-drafted Variation record? A Gmail?
6. **How variations close the loop** — when a Variation is raised and approved, does it
   *increase* the Allocated for the Task, or stay as a separate budget line?

## Not part of Workflow 2

- Submission tracking, drawing review, S-stage gating — that's Workflow 1.
- General timesheet entry workflow — that's an existing thing.
- Invoice generation — out of scope.
