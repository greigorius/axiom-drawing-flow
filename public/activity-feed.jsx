// activity-feed.jsx — Item Activity Feed
// Default view: all projects, last 7 days. Select a project to see all its activity
// (unbounded by date). Select an item within that project to see its full history and
// add manual notes. Replaces the (unused) Programme Inputs tab — same selector pattern,
// same /api/projects + /api/tasks lookups, swapped for the feed instead of the form.
//
// Entries are auto-logged by the Drawing Flow backend on submission events
// (ingest / approve / bounce / issue / log-status). The quick-log form (only shown once
// a specific item is selected — a note has to attach to one Task) adds manual notes, and
// can also backfill historical entries once the backend supports passing eventDate from
// this form (see ITEM-ACTIVITY-FEED-HANDOFF.md and BUILD-SEQUENCE.md).

const { useState, useEffect, useCallback, useRef } = React;

const TAGS = ["#decision", "#instruction", "#query", "#response", "#issue", "#approval", "#info"];
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
  const [projects,          setProjects]          = useState([]);
  const [tasks,             setTasks]             = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedTaskId,    setSelectedTaskId]    = useState("");
  const [entries,           setEntries]           = useState([]);
  const [loadingData,       setLoadingData]       = useState(false);
  const [loadError,         setLoadError]         = useState(null);
  const [expandedIds,       setExpandedIds]       = useState(() => new Set());

  // ── Quick-log form state ────────────────────────────────────────────────
  const [noteText,    setNoteText]    = useState("");
  const [selectedTag, setSelectedTag] = useState(null);
  const [posting,     setPosting]     = useState(false);
  const [postError,   setPostError]   = useState(null);

  // ── Fetch projects on mount ─────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then(({ projects }) => setProjects(projects || []))
      .catch(() => {});
  }, []);

  // ── Fetch tasks when project changes ────────────────────────────────────
  useEffect(() => {
    setSelectedTaskId("");
    setTasks([]);
    if (!selectedProjectId) return;
    fetch(`/api/tasks?projectId=${selectedProjectId}`)
      .then((r) => r.json())
      .then(({ tasks }) => setTasks(tasks || []))
      .catch(() => {});
  }, [selectedProjectId]);

  // ── Fetch feed entries — three modes, in priority order ────────────────
  //   item selected    -> full history for that one item, unbounded by date
  //   project selected -> all activity across every item in that project, unbounded
  //   nothing selected -> global feed across all projects, last DEFAULT_WINDOW_DAYS days
  const loadEntries = useCallback(async () => {
    setLoadingData(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      if (selectedTaskId) {
        params.set("taskId", selectedTaskId);
        params.set("limit", "50");
      } else if (selectedProjectId) {
        params.set("projectId", selectedProjectId);
        params.set("limit", "100");
      } else {
        params.set("days", String(DEFAULT_WINDOW_DAYS));
        params.set("limit", "100");
      }
      const r = await fetch(`/api/df/activity-log?${params.toString()}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Failed to load feed");
      setEntries(data.entries || []);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoadingData(false);
    }
  }, [selectedProjectId, selectedTaskId]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  // Rows default to a single-line summary (Entry only) — Detail text and media
  // attachments are hidden behind a per-row toggle so a busy feed stays scannable.
  const toggleExpanded = (id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // ── Submit a manual note — optimistic, rolls back on failure ───────────
  const handleSubmitNote = async () => {
    const trimmed = noteText.trim();
    if (!trimmed || !selectedTag || !selectedTaskId || posting) return;

    setPosting(true);
    setPostError(null);

    const optimisticId = `optimistic-${Date.now()}`;
    setEntries((prev) => [{
      id:        optimisticId,
      created:   new Date().toISOString(),
      eventDate: null,
      entry:     trimmed,
      source:    "Manual",
      tag:       selectedTag,
      author:    "DM",
      detail:    "",
      link:      "",
      files:     [],
      taskId:    selectedTaskId,
      taskName:  selectedTaskName,
    }, ...prev]);
    setNoteText("");
    setSelectedTag(null);

    try {
      const r = await fetch("/api/df/activity-log", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ taskId: selectedTaskId, tag: selectedTag, entry: trimmed, author: "DM" }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Save failed");
      setEntries((prev) => prev.map((e) => (e.id === optimisticId ? { ...data.entry, taskId: selectedTaskId, taskName: selectedTaskName } : e)));
    } catch (err) {
      // Roll back — remove the optimistic row and restore the form so nothing is lost
      setEntries((prev) => prev.filter((e) => e.id !== optimisticId));
      setPostError(err.message);
      setNoteText(trimmed);
      setSelectedTag(selectedTag);
    } finally {
      setPosting(false);
    }
  };

  // ── Render helpers ───────────────────────────────────────────────────────
  const selectedProjectName = projects.find((p) => p.id === selectedProjectId)?.name || "";
  const selectedTaskName    = tasks.find((t)    => t.id === selectedTaskId)?.name    || "";

  const formatTimestamp = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };

  const isEmphasised = (source) => source === "Manual" || source === "Email";

  // Images render as clickable thumbnails; everything else (PDFs, docs, etc.) renders
  // as a plain file chip with its name. Judged by extension since Notion doesn't expose
  // a content-type — good enough for the file kinds this DB actually sees.
  const isImageFile = (f) => /\.(png|jpe?g|gif|webp|svg|bmp)(\?|$)/i.test(f.url || f.name || "");

  // Entries only need a per-row item label when the feed can span more than one item
  // (global or project-scoped views) — once a specific item is selected it's redundant.
  const showItemLabel = !selectedTaskId;

  // Project name is only ambiguous in the true global view (no project selected) — once
  // a project is chosen, the scope line above already says which one, so repeating it on
  // every row would just be noise.
  const showProjectLabel = !selectedProjectId;

  const scopeLabel = selectedTaskId
    ? <>Activity for <strong style={{ color: "var(--text2)" }}>{selectedTaskName}</strong> within <strong style={{ color: "var(--text2)" }}>{selectedProjectName}</strong>.</>
    : selectedProjectId
      ? <>Showing all activity for <strong style={{ color: "var(--text2)" }}>{selectedProjectName}</strong>.</>
      : <>Showing all projects — last {DEFAULT_WINDOW_DAYS} days. Select a project to see its full history.</>;

  const emptyLabel = selectedTaskId
    ? "No activity logged yet for this item."
    : selectedProjectId
      ? "No activity logged yet for this project."
      : `No activity logged across any project in the last ${DEFAULT_WINDOW_DAYS} days.`;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Activity Feed</h1>
      </div>

      <div className="form-card">
        {/* ── Selectors ─────────────────────────────────────────────── */}
        <div className="form-selectors">
          <select
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          <select
            value={selectedTaskId}
            onChange={(e) => setSelectedTaskId(e.target.value)}
            disabled={!selectedProjectId || tasks.length === 0}
          >
            <option value="">All items in project</option>
            {tasks.map((t) => (
              // "Item Name" already reads like "Suffix 022 - Description" — no need to
              // prefix itemNo separately (unlike the old Programme Inputs dropdown).
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>

        <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 16 }}>
          {scopeLabel}
        </div>

        {loadingData && (
          <div className="state-loading">
            <div className="spinner" />
            <div>Loading…</div>
          </div>
        )}

        {!loadingData && loadError && (
          <div className="state-error">{loadError}</div>
        )}

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
                      <a className="activity-row-link" href={e.link} target="_blank" rel="noreferrer">
                        ↗ Link
                      </a>
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

        {/* ── Quick-log form — only once a specific item is selected; a note has to attach to one Task ── */}
        {selectedTaskId ? (
          <>
            <div className="section-label" style={{ marginTop: 24 }}>Add a note</div>

            <textarea
              className="field-input activity-note-input"
              placeholder="Add a note…"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              rows={3}
            />

            <div className="tag-picker">
              {TAGS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`tag-picker-btn tag-${t.replace("#", "")}${selectedTag === t ? " selected" : ""}`}
                  onClick={() => setSelectedTag(t)}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="form-footer">
              <button
                className="btn btn-primary"
                disabled={!noteText.trim() || !selectedTag || posting}
                onClick={handleSubmitNote}
              >
                {posting ? "Logging…" : "Log entry"}
              </button>
              {postError && <div className="save-result error">{postError}</div>}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 20 }}>
            Select a specific item to add a note.
          </div>
        )}
      </div>
    </div>
  );
};

window.ActivityFeed = ActivityFeed;
