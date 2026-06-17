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
  const [busy, setBusy] = useState(false);

  const isAB  = submission.stage === "AB";
  const isA45 = submission.stage === "A4.5";
  const grades = (isAB || isA45) ? ["Approved", "Rejected"] : ["A", "B", "C", "NA"];
  const hint   = isAB  ? "Approved = As Built accepted · Rejected = revision required"
               : isA45 ? "Approved = Contractor sign-off · Rejected = revision required"
               : "A = accepted · B = minor revision · C = major revision · NA = not applicable";

  const select = async (grade) => {
    setBusy(true);
    await onConfirm(submission.id, grade);
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
        <div className="grade-buttons">
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

const SubmissionRow = ({ sub, onApprove, onBounce, onLogStatus, onIssue, busy, selected, onToggleSelect }) => {
  const isBusy = busy === sub.id;
  const isApproved      = sub.status === "Approved";
  const isAwaitingIssue = sub.status === "Awaiting Issue";
  const isIssued        = sub.status === "Issued";

  const actions = () => {
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
    <div className={`queue-row${selected ? " selected" : ""}`}>
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
        <div className="queue-row-drawing">{sub.drawingNo || sub.title}</div>
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
        {sub.dropboxLink
          ? <a href={sub.dropboxLink} target="_blank" rel="noopener noreferrer">↗ Open</a>
          : <span style={{ color: "var(--text3)", fontSize: 11 }}>No link</span>}
      </div>
      <div className="queue-actions">{actions()}</div>
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
  title, submissions, onApprove, onBounce, onLogStatus, onIssue, busy,
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
      const [subRes, approvedRes, awaitRes, issRes, pendingRes] = await Promise.all([
        fetch("/api/df/submissions?status=Submitted"),
        fetch("/api/df/submissions?status=Approved"),
        fetch("/api/df/submissions?status=Awaiting%20Issue"),
        fetch("/api/df/submissions?status=Issued"),
        fetch("/api/df/submissions?status=pending-notification"),
      ]);

      if (!subRes.ok || !approvedRes.ok || !awaitRes.ok || !issRes.ok || !pendingRes.ok) {
        throw new Error("API error");
      }

      const { submissions: subs      } = await subRes.json();
      const { submissions: approved_ } = await approvedRes.json();
      const { submissions: await_    } = await awaitRes.json();
      const { submissions: iss       } = await issRes.json();
      const { submissions: pending   } = await pendingRes.json();

      const newOnes = subs.filter((s) => !knownIds.current.has(s.id));
      if (newOnes.length && knownIds.current.size > 0) notify(newOnes.length);
      subs.forEach((s) => knownIds.current.add(s.id));

      setSubmitted(subs);
      setAwaitingIssue([...approved_, ...await_]);
      setIssued(iss);
      setPendingNotification(pending);
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

  const handleLogStatus = async (id, grade) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/df/submissions/${id}/log-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grade }),
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

  const handleScanPending = async () => {
    setScanning(true);
    try {
      await fetch("/api/df/scan-pending", { method: "POST" });
      // Give Make ~8s to run the scenario before refreshing
      setTimeout(() => { fetchQueue(true); setScanning(false); }, 8000);
    } catch (err) {
      setScanning(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  const total = submitted.length + awaitingIssue.length + issued.length;

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h1 className="page-title">Submissions Queue</h1>
          {pendingNotification.length > 0 && (
            <span className="pending-email-badge">{pendingNotification.length} pending email</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {sendEmailResult === "ok" && (
            <span className="send-result ok">Emails sent!</span>
          )}
          {sendEmailResult === "error" && (
            <span className="send-result error">Send failed</span>
          )}
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleScanPending}
            disabled={scanning}
            title="Trigger Make ingest scenario to pick up new Dropbox submissions"
          >
            {scanning ? "Scanning…" : "⟳ Scan Pending"}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSendDTEmails}
            disabled={sendEmailBusy || pendingNotification.length === 0}
            title={pendingNotification.length === 0 ? "No pending notifications" : `Send DT emails for ${pendingNotification.length} item(s)`}
          >
            {sendEmailBusy ? "Sending…" : `Send DT Emails${pendingNotification.length > 0 ? ` (${pendingNotification.length})` : ""}`}
          </button>
          <div className="page-meta">
            {lastPoll
              ? `Updated ${lastPoll.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · auto-refresh 30s`
              : "Loading…"
            }
          </div>
        </div>
      </div>

      {/* Pending DT Notification — shown first so DM sees outstanding emails before acting */}
      <PendingNotificationSection submissions={pendingNotification} />

      {loading && !total && (
        <div className="state-loading">
          <div className="spinner" />
          <div>Loading submissions…</div>
        </div>
      )}

      {error && (
        <div className="state-error">
          Failed to load: {error}
        </div>
      )}

      {!loading && !error && total === 0 && pendingNotification.length === 0 && (
        <div className="state-empty">
          No submissions waiting — queue clear.
        </div>
      )}

      {submitted.length > 0 && (
        <QueueSection
          title="Awaiting QA Review"
          submissions={submitted}
          onApprove={handleApprove}
          onBounce={(sub) => setBounceTarget(sub)}
          onLogStatus={(sub) => setLogStatusTarget(sub)}
          onIssue={(sub) => setIssueTarget(sub)}
          busy={busy}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          batchLabel="Approve"
          onBatchAction={handleBatchApprove}
          batchBusy={batchBusy}
        />
      )}

      {/* Bounce batch is separate so its button label differs */}
      {submitted.length > 0 && (
        <div style={{ marginTop: -8 }}>
          <BatchBar
            count={submitted.filter((s) => selectedIds.has(s.id)).length}
            label="Bounce"
            onAction={() => handleBatchBounce(submitted.filter((s) => selectedIds.has(s.id)).map((s) => s.id))}
            onClear={() => submitted.forEach((s) => selectedIds.has(s.id) && toggleSelect(s.id))}
            busy={batchBusy}
          />
        </div>
      )}

      {awaitingIssue.length > 0 && (
        <QueueSection
          title="Approved — Awaiting Issue"
          submissions={awaitingIssue}
          onApprove={handleApprove}
          onBounce={(sub) => setBounceTarget(sub)}
          onLogStatus={(sub) => setLogStatusTarget(sub)}
          onIssue={(sub) => setIssueTarget(sub)}
          busy={busy}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          batchLabel="Issue"
          onBatchAction={handleBatchIssue}
          batchBusy={batchBusy}
        />
      )}

      {issued.filter((s) => s.stage !== "A4.5").length > 0 && (
        <QueueSection
          title="Issued — Awaiting Client Grade"
          submissions={issued.filter((s) => s.stage !== "A4.5")}
          onApprove={handleApprove}
          onBounce={(sub) => setBounceTarget(sub)}
          onLogStatus={(sub) => setLogStatusTarget(sub)}
          onIssue={(sub) => setIssueTarget(sub)}
          busy={busy}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          batchBusy={batchBusy}
        />
      )}

      {issued.filter((s) => s.stage === "A4.5").length > 0 && (
        <QueueSection
          title="Issued — Awaiting Sign Off"
          submissions={issued.filter((s) => s.stage === "A4.5")}
          onApprove={handleApprove}
          onBounce={(sub) => setBounceTarget(sub)}
          onLogStatus={(sub) => setLogStatusTarget(sub)}
          onIssue={(sub) => setIssueTarget(sub)}
          busy={busy}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          batchBusy={batchBusy}
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
    </div>
  );
};
