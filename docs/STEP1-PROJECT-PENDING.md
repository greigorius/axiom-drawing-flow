# Step 1: Project-level Pending folder and stage in the filename

**Date:** 2026-09-10
**Files changed:** `drawing-flow.js`, `AXIOM-DRAWING-FLOW.md`
**Make:** one route in *Axiom — 2. Actions Hub* (5993716) needs changing (see §4). *Axiom — 1. Ingest* (5993712) needs **no** change.

---

## 1. What changes

| | Before | After |
|---|---|---|
| Upload folder | `{Project}/{Stage}/Pending/` × 4 per project | `{Project}/Pending/` (one per project) |
| Filename | `{Item}_{DrawingNo}_{Rev}_{Initials}.pdf` | `{Item}_{Stage}_{Rev}_{DrawingNo}[_{Initials}].pdf` |
| Stage comes from | folder | filename |
| DT comes from | initials (required) | initials if present, otherwise the Item's **Person** (Tasks DB) |
| Approve moves to | `{Project}/{Stage}/Suffix NNN/{DrawingNo}.pdf` | `{Project}/Approved/{original filename}` |
| Bounce moves to | `{Project}/{Stage}/Rejected/R{n}/Suffix NNN/` (Make **deleted** the original) | `{Project}/Rejected/{original name}_R{n}.pdf` |
| Grade Returns | `{Project}/{Stage}/Grade Returns/` | `{Project}/Grade Returns/` |
| DWG uploads (flip to Awaiting Issue) | Suffix folder, stage from folder | `{Project}/Approved/`. Stage comes from the DWG filename if it follows the convention; otherwise every Approved/BIC=DT submission on the project flips |

Examples:
```
003_S4_P01_EIT-TMJ-AA-B2-D-I-45120.pdf
003_A4.5_C01_EIT-TMJ-AA-B2-D-I-45120_GF.pdf
→ bounced:  Rejected/003_S4_P01_EIT-TMJ-AA-B2-D-I-45120_R1.pdf
```

**Ingest now rejects, with a reason in the cockpit feed:** files not directly inside `{Project}/Pending/`, fewer than 4 or more than 5 sections, an unknown stage (e.g. `S6`), a non-digit item, a rev that isn't like `P01`/`C01`, a 5th section that isn't 2–4 letters, and old-style names dropped into the new Pending folder.

---

## 2. In-flight drawings (legacy)

Everything already in an old `{Project}/{Stage}/Pending/` folder still ingests, approves and bounces. Approve and bounce send those files to the new project-level `Approved/` and `Rejected/` folders. Files approved earlier into `{Stage}/Suffix NNN/` keep their stage-level Grade Returns. All legacy branches are marked `LEGACY` in `drawing-flow.js` and can be deleted once the old Pending folders are empty.

---

## 3. Dropbox setup per project

Create `Drawing Submissions/{Project}/Pending/` by hand. Make creates `Approved/`, `Rejected/` and `Grade Returns/` the first time it needs them.

---

## 4. Make: Actions Hub, Bounce route (required)

The Bounce route currently **deletes** the PDF from Pending. It expected the DT Checker to have already uploaded a marked-up copy. The cockpit Bounce button never sends one, so **today every cockpit bounce deletes the DT's file.** Change the route to move the file instead:

| Module | Field | From | To |
|---|---|---|---|
| **5** Dropbox: Create a Folder | Folder name | `Suffix {{1.dropboxMove.itemNo}}` | `{{1.dropboxMove.toFolderName}}` |
| | Path | `{{1.dropboxMove.rFolder}}` | `{{1.dropboxMove.toFolderParent}}` |
| **6** Dropbox: Delete a File | *replace the module with* **Dropbox: Move a File/Folder** | | Path `{{1.dropboxMove.from}}` · Destination `{{1.dropboxMove.toFolder}}` · New name `{{1.dropboxMove.newFilename}}` · Autorename **No**. Error handler: Break, retry 5 × 1 min (same as the Approve route's move) |
| 42 / 61 / 46 / 37 | | no change | shared link on `toFolder` → `{Project}/Rejected`, PATCH folder-link |

**Approve route:** no change. It already maps `toFolderParent`, `toFolderName`, `toFolder`, `newFilename` and `suffixFolderPath`, and the backend now fills those with the Approved folder values.

**Ingest scenario:** no change. The recursive watch on `Drawing Submissions` and the `/pending/` filter already match `{Project}/Pending/`. The DWG route filter (not `/pending/`, `.dwg`) still works for DWGs in `Approved/`.

---

## 5. Deploy order

1. `push-to-github.bat`. Netlify deploys the backend.
2. **Right away**, make the §4 Bounce route change. Don't bounce anything between steps 1 and 2.
3. Create `{Project}/Pending/` for active projects and tell DTs the new naming.

---

## 6. Test checklist

- [ ] Upload `003_S4_P01_{real drawing no}.pdf` to `{Project}/Pending/` → Scan Pending → card appears in For Review, stage S4, DT = the Item's Person.
- [ ] Same with `_GF` on the end → DT = Greig.
- [ ] Upload `003_S6_P01_x.pdf` → the cockpit feed shows "2nd section "S6" isn't a stage…".
- [ ] Approve → file lands in `{Project}/Approved/` with its name unchanged; Notion Dropbox Path updated; Folder Link written.
- [ ] Bounce → file lands in `{Project}/Rejected/…_R1.pdf` (**not deleted**); Folder Link written.
- [ ] Send DT Emails → folder header reads `24-367 / Approved` or `24-367 / Rejected`.
- [ ] Upload a DWG to `Approved/` → matching submission moves to Awaiting Issue.

---

## 7. Left for step 2 (approve and bounce review)

- `bounce-dest` and `annotatedPdf*` handling for the DT Checker are still in place and harmless. Remove them when the DT Checker is disconnected.
- The Comment Reviewer's `cr-ingest` still reads the stage from `/S4/` / `/S5/` / `/A4.5/` in the client-comment folder path.
- The bounce email wording assumes no marked-up PDF. Decide where DM comments live (Noteey, Miro, a DM Comments subfolder).
- Grade-reject Make route: Create Folder makes `Grade Returns/Grade Returns` (name + path both include it). Harmless, but untidy.
- Ingest runs 4× a day, 5 files per run.
