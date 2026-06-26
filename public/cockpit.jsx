// cockpit.jsx — DM Submissions Queue
// Polls /api/df/submissions every 30s.
// Shows Status=Submitted queue (grouped by task/item) with Approve + Bounce actions.
// Shows Status=Issued section with Log Status (A/B/C/NA) action.
// Shows Pending DT Notification section — actioned items awaiting batch email send.
// Multi-select batch actions per queue section.
// Desktop notifications on new arrivals.

const { useState, useEffect, useRef, useCallback } = React;

// ─── Utilities ────────────────────────────────────────────────────────────────

function stageBadgeClass(stage) {
  if (!stage) return "";
  if (stage === "S4") return "badge-s4";
  if (stage === "S5") return "badge-s5";
  if (stage === "S3") return "badge-s3";
  return "badge-a45";
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / 86400000);
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
          This will return the drawing to the DT. The Miro board link will be included in the notification email so the DT can see the markup.
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

  const isAB  = submission.stage === "AB";
  const isA45 = submission.stage === "A4.5";
  const needsReturnDate = !isAB && !isA45;   // S4/S5 have a project-system return date
  const grades = (isAB || isA45) ? ["Approved", "Rejected"] : ["A", "B", "C", "NA"];
  const hint   = isAB  ? "Approved = As Built accepted · Rejected = revision required"
               : isA45 ? "Approved = Contractor sign-off · Rejected = revision required"
               : "A = accepted · B = minor revision · C = major revision · NA = not applicable";

  const select = async (grade) => {
    if (needsReturnDate && !returnDate) {
      alert("Please enter the date the return was filed on the project system.");
      return;
    }
    setBusy(true);
    await onConfirm(submission.id, grade, returnDate || null);
    setBusy(false);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Log Client Grade — {submission.drawingNo || submission.title}</h3>
        <div className="modal-sub">
          {submission.stage} · Rev {submission.revision}
        </div>
        {needsReturnDate && (
          <div style={{ margin: "16px 0 4px" }}>
            <label style={{ fontSize: 12, color: "var(--text2)", display: "block", marginBottom: 4 }}>
              Return date (as filed on project system) *
            </label>
            <input
              type="date"
              value={returnDate}
              onChange={(e) => setReturnDate(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text1)", fontSize: 13 }}
            />
          </div>
        )}
        <div className="grade-buttons" style={{ marginTop: 16 }}>
          {grades.map((g) => (
            <button key={g} className={`grade-btn ${g}`} onClick={() => select(g)} disabled={busy}>
              {g}
            </button>
          ))}
        </div>
        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: "var(--text3)" }}>
          {hint}
        </div>
      </div>
    </div>
  );
};

// ─── Issue modal ──────────────────────────────────────────────────────────────

const IssueModal = ({ submission, onConfirm, onClose }) => {
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
        <h3>Issue — {submission.drawingNo || submission.title}</h3>
        <div className="modal-sub">
          {submission.stage} · Rev {submission.revision}
          {submission.dtName ? ` · ${submission.dtName}` : ""}
        </div>
        <p style={{ fontSize: 13, color: "var(--text2)", margin: "16px 0 0" }}>
          Confirm you have issued the drawings to the client. Notion and the MDS will be updated and the DT will be notified.
        </p>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-issue" onClick={submit} disabled={busy}>
            {busy ? "Issuing…" : "Confirm Issue"}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Submission row ───────────────────────────────────────────────────────────

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
  const [graded,               setGraded]               = useState([]);
  const [sendGradeEmailsBusy,  setSendGradeEmailsBusy]  = useState(false);
  const [sendGradeResult,      setSendGradeResult]      = useState(null);  // "ok" | "error" | null
  const [search,               setSearch]               = useState("");
  const [density,              setDensity]              = useState("comfortable");

  // Multi-select: single Set shared across all sections; sections filter to their own IDs
  const [selectedIds, setSelectedIds] = useState(new Set());

  const knownIds = useRef(new Set());
  const notifGranted = useRef(false);

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
  const fetchQueue = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [subRes, approvedRes, awaitRes, issRes, pendingRes, gradedRes] = await Promise.all([
        fetch("/api/df/submissions?status=Submitted"),
        fetch("/api/df/submissions?status=Approved"),
        fetch("/api/df/submissions?status=Awaiting%20Issue"),
        fetch("/api/df/submissions?status=Issued"),
        fetch("/api/df/submissions?status=pending-notification"),
        fetch("/api/df/submissions?status=Graded"),
      ]);

      if (!subRes.ok || !approvedRes.ok || !awaitRes.ok || !issRes.ok || !pendingRes.ok || !gradedRes.ok) {
        throw new Error("API error");
      }

      const { submissions: subs      } = await subRes.json();
      const { submissions: approved_ } = await approvedRes.json();
      const { submissions: await_    } = await awaitRes.json();
      const { submissions: iss       } = await issRes.json();
      const { submissions: pending   } = await pendingRes.json();
      const { submissions: graded_   } = await gradedRes.json();

      const newOnes = subs.filter((s) => !knownIds.current.has(s.id));
      if (newOnes.length && knownIds.current.size > 0) notify(newOnes.length);
      subs.forEach((s) => knownIds.current.add(s.id));

      setSubmitted(subs);
      setAwaitingIssue([...approved_, ...await_]);
      setIssued(iss);
      setPendingNotification(pending);
      setGraded(graded_.filter((s) => !s.dtNotified));
      setLastPoll(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(() => fetchQueue(true), 30000);
    return () => clearInterval(interval);
  }, [fetchQueue]);

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

  const handleIssue = async (id) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/df/submissions/${id}/issue`, { method: "PATCH" });
      if (!res.ok) {
        const body = await res.json();
        alert(`Issue failed: ${body.error || res.statusText}`);
      } else {
        await fetchQueue(true);
      }
    } catch (err) {
      alert(`Issue error: ${err.message}`);
    } finally {
      setBusy(null);
    }
  };

  const handleLogStatus = async (id, grade, returnDate) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/df/submissions/${id}/log-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grade, ...(returnDate ? { returnDate } : {}) }),
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
  const runBatch = async (ids, apiPath, method = "PATCH", body = null) => {
    setBatchBusy(true);
    try {
      const results = await Promise.allSettled(
        ids.map((id) =>
          fetch(`/api/df/submissions/${id}/${apiPath}`, {
            method,
            headers: body ? { "Content-Type": "application/json" } : undefined,
            body:    body ? JSON.stringify(body) : undefined,
          })
        )
      );
      const failed = results.filter((r) => r.status === "rejected" || (r.value && !r.value.ok));
      if (failed.length) alert(`${failed.length} of ${ids.length} actions failed. Check console.`);
      clearSelection();
      await fetchQueue(true);
    } catch (err) {
      alert(`Batch error: ${err.message}`);
    } finally {
      setBatchBusy(false);
    }
  };

  const handleBatchApprove = (ids) => runBatch(ids, "approve");
  const handleBatchBounce  = (ids) => runBatch(ids, "bounce", "PATCH", {});
  const handleBatchIssue   = (ids) => runBatch(ids, "issue");

  // ── Send DT emails ───────────────────────────────────────────────────────
  const handleSendDTEmails = async () => {
    setSendEmailBusy(true);
    setSendEmailResult(null);
    try {
      const res = await fetch("/api/df/send-dt-emails", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        alert(`Send emails failed: ${body.error || res.statusText}`);
        setSendEmailResult("error");
      } else {
        setSendEmailResult("ok");
        // Remove notified items from pending list immediately (no wait for next poll)
        setPendingNotification([]);
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

  const handleSendGradeEmails = async () => {
    setSendGradeEmailsBusy(true);
    setSendGradeResult(null);
    try {
      const res  = await fetch("/api/df/send-grade-emails", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        alert(`Send grade emails failed: ${body.error || res.statusText}`);
        setSendGradeResult("error");
      } else {
        setSendGradeResult("ok");
        setGraded([]);
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

  const handleHold = async (id, currentBlocked) => {
    const blocked = !currentBlocked;
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
      fetchQueue(true);
    } catch (err) {
      alert(`Hold toggle error: ${err.message}`);
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
  const commentItems     = issued.filter((s) => s.hasComments);
  const signoffItems     = issued.filter((s) => s.stage === "A4.5" && !s.hasComments);
  const awaitingComments = issued.filter((s) => s.stage !== "A4.5" && !s.hasComments);
  const reviewedNotify   = pendingNotification.filter((s) => s.status === "Approved" || s.status === "Rejected");
  // Approved drawings only enter the Awaiting-Issue column once the DT has been notified;
  // until their DWGs are uploaded (Make flips status → "Awaiting Issue") the Issue button stays grey.
  const approvedItems    = awaitingIssue.filter((s) => s.status === "Awaiting Issue" || s.dtNotified);
  const total = submitted.length + awaitingIssue.length + issued.length + graded.length;
  const overdueCount = [...submitted, ...awaitingIssue, ...issued, ...graded]
    .filter((s) => (daysSince(s.bicSince) ?? 0) > 14).length;

  const scanPendingLabel  = scanning && scanResult !== "error" ? "Scanning…" : "⟳ Scan Pending";
  const scanCommentsLabel = scanCommentsBusy && scanCommentsResult !== "error" ? "💬 Ingesting…" : "💬 Scan Comments";
  const sendDtLabel       = sendEmailBusy ? "Sending…" : "✉ Send DT Email";
  const sendGradeLabel    = sendGradeEmailsBusy ? "Sending…" : "✉ Send DT Email";

  const COLS = [
    { id: "submitted", title: "Submitted — Awaiting Review", accent: "var(--info)", sub: "New DT drawing submissions", items: submitted,
      action: { label: scanPendingLabel, onClick: handleScanPending, disabled: scanning } },
    { id: "reviewed", title: "Reviewed — Notify DT", accent: "var(--ok)", sub: "Approved / bounced — awaiting DT email", items: reviewedNotify,
      action: { label: sendDtLabel, onClick: handleSendDTEmails, disabled: sendEmailBusy, count: reviewedNotify.length } },
    { id: "approved", title: "Approved — Awaiting Issue", accent: "var(--ok)", sub: "DT notified · awaiting DWG upload, then issue", items: approvedItems },
    { id: "awaiting-comments", title: "Issued — Awaiting Comments", accent: "var(--info)", sub: "Issued to client, awaiting comments", items: awaitingComments,
      action: { label: sendDtLabel, onClick: handleSendDTEmails, disabled: sendEmailBusy } },
    { id: "comments", title: "Issued — Review Client Comments", accent: "var(--grade)", sub: "Client comments received", items: commentItems,
      action: { label: scanCommentsLabel, onClick: handleScanComments, disabled: scanCommentsBusy, count: commentItems.length } },
    { id: "signoff", title: "Issued — Awaiting Sign-Off", accent: "var(--warn)", sub: "A4.5 — with client for sign-off", items: signoffItems },
    { id: "graded", title: "Graded — Notify DT", accent: "var(--accent)", sub: "Notion · DT Notified unchecked", items: graded,
      action: { label: sendGradeLabel, onClick: handleSendGradeEmails, disabled: sendGradeEmailsBusy, count: graded.length } },
  ];

  const q = search.trim().toLowerCase();
  const matchSearch = (s) => !q || `${s.drawingNo || ""} ${s.title || ""} ${s.taskCode || ""} ${s.dtName || ""}`.toLowerCase().includes(q);

  const statusPill = (colId, s) => {
    switch (colId) {
      case "submitted":         return { cls: "info",  txt: "Submitted" };
      case "reviewed":          return s.status === "Rejected" ? { cls: "danger", txt: "Bounced" } : { cls: "ok", txt: "Approved" };
      case "approved":          return s.status === "Awaiting Issue" ? { cls: "ok", txt: "Ready to Issue" } : { cls: "warn", txt: "Awaiting DT Upload" };
      case "awaiting-comments": return { cls: "info",  txt: "Issued" };
      case "comments":          return { cls: "grade", txt: "Comments" };
      case "signoff":           return { cls: "warn",  txt: "Sign-Off" };
      case "graded":            return { cls: "grade", txt: "Grade " + (s.clientGrade || "—") };
      default:                  return { cls: "info",  txt: "" };
    }
  };

  // Every card gets a Hold/Unblock action; some stages add a primary action too.
  const cardActions = (colId, s) => {
    const isBusy = busy === s.id;
    const hold = (
      <button className="k-act" onClick={(e) => { e.stopPropagation(); handleHold(s.id, s.blocked); }}>{s.blocked ? "Unblock" : "Hold"}</button>
    );
    let primary = null;
    if (colId === "submitted") primary = (
      <>
        <button className="k-act go" disabled={isBusy} onClick={(e) => { e.stopPropagation(); handleApprove(s.id); }}>Approve</button>
        <button className="k-act" disabled={isBusy} onClick={(e) => { e.stopPropagation(); setBounceTarget(s); }}>Bounce</button>
      </>
    );
    else if (colId === "approved") {
      const ready = s.status === "Awaiting Issue"; // DWGs uploaded → Issue enabled (blue)
      primary = (
        <button className={`k-act${ready ? " go" : ""}`} disabled={isBusy || !ready}
          onClick={(e) => { e.stopPropagation(); setIssueTarget(s); }}
          title={ready ? "Issue the drawing" : "Awaiting DT to upload DWGs"}>Issue</button>
      );
    }
    else if (colId === "comments" || colId === "signoff" || colId === "awaiting-comments") primary = (
      <button className="k-act go" onClick={(e) => { e.stopPropagation(); setLogStatusTarget(s); }}>Grade</button>
    );
    return (<>{primary}{hold}</>);
  };

  const renderCard = (s, colId) => {
    const age = daysSince(s.bicSince);
    const ageCls = age == null ? "" : age > 14 ? "r" : age > 7 ? "a" : "g";
    const sel = selectedIds.has(s.id);
    const pill = statusPill(colId, s);
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
          {s.revision && <span className="k-tag">{s.revision}</span>}
          <span className={`k-pill ${pill.cls}`}>{pill.txt}</span>
          {s.hasComments && <span className="k-pill danger">New ✦</span>}
          {s.blocked && <span className="k-pill warn">On Hold</span>}
        </div>
        <div className="k-card-foot">
          <span className={`k-age ${ageCls}`} title={age == null ? "" : `${age} days in stage`}>{age == null ? "—" : age + "d"}</span>
          <span className="k-ava" style={{ background: personColor(s.dtName) }} title={s.dtName || ""}>{initials}</span>
          <span className="k-cardact">{cardActions(colId, s)}</span>
        </div>
      </div>
    );
  };

  // Group a column's cards by project-suffix (taskCode), colour-coded by project.
  const renderColumnBody = (items, colId) => {
    if (items.length === 0) return <div className="k-empty">{q ? "No matches in this stage" : "Nothing here — all clear"}</div>;
    const groups = groupByTask(items);
    return Object.entries(groups).map(([taskCode, rows]) => (
      <div key={taskCode} className="k-group" style={{ "--k-proj": projectColor(taskCode) }}>
        <div className="k-group-head">
          <span className="k-group-dot" aria-hidden="true" />{taskCode}<span className="k-group-n">{rows.length}</span>
        </div>
        {rows.map((s) => renderCard(s, colId))}
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
        <input className="k-search" type="search" placeholder="Search drawing ref, title, DT…"
          value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search submissions" />
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

      <div className="k-board" aria-label="Submissions board">
        {COLS.map((col) => {
          const items = col.items.filter(matchSearch);
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
              </div>
              <div className="k-col-body">
                {renderColumnBody(items, col.id)}
              </div>
            </div>
          );
        })}
      </div>

      {selectedIds.size > 0 && (
        <div className="k-bulkbar">
          <span className="k-bulk-n">{selectedIds.size}</span><span className="k-bulk-lbl">selected</span>
          <button className="k-btn" onClick={clearSelection}>Clear</button>
          <button className="k-btn" onClick={() => handleBatchApprove([...selectedIds])} disabled={batchBusy}>Approve</button>
          <button className="k-btn" onClick={() => handleBatchBounce([...selectedIds])} disabled={batchBusy}>Bounce</button>
          <button className="k-btn primary" onClick={() => handleBatchIssue([...selectedIds])} disabled={batchBusy}>Issue</button>
        </div>
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
    </div>
  );
};
