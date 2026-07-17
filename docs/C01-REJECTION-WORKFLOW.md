# Workflow: C01 (Construction) Drawing Revision Rejected by Contractor

Covers a drawing at the **A4.5** stage ("Authorised Mfg. & Constr. Design") on a
construction revision (letter prefix `C`, e.g. `C01`), from issue through to the
Contractor returning a **Rejected** grade and the corrected drawing being
resubmitted. Every Notion property and Make module named below is taken directly
from the current `drawing-flow.js` code and the live Make scenarios — nothing
here is aspirational.

Note on terminology: the codebase's `DT` relation/field is the generic "external
reviewing party" for whichever stage is active. At A4.5 that party is the
**Contractor** — `Ball In Court` literally uses the value `"Contractor"` at this
stage (code comment: "MC sign-off").

---

## 1. Precondition — drawing is issued to the Contractor

DM clicks **Issue** in the cockpit (`PATCH /api/df/submissions/:id/issue`), after
the submission has already gone through Approve and reached `Awaiting Issue`.

**Submission writes:**
- `Status` → `Issued`
- `DM Action` → `Approve`
- `Issued` → today
- `Ball In Court` → `Contractor`
- `BIC Since` → today

**MDS Drawing writes:**
- `Drawing Status` → `Production Updates` (A4.5's fixed mapping)
- `C01 Submit Date (Actual)` → today

**Make:** the `issue` action branch in *Axiom — 2. Actions Hub* (a Gmail send,
"Drawings Issued to Client") is defined but currently **dead code** — the
`/issue` endpoint stopped firing it (see its own comment: "fireWebhook removed —
DT email now batched via `POST /api/df/send-dt-emails`"). The issue notification
actually goes out later, batched with other actioned items, via the `dt-summary`
action branch when the DM clicks **Send DT Emails**.

At this point the Contractor has the drawing and Ball In Court sits with them.

---

## 2. Contractor rejects — DM logs the grade

The Contractor's decision doesn't flow back through any automation — the DM
manually reviews whatever the Contractor returned and records it in the cockpit.

DM clicks **Log Status**, grade = `Rejected`, on the Issued submission
(`PATCH /api/df/submissions/:id/log-status`). Valid grades for A4.5 are only
`Approved` / `Rejected` (`STAGE_LOG_STATUS_MAP`).

**Drawing Status decision** (same rule now shared by both apps — see below):
```
isTerminalAB    = stage === "AB"   && grade === "Approved"   → false
isA45Approved   = stage === "A4.5" && grade === "Approved"   → false (grade is Rejected)
isProductionRev = revision starts with "C"                   → true  (C01)
```
None of the terminal cases apply, so it falls through to `isProductionRev` →
**`Production Updates`**. (A Rejected C-revision still shows as "Production
Updates" on the Master Drawing Schedule, not e.g. "Rejected" — there's no
distinct MDS status for a rejected construction issue; the rejection itself only
shows up on the Submission record.)

**Submission writes:**
- `Status` → `Graded`
- `DM Action` → `Log Status`
- `Client Grade` → `Rejected`
- `Reviewed` → grade date
- `DT Notified` → `false` (queues it for the batch email)
- `Ball In Court` → `DM`
- `BIC Since` → grade date

**MDS Drawing writes:**
- `Drawing Status` → `Production Updates`
- `C01 Sign Off` date is **not** set — A4.5 only stamps that field when the
  grade is `Approved`.

No Make scenario fires at this step. It's a pure Notion write.

---

## 3. DM sends the grade notification

Separate, manual step: DM clicks **Send Grade Emails**
(`POST /api/df/send-grade-emails`). This batches *every* `Graded` +
`DT Notified=false` submission (not just this one), grouped by reviewing party.

For this drawing, the batch-build logic computes:
- `gradeReturnsPath` — the stage's `Grade Returns` Dropbox folder, derived from
  the submission's stored path (`.../A4.5/Grade Returns`)
- `action` text — since grade isn't `C` or `NA` and the revision is a
  production revision (`C01`): **"Update drawings for production"**
- `completionDate` — grade date + the project's Revision Days, skipping weekends

**Make — *Axiom — 2. Actions Hub*, `grade-summary` branch:**
1. `BasicFeeder` (43) — iterates the folder blocks in the payload
2. `TextAggregator` (44) — builds one HTML table body per folder/bucket
3. `sendAnEmail` (8) — one email per Contractor contact, subject
   `Grade Returns — {count} drawing(s) require action`, listing
   Drawing / Stage / Rev / Grade / Action / Complete By, plus a line naming the
   `Grade Returns` folder and the expected filename format
   (`{SuffixNo}_{DrawingNo}_{Rev}_{Grade}_{YYMMDD}.pdf`), and a closing
   instruction: "submit revised drawings to the Pending folder for DM review."

No Dropbox file movement happens in this branch — it's Gmail only. Placing the
Contractor's actual marked-up/rejected PDF into `Grade Returns` is a manual step
(there's no automated ingest for that folder, unlike Client Comments).

After sending, all included submissions get `DT Notified` → `true`.

---

## 4. Resubmission — corrected drawing comes back in

The email tells the Contractor to drop the corrected drawing into the stage's
`Pending` folder. Getting that back into Notion as a new QA round is meant to
go through:

**Make — *Axiom — 1. Ingest (Dropbox → Backend)*:** watches the whole
`Drawing Submissions` tree; any PDF landing under a `/Pending/` folder gets a
share link created and is POSTed to `POST /api/df/ingest`, which creates a new
Submission page (next QA round) for the DM to pick up in Submitted.

**⚠ This scenario is currently both inactive and flagged invalid in Make.**
That's expected for the *inactive* part — like the other ingest scenarios in
this system, it's meant to be triggered on demand (cockpit's **Scan Pending**
button → `POST /api/df/scan-pending` → Make API `scenarios/{id}/run`) rather
than polling continuously, to save Make credits. But `isinvalid: true` is a
separate, real problem: Make's validator is rejecting its current
configuration (the `watchFiles2` module has a stray `"undefined": "list"`
parameter, which looks like leftover cruft from an older module schema). Until
that's fixed, triggering Scan Pending will fail, meaning **the resubmission
step of this workflow won't actually complete right now.** I didn't fix this
since it wasn't part of what was asked — flag if you'd like it repaired.

Once ingested, the new Submission starts the QA cycle again from `Submitted`
with an incremented `QA Round`, heading back toward Approve → Issue for the
next revision (`C02`).

---

## Summary table

| Step | Trigger | Submission changes | MDS Drawing changes | Make scenario / branch |
|---|---|---|---|---|
| Issue to Contractor | DM clicks Issue | Status→Issued, Ball In Court→Contractor | Drawing Status→Production Updates | *(none directly — dt-summary batches the email later)* |
| Contractor rejects | DM clicks Log Status (grade=Rejected) | Status→Graded, Client Grade→Rejected, BIC→DM, DT Notified→false | Drawing Status→Production Updates | none |
| Notify Contractor | DM clicks Send Grade Emails | DT Notified→true | — | Actions Hub → `grade-summary` (Gmail only) |
| Resubmit corrected drawing | Contractor drops file in Pending | new Submission created | — | Ingest → `/api/df/ingest` *(currently broken — see §4)* |
