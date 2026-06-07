import { useState } from "react";
import { parseSentence, createRule, updateRule } from "./api.js";

// friendly label -> column (kept in sync with the backend's known columns)
const METRICS = {
  "Forecast sales (free stock)": "sales_free_stock_in_tons",
  "Forecast sales (contracts)": "sales_contracts_in_tons",
  "Forecast sales (scheduling agreement)": "sales_scheduling_agreement_in_tons",
  "Inventory 12mo (free stock)": "historic_inventory_12_free_stock_in_tons",
  "Historic sales 12mo (free stock)": "historic_sales_12_free_stock_in_tons",
  "Historic sales 24mo (free stock)": "historic_sales_24_free_stock_in_tons",
};
const OPERATORS = {
  "is greater than": ">",
  "is greater or equal": ">=",
  "is less than": "<",
  "is less or equal": "<=",
  "equals": "==",
};
const COMPARISONS = { "absolute value (tons)": "absolute", "% change vs baseline": "percent_change" };
const SEVERITIES = ["info", "warning", "critical"];

const labelFor = (obj, val, fallback) =>
  Object.keys(obj).find((k) => obj[k] === val) || fallback;

export default function RuleBuilder({ existing, onClose, onSaved }) {
  const [sentence, setSentence] = useState(existing?.raw_sentence || "");
  const [draft, setDraft] = useState(existing || null);
  const [loading, setLoading] = useState(false);

  async function generate() {
    if (!sentence.trim()) return;
    setLoading(true);
    const rule = await parseSentence(sentence);
    setDraft(rule);
    setLoading(false);
  }

  function set(field, value) {
    setDraft((d) => ({ ...d, [field]: value }));
  }

  async function save() {
    if (existing?._id) await updateRule(existing._id, draft);
    else await createRule(draft);
    onSaved();
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{existing ? "Edit rule" : "Add rule"}</h2>
        <div className="sub">Describe the rule in plain English — we turn it into an editable rule.</div>

        {/* Step 1-3: sentence -> draft */}
        <div className="field">
          <label>Plain-English rule</label>
          <input
            value={sentence}
            placeholder="e.g. Flag when forecast sales are above 20 tons per material"
            onChange={(e) => setSentence(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && generate()}
          />
          <div className="hint">Press Enter or click Generate. You can edit every field below.</div>
        </div>
        <button className="btn btn-primary" onClick={generate} disabled={loading}>
          {loading ? "Generating…" : "✨ Generate rule"}
        </button>

        {/* Step 4-5: editable card */}
        {draft && (
          <>
            <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid var(--border)" }} />
            <div className="field">
              <label>Rule name</label>
              <input value={draft.name} onChange={(e) => set("name", e.target.value)} />
            </div>
            <div className="grid-2">
              <div className="field">
                <label>Metric</label>
                <select
                  value={labelFor(METRICS, draft.metric, Object.keys(METRICS)[0])}
                  onChange={(e) => set("metric", METRICS[e.target.value])}
                >
                  {Object.keys(METRICS).map((k) => <option key={k}>{k}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Compare as</label>
                <select
                  value={labelFor(COMPARISONS, draft.comparison_type, Object.keys(COMPARISONS)[0])}
                  onChange={(e) => set("comparison_type", COMPARISONS[e.target.value])}
                >
                  {Object.keys(COMPARISONS).map((k) => <option key={k}>{k}</option>)}
                </select>
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label>Condition</label>
                <select
                  value={labelFor(OPERATORS, draft.operator, "is greater than")}
                  onChange={(e) => set("operator", OPERATORS[e.target.value])}
                >
                  {Object.keys(OPERATORS).map((k) => <option key={k}>{k}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Threshold</label>
                <input
                  type="number"
                  value={draft.threshold}
                  onChange={(e) => set("threshold", parseFloat(e.target.value) || 0)}
                />
              </div>
            </div>
            {draft.comparison_type === "percent_change" && (
              <div className="field">
                <label>Baseline column</label>
                <select value={draft.baseline || ""} onChange={(e) => set("baseline", e.target.value)}>
                  {Object.values(METRICS).map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
            )}
            <div className="field">
              <label>Severity</label>
              <select value={draft.severity} onChange={(e) => set("severity", e.target.value)}>
                {SEVERITIES.map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>

            <div className="modal-actions">
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={save}>💾 Save rule</button>
            </div>
          </>
        )}

        {!draft && (
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}
