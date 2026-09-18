// activity-feed.jsx — Item Activity Feed
//
// A read surface, not a workspace. Nothing is authored here: the Activity Log is written
// only by automation attached to the three trackers (Actions & Info, RFIs, Submissions),
// and this page reads it. The v1 quick-log form was removed in Sep 2026 — see
// ITEM-ACTIVITY-FEED-HANDOFF.md P2/P3.
//
// Two different questions, answered from two different places, deliberately:
//   • "How did we get here"  → the feed, from the Activity Log       (/api/df/activity-log)
//   • "Where are we now"     → the header + blocker strip, from the
//                              trackers themselves                  (/api/df/activity-position)
// Deriving either from the other would make both wrong. Current state lives in the
// trackers; history lives in the log.
//
// Filters compose, and they drive the feed and the export identically — the export is
// exactly what is on screen (§7.5). The position header is scope-only (project/item): it
// reports where things stand now, which a tag or date filter has no business narrowing.

const { useState, useEffect, useCallback, useMemo, useRef } = React;

const TAGS = ["#decision", "#instruction", "#query", "#response", "#issue", "#approval", "#info", "#action"];

// Mirrors the Source select on the Item Activity Log DB. Variation and Meeting have no
// writer behind them yet — they are listed because the schema carries them and a feed that
// silently cannot filter for a value that exists is worse than an option that finds nothing.
const SOURCES = ["A&I", "RFI", "Drawing Flow", "Email", "Manual", "System", "Variation", "Meeting"];

const DEFAULT_WINDOW_DAYS = 7;

// Detail text arrives from the backend as plain text with real "\n" line breaks and
// "**bold**" markers standing in for Notion's real bold annotations (see getProp /
// richTextToMarkdown in drawing-flow.js — those aren't literal characters the user
// typed, they're re-encoded here so this lightweight renderer can show them).
const renderFormatted = (text, keyPrefix) => {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => (
    part.startsWith("**") && part.endsWith("**") && part.length > 4
      ? <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>
      : <React.Fragment key={`${keyPrefix}-${i}`}>{part}</React.Fragment>
  ));
};

// Collapsed: the full Detail text sits in a single-line, CSS-clipped block (nowrap +
// ellipsis) rather than trying to guess a "first line" from a delimiter that isn't
// reliably present in the real data. A ref measures actual overflow so the toggle only
// shows up when there's genuinely more to reveal (long text and/or attachments) — a
// short one-liner with no attachments never gets a pointless "Show details" button.
const ActivityDetail = ({ id, detail, files, isOpen, onToggle, isImageFile }) => {
  const previewRef = useRef(null);
  const [isClipped, setIsClipped] = useState(false);

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    setIsClipped(el.scrollWidth > el.clientWidth + 1);
  }, [detail]);

  const fileCount = files?.length || 0;
  const hasToggle = isClipped || fileCount > 0;

  if (!detail && fileCount === 0) return null;

  return (
    <>
      {detail && (
        <div
          ref={previewRef}
          className={`activity-row-detail ${isOpen ? "activity-row-detail-full" : "activity-row-detail-preview"}`}
        >
          {renderFormatted(detail, `${id}-detail`)}
        </div>
      )}

      {hasToggle && (
        <button
          type="button"
          className="activity-row-toggle"
          onClick={onToggle}
          aria-expanded={isOpen}
        >
          {fileCount > 0 && (
            <span className="attachment-indicator" title={`${fileCount} attachment${fileCount === 1 ? "" : "s"}`}>
              📎 {fileCount}
            </span>
          )}
          <span>{isOpen ? "Hide details ▴" : "Show details ▾"}</span>
        </button>
      )}

      {isOpen && fileCount > 0 && (
        <div className="activity-row-files">
          {files.map((f, i) => (
            isImageFile(f) ? (
              <a key={i} className="activity-file-thumb" href={f.url} target="_blank" rel="noreferrer" title={f.name || "Open image"}>
                <img src={f.url} alt={f.name || "Attached image"} loading="lazy" />
              </a>
            ) : (
              <a key={i} className="activity-file-doc" href={f.url} target="_blank" rel="noreferrer" title={f.name || "Open file"}>
                📄 <span>{f.name || "Document"}</span>
              </a>
            )
          ))}
        </div>
      )}
    </>
  );
};

const ActivityFeed = () => {
  // ── Scope ───────────────────────────────────────────────────────────────
  const [projects,          setProjects]          = useState([]);
  const [tasks,             setTasks]             = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedTaskId,    setSelectedTaskId]    = useState("");

  // ── Filters (feed + export only — never the position header) ────────────
  const [selectedTags,    setSelectedTags]    = useState(() => new Set());
  const [selectedSources, setSelectedSources] = useState(() => new Set());
  const [fromDate,        setFromDate]        = useState("");
  const [toDate,          setToDate]          = useState("");

  // ── Data ────────────────────────────────────────────────────────────────
  const [entries,     setEntries]     = useState([]);
  const [position,    setPosition]    = useState(null);
  const [loadingData, setLoadingData] = useState(false);
  const [loadError,   setLoadError]   = useState(null);
  const [posError,    setPosError]    = useState(null);
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [exporting,   setExporting]   = useState(false);
  const [exportError, setExportError] = useState(null);

  useEffect(() => {
    fetch("/api/projects").then((r) => r.json())
      .then(({ projects }) => setProjects(projects || [])).catch(() => {});
  }, []);

  useEffect(() => {
    setSelectedTaskId("");
    setTasks([]);
    if (!selectedProjectId) return;
    fetch(`/api/tasks?projectId=${selectedProjectId}`).then((r) => r.json())
      .then(({ tasks }) => setTasks(tasks || [])).catch(() => {});
  }, [selectedProjectId]);

  // One place builds the query string, and the feed, the export and (for scope) the header
  // all read from it. Anything else and "the export is exactly what is on screen" quietly
  // stops being true the first time a filter is added.
  const feedParams = useMemo(() => {
    const p = new URLSearchParams();
    if (selectedTaskId) {
      p.set("taskId", selectedTaskId);
      p.set("limit", "200");
    } else if (selectedProjectId) {
      p.set("projectId", selectedProjectId);
      p.set("limit", "200");
    } else if (!fromDate && !toDate) {
      p.set("days", String(DEFAULT_WINDOW_DAYS));
      p.set("limit", "100");
    } else {
      p.set("limit", "200");
    }
    if (selectedTags.size)    p.set("tag",    [...selectedTags].join(","));
    if (selectedSources.size) p.set("source", [...selectedSources].join(","));
    if (fromDate) p.set("from", fromDate);
    if (toDate)   p.set("to",   toDate);
    return p;
  }, [selectedProjectId, selectedTaskId, selectedTags, selectedSources, fromDate, toDate]);

  const scopeParams = useMemo(() => {
    const p = new URLSearchParams();
    if (selectedTaskId)         p.set("taskId", selectedTaskId);
    else if (selectedProjectId) p.set("projectId", selectedProjectId);
    return p;
  }, [selectedProjectId, selectedTaskId]);

  const loadEntries = useCallback(async () => {
    setLoadingData(true);
    setLoadError(null);
    try {
      const r = await fetch(`/api/df/activity-log?${feedParams.toString()}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Failed to load feed");
      setEntries(data.entries || []);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoadingData(false);
    }
  }, [feedParams]);

  // The header is scope-only. It reads the trackers, not the log, so a tag or date filter
  // has nothing to narrow — "2 with DM" is true regardless of which slice of history the
  // feed below happens to be showing.
  const loadPosition = useCallback(async () => {
    setPosError(null);
    try {
      const r = await fetch(`/api/df/activity-position?${scopeParams.toString()}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Failed to load position");
      setPosition(data);
    } catch (err) {
      setPosError(err.message);
      setPosition(null);
    }
  }, [scopeParams]);

  useEffect(() => { loadEntries(); },  [loadEntries]);
  useEffect(() => { loadPosition(); }, [loadPosition]);

  const toggleExpanded = (id) => setExpandedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleIn = (setter) => (value) => setter((prev) => {
    const next = new Set(prev);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  });

  const clearFilters = () => {
    setSelectedTags(new Set());
    setSelectedSources(new Set());
    setFromDate("");
    setToDate("");
  };

  const filtersActive = selectedTags.size > 0 || selectedSources.size > 0 || !!fromDate || !!toDate;

  // Fetched as a blob rather than pointed at with window.location, so a 500 surfaces as a
  // message in the page instead of dumping raw JSON over the app in a new tab.
  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const r = await fetch(`/api/df/activity-export?${feedParams.toString()}`);
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || `Export failed (${r.status})`);
      }
      const blob = await r.blob();
      const name = (r.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1]
        || `activity-export_${new Date().toISOString().slice(0, 10)}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err.message);
    } finally {
      setExporting(false);
    }
  };

  // ── Render helpers ───────────────────────────────────────────────────────
  const selectedProjectName = projects.find((p) => p.id === selectedProjectId)?.name || "";
  const selectedTaskName    = tasks.find((t)    => t.id === selectedTaskId)?.name    || "";

  // A Notion date property set without a time comes back as a bare "YYYY-MM-DD", and a
  // backfilled entry usually is — nobody records the minute a decision was taken three
  // months ago. Formatting that as a time invents a midnight that was never recorded, so
  // date-only entries show a date only. Parsed at midday rather than midnight so the date
  // cannot slip a day when rendered west of UTC.
  const formatTimestamp = (raw) => {
    if (!raw) return "";
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    const d = new Date(dateOnly ? `${raw}T12:00:00` : raw);
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return dateOnly ? date
      : `${date} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  };

  const isEmphasised = (source) => source === "Manual" || source === "Email" || source === "Meeting";
  const isImageFile  = (f) => /\.(png|jpe?g|gif|webp|svg|bmp)(\?|$)/i.test(f.url || f.name || "");

  const showItemLabel    = !selectedTaskId;
  const showProjectLabel = !selectedProjectId;

  const scopeLabel = selectedTaskId
    ? <>Activity for <strong style={{ color: "var(--text2)" }}>{selectedTaskName}</strong> within <strong style={{ color: "var(--text2)" }}>{selectedProjectName}</strong>.</>
    : selectedProjectId
      ? <>Showing all activity for <strong style={{ color: "var(--text2)" }}>{selectedProjectName}</strong>.</>
      : filtersActive
        ? <>Showing all projects, filtered.</>
        : <>Showing all projects — last {DEFAULT_WINDOW_DAYS} days. Select a project to see its full history.</>;

  const emptyLabel = filtersActive
    ? "Nothing matches these filters."
    : selectedTaskId
      ? "No activity logged yet for this item."
      : selectedProjectId
        ? "No activity logged yet for this project."
        : `No activity logged across any project in the last ${DEFAULT_WINDOW_DAYS} days.`;

  const blockers   = position?.blockers || [];
  const unassigned = position?.unassigned || 0;
  const withDMZero = position && position.withDM === 0;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Activity Feed</h1>
        <button
          className="btn btn-ghost"
          onClick={handleExport}
          disabled={exporting || loadingData || entries.length === 0}
          title={entries.length === 0 ? "Nothing to export" : "Download exactly what is shown below"}
        >
          {exporting ? "Preparing…" : "⤓ Export"}
        </button>
      </div>

      <div className="form-card">
        {/* ── Scope ──────────────────────────────────────────────────── */}
        <div className="form-selectors">
          <select value={selectedProjectId} onChange={(e) => setSelectedProjectId(e.target.value)}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <select
            value={selectedTaskId}
            onChange={(e) => setSelectedTaskId(e.target.value)}
            disabled={!selectedProjectId || tasks.length === 0}
          >
            <option value="">All items in project</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>

        {/* ── Filters ────────────────────────────────────────────────── */}
        <div className="filter-block">
          <div className="filter-row" data-filtering={selectedTags.size > 0}>
            <span className="filter-legend">Tag</span>
            <div className="tag-picker">
              {TAGS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`tag-picker-btn tag-${t.replace("#", "")}${selectedTags.has(t) ? " selected" : ""}`}
                  aria-pressed={selectedTags.has(t)}
                  onClick={() => toggleIn(setSelectedTags)(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-row" data-filtering={selectedSources.size > 0}>
            <span className="filter-legend">Source</span>
            <div className="tag-picker">
              {SOURCES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`source-filter-btn${selectedSources.has(s) ? " selected" : ""}`}
                  aria-pressed={selectedSources.has(s)}
                  onClick={() => toggleIn(setSelectedSources)(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-row">
            <span className="filter-legend">Date</span>
            <div className="filter-dates">
              <input type="date" className="filter-date" value={fromDate} max={toDate || undefined}
                     onChange={(e) => setFromDate(e.target.value)} aria-label="From date" />
              <span className="filter-date-sep">to</span>
              <input type="date" className="filter-date" value={toDate} min={fromDate || undefined}
                     onChange={(e) => setToDate(e.target.value)} aria-label="To date" />
              {filtersActive && (
                <button type="button" className="btn btn-ghost btn-sm filter-clear" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
          </div>
        </div>

        <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 16 }}>{scopeLabel}</div>

        {/* ── Current position ───────────────────────────────────────── */}
        {/* Zero in Greig's court is the target, so it gets to look like an achievement.
            The colour never carries the meaning on its own — the label says "with DM"
            either way. */}
        <div className="section-label">Current position</div>

        {posError && <div className="save-result error" style={{ marginBottom: 16 }}>{posError}</div>}

        {position && (
          <>
            <div className="position-header">
              <div className={`position-hero${withDMZero ? " position-hero-clear" : ""}`}>
                <div className="position-hero-value">{position.withDM}</div>
                <div className="position-hero-label">
                  {withDMZero ? "nothing with DM" : "with DM"}
                </div>
              </div>

              <div className="position-tiles">
                <div className="stat-tile">
                  <div className="stat-value">{position.open}</div>
                  <div className="stat-label">open</div>
                </div>
                <div className="stat-tile">
                  <div className={`stat-value${position.blocked > 0 ? " stat-value-alert" : ""}`}>{position.blocked}</div>
                  <div className="stat-label">blocked</div>
                </div>
              </div>
            </div>

            {position.errors?.length > 0 && (
              <div className="position-note">⚠ {position.errors.join(" · ")}</div>
            )}

            {/* Absence should be silent — no "no blockers" placeholder. */}
            {blockers.length > 0 && (
              <div className="blocker-strip">
                <div className="blocker-strip-title">⚠ Blocked</div>
                {blockers.map((b) => (
                  <div key={b.id} className="blocker-row">
                    <span className={`source-badge source-badge-${b.source === "RFI" ? "rfi" : "ai"}`}>{b.source}</span>
                    <span className="blocker-item">{b.ref ? `${b.ref} — ` : ""}{b.item || "(unassigned)"}</span>
                    <span className="blocker-reason">{b.reason}</span>
                    <span className="blocker-bic">BIC {b.bic}</span>
                    {b.url && <a className="activity-row-link" href={b.url} target="_blank" rel="noreferrer">↗</a>}
                  </div>
                ))}
              </div>
            )}

            {/* A tracked row with no item can never reach an item feed. Showing it is the
                whole point — hiding it would make it invisible instead of fixable. */}
            {unassigned > 0 && (
              <div className="unassigned-note">
                ⚠ {unassigned} tracked {unassigned === 1 ? "item is" : "items are"} not linked to an item —
                add the relation in Notion so {unassigned === 1 ? "it reaches" : "they reach"} the right feed.
              </div>
            )}
          </>
        )}

        {/* ── Feed ───────────────────────────────────────────────────── */}
        <div className="section-label" style={{ marginTop: 24 }}>Feed</div>

        {exportError && <div className="save-result error" style={{ marginBottom: 12 }}>{exportError}</div>}

        {loadingData && (
          <div className="state-loading"><div className="spinner" /><div>Loading…</div></div>
        )}

        {!loadingData && loadError && <div className="state-error">{loadError}</div>}

        {!loadingData && !loadError && entries.length === 0 && (
          <div className="state-empty">{emptyLabel}</div>
        )}

        {!loadingData && !loadError && entries.length > 0 && (
          <div className="activity-feed-list">
            {entries.map((e) => {
              const isOpen = expandedIds.has(e.id);
              return (
                <div
                  key={e.id}
                  className={`activity-row ${isEmphasised(e.source) ? "activity-row-manual" : "activity-row-system"}`}
                >
                  <div className="activity-row-header">
                    <span className="activity-row-time">{formatTimestamp(e.eventDate || e.created)}</span>
                    {e.link && (
                      <a className="activity-row-link" href={e.link} target="_blank" rel="noreferrer">↗ Link</a>
                    )}
                  </div>

                  {showItemLabel && e.taskName && (
                    <div className="activity-row-item">
                      {showProjectLabel && e.projectName ? `${e.projectName} — ${e.taskName}` : e.taskName}
                    </div>
                  )}

                  <div className="activity-row-entry">{e.entry}</div>

                  <ActivityDetail
                    id={e.id}
                    detail={e.detail}
                    files={e.files}
                    isOpen={isOpen}
                    onToggle={() => toggleExpanded(e.id)}
                    isImageFile={isImageFile}
                  />

                  <div className="activity-row-footer">
                    <span className={`tag-pill tag-${(e.tag || "").replace("#", "")}`}>{e.tag}</span>
                    <span className="source-badge">{e.source}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

window.ActivityFeed = ActivityFeed;
