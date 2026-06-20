import { useEffect, useState, useRef } from "react";
import { getDashboard, getRules, deleteRule, getAiBriefing, suggestActions } from "./api.js";
import RuleBuilder from "./RuleBuilder.jsx";
import Chat from "./Chat.jsx";
import { ChevronLeft, ChevronRight } from "lucide-react";

const typePill = {
  "Stockout risk": "pill-red",
  "Demand drop": "pill-amber",
  "Demand surge": "pill-blue",
  "Forecast deviation": "pill-teal",
  "New demand": "pill-teal",
};
const urgencyPill = { High: "pill-red", Medium: "pill-amber", Low: "pill-teal" };
const barClass = (s) => (s >= 85 ? "bar-high" : s >= 60 ? "bar-med" : "bar-low");

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
  "0–30": "fill-teal",
  "31–50": "fill-blue",
  "51–70": "fill-amber",
  "71–90": "fill-orange",
  "90+": "fill-red",
};

function BarChart({ data, colorClassMap, fallbackClasses }) {
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
            <span className="cbar-label">{label}</span>
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

export default function App() {
  const [dash, setDash] = useState(null);
  const [rules, setRules] = useState([]);
  const [typeFilter, setTypeFilter] = useState("all");
  const [urgencyFilter, setUrgencyFilter] = useState("all");
  const [builder, setBuilder] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [aiBriefing, setAiBriefing] = useState(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const itemsPerPage = 100;

  // Ref so refresh() always reads the latest typeFilter without stale closure
  const typeFilterRef = useRef("all");

  async function regenerateBriefing() {
    setBriefingLoading(true);
    try {
      const r = await getAiBriefing();
      setAiBriefing(r.briefing);
    } finally {
      setBriefingLoading(false);
    }
  }

  async function refresh(page = 0, type = typeFilterRef.current) {
    const [d, r] = await Promise.all([
      getDashboard({ page, pageSize: itemsPerPage, type }),
      getRules(),
    ]);
    setDash(d);
    setRules(r);
    setCurrentPage(page);
  }

  useEffect(() => { refresh(0, "all"); }, []);

  if (!dash) return <div className="db">Loading dashboard…</div>;

  // dash.signals is already type-filtered by the server.
  // Only apply urgency filter client-side.
  const filteredSignals = dash.signals.filter(
    (s) => urgencyFilter === "all" || s.priority === urgencyFilter
  );

  const k = dash.kpis;

  const handleTypeChange = (newType) => {
    typeFilterRef.current = newType;
    setTypeFilter(newType);
    setUrgencyFilter("all");
    setExpanded(null);
    refresh(0, newType);
  };

  const handleNext = () => {
    if (!dash || dash.page >= dash.totalPages - 1) return;
    refresh(dash.page + 1, typeFilterRef.current);
  };

  const handlePrev = () => {
    if (!dash || dash.page <= 0) return;
    refresh(dash.page - 1, typeFilterRef.current);
  };

  const page = dash.page ?? currentPage;
  const totalPages = dash.totalPages ?? 1;
  const pageSize = dash.pageSize ?? itemsPerPage;
  const rangeStart = dash.signals.length ? page * pageSize : 0;
  const displayStart = dash.signals.length ? rangeStart + 1 : 0;
  const displayEnd = dash.signals.length ? rangeStart + dash.signals.length : 0;

  // Build dropdown options: byType (all signals) + any custom rule names not yet producing signals
  const dropdownTypes = [
    ...Object.keys(dash.byType),
    ...rules.map((r) => r.name).filter((n) => n && !dash.byType[n]),
  ];

  return (
    <div className="db">
      {/* top bar */}
      <div className="topbar">
        <div className="topbar-brand">
          <div className="topbar-tk-logo">
            <span className="tk-logo-box">tk</span>
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

      {/* Briefing */}
      <div className="briefing-box">
        <div className="briefing-box-header">
          <span className="briefing-box-title">✨ Planning Briefing</span>
          <button className="link-btn" onClick={regenerateBriefing} disabled={briefingLoading}>
            {briefingLoading ? "Generating…" : "Regenerate with AI"}
          </button>
        </div>
        <div className="briefing-box-text">
          {aiBriefing || dash.briefing}
        </div>
      </div>

      {/* KPI cards */}
      <div className="metrics">
        <div className="metric">
          <div className="metric-label">Total signals</div>
          <div className="metric-val">{k.total}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Critical (score ≥ 85)</div>
          <div className="metric-val red">{k.critical}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Medium (60–84)</div>
          <div className="metric-val amber">{k.medium}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Custom rules active</div>
          <div className="metric-val green">{k.rulesActive}</div>
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
          <div className="card-title">Score distribution</div>
          <BarChart
            data={dash.byBucket}
            colorClassMap={BUCKET_COLOR_CLASS}
          />
        </div>
      </div>

      {/* custom rules list */}
      {rules.length > 0 && (
        <div className="card spacer">
          <div className="card-title">Custom rules</div>
          <div className="rules-list">
            {rules.map((r) => (
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
                    await deleteRule(r._id);
                    const nextType = typeFilterRef.current === r.name ? "all" : typeFilterRef.current;
                    typeFilterRef.current = nextType;
                    setTypeFilter(nextType);
                    refresh(0, nextType);
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
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <div className="card-title" style={{ margin: 0 }}>
              Signal table — prioritised ({displayStart}–{displayEnd}) of {k.total}
            </div>
            <div className="card-title">
              Page {page + 1} of {totalPages}
            </div>
          </div>

          <div className="filters">
            <div>
              <button
                onClick={handlePrev}
                disabled={!dash || page === 0}
                style={{
                  padding: "5px 8px", fontSize: "10px",
                  cursor: page === 0 ? "not-allowed" : "pointer",
                  opacity: page === 0 ? 0.5 : 1,
                  border: "1px solid grey", backgroundColor: "#fff",
                  color: "grey", borderRadius: "4px",
                }}>
                <ChevronLeft size={18} />
              </button>
              <button
                onClick={handleNext}
                disabled={!dash || page >= totalPages - 1}
                style={{
                  padding: "5px 8px", fontSize: "10px",
                  cursor: page >= totalPages - 1 ? "not-allowed" : "pointer",
                  opacity: page >= totalPages - 1 ? 0.5 : 1,
                  border: "1px solid grey", backgroundColor: "#fff",
                  color: "grey", borderRadius: "4px", marginLeft: "8px",
                }}>
                <ChevronRight size={18} />
              </button>
            </div>

            <select value={typeFilter} onChange={(e) => handleTypeChange(e.target.value)}>
              <option value="all">All types</option>
              {dropdownTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>

            <select value={urgencyFilter} onChange={(e) => { setUrgencyFilter(e.target.value); setExpanded(null); }}>
              <option value="all">All urgency</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Low">Low</option>
            </select>
          </div>
        </div>

        {filteredSignals.length === 0 ? (
          <div className="empty-state">No signals match the current filters.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Signal</th><th>Material</th><th>Plant</th>
                  <th>Month</th><th>Urgency</th><th>Score</th>
                  <th>Detail</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredSignals.map((s) => (
                  <Row
                    key={s.id}
                    s={s}
                    expanded={expanded === s.id}
                    onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
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
              typeFilterRef.current = savedName;
              setTypeFilter(savedName);
              setUrgencyFilter("all");
              refresh(0, savedName);
            } else {
              refresh(0, typeFilterRef.current);
            }
          }}
        />
      )}

      <Chat />
    </div>
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

function SnapshotView({ snap, s }) {
  if (!snap) return <p className="snap-fallback">{s.reasoning}</p>;

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

function Row({ s, expanded, onToggle }) {
  const [aiActions, setAiActions] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    if (expanded && aiActions === null && !aiLoading) {
      setAiLoading(true);
      suggestActions(s)
        .then((r) => setAiActions(r?.actions || ""))
        .finally(() => setAiLoading(false));
    }
  }, [expanded]);

  const pillClass = typePill[s.type] || "pill-blue";
  const scoreBarClass = barClass(s.score);
  const scoreBadge = s.score >= 85 ? "score-badge-high" : s.score >= 60 ? "score-badge-med" : "score-badge-low";

  return (
    <>
      <tr>
        <td><span className={`pill ${pillClass}`}>{s.type}</span></td>
        <td style={{ fontWeight: 500 }}>{s.material}</td>
        <td>{s.plant}</td>
        <td>{s.month}</td>
        <td><span className={`pill ${urgencyPill[s.priority] || "pill-teal"}`}>{s.priority}</span></td>
        <td>
          <div className="score-bar">
            <span className="bar-bg">
              <span className={`bar-fill ${scoreBarClass}`} style={{ width: `${s.score}%` }} />
            </span>
            <span className={`score-badge ${scoreBadge}`}>{s.score}</span>
          </div>
        </td>
        <td style={{ color: "var(--text-2)" }}>{s.detail}</td>
        <td><button className="btn" onClick={onToggle}>{expanded ? "Hide" : "Detail"}</button></td>
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
                <div className="sig-detail-section-title">Recommended actions</div>
                <div className="sig-actions-text">
                  {aiLoading ? "Generating with AI…" : (aiActions || s.actions)}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}