// lanes.js — the single definition of the eight submission lanes.
//
// Lives in public/ so that ONE implementation serves both surfaces: the Netlify function
// bundle picks it up through require("./public/lanes.js"), and the browser loads it from
// /lanes.js (publish = "public" in netlify.toml, so only this directory is served).
// Before this file the lane rules existed only as client-side state buckets in cockpit.jsx;
// re-implementing them for the summary endpoint would have left two copies to drift apart
// the first time a lane changed.
//
// The important thing this module knows, and a naive count does not: Submissions is an
// EVENT LOG, not a state table. One row per submission attempt, so a drawing bounced three
// times has three Rejected rows. Counting rows gives "Resubmission — With DT 30" for 24-354-003
// where the truthful figure is 13, and 8 for 24-354-190 where every one has been superseded
// and the answer is 0. latestPerDrawing() is what makes the counts mean "where things stand".

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DFLanes = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Board order — the order badges read in, left to right. Resubmission first: on a summary
  // card the thing that needs chasing should be the first thing seen.
  var LANES = [
    { id: "resubmission",      title: "Resubmission — With DT",          short: "With DT",           accent: "danger" },
    { id: "submitted",         title: "Submitted — Awaiting Review",     short: "Submitted",         accent: "info"   },
    { id: "reviewed",          title: "Reviewed — Notify DT",            short: "Notify DT",         accent: "ok"     },
    { id: "approved",          title: "Approved — Awaiting Issue",       short: "Awaiting Issue",    accent: "ok"     },
    { id: "awaiting-comments", title: "Issued — Awaiting Comments",      short: "Awaiting Comments", accent: "info"   },
    { id: "comments",          title: "Issued — Review Client Comments", short: "Review Comments",   accent: "grade"  },
    { id: "signoff",           title: "Issued — Awaiting Sign-Off",      short: "Awaiting Sign-Off", accent: "warn"   },
    { id: "graded",            title: "Graded — Notify DT",              short: "Graded (notify)",   accent: "grade"  },
    // Orthogonal to the pipeline: a drawing can be blocked at any stage. It sits at the end
    // of the active lanes rather than among them, because the board reads left to right as
    // the flow and parked work is not part of that flow — but it stays visible, since a
    // blocked drawing is the one most easily forgotten.
    { id: "blocked",           title: "Blocked — Awaiting Info",         short: "Blocked",           accent: "warn"   },
    // Terminal. Never appears on the cockpit board. Reaching it takes more than a grade
    // that asks for no new revision: an NA at S5 signs off S5 and hands the DT the A4.5
    // set, and even a PRD sign-off leaves the as-built to draw — all still DT work. Only
    // an outcome that ends the drawing's journey closes (see isFinal). This lane is the
    // whole point of the client card: "these are signed off".
    { id: "closed",            title: "Graded — Signed Off",             short: "Signed Off",        accent: "ok"     },
    // Placeholder rows created ahead of a real submission. Counted separately so they are
    // never mistaken for work in flight.
    { id: "scheduled",         title: "Scheduled",                       short: "Scheduled",         accent: "muted"  },
  ];

  var LANE_ORDER = LANES.map(function (l) { return l.id; });
  var LANE_TITLE = LANES.reduce(function (m, l) { m[l.id] = l.title; return m; }, {});
  // `short` is the spreadsheet column head. `title` is the badge label — "Issued — Review
  // Client Comments" is right on a pill and unusable as a column header.
  var LANE_SHORT = LANES.reduce(function (m, l) { m[l.id] = l.short || l.title; return m; }, {});

  // A drawing climbs these in order. Rank decides which of its submissions is "current":
  // a drawing graded at S4 and resubmitted at A4.5 is at A4.5, not still graded at S4.
  var STAGE_RANK = { S2: 1, S3: 2, S4: 3, S5: 4, "A4.5": 5, PRD: 6, AB: 7 };
  function stageRank(stage) { return STAGE_RANK[stage] || 0; }

  // Grades that hand the drawing back to the DT for a new revision. A and NA ask for
  // nothing further, so they close. "Rejected" is the A4.5/PRD outcome (contractor or
  // factory said no); "QA Rejected" is the client's document controller bouncing the
  // paperwork. Both mean the DT owes a new submission, exactly like a QA bounce does.
  // "Revise" is the sketch flow's own outcome (S3 and any -SK- drawing), the counterpart
  // to "No Action" — it asks for an updated sketch, so it belongs here with the rest.
  var REVISION_GRADES = { "B": 1, "C": 1, "Rejected": 1, "QA Rejected": 1, "Revise": 1 };
  function needsRevision(grade) { return !!REVISION_GRADES[grade]; }

  // Asking for no new revision is not the same as being finished. A drawing climbs the
  // stages, and a clean grade below the top hands it FORWARD rather than ending it:
  // S4 A/NA means the DT now owes the S5 set and S5 A/NA the A4.5 set. All of that is DT
  // work, so it belongs on the board. Only these outcomes leave nothing owed by the DT now:
  //   AB Approved — the as-built is signed off; log-status writes Drawing Status "Complete"
  //   A4.5 / PRD Approved — see FINAL_STAGES; the drawing moves to the Production tab
  //   No Action   — a sketch or S3 coordination loop closed without a redraw; keyed on the
  //                 grade, not the stage, because a sketch carries these outcomes at
  //                 whatever stage it is submitted under
  // A Graded row with no grade recorded stays on the board rather than closing. In practice
  // a blank is an NA — the architect reviewed something non-aesthetic and issued no status —
  // which amounts to an A, and the DT still has to carry the drawing into the next revision.
  // Filing it as signed off would hide live work, which is the failure that matters here.
  // A4.5 Approved: client-facing manufacturing drawing signed off; what follows (scheduling,
  // production, as-built) is tracked on the Production tab, not owed by the DT now.
  // PRD Approved: the factory / supplier signed the sketch off; it needs no as-built.
  var FINAL_STAGES = { "AB": 1, "A4.5": 1, "PRD": 1 };
  function isFinal(s) {
    var grade = s && s.clientGrade;
    if (grade === "No Action") return true;
    return !!FINAL_STAGES[s && s.stage] && grade === "Approved";
  }

  function time(d) { var t = d ? Date.parse(d) : NaN; return isNaN(t) ? 0 : t; }

  // Which lane one submission sits in. Mirrors the COLS buckets in cockpit.jsx.
  //
  // One deliberate difference: the cockpit hides an Approved/Rejected row until Make has
  // written Folder Link back, because the DM cannot send the notification email before the
  // Dropbox folder is live. That is a gate on an ACTION, not a statement about where the
  // drawing is. A summary card that silently omitted those drawings would under-report, so
  // they are classified here regardless of Folder Link.
  function laneOf(s) {
    var st = s.status, stage = s.stage, notified = !!s.dtNotified;
    if (isLegacySignOff(s)) return "closed"; // an old-flow A4.5 sign-off; tracked on the Production tab
    if (st === "Schedule") return "scheduled";
    // Checked before everything except the placeholder rows: a blocked drawing is waiting on
    // information, not on the DT or the DM, so it must not inflate any queue that reads as
    // "someone owes us this". Cleared by Unblock in the cockpit.
    if (s.blocked) return "blocked";
    if (st === "Submitted") return "submitted";
    if ((st === "Approved" || st === "Rejected") && !notified) return "reviewed";
    if (st === "Rejected") return "resubmission";
    if (st === "Approved" || st === "Awaiting Issue") return "approved";
    if (st === "Issued") {
      if (s.hasComments) return "comments";
      // A4.5 sits with the contractor for sign-off, PRD with the factory — neither is
      // waiting on client comments.
      if (stage === "A4.5" || stage === "PRD") return "signoff";
      return "awaiting-comments";
    }
    if (st === "Graded") {
      if (!notified) return "graded";
      // Notified and the grade asks for a new rev: the ball is with the DT, so it belongs
      // in column 1 rather than dropping off the board. latestPerDrawing() clears it the
      // moment that rev lands.
      if (needsRevision(s.clientGrade)) return "resubmission";
      // Clean, but not the end of the road: the next stage is the DT's to draw, so the
      // card stays in column 1 instead of being filed as signed off.
      return isFinal(s) ? "closed" : "resubmission";
    }
    return null; // unknown status — counted nowhere rather than counted wrongly
  }

  // Reduce an event log to current state: one row per drawing, the furthest it has got.
  // Ordering is (stage, QA round, submitted date) descending — stage first, because a later
  // stage always supersedes an earlier one no matter how many rounds the earlier one ran.
  //
  // A submission with no Drawing relation keys on its own id, so it survives as itself
  // instead of being silently swallowed into another drawing's group.
  function latestPerDrawing(submissions) {
    var best = {};
    (submissions || []).forEach(function (s) {
      var ids = s.drawingIds && s.drawingIds.length ? s.drawingIds : [null];
      ids.forEach(function (did) {
        var key = did || ("sub:" + s.id);
        var cur = best[key];
        if (!cur ||
            stageRank(s.stage) > stageRank(cur.stage) ||
            (stageRank(s.stage) === stageRank(cur.stage) &&
              ((s.qaRound || 0) > (cur.qaRound || 0) ||
               ((s.qaRound || 0) === (cur.qaRound || 0) &&
                time(s.submitted) > time(cur.submitted))))) {
          best[key] = s;
        }
      });
    });
    return Object.keys(best).map(function (k) { return best[k]; });
  }

  // ── Production tab ─────────────────────────────────────────────────────────
  // A4.5 drawings are the client-facing manufacturing drawings. Once signed off they leave
  // design and go where the item's Contract Route (Tasks DB) sends them:
  //   In-house / Supply Only → supply drawings needed? Awaiting supply drawings (the PRD
  //                            sketches, their own drawings in the normal flow) : To be scheduled
  //                            → Scheduled (WO date) = In production
  //   Supply & Install       → In production (with the supplier, no factory)
  //   Install Only           → Awaiting install (also site-only drawings: nothing to make)
  // In production / Awaiting install → Installed → Awaiting as-built → the AB goes through
  // review → Approved closes it. PRD drawings, once the factory or supplier signs them off, sit in In
  // production until marked Complete; they need no as-built.
  // Where a drawing is lives on its MDS row (Production Stage), set by the Production tab
  // buttons; the submission log only says where the drawing came from.
  var PRODUCTION_LANES = [
    { id: "signed-off",        title: "A4.5 signed off — decide",   short: "Decide",            accent: "danger",
      sub: "Supply drawings? Outsourced? Site only?" },
    { id: "awaiting-supply",   title: "Awaiting supply drawings",   short: "Awaiting supply",   accent: "warn",
      sub: "PRD / sketches going through the flow · moves on when all are signed off" },
    { id: "to-schedule",       title: "To be scheduled",            short: "To schedule",       accent: "info",
      sub: "Ready for the factory · Scheduled writes the production date and WO Raised" },
    { id: "in-production",     title: "In production",              short: "In production",     accent: "grade",
      sub: "Factory, supplier or signed-off PRD · Installed when it is on site" },
    { id: "awaiting-install",  title: "Awaiting install",           short: "Awaiting install",  accent: "info",
      sub: "Install only (incl. site drawings) · Installed when it is fitted" },
    { id: "awaiting-as-built", title: "Awaiting as-built",          short: "Awaiting AB",       accent: "warn",
      sub: "Installed or site-only · with the DT for the as-built" },
    { id: "ab-review",         title: "As-built review",            short: "AB review",         accent: "ok",
      sub: "AB submitted → issued → graded · Approved closes the drawing" },
  ];
  var PRODUCTION_ORDER = PRODUCTION_LANES.map(function (l) { return l.id; });
  var STAGE_LANE = {
    "Awaiting Supply Drawings": "awaiting-supply", "To Be Scheduled": "to-schedule",
    "In Production": "in-production", "Awaiting Install": "awaiting-install", "Awaiting As Built": "awaiting-as-built",
  };
  // Contract Route (Tasks DB) → the moves offered on a just-signed-off A4.5.
  var ROUTES = ["In-house", "Supply Only", "Supply & Install", "Install Only"];
  var ROUTE_MOVES = {
    "In-house":         ["Awaiting Supply Drawings", "To Be Scheduled"],
    "Supply Only":      ["Awaiting Supply Drawings", "To Be Scheduled"],
    "Supply & Install": ["In Production"],
    "Install Only":     ["Awaiting Install"],
  };
  // Drawn by a supplier (Team DB "Outsourced" / "By Supplier"), so likely a supply route.
  function isOutsourced(dtName) { return /outsourced|by supplier/i.test(dtName || ""); }

  // Old flow (to June 2026): an A4.5 sign-off was written as Status "Schedule" with grade
  // Approved. Those rows are real sign-offs, not the grade-less placeholder rows "Schedule"
  // otherwise means.
  function isLegacySignOff(s) { return !!s && s.status === "Schedule" && s.clientGrade === "Approved" && s.stage === "A4.5"; }
  function signedOff(s, stage) {
    if (!s || s.stage !== stage) return false;
    if (stage === "A4.5" && isLegacySignOff(s)) return true;
    // Moves across once the DT has been told; until then it waits in Graded — Notify DT.
    return s.status === "Graded" && s.clientGrade === "Approved" && !!s.dtNotified;
  }

  // ps = the drawing's MDS Production Stage. Unknown → design, so nothing ever vanishes
  // because of a rule it fell between.
  function phaseOf(s, ps) {
    if (ps === "Complete") return "done";
    if (ps) return "production";
    if (!s) return "design";
    if (s.stage === "AB") return isFinal(s) || s.status === "Complete" ? "done" : "production";
    if (s.stage === "PRD" && s.status === "Complete") return "done";   // old flow
    if (signedOff(s, "A4.5") || signedOff(s, "PRD")) return "production";
    return "design";
  }

  // opts.supplyDone: every supply drawing (PRD) on the same item is signed off.
  function productionLaneOf(s, ps, opts) {
    if (phaseOf(s, ps) !== "production") return null;
    if (s && s.stage === "AB") {
      if (s.status === "Rejected" && s.dtNotified) return "awaiting-as-built";
      if (s.status === "Graded" && s.dtNotified && needsRevision(s.clientGrade)) return "awaiting-as-built";
      return "ab-review";
    }
    if (ps === "Awaiting Supply Drawings" && opts && opts.supplyDone) return "to-schedule";
    if (STAGE_LANE[ps]) return STAGE_LANE[ps];
    if (s && s.stage === "PRD") return "in-production";
    return "signed-off";
  }

  // Supply drawings for an item = its drawings whose current submission is a PRD.
  // Done when there is at least one and every one is signed off (or closed / in production).
  function supplyDoneFor(itemId, current, stageOf) {
    var prds = (current || []).filter(function (s) {
      return s.stage === "PRD" && s.taskIds && s.taskIds.indexOf(itemId) >= 0;
    });
    if (!prds.length) return false;
    return prds.every(function (s) {
      var ps = stageOf ? stageOf(s) : null;
      return ps === "In Production" || ps === "Complete" || signedOff(s, "PRD") || s.status === "Complete";
    });
  }

  // Per-item lane counts, zeros dropped, in board order.
  // Keyed on the Item relation page id — the string taskCode is carried for display only,
  // so a renamed submission title can never split one item into two cards.
  //
  // Returns { byItem: { <itemId>: { taskCode, total, lanes: [{id,title,n}] } }, unlinked }
  function summarise(submissions) {
    var current = latestPerDrawing(submissions);
    var byItem = {}, unlinked = 0;

    current.forEach(function (s) {
      var lane = laneOf(s);
      if (!lane) return;
      var itemId = s.taskIds && s.taskIds.length ? s.taskIds[0] : null;
      if (!itemId) { unlinked++; return; }
      var e = byItem[itemId] || (byItem[itemId] = { taskCode: s.taskCode || null, counts: {}, total: 0 });
      if (!e.taskCode && s.taskCode) e.taskCode = s.taskCode;
      e.counts[lane] = (e.counts[lane] || 0) + 1;
      e.total++;
    });

    Object.keys(byItem).forEach(function (id) {
      var e = byItem[id];
      e.lanes = LANE_ORDER
        .filter(function (l) { return e.counts[l] > 0; })   // "Exclude any that equal 0"
        .map(function (l) { return { id: l, title: LANE_TITLE[l], n: e.counts[l] }; });
      delete e.counts;
    });

    return { byItem: byItem, unlinked: unlinked };
  }

  return { LANES: LANES, LANE_ORDER: LANE_ORDER, LANE_TITLE: LANE_TITLE, LANE_SHORT: LANE_SHORT,
           stageRank: stageRank, needsRevision: needsRevision, isFinal: isFinal,
           laneOf: laneOf, latestPerDrawing: latestPerDrawing,
           summarise: summarise,
           PRODUCTION_LANES: PRODUCTION_LANES, PRODUCTION_ORDER: PRODUCTION_ORDER,
           phaseOf: phaseOf, productionLaneOf: productionLaneOf, isLegacySignOff: isLegacySignOff,
           supplyDoneFor: supplyDoneFor, STAGE_LANE: STAGE_LANE,
           ROUTES: ROUTES, ROUTE_MOVES: ROUTE_MOVES, isOutsourced: isOutsourced };
});
