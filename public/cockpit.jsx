// cockpit.jsx — DM Submissions Queue
// Polls /api/df/submissions every 30s.
// Shows Status=Submitted queue (grouped by task/item) with Approve + Bounce actions.
// Shows Status=Issued section with Log Status (A/B/C/NA) action.
// Shows Pending DT Notification section — actioned items awaiting batch email send.
// Multi-select batch actions per queue section.
// Desktop notifications on new arrivals.

const { useState, useEffect, useRef, useCallback } = React;

// ─── Utilities ────────────────────────────────────────────────────────────────

// Every graded stage records a real date rather than the day it happened to be logged.
// S4/S5 take the date the return was filed on the project system; A4.5 and PRD the date
// it was actually signed off; AB the date the status changed. Leaving these to default to
// today quietly post-dated anything logged a few days late — and for A4.5 that date is
// `C01 Sign Off`, which the programme reads.
// Mirrors STAGE_LOG_STATUS_MAP in drawing-flow.js. Kept here rather than derived from the
// card so both modals offer exactly what the backend will accept.
//   QA Rejected — the client's document controller bounced it on paperwork before anyone
//                 reviewed it. Offered wherever a drawing goes to the client for review.
//   S3          — coordination, not approval: an outcome, not a grade.
// A sketch is a coordination document whatever stage it carries — the architect marks it
// up or it goes straight to a supplier, and nobody issues an A/B/C against one. The drawing
// number is the test: most SK-I drawings are not tagged "Sketch" in the MDS.
const SKETCH_GRADES = ["Revise", "No Action"];
const isSketchDrawingNo = (drawingNo) => /-SK-I-/i.test(String(drawingNo ?? ""));
const gradesFor = (stage, drawingNo) =>
  (stage === "S3" || isSketchDrawingNo(drawingNo))
    ? SKETCH_GRADES
    : (STAGE_GRADES[stage] || ["A", "B", "C", "NA"]);

const STAGE_GRADES = {
  "S3":   ["Revise", "No Action"],
  "S4":   ["A", "B", "C", "NA", "QA Rejected"],
  "S5":   ["A", "B", "C", "NA", "QA Rejected"],
  "A4.5": ["Approved", "Rejected", "QA Rejected"],
  "PRD":  ["Approved", "Rejected"],
  "AB":   ["Approved", "Rejected"],
};
// Grades reach CSS as class names, and two of them have a space in them.
const gradeClass = (g) => String(g).replace(/[^A-Za-z0-9]+/g, "-");

const STATUS_DATE_LABEL = {
  "S4":   "Return date (as filed on project system)",
  "S5":   "Return date (as filed on project system)",
  "A4.5": "Sign-off date (contractor)",
  "PRD":  "Sign-off date (factory)",
  "AB":   "Status date",
  "S3":   "Date comments received",
};
// One stage gives its own label; a batch spanning A4.5/PRD/AB falls back to the neutral
// one rather than naming a party that is wrong for half the set.
const statusDateLabel = (stages) => {
  const labels = [...new Set(stages.map((st) => STATUS_DATE_LABEL[st]).filter(Boolean))];
  return labels.length === 1 ? labels[0] : "Sign-off date";
};

function stageBadgeClass(stage) {
  if (!stage) return "";
  if (stage === "S4") return "badge-s4";
  if (stage === "S5") return "badge-s5";
  if (stage === "S3") return "badge-s3";
  if (stage === "PRD") return "badge-prd";
  if (stage === "AB") return "badge-ab";
  return "badge-a45";
}

// lanes.js is loaded ahead of this file in index.html and is the single definition of
// which lane a submission sits in — shared with the summary endpoint so the board and the
// client card can never disagree about where a drawing is.
const DFLanes = typeof window !== "undefined" ? window.DFLanes : null;
if (!DFLanes) console.error("[cockpit] lanes.js did not load — the With DT column will be empty");

function daysSince(dateStr) {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / 86400000);
}

// Whole days until a due date; negative means overdue. Both sides are floored to local
// midnight so "due today" reads 0 rather than a fraction of a day in either direction.
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const midnight = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const t = midnight(dateStr);
  return isNaN(t) ? null : Math.round((t - midnight(Date.now())) / 86400000);
}

function shortDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// Due-date chip for a drawing sitting with a DT. The date comes off the Item's programme,
// so it is the same for every drawing in that item and does not move as QA rounds go by —
// a chase date, not a per-drawing deadline.
function dueCls(dateStr) {
  const d = daysUntil(dateStr);
  return d == null ? "info" : d < 0 ? "danger" : d <= 3 ? "warn" : "info";
}

function dueLabel(dateStr) {
  const d = daysUntil(dateStr);
  if (d == null) return "";
  if (d < 0)     return `Due ${shortDate(dateStr)} · ${-d}d late`;
  if (d === 0)   return "Due today";
  return `Due ${shortDate(dateStr)}`;
}

function formatBicSince(dateStr) {
  const days = daysSince(dateStr);
  if (days === null) return "—";
  if (days === 0) return "Today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

function bicSinceClass(dateStr) {
  const days = daysSince(dateStr);
  if (days === null) return "";
  if (days >= 5) return "overdue";
  if (days >= 3) return "urgent";
  return "";
}

// Group submissions by task code (first segment of title before first _)
function groupByTask(submissions) {
  const groups = {};
  for (const s of submissions) {
    const key = s.taskCode || "Unknown";
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }
  return groups;
}

// Deterministic hue (0–359) from a string — used to colour DTs and projects consistently.
function hashHue(str) {
  let h = 0;
  for (let i = 0; i < (str || "").length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}
// Colour per DT (avatar) and per project (group accent). Same input → same colour.
function personColor(name) { return `oklch(58% 0.16 ${hashHue(name || "?")})`; }
function projectColor(taskCode) {
  const proj = (taskCode || "").split("-").slice(0, 2).join("-") || taskCode || "x";
  return `oklch(64% 0.15 ${hashHue(proj)})`;
}

// ─── Modals ───────────────────────────────────────────────────────────────────

// Scheduled: asks for the date the works order was raised. Written to the drawing's
// Schedule Production (Actual) and the item's WO Raised. One date for every card passed in.
const ScheduleModal = ({ cards, onConfirm, onClose }) => {
  const [woDate, setWoDate] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const submit = async () => { setBusy(true); await onConfirm(cards, woDate); setBusy(false); onClose(); };
  const items = [...new Set(cards.map((c) => c.taskCode).filter(Boolean))];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Scheduled — {cards.length === 1 ? (cards[0].drawingNo || cards[0].title) : `${cards.length} drawings`}</h3>
        <div className="modal-sub">{items.join(" · ")}</div>
        <label style={{ display: "block", fontSize: 13, color: "var(--text2)", margin: "16px 0 6px" }}>Date the WO was raised</label>
        <input type="date" value={woDate} onChange={(e) => setWoDate(e.target.value)} className="k-search" style={{ maxWidth: 200 }} aria-label="Date the WO was raised" />
        <p style={{ fontSize: 12, color: "var(--muted)", margin: "10px 0 0" }}>
          Written to each drawing's Schedule Production (Actual) and the item's WO Raised. Move back puts the previous WO Raised back.
        </p>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-approve" onClick={submit} disabled={busy || !woDate}>{busy ? "Saving…" : "Scheduled"}</button>
        </div>
      </div>
    </div>
  );
};

const BounceModal = ({ submission, onConfirm, onClose }) => {
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    await onConfirm(submission.id);
    setBusy(false);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Bounce — {submission.drawingNo || submission.title}</h3>
        <div className="modal-sub">
          {submission.stage} · Rev {submission.revision} · QA R{submission.qaRound}
          {submission.dtName ? ` · ${submission.dtName}` : ""}
        </div>
        <p style={{ fontSize: 13, color: "var(--text2)", margin: "16px 0 0" }}>
          Returns the drawing to the DT. Your Drawboard markup travels with the PDF — it moves to the
          project's <strong>02_Rejected</strong> folder as <code>…_R{submission.qaRound ?? 1}.pdf</code> and the folder
          link goes out in the next DT email.
        </p>
        <p style={{ fontSize: 12, color: "var(--warn)", margin: "10px 0 0" }}>
          Sync the document in Drawboard and close it before bouncing, so the marked-up version is the one that moves.
        </p>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-bounce" onClick={submit} disabled={busy}>
            {busy ? "Sending…" : "Bounce"}
          </button>
        </div>
      </div>
    </div>
  );
};

const LogStatusModal = ({ submission, onConfirm, onClose }) => {
  const [busy,       setBusy]       = useState(false);
  const [returnDate, setReturnDate] = useState("");
  const [comment,    setComment]    = useState("");
  // Which grade was clicked. Set before the await so the button lights up on press and
  // stays lit until the modal closes, rather than reverting the moment the pointer lifts.
  const [chosen,     setChosen]     = useState(null);

  const isAB  = submission.stage === "AB";
  const isA45 = submission.stage === "A4.5";
  const isPRD = submission.stage === "PRD";
  // A4.5 and PRD share the same Approved/Rejected mechanics and file moves.
  const isSignOff = isA45 || isPRD;
  const dateLabel = statusDateLabel([submission.stage]);
  // Only S4/S5/A4.5 carry a `{stage} Comments` property on the MDS. A note typed against
  // PRD or AB still reaches the submission and the DT's email, it just has no MDS home.
  const commentsTracked = ["S4", "S5", "A4.5"].includes(submission.stage);
  const isS3   = submission.stage === "S3" || isSketchDrawingNo(submission.drawingNo);
  const grades = gradesFor(submission.stage, submission.drawingNo);
  const hint   = isS3  ? "Revise = sketch goes back to the DT · No Action = coordination closed"
               : isAB  ? "Approved = As Built accepted · Rejected = revision required"
               : isPRD ? "Approved = Factory sign-off · Rejected = revision required"
               : isA45 ? "Approved = Contractor sign-off · Rejected = revision required · QA Rejected = bounced by client document control"
               : "A = accepted · B = minor revision · C = major revision · NA = not applicable · QA Rejected = bounced by client document control";

  const select = async (grade) => {
    if (!returnDate) {
      alert(`Please enter the ${dateLabel.toLowerCase()}.`);
      return;
    }
    setChosen(grade);
    setBusy(true);
    try {
      // handleLogStatus reports its own failures and resolves either way, so the modal
      // closes on both paths — same as Bounce and Issue. The try/finally is only here so
      // an unexpected throw hands the buttons back instead of freezing the selection.
      await onConfirm(submission.id, grade, returnDate || null, comment.trim() || null);
      onClose();
    } finally {
      setBusy(false);
      setChosen(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Log {isPRD ? "Factory" : "Client"} Grade — {submission.drawingNo || submission.title}</h3>
        <div className="modal-sub">
          {submission.stage} · Rev {submission.revision}
        </div>
        <div style={{ margin: "16px 0 4px" }}>
          <label style={{ fontSize: 12, color: "var(--text2)", display: "block", marginBottom: 4 }}>
            {dateLabel} *
          </label>
          <input
            type="date"
            value={returnDate}
            onChange={(e) => setReturnDate(e.target.value)}
            disabled={busy}
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text1)", fontSize: 13 }}
          />
        </div>
        {/* Optional, and usually empty: a client either sends a marked-up PDF or writes a
            line. This is the second case — it lands in the same {stage} Comments field the
            comment PDFs do, and reaches the DT in the grade email. */}
        <div style={{ margin: "16px 0 4px" }}>
          <label style={{ fontSize: 12, color: "var(--text2)", display: "block", marginBottom: 4 }}>
            Comment (optional)
          </label>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder={commentsTracked
              ? `Client's written comments — saved to ${submission.stage} Comments and sent to the DT`
              : "Note for the DT — sent with the grade email"}
            style={{ width: "100%", boxSizing: "border-box", padding: "6px 10px", borderRadius: 6,
                     border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text1)",
                     fontSize: 13, fontFamily: "inherit", resize: "vertical" }}
          />
        </div>
        <div className="grade-buttons" style={{ marginTop: 16 }}>
          {grades.map((g) => (
            <button key={g} className={`grade-btn ${gradeClass(g)}${chosen === g ? " is-selected" : ""}`}
              onClick={() => select(g)} disabled={busy} aria-busy={busy && chosen === g}>
              {g}
            </button>
          ))}
        </div>
        {busy && (
          <div className="modal-working" role="status" aria-live="polite">
            <span className="spinner" />
            <span>Logging grade {chosen} — updating Notion{submission.hasComments ? " and moving the comment PDFs" : ""}…</span>
          </div>
        )}
        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: "var(--text3)" }}>
          {hint}
        </div>
        {submission.hasComments && (
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--text3)" }}>
            Client comment PDFs for this drawing move to <code>05_Client Comments/Reviewed</code> with an <code>R_</code> prefix —
            sync them in Drawboard first.
          </div>
        )}
        {isSignOff && (
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--text3)" }}>
            Rejected moves the issued {isPRD ? "PRD" : "C01"} PDF to <code>05_Client Comments</code> as <code>…_Rejected_YYMMDD.pdf</code>; Approved moves it to <code>06_Signed Off</code>.
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Issue modal ──────────────────────────────────────────────────────────────

const IssueModal = ({ submission, onConfirm, onClose }) => {
  const [busy, setBusy] = useState(false);
  // Reached from an Approved card: the DT has uploaded no DWGs and the DM is saying there
  // are none coming. An S3 coordination sketch is the usual case — the PDF is the whole
  // deliverable, so waiting for a DWG parks it forever.
  const forcing = submission.status === "Approved";

  const submit = async () => {
    setBusy(true);
    await onConfirm(submission.id, forcing);
    setBusy(false);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Issue — {submission.drawingNo || submission.title}</h3>
        <div className="modal-sub">
          {submission.stage} · Rev {submission.revision}
          {submission.dtName ? ` · ${submission.dtName}` : ""}
        </div>
        {/* Issue means two different things depending on the flag, so say which one. */}
        <p style={{ fontSize: 13, color: "var(--text2)", margin: "16px 0 0" }}>
          {submission.noClientApproval
            ? <>Confirm you have issued the drawings to the supplier. The PDF moves from <code>03_Ready For Issue</code> to{" "}
               <code>04_Issued</code> (DWGs stay put), and Notion and the MDS are updated.</>
            : <>Confirm you have issued the drawings to the client. The PDF moves from <code>03_Ready For Issue</code> to{" "}
               <code>04_Issued</code> (DWGs stay put), Notion and the MDS are updated, and the DT is notified.</>}
        </p>
        {forcing && (
          <p className="issue-nca">
            <strong>No DWGs uploaded</strong> — this drawing has not reached Awaiting Issue. Issue it
            anyway only if the PDF is the whole deliverable, as it is for an S3 coordination sketch.
          </p>
        )}
        {submission.noClientApproval && (
          <p className="issue-nca">
            <strong>No client approval</strong> — this goes to the supplier rather than out for approval.
            The ball moves to <strong>Supplier</strong> and the card stays on the board under Awaiting
            Comments, so you can see where it sits. Close it off later with Revise or No Action.
          </p>
        )}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-issue" onClick={submit} disabled={busy}>
            {busy ? "Issuing…"
              : forcing ? "Issue anyway"
              : submission.noClientApproval ? "Issue to Supplier"
              : "Confirm Issue"}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Submission row ───────────────────────────────────────────────────────────

// Grade several drawings in one pass from the bulk bar. Deliberately not a loop around
// LogStatusModal: one grade, one return date and one comment are entered once and applied
// to every selected drawing, which is the real case — a client replies about a set of
// drawings at once, with one verdict.
const BatchGradeModal = ({ submissions, onConfirm, onClose }) => {
  const [returnDate, setReturnDate] = useState("");
  const [comment,    setComment]    = useState("");
  const [chosen,     setChosen]     = useState(null);
  const [progress,   setProgress]   = useState(null);   // { done, total, current }
  const [failures,   setFailures]   = useState(null);   // [{ label, error }]

  const stages    = [...new Set(submissions.map((s) => s.stage))];
  const isSignOff = stages.every((st) => ["A4.5", "PRD", "AB"].includes(st));
  // Only outcomes every selected stage accepts — a mixed A4.5/PRD batch loses QA Rejected,
  // which PRD does not have, rather than offering a button half of them would reject.
  const perSub  = submissions.map((sub) => gradesFor(sub.stage, sub.drawingNo));
  const grades  = perSub.reduce((common, g) => common.filter((x) => g.includes(x)), perSub[0] || []);
  const dateLabel = statusDateLabel(stages);
  const commentsTracked = stages.every((st) => ["S4", "S5", "A4.5"].includes(st));
  // PRD is graded by the factory, every other stage by the client. A set spanning both
  // gets the neutral wording rather than a label that is wrong for half of it.
  const actor = stages.every((st) => st === "PRD") ? "factory "
              : stages.some((st) => st === "PRD")  ? ""
              : "client ";
  const label     = (sub) => sub.drawingNo || sub.title || sub.id;
  const busy      = !!progress && !failures;
  const done      = !!failures;

  const select = async (grade) => {
    if (!returnDate) {
      alert(`Please enter the ${dateLabel.toLowerCase()}.`);
      return;
    }
    setChosen(grade);
    const fails = [];
    // One at a time. Each log-status call fans out to Notion and fires its own move-files
    // webhook; firing thirty of those inside the same second is what left 4 of 31 files
    // moved on the 109 issue. Slower, but every drawing actually lands.
    for (let i = 0; i < submissions.length; i++) {
      const sub = submissions[i];
      setProgress({ done: i, total: submissions.length, current: label(sub) });
      const err = await onConfirm(sub.id, grade, returnDate || null, comment.trim() || null);
      if (err) fails.push({ label: label(sub), error: err });
    }
    setProgress({ done: submissions.length, total: submissions.length, current: null });
    // Failures keep the modal open and named — "3 of 12 failed, check console" tells you
    // nothing you can act on.
    if (fails.length) setFailures(fails);
    else onClose();
  };

  const shown = submissions.slice(0, 8);

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Grade {submissions.length} drawing{submissions.length === 1 ? "" : "s"}</h3>
        <div className="modal-sub">{stages.join(" · ")} — one {actor}grade applied to all</div>

        <ul className="batch-grade-list">
          {shown.map((sub) => <li key={sub.id}><code>{label(sub)}</code> <span>{sub.stage} · Rev {sub.revision}</span></li>)}
          {submissions.length > shown.length && <li className="more">+{submissions.length - shown.length} more</li>}
        </ul>

        {!done && (
          <div style={{ margin: "14px 0 4px" }}>
            <label style={{ fontSize: 12, color: "var(--text2)", display: "block", marginBottom: 4 }}>
              {dateLabel} *
            </label>
            <input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} disabled={busy}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text1)", fontSize: 13 }} />
          </div>
        )}

        {!done && (
          <div style={{ margin: "14px 0 4px" }}>
            <label style={{ fontSize: 12, color: "var(--text2)", display: "block", marginBottom: 4 }}>
              Comment (optional — applied to every drawing above)
            </label>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} disabled={busy}
              placeholder={commentsTracked
                ? "Client's written comments — saved against each drawing's Comments and sent to the DT"
                : "Note for the DT — sent with the grade email"}
              style={{ width: "100%", boxSizing: "border-box", padding: "6px 10px", borderRadius: 6,
                       border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text1)",
                       fontSize: 13, fontFamily: "inherit", resize: "vertical" }} />
          </div>
        )}

        {!done && (
          <div className="grade-buttons" style={{ marginTop: 16 }}>
            {grades.map((g) => (
              <button key={g} className={`grade-btn ${gradeClass(g)}${chosen === g ? " is-selected" : ""}`}
                onClick={() => select(g)} disabled={busy} aria-busy={busy && chosen === g}>
                {g}
              </button>
            ))}
          </div>
        )}

        {busy && (
          <div className="modal-working" role="status" aria-live="polite">
            <span className="spinner" />
            <span>Grading {Math.min(progress.done + 1, progress.total)} of {progress.total}
              {progress.current ? ` — ${progress.current}` : ""}…</span>
          </div>
        )}

        {done && (
          <div className="batch-grade-fail">
            <strong>{failures.length} of {submissions.length} could not be graded</strong>
            <ul>{failures.map((f) => <li key={f.label}><code>{f.label}</code> — {f.error}</li>)}</ul>
            <span className="note">The rest went through. Re-select just these and try again.</span>
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>{done ? "Close" : "Cancel"}</button>
        </div>
      </div>
    </div>
  );
};

const SubmissionRow = ({ sub, onApprove, onBounce, onLogStatus, onIssue, onHold, busy, selected, onToggleSelect }) => {
  const isBusy = busy === sub.id;
  const isApproved      = sub.status === "Approved";
  const isAwaitingIssue = sub.status === "Awaiting Issue";
  const isIssued        = sub.status === "Issued";
  const isGraded        = sub.status === "Graded";

  const actions = () => {
    if (isGraded) {
      return (
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--warning)", whiteSpace: "nowrap" }}>
          Grade: {sub.clientGrade || "—"}
        </span>
      );
    }
    if (isIssued) {
      return (
        <button className="btn btn-grade btn-sm" onClick={() => onLogStatus(sub)} disabled={isBusy}>
          Grade
        </button>
      );
    }
    if (isAwaitingIssue) {
      return (
        <button className="btn btn-issue btn-sm" onClick={() => onIssue(sub)} disabled={isBusy}>
          {isBusy ? "…" : "Issue"}
        </button>
      );
    }
    if (isApproved) {
      return <span style={{ fontSize: 11, color: "var(--text3)" }}>Awaiting DT upload</span>;
    }
    return (
      <>
        <button className="btn btn-approve btn-sm" onClick={() => onApprove(sub.id)} disabled={isBusy}
          title="Approve — passes QA review">
          {isBusy ? "…" : "Approve"}
        </button>
        <button className="btn btn-bounce btn-sm" onClick={() => onBounce(sub)} disabled={isBusy}
          title="Bounce — return to DT for revision">
          Bounce
        </button>
      </>
    );
  };

  return (
    <div className={`queue-row${selected ? " selected" : ""}${sub.blocked ? " blocked" : ""}`}>
      <div className="queue-row-check">
        <input
          type="checkbox"
          checked={!!selected}
          onChange={() => onToggleSelect(sub.id)}
          onClick={(e) => e.stopPropagation()}
          title="Select for batch action"
        />
      </div>
      <div>
        <div className="queue-row-drawing">
          {sub.drawingNo || sub.title}
          {sub.hasComments && (
            <span
              title="Client comments received — ready to review"
              style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, padding: "1px 6px",
                       borderRadius: 8, background: "rgba(204,121,167,0.18)", color: "#CC79A7",
                       whiteSpace: "nowrap", verticalAlign: "middle" }}
            >
              💬 Comments
            </span>
          )}
        </div>
        <div className="queue-row-sub">
          R{sub.qaRound} · Rev {sub.revision}
          {sub.dtName ? ` · ${sub.dtName}` : ""}
        </div>
      </div>
      <div>
        <span className={`badge ${stageBadgeClass(sub.stage)}`}>{sub.stage}</span>
      </div>
      <div>
        <span className={`badge badge-${(sub.status || "submitted").toLowerCase().replace(/\s+/g, "-")}`}>
          {sub.status || "Submitted"}
        </span>
      </div>
      <div style={{ textAlign: "center", fontSize: 13, color: "var(--text2)" }}>R{sub.qaRound}</div>
      <div className={`bic-time ${bicSinceClass(sub.bicSince)}`}>{formatBicSince(sub.bicSince)}</div>
      <div className="queue-row-link">
        {(sub.shareLink || sub.dropboxLink)
          ? <a href={sub.shareLink || sub.dropboxLink} target="_blank" rel="noopener noreferrer">↗ Open</a>
          : <span style={{ color: "var(--text3)", fontSize: 11 }}>No link</span>}
      </div>
      <div className="queue-actions">
        {actions()}
        {onHold && (
          <button
            className={`btn btn-sm${sub.blocked ? " btn-hold-active" : " btn-ghost"}`}
            onClick={() => onHold(sub.id, sub.blocked)}
            disabled={isBusy}
            title={sub.blocked ? "Remove hold" : "Put on hold (RFI / Design Change)"}
          >
            {sub.blocked ? "⏸ Held" : "Hold"}
          </button>
        )}
      </div>
    </div>
  );
};

// ─── Batch action bar ─────────────────────────────────────────────────────────

const BatchBar = ({ count, label, onAction, onClear, busy }) => {
  if (count === 0) return null;
  return (
    <div className="batch-bar">
      <span className="batch-bar-count">{count} selected</span>
      <button className="btn btn-sm btn-primary" onClick={onAction} disabled={busy}>
        {busy ? "Working…" : `${label} ${count}`}
      </button>
      <button className="btn btn-sm btn-ghost" onClick={onClear} disabled={busy}>
        Clear
      </button>
    </div>
  );
};

// ─── Queue section ────────────────────────────────────────────────────────────

const QueueSection = ({
  title, submissions, onApprove, onBounce, onLogStatus, onIssue, onHold, busy,
  selectedIds, onToggleSelect, batchLabel, onBatchAction, batchBusy,
}) => {
  if (!submissions.length) return null;
  const groups = groupByTask(submissions);

  // IDs of all submissions in this section
  const sectionIds = submissions.map((s) => s.id);
  const selectedInSection = sectionIds.filter((id) => selectedIds.has(id));
  const allSelected = sectionIds.length > 0 && selectedInSection.length === sectionIds.length;
  const someSelected = selectedInSection.length > 0;

  const toggleAll = () => {
    if (allSelected) {
      // deselect all in this section
      sectionIds.forEach((id) => selectedIds.has(id) && onToggleSelect(id));
    } else {
      // select all in this section that aren't already selected
      sectionIds.forEach((id) => !selectedIds.has(id) && onToggleSelect(id));
    }
  };

  return (
    <div>
      <div className="section-header">
        <input
          type="checkbox"
          className="section-select-all"
          checked={allSelected}
          ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
          onChange={toggleAll}
          title="Select all in section"
        />
        <span className="section-title">{title}</span>
        <span className="count-pill">{submissions.length}</span>
      </div>

      {batchLabel && (
        <BatchBar
          count={selectedInSection.length}
          label={batchLabel}
          onAction={() => onBatchAction(selectedInSection)}
          onClear={() => sectionIds.forEach((id) => selectedIds.has(id) && onToggleSelect(id))}
          busy={batchBusy}
        />
      )}

      {Object.entries(groups).map(([taskCode, rows]) => (
        <div key={taskCode} className="queue-group">
          <div className="queue-group-header">{taskCode}</div>
          {rows.map((sub) => (
            <SubmissionRow
              key={sub.id}
              sub={sub}
              onApprove={onApprove}
              onBounce={onBounce}
              onLogStatus={onLogStatus}
              onIssue={onIssue}
              onHold={onHold}
              busy={busy}
              selected={selectedIds.has(sub.id)}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </div>
      ))}
    </div>
  );
};

// ─── Pending DT Notification section ─────────────────────────────────────────
// Read-only list of actioned submissions awaiting the batch DT email send.

const PendingNotificationRow = ({ sub }) => {
  const actionColor = sub.dmAction === "Bounce" ? "var(--danger)"
    : sub.dmAction === "Log Status" ? "var(--warning)"
    : "var(--success)";

  return (
    <div className="pending-row">
      <div>
        <div className="queue-row-drawing">{sub.drawingNo || sub.title}</div>
        <div className="queue-row-sub">
          {sub.stage} · R{sub.qaRound}
          {sub.dtName ? ` · ${sub.dtName}` : ""}
        </div>
      </div>
      <div>
        <span className={`badge ${stageBadgeClass(sub.stage)}`}>{sub.stage}</span>
      </div>
      <div style={{ fontSize: 12, color: actionColor, fontWeight: 600 }}>
        {sub.dmAction === "Bounce"     ? `Bounced R${sub.qaRound}`
         : sub.dmAction === "Log Status" ? `Grade: ${sub.grade || "—"}`
         : sub.status === "Issued"    ? "Issued"
         : "Approved"}
      </div>
      <div className="queue-row-link" style={{ fontSize: 11, color: "var(--text3)" }}>
        {sub.folderPath
          ? sub.folderPath.split("/").slice(-2).join("/")
          : "—"}
      </div>
    </div>
  );
};

const PendingNotificationSection = ({ submissions }) => {
  if (!submissions.length) return null;

  // Group by DT name
  const byDT = {};
  for (const s of submissions) {
    const key = s.dtName || "Unknown DT";
    if (!byDT[key]) byDT[key] = [];
    byDT[key].push(s);
  }

  return (
    <div className="pending-notif-section">
      <div className="section-header" style={{ marginTop: 8 }}>
        <span className="section-title">Pending DT Notification</span>
        <span className="count-pill pending-count">{submissions.length}</span>
        <span style={{ fontSize: 11, color: "var(--text3)", marginLeft: 6 }}>
          — click "Send DT Emails" to notify
        </span>
      </div>
      {Object.entries(byDT).map(([dtName, rows]) => (
        <div key={dtName} className="queue-group">
          <div className="queue-group-header">{dtName}</div>
          {rows.map((sub) => (
            <PendingNotificationRow key={sub.id} sub={sub} />
          ))}
        </div>
      ))}
    </div>
  );
};

// ─── Cockpit root ─────────────────────────────────────────────────────────────

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const Cockpit = () => {
  const [submitted,            setSubmitted]            = useState([]);
  const [awaitingIssue,        setAwaitingIssue]        = useState([]);
  const [issued,               setIssued]               = useState([]);
  const [pendingNotification,  setPendingNotification]  = useState([]);
  const [loading,              setLoading]              = useState(true);
  const [error,                setError]                = useState(null);
  const [lastPoll,             setLastPoll]             = useState(null);
  const [busy,                 setBusy]                 = useState(null);
  const [batchBusy,            setBatchBusy]            = useState(false);
  const [batchGradeTargets,    setBatchGradeTargets]    = useState(null);
  const [sendEmailBusy,        setSendEmailBusy]        = useState(false);
  const [sendEmailResult,      setSendEmailResult]      = useState(null); // "ok" | "error" | null
  const [bounceTarget,         setBounceTarget]         = useState(null);
  const [issueTarget,          setIssueTarget]          = useState(null);
  const [logStatusTarget,      setLogStatusTarget]      = useState(null);
  const [scanning,             setScanning]             = useState(false);
  const [scanResult,           setScanResult]           = useState(null);  // "ok" | "error" | null
  const [scanError,            setScanError]            = useState(null);
  const [scanCommentsBusy,     setScanCommentsBusy]     = useState(false);
  const [scanCommentsResult,   setScanCommentsResult]   = useState(null);  // "ok" | "error" | null
  const [withDT,               setWithDT]               = useState([]);
  const [blockedItems,         setBlockedItems]         = useState([]);
  // Production tab: drawings past A4.5 sign-off, current submission only (lanes.js phaseOf).
  const [production,           setProduction]           = useState([]);
  // MDS Production Stage per drawing id (GET /api/df/production-stages).
  const [prodStages,           setProdStages]           = useState({});
  const [prodRoutes,           setProdRoutes]           = useState({});   // itemId → Contract Route
  const [scheduleTargets,      setScheduleTargets]      = useState(null); // cards for the WO date modal
  const [prodBatch,            setProdBatch]            = useState({ to: "", route: "" });
  const [view, setViewState] = useState(() => { try { return localStorage.getItem("df.view") || "design"; } catch { return "design"; } });
  const setView = (v) => { setViewState(v); try { localStorage.setItem("df.view", v); } catch { /* private mode */ } };
  const [graded,               setGraded]               = useState([]);
  const [sendGradeEmailsBusy,  setSendGradeEmailsBusy]  = useState(false);
  const [sendGradeResult,      setSendGradeResult]      = useState(null);  // "ok" | "error" | null
  const [search,               setSearch]               = useState("");
  // Filter the whole board to one DT — shows at a glance where each of their drawings sits.
  const [dtFilter,             setDtFilter]             = useState("");
  const [density,              setDensity]              = useState("comfortable");

  // Ingest notifications — separate from the queue data above. Backed by
  // GET/POST /api/df/notifications (see drawing-flow.js), this is a heads-up feed of
  // every ingest outcome (created / skipped / errored) so it's obvious the Dropbox
  // trigger actually ran, without digging through Make/Netlify logs.
  const [notifications,        setNotifications]        = useState([]);
  const [notifOpen,            setNotifOpen]            = useState(false);
  const [toasts,               setToasts]               = useState([]);

  // Multi-select: single Set shared across all sections; sections filter to their own IDs
  const [selectedIds, setSelectedIds] = useState(new Set());

  const knownIds = useRef(new Set());
  const notifGranted = useRef(false);
  const seenNotifIds  = useRef(new Set());
  const notifInitDone = useRef(false);

  const toggleSelect = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // ── Notification permission ──────────────────────────────────────────────
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then((p) => {
        notifGranted.current = p === "granted";
      });
    } else {
      notifGranted.current = Notification.permission === "granted";
    }
  }, []);

  const notify = (count) => {
    if (!notifGranted.current) return;
    new Notification("Axiom Drawing Flow", {
      body: count === 1
        ? "1 new drawing submission waiting for QA review"
        : `${count} new drawing submissions waiting for QA review`,
      icon: "/favicon.ico",
    });
  };

  // ── Fetch ────────────────────────────────────────────────────────────────
  const consecutiveErrors = React.useRef(0);
  const prodStagesRef = React.useRef(null);

  // Chunked fetch — one small request per status group instead of a single monolithic
  // /api/df/queue call. The old approach ran ~10-15 sequential Notion queries inside one
  // Lambda invocation (with artificial gaps to dodge rate limiting), which on larger queues
  // ran past Netlify's function timeout and came back as a 502. Splitting into per-status
  // requests keeps each Lambda invocation short; a small stagger on kickoff (rather than
  // firing all 7 at once) keeps the aggregate Notion call rate reasonable.
  // Schedule and Complete only matter to the Production tab: old-flow A4.5 sign-offs were
  // written as Schedule, and Complete rows are what close a drawing (and supersede older rows).
  const STATUS_FETCHES = [
    "Submitted", "Rejected", "Approved", "Awaiting Issue", "Issued", "Graded", "Schedule", "Complete",
  ];

  const fetchQueue = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      // One retry on failure — a 500 here is usually a transient Notion rate-limit
      // blip (bursty concurrent lookups within a single status group), not a real
      // fault, and clears on its own a second later.
      const fetchWithRetry = async (url, label) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await fetch(url);
          if (res.ok) return (await res.json()).submissions;
          if (attempt === 0) { await pause(1500); continue; }
          throw new Error(`API error ${res.status} (${label})`);
        }
      };
      const fetchStatus = async (status, i) => {
        await pause(i * 350);
        return fetchWithRetry(`/api/df/submissions?status=${encodeURIComponent(status)}`, status);
      };
      const fetchPending = async (i) => {
        await pause(i * 350);
        return fetchWithRetry("/api/df/submissions?status=pending-notification", "pending");
      };

      const stagesP = fetch("/api/df/production-stages").then((r) => (r.ok ? r.json() : { stages: null })).catch(() => ({ stages: null }));
      const [subs, bounced_, approved_, await_, iss, graded_, sched_, complete_, pending] = await Promise.all([
        ...STATUS_FETCHES.map((s, i) => fetchStatus(s, i)),
        fetchPending(STATUS_FETCHES.length),
      ]);

      const newOnes = subs.filter((s) => !knownIds.current.has(s.id));
      if (newOnes.length && knownIds.current.size > 0) notify(newOnes.length);
      subs.forEach((s) => knownIds.current.add(s.id));

      // Column 1 is "what is with the DT": every drawing whose CURRENT submission hands it
      // back to them — a QA bounce, or a client grade of B / C / Rejected / QA Rejected.
      // Both clear themselves the moment the new rev lands, because a resubmission becomes
      // the current submission for that drawing and moves it to Awaiting Review.
      //
      // Superseding has to rank stage before QA round, which is why this defers to
      // latestPerDrawing() rather than comparing rounds: a drawing graded at S4 R2 and
      // resubmitted at S5 R1 is no longer with the DT even though 1 < 2. A submission with
      // no Drawing relation keys on its own id there, so it survives as itself.
      const current = DFLanes
        ? DFLanes.latestPerDrawing([...subs, ...bounced_, ...approved_, ...await_, ...iss, ...graded_, ...sched_, ...complete_])
        : [];
      // A failed stage lookup keeps the last good set rather than emptying the tab.
      const stagesRes = await stagesP;
      const stages = stagesRes.stages || prodStagesRef.current || {};
      prodStagesRef.current = stages;
      setProdStages(stages);
      if (stagesRes.routes) setProdRoutes(stagesRes.routes);
      const stageOf = (s) => (stages[(s.drawingIds || [])[0]] || {}).stage || null;
      setProduction(current
        .filter((s) => DFLanes.phaseOf(s, stageOf(s)) === "production")
        .map((s) => {
          const ps = stageOf(s), itemId = (s.taskIds || [])[0];
          const supplyDone = ps === "Awaiting Supply Drawings" && itemId ? DFLanes.supplyDoneFor(itemId, current, stageOf) : false;
          return { ...s, prodStage: ps, prodLog: (stages[(s.drawingIds || [])[0]] || {}).log || "",
                   supplyDone, prodLane: DFLanes.productionLaneOf(s, ps, { supplyDone }) };
        })
        .filter((s) => s.prodLane));

      setSubmitted(subs);
      setWithDT(current.filter((s) => DFLanes.laneOf(s) === "resubmission"));
      // Parked work, at whatever stage it was parked. Same current-state basis as column 1,
      // so a blocked drawing that has since been superseded does not linger here either.
      setBlockedItems(current.filter((s) => DFLanes.laneOf(s) === "blocked"));
      setAwaitingIssue([...approved_, ...await_]);
      setIssued(iss);
      setPendingNotification(pending);
      setGraded(graded_.filter((s) => !s.dtNotified));
      setLastPoll(new Date());
      consecutiveErrors.current = 0;
    } catch (err) {
      consecutiveErrors.current += 1;
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
    // Back off polling after repeated failures: 30s normally, 5min after 3+ errors.
    // Also skip ticks entirely while the tab is hidden or the browser is offline — a
    // cockpit tab left open unattended (overnight, over a weekend) was previously
    // polling nonstop regardless, racking up thousands of requests for no one to see.
    // This does NOT touch Make — this loop only ever calls /api/df/submissions?status=X,
    // which reads Notion. Make scenarios only fire from explicit button clicks
    // (Scan Comments / Scan Uploads / Send DT / Grade Emails) or the approve/bounce/
    // issue/log-status actions, never from this poll.
    const schedule = () => {
      const delay = consecutiveErrors.current >= 3 ? 300_000 : 30_000;
      return setTimeout(runPoll, delay);
    };
    const runPoll = () => {
      if (document.hidden || !navigator.onLine) { timerRef.current = schedule(); return; }
      fetchQueue(true);
      timerRef.current = schedule();
    };
    const timerRef = { current: schedule() };

    // Catch up immediately on regaining focus/connectivity rather than waiting out
    // whatever's left of the current interval — keeps the board fresh the moment
    // someone actually looks at it again, without polling the whole time it was hidden.
    const onVisible = () => { if (!document.hidden) fetchQueue(true); };
    const onOnline  = () => fetchQueue(true);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);

    return () => {
      clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [fetchQueue]);

  // ── Ingest notifications ─────────────────────────────────────────────────
  // Polls independently of the queue above — a lightweight feed, not project data.
  // On the very first load we just record what's already there as "seen" (no
  // toast storm for a backlog); only entries that show up on later polls toast.
  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch("/api/df/notifications");
      if (!res.ok) return;
      const body = await res.json();
      const list = body.notifications || [];

      if (!notifInitDone.current) {
        list.forEach((n) => seenNotifIds.current.add(n.id));
        notifInitDone.current = true;
        setNotifications(list);
        return;
      }

      const fresh = list.filter((n) => !seenNotifIds.current.has(n.id));
      if (fresh.length) {
        fresh.forEach((n) => seenNotifIds.current.add(n.id));
        setToasts((prev) => [...fresh, ...prev]);
        fresh.forEach((n) => {
          setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== n.id)), 8000);
        });
      }
      setNotifications(list);
    } catch (_err) { /* best-effort — not core polling, fail silently */ }
  }, []);

  useEffect(() => {
    fetchNotifications();
    const id = setInterval(() => {
      if (document.hidden || !navigator.onLine) return;
      fetchNotifications();
    }, 30_000);
    return () => clearInterval(id);
  }, [fetchNotifications]);

  const handleClearNotifications = async () => {
    setNotifications([]);
    setNotifOpen(false);
    try {
      await fetch("/api/df/notifications/clear", { method: "POST" });
    } catch (_err) { /* best-effort */ }
  };

  const notifIcon = (type) => (type === "success" ? "✓" : type === "skip" ? "⏭" : "⚠");

  // ── Individual actions ───────────────────────────────────────────────────
  const handleApprove = async (id) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/df/submissions/${id}/approve`, { method: "PATCH" });
      if (!res.ok) {
        const body = await res.json();
        alert(`Approve failed: ${body.error || res.statusText}`);
      } else {
        await fetchQueue(true);
      }
    } catch (err) {
      alert(`Approve error: ${err.message}`);
    } finally {
      setBusy(null);
    }
  };

  const handleBounce = async (id) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/df/submissions/${id}/bounce`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json();
        alert(`Bounce failed: ${body.error || res.statusText}`);
      } else {
        await fetchQueue(true);
      }
    } catch (err) {
      alert(`Bounce error: ${err.message}`);
    } finally {
      setBusy(null);
    }
  };

  const handleIssue = async (id, force = false) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/df/submissions/${id}/issue`, {
        method: "PATCH",
        ...(force ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) } : {}),
      });
      if (!res.ok) {
        const body = await res.json();
        alert(`Issue failed: ${body.error || res.statusText}${body.detail ? `\n(${body.detail})` : ""}`);
      } else {
        await fetchQueue(true);
      }
    } catch (err) {
      alert(`Issue error: ${err.message}`);
    } finally {
      setBusy(null);
    }
  };

  const handleLogStatus = async (id, grade, returnDate, comment) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/df/submissions/${id}/log-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grade, ...(returnDate ? { returnDate } : {}), ...(comment ? { comment } : {}) }),
      });
      if (!res.ok) {
        const body = await res.json();
        alert(`Log Status failed: ${body.error || res.statusText}`);
      } else {
        await fetchQueue(true);
      }
    } catch (err) {
      alert(`Log Status error: ${err.message}`);
    } finally {
      setBusy(null);
    }
  };

  // ── Batch actions ────────────────────────────────────────────────────────
  // What each batch action leaves behind. A refusal naming exactly that state is not a
  // failure, it is the same work arriving twice — the row is already where the click was
  // trying to put it. Reporting that as an error sends you looking for damage that is not
  // there, which is how a successful bounce came to look like a broken one.
  const SETTLED_STATE = { bounce: "Rejected", approve: "Approved", issue: "Issued" };

  const runBatch = async (ids, apiPath, method = "PATCH", body = null) => {
    if (!ids.length) return;
    setBatchBusy(true);
    try {
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const res = await fetch(`/api/df/submissions/${id}/${apiPath}`, {
            method,
            headers: body ? { "Content-Type": "application/json" } : undefined,
            body:    body ? JSON.stringify(body) : undefined,
          });
          if (res.ok) return null;
          // The routes answer a refusal with { error } naming the state the row was in.
          // Carrying that out of here is the difference between "something failed" and
          // "this drawing was already Rejected".
          const detail = await res.json().catch(() => ({}));
          const msg    = detail.error || res.statusText || `HTTP ${res.status}`;
          const settled = SETTLED_STATE[apiPath];
          if (settled && new RegExp(`\\b${settled}\\b`).test(msg)) return "already";
          throw new Error(msg);
        })
      );
      // Name what went wrong per drawing rather than a count and "check console". A batch
      // is partly-applied by nature — the rows that were in the right state have already
      // gone through — so the message has to say which ones did not and why.
      const failed = results
        .map((r, i) => (r.status === "rejected" ? { id: ids[i], why: r.reason?.message || "Failed" } : null))
        .filter(Boolean);
      if (failed.length) {
        const cards = BOARD.flatMap((c) => c.items);
        const name  = (id) => { const c = cards.find((x) => x.id === id); return (c && (c.drawingNo || c.title)) || id; };
        alert(`${ids.length - failed.length} of ${ids.length} went through.\n\nThese did not:\n` +
              failed.map((f) => `\u2022 ${name(f.id)} — ${f.why}`).join("\n"));
      }
      // Rows that were already in the target state are counted as done and raise nothing:
      // the board refreshes below and shows them where they belong.
      clearSelection();
      await fetchQueue(true);
    } catch (err) {
      alert(`Batch error: ${err.message}`);
    } finally {
      setBatchBusy(false);
    }
  };

  // One drawing's grade, returning null on success or a message on failure, so the batch
  // modal can name what went wrong per drawing instead of counting anonymous failures.
  const runOneGrade = async (id, grade, returnDate, comment) => {
    try {
      const res = await fetch(`/api/df/submissions/${id}/log-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grade, ...(returnDate ? { returnDate } : {}), ...(comment ? { comment } : {}) }),
      });
      if (res.ok) return null;
      const body = await res.json().catch(() => ({}));
      return body.error || res.statusText || `HTTP ${res.status}`;
    } catch (err) {
      return err.message || "Network error";
    }
  };

  const closeBatchGrade = async () => {
    setBatchGradeTargets(null);
    clearSelection();
    await fetchQueue(true);
  };

  const handleBatchApprove = (ids) => runBatch(ids, "approve");
  const handleBatchBounce  = (ids) => runBatch(ids, "bounce", "PATCH", {});
  const handleBatchIssue   = (ids) => runBatch(ids, "issue");
  const handleBatchHold    = (ids) => runBatch(ids, "hold", "PATCH", { blocked: true });

  // ── Send DT emails ───────────────────────────────────────────────────────
  // `ids`, when passed, scopes the send to those checkbox-selected cards only — this used
  // to be ignored entirely (checkboxes existed but the button always sent the whole column).
  // No ids (or an empty selection) preserves the old "send everything in this column" default.
  const handleSendDTEmails = async (ids) => {
    setSendEmailBusy(true);
    setSendEmailResult(null);
    try {
      const scoped = Array.isArray(ids) && ids.length > 0;
      const res = await fetch("/api/df/send-dt-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scoped ? { submissionIds: ids } : {}),
      });
      const body = await res.json();
      if (!res.ok) {
        alert(`Send emails failed: ${body.error || res.statusText}`);
        setSendEmailResult("error");
      } else {
        setSendEmailResult("ok");
        if (scoped) {
          // Only drop the items actually sent — leave the rest of the column as-is.
          const sent = new Set(ids);
          setPendingNotification((prev) => prev.filter((s) => !sent.has(s.id)));
          setSelectedIds((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; });
        } else {
          // Remove notified items from pending list immediately (no wait for next poll)
          setPendingNotification([]);
        }
        // Refresh queue in background to catch any state changes
        fetchQueue(true);
      }
    } catch (err) {
      alert(`Send emails error: ${err.message}`);
      setSendEmailResult("error");
    } finally {
      setSendEmailBusy(false);
      // Clear "Sent!" confirmation after 4s
      setTimeout(() => setSendEmailResult(null), 4000);
    }
  };

  const handleSendGradeEmails = async (ids) => {
    setSendGradeEmailsBusy(true);
    setSendGradeResult(null);
    try {
      const scoped = Array.isArray(ids) && ids.length > 0;
      const res  = await fetch("/api/df/send-grade-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scoped ? { submissionIds: ids } : {}),
      });
      const body = await res.json();
      if (!res.ok) {
        alert(`Send grade emails failed: ${body.error || res.statusText}`);
        setSendGradeResult("error");
      } else {
        setSendGradeResult("ok");
        if (scoped) {
          const sent = new Set(ids);
          setGraded((prev) => prev.filter((s) => !sent.has(s.id)));
          setSelectedIds((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; });
        } else {
          setGraded([]);
        }
        fetchQueue(true);
      }
    } catch (err) {
      alert(`Send grade emails error: ${err.message}`);
      setSendGradeResult("error");
    } finally {
      setSendGradeEmailsBusy(false);
      setTimeout(() => setSendGradeResult(null), 4000);
    }
  };

  // Production-tab moves. Each writes the drawing's MDS Production Stage (and the dates
  // that go with it) via POST /api/df/drawings/:id/production. Complete and Move back ask first.
  const PROD_CONFIRM = {
    "Complete": "Mark this drawing Complete? It drops off the Production tab.",
    "back":     "Move this drawing back to where it was before the last move?",
  };
  const moveOne = async (s, to, extra = {}) => {
    const drawingId = (s.drawingIds || [])[0];
    if (!drawingId) return { ok: false, error: "no drawing linked" };
    const res  = await fetch(`/api/df/drawings/${drawingId}/production`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, ...extra }),
    });
    const body = await res.json().catch(() => ({}));
    return res.ok ? { ok: true } : { ok: false, error: body.error || res.statusText };
  };
  const handleProduction = async (s, to) => {
    if (PROD_CONFIRM[to] && !window.confirm(`${s.drawingNo || s.title}: ${PROD_CONFIRM[to]}`)) return;
    setBusy(s.id);
    try {
      const r = await moveOne(s, to);
      if (!r.ok) alert(`Not moved: ${r.error}`);
      await fetchQueue(true);
    } catch (err) {
      alert(`Not moved: ${err.message}`);
    } finally {
      setBusy(null);
    }
  };
  // One after another, so Notion's rate limit is never hit; failures are listed at the end.
  const runProdBatch = async (cards, fn, label) => {
    setBatchBusy(true);
    const failed = [];
    for (const s of cards) {
      try { const r = await fn(s); if (r && r.ok === false) failed.push(`${s.drawingNo || s.title}: ${r.error}`); }
      catch (err) { failed.push(`${s.drawingNo || s.title}: ${err.message}`); }
    }
    setBatchBusy(false);
    setSelectedIds(new Set());
    await fetchQueue(true);
    if (failed.length) alert(`${label}: ${cards.length - failed.length} of ${cards.length} done.\n\n${failed.join("\n")}`);
  };
  const scheduleCards = (cards, woDate) => runProdBatch(cards, (s) => moveOne(s, "In Production", { woDate }), "Scheduled");
  const setRoute = async (itemIds, route) => {
    const ids = [...new Set(itemIds.filter(Boolean))];
    if (!ids.length) { alert("No item linked."); return; }
    setBatchBusy(true);
    const failed = [];
    for (const id of ids) {
      const res = await fetch(`/api/df/items/${id}/route`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ route }) });
      if (!res.ok) failed.push(id);
    }
    setBatchBusy(false);
    setProdRoutes((m) => { const n = { ...m }; ids.forEach((id) => { if (!failed.includes(id)) n[id] = route || undefined; }); return n; });
    if (failed.length) alert(`Route not saved on ${failed.length} item(s).`);
  };

  const handleHold = async (id, currentBlocked) => {
    const blocked = !currentBlocked;
    setBusy(id);
    try {
      const res  = await fetch(`/api/df/submissions/${id}/hold`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocked }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Hold failed: ${body.error || res.statusText}`);
        return;
      }
      await fetchQueue(true);
    } catch (err) {
      alert(`Hold toggle error: ${err.message}`);
    } finally {
      setBusy(null);
    }
  };

  // Trigger on-demand client-comment ingest (Make cr-ingest), then refresh the Issued queue.
  const handleScanComments = async () => {
    setScanCommentsBusy(true);
    setScanCommentsResult(null);
    try {
      const res = await fetch("/api/df/scan-comments", { method: "POST" });
      if (!res.ok) {
        setScanCommentsResult("error");
        setScanCommentsBusy(false);
        setTimeout(() => setScanCommentsResult(null), 8000);
        return;
      }
      setScanCommentsResult("ok");
      // Give Make ~8s to list folders + write properties, then refresh so badges appear.
      setTimeout(() => { fetchQueue(true); setScanCommentsBusy(false); setScanCommentsResult(null); }, 8000);
    } catch (err) {
      setScanCommentsResult("error");
      setScanCommentsBusy(false);
      setTimeout(() => setScanCommentsResult(null), 8000);
    }
  };

  const handleScanPending = async () => {
    setScanning(true);
    setScanResult(null);
    setScanError(null);
    try {
      const res  = await fetch("/api/df/scan-pending", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setScanResult("error");
        setScanError(body.error || `HTTP ${res.status}`);
        setScanning(false);
        setTimeout(() => setScanResult(null), 8000);
        return;
      }
      setScanResult("ok");
      // Give Make ~8s to run before refreshing queue
      setTimeout(() => { fetchQueue(true); setScanning(false); setScanResult(null); }, 8000);
    } catch (err) {
      setScanResult("error");
      setScanError(err.message || "Network error");
      setScanning(false);
      setTimeout(() => setScanResult(null), 8000);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  // A4.5 sits with the contractor for sign-off, PRD with the factory — both land in the
  // Awaiting Sign-Off column rather than Awaiting Comments.
  const isSignOffStage   = (s) => s.stage === "A4.5" || s.stage === "PRD";
  const commentItems     = issued.filter((s) => s.hasComments);
  const signoffItems     = issued.filter((s) => isSignOffStage(s) && !s.hasComments);
  const awaitingComments = issued.filter((s) => !isSignOffStage(s) && !s.hasComments);
  const reviewedNotify   = pendingNotification.filter((s) => s.status === "Approved" || s.status === "Rejected");
  // Checkbox-selected cards, scoped to each of these two columns — an empty result means
  // "nothing selected in this column", which the send handlers treat as "send everything".
  const reviewedSelectedIds = reviewedNotify.filter((s) => selectedIds.has(s.id)).map((s) => s.id);
  const gradedSelectedIds   = graded.filter((s) => selectedIds.has(s.id)).map((s) => s.id);
  // Batch grading works off the Issued pool — the only cards that carry a Grade button at
  // all. Anything else caught in the selection (Submitted, Approved, Awaiting Issue) is
  // left alone rather than quietly pushed through log-status, which does not check status.
  const gradeSelected = issued.filter((s) => selectedIds.has(s.id));
  const gradeFamilyOf = (s) => (["A4.5", "PRD", "AB"].includes(s.stage) ? "sign-off" : "abc");
  const gradeFamilies = [...new Set(gradeSelected.map(gradeFamilyOf))];
  // A mixed selection is refused rather than part-graded: the two families do not share a
  // grade vocabulary, so there is no single button that means the right thing for both.
  const batchGradeBlocked =
    gradeSelected.length === 0
      ? "Select Issued drawings to grade — nothing else can be"
      : gradeFamilies.length > 1
        ? "Mixed stages: S4/S5 grade A/B/C/NA, A4.5/PRD/AB grade Approved/Rejected — narrow the selection to one or the other"
        : null;
  // Approved drawings only enter the Awaiting-Issue column once the DT has been notified;
  // until their DWGs are uploaded (Make flips status → "Awaiting Issue") the Issue button stays grey.
  const approvedItems    = awaitingIssue.filter((s) => s.status === "Awaiting Issue" || s.dtNotified);
  const total = submitted.length + awaitingIssue.length + issued.length + graded.length;
  const overdueCount = [...submitted, ...awaitingIssue, ...issued, ...graded]
    .filter((s) => (daysSince(s.bicSince) ?? 0) > 14).length;

  const scanPendingLabel  = scanning && scanResult !== "error" ? "Scanning…" : "⟳ Scan Pending";
  const scanUploadsLabel  = scanning && scanResult !== "error" ? "Scanning…" : "⟳ Scan Uploads";
  const scanCommentsLabel = scanCommentsBusy && scanCommentsResult !== "error" ? "💬 Ingesting…" : "💬 Scan Comments";
  const sendDtLabel       = sendEmailBusy ? "Sending…" : "✉ Send DT Email";
  const sendGradeLabel    = sendGradeEmailsBusy ? "Sending…" : "✉ Send DT Email";

  // A blocked drawing has its own column, so it must not also sit in the pipeline column it
  // was parked from — otherwise it is counted twice and still reads as someone's to action.
  // withDT and blockedItems already come from laneOf, which routes blocked first.
  const unparked = (arr) => arr.filter((s) => !s.blocked);

  const COLS = [
    { id: "resubmission", title: "Resubmission — With DT", accent: "var(--danger)",
      sub: "Awaiting a new revision · bounced at QA or graded back by the client", items: withDT },
    { id: "submitted", title: "Submitted — Awaiting Review", accent: "var(--info)", sub: "Review in Drawboard · sync before Approve / Bounce", items: unparked(submitted),
      action: { label: scanPendingLabel, onClick: handleScanPending, disabled: scanning } },
    { id: "reviewed", title: "Reviewed — Notify DT", accent: "var(--ok)", sub: "Approved / bounced — awaiting DT email", items: unparked(reviewedNotify),
      action: { label: sendDtLabel, disabled: sendEmailBusy, count: reviewedSelectedIds.length || reviewedNotify.length,
        onClick: () => handleSendDTEmails(reviewedSelectedIds) } },
    { id: "approved", title: "Approved — Awaiting Issue", accent: "var(--ok)", sub: "DT notified · awaiting DWG upload, then issue", items: unparked(approvedItems),
      action: { label: scanUploadsLabel, onClick: handleScanPending, disabled: scanning } },
    { id: "awaiting-comments", title: "Issued — Awaiting Comments", accent: "var(--info)", sub: "Out with the client or supplier, awaiting comments", items: unparked(awaitingComments) },
    { id: "comments", title: "Issued — Review Client Comments", accent: "var(--grade)", sub: "Review in Drawboard, then grade", items: unparked(commentItems),
      action: { label: scanCommentsLabel, onClick: handleScanComments, disabled: scanCommentsBusy, count: commentItems.length } },
    { id: "signoff", title: "Issued — Awaiting Sign-Off", accent: "var(--warn)", sub: "A4.5 with client · PRD with factory", items: unparked(signoffItems) },
    { id: "graded", title: "Graded — Notify DT", accent: "var(--accent)", sub: "Notion · DT Notified unchecked", items: unparked(graded),
      action: { label: sendGradeLabel, disabled: sendGradeEmailsBusy, count: gradedSelectedIds.length || graded.length,
        onClick: () => handleSendGradeEmails(gradedSelectedIds) } },
    { id: "blocked", title: "Blocked — Awaiting Info", accent: "var(--warn)",
      sub: "Parked by Hold · not waiting on the DT or the DM", items: blockedItems },
  ];

  // The main board is design only: a drawing past A4.5 sign-off lives on the Production tab.
  const stageOfCard = (s) => (prodStages[(s.drawingIds || [])[0]] || {}).stage || null;
  if (DFLanes) COLS.forEach((c) => { c.items = c.items.filter((s) => DFLanes.phaseOf(s, stageOfCard(s)) !== "production"); });

  // Production tab. Each card keeps the action its submission would have on the main board
  // (Approve / Bounce / Issue / Grade), found from its main-board lane; emails are sent from
  // the column head, scoped to that column's cards so nothing else goes out.
  const nativeLane = (s) => (DFLanes ? DFLanes.laneOf(s) : null);
  const prodIn = (id) => production.filter((s) => s.prodLane === id);
  const PROD_COLS = DFLanes ? DFLanes.PRODUCTION_LANES.map((l) => {
    const items = prodIn(l.id);
    const toNotify = items.filter((s) => nativeLane(s) === "reviewed").map((s) => s.id);
    const toGrade  = items.filter((s) => nativeLane(s) === "graded").map((s) => s.id);
    return {
      id: l.id, title: l.title, sub: l.sub, items, accent: `var(--${l.accent})`, production: true,
      action: toNotify.length ? { label: sendDtLabel, disabled: sendEmailBusy, count: toNotify.length, onClick: () => handleSendDTEmails(toNotify) } : null,
      action2: toGrade.length ? { label: sendGradeLabel, disabled: sendGradeEmailsBusy, count: toGrade.length, onClick: () => handleSendGradeEmails(toGrade) } : null,
    };
  }) : [];
  const BOARD = view === "production" ? PROD_COLS : COLS;
  const productionCount = production.length;

  // The bulk bar floats over the whole board, so one selection can span columns — and these
  // actions are not interchangeable. Firing every one of them at everything selected is
  // what produced a 409 from the rows that were never in the right state, after the
  // eligible ones had already moved: the batch half-worked and the alert only said a count.
  // Each action is now scoped to the cards it actually applies to — the same care the Grade
  // button already takes — and its button carries the count, so what will move is visible
  // before the click. The server-side status guards stay as the backstop.
  const selectedCards = BOARD.flatMap((c) => c.items).filter((s) => selectedIds.has(s.id));
  const idsOf         = (arr) => arr.map((s) => s.id);
  // Approve and Bounce are the two outcomes of reviewing a submission, so both want the
  // same pool: a drawing that is actually sitting in review, and not parked on hold.
  const reviewableSel = idsOf(selectedCards.filter((s) => s.status === "Submitted" && !s.blocked));
  // Issue needs the DWGs uploaded first, which is exactly what Awaiting Issue means — an
  // Approved card still waiting on the DT is not ready and the route refuses it.
  const issuableSel   = idsOf(selectedCards.filter((s) => s.status === "Awaiting Issue" && !s.blocked));
  // Hold parks a card; one already parked has nothing to do.
  const holdableSel   = idsOf(selectedCards.filter((s) => !s.blocked));

  const q = search.trim().toLowerCase();
  const matchSearch = (s) => !q || `${s.drawingNo || ""} ${s.title || ""} ${s.taskCode || ""} ${s.dtName || ""}`.toLowerCase().includes(q);

  // Every DT with something on the board, plus a bucket for cards with no DT set.
  const UNASSIGNED = "— No DT —";
  const dtNames = Array.from(new Set(
    BOARD.flatMap((c) => c.items).map((s) => s.dtName || UNASSIGNED)
  )).sort((a, b) => (a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : a.localeCompare(b)));
  const matchDT = (s) => !dtFilter || (s.dtName || UNASSIGNED) === dtFilter;
  const matches = (s) => matchSearch(s) && matchDT(s);
  const dtTotal = dtFilter ? BOARD.reduce((n, c) => n + c.items.filter(matches).length, 0) : 0;

  const statusPill = (colId, s) => {
    switch (colId) {
      // Same column, three routes in — the pill says which, so it is obvious whether the DT
      // is reworking a QA bounce, incorporating the client's comments, or drawing the next
      // stage after a clean grade. The third is not rework: an NA at S5 signs S5 off and
      // hands over the A4.5 set, so labelling it "rev due" would read as a drawing that
      // came back when it did not.
      case "resubmission":      return s.status !== "Graded"
        ? { cls: "danger", txt: `R${s.qaRound ?? "?"} Bounced` }
        : (DFLanes && DFLanes.needsRevision(s.clientGrade))
          ? { cls: "grade", txt: `Grade ${s.clientGrade || "—"} · rev due` }
          : { cls: "ok",    txt: `Grade ${s.clientGrade || "—"} · next stage` };
      case "submitted":         return { cls: "info",  txt: "Submitted" };
      case "reviewed":          return s.status === "Rejected" ? { cls: "danger", txt: "Bounced" } : { cls: "ok", txt: "Approved" };
      // A no-approval drawing is issued to a supplier and completed in the same press, so
      // the pill says so before you reach for the button.
      case "approved":          return s.status !== "Awaiting Issue" ? { cls: "warn", txt: "Awaiting DT Upload" }
                                     : s.noClientApproval            ? { cls: "ok",   txt: "Issue → Supplier" }
                                     :                                 { cls: "ok",   txt: "Ready to Issue" };
      // A supplier issue is not waiting on client comments — it is sitting with the
      // supplier. Same column, different thing, so the pill says which.
      case "awaiting-comments": return s.noClientApproval
        ? { cls: "info", txt: "With Supplier" }
        : { cls: "info", txt: "Issued" };
      case "comments":          return { cls: "grade", txt: "Review Comments" };
      case "signoff":           return { cls: "warn",  txt: "Sign-Off" };
      case "graded":            return { cls: "grade", txt: "Grade " + (s.clientGrade || "—") };
      // The column no longer tells you where it was parked from, so the pill does.
      case "blocked":           return { cls: "warn",  txt: "On Hold · " + (s.status || "—") };
      default:                  return { cls: "info",  txt: "" };
    }
  };

  // Every card gets a Hold/Unblock action; some stages add a primary action too.
  const cardActions = (colId, s) => {
    const isBusy = busy === s.id;
    const hold = (
      <button className="k-act" disabled={isBusy}
        onClick={(e) => { e.stopPropagation(); handleHold(s.id, s.blocked); }}
        title={s.blocked ? "Remove hold" : "Put on hold (RFI / Design Change)"}>
        {isBusy ? "…" : (s.blocked ? "Unblock" : "Hold")}
      </button>
    );
    let primary = null;
    if (colId === "submitted") primary = (
      <>
        <button className="k-act go" disabled={isBusy} onClick={(e) => { e.stopPropagation(); handleApprove(s.id); }}>{isBusy ? "…" : "Approve"}</button>
        <button className="k-act" disabled={isBusy} onClick={(e) => { e.stopPropagation(); setBounceTarget(s); }}>Bounce</button>
      </>
    );
    else if (colId === "approved") {
      const ready = s.status === "Awaiting Issue"; // DWGs uploaded → Issue enabled (blue)
      // Not-ready cards stay secondary rather than disabled: some drawings have no DWGs
      // coming at all, and the modal is where the DM confirms that.
      primary = (
        <button className={`k-act${ready ? " go" : ""}`} disabled={isBusy}
          onClick={(e) => { e.stopPropagation(); setIssueTarget(s); }}
          title={!ready ? "No DWGs uploaded yet — open to issue anyway if none are coming"
               : s.noClientApproval ? "Issue to the supplier — no client approval, marks the drawing Complete"
               : "Issue the drawing"}>Issue</button>
      );
    }
    // Client comments are reviewed in Drawboard, then graded here — Log Status moves the
    // comment PDFs to 05_Client Comments/Reviewed/R_… (the Comment Reviewer app is retired).
    // "Awaiting Comments" also gets Grade: a client who returns Status A (approved, no
    // mark-ups) sends no comment PDF, so the card never moves to Review Client Comments
    // and would otherwise sit there forever. Grade is secondary (not "go") there, since the
    // normal path is still to wait for comments.
    else if (colId === "signoff" || colId === "comments" || colId === "awaiting-comments") primary = (
      <button className={`k-act${colId === "awaiting-comments" ? "" : " go"}`}
        onClick={(e) => { e.stopPropagation(); setLogStatusTarget(s); }}
        title={colId === "comments" ? "Review the comment PDF in Drawboard, then grade"
             : colId === "awaiting-comments" ? (s.noClientApproval
                 ? "Close it off — issued to the supplier, no comments expected"
                 : "Log the client grade (no comments received — e.g. Status A)")
             : "Log the client grade"}>Grade</button>
    );
    return (<>{primary}{hold}</>);
  };

  // Production cards: the pill says where in the cycle the drawing is; the AB review column
  // borrows the main-board pill, since those cards are moving through the normal flow.
  const routeOf = (s) => prodRoutes[(s.taskIds || [])[0]] || null;
  const prodPill = (colId, s) => {
    switch (colId) {
      case "signed-off":        return { cls: "ok", txt: DFLanes.isLegacySignOff(s) ? "A4.5 signed off (old flow)" : "A4.5 signed off" };
      case "awaiting-supply":   return { cls: "warn", txt: "Supply drawings in flow" };
      case "to-schedule":       return s.supplyDone ? { cls: "ok", txt: "Supply drawings signed off" } : { cls: "info", txt: "To schedule" };
      case "in-production":     return s.stage === "PRD" ? { cls: "grade", txt: "PRD signed off" }
                                     : { cls: "grade", txt: routeOf(s) === "Supply & Install" ? "With supplier (S&I)" : routeOf(s) === "Supply Only" ? "With supplier" : "In production" };
      case "awaiting-install":  return { cls: "info", txt: "Install only" };
      case "awaiting-as-built": return s.stage === "AB" ? { cls: "danger", txt: "As-built rejected · rev due" } : { cls: "warn", txt: "As-built owed" };
      default:                  return statusPill(nativeLane(s), s);
    }
  };
  const MOVE_LABEL = {
    "Awaiting Supply Drawings": ["Supply dwgs", "Supply drawings (PRD / sketches) are needed first"],
    "To Be Scheduled":          ["To schedule", "No supply drawings needed: ready to schedule"],
    "In Production":            ["To supplier", "Supply & Install: straight to the supplier, no factory"],
    "Awaiting Install":         ["Await install", "Install only (or a site drawing): waiting to be fitted"],
  };
  const prodActions = (colId, s) => {
    const isBusy = busy === s.id;
    const btn = (to, label, title, go) => (
      <button key={to + label} className={`k-act${go ? " go" : ""}`} disabled={isBusy || batchBusy} title={title}
        onClick={(e) => { e.stopPropagation(); handleProduction(s, to); }}>{isBusy ? "…" : label}</button>
    );
    const isPrd = s.stage === "PRD";
    const route = routeOf(s);
    return (
      <>
        {colId === "signed-off" && (
          <select className="k-act" value={route || ""} disabled={batchBusy} title="Contract route for this item"
            onClick={(e) => e.stopPropagation()} onChange={(e) => setRoute([(s.taskIds || [])[0]], e.target.value)}>
            <option value="">Route…</option>
            {DFLanes.ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
        {colId === "signed-off" && route && DFLanes.ROUTE_MOVES[route].map((to, i) => btn(to, MOVE_LABEL[to][0], MOVE_LABEL[to][1], i === DFLanes.ROUTE_MOVES[route].length - 1))}
        {colId === "awaiting-supply" && btn("To Be Scheduled", "Supply done", "Supply drawings are done: ready to schedule", true)}
        {colId === "to-schedule" && (
          <button className="k-act go" disabled={isBusy || batchBusy} title="Enter the date the WO was raised"
            onClick={(e) => { e.stopPropagation(); setScheduleTargets([s]); }}>Scheduled…</button>
        )}
        {(colId === "in-production" || colId === "awaiting-install") && !isPrd && btn("Awaiting As Built", "Installed", "Installed on site: the as-built is now owed", true)}
        {colId === "in-production" && isPrd && btn("Complete", "Complete", "Close the PRD drawing (no as-built needed)", true)}
        {colId === "awaiting-as-built" && s.stage !== "AB" && btn("Complete", "Complete", "Close the drawing without an as-built through Drawing Flow")}
        {s.prodStage && s.prodLog && btn("back", "Move back", "Undo the last Production tab move")}
      </>
    );
  };

  const renderCard = (s, colId, prod) => {
    const age = daysSince(s.bicSince);
    const ageCls = age == null ? "" : age > 14 ? "r" : age > 7 ? "a" : "g";
    const sel = selectedIds.has(s.id);
    const pill = prod ? prodPill(colId, s) : statusPill(colId, s);
    const initials = (s.dtName || "").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "—";
    return (
      <div
        key={s.id}
        className={`k-card${sel ? " sel" : ""}${(age ?? 0) > 14 ? " overdue" : ""}${s.blocked ? " blocked" : ""}`}
        onClick={() => toggleSelect(s.id)}
      >
        <div className="k-card-top">
          <input type="checkbox" className="k-check" checked={sel}
            onChange={() => toggleSelect(s.id)} onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${s.drawingNo || s.title}`} />
          <div className="k-ref">
            <div className="k-code">{s.drawingNo || s.title}</div>
            {s.taskCode && <div className="k-title">{s.taskCode}</div>}
          </div>
        </div>
        <div className="k-meta">
          {s.stage && <span className="k-tag">{s.stage}</span>}
          {prod && routeOf(s) && <span className="k-tag" title="Contract route (item)">{routeOf(s)}</span>}
          {prod && DFLanes.isOutsourced(s.dtName) && <span className="k-pill warn" title={`Drawn by ${s.dtName}`}>Outsourced</span>}
          {s.revision && <span className="k-tag">{s.revision}</span>}
          <span className={`k-pill ${pill.cls}`}>{pill.txt}</span>
          {s.hasComments && <span className="k-pill danger">New ✦</span>}
          {s.blocked && colId !== "blocked" && <span className="k-pill warn">On Hold</span>}
          {colId === "resubmission" && s.revisionDue && (
            // Revision Due is written per drawing at bounce and at grade, so it needs no
            // lookup. There used to be a fallback here to the item's programme date, which
            // cost one Notion read per item on every 30-second poll and was a large part of
            // what rate-limited the cockpit into 500s. Rows actioned before Revision Due
            // existed simply show no chip, and gain one the next time they are actioned.
            <span className={`k-pill ${dueCls(s.revisionDue)}`}
              title={`Revision due ${shortDate(s.revisionDue)} — review date + the project's Revision Days`}>
              {dueLabel(s.revisionDue)}
            </span>
          )}
        </div>
        <div className="k-card-foot">
          <span className={`k-age ${ageCls}`}
            title={age == null ? "" : `${age} days ${colId === "resubmission" ? "with the DT" : "in stage"}`}>{age == null ? "—" : age + "d"}</span>
          <span className="k-ava" style={{ background: personColor(s.dtName) }} title={s.dtName || ""}>{initials}</span>
          <span className="k-cardact">{prod ? <>{cardActions(nativeLane(s), s)}{prodActions(colId, s)}</> : cardActions(colId, s)}</span>
        </div>
      </div>
    );
  };

  // Group a column's cards by project-suffix (taskCode), colour-coded by project.
  const renderColumnBody = (items, colId, prod) => {
    if (items.length === 0) return <div className="k-empty">{q ? "No matches in this stage" : "Nothing here — all clear"}</div>;
    const groups = groupByTask(items);
    return Object.entries(groups).map(([taskCode, rows]) => (
      <div key={taskCode} className="k-group" style={{ "--k-proj": projectColor(taskCode) }}>
        <div className="k-group-head">
          <span className="k-group-dot" aria-hidden="true" />{taskCode}<span className="k-group-n">{rows.length}</span>
        </div>
        {rows.map((s) => renderCard(s, colId, prod))}
      </div>
    ));
  };

  return (
    <div className="kanban" data-density={density}>
      <div className="k-header">
        <div className="k-kpis" role="group" aria-label="Queue summary">
          <div className="k-kpi"><span className="v">{total}</span><span className="l">In flow</span></div>
          <div className="k-kpi flag"><span className="v">{graded.length}</span><span className="l">Awaiting DT email</span></div>
          <div className="k-kpi alert"><span className="v">{overdueCount}</span><span className="l">Overdue &gt;14d</span></div>
          <div className="k-kpi"><span className="v">{commentItems.length}</span><span className="l">New comments</span></div>
        </div>
        <div className="k-clock">
          <span className="dot" aria-hidden="true" />
          {lastPoll ? `Updated ${lastPoll.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · auto-refresh 30s` : "Loading…"}
        </div>
      </div>

      <div className="k-toolbar" role="toolbar" aria-label="Cockpit actions">
        <div className="k-seg" role="group" aria-label="Board">
          <button aria-pressed={view === "design"} onClick={() => setView("design")}>Design</button>
          <button aria-pressed={view === "production"} onClick={() => setView("production")}
            title="Drawings past A4.5 sign-off: PRD, factory, production and as-built">Production · {productionCount}</button>
        </div>
        <input className="k-search" type="search" placeholder="Search drawing ref, title, DT…"
          value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search submissions" />
        <select className="k-dt-filter" value={dtFilter} onChange={(e) => setDtFilter(e.target.value)}
          aria-label="Filter the board by DT">
          <option value="">All DTs</option>
          {dtNames.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        {dtFilter && (
          <button className="k-dt-clear" onClick={() => setDtFilter("")}
            title={`Clear the DT filter — showing ${dtTotal} drawing(s) for ${dtFilter}`}>
            {dtFilter} · {dtTotal} in flow ✕
          </button>
        )}
        <div className="k-seg" role="group" aria-label="Density">
          <button aria-pressed={density === "comfortable"} onClick={() => setDensity("comfortable")}>Comfortable</button>
          <button aria-pressed={density === "compact"} onClick={() => setDensity("compact")}>Compact</button>
        </div>
        <div className="k-spacer" />
        {error && <span className="k-result error">Load failed</span>}
        {scanResult === "error" && <span className="k-result error">Scan failed</span>}
        {sendEmailResult === "ok" && <span className="k-result ok">Emails sent!</span>}
        {sendGradeResult === "ok" && <span className="k-result ok">Grade emails sent!</span>}
        {sendGradeResult === "error" && <span className="k-result error">Send failed</span>}
      </div>

      <div className="k-board" aria-label={view === "production" ? "Production board" : "Submissions board"}>
        {BOARD.map((col) => {
          const items = col.items.filter(matches);
          return (
            <div key={col.id} className="k-column" style={{ "--k-col-accent": col.accent }}>
              <div className="k-col-head">
                <div className="k-col-title">
                  <span className="k-swatch" aria-hidden="true" />
                  <h2>{col.title}</h2>
                  <span className="k-num">{items.length}</span>
                </div>
                <div className="k-col-sub"><span>{col.sub}</span></div>
                {col.action && (
                  <button className="k-col-btn" onClick={col.action.onClick} disabled={col.action.disabled}>
                    {col.action.label}
                    {col.action.count != null && col.action.count > 0 && <span className="k-count">{col.action.count}</span>}
                  </button>
                )}
                {col.action2 && (
                  <button className="k-col-btn" onClick={col.action2.onClick} disabled={col.action2.disabled}>
                    {col.action2.label}
                    {col.action2.count > 0 && <span className="k-count">{col.action2.count}</span>}
                  </button>
                )}
              </div>
              <div className="k-col-body">
                {renderColumnBody(items, col.id, col.production)}
              </div>
            </div>
          );
        })}
      </div>

      {view === "production" && selectedIds.size > 0 && (() => {
        const sel = production.filter((s) => selectedIds.has(s.id));
        const toSchedule = sel.filter((s) => s.prodLane === "to-schedule");
        const canBack = sel.filter((s) => s.prodStage && s.prodLog);
        const stageOpts = ["Awaiting Supply Drawings", "To Be Scheduled", "In Production", "Awaiting Install", "Awaiting As Built", "Complete"];
        return (
          <div className="k-bulkbar">
            <span className="k-bulk-n">{sel.length}</span><span className="k-bulk-lbl">selected</span>
            {batchBusy && <span className="k-bulk-lbl" style={{ color: "var(--accent)" }}>Working…</span>}
            <button className="k-btn" onClick={clearSelection} disabled={batchBusy}>Clear</button>
            <select className="k-btn" value={prodBatch.to} disabled={batchBusy} aria-label="Move ticked drawings to"
              onChange={(e) => setProdBatch((b) => ({ ...b, to: e.target.value }))}>
              <option value="">Move to…</option>
              {stageOpts.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <button className="k-btn" disabled={batchBusy || !prodBatch.to || !sel.length}
              title={prodBatch.to === "In Production" ? "Cards in To be scheduled get the WO date prompt; the rest move straight across" : ""}
              onClick={() => {
                const to = prodBatch.to;
                if (to === "Complete" && !window.confirm(`Mark ${sel.length} drawing(s) Complete?`)) return;
                // Any card coming out of To be scheduled needs the WO date, so the whole selection goes through the date prompt.
                if (to === "In Production" && toSchedule.length) { setScheduleTargets(sel); return; }
                runProdBatch(sel, (s) => moveOne(s, to), `Move to ${to}`);
              }}>Move</button>
            <button className="k-btn primary" disabled={batchBusy || !toSchedule.length} onClick={() => setScheduleTargets(toSchedule)}
              title="All ticked cards in To be scheduled, one WO date">Scheduled{toSchedule.length ? ` (${toSchedule.length})` : ""}…</button>
            <select className="k-btn" value={prodBatch.route} disabled={batchBusy} aria-label="Contract route for the ticked drawings' items"
              onChange={(e) => setProdBatch((b) => ({ ...b, route: e.target.value }))}>
              <option value="">Route…</option>
              {DFLanes.ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button className="k-btn" disabled={batchBusy || !prodBatch.route}
              onClick={() => setRoute(sel.map((s) => (s.taskIds || [])[0]), prodBatch.route)}>Set route</button>
            <button className="k-btn" disabled={batchBusy || !canBack.length}
              onClick={() => { if (window.confirm(`Move ${canBack.length} drawing(s) back one step?`)) runProdBatch(canBack, (s) => moveOne(s, "back"), "Move back"); }}>
              Move back{canBack.length ? ` (${canBack.length})` : ""}</button>
          </div>
        );
      })()}

      {scheduleTargets && scheduleTargets.length > 0 && (
        <ScheduleModal cards={scheduleTargets} onConfirm={scheduleCards} onClose={() => setScheduleTargets(null)} />
      )}

      {view !== "production" && selectedIds.size > 0 && (
        <div className="k-bulkbar">
          <span className="k-bulk-n">{selectedIds.size}</span><span className="k-bulk-lbl">selected</span>
          {batchBusy && <span className="k-bulk-lbl" style={{ color: "var(--accent)" }}>Working…</span>}
          <button className="k-btn" onClick={clearSelection} disabled={batchBusy}>Clear</button>
          <button className="k-btn" onClick={() => handleBatchApprove(reviewableSel)}
            disabled={batchBusy || !reviewableSel.length}
            title={reviewableSel.length ? `Approve ${reviewableSel.length} drawing${reviewableSel.length === 1 ? "" : "s"} awaiting review`
                                        : "Nothing in the selection is awaiting review"}>
            Approve{reviewableSel.length ? ` (${reviewableSel.length})` : ""}
          </button>
          <button className="k-btn" onClick={() => handleBatchBounce(reviewableSel)}
            disabled={batchBusy || !reviewableSel.length}
            title={reviewableSel.length ? `Bounce ${reviewableSel.length} drawing${reviewableSel.length === 1 ? "" : "s"} awaiting review`
                                        : "Nothing in the selection is awaiting review"}>
            Bounce{reviewableSel.length ? ` (${reviewableSel.length})` : ""}
          </button>
          <button className="k-btn" onClick={() => setBatchGradeTargets(gradeSelected)}
            disabled={batchBusy || !!batchGradeBlocked}
            title={batchGradeBlocked || `Grade ${gradeSelected.length} selected drawing${gradeSelected.length === 1 ? "" : "s"}`}>
            Grade{gradeSelected.length ? ` (${gradeSelected.length})` : ""}
          </button>
          <button className="k-btn" onClick={() => handleBatchHold(holdableSel)}
            disabled={batchBusy || !holdableSel.length}
            title={holdableSel.length ? `Put ${holdableSel.length} drawing${holdableSel.length === 1 ? "" : "s"} on hold (RFI / Design Change)`
                                      : "Everything in the selection is already on hold"}>
            Hold{holdableSel.length ? ` (${holdableSel.length})` : ""}
          </button>
          <button className="k-btn primary" onClick={() => handleBatchIssue(issuableSel)}
            disabled={batchBusy || !issuableSel.length}
            title={issuableSel.length ? `Issue ${issuableSel.length} drawing${issuableSel.length === 1 ? "" : "s"}`
                                      : "Nothing in the selection is awaiting issue — the DWGs may not be uploaded yet"}>
            Issue{issuableSel.length ? ` (${issuableSel.length})` : ""}
          </button>
        </div>
      )}

      {batchGradeTargets && batchGradeTargets.length > 0 && (
        <BatchGradeModal
          submissions={batchGradeTargets}
          onConfirm={runOneGrade}
          onClose={closeBatchGrade}
        />
      )}

      {bounceTarget && (
        <BounceModal
          submission={bounceTarget}
          onConfirm={handleBounce}
          onClose={() => setBounceTarget(null)}
        />
      )}

      {issueTarget && (
        <IssueModal
          submission={issueTarget}
          onConfirm={handleIssue}
          onClose={() => setIssueTarget(null)}
        />
      )}

      {logStatusTarget && (
        <LogStatusModal
          submission={logStatusTarget}
          onConfirm={handleLogStatus}
          onClose={() => setLogStatusTarget(null)}
        />
      )}

      {/* ── Ingest notifications: fixed bell + toasts + dismissable list ───── */}
      <div className="notif-widget">
        {toasts.length > 0 && (
          <div className="notif-toasts" aria-live="polite">
            {toasts.map((t) => (
              <div key={t.id} className={`notif-toast notif-${t.type}`}>
                <span className="notif-icon">{notifIcon(t.type)}</span>
                <div className="notif-toast-body">
                  {t.filename && <div className="notif-toast-file">{t.filename}</div>}
                  <div className="notif-toast-msg">{t.message}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {notifOpen && (
          <div className="notif-panel">
            <div className="notif-panel-head">
              <span>Ingest activity</span>
              <button className="k-btn" onClick={handleClearNotifications} disabled={notifications.length === 0}>
                Clear all
              </button>
            </div>
            <div className="notif-panel-list">
              {notifications.length === 0 ? (
                <div className="notif-empty">No ingest activity yet</div>
              ) : (
                notifications.map((n) => (
                  <div key={n.id} className={`notif-row notif-${n.type}`}>
                    <span className="notif-icon">{notifIcon(n.type)}</span>
                    <div className="notif-row-body">
                      <div className="notif-row-msg">{n.message}</div>
                      {n.filename && <div className="notif-row-file">{n.filename}</div>}
                      <div className="notif-row-time">
                        {new Date(n.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        <button
          className="notif-bell"
          onClick={() => setNotifOpen((v) => !v)}
          aria-label="Ingest notifications"
          aria-expanded={notifOpen}
          title="Ingest notifications — shows the trigger ran"
        >
          🔔
          {notifications.length > 0 && <span className="notif-badge">{notifications.length}</span>}
        </button>
      </div>
    </div>
  );
};
