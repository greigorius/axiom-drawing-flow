// Unit tests for the pure path/filename helpers in drawing-flow.js.  Run: node tests/parsing.test.js
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const src = fs.readFileSync(fs.existsSync(__dirname + "/drawing-flow.js") ? __dirname + "/drawing-flow.js" : __dirname + "/../drawing-flow.js", "utf8") +
  "\n;module.exports.__t = { parsePath, parseFilename, parseSubmissionName, computeDropboxMove, gradeReturnsFolder, toShortDropboxPath, locateProject, computeReviewedMove, computeGradeReturnMove, computeIssueMove, computeSignedOffMove, isGradeReturnName, parseClientCommentName, parseSubmissionTitle, padItemNo, itemNoFromTaskName };";
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
ok("grade returns new → 05_Client Comments (no subfolder)", () => assert.strictEqual(t.gradeReturnsFolder(`${P}/04_Issued/003_A4.5_C01_A-101.pdf`), full(`${P}/05_Client Comments`)));
ok("grade returns legacy", () => assert.strictEqual(t.gradeReturnsFolder(`${P}/A4.5/Suffix 003/A-101.pdf`), full(`${P}/A4.5/Grade Returns`)));
ok("grade return move A4.5 rejected", () => { const m = t.computeGradeReturnMove(`${P}/04_Issued/003_A4.5_C01_A-101.pdf`,
    { itemNo: "003", stage: "A4.5", revision: "C01", drawingNo: "A-101", grade: "Rejected", date: "2026-09-10" });
  assert.strictEqual(m.from, full(`${P}/04_Issued/003_A4.5_C01_A-101.pdf`));
  assert.strictEqual(m.toFolder, full(`${P}/05_Client Comments`));
  assert.strictEqual(m.toFolderParent, full(P)); assert.strictEqual(m.toFolderName, "05_Client Comments");
  assert.strictEqual(m.to, full(`${P}/05_Client Comments/003_A4.5_C01_A-101_Rejected_260910.pdf`)); });
ok("grade return legacy → {Stage}/Grade Returns", () => { const m = t.computeGradeReturnMove(`${P}/A4.5/Suffix 003/A-101.pdf`,
    { itemNo: "003", stage: "A4.5", revision: "C01", drawingNo: "A-101", grade: "Rejected", date: "2026-09-10" });
  assert.strictEqual(m.toFolderParent, full(`${P}/A4.5`)); assert.strictEqual(m.toFolderName, "Grade Returns"); });
ok("grade return move skipped when already returned", () => {
  const o = { itemNo: "003", stage: "A4.5", revision: "C01", drawingNo: "A-101", grade: "Rejected" };
  assert.strictEqual(t.computeGradeReturnMove(`${P}/05_Client Comments/003_A4.5_C01_A-101_Rejected_260910.pdf`, o), null);
  assert.strictEqual(t.computeGradeReturnMove(`${P}/A4.5/Grade Returns/x.pdf`, o), null); });
ok("grade-return filenames recognised (and client comments not)", () => {
  assert.ok(t.isGradeReturnName("003_A4.5_C01_EIT-TMJ-AA-B2-D-I-45120_Rejected_260910.pdf"));
  assert.ok(!t.isGradeReturnName("MC_260910_EIT-TMJ-AA-B2-D-I-45120_P01.pdf"));
  assert.ok(!t.isGradeReturnName("PC_260910_A-101_C01.pdf")); });
ok("signed off move 04_Issued → 06_Signed Off, name unchanged", () => { const m = t.computeSignedOffMove(`${P}/04_Issued/003_A4.5_C01_A-101_GF.pdf`);
  assert.strictEqual(m.to, full(`${P}/06_Signed Off/003_A4.5_C01_A-101_GF.pdf`));
  assert.strictEqual(m.toFolderParent, full(P)); assert.strictEqual(m.toFolderName, "06_Signed Off"); assert.strictEqual(m.newFilename, "003_A4.5_C01_A-101_GF.pdf"); });
ok("signed off move also from Ready For Issue / un-numbered Approved", () => {
  assert.strictEqual(t.computeSignedOffMove(`${P}/03_Ready For Issue/x.pdf`).to, full(`${P}/06_Signed Off/x.pdf`));
  assert.strictEqual(t.computeSignedOffMove(`${P}/Approved/x.pdf`).to, full(`${P}/06_Signed Off/x.pdf`)); });
ok("signed off leaves returned / signed-off / legacy copies alone", () => {
  assert.strictEqual(t.computeSignedOffMove(`${P}/05_Client Comments/003_A4.5_C01_A-101_Rejected_260910.pdf`), null);
  assert.strictEqual(t.computeSignedOffMove(`${P}/06_Signed Off/x.pdf`), null);
  assert.strictEqual(t.computeSignedOffMove(`${P}/A4.5/Approved/x.pdf`), null); });
ok("reviewed move project-level", () => { const m = t.computeReviewedMove(`${P}/05_Client Comments/MC_260910_A-101_P01.pdf`);
  assert.strictEqual(m.toFolderParent, full(`${P}/05_Client Comments`)); assert.strictEqual(m.toFolderName, "Reviewed");
  assert.strictEqual(m.to, full(`${P}/05_Client Comments/Reviewed/R_MC_260910_A-101_P01.pdf`)); });
ok("reviewed move legacy stage-level", () => assert.strictEqual(t.computeReviewedMove(`${P}/S4/Client Comments/MC_260910_A-101_P01.pdf`).to,
  full(`${P}/S4/Client Comments/Reviewed/R_MC_260910_A-101_P01.pdf`)));
ok("reviewed move skips already-reviewed", () => { assert.strictEqual(t.computeReviewedMove(`${P}/Client Comments/Reviewed/R_x.pdf`), null);
  assert.strictEqual(t.computeReviewedMove(`${P}/Client Comments/R_x.pdf`), null); });
// ---- Derivative items (Suffix 200 vs Suffix 200_1)
ok("derivative item in a filename", () => { const r = t.parseSubmissionName("200_1_S4_P01_EIT-TMJ-AA-B3-D-I-24217_GF");
  assert.strictEqual(r.ok, true); assert.strictEqual(r.itemNo, "200_1"); assert.strictEqual(r.stage, "S4");
  assert.strictEqual(r.revision, "P01"); assert.strictEqual(r.drawingNo, "EIT-TMJ-AA-B3-D-I-24217"); assert.strictEqual(r.dtInitials, "GF"); });
ok("plain item unaffected", () => assert.strictEqual(t.parseSubmissionName("200_S4_P01_A-101_GF").itemNo, "200"));
ok("item padding keeps the derivative", () => { assert.strictEqual(t.padItemNo("3"), "003");
  assert.strictEqual(t.padItemNo("3_1"), "003_1"); assert.strictEqual(t.padItemNo("200_1"), "200_1"); });
ok("item read off the task name, exactly", () => {
  assert.strictEqual(t.itemNoFromTaskName("Suffix 200 - LIN-804 Soft Cell Wall Panelling"), "200");
  assert.strictEqual(t.itemNoFromTaskName("Suffix 200_1 - LIN-804 … Lobby"), "200_1");
  assert.strictEqual(t.itemNoFromTaskName("Suffix 22 - Risers"), "022");
  assert.strictEqual(t.itemNoFromTaskName("001-24-354 Document Control (MW)"), null); });
ok("submission title round-trips a derivative item", () => {
  assert.deepStrictEqual({...t.parseSubmissionTitle("24-367-200_1_EIT-TMJ-AA-B3-D-I-24217_S4_R2", "S4")},
    { taskCode: "24-367-200_1", drawingNo: "EIT-TMJ-AA-B3-D-I-24217" });
  assert.deepStrictEqual({...t.parseSubmissionTitle("24-367-003_EIT-TMJ-AA-B2-D-I-45120_A4.5_R1", "A4.5")},
    { taskCode: "24-367-003", drawingNo: "EIT-TMJ-AA-B2-D-I-45120" }); });
ok("client comment for a derivative item", () => { const r = t.parseClientCommentName("260604_F&P_200_1_S4_P01_EIT-TMJ-AA-B3-D-I-24217");
  assert.strictEqual(r.itemNo, "200_1"); assert.strictEqual(r.stage, "S4"); assert.strictEqual(r.drawingNo, "EIT-TMJ-AA-B3-D-I-24217"); });

// ---- Stage aliases (DTs write A45 as often as A4.5)
ok("A45 filename ingests as A4.5", () => { const r = t.parseSubmissionName("200_A45_C01_EIT-TMJ-AA-B3-SK-I-45104_JC");
  assert.strictEqual(r.ok, true); assert.strictEqual(r.stage, "A4.5"); assert.strictEqual(r.revision, "C01"); assert.strictEqual(r.drawingNo, "EIT-TMJ-AA-B3-SK-I-45104"); });
ok("A4.5 and a4-5 still fine, S6 still rejected", () => {
  assert.strictEqual(t.parseSubmissionName("200_A4.5_C01_A-101_JC").stage, "A4.5");
  assert.strictEqual(t.parseSubmissionName("200_a4-5_C01_A-101_JC").stage, "A4.5");
  assert.strictEqual(t.parseSubmissionName("200_S6_C01_A-101_JC").ok, false); });
ok("A45 pending path parses", () => assert.strictEqual(t.parsePath(`${P}/01_Pending/200_A45_C01_A-101_JC.pdf`).projectNo, "24-367"));
ok("client comment with A45 stage", () => assert.strictEqual(t.parseClientCommentName("260604_PC_200_A45_C01_EIT-TMJ-AA-B3-D-I-24217").stage, "A4.5"));

// ---- PRD (production drawings, graded by the factory)
ok("PRD filename parses", () => assert.deepStrictEqual(pf("003_PRD_C01_EIT-TMJ-AA-B2-D-I-45120_GF.pdf"),
  { ok: true, format: "v2", itemNo: "003", stage: "PRD", revision: "C01", drawingNo: "EIT-TMJ-AA-B2-D-I-45120", dtInitials: "GF" }));
ok("PRD lower-case + derivative item", () => { const r = pf("200_1_prd_c01_A-101_GF.pdf");
  assert.strictEqual(r.stage, "PRD"); assert.strictEqual(r.itemNo, "200_1"); assert.strictEqual(r.revision, "C01"); });
ok("PRD has no aliases — PROD rejected", () => assert.strictEqual(t.parseSubmissionName("200_PROD_C01_A-101_JC").ok, false));
ok("PRD pending path parses", () => assert.strictEqual(t.parsePath(`${P}/01_Pending/200_PRD_C01_A-101_JC.pdf`).projectNo, "24-367"));
ok("PRD grade return → 05_Client Comments, named like A4.5", () => {
  const m = t.computeGradeReturnMove(`${P}/04_Issued/003_PRD_C01_A-101.pdf`,
    { itemNo: "003", stage: "PRD", revision: "C01", drawingNo: "A-101", grade: "Rejected", date: "2026-09-10" });
  assert.strictEqual(m.to, full(`${P}/05_Client Comments/003_PRD_C01_A-101_Rejected_260910.pdf`)); });
ok("PRD grade return name detected (so cr-ingest skips it)", () =>
  assert.ok(t.isGradeReturnName("003_PRD_C01_EIT-TMJ-AA-B2-D-I-45120_Rejected_260910.pdf")));
ok("PRD signed off → 06_Signed Off, name unchanged", () => {
  const m = t.computeSignedOffMove(`${P}/04_Issued/003_PRD_C01_A-101_GF.pdf`);
  assert.strictEqual(m.to, full(`${P}/06_Signed Off/003_PRD_C01_A-101_GF.pdf`)); });
ok("client comment with PRD stage parses (ingest rejects it later by stage)", () =>
  assert.strictEqual(t.parseClientCommentName("260604_PC_200_PRD_C01_EIT-TMJ-AA-B3-D-I-24217").stage, "PRD"));

// ---- Client comment names
ok("client comment: Greig's example", () => assert.deepStrictEqual({...t.parseClientCommentName("260604_F&P_200_S4_P01_EIT-TMJ-AA-B3-D-I-24217")},
  { ok: true, format: "current", date: "260604", commenter: "F&P", itemNo: "200", stage: "S4", revision: "P01", drawingNo: "EIT-TMJ-AA-B3-D-I-24217" }));
ok("client comment: rev left out", () => { const r = t.parseClientCommentName("260604_F&P_200_S5_EIT-TMJ-AA-B3-D-I-24217");
  assert.strictEqual(r.ok, true); assert.strictEqual(r.revision, null); assert.strictEqual(r.stage, "S5"); assert.strictEqual(r.drawingNo, "EIT-TMJ-AA-B3-D-I-24217"); });
ok("client comment: rev after drawing no / lower-case stage", () => { const r = t.parseClientCommentName("260604_PC_200_a4.5_EIT-TMJ-AA-B3-D-I-24217_C01");
  assert.strictEqual(r.stage, "A4.5"); assert.strictEqual(r.revision, "C01"); assert.strictEqual(r.drawingNo, "EIT-TMJ-AA-B3-D-I-24217"); });
ok("client comment: older {Client}_{YYMMDD}_{DrawingNo}_{Rev} still parses", () => { const r = t.parseClientCommentName("MC_260910_A-101_P02");
  assert.strictEqual(r.format, "older"); assert.strictEqual(r.commenter, "MC"); assert.strictEqual(r.drawingNo, "A-101"); assert.strictEqual(r.revision, "P02"); assert.strictEqual(r.stage, null); });
ok("client comment: bad names rejected with a reason", () => {
  assert.match(t.parseClientCommentName("260604_F&P_200_S6_P01_A-101").error, /isn't a stage/);
  assert.match(t.parseClientCommentName("260604_F&P_X1_S4_P01_A-101").error, /item number/);
  assert.match(t.parseClientCommentName("260604_F&P_200_S4_P01_A 101_extra").error, /drawing number/);
  assert.match(t.parseClientCommentName("comments from F&P").error, /should be/); });
ok("client comment names never look like C01 returns", () => assert.ok(!t.isGradeReturnName("260604_F&P_200_S4_P01_EIT-TMJ-AA-B3-D-I-24217.PDF")));
ok("short path roundtrip", () => assert.strictEqual(t.toShortDropboxPath(full(`${P}/03_Ready For Issue/x.pdf`)), `${P}/03_Ready For Issue/x.pdf`));
console.log(`\n${n} tests passed`);
