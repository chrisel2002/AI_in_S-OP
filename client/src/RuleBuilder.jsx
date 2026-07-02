import { useState, useRef, useEffect } from "react";
import { parseSentence, validatePrompt, createRule, updateRule } from "./api.js";

// ── Column registry ───────────────────────────────────────────────────────
// Add new columns here — grouped by business category.
// COLUMN_LABELS is derived automatically for all other usages (humanize, validation, etc.)
const COLUMN_GROUPS = [
  {
    label: "Forecast Sales",
    columns: {
      sales_free_stock_in_tons:               "Free-stock sales",
      sales_contracts_in_tons:               "Contract sales",
      sales_scheduling_agreement_in_tons:    "Scheduling-agreement sales",
    },
  },
  {
    label: "Inventory",
    columns: {
      historic_inventory_12_free_stock_in_tons: "12-month average (free stock)",
      historic_inventory_24_free_stock_in_tons: "24-month average (free stock)",
    },
  },
  {
    label: "Historic Sales — 12 months",
    columns: {
      historic_sales_12_free_stock_in_tons:             "Free stock",
      historic_sales_12_contracts_in_tons:              "Contracts",
      historic_sales_12_scheduling_agreement_in_tons:   "Scheduling agreement",
    },
  },
  {
    label: "Historic Sales — 24 months",
    columns: {
      historic_sales_24_free_stock_in_tons:             "Free stock",
      historic_sales_24_contracts_in_tons:              "Contracts",
      historic_sales_24_scheduling_agreement_in_tons:   "Scheduling agreement",
    },
  },
];

// Flat label map derived from groups — used by humanizeFormula, validation, etc.
// Label = "Group · Column" so full context is always visible in readable output.
const COLUMN_LABELS = Object.fromEntries(
  COLUMN_GROUPS.flatMap(({ label: group, columns }) =>
    Object.entries(columns).map(([col, name]) => [col, `${group} · ${name}`])
  )
);

function humanizeFormula(formula) {
  let h = formula;
  // Replace column keys with human labels (longest first to avoid partial matches)
  Object.entries(COLUMN_LABELS)
    .sort((a, b) => b[0].length - a[0].length)
    .forEach(([col, label]) => { h = h.replaceAll(`row.${col}`, label); });
  // "0.8 * X" → "80% of X"
  h = h.replace(/(\d+\.\d+)\s*\*/g, (_, n) => `${Math.round(parseFloat(n) * 100)}% of`);
  // "X * 0.8" → "X × 80%"
  h = h.replace(/\*\s*(\d+\.\d+)/g, (_, n) => `× ${Math.round(parseFloat(n) * 100)}%`);
  // "2 * X" → "2× X"
  h = h.replace(/\b(\d+)\s*\*/g, (_, n) => `${n}×`);
  // Comparison operators → readable text on their own line
  h = h.replace(/\s*>=\s*/g, '\n  is greater than or equal to\n');
  h = h.replace(/\s*<=\s*/g, '\n  is less than or equal to\n');
  h = h.replace(/\s*>\s*/g,  '\n  is greater than\n');
  h = h.replace(/\s*<\s*/g,  '\n  is less than\n');
  // Logical operators → visual separator
  h = h.replace(/\s*&&\s*/g, '\n\nAND\n\n');
  h = h.replace(/\s*\|\|\s*/g, '\n\nOR\n\n');
  return h.trim();
}

function extractColumns(formula) {
  const matches = [...formula.matchAll(/row\.([a-z0-9_]+)/g)];
  const unique  = [...new Set(matches.map((m) => m[1]))];
  return unique.map((col) => COLUMN_LABELS[col] || col);
}

// Returns specific error string or null if valid
function validateFormulaClient(formula) {
  const f = formula.trim();
  if (!f) return null;

  // 'row.' anywhere not immediately followed by a column name character.
  // Catches trailing row., row. + newline, row. + space, etc.
  // JS allows whitespace after a dot (row.\nproperty = row.property) so the
  // syntax check won't catch this — we must catch it explicitly.
  if (/row\.(?![a-z0-9_])/.test(f))
    return "Incomplete column reference — 'row.' must be followed by a column name, with no spaces or line breaks between them";

  // Bitwise & instead of logical &&
  if (/(?<!&)&(?!&)/.test(f))
    return 'Use && for AND — a single & is a bitwise operator, not logical AND';

  // Bitwise | instead of logical ||
  if (/(?<!\|)\|(?!\|)/.test(f))
    return 'Use || for OR — a single | is a bitwise operator, not logical OR';

  // Single = (assignment) instead of == comparison
  if (/(?<![=!<>])=(?!=)/.test(f))
    return 'Use == for equality comparison — a single = assigns a value instead of comparing';

  // Plain-English logical operators (give a specific hint before the generic syntax error)
  if (/\b(and|AND)\b/.test(f))
    return 'Write && instead of "and" / "AND" — e.g. condition1 && condition2';
  if (/\b(or|OR)\b/.test(f))
    return 'Write || instead of "or" / "OR" — e.g. condition1 || condition2';
  if (/\b(not|NOT)\b/.test(f))
    return 'Write !(...) instead of "not" / "NOT" — e.g. !(row.COLUMN > 10)';

  if (!f.includes("row."))
    return "Must reference at least one data column — click a column above to insert it";

  if (f.includes(";"))
    return "Semicolons are not allowed — write a single boolean expression";

  if (/\b(var|let|const|function|return)\b/.test(f))
    return "Variable declarations are not allowed — use row.COLUMN_NAME directly";

  // Unknown column (allow partial prefix while the user is still typing)
  const allCols = Object.keys(COLUMN_LABELS);
  const unknown = [...f.matchAll(/row\.([a-z0-9_]+)/g)]
    .map((m) => m[1])
    .find((col) => !COLUMN_LABELS[col] && !allCols.some((k) => k.startsWith(col)));
  if (unknown)
    return `Unknown column "row.${unknown}" — pick from the available columns above`;

  // JS syntax check
  try {
    // eslint-disable-next-line no-new-func
    new Function(`"use strict"; const row = {}; return (${f})`);
  } catch (e) {
    return `Syntax error: ${e.message}`;
  }

  // Bare identifiers / free text — strip everything valid and flag what remains.
  // Valid tokens: row.column references, numbers (int/float), operators, parens, whitespace, dots.
  const leftover = f
    .replace(/row\.[a-z0-9_]*/g, '')         // column refs — must include digits (e.g. _12_)
    .replace(/\d+(\.\d+)?/g, '')             // integers and decimals
    .replace(/[\s+\-*/%()><=!&|.]+/g, '')   // operators, parens, whitespace, dots
    .trim();
  if (leftover)
    return `Unexpected text "${leftover.slice(0, 25)}" — only row.COLUMN_NAME, numbers, and operators (>, <, +, -, *, /, &&, ||) are allowed`;

  // Must have at least one comparison to produce a boolean
  if (!/[><=!]/.test(f))
    return "Formula needs a comparison — use >, <, >=, <=, or ==";

  return null;
}

// Returns matching column keys for autocomplete at the current cursor position
function getSuggestions(value, cursorPos) {
  const before = value.slice(0, cursorPos);
  const match  = before.match(/row\.([a-z_]*)$/);
  if (!match) return { list: [], start: -1 };
  const partial = match[1].toLowerCase();
  const start   = cursorPos - match[0].length;
  const all     = Object.keys(COLUMN_LABELS);
  const list    = (partial
    ? all.filter((c) => c.includes(partial) || COLUMN_LABELS[c].toLowerCase().includes(partial))
    : all
  ).slice(0, 8);
  return { list, start };
}

// ── Metric configuration for the structured condition builder ────────────
// "direct" metrics resolve straight to one MongoDB field.
// "periods" metrics resolve through a 12/24-month dropdown.
// To enable a new metric, add an entry here. The backend whitelist in
// signals.js METRIC_COLUMNS is already complete.
const METRIC_DEFS = [
  { id: "sales_free_stock",                  label: "Sales Free Stock",                  direct: "sales_free_stock_in_tons" },
  { id: "sales_contracts",                   label: "Sales Contracts",                   direct: "sales_contracts_in_tons" },
  { id: "sales_scheduling_agreement",        label: "Sales Scheduling Agreement",        direct: "sales_scheduling_agreement_in_tons" },
  {
    id: "historic_sales_free_stock",
    label: "Historic Sales Free Stock",
    periods: { "12": "historic_sales_12_free_stock_in_tons", "24": "historic_sales_24_free_stock_in_tons" },
  },
  {
    id: "historic_sales_contracts",
    label: "Historic Sales Contracts",
    periods: { "12": "historic_sales_12_contracts_in_tons", "24": "historic_sales_24_contracts_in_tons" },
  },
  {
    id: "historic_sales_scheduling_agreement",
    label: "Historic Sales Scheduling Agreement",
    periods: { "12": "historic_sales_12_scheduling_agreement_in_tons", "24": "historic_sales_24_scheduling_agreement_in_tons" },
  },
  {
    id: "historic_inventory_free_stock",
    label: "Historic Inventory Free Stock",
    periods: { "12": "historic_inventory_12_free_stock_in_tons", "24": "historic_inventory_24_free_stock_in_tons" },
  },
];

// Flat list of all resolved fields — used for the baseline dropdown (percent_change).
const BASELINE_OPTIONS = METRIC_DEFS.flatMap((d) =>
  d.direct
    ? [{ field: d.direct, label: d.label }]
    : Object.entries(d.periods).map(([p, f]) => ({ field: f, label: `${d.label} (${p}M)` }))
);

// Legacy label → column key (for rules saved before this refactor)
const LEGACY_LABEL_TO_FIELD = {
  "Forecast sales (free stock)":               "sales_free_stock_in_tons",
  "Forecast sales (contracts)":                "sales_contracts_in_tons",
  "Forecast sales (scheduling agreement)":     "sales_scheduling_agreement_in_tons",
  "Inventory 12mo (free stock)":               "historic_inventory_12_free_stock_in_tons",
  "Historic sales 12mo (free stock)":          "historic_sales_12_free_stock_in_tons",
  "Historic sales 24mo (free stock)":          "historic_sales_24_free_stock_in_tons",
};

// Resolve a stored value (column key or legacy label) to a column key.
function resolveField(val) {
  if (!val) return null;
  return LEGACY_LABEL_TO_FIELD[val] ?? val;
}

// Given a MongoDB column key, return the METRIC_DEFS id + selected period.
function fieldToMetricSelection(field) {
  const resolved = resolveField(field) || field;
  for (const def of METRIC_DEFS) {
    if (def.direct === resolved) return { metricId: def.id, period: null };
    if (def.periods) {
      for (const [p, f] of Object.entries(def.periods)) {
        if (f === resolved) return { metricId: def.id, period: p };
      }
    }
  }
  return { metricId: METRIC_DEFS[0].id, period: null };
}

// Given a metricId + period, return the MongoDB column key.
function resolveMetricColumn(metricId, period) {
  const def = METRIC_DEFS.find((d) => d.id === metricId);
  if (!def) return "sales_free_stock_in_tons";
  if (def.direct) return def.direct;
  const p = period && def.periods[period] ? period : "12";
  return def.periods[p];
}

const OPERATORS = {
  "is greater than": ">",
  "is greater or equal": ">=",
  "is less than": "<",
  "is less or equal": "<=",
  "equals": "==",
};
const SEVERITIES = ["low", "medium", "high"];

// Score (0-10) → severity band. Kept in sync with the backend's severity-based
// scoring in signals.js: >=8 High, >=5 Medium, else Low.
const SEV_RANGE = { low: [0, 5], medium: [5, 8], high: [8, 10] };
const scoreToSeverity = (score) => (score >= 8 ? "high" : score >= 5 ? "medium" : "low");
const severityToScore = (sev) => (sev === "high" ? 9 : sev === "medium" ? 6.5 : 2.5);
const clamp01 = (n) => Math.max(0, Math.min(1, n));

const labelFor = (obj, val, fallback) =>
  Object.keys(obj).find((k) => obj[k] === val) || fallback;

// resolveBaseline is kept for save() — resolves legacy labels and passes through column keys.
const resolveBaseline = resolveField;

const EMPTY_COND = () => ({
  metric: "sales_free_stock_in_tons",
  comparison_type: "absolute",
  operator: ">",
  threshold: 0,
  baseline: null,
});

const EMPTY_GROUP = () => ({ logic: "AND", conditions: [EMPTY_COND()], score: 6 });

const EMPTY_DRAFT = () => ({
  name: "",
  groups: [EMPTY_GROUP()],
  groupLogic: "OR",
  severity: "medium",
  group_by: [],
  raw_sentence: "",
  active: true,
});

// Overall calculated severity/score for the score card — the worst (highest)
// score across all groups, since the rule fires as soon as any group's
// conditions match.
function calcOverallScore(groups) {
  if (!groups?.length) return { score: severityToScore("medium"), severity: "medium" };
  const score = Math.max(...groups.map((g) => g.score ?? 6));
  return { score, severity: scoreToSeverity(score) };
}

function normalizeCond(c) {
  return {
    ...EMPTY_COND(),
    metric: resolveField(c.metric) || "sales_free_stock_in_tons",
    comparison_type: c.comparison_type || "absolute",
    operator: c.operator || ">",
    threshold: c.threshold ?? 0,
    baseline: resolveField(c.baseline),
  };
}

function draftFromExisting(existing) {
  // Formula-based rule — preserve as-is, no groups to rebuild. Ensure a rule-level
  // score exists so the criticality slider has a value (fall back to the severity).
  if (existing.formula) {
    return {
      ...existing, groups: [], groupLogic: "OR",
      score: existing.score ?? severityToScore(existing.severity || "medium"),
    };
  }
  // Groups saved before per-group scoring existed fall back to a score derived
  // from the rule's overall severity (or medium) so the sliders start somewhere sensible.
  const fallbackScore = (g) => g.score ?? severityToScore(g.severity || existing.severity || "medium");
  let groups;
  if (existing.groups?.length > 0) {
    groups = existing.groups.map((g) => ({
      logic: g.logic || "AND",
      conditions: (g.conditions || []).map(normalizeCond),
      score: fallbackScore(g),
    }));
  } else if (existing.conditions?.length > 0) {
    groups = [{ logic: existing.logic || "AND", conditions: existing.conditions.map(normalizeCond), score: fallbackScore(existing) }];
  } else {
    groups = [{ logic: "AND", conditions: [normalizeCond(existing)], score: fallbackScore(existing) }];
  }
  return { ...existing, groups, groupLogic: existing.groupLogic || "OR" };
}

const SEV_STYLE = {
  low:    { bg: "var(--blue-bg)",  border: "var(--blue-border)",  color: "var(--blue)"  },
  medium: { bg: "#fef3c7",         border: "#fcd34d",             color: "#92400e"       },
  high:   { bg: "var(--red-bg)",   border: "#fca5a5",             color: "var(--red)"   },
};

function ConditionRow({ cond, total, onUpdate, onRemove }) {
  const isPercent = cond.comparison_type === "percent_change";
  const { metricId, period } = fieldToMetricSelection(cond.metric);
  const def = METRIC_DEFS.find((d) => d.id === metricId) || METRIC_DEFS[0];
  const hasPeriod = !!def.periods;

  function handleMetricChange(newId) {
    const newDef = METRIC_DEFS.find((d) => d.id === newId) || METRIC_DEFS[0];
    if (newDef.direct) {
      onUpdate({ metric: newDef.direct });
    } else {
      // Preserve current period when the new metric also has it; otherwise default to 12M
      const newPeriod = period && newDef.periods[period] ? period : "12";
      onUpdate({ metric: newDef.periods[newPeriod] });
    }
  }

  function handlePeriodChange(newPeriod) {
    if (def.periods) onUpdate({ metric: def.periods[newPeriod] });
  }

  return (
    <div className="rb-cond">
      <div className="rb-cond-body">
        {/* Metric selector + optional period dropdown */}
        <div className="rb-cond-inline">
          <select
            className="rb-select rb-select-grow"
            value={metricId}
            onChange={(e) => handleMetricChange(e.target.value)}
          >
            {METRIC_DEFS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          {hasPeriod && (
            <select
              className="rb-select rb-select-period"
              value={period || "12"}
              onChange={(e) => handlePeriodChange(e.target.value)}
            >
              <option value="12">12 months</option>
              <option value="24">24 months</option>
            </select>
          )}
        </div>

        {/* Operator / threshold / unit */}
        <div className="rb-cond-inline">
          <select
            className="rb-select rb-select-grow"
            value={labelFor(OPERATORS, cond.operator, "is greater than")}
            onChange={(e) => onUpdate({ operator: OPERATORS[e.target.value] })}
          >
            {Object.keys(OPERATORS).map((k) => <option key={k}>{k}</option>)}
          </select>
          <input
            type="number"
            className="rb-input-num"
            value={cond.threshold ?? ""}
            placeholder="0"
            onChange={(e) => onUpdate({ threshold: e.target.value === "" ? "" : parseFloat(e.target.value) })}
          />
          <select
            className="rb-select rb-select-unit"
            value={cond.comparison_type}
            onChange={(e) => onUpdate({ comparison_type: e.target.value, baseline: null })}
          >
            <option value="absolute">tons</option>
            <option value="percent_change">% change</option>
          </select>
        </div>

        {/* Baseline selector for percent_change — flat list of all resolved fields */}
        {isPercent && (
          <div className="rb-cond-inline">
            <span className="rb-cond-against">compared against</span>
            <select
              className="rb-select rb-select-grow"
              value={cond.baseline || ""}
              onChange={(e) => onUpdate({ baseline: e.target.value || null })}
            >
              <option value="">— select baseline —</option>
              {BASELINE_OPTIONS.map((o) => (
                <option key={o.field} value={o.field}>{o.label}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {total > 1 && (
        <button className="rb-remove" onClick={onRemove} title="Remove condition">×</button>
      )}
    </div>
  );
}

// Small per-group score control — a slider the user drags to choose a 0-10
// score, plus three compact progress bars (one per severity band) that fill
// proportionally to how far the score reaches into that band.
function GroupSeverityBars({ score, onChange }) {
  const severity = scoreToSeverity(score);
  return (
    <div className="rb-group-sev">
      <input
        type="range"
        min={0}
        max={10}
        step={1}
        value={score}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rb-group-sev-slider"
        title={`Score: ${score}/10`}
      />
      <div className="rb-group-sev-bars">
        {SEVERITIES.map((s) => {
          const [lo, hi] = SEV_RANGE[s];
          const fillPct = clamp01((score - lo) / (hi - lo)) * 100;
          const active = severity === s;
          const st = SEV_STYLE[s];
          return (
            <span key={s} className="rb-group-sev-bar" title={`${s.charAt(0).toUpperCase() + s.slice(1)} (${lo}-${hi})`}>
              <span className="rb-group-sev-bar-track">
                <span className="rb-group-sev-bar-fill" style={{ width: `${fillPct}%`, background: st.color }} />
              </span>
            </span>
          );
        })}
      </div>
      <span className="rb-group-sev-value" style={{ color: SEV_STYLE[severity].color }}>{score}/10</span>
    </div>
  );
}

function GroupCard({ group, groupIndex, totalGroups, groupLogic, onUpdateGroup, onRemoveGroup, onUpdateCond, onAddCond, onRemoveCond }) {
  const isAND = group.logic === "AND";
  return (
    <div className="rb-group">
      <div className="rb-group-header">
        <div className="rb-group-header-left">
          <span className="rb-group-label">Match</span>
          <button
            className={`rb-logic-pill ${isAND ? "rb-logic-and" : "rb-logic-or"}`}
            onClick={() => onUpdateGroup({ logic: isAND ? "OR" : "AND" })}
            title="Click to toggle ALL / ANY"
          >
            {isAND ? "ALL" : "ANY"}
          </button>
          <span className="rb-group-label">of these conditions</span>
        </div>
        <div className="rb-group-header-right">
          <GroupSeverityBars score={group.score ?? 6} onChange={(sc) => onUpdateGroup({ score: sc })} />
          {totalGroups > 1 && (
            <button className="rb-remove-group" onClick={onRemoveGroup}>Remove group</button>
          )}
        </div>
      </div>

      <div className="rb-group-body">
        {group.conditions.map((cond, ci) => (
          <ConditionRow
            key={ci}
            cond={cond}
            total={group.conditions.length}
            onUpdate={(patch) => onUpdateCond(ci, patch)}
            onRemove={() => onRemoveCond(ci)}
          />
        ))}
        <button className="rb-add-cond" onClick={onAddCond}>+ Add condition</button>
      </div>
    </div>
  );
}

export default function RuleBuilder({ existing, onClose, onSaved }) {
  const [mode, setMode] = useState(existing ? "manual" : null);
  const [sentence, setSentence] = useState(existing?.raw_sentence || "");
  const [promptHint, setPromptHint] = useState(null);
  const [draft, setDraft] = useState(existing ? draftFromExisting(existing) : null);
  const [loading, setLoading] = useState(false);
  const [conditionMode, setConditionMode] = useState(existing?.formula ? "formula" : "structured");
  const [editingFormula, setEditingFormula] = useState(false);
  const [formulaDraft, setFormulaDraft] = useState("");
  const [formulaError, setFormulaError] = useState(null);
  const [colSearch, setColSearch] = useState("");
  const formulaRef  = useRef(null);
  const errorTimer  = useRef(null);
  const latestDraft = useRef("");

  // Cleanup debounce timer on unmount
  useEffect(() => () => clearTimeout(errorTimer.current), []);

  // Auto-resize the formula textarea whenever its content changes
  useEffect(() => {
    const el = formulaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [formulaDraft]);

  // Debounced validation: clear error immediately when valid, delay new errors
  function updateFormulaError(val) {
    latestDraft.current = val;
    clearTimeout(errorTimer.current);
    const err = validateFormulaClient(val);
    if (!err) {
      setFormulaError(null); // valid — clear right away
    } else {
      errorTimer.current = setTimeout(() => {
        setFormulaError(validateFormulaClient(latestDraft.current));
      }, 400);
    }
  }

  function handleFormulaChange(e) {
    const val = e.target.value;
    setFormulaDraft(val);
    updateFormulaError(val);
  }

  function insertColumn(col) {
    const textarea = formulaRef.current;
    const cursor   = textarea?.selectionStart ?? formulaDraft.length;
    const before   = formulaDraft.slice(0, cursor);
    const after    = formulaDraft.slice(cursor);
    const pad      = before.length && !/[\s(]$/.test(before) ? " " : "";
    const next     = `${before}${pad}row.${col}${after}`;
    setFormulaDraft(next);
    updateFormulaError(next);
    setTimeout(() => {
      const pos = before.length + pad.length + `row.${col}`.length;
      textarea.setSelectionRange(pos, pos);
      textarea.focus();
    }, 0);
  }

  function switchToFormula() {
    setConditionMode("formula");
    setFormulaDraft(draft.formula || "");
    setEditingFormula(true);
    setFormulaError(null);
    setColSearch("");
  }

  function switchToStructured() {
    setConditionMode("structured");
    setEditingFormula(false);
    setDraft((d) => {
      const { formula, detail_label, ...rest } = d;
      return { ...rest, groups: d.groups?.length ? d.groups : [EMPTY_GROUP()] };
    });
  }

  function pickManual() { setMode("manual"); setDraft(EMPTY_DRAFT()); setConditionMode("structured"); }
  function pickAI()     { setMode("ai");     setDraft(null);          }

  async function generate() {
    if (!sentence.trim()) return;
    setLoading(true);
    setPromptHint(null);

    // Ask the AI if the prompt is clear enough before doing the full parse
    const clarity = await validatePrompt(sentence).catch(() => ({ clear: true }));
    if (!clarity.clear) {
      setPromptHint(clarity.suggestion || "Please describe the metric, condition, and threshold more clearly.");
      setLoading(false);
      return;
    }

    const rule = await parseSentence(sentence);
    if (rule.formula) {
      setConditionMode("formula");
      setEditingFormula(false);
      // Formula rules have no groups, so the criticality score lives on the rule
      // itself — seed it from the severity the AI inferred.
      setDraft({
        ...EMPTY_DRAFT(), ...rule, raw_sentence: sentence, groups: [],
        score: severityToScore(rule.severity || "medium"),
      });
    } else {
      setConditionMode("structured");
      setDraft({
        ...EMPTY_DRAFT(), ...rule, raw_sentence: sentence,
        groups: [{ logic: "AND", conditions: [normalizeCond(rule)], score: severityToScore(rule.severity || "medium") }],
      });
    }
    setLoading(false);
  }

  function set(field, value) {
    setDraft((d) => ({ ...d, [field]: value }));
  }

  function updateGroup(gi, patch) {
    setDraft((d) => ({ ...d, groups: d.groups.map((g, i) => i === gi ? { ...g, ...patch } : g) }));
  }

  function addGroup() {
    setDraft((d) => ({ ...d, groups: [...d.groups, EMPTY_GROUP()] }));
  }

  function removeGroup(gi) {
    setDraft((d) => ({ ...d, groups: d.groups.filter((_, i) => i !== gi) }));
  }

  function updateCond(gi, ci, patch) {
    setDraft((d) => ({
      ...d,
      groups: d.groups.map((g, i) =>
        i !== gi ? g : { ...g, conditions: g.conditions.map((c, j) => j === ci ? { ...c, ...patch } : c) }
      ),
    }));
  }

  function addCond(gi) {
    setDraft((d) => ({
      ...d,
      groups: d.groups.map((g, i) => i !== gi ? g : { ...g, conditions: [...g.conditions, EMPTY_COND()] }),
    }));
  }

  function removeCond(gi, ci) {
    setDraft((d) => ({
      ...d,
      groups: d.groups.map((g, i) =>
        i !== gi ? g : { ...g, conditions: g.conditions.filter((_, j) => j !== ci) }
      ),
    }));
  }

  async function save() {
    if (!draft) return;
    let toSave;
    if (draft.formula) {
      // Persist the rule-level criticality score (the backend reads rule.score) and
      // keep severity in sync with it.
      const score = draft.score ?? severityToScore(draft.severity || "medium");
      toSave = { ...draft, score, severity: scoreToSeverity(score), active: true };
    } else {
      const cleanGroups = draft.groups.map((g) => ({
        logic: g.logic,
        score: g.score ?? 6,
        severity: scoreToSeverity(g.score ?? 6),
        conditions: g.conditions.map(({ baseline, threshold, ...c }) => ({
          ...c,
          threshold: parseFloat(threshold) || 0,
          baseline: resolveBaseline(baseline),
        })),
      }));
      const firstCond = cleanGroups[0]?.conditions[0] || {};
      const { score: overallScore, severity: overallSeverity } = calcOverallScore(cleanGroups);
      toSave = {
        ...draft, groups: cleanGroups, groupLogic: draft.groupLogic,
        conditions: cleanGroups[0]?.conditions || [],
        logic: cleanGroups[0]?.logic || "AND",
        metric: firstCond.metric, operator: firstCond.operator,
        threshold: firstCond.threshold ?? 0,
        comparison_type: firstCond.comparison_type,
        baseline: firstCond.baseline,
        score: overallScore,
        severity: overallSeverity,
        active: true,
      };
    }
    if (existing?._id) await updateRule(existing._id, toSave);
    else await createRule(toSave);
    onSaved(toSave.name);
  }

  const canSave = draft?.name?.trim() && (
    conditionMode === "formula"
      ? !!draft.formula
      : draft?.groups?.every((g) => g.conditions.length > 0)
  );

  // Current criticality (score + severity) that drives the score card and the
  // severity pills. Formula rules carry the score on the rule itself; structured
  // rules derive it from the worst group score.
  const crit = !draft ? null
    : conditionMode === "formula"
      ? (() => { const score = draft.score ?? severityToScore(draft.severity || "medium"); return { score, severity: scoreToSeverity(score) }; })()
      : calcOverallScore(draft.groups);

  return (
    <div className="overlay">
      <div className="rb-modal">

        {/* Header */}
        <div className="rb-modal-header">
          <div className="rb-modal-title">{existing ? "Edit rule" : "New rule"}</div>
          <button className="rb-close-x" onClick={onClose}>×</button>
        </div>

        <div className="rb-modal-body">

          {/* ── Mode picker ── */}
          {!existing && mode === null && (
            <div className="rb-section">
              <p className="rb-section-desc">How would you like to create this rule?</p>
              <div className="rb-mode-grid">
                <button className="rb-mode-card" onClick={pickAI}>
                  <span className="rb-mode-icon">✨</span>
                  <span className="rb-mode-name">AI-assisted</span>
                  <span className="rb-mode-hint">Describe it in plain English — AI sets everything up.</span>
                </button>
                <button className="rb-mode-card" onClick={pickManual}>
                  <span className="rb-mode-icon">🛠</span>
                  <span className="rb-mode-name">Manual</span>
                  <span className="rb-mode-hint">Choose metrics, operators and thresholds yourself.</span>
                </button>
              </div>
              <div className="rb-footer">
                <button className="btn" onClick={onClose}>Cancel</button>
              </div>
            </div>
          )}

          {/* ── AI input ── */}
          {mode === "ai" && !draft && (
            <div className="rb-section">
              <p className="rb-section-desc">Describe what the rule should flag — the AI will fill in the details. You can adjust everything afterwards.</p>
              <textarea
                className="rb-textarea"
                rows={4}
                value={sentence}
                placeholder={'e.g. "Flag as high severity when forecast sales are more than 20% above historic 12-month sales per material"'}
                onChange={(e) => { setSentence(e.target.value); setPromptHint(null); }}
                onKeyDown={(e) => e.key === "Enter" && e.metaKey && generate()}
                autoFocus
              />
              {promptHint && (
                <div className="rb-prompt-hint">
                  <span className="rb-prompt-hint-icon">💡</span>
                  <span>{promptHint}</span>
                </div>
              )}
              <div className="rb-footer" style={{ justifyContent: "space-between" }}>
                <button className="btn" onClick={() => setMode(null)}>← Back</button>
                <button className="btn btn-primary" onClick={generate} disabled={loading || !sentence.trim()}>
                  {loading ? "Generating…" : "✨ Generate rule"}
                </button>
              </div>
            </div>
          )}

          {/* ── Rule form ── */}
          {draft && (
            <div className="rb-section">
              {mode === "ai" && (
                <div className="rb-ai-note">
                  <span>✨ AI generated — review and adjust before saving.</span>
                  <button className="link-btn" onClick={() => { setSentence(draft.raw_sentence || sentence); setDraft(null); }}>Re-generate</button>
                </div>
              )}

              {/* Original description — kept visible throughout the process so the
                  user can always see the exact text they entered (and edit/re-generate
                  from it without retyping). Shown whenever a description exists. */}
              {draft.raw_sentence && (
                <div className="rb-original">
                  <span className="rb-original-label">📝 Your description</span>
                  <p className="rb-original-text">{draft.raw_sentence}</p>
                </div>
              )}

              {/* Rule name */}
              <div className="rb-field">
                <label className="rb-label">Rule name</label>
                <input
                  className="rb-input"
                  value={draft.name || ""}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="e.g. High forecast deviation"
                  autoFocus={mode === "manual"}
                />
              </div>

              {/* Conditions section */}
              <div className="rb-field">
                <div className="rb-conditions-label-row">
                  <label className="rb-label" style={{ margin: 0 }}>Condition</label>
                  {conditionMode === "structured" ? (
                    <button className="link-btn" onClick={switchToFormula}>Use formula instead</button>
                  ) : (
                    <button className="link-btn" onClick={switchToStructured}>Use condition builder instead</button>
                  )}
                </div>

                {conditionMode === "formula" ? (
                  /* Formula rule — human-readable + editable */
                  <div className="rb-formula-card">
                    <div className="rb-formula-header">
                      <span>{editingFormula ? "Write your formula" : mode === "ai" ? "✨ AI understood your rule as" : "Formula"}</span>
                      {!editingFormula && draft.formula && (
                        <button className="link-btn" onClick={() => { setFormulaDraft(draft.formula); setEditingFormula(true); }}>
                          Edit formula
                        </button>
                      )}
                    </div>

                    {editingFormula ? (
                      /* Edit mode — side-by-side: column picker left, editor right */
                      <>
                        <div className="rb-formula-edit-layout">
                          {/* Left: column picker */}
                          <div className="rb-col-picker">
                            <div className="rb-col-search-row">
                              <input
                                className="rb-col-search"
                                placeholder="Search columns…"
                                value={colSearch}
                                onChange={(e) => setColSearch(e.target.value)}
                                onMouseDown={(e) => e.stopPropagation()}
                              />
                            </div>

                            {(() => {
                              const q = colSearch.trim().toLowerCase();
                              if (q) {
                                const hits = COLUMN_GROUPS.flatMap(({ label: grp, columns }) =>
                                  Object.entries(columns)
                                    .filter(([col, name]) =>
                                      name.toLowerCase().includes(q) ||
                                      grp.toLowerCase().includes(q) ||
                                      col.includes(q)
                                    )
                                    .map(([col, name]) => ({ col, name, grp }))
                                );
                                return hits.length === 0 ? (
                                  <div className="rb-col-no-results">No match for "{colSearch}"</div>
                                ) : (
                                  <div className="rb-col-groups">
                                    {hits.map(({ col, name, grp }) => (
                                      <button key={col} className="rb-col-btn"
                                        title={`row.${col}`}
                                        onMouseDown={(e) => { e.preventDefault(); insertColumn(col); }}>
                                        <span className="rb-col-btn-label">{name}</span>
                                        <span className="rb-col-btn-group">{grp}</span>
                                      </button>
                                    ))}
                                  </div>
                                );
                              }
                              return (
                                <div className="rb-col-groups">
                                  {COLUMN_GROUPS.map(({ label: grp, columns }) => (
                                    <div key={grp} className="rb-col-group">
                                      <div className="rb-col-group-label">{grp}</div>
                                      {Object.entries(columns).map(([col, name]) => (
                                        <button key={col} className="rb-col-btn"
                                          title={`row.${col}`}
                                          onMouseDown={(e) => { e.preventDefault(); insertColumn(col); }}>
                                          <span className="rb-col-btn-label">{name}</span>
                                        </button>
                                      ))}
                                    </div>
                                  ))}
                                </div>
                              );
                            })()}
                          </div>

                          {/* Right: formula editor + validation */}
                          <div className="rb-formula-editor-panel">
                            <textarea
                              ref={formulaRef}
                              className={`rb-formula-editor${formulaError ? " rb-formula-editor-invalid" : ""}`}
                              value={formulaDraft}
                              onChange={handleFormulaChange}
                              placeholder={"e.g.\nrow.sales_free_stock_in_tons\n  > 0.8 * row.historic_sales_12_free_stock_in_tons"}
                              spellCheck={false}
                              autoFocus
                            />
                            {formulaError
                              ? <div className="rb-formula-err">⚠ {formulaError}</div>
                              : formulaDraft.trim() && <div className="rb-formula-ok">✓ Formula looks valid</div>
                            }
                          </div>
                        </div>

                        <div className="rb-formula-editor-actions">
                          <button className="btn" onClick={() => {
                            if (!draft.formula) switchToStructured();
                            else { setEditingFormula(false); setFormulaError(null); }
                          }}>Cancel</button>
                          <button
                            className="btn btn-primary"
                            disabled={!!formulaError || !formulaDraft.trim().includes("row.")}
                            onClick={() => { set("formula", formulaDraft.trim()); setEditingFormula(false); setFormulaError(null); }}
                          >
                            Save formula
                          </button>
                        </div>
                      </>
                    ) : draft.formula ? (
                      /* Read mode — human-readable breakdown */
                      <>
                        <div className="rb-formula-human">{humanizeFormula(draft.formula)}</div>
                        <div className="rb-formula-cols">
                          <span className="rb-formula-cols-label">Using:</span>
                          {extractColumns(draft.formula).map((label) => (
                            <span key={label} className="rb-formula-chip">{label}</span>
                          ))}
                        </div>
                        {draft.detail_label && (
                          <div className="rb-formula-signal">
                            Signal will read: <em>{draft.detail_label}</em>
                          </div>
                        )}
                      </>
                    ) : (
                      /* No formula yet — prompt */
                      <div className="rb-formula-empty">
                        <p>Build a custom calculation using your data columns.</p>
                        <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={() => { setFormulaDraft(""); setEditingFormula(true); }}>
                          Write formula
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Structured conditions builder */
                  <>
                    <div className="rb-conditions-header">
                      {draft.groups.length > 1 && (
                        <div className="rb-group-logic-row">
                          <span className="rb-group-label">Trigger when</span>
                          <button
                            className={`rb-logic-pill ${draft.groupLogic === "OR" ? "rb-logic-or" : "rb-logic-and"}`}
                            onClick={() => set("groupLogic", draft.groupLogic === "OR" ? "AND" : "OR")}
                          >
                            {draft.groupLogic === "OR" ? "any group" : "all groups"}
                          </button>
                          <span className="rb-group-label">match</span>
                        </div>
                      )}
                    </div>

                    {draft.groups.map((group, gi) => (
                      <div key={gi}>
                        {gi > 0 && (
                          <div className="rb-group-sep">
                            <div className="rb-sep-line" />
                            <span className={`rb-sep-badge ${draft.groupLogic === "OR" ? "rb-logic-or" : "rb-logic-and"}`}>
                              {draft.groupLogic}
                            </span>
                            <div className="rb-sep-line" />
                          </div>
                        )}
                        <GroupCard
                          group={group}
                          groupIndex={gi}
                          totalGroups={draft.groups.length}
                          groupLogic={draft.groupLogic}
                          onUpdateGroup={(patch) => updateGroup(gi, patch)}
                          onRemoveGroup={() => removeGroup(gi)}
                          onUpdateCond={(ci, patch) => updateCond(gi, ci, patch)}
                          onAddCond={() => addCond(gi)}
                          onRemoveCond={(ci) => removeCond(gi, ci)}
                        />
                      </div>
                    ))}

                    <button className="rb-add-group" onClick={addGroup}>+ Add group</button>
                  </>
                )}
              </div>

              {/* Criticality slider — formula rules have no per-group sliders, so this
                  single control drives the rule's score. Same slider component as the
                  manual builder's group cards, and it feeds the score card + pills below. */}
              {conditionMode === "formula" && (
                <div className="rb-field">
                  <label className="rb-label">Criticality</label>
                  <div className="rb-formula-sev">
                    <span className="rb-group-label">Set how critical this rule is</span>
                    <GroupSeverityBars
                      score={crit.score}
                      onChange={(sc) => setDraft((d) => ({ ...d, score: sc, severity: scoreToSeverity(sc) }))}
                    />
                  </div>
                </div>
              )}

              {/* Score card — reflects the calculated severity in both modes: from the
                  group sliders (structured) or the criticality slider (formula). */}
              {crit && (conditionMode === "formula" || draft.groups.length > 0) && (() => {
                const st = SEV_STYLE[crit.severity];
                const sub = conditionMode === "formula"
                  ? "Based on the criticality slider above"
                  : `Highest severity across ${draft.groups.length} group${draft.groups.length > 1 ? "s" : ""}`;
                return (
                  <div className="rb-field">
                    <div className="rb-scorecard" style={{ background: st.bg, border: `1px solid ${st.border}` }}>
                      <div className="rb-scorecard-left">
                        <span className="rb-scorecard-title">Calculated score</span>
                        <span className="rb-scorecard-sub">{sub}</span>
                      </div>
                      <div className="rb-scorecard-right">
                        <span className="rb-scorecard-score" style={{ color: st.color }}>{crit.score}/10</span>
                        <span className="rb-scorecard-sev" style={{ color: st.color }}>
                          {crit.severity.charAt(0).toUpperCase() + crit.severity.slice(1)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Severity — derived (read-only) from the score above in both modes. The
                  active pill tracks the slider dynamically. */}
              <div className="rb-field">
                <label className="rb-label">Severity</label>
                <div className="rb-sev-row">
                  {SEVERITIES.map((s) => {
                    const active = crit?.severity === s;
                    const st = SEV_STYLE[s];
                    return (
                      <button
                        key={s}
                        className="rb-sev-pill"
                        style={active ? { background: st.bg, border: `1px solid ${st.border}`, color: st.color } : {}}
                        disabled
                        title={conditionMode === "formula" ? "Derived from the criticality slider above" : "Derived from each group's score above"}
                      >
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rb-footer">
                <button className="btn" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" onClick={save} disabled={!canSave}>Save rule</button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
