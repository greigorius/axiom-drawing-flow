// Production tab (public/lanes.js): which board a drawing is on, and which column.
// ps = the drawing's MDS Production Stage.
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../public/lanes.js");

const a45 = { stage: "A4.5", status: "Graded", clientGrade: "Approved", dtNotified: true };
const lane = (s, ps, opts) => L.productionLaneOf(s, ps || null, opts);

test("design until A4.5 or PRD is signed off and the DT told", () => {
  assert.equal(L.phaseOf({ stage: "S5", status: "Issued" }), "design");
  assert.equal(L.phaseOf({ stage: "A4.5", status: "Issued" }), "design");
  assert.equal(L.phaseOf({ ...a45, dtNotified: false }), "design", "Graded — Notify DT stays on the main board");
  assert.equal(L.phaseOf({ ...a45, clientGrade: "Rejected" }), "design", "a rejected A4.5 is design rework");
  assert.equal(L.phaseOf({ stage: "PRD", status: "Issued" }), "design", "PRDs go through the normal flow");
  assert.equal(L.phaseOf(a45), "production");
  assert.equal(L.laneOf(a45), "closed", "nothing owed by the DT on the design board");
});

test("A4.5 sign-off waits for the DM's decision, then follows Production Stage", () => {
  assert.equal(lane(a45), "signed-off");
  assert.equal(lane({ stage: "A4.5", status: "Schedule", clientGrade: "Approved" }), "signed-off", "old-flow sign-off");
  assert.equal(L.laneOf({ stage: "A4.5", status: "Schedule" }), "scheduled", "grade-less placeholder unchanged");
  assert.equal(lane(a45, "Awaiting Supply Drawings"), "awaiting-supply");
  assert.equal(lane(a45, "Awaiting Supply Drawings", { supplyDone: true }), "to-schedule", "moves on once supply drawings are signed off");
  assert.equal(lane(a45, "To Be Scheduled"), "to-schedule");
  assert.equal(lane(a45, "In Production"), "in-production");
  assert.equal(lane(a45, "Awaiting As Built"), "awaiting-as-built");
  assert.equal(L.phaseOf(a45, "Complete"), "done");
  assert.equal(lane(a45, "Complete"), null);
});

test("PRD signed off sits in production until Complete; no as-built", () => {
  const prd = { stage: "PRD", status: "Graded", clientGrade: "Approved", dtNotified: true };
  assert.equal(lane(prd), "in-production");
  assert.equal(L.laneOf(prd), "closed");
  assert.equal(lane(prd, "Complete"), null);
  assert.equal(L.phaseOf({ stage: "PRD", status: "Complete" }), "done", "old-flow PRD Complete");
});

test("as-built cycle; only AB Approved closes", () => {
  assert.equal(lane({ stage: "AB", status: "Submitted" }, "Awaiting As Built"), "ab-review");
  assert.equal(lane({ stage: "AB", status: "Issued" }, "Awaiting As Built"), "ab-review");
  assert.equal(lane({ stage: "AB", status: "Graded", clientGrade: "Rejected", dtNotified: true }, "Awaiting As Built"), "awaiting-as-built");
  assert.equal(lane({ stage: "AB", status: "Graded", clientGrade: "Approved", dtNotified: true }), null);
});

test("supply drawings: done when every PRD on the item is signed off", () => {
  const cur = [
    { id: "p1", stage: "PRD", status: "Graded", clientGrade: "Approved", dtNotified: true, taskIds: ["i1"], drawingIds: ["d1"] },
    { id: "p2", stage: "PRD", status: "Issued", taskIds: ["i1"], drawingIds: ["d2"] },
    { id: "p3", stage: "PRD", status: "Graded", clientGrade: "Approved", dtNotified: true, taskIds: ["i2"], drawingIds: ["d3"] },
  ];
  assert.equal(L.supplyDoneFor("i1", cur), false, "one still with the factory");
  assert.equal(L.supplyDoneFor("i2", cur), true);
  assert.equal(L.supplyDoneFor("i3", cur), false, "no supply drawings yet");
  assert.equal(L.supplyDoneFor("i1", cur, (s) => (s.id === "p2" ? "Complete" : null)), true, "a PRD marked Complete counts");
});

test("contract routes and install-only", () => {
  const a45 = { stage: "A4.5", status: "Graded", clientGrade: "Approved", dtNotified: true };
  assert.equal(L.productionLaneOf(a45, "Awaiting Install"), "awaiting-install");
  assert.deepEqual(L.ROUTE_MOVES["In-house"], ["Awaiting Supply Drawings", "To Be Scheduled"]);
  assert.deepEqual(L.ROUTE_MOVES["Supply Only"], ["Awaiting Supply Drawings", "To Be Scheduled"], "supply only can still need scheduling");
  assert.deepEqual(L.ROUTE_MOVES["Supply & Install"], ["In Production"], "no in-house factory");
  assert.deepEqual(L.ROUTE_MOVES["Install Only"], ["Awaiting Install"]);
  assert.equal(L.ROUTE_MOVES["Site Only"], undefined, "site drawings use Install Only");
  assert.ok(L.isOutsourced("Outsourced") && L.isOutsourced("By Supplier") && !L.isOutsourced("Andrew Isted"));
});
