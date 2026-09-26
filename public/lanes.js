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
// times has three Rejected rows. Counting rows gives "Bounced — With DT 30" for 24-354-003
// where the truthful figure is 13, and 8 for 24-354-190 where every one has been superseded
// and the answer is 0. latestPerDrawing() is what makes the counts mean "where things stand".

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DFLanes = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Board order — the order badges read in, left to right. Bounced first: on a summary card
  // the thing that needs chasing should be the first thing seen.
  var LANES = [
    { id: "bounced",           title: "Bounced — With DT",               short: "Bounced",           accent: "danger" },
    { id: "submitted",         title: "Submitted — Awaiting Review",     short: "Submitted",         accent: "info"   },
    { id: "reviewed",          title: "Reviewed — Notify DT",            short: "Notify DT",         accent: "ok"     },
    { id: "approved",          title: "Approved — Awaiting Issue",       short: "Awaiting Issue",    accent: "ok"     },
    { id: "awaiting-comments", title: "Issued — Awaiting Comments",      short: "Awaiting Comments", accent: "info"   },
    { id: "comments",          title: "Issued — Review Client Comments", short: "Review Comments",   accent: "grade"  },
    { id: "signoff",           title: "Issued — Awaiting Sign-Off",      short: "Awaiting Sign-Off", accent: "warn"   },
    { id: "graded",            title: "Graded — Notify DT",              short: "Graded (notify)",   accent: "grade"  },
    // Terminal. Never appears on the cockpit board — a graded, DT-notified submission has
    // left the queue — but it is the whole point of the client card: "these are signed off".
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
    if (st === "Schedule") return "scheduled";
    if (st === "Submitted") return "submitted";
    if ((st === "Approved" || st === "Rejected") && !notified) return "reviewed";
    if (st === "Rejected") return "bounced";
    if (st === "Approved" || st === "Awaiting Issue") return "approved";
    if (st === "Issued") {
      if (s.hasComments) return "comments";
      // A4.5 sits with the contractor for sign-off, PRD with the factory — neither is
      // waiting on client comments.
      if (stage === "A4.5" || stage === "PRD") return "signoff";
      return "awaiting-comments";
    }
    if (st === "Graded") return notified ? "closed" : "graded";
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
           stageRank: stageRank, laneOf: laneOf, latestPerDrawing: latestPerDrawing,
           summarise: summarise };
});
