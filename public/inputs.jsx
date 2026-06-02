// inputs.jsx — Programme Inputs Form
// Project / Task selectors → 7 programme fields.
// Client review periods (Approval Days, Revision Days, C01 Sign Off Days) live in
// the Projects DB — read by the scheduling tool directly, not edited here.
// Task scope shows project defaults as placeholders; overridden fields are bold
// with a ↩ inherit link to clear back to null.

const { useState, useEffect, useCallback } = React;

// ─── Field definitions ────────────────────────────────────────────────────────

const FIELDS = [
  { key: "programmeStart", label: "Programme Start",  unit: "",      type: "date"   },
  { key: "s3LeadTime",     label: "S3 Lead Time",     unit: "days",  type: "number" },
  { key: "s4LeadTime",     label: "S4 Lead Time",     unit: "days",  type: "number" },
  { key: "s4QaDays",       label: "S4 QA Days",       unit: "days",  type: "number" },
  { key: "s5LeadTime",     label: "S5 Lead Time",     unit: "days",  type: "number" },
  { key: "s5QaDays",       label: "S5 QA Days",       unit: "days",  type: "number" },
  { key: "c01LeadTime",    label: "C01 Lead Time",    unit: "days",  type: "number" },
];

const EMPTY_VALUES = () => Object.fromEntries(FIELDS.map((f) => [f.key, null]));

// ─── InputsForm ───────────────────────────────────────────────────────────────

const InputsForm = () => {
  const [projects,          setProjects]          = useState([]);
  const [tasks,             setTasks]             = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedTaskId,    setSelectedTaskId]    = useState("");
  const [projectDefaults,   setProjectDefaults]   = useState(EMPTY_VALUES());
  const [values,            setValues]            = useState(EMPTY_VALUES()); // current editing state
  const [existingId,        setExistingId]        = useState(null);           // page ID if row exists
  const [saving,            setSaving]            = useState(false);
  const [saveResult,        setSaveResult]        = useState(null);           // { ok, msg }
  const [loadingData,       setLoadingData]       = useState(false);

  const isTaskScope = Boolean(selectedTaskId);

  // ── Fetch projects on mount ────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then(({ projects }) => setProjects(projects || []))
      .catch(() => {});
  }, []);

  // ── Fetch tasks when project changes ──────────────────────────────────
  useEffect(() => {
    setSelectedTaskId("");
    setTasks([]);
    if (!selectedProjectId) {
      setValues(EMPTY_VALUES());
      setProjectDefaults(EMPTY_VALUES());
      setExistingId(null);
      return;
    }
    fetch(`/api/tasks?projectId=${selectedProjectId}`)
      .then((r) => r.json())
      .then(({ tasks }) => setTasks(tasks || []))
      .catch(() => {});
  }, [selectedProjectId]);

  // ── Fetch inputs when project or task selection changes ───────────────
  const loadInputs = useCallback(async () => {
    if (!selectedProjectId) return;
    setLoadingData(true);
    setSaveResult(null);
    try {
      if (isTaskScope) {
        const r = await fetch(`/api/df/inputs/${selectedProjectId}/${selectedTaskId}`);
        const data = await r.json();
        // project object has defaults; task object has overrides (nulls = inherit)
        const projVals = {};
        const taskVals = {};
        for (const f of FIELDS) {
          projVals[f.key] = data.project?.[f.key] ?? null;
          taskVals[f.key] = data.task?.[f.key] ?? null;
        }
        setProjectDefaults(projVals);
        setValues(taskVals);
        setExistingId(data.taskId || null);
      } else {
        const r = await fetch(`/api/df/inputs/${selectedProjectId}`);
        const data = await r.json();
        const vals = {};
        for (const f of FIELDS) {
          vals[f.key] = data.inputs?.[f.key] ?? null;
        }
        setProjectDefaults(EMPTY_VALUES());
        setValues(vals);
        setExistingId(data.id || null);
      }
    } catch { /* silent */ }
    finally { setLoadingData(false); }
  }, [selectedProjectId, selectedTaskId, isTaskScope]);

  useEffect(() => {
    loadInputs();
  }, [loadInputs]);

  // ── Field change handler ───────────────────────────────────────────────
  const handleChange = (key, raw) => {
    setSaveResult(null);
    const f = FIELDS.find((x) => x.key === key);
    if (!f) return;
    if (raw === "" || raw === null) {
      setValues((v) => ({ ...v, [key]: null }));
    } else {
      setValues((v) => ({ ...v, [key]: f.type === "number" ? Number(raw) : raw }));
    }
  };

  // ↩ inherit — clear override, revert to null so project default applies
  const handleInherit = (key) => {
    setSaveResult(null);
    setValues((v) => ({ ...v, [key]: null }));
  };

  // ── Save ───────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    setSaveResult(null);
    try {
      const body = {
        projectId: selectedProjectId,
        ...(isTaskScope ? { taskId: selectedTaskId } : {}),
        scope: isTaskScope ? "Task" : "Project",
        ...values,
      };
      const r = await fetch("/api/df/inputs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (data.ok) {
        setExistingId(data.id);
        setSaveResult({ ok: true, msg: data.created ? "Saved (new row created)" : "Saved" });
      } else {
        setSaveResult({ ok: false, msg: data.error || "Save failed" });
      }
    } catch (err) {
      setSaveResult({ ok: false, msg: err.message });
    } finally {
      setSaving(false);
    }
  };

  // ── Reset overrides (task scope only) ─────────────────────────────────
  const handleResetOverrides = () => {
    setSaveResult(null);
    setValues(EMPTY_VALUES());
  };

  // ── Render ─────────────────────────────────────────────────────────────

  const effectiveValue = (key) => {
    // What's actually in effect: task value (if set) else project default
    return values[key] !== null && values[key] !== undefined
      ? values[key]
      : projectDefaults[key];
  };

  const isOverridden = (key) => {
    return isTaskScope && values[key] !== null && values[key] !== undefined;
  };

  const hasAnyOverride = FIELDS.some((f) => isOverridden(f.key));

  const selectedProjectName = projects.find((p) => p.id === selectedProjectId)?.name || "";
  const selectedTaskName    = tasks.find((t)    => t.id === selectedTaskId)?.name    || "";

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Programme Inputs</h1>
        {existingId && (
          <div className="page-meta">Row exists in Notion</div>
        )}
      </div>

      <div className="form-card">
        {/* ── Selectors ─────────────────────────────────────────────── */}
        <div className="form-selectors">
          <select
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
          >
            <option value="">Select project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          <select
            value={selectedTaskId}
            onChange={(e) => setSelectedTaskId(e.target.value)}
            disabled={!selectedProjectId || tasks.length === 0}
          >
            <option value="">Project defaults (no task override)</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.itemNo ? `${String(t.itemNo).padStart(3, "0")} — ` : ""}{t.name}
              </option>
            ))}
          </select>
        </div>

        {!selectedProjectId && (
          <div className="state-empty" style={{ padding: "32px 0" }}>
            Select a project to view or edit programme inputs.
          </div>
        )}

        {selectedProjectId && loadingData && (
          <div className="state-loading" style={{ padding: "32px 0" }}>
            <div className="spinner" />
            <div>Loading…</div>
          </div>
        )}

        {selectedProjectId && !loadingData && (
          <>
            {/* Scope context */}
            {isTaskScope && (
              <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 16 }}>
                Editing task overrides for{" "}
                <strong style={{ color: "var(--text2)" }}>{selectedTaskName}</strong>{" "}
                within{" "}
                <strong style={{ color: "var(--text2)" }}>{selectedProjectName}</strong>.
                Fields left blank inherit the project default (shown as placeholder).
              </div>
            )}

            {/* ── Fields ────────────────────────────────────────────── */}
            <div className="section-label">⏱ Programme</div>

            {FIELDS.map((f) => {
              const overridden  = isOverridden(f.key);
              const placeholder = isTaskScope
                ? (projectDefaults[f.key] !== null && projectDefaults[f.key] !== undefined
                    ? String(projectDefaults[f.key])
                    : "—")
                : "";

              return (
                <div key={f.key} className="field-row">
                  <label className="field-label" htmlFor={`field-${f.key}`}>
                    {f.label}
                  </label>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input
                      id={`field-${f.key}`}
                      type={f.type}
                      className={`field-input${overridden ? " overridden" : ""}`}
                      value={values[f.key] !== null && values[f.key] !== undefined ? values[f.key] : ""}
                      placeholder={placeholder}
                      min={f.type === "number" ? 0 : undefined}
                      step={f.type === "number" ? 1 : undefined}
                      onChange={(e) => handleChange(f.key, e.target.value)}
                    />
                    {overridden && (
                      <button
                        className="inherit-btn"
                        onClick={() => handleInherit(f.key)}
                        title="Clear override — inherit project default"
                      >
                        ↩ inherit
                      </button>
                    )}
                  </div>
                  <div className="field-unit">{f.unit}</div>
                </div>
              );
            })}

            {/* ── Footer ────────────────────────────────────────────── */}
            <div className="form-footer">
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save"}
              </button>

              {isTaskScope && hasAnyOverride && (
                <button
                  className="btn btn-ghost"
                  onClick={handleResetOverrides}
                  disabled={saving}
                >
                  Reset overrides
                </button>
              )}

              {saveResult && (
                <div className={`save-result ${saveResult.ok ? "ok" : "error"}`}>
                  {saveResult.msg}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

window.InputsForm = InputsForm;
