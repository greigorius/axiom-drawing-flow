// Unit tests for the pure path/filename helpers in drawing-flow.js.  Run: node tests/parsing.test.js
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const src = fs.readFileSync(fs.existsSync(__dirname + "/drawing-flow.js") ? __dirname + "/drawing-flow.js" : __dirname + "/../drawing-flow.js", "utf8") +
  "\n;module.exports.__t = { parsePath, parseFilename, parseSubmissionName, computeDropboxMove, gradeReturnsFolder, toShortDropboxPath, locateProject, computeReviewedMove, computeGradeReturnMove, computeIssueMove };";
const mod = { exports: {} };
vm.runInNewContext(src, { module: mod, exports: mod.exports, require: (n) => n === "@netlify/blobs" ? { getStore(){} } : require(n), process, console, Date });
const t = mod.exports.__t;
const R = "/DESIGN KNOW HOW/TMJ Interiors/Drawing Submissions";
let n = 0; const ok = (name, fn) => { fn(); n++; console.log("✓", name); };

// ---- parsePath
ok("new layout path", () => assert.deepStrictEqual({...t.parsePath(`${R}/24-367/Pending/003_S4_P01_A-101_GF.pdf`)},
  { projectNo: "24-367", folderStage: null, filename: "003_S4_P01_A-101_GF.pdf", layout: "project" }));
ok("legacy layout path", () => assert.deepStrictEqual({...t.parsePath(`${R}/24-367/S4/Pending/003_A-101_P01_GF.pdf`)},
  { projectNo: "24-367", folderStage: "S4", filename: "003_A-101_P01_GF.pdf", layout: "legacy" }));
ok("lowercase path", () => assert.strictEqual(t.parsePath(`${R.toLowerCase()}/24-367/pending/x.pdf`).projectNo, "24-367"));
ok("nested subfolder in Pending rejected", () => assert.strictEqual(t.parsePath(`${R}/24-367/Pending/sub/x.pdf`), null));
ok("Pending not under Drawing Submissions rejected", () => assert.strictEqual(t.parsePath(`/Other/24-367/Pending/x.pdf`), null));
ok("Pending under Approved rejected", () => assert.strictEqual(t.parsePath(`${R}/24-367/Approved/Pending/x.pdf`), null));

// ---- parseFilename
const pf = (f) => ({ ...t.parseFilename(f) });
ok("v2 basic", () => assert.deepStrictEqual(pf("003_S4_P01_EIT-TMJ-AA-B2-D-I-45120_GF.pdf"),
  { ok: true, format: "v2", itemNo: "003", stage: "S4", revision: "P01", drawingNo: "EIT-TMJ-AA-B2-D-I-45120", dtInitials: "GF" }));
ok("v2 initials lower-case normalised", () => assert.strictEqual(pf("003_S4_P01_A-101_gf.pdf").dtInitials, "GF"));
ok("v2 missing initials rejected", () => assert.match(pf("003_S4_P01_A-101.pdf").error, /initials missing/));
ok("v2 A4.5 stage + upper PDF ext", () => { const r = pf("112_a4.5_c01_A-101_GF.PDF"); assert.strictEqual(r.stage, "A4.5"); assert.strictEqual(r.revision, "C01"); });
ok("v2 AB stage", () => assert.strictEqual(pf("001_AB_C02_A-1_AI.pdf").stage, "AB"));
ok("v2 too few", () => assert.strictEqual(pf("003_S4_P01.pdf").ok, false));
ok("v2 too many underscores", () => assert.match(pf("003_S4_P01_A_101_GF.pdf").error, /Too many/));
ok("v2 bad rev", () => assert.match(pf("003_S4_A-101_P01_GF.pdf").error, /Rev/));
ok("v2 bad item", () => assert.match(pf("X03_S4_P01_A-101_GF.pdf").error, /Item/));
ok("v2 bad initials", () => assert.match(pf("003_S4_P01_A-101_G1.pdf").error, /initials/));
ok("drawing no with spaces", () => assert.match(pf("003_S4_P01_A 101_GF.pdf").error, /Drawing number/));
ok("Dropbox conflicted copy", () => assert.match(pf("003_S4_P01_A-101 (Greig's conflicted copy 2026-09-10).pdf").error, /duplicate copy/));
ok("(1) copy", () => assert.match(pf("003_S4_P01_A-101_GF (1).pdf").error, /duplicate copy/));
ok("double underscore", () => assert.strictEqual(pf("003__S4_P01_A-101_GF.pdf").ok, false));
ok("not pdf", () => assert.strictEqual(pf("003_S4_P01_A-101_GF.dwg").ok, false));
ok("unknown stage", () => assert.match(pf("003_S6_P01_A-101_GF.pdf").error, /isn't a stage/));
ok("legacy name", () => assert.deepStrictEqual(pf("003_A-101_P01_GF.pdf"),
  { ok: true, format: "legacy", itemNo: "003", stage: null, revision: "P01", drawingNo: "A-101", dtInitials: "GF" }));
ok("dwg name without initials allowed when not required", () => assert.strictEqual(t.parseSubmissionName("003_S5_P02_A-101", { requireInitials: false }).stage, "S5"));

// ---- computeDropboxMove
const P = "Drawing Submissions/24-367";
const full = (p) => `/DESIGN KNOW HOW/TMJ Interiors/${p}`;
ok("approve new", () => { const m = t.computeDropboxMove(`${P}/Pending/003_S4_P01_A-101_GF.pdf`, "approve");
  assert.strictEqual(m.from, full(`${P}/Pending/003_S4_P01_A-101_GF.pdf`));
  assert.strictEqual(m.toFolder, full(`${P}/03_Ready For Issue`));
  assert.strictEqual(m.toFolderParent, full(P)); assert.strictEqual(m.toFolderName, "03_Ready For Issue");
  assert.strictEqual(m.newFilename, "003_S4_P01_A-101_GF.pdf"); assert.strictEqual(m.to, full(`${P}/03_Ready For Issue/003_S4_P01_A-101_GF.pdf`));
  assert.strictEqual(m.itemNo, "003"); assert.strictEqual(m.drawingNo, "A-101"); assert.strictEqual(m.stage, "S4"); });
ok("bounce new", () => { const m = t.computeDropboxMove(`${P}/Pending/003_A4.5_C01_A-101_GF.pdf`, "bounce", 2);
  assert.strictEqual(m.toFolder, full(`${P}/02_Rejected`)); assert.strictEqual(m.toFolderName, "02_Rejected");
  assert.strictEqual(m.newFilename, "003_A4.5_C01_A-101_GF_R2.pdf"); assert.strictEqual(m.to, full(`${P}/02_Rejected/003_A4.5_C01_A-101_GF_R2.pdf`));
  assert.strictEqual(m.stage, "A4.5"); assert.strictEqual(m.drawingNo, "A-101"); });
ok("bounce default round 1", () => assert.strictEqual(t.computeDropboxMove(`${P}/Pending/003_S4_P01_A-101_GF.pdf`, "bounce").newFilename, "003_S4_P01_A-101_GF_R1.pdf"));
ok("move still parses a pre-change 4-section name", () => assert.strictEqual(t.computeDropboxMove(`${P}/Pending/003_S4_P01_A-101.pdf`, "approve").drawingNo, "A-101"));
ok("approve legacy in-flight → project Approved", () => { const m = t.computeDropboxMove(`${P}/S4/Pending/003_A-101_P01_GF.pdf`, "approve");
  assert.strictEqual(m.toFolder, full(`${P}/03_Ready For Issue`)); assert.strictEqual(m.newFilename, "003_A-101_P01_GF.pdf");
  assert.strictEqual(m.drawingNo, "A-101"); assert.strictEqual(m.stage, "S4"); });
ok("bounce legacy in-flight → project 02_Rejected", () => assert.strictEqual(
  t.computeDropboxMove(`${P}/S5/Pending/003_A-101_P01_GF.pdf`, "bounce", 3).to, full(`${P}/02_Rejected/003_A-101_P01_GF_R3.pdf`)));
ok("full path input accepted", () => assert.ok(t.computeDropboxMove(full(`${P}/Pending/003_S4_P01_A-101.pdf`), "approve")));
ok("not in Pending → null", () => assert.strictEqual(t.computeDropboxMove(`${P}/03_Ready For Issue/003_S4_P01_A-101.pdf`, "approve"), null));
ok("numbered 01_Pending path parsed", () => assert.deepStrictEqual({...t.parsePath(`${R}/24-367/01_Pending/003_S4_P01_A-101_GF.pdf`)},
  { projectNo: "24-367", folderStage: null, filename: "003_S4_P01_A-101_GF.pdf", layout: "project" }));
ok("approve from 01_Pending → 03_Ready For Issue", () => assert.strictEqual(
  t.computeDropboxMove(`${P}/01_Pending/003_S4_P01_A-101_GF.pdf`, "approve").to, full(`${P}/03_Ready For Issue/003_S4_P01_A-101_GF.pdf`)));
ok("issue move Ready For Issue → 04_Issued", () => { const m = t.computeIssueMove(`${P}/03_Ready For Issue/003_S4_P01_A-101_GF.pdf`);
  assert.strictEqual(m.to, full(`${P}/04_Issued/003_S4_P01_A-101_GF.pdf`)); assert.strictEqual(m.toFolderName, "04_Issued"); assert.strictEqual(m.toFolderParent, full(P)); });
ok("issue move from this morning's un-numbered Approved folder", () => assert.strictEqual(
  t.computeIssueMove(`${P}/Approved/003_S4_P01_A-101_GF.pdf`).to, full(`${P}/04_Issued/003_S4_P01_A-101_GF.pdf`)));
ok("issue leaves legacy Suffix copies alone", () => assert.strictEqual(t.computeIssueMove(`${P}/S4/Suffix 003/A-101.pdf`), null));
ok("null path → null", () => assert.strictEqual(t.computeDropboxMove(null, "approve"), null));

// ---- Grade Returns / Reviewed
ok("grade returns new → 05_Client Comments/Grade Returns", () => assert.strictEqual(t.gradeReturnsFolder(`${P}/04_Issued/003_A4.5_C01_A-101.pdf`), full(`${P}/05_Client Comments/Grade Returns`)));
ok("grade returns legacy", () => assert.strictEqual(t.gradeReturnsFolder(`${P}/A4.5/Suffix 003/A-101.pdf`), full(`${P}/A4.5/Grade Returns`)));
ok("grade return move A4.5 rejected", () => { const m = t.computeGradeReturnMove(`${P}/04_Issued/003_A4.5_C01_A-101.pdf`,
    { itemNo: "003", stage: "A4.5", revision: "C01", drawingNo: "A-101", grade: "Rejected", date: "2026-09-10" });
  assert.strictEqual(m.from, full(`${P}/04_Issued/003_A4.5_C01_A-101.pdf`));
  assert.strictEqual(m.toFolderParent, full(`${P}/05_Client Comments`)); assert.strictEqual(m.toFolderName, "Grade Returns");
  assert.strictEqual(m.newFilename, "003_A4.5_C01_A-101_Rejected_260910.pdf"); });
ok("grade return move skipped when already returned", () => assert.strictEqual(t.computeGradeReturnMove(`${P}/05_Client Comments/Grade Returns/x.pdf`,
    { itemNo: "003", stage: "A4.5", revision: "C01", drawingNo: "A-101", grade: "Rejected" }), null));
ok("reviewed move project-level", () => { const m = t.computeReviewedMove(`${P}/05_Client Comments/MC_260910_A-101_P01.pdf`);
  assert.strictEqual(m.toFolderParent, full(`${P}/05_Client Comments`)); assert.strictEqual(m.toFolderName, "Reviewed");
  assert.strictEqual(m.to, full(`${P}/05_Client Comments/Reviewed/R_MC_260910_A-101_P01.pdf`)); });
ok("reviewed move legacy stage-level", () => assert.strictEqual(t.computeReviewedMove(`${P}/S4/Client Comments/MC_260910_A-101_P01.pdf`).to,
  full(`${P}/S4/Client Comments/Reviewed/R_MC_260910_A-101_P01.pdf`)));
ok("reviewed move skips already-reviewed", () => { assert.strictEqual(t.computeReviewedMove(`${P}/Client Comments/Reviewed/R_x.pdf`), null);
  assert.strictEqual(t.computeReviewedMove(`${P}/Client Comments/R_x.pdf`), null); });
ok("short path roundtrip", () => assert.strictEqual(t.toShortDropboxPath(full(`${P}/03_Ready For Issue/x.pdf`)), `${P}/03_Ready For Issue/x.pdf`));
console.log(`\n${n} tests passed`);
