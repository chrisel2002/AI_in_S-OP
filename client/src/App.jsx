import { useEffect, useState, useRef } from "react";
import { getDashboard, getRules, deleteRule, getOrders, getAiBriefing, getSignalStatuses, setSignalStatus, clearSignalStatus, updateSignal, getAiRecommendations } from "./api.js";
import RuleBuilder from "./RuleBuilder.jsx";
import Chat from "./Chat.jsx";
import { ChevronLeft, ChevronRight, Activity, AlertTriangle, TrendingDown, SlidersHorizontal } from "lucide-react";

function SearchableSelect({ value, onChange, options, placeholder = "All", labelMap = {} }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef(null);
  const inputRef = useRef(null);
  const showSearch = options.length > 5;

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    if (open) { setSearch(""); if (showSearch) setTimeout(() => inputRef.current?.focus(), 0); }
  }, [open]);

  const displayLabel = (o) => labelMap[o] || o;
  const filtered = options.filter((o) => displayLabel(o).toLowerCase().includes(search.toLowerCase()));
  const label = value === "all" ? placeholder : displayLabel(value);

  return (
    <div className="ss-wrap" ref={ref}>
      <button className={`ss-trigger ${open ? "ss-trigger-open" : ""}`} onClick={() => setOpen((v) => !v)}>
        <span className="ss-trigger-label">{label}</span>
      </button>
      {open && (
        <div className="ss-dropdown">
          {showSearch && (
            <div className="ss-search-row">
              <input
                ref={inputRef}
                className="ss-search"
                type="text"
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          )}
          <div className="ss-list">
            <button className={`ss-option ${value === "all" ? "ss-option-active" : ""}`}
              onClick={() => { onChange("all"); setOpen(false); }}>
              {placeholder}
            </button>
            {filtered.length === 0 && <div className="ss-empty">No match</div>}
            {filtered.map((o) => (
              <button key={o} className={`ss-option ${value === o ? "ss-option-active" : ""}`}
                onClick={() => { onChange(o); setOpen(false); }}>
                {displayLabel(o)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const typePill = {
  "Stockout risk": "pill-red",
  "Demand drop": "pill-amber",
  "Demand surge": "pill-blue",
  "Forecast deviation": "pill-teal",
  "New demand": "pill-teal",
};
const urgencyPill = { High: "pill-red", Medium: "pill-amber", Low: "pill-teal" };
// Scores are on a 0-10 scale throughout the app: >=8 High, >=5 Medium, else Low.
const barClass = (s) => (s >= 8 ? "bar-high" : s >= 5 ? "bar-med" : "bar-low");

const TYPE_COLOR_CLASS = {
  "Demand surge": "fill-yellow",
  "Low Inventory Coverage": "fill-red",
  "Stockout risk": "fill-red",
  "Demand drop": "fill-amber",
  "Forecast deviation": "fill-teal",
  "New demand": "fill-purple",
};
const FALLBACK_FILL_CLASSES = ["fill-blue", "fill-red", "fill-amber", "fill-teal", "fill-purple", "fill-orange"];

const BUCKET_COLOR_CLASS = {
  "0–3": "fill-teal",
  "3–5": "fill-blue",
  "5–7": "fill-amber",
  "7–9": "fill-orange",
  "9–10": "fill-red",
};

function BarChart({ data, colorClassMap, fallbackClasses, compact }) {
  const max = Math.max(1, ...Object.values(data));
  const entries = Object.entries(data);
  return (
    <div>
      {entries.map(([label, val], i) => {
        const fillClass =
          (colorClassMap && colorClassMap[label]) ||
          (fallbackClasses && fallbackClasses[i % fallbackClasses.length]) ||
          "fill-blue";
        return (
          <div className="cbar" key={label}>
            <span className={compact ? "cbar-label cbar-label-compact" : "cbar-label"}>{label}</span>
            <span className="cbar-track">
              <span
                className={`cbar-fill ${fillClass}`}
                style={{ width: `${(val / max) * 100}%` }}
              />
            </span>
            <span className="cbar-val">{val}</span>
          </div>
        );
      })}
    </div>
  );
}

// Matches signal mentions in briefing prose, e.g. "Material 12345, Plant 1000"
// (template) or "material 12345, plant 1000" (LLM). Tolerates an optional comma
// and an optional "#" before the numbers.
const SIGNAL_MENTION_RE = /(material)\s+#?(\d+)\s*,?\s+(plant)\s+#?(\d+)/gi;

// Pick the signal a briefing mention refers to. allSignals is sorted by score
// desc, so the first material+plant match is the highest-priority one — which is
// exactly what the "top signals" briefing calls out.
function findMentionedSignal(signals, material, plant) {
  return (
    signals.find(
      (s) => Number(s.material) === Number(material) && Number(s.plant) === Number(plant)
    ) || null
  );
}

// Renders the briefing text, turning each signal mention into a clickable link
// that jumps to the matching row in the table below. Mentions with no matching
// signal are left as plain text. Newlines are preserved via CSS white-space.
function InteractiveBriefing({ text, signals, onPick }) {
  if (!text) return null;
  const parts = [];
  const re = new RegExp(SIGNAL_MENTION_RE); // fresh lastIndex
  let last = 0;
  let key = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [full, , material, , plant] = m;
    if (m.index > last) parts.push(text.slice(last, m.index));
    const sig = findMentionedSignal(signals, material, plant);
    if (sig) {
      parts.push(
        <button
          key={`sig-${key++}`}
          type="button"
          className="briefing-signal-link"
          onClick={() => onPick(sig)}
          title={`Go to signal: ${sig.type} — Material ${sig.material}, Plant ${sig.plant}`}
        >
          {full}
        </button>
      );
    } else {
      parts.push(full);
    }
    last = m.index + full.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export default function App() {
  const [dash, setDash] = useState(null);
  const [allSignals, setAllSignals] = useState([]);
  const [rules, setRules] = useState([]);
  const [typeFilter, setTypeFilter] = useState("all");
  const [urgencyFilter, setUrgencyFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [rulesSearch, setRulesSearch] = useState("");
  const [builder, setBuilder] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [page, setPage] = useState(0);
  const [aiBriefing, setAiBriefing] = useState(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [statuses, setStatuses] = useState({});
  const [highlightId, setHighlightId] = useState(null);
  const [scrollTarget, setScrollTarget] = useState(null);
  const PAGE_SIZE = 100;

  async function regenerateBriefing() {
    setBriefingLoading(true);
    try {
      const r = await getAiBriefing();
      setAiBriefing(r.briefing);
    } finally {
      setBriefingLoading(false);
    }
  }

  async function refresh({ fetchRules = false } = {}) {
    const fetches = [getDashboard()];
    console.log('fetches', fetches);
    if (fetchRules) fetches.push(getRules());
    const [d, r] = await Promise.all(fetches);
    console.log('dashboard', d);
    setDash(d);
    if (d.allSignals) setAllSignals(d.allSignals);
    if (r) setRules(r);
    setPage(0);
  }

  useEffect(() => {
    refresh({ fetchRules: true });
    getSignalStatuses().then(setStatuses).catch(() => {});
  }, []);

  // Scroll to (and briefly highlight) a signal row after a briefing link is clicked.
  // Runs after the page/expanded state has committed so the target row is mounted.
  useEffect(() => {
    if (scrollTarget == null) return;
    const el = document.getElementById(`signal-row-${scrollTarget}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setHighlightId(null), 2400);
    setScrollTarget(null);
    return () => clearTimeout(t);
  }, [scrollTarget]);

  // Jump from a briefing mention to the matching signal in the table below.
  function goToSignal(sig) {
    if (!sig) return;
    // Clear filters so the signal is guaranteed to be visible, then locate its page.
    setTypeFilter("all");
    setUrgencyFilter("all");
    setStatusFilter("all");
    const idx = allSignals.findIndex((x) => x.id === sig.id);
    if (idx === -1) return;
    setPage(Math.floor(idx / PAGE_SIZE));
    setExpanded(sig.id);
    setHighlightId(sig.id);
    setScrollTarget(sig.id);
  }

  async function handleSetStatus(key, status) {
    await setSignalStatus(key, status);
    setStatuses((prev) => ({ ...prev, [key]: { status } }));
  }

  async function handleClearStatus(key) {
    await clearSignalStatus(key);
    setStatuses((prev) => { const n = { ...prev }; delete n[key]; return n; });
  }

  function handleSignalUpdate(mongoId, updatedSignal) {
    if (updatedSignal) {
      setAllSignals((prev) => prev.map((s) => s._id === mongoId ? updatedSignal : s));
    } else {
      // Signal disappeared or changed type after recalculation — reload
      refresh();
    }
  }

  async function handleExportCSV() {
    const signals = typeFilter === "all" ? allSignals : allSignals.filter(s => s.type === typeFilter);
    const briefingText = aiBriefing || dash.briefing || "";
    const header = ["Type", "Material", "Plant", "Sales Office", "Month", "Severity", "Priority", "Detail", "Status"].join(",");
    const rows = signals.map((s) => {
      const st = statuses[s.key]?.status || "open";
      return [
        `"${s.type}"`, s.material, s.plant, s.salesOffice,
        s.month, s.priority, s.score,
        `"${(s.detail || "").replace(/"/g, '""')}"`,
        st,
      ].join(",");
    });
    const briefingLines = briefingText.split("\n").map((l) => `# ${l}`).join("\n");
    const csv = `# S&OP Signal Export — ${new Date().toISOString().slice(0, 10)}\n${briefingLines}\n\n${header}\n${rows.join("\n")}`;
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sop-signals-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!dash) return <div className="db">Loading dashboard…</div>;

  // All filtering and pagination is client-side — no server round-trips needed.
  const filteredSignals = allSignals.filter((s) => {
    if (typeFilter !== "all" && s.type !== typeFilter) return false;
    if (urgencyFilter !== "all" && s.priority !== urgencyFilter) return false;
    if (statusFilter !== "all") {
      const st = statuses[s.key]?.status || null;
      if (statusFilter === "open" && st !== null) return false;
      if (statusFilter !== "open" && st !== statusFilter) return false;
    }
    return true;
  });
  const totalPages = Math.max(1, Math.ceil(filteredSignals.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pagedSignals = filteredSignals.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const displayStart = filteredSignals.length ? safePage * PAGE_SIZE + 1 : 0;
  const displayEnd = safePage * PAGE_SIZE + pagedSignals.length;

  const k = dash.kpis;

  const handleTypeChange = (newType) => {
    setTypeFilter(newType);
    setUrgencyFilter("all");
    setStatusFilter("all");
    setExpanded(null);
    setPage(0);
  };

  const handleNext = () => setPage((p) => Math.min(p + 1, totalPages - 1));
  const handlePrev = () => setPage((p) => Math.max(p - 1, 0));

  // Build dropdown options: byType (all signals) + any custom rule names not yet producing signals
  const dropdownTypes = [
    ...Object.keys(dash.byType),
    ...rules.map((r) => r.name).filter((n) => n && !dash.byType[n]),
  ];

  return (
    <>
      {/* top bar — full viewport width, outside the max-width container */}
      <div className="topbar">
        <div className="topbar-inner">
          <div className="topbar-brand">
            <div className="topbar-tk-logo">
              {/* ThyssenKrupp three-circle mark */}
              <svg width="34" height="34" viewBox="0 0 50 52" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <circle cx="25" cy="17" r="14" stroke="white" strokeWidth="2.6"/>
                <circle cx="14" cy="37" r="14" stroke="white" strokeWidth="2.6"/>
                <circle cx="36" cy="37" r="14" stroke="white" strokeWidth="2.6"/>
              </svg>
              <span className="tk-logo-name">thyssenkrupp</span>
            </div>
            <div className="topbar-divider" />
            <div>
              <div className="topbar-title">S&amp;OP Signal Dashboard</div>
              <div className="topbar-meta">Planning cycle 2026-06 · {k.rulesActive} active custom rules</div>
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => setBuilder({})}>+ Add rule</button>
        </div>
      </div>

    <div className="db">
      {/* Briefing */}
      <div className="briefing-box">
        <div className="briefing-box-header">
          <span className="briefing-box-title">✨ Planning Briefing</span>
          <button className="link-btn" onClick={regenerateBriefing} disabled={briefingLoading}>
            {briefingLoading ? "Generating…" : "Regenerate with AI"}
          </button>
        </div>
        <div className="briefing-box-text">
          <InteractiveBriefing
            text={aiBriefing || dash.briefing}
            signals={allSignals}
            onPick={goToSignal}
          />
        </div>
      </div>

      {/* KPI cards */}
      <div className="metrics">
        <div className="metric">
          <div className="metric-header">
            <span className="metric-label">Total signals</span>
            <Activity size={15} className="metric-icon" />
          </div>
          <div className="metric-val">{k.total}</div>
          <div className="metric-sub">all active signals</div>
        </div>
        <div className="metric metric-critical">
          <div className="metric-header">
            <span className="metric-label">High severity</span>
            <AlertTriangle size={15} className="metric-icon" />
          </div>
          <div className="metric-val red">{k.critical}</div>
          <div className="metric-sub">priority ≥ 85</div>
        </div>
        <div className="metric metric-medium">
          <div className="metric-header">
            <span className="metric-label">Medium severity</span>
            <TrendingDown size={15} className="metric-icon" />
          </div>
          <div className="metric-val amber">{k.medium}</div>
          <div className="metric-sub">priority 60 – 84</div>
        </div>
        <div className="metric metric-rules">
          <div className="metric-header">
            <span className="metric-label">Custom rules active</span>
            <SlidersHorizontal size={15} className="metric-icon" />
          </div>
          <div className="metric-val green">{k.rulesActive}</div>
          <div className="metric-sub">user-defined</div>
        </div>
      </div>

      {/* charts */}
      <div className="chart-row">
        <div className="card">
          <div className="card-title">Signals by type</div>
          <BarChart
            data={dash.byType}
            colorClassMap={TYPE_COLOR_CLASS}
            fallbackClasses={FALLBACK_FILL_CLASSES}
          />
        </div>
        <div className="card">
          <div className="card-title">Priority distribution</div>
          <BarChart
            data={dash.byBucket}
            colorClassMap={BUCKET_COLOR_CLASS}
            compact
          />
        </div>
      </div>

      {/* custom rules list */}
      {rules.length > 0 && (
        <div className="card spacer">
          <div className="rules-card-header">
            <div className="card-title">
              Custom rules
              <span className="rules-count">{rules.length}</span>
            </div>
            {rules.length > 4 && (
              <input
                className="rules-search"
                type="search"
                placeholder="Search rules…"
                value={rulesSearch}
                onChange={(e) => setRulesSearch(e.target.value)}
              />
            )}
          </div>
          <div className="rules-list rules-list-scroll">
            {rules.filter((r) => r.name?.toLowerCase().includes(rulesSearch.toLowerCase())).map((r) => (
              <div className="rule-item" key={r._id}>
                <div>
                  <b>{r.name}</b>{" "}
                  <small>
                    {r.metric} {r.operator} {r.threshold}
                    {r.comparison_type === "percent_change" ? " %" : " t"}
                  </small>
                </div>
                <div className="row-gap">
                  <button className="link-btn" onClick={() => setBuilder(r)}>Edit</button>
                  <button className="link-btn" onClick={async () => {
                    // Optimistic: remove immediately from rules list
                    setRules((prev) => prev.filter((x) => x._id !== r._id));
                    if (typeFilter === r.name) { setTypeFilter("all"); setPage(0); }
                    await deleteRule(r._id);
                    refresh({ fetchRules: true });
                  }}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* signal table */}
      <div className="card">
        <div className="table-header-row">
          <div>
            <div className="table-title">Signal table — prioritised</div>
            <div className="table-subtitle">
              {displayStart}–{displayEnd} of {filteredSignals.length} signals &nbsp;·&nbsp; Page {safePage + 1} of {totalPages}
            </div>
          </div>

          <div className="filters">
            <div className="pag-btns">
              <button className="pag-btn" onClick={handlePrev} disabled={safePage === 0}>
                <ChevronLeft size={14} />
              </button>
              <button className="pag-btn" onClick={handleNext} disabled={safePage >= totalPages - 1}>
                <ChevronRight size={14} />
              </button>
            </div>

            <SearchableSelect
              value={typeFilter}
              onChange={(v) => handleTypeChange(v)}
              options={dropdownTypes}
              placeholder="All types"
            />

            <SearchableSelect
              value={urgencyFilter}
              onChange={(v) => { setUrgencyFilter(v); setExpanded(null); }}
              options={["High", "Medium", "Low"]}
              placeholder="All severity"
            />

            <SearchableSelect
              value={statusFilter}
              onChange={(v) => { setStatusFilter(v); setExpanded(null); }}
              options={["open", "escalated", "actioned", "snoozed"]}
              placeholder="All status"
              labelMap={{ open: "Open (unmarked)", escalated: "Escalated", actioned: "Actioned", snoozed: "Snoozed" }}
            />

            <button className="btn export-btn" onClick={handleExportCSV} title="Export all signals to CSV">
              ↓ Export CSV
            </button>
          </div>
        </div>

        {pagedSignals.length === 0 ? (
          <div className="empty-state">No signals match the current filters.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Signal</th><th>Material</th><th>Plant</th>
                  <th>Month</th><th>Severity</th><th>Priority</th>
                  <th>Detail</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagedSignals.map((s) => (
                  <Row
                    key={s.id}
                    s={s}
                    highlighted={highlightId === s.id}
                    expanded={expanded === s.id}
                    onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
                    signalStatus={statuses[s.key]?.status || null}
                    onSetStatus={(st) => handleSetStatus(s.key, st)}
                    onClearStatus={() => handleClearStatus(s.key)}
                    onSignalUpdate={handleSignalUpdate}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {builder !== null && (
        <RuleBuilder
          existing={builder._id ? builder : null}
          onClose={() => setBuilder(null)}
          onSaved={(savedName) => {
            setBuilder(null);
            if (savedName && !builder._id) {
              setTypeFilter(savedName);
              setUrgencyFilter("all");
              setStatusFilter("all");
              setPage(0);
            }
            refresh({ fetchRules: true });
          }}
        />
      )}

      <Chat />
    </div>
    </>
  );
}

// ---- editable field configuration (frontend source of truth) -----------
// To expose additional fields in the future, add an entry here and on the
// server-side ALLOWED_EDITABLE_FIELDS set in index.js.
const EDITABLE_FIELDS = [
  { key: "sales_free_stock_in_tons",              label: "Sales Free Stock",            group: "Sales Forecast", editable: true, visible: true, unit: "t" },
  { key: "sales_contracts_in_tons",              label: "Sales Contracts",              group: "Sales Forecast", editable: true, visible: true, unit: "t" },
  { key: "sales_scheduling_agreement_in_tons",   label: "Sales Scheduling Agreement",  group: "Sales Forecast", editable: true, visible: true, unit: "t" },
];

// ---- PlanningInputs component ------------------------------------------
function PlanningInputs({ signal, localEdits, setLocalEdits, onSave, saving, saveStatus }) {
  const fields = EDITABLE_FIELDS.filter((f) => f.editable && f.visible);

  function handleChange(key, rawValue) {
    setLocalEdits((prev) => ({ ...prev, [key]: rawValue }));
  }

  function handleBlur(key, rawValue) {
    // Blank input on blur → restore saved value (remove from edits)
    if (rawValue === "" || rawValue === null || rawValue === undefined) {
      setLocalEdits((prev) => { const n = { ...prev }; delete n[key]; return n; });
    }
  }

  const hasRealChanges = fields.some((f) => {
    if (!(f.key in localEdits)) return false;
    const num = parseFloat(localEdits[f.key]);
    return Number.isFinite(num) && num !== (signal[f.key] ?? 0);
  });

  function handleSave() {
    const changed = {};
    for (const f of fields) {
      if (!(f.key in localEdits)) continue;
      const num = parseFloat(localEdits[f.key]);
      if (!Number.isFinite(num)) {
        alert(`"${f.label}" must be a valid number.`);
        return;
      }
      if (num !== (signal[f.key] ?? 0)) changed[f.key] = num;
    }
    if (Object.keys(changed).length === 0) return;
    onSave(changed);
  }

  function handleReset() {
    setLocalEdits({});
  }

  return (
    <div className="plan-inputs-section">
      <div className="sig-detail-section-title">Planning Inputs</div>
      <div className="plan-inputs-row">
        {fields.map((f) => {
          const savedVal = signal[f.key] ?? 0;
          const isDirty = f.key in localEdits && parseFloat(localEdits[f.key]) !== savedVal;
          const displayVal = f.key in localEdits ? localEdits[f.key] : savedVal;
          return (
            <div key={f.key} className={`plan-input-group${isDirty ? " plan-input-dirty" : ""}`}>
              <label className="plan-input-label">{f.label}</label>
              <div className="plan-input-wrap">
                <input
                  type="number"
                  step="any"
                  className="plan-input-field"
                  value={displayVal}
                  onChange={(e) => handleChange(f.key, e.target.value)}
                  onBlur={(e) => handleBlur(f.key, e.target.value)}
                  disabled={saving}
                />
                {f.unit && <span className="plan-input-unit">{f.unit}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="plan-inputs-actions">
        <button className="btn" onClick={handleReset} disabled={saving || !hasRealChanges}>
          Reset
        </button>
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving || !hasRealChanges}
        >
          {saving ? "Saving…" : "Save & Recalculate"}
        </button>
        {saveStatus === "success" && (
          <span className="plan-save-ok">✓ Saved</span>
        )}
        {saveStatus && saveStatus !== "success" && (
          <span className="plan-save-err">{saveStatus}</span>
        )}
      </div>
    </div>
  );
}

// ---- AiRecommendationsPanel component ----------------------------------
function AiRecommendationsPanel({ rowId, onApply }) {
  const [recs, setRecs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!rowId) { setLoading(false); return; }
    setLoading(true);
    setFailed(false);
    getAiRecommendations(rowId)
      .then((r) => setRecs(r?.recommendations || []))
      .catch(() => { setFailed(true); setRecs([]); })
      .finally(() => setLoading(false));
  }, [rowId]);

  if (loading) {
    return (
      <div className="action-skeleton">
        {[75, 90, 60].map((w, i) => (
          <div key={i} className="action-skeleton-item">
            <div className="skeleton-circle" />
            <div className="skeleton-lines">
              <div className="skeleton-line" style={{ width: `${w}%` }} />
              {w > 70 && <div className="skeleton-line" style={{ width: `${w - 30}%` }} />}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (failed || !recs || recs.length === 0) {
    return <p className="snap-fallback">{failed ? "Could not load AI recommendations." : "No recommendations available."}</p>;
  }

  return (
    <ol className="action-list ai-recs-list">
      {recs.map((rec, i) => (
        <li key={i} className="action-list-item">
          <span className="action-num">{i + 1}</span>
          <span className="action-text">
            {rec.text}
            {rec.changes && (
              <button
                className="ai-apply-btn"
                onClick={() => onApply(rec.changes)}
              >
                Apply
              </button>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

const SNAP_METRIC_LABELS = {
  sales_free_stock_in_tons: "Forecast (free stock)",
  sales_contracts_in_tons: "Forecast (contracts)",
  sales_scheduling_agreement_in_tons: "Forecast (sched. agr.)",
  historic_inventory_12_free_stock_in_tons: "Inventory 12M avg",
  historic_sales_12_free_stock_in_tons: "Historic sales 12M",
  historic_sales_24_free_stock_in_tons: "Historic sales 24M",
  historic_sales_12_contracts_in_tons: "Historic contracts 12M",
  historic_sales_24_contracts_in_tons: "Historic contracts 24M",
  historic_sales_12_scheduling_agreement_in_tons: "Historic sched. agr. 12M",
  historic_sales_24_scheduling_agreement_in_tons: "Historic sched. agr. 24M",
};

const OP_WORD = { "<": "below", "<=": "at or below", ">": "above", ">=": "at or above", "==": "equal to" };
const OP_SYM = { "<": "<", "<=": "≤", ">": ">", ">=": "≥", "==": "=" };
const fmtTons = (n) => `${Number(n).toFixed(2)} t`;
const metricLabel = (col) => SNAP_METRIC_LABELS[col] || col;

// Renders one custom-rule condition as a comparison card, matching the look of
// the built-in signal snapshots. Handles three shapes emitted by the server:
// a fixed threshold, a ratio of another metric, or a percent-change vs baseline.
function ConditionCard({ c }) {
  const label = metricLabel(c.metric);
  const opWord = OP_WORD[c.op] || c.op;

  if (c.mode === "ratio") {
    const baseLabel = metricLabel(c.baseline);
    const isDirect = c.factor === 1; // bare metric-vs-metric comparison
    const pct = (c.factor * 100).toFixed(0);
    const refDesc = isDirect ? baseLabel : `${pct}% of ${baseLabel}`;
    return (
      <div className="snap-cond">
        <div className="snap-compare">
          <div className="snap-col snap-col-alert">
            <div className="snap-col-date">{label}</div>
            <div className="snap-col-val">{fmtTons(c.value)}</div>
            <div className="snap-col-sub">This month</div>
          </div>
          <div className="snap-arrow">vs</div>
          <div className="snap-col">
            <div className="snap-col-date">{refDesc}</div>
            <div className="snap-col-val">{fmtTons(c.reference)}</div>
            <div className="snap-col-sub">Rule reference</div>
          </div>
        </div>
        <div className="snap-verdict">
          {fmtTons(c.value)} is {opWord} {refDesc} ({fmtTons(c.reference)})
        </div>
      </div>
    );
  }

  if (c.mode === "percent") {
    const baseLabel = metricLabel(c.baseline);
    const up = c.pct >= 0;
    return (
      <div className="snap-cond">
        <div className="snap-compare">
          <div className="snap-col">
            <div className="snap-col-date">{baseLabel}</div>
            <div className="snap-col-val">{fmtTons(c.baselineValue)}</div>
            <div className="snap-col-sub">Baseline</div>
          </div>
          <div className="snap-arrow">{up ? "▲" : "▼"}</div>
          <div className="snap-col snap-col-alert">
            <div className="snap-col-date">{label}</div>
            <div className="snap-col-val">{fmtTons(c.value)}</div>
            <div className="snap-col-sub">{up ? "+" : ""}{c.pct.toFixed(0)}% vs baseline</div>
          </div>
        </div>
        <div className="snap-verdict">
          {up ? "+" : ""}{c.pct.toFixed(0)}% change is {opWord} the {c.threshold}% threshold
        </div>
      </div>
    );
  }

  // threshold (fixed numeric limit)
  return (
    <div className="snap-cond">
      <div className="snap-compare">
        <div className="snap-col snap-col-alert">
          <div className="snap-col-date">{label}</div>
          <div className="snap-col-val">{fmtTons(c.value)}</div>
          <div className="snap-col-sub">This month</div>
        </div>
        <div className="snap-arrow">vs</div>
        <div className="snap-col">
          <div className="snap-col-date">Threshold</div>
          <div className="snap-col-val">{OP_SYM[c.op] || c.op} {fmtTons(c.threshold)}</div>
          <div className="snap-col-sub">Rule limit</div>
        </div>
      </div>
      <div className="snap-verdict">
        {fmtTons(c.value)} is {opWord} the {fmtTons(c.threshold)} threshold
      </div>
    </div>
  );
}

function SnapshotView({ snap, s }) {
  if (!snap) return <p className="snap-fallback">{s.reasoning}</p>;

  if (snap.kind === "conditions") {
    return (
      <div className="snap">
        <div className="snap-meta">
          {snap.logic === "OR" ? "Any of these conditions matched:" : "All of these conditions matched:"}
        </div>
        {snap.conditions.map((c, i) => <ConditionCard key={i} c={c} />)}
      </div>
    );
  }

  if (snap.kind === "mom_change") {
    const up = snap.changePct > 0;
    const absPct = Math.abs(snap.changePct).toFixed(0);
    return (
      <div className="snap">
        <div className="snap-meta">Forecast free-stock sales — month over month</div>
        <div className="snap-compare">
          <div className="snap-col">
            <div className="snap-col-date">{snap.prevDate}</div>
            <div className="snap-col-val">{snap.prevVal.toFixed(2)} t</div>
            <div className="snap-col-sub">Previous month</div>
          </div>
          <div className="snap-arrow">{up ? "▲" : "▼"}</div>
          <div className="snap-col snap-col-alert">
            <div className="snap-col-date">{snap.currDate}</div>
            <div className="snap-col-val">{snap.currVal.toFixed(2)} t</div>
            <div className="snap-col-sub">This month</div>
          </div>
        </div>
        <div className="snap-verdict">
          {up ? "+" : ""}{absPct}% month-over-month &nbsp;·&nbsp; threshold ±{snap.thresholdPct}%
        </div>
      </div>
    );
  }

  if (snap.kind === "deviation") {
    const up = snap.devPct > 0;
    return (
      <div className="snap">
        <div className="snap-meta">Forecast vs 12-month historic baseline</div>
        <div className="snap-compare">
          <div className="snap-col">
            <div className="snap-col-date">12M historic avg</div>
            <div className="snap-col-val">{snap.reference.toFixed(2)} t</div>
            <div className="snap-col-sub">Baseline</div>
          </div>
          <div className="snap-arrow">vs</div>
          <div className="snap-col snap-col-alert">
            <div className="snap-col-date">Current forecast</div>
            <div className="snap-col-val">{snap.plan.toFixed(2)} t</div>
            <div className="snap-col-sub">Plan</div>
          </div>
        </div>
        <div className="snap-verdict">
          {up ? "+" : ""}{Math.abs(snap.devPct).toFixed(0)}% {up ? "above" : "below"} baseline &nbsp;·&nbsp; threshold ±{snap.thresholdPct}%
        </div>
      </div>
    );
  }

  if (snap.kind === "low_inventory") {
    const coverageDays = snap.demand > 0 ? ((snap.inv / snap.demand) * 30).toFixed(0) : "—";
    return (
      <div className="snap">
        <div className="snap-meta">Inventory vs planned demand</div>
        <div className="snap-compare">
          <div className="snap-col snap-col-alert">
            <div className="snap-col-date">Current inventory</div>
            <div className="snap-col-val">{snap.inv.toFixed(2)} t</div>
            <div className="snap-col-sub">≈ {coverageDays} days cover</div>
          </div>
          <div className="snap-arrow">vs</div>
          <div className="snap-col">
            <div className="snap-col-date">Planned demand</div>
            <div className="snap-col-val">{snap.demand.toFixed(2)} t</div>
            <div className="snap-col-sub">This month</div>
          </div>
        </div>
        <div className="snap-verdict">Inventory below {snap.thresholdTons} t minimum threshold</div>
      </div>
    );
  }

  if (snap.kind === "new_demand") {
    return (
      <div className="snap">
        <div className="snap-meta">New demand — no sales history found</div>
        <div className="snap-compare">
          <div className="snap-col snap-col-alert">
            <div className="snap-col-date">Planned forecast</div>
            <div className="snap-col-val">{snap.plan.toFixed(2)} t</div>
            <div className="snap-col-sub">Current plan</div>
          </div>
          <div className="snap-arrow">vs</div>
          <div className="snap-col">
            <div className="snap-col-date">Historic sales</div>
            <div className="snap-col-val">0 t</div>
            <div className="snap-col-sub">12M + 24M combined</div>
          </div>
        </div>
        <div className="snap-verdict">No prior sales history for this material / plant / office</div>
      </div>
    );
  }

  if (snap.kind === "formula") {
    const vals = Object.entries(snap.values || {}).filter(([, v]) => v != null && v !== 0);
    return (
      <div className="snap">
        <div className="snap-meta">Formula rule matched — row values at trigger</div>
        <div className="snap-formula-code">{snap.formula}</div>
        {vals.length > 0 && (
          <div className="snap-vals">
            {vals.map(([col, val]) => (
              <div key={col} className="snap-val-row">
                <span className="snap-val-label">{SNAP_METRIC_LABELS[col] || col}</span>
                <span className="snap-val-num">{Number(val).toFixed(2)} t</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return <p className="snap-fallback">{s.reasoning}</p>;
}


function Row({ s, expanded, highlighted, onToggle, signalStatus, onSetStatus, onClearStatus, onSignalUpdate }) {
  const [showOrders, setShowOrders] = useState(false);
  const [orders, setOrders] = useState(null);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [localEdits, setLocalEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'success' | error string

  useEffect(() => {
    if (!expanded) {
      setShowOrders(false);
      setOrders(null);
      setLocalEdits({});
      setSaveStatus(null);
    }
  }, [expanded]);

  function toggleOrders() {
    if (!showOrders && !orders && !ordersLoading) {
      setOrdersLoading(true);
      getOrders({ material: s.material, plant: s.plant, salesOffice: s.salesOffice })
        .then(setOrders)
        .finally(() => setOrdersLoading(false));
    }
    setShowOrders((v) => !v);
  }

  async function handleSave(changed) {
    if (!s._id) return;
    setSaving(true);
    setSaveStatus(null);
    try {
      const result = await updateSignal(s._id, changed);
      setLocalEdits({});
      setSaveStatus("success");
      setTimeout(() => setSaveStatus(null), 3000);
      if (onSignalUpdate) onSignalUpdate(s._id, result.signal);
    } catch (e) {
      setSaveStatus(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function handleApplyRec(changes) {
    setLocalEdits((prev) => {
      const n = { ...prev };
      for (const [key, value] of Object.entries(changes || {})) {
        if (EDITABLE_FIELDS.some((f) => f.key === key && f.editable)) {
          n[key] = String(value);
        }
      }
      return n;
    });
  }

  const pillClass = typePill[s.type] || "pill-blue";
  const scoreBarClass = barClass(s.score);
  const scoreBadge = s.score >= 8 ? "score-badge-high" : s.score >= 5 ? "score-badge-med" : "score-badge-low";

  return (
    <>
      <tr
        id={`signal-row-${s.id}`}
        className={`signal-row prio-${(s.priority || "low").toLowerCase()}${highlighted ? " signal-row-highlight" : ""}`}
        onClick={onToggle}
      >
        <td>
          <span className={`pill ${pillClass}`}>{s.type}</span>
          {signalStatus && <span className={`status-badge status-${signalStatus}`}>{signalStatus}</span>}
        </td>
        <td style={{ fontWeight: 500 }}>{s.material}</td>
        <td>{s.plant}</td>
        <td>{s.month}</td>
        <td><span className={`pill ${urgencyPill[s.priority] || "pill-teal"}`}>{s.priority}</span></td>
        <td>
          <div className="score-bar">
            <span className="bar-bg">
              <span className={`bar-fill ${scoreBarClass}`} style={{ width: `${s.score * 10}%` }} />
            </span>
            <span className={`score-badge ${scoreBadge}`}>{s.score}</span>
          </div>
        </td>
        <td style={{ color: "var(--text-2)" }}>{s.detail}</td>
        <td><button className="btn" onClick={(e) => { e.stopPropagation(); onToggle(); }}>{expanded ? "Hide" : "Detail"}</button></td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} style={{ padding: 0 }}>
            <div className="sig-detail">
              <div className="sig-detail-why">
                <div className="sig-detail-section-title">Why this fired</div>
                <SnapshotView snap={s.snapshot} s={s} />
              </div>
              <div className="sig-detail-actions">
                <div className="sig-detail-section-title">AI Recommendations</div>
                <AiRecommendationsPanel rowId={s._id} onApply={handleApplyRec} />
              </div>
            </div>
            {s._id && (
              <PlanningInputs
                signal={s}
                localEdits={localEdits}
                setLocalEdits={setLocalEdits}
                onSave={handleSave}
                saving={saving}
                saveStatus={saveStatus}
              />
            )}
            <div className="sig-status-bar">
              <span className="sig-status-label">Mark as:</span>
              {[
                { key: "actioned",  label: "✓ Actioned"  },
                { key: "snoozed",   label: "⏸ Snoozed"  },
                { key: "escalated", label: "↑ Escalated" },
              ].map(({ key, label }) => (
                <button
                  key={key}
                  className={`sig-status-btn sig-status-btn-${key}${signalStatus === key ? " active" : ""}`}
                  onClick={(e) => { e.stopPropagation(); signalStatus === key ? onClearStatus() : onSetStatus(key); }}
                >
                  {label}
                </button>
              ))}
              {signalStatus && (
                <button className="sig-status-btn sig-status-clear" onClick={(e) => { e.stopPropagation(); onClearStatus(); }}>
                  ✕ Clear
                </button>
              )}
            </div>

            <div className="sig-orders-toggle-row">
              <button className="sig-orders-toggle-btn" onClick={toggleOrders}>
                {showOrders ? "▲ Hide underlying orders" : "▼ View underlying orders"}
              </button>
            </div>
            {showOrders && <OrdersDrilldown orders={orders} loading={ordersLoading} />}
          </td>
        </tr>
      )}
    </>
  );
}

function OrdersDrilldown({ orders, loading }) {
  if (loading) return <div className="orders-drill">Loading orders…</div>;
  if (!orders) return null;
  if (!orders.available) return <div className="orders-drill orders-drill-empty">Underlying orders require MongoDB connection.</div>;
  const { summary, byCountry, orders: rows } = orders;
  if (!summary.orders) return <div className="orders-drill orders-drill-empty">No historic orders found for this material / plant / office.</div>;
  return (
    <div className="orders-drill">
      <div className="orders-drill-summary">
        <span><b>{summary.orders}</b> orders</span>
        <span><b>{summary.totalTons.toFixed(3)}</b> t total</span>
        <span><b>{summary.customers}</b> customers</span>
        {byCountry.length > 0 && (
          <span>Top regions: {byCountry.map((c) => `${c.country} (${c.tons.toFixed(2)}t)`).join(", ")}</span>
        )}
      </div>
      <table className="orders-drill-table">
        <thead>
          <tr><th>Date</th><th>Customer</th><th>Country</th><th>Postal</th><th>Tons</th><th>Type</th></tr>
        </thead>
        <tbody>
          {rows.map((o, i) => (
            <tr key={i}>
              <td>{String(o.date).slice(0, 10)}</td>
              <td>{o.customer}</td>
              <td>{o.recipient_country}</td>
              <td>{o.recipient_postal_code}</td>
              <td>{Number(o.quantity_in_tons).toFixed(4)}</td>
              <td>{o.is_contract ? "Contract" : o.is_scheduling_agreement ? "Sched. agr." : "Free stock"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {summary.orders > rows.length && (
        <div className="orders-drill-more">Showing latest {rows.length} of {summary.orders} orders</div>
      )}
    </div>
  );
}