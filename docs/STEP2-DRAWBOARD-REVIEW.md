# Step 2: Review in Drawboard, act in the Hub

**Date:** 2026-09-10 · builds on `STEP1-PROJECT-PENDING.md` (deploy both together)
**Files changed:** `drawing-flow.js`, `public/cockpit.jsx`, `AXIOM-DRAWING-FLOW.md`, `tests/*`
**Notion:** `Comment Paths` (text) added to the Submissions DB. Already done.
**Make:** Actions Hub needs 3 changes after deploy (§5). Ingest and Client Comment Ingest need none.

---

## 1. How it now works

### DT review (S3 / S4 / S5 / A4.5 / AB submissions)
1. The DT uploads `{Item}_{Stage}_{Rev}_{DrawingNo}.pdf` to `{Project}/Pending/`. The card appears under **Submitted**.
2. You open it in **Drawboard** straight from Dropbox and mark it up. **Press *Sync Document now*, then close it.**
3. In the Hub:
   - **Approve:** Make moves the PDF to `{Project}/Approved/` with its name unchanged.
   - **Bounce:** Make moves the marked-up PDF to `{Project}/Rejected/{name}_R{n}.pdf`.

   Either way, the folder link reaches the DT in the next *Send DT Email*.

### Client comments (S4 / S5)
1. Save the client's PDF to `{Project}/Client Comments/` as `{Client}_{YYMMDD}_{DrawingNo}_{Rev}.pdf`. The old `{Project}/{Stage}/Client Comments/` folders also still work.
2. **Scan Comments.** The card moves to **Review Client Comments**. The stage comes from the drawing's Issued submission, matched on Rev, so the folder doesn't need a stage. The file path is saved to the submission's `Comment Paths`.
3. Review it in Drawboard. Sync, then close.
4. **Grade** in the Hub (A / B / C / NA). Every logged comment PDF for that drawing moves to `Client Comments/Reviewed/R_{name}`. *Send DT Email* then points the DT at that Reviewed folder.

### C01 sign-off (A4.5)
**Grade** as Approved or Rejected.
- **Rejected:** the issued PDF moves from `Approved/` to `{Project}/Grade Returns/{Item}_{Stage}_{Rev}_{DrawingNo}_Rejected_{YYMMDD}.pdf`.
- **Approved:** the PDF stays in `Approved/` as the final record, as before.

---

## 2. Backend changes

| Area | Change |
|---|---|
| Bounce | DT Checker annotated-PDF upload, base64 fallback, `/bounce-dest` and the Miro link lookup **removed**. Bounce always moves the file sitting in Pending, which is the Drawboard-marked copy. |
| Approve / Bounce | Both now refuse anything that isn't `Submitted` (409), so a double-click can't send a second move for a file that's already gone. The new Dropbox Path is written in the same Notion call as the status. It used to be a separate call that nothing waited for, which Netlify can drop. |
| Ingest | Drawboard saves change the file in Pending, so Make picks it up again. The duplicate guard skips it **without** a feed entry while it's still Submitted. |
| Ingest | If the same Rev turns up again for a drawing+stage, the file is still created and the feed adds `⚠ same Rev as QA R1 (Approved) — … may be a Drawboard re-sync`. |
| Ingest | Dropbox/Drawboard copies (`… (1).pdf`, `… (conflicted copy).pdf`) and drawing numbers with spaces are rejected with a clear message. |
| cr-ingest | Stage now comes from the Issued submission (the legacy stage folder still wins if present), no longer from a folder default of S4. The path is stored in `Comment Paths`. `Reviewed/` and `R_` files are ignored. A line is added to the feed. |
| Log Status | The *"grade it in the Comment Reviewer"* block is **removed**. One `move-files` webhook moves client comments to `Reviewed/R_…` and, for A4.5 Rejected, the C01 PDF to Grade Returns. Paths in Notion are updated in the same write. Grading the same drawing again doesn't move anything twice. |
| Grade emails | Files are grouped by where they now are: S4/S5 → `…/Client Comments/Reviewed` (R_ files), A4.5 Rejected → `…/Grade Returns` (new naming), otherwise "No return file". Action text for A4.5 is fixed: *Rejected → revise and resubmit*, *Approved → proceed with production*. |
| DT email | The bounce instruction now says the marked-up drawings are in the Rejected link. |

**Kanban (`cockpit.jsx`):** Review Client Comments cards now show **Grade** instead of the disabled "Review in Comment Reviewer" button. The Bounce dialog talks about Drawboard rather than Miro and carries a sync reminder. The Grade dialog explains which files will move. The Submitted column subtitle reads *"Review in Drawboard · sync before Approve / Bounce"*.

---

## 3. The Drawboard rule

Drawboard syncs on a timer unless you press **Sync Document now**. If you act before it syncs:
- Make moves the **un-marked** version.
- A late sync may **recreate the file in Pending**. It would come in as a new submission, which the same-Rev warning flags. Delete the stray file and its Notion row.

**Always: Sync now, close the document, then Approve / Bounce / Grade.**

---

## 4. Deploy order (steps 1 + 2 together)

1. `push-to-github.bat`. Netlify deploys.
2. Tell me it's live and I'll apply §5 to the Actions Hub straight away. Or do it by hand from §5. **Don't bounce or grade anything until this is done.**
3. Create `{Project}/Pending/` and `{Project}/Client Comments/` in active projects.
4. Check `MAKE_CR_INGEST_WEBHOOK` in Netlify points at Scenario 3's hook. That scenario has never run, so Scan Comments may not currently reach it.

---

## 5. Make: Actions Hub (5993716)

**a. Bounce route.** Stop deleting, start moving (carried over from step 1):
- Module 5, Create Folder: name `{{1.dropboxMove.toFolderName}}`, path `{{1.dropboxMove.toFolderParent}}`
- Module 6, Delete a File: **replace** with Move a File/Folder. Path `{{1.dropboxMove.from}}`, destination `{{1.dropboxMove.toFolder}}`, new name `{{1.dropboxMove.newFilename}}`, autorename No. Error handler: Break, retry 5 × 1 min.

**b. New route `move-files`.** Filter `{{1.action}}` = `move-files`:
Iterator over `{{1.moves}}` → Create Folder (name `{{it.toFolderName}}`, path `{{it.toFolderParent}}`, error handler Resume) → Move a File/Folder (path `{{it.from}}`, destination `{{it.toFolder}}`, new name `{{it.newFilename}}`, autorename No, error handler Break retry).

**c. Grade Summary route, Gmail module 8.** Replace the intro paragraph that mentions Grade Returns and `{SuffixNo}_…` with something general, e.g. *"The following drawings have been graded. Each group shows the folder the returned files are in and how they're named."* The backend now supplies the folder and naming notes inside each block.

The `grade-reject`, `cr-upload` and `issue` routes are no longer triggered. They're harmless, and can be deleted once you've tested.

---

## 6. Test checklist

- [ ] Mark up a Pending PDF in Drawboard → sync → the feed shows **no** duplicate entry after the next ingest run.
- [ ] Bounce → the marked-up file lands in `Rejected/…_R1.pdf` with markup visible, **not deleted**. A second click on Bounce is refused.
- [ ] Approve → the file lands in `Approved/` with its name unchanged.
- [ ] Drop `MC_260910_{DrawingNo}_P01.pdf` in `{Project}/Client Comments/` → Scan Comments → the card moves to Review Client Comments, and `Comment Paths` is filled on the submission.
- [ ] Review in Drawboard → Grade **B** → the file moves to `Client Comments/Reviewed/R_MC_…pdf`, and the card moves to Graded.
- [ ] Send DT Email (grades) → the block heading reads `24-367/Client Comments/Reviewed`.
- [ ] A4.5 → Grade **Rejected** → the file moves to `Grade Returns/003_A4.5_C01_…_Rejected_YYMMDD.pdf`.
- [ ] Rename a file `… (1).pdf` in Pending → the feed shows "Looks like a duplicate copy".
