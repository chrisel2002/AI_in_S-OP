import { useEffect, useState } from "react";
import { getDashboard, getRules, deleteRule, getOrders } from "./api.js";
import RuleBuilder from "./RuleBuilder.jsx";

const typePill = {
  "Stockout risk": "pill-red",
  "Demand drop": "pill-amber",
  "Demand surge": "pill-blue",
  "Forecast deviation": "pill-teal",
  "New demand": "pill-teal",
};
const urgencyPill = { High: "pill-red", Medium: "pill-amber", Low: "pill-teal" };
const barClass = (s) => (s >= 80 ? "bar-high" : s >= 50 ? "bar-med" : "bar-low");

function BarChart({ data }) {
  const max = Math.max(1, ...Object.values(data));
  return (
    <div>
      {Object.entries(data).map(([label, val]) => (
        <div className="cbar" key={label}>
          <span className="cbar-label">{label}</span>
          <span className="cbar-track"><span className="cbar-fill" style={{ width: `${(val / max) * 100}%` }} /></span>
          <span className="cbar-val">{val}</span>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [dash, setDash] = useState(null);
  const [rules, setRules] = useState([]);
  const [typeFilter, setTypeFilter] = useState("all");
  const [urgencyFilter, setUrgencyFilter] = useState("all");
  const [builder, setBuilder] = useState(null); // null | {} | existingRule
  const [expanded, setExpanded] = useState(null);

  async function refresh() {
    const [d, r] = await Promise.all([getDashboard(), getRules()]);
    setDash(d);
    setRules(r);
  }
  useEffect(() => { refresh(); }, []);

  if (!dash) return <div className="db">Loading dashboard…</div>;

  const signals = dash.signals.filter(
    (s) => (typeFilter === "all" || s.type === typeFilter) && (urgencyFilter === "all" || s.priority === urgencyFilter)
  );
  const k = dash.kpis;

  return (
    <div className="db">
      {/* top bar */}
      <div className="topbar">
        <div>
          <div className="topbar-title">📊 S&OP Signal Dashboard</div>
          <div className="topbar-meta">
            Planning cycle 2026-06 · {k.rulesActive} active custom rules ·
            storage: {dash.storage === "mongo" ? "MongoDB ✅" : "local file ⚠️"}
          </div>
        </div>
        <div className="row-gap">
          <button className="btn btn-primary" onClick={() => setBuilder({})}>+ Add rule</button>
        </div>
      </div>

      {/* AI briefing */}
      <div className="briefing">
        <div className="briefing-header">✨ AI briefing</div>
        <div className="briefing-text">{dash.briefing}</div>
      </div>

      {/* KPI cards */}
      <div className="metrics">
        <div className="metric"><div className="metric-label">Total signals</div><div className="metric-val">{k.total}</div></div>
        <div className="metric"><div className="metric-label">Critical (score &gt; 80)</div><div className="metric-val red">{k.critical}</div></div>
        <div className="metric"><div className="metric-label">Medium (50–80)</div><div className="metric-val amber">{k.medium}</div></div>
        <div className="metric"><div className="metric-label">Custom rules active</div><div className="metric-val green">{k.rulesActive}</div></div>
      </div>

      {/* charts */}
      <div className="chart-row">
        <div className="card"><div className="card-title">Signals by type</div><BarChart data={dash.byType} /></div>
        <div className="card"><div className="card-title">Score distribution</div><BarChart data={dash.byBucket} /></div>
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
                  <small>{r.metric} {r.operator} {r.threshold}{r.comparison_type === "percent_change" ? " %" : " t"}</small>
                </div>
                <div className="row-gap">
                  <button className="link-btn" onClick={() => setBuilder(r)}>Edit</button>
                  <button className="link-btn" onClick={async () => { await deleteRule(r._id); refresh(); }}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* signal table */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div className="card-title" style={{ margin: 0 }}>Signal table — prioritised (top {dash.signals.length})</div>
          <div className="filters">
            <select onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="all">All types</option>
              {Object.keys(dash.byType).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select onChange={(e) => setUrgencyFilter(e.target.value)}>
              <option value="all">All urgency</option>
              <option value="High">High</option><option value="Medium">Medium</option><option value="Low">Low</option>
            </select>
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr><th>Signal</th><th>Material</th><th>Plant</th><th>Month</th><th>Urgency</th><th>Score</th><th>Detail</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <Row key={s.id} s={s} expanded={expanded === s.id} onToggle={() => setExpanded(expanded === s.id ? null : s.id)} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {builder !== null && (
        <RuleBuilder
          existing={builder._id ? builder : null}
          onClose={() => setBuilder(null)}
          onSaved={() => { setBuilder(null); refresh(); }}
        />
      )}
    </div>
  );
}

function Row({ s, expanded, onToggle }) {
  const [orders, setOrders] = useState(null);

  useEffect(() => {
    if (expanded && !orders) {
      getOrders({ material: s.material, plant: s.plant, salesOffice: s.salesOffice }).then(setOrders);
    }
  }, [expanded]);

  return (
    <>
      <tr>
        <td><span className={`pill ${typePill[s.type] || "pill-teal"}`}>{s.type}</span></td>
        <td style={{ fontWeight: 500 }}>{s.material}</td>
        <td>{s.plant}</td>
        <td>{s.month}</td>
        <td><span className={`pill ${urgencyPill[s.priority]}`}>{s.priority}</span></td>
        <td>
          <div className="score-bar">
            <span className="bar-bg"><span className={`bar-fill ${barClass(s.score)}`} style={{ width: `${s.score}%` }} /></span>
            <span style={{ minWidth: 26, fontWeight: 600 }}>{s.score}</span>
          </div>
        </td>
        <td style={{ color: "var(--text-2)" }}>{s.detail}</td>
        <td><button className="btn" onClick={onToggle}>{expanded ? "Hide" : "Detail"}</button></td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} style={{ padding: 0 }}>
            <div className="action-panel">
              <b>Reasoning:</b> {s.reasoning}{"\n\n"}<b>AI-suggested actions:</b>{"\n"}{s.actions}
            </div>
            <Drilldown orders={orders} />
          </td>
        </tr>
      )}
    </>
  );
}

// Real orders behind the signal, from the underlying_sales collection.
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
        <thead><tr><th>Date</th><th>Customer</th><th>Country</th><th>Postal</th><th>Tons</th><th>Type</th></tr></thead>
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
      {summary.orders > rows.length && <div className="drill-more">Showing latest {rows.length} of {summary.orders} orders.</div>}
    </div>
  );
}
