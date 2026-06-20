import { useEffect, useState, useRef } from "react";
import { getDashboard, getRules, deleteRule, getOrders, getAiBriefing, suggestActions } from "./api.js";
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
        <div>
          <div className="topbar-title">📊 S&amp;OP Signal Dashboard</div>
          <div className="topbar-meta">
            Planning cycle 2026-06 · {k.rulesActive} active custom rules ·
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

function Row({ s, expanded, onToggle }) {
  const [orders, setOrders] = useState(null);
  const [aiActions, setAiActions] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    if (expanded && !orders) {
      getOrders({ material: s.material, plant: s.plant, salesOffice: s.salesOffice }).then(setOrders);
    }
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
            <div className="action-panel">
              <b>Reasoning:</b> {s.reasoning}{"\n\n"}
              <b>AI-suggested actions:</b>{"\n"}
              {aiLoading ? "Generating with AI…" : (aiActions || s.actions)}
            </div>
            <Drilldown orders={orders} />
          </td>
        </tr>
      )}
    </>
  );
}

function Drilldown({ orders }) {
  if (!orders) return <div className="drill">Loading underlying orders…</div>;
  if (!orders.available) return <div className="drill">Underlying orders need MongoDB (storage is local file).</div>;
  const { summary, byCountry, orders: rows } = orders;
  if (!summary.orders) return <div className="drill">No underlying orders found for this material / plant / office.</div>;
  return (
    <div className="drill">
      <div className="drill-title">Underlying sales orders (historic actuals)</div>
      <div className="drill-summary">
        <span><b>{summary.orders}</b> orders</span>
        <span><b>{summary.totalTons.toFixed(3)}</b> t total</span>
        <span><b>{summary.customers}</b> customers</span>
        <span>Top regions: {byCountry.map((c) => `${c.country} (${c.tons.toFixed(2)}t)`).join(", ")}</span>
      </div>
      <table className="drill-table">
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
        <div className="drill-more">Showing latest {rows.length} of {summary.orders} orders.</div>
      )}
    </div>
  );
}