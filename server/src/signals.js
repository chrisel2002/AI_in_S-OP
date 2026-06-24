import vm from "node:vm";

const PRIORITY = (score) => (score >= 85 ? "High" : score >= 60 ? "Medium" : "Low");
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const MIN_TONS = 5;

const ratioScore = (ratio) =>
  clamp(Math.round(40 + 20 * Math.log2(1 + Math.abs(ratio))), 40, 100);

function comboKey(r) {
  return `${r.material}|${r.plant}|${r.sales_office}`;
}

const METRICS = {
  "sales_free_stock_in_tons": "Forecast sales (free stock)",
  "sales_contracts_in_tons": "Forecast sales (contracts)",
  "sales_scheduling_agreement_in_tons": "Forecast sales (scheduling agreement)",
  "historic_inventory_12_free_stock_in_tons": "Inventory 12mo (free stock)",
  "historic_sales_12_free_stock_in_tons": "Historic sales 12mo (free stock)",
  "historic_sales_24_free_stock_in_tons": "Historic sales 24mo (free stock)",
};

// Reverse map: label → column key (to handle rules saved with old label-based baseline)
const LABEL_TO_COL = Object.fromEntries(
  Object.entries(METRICS).map(([col, label]) => [label, col])
);

function resolveColumn(val) {
  if (!val) return null;
  if (val in LABEL_TO_COL) return LABEL_TO_COL[val]; // old label → fix to key
  return val; // already a column key
}

function groupByCombo(rows) {
  const map = new Map();
  for (const r of rows) {
    const k = comboKey(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
  return map;
}

function baseSignal(r, extra) {
  return {
    material: r.material,
    plant: r.plant,
    salesOffice: r.sales_office,
    ...extra,
  };
}

// ---- built-in detectors -------------------------------------------------

function detectForecastDeviation(months) {
  let worst = null;
  for (const r of months) {
    const reference = r.historic_sales_12_free_stock_in_tons;
    if (reference <= 0) continue;
    const plan = r.sales_free_stock_in_tons;
    if (Math.max(plan, reference) < MIN_TONS) continue;
    const dev = (plan - reference) / reference;
    if (Math.abs(dev) < 0.2) continue;
    if (!worst || Math.abs(dev) > Math.abs(worst.dev)) worst = { r, dev, plan, reference };
  }
  if (!worst) return null;
  const { r, dev, plan, reference } = worst;
  const score = ratioScore(dev);
  return baseSignal(r, {
    type: "Forecast deviation",
    month: r.date,
    score,
    priority: PRIORITY(score),
    detail: `Plan ${plan.toFixed(2)}t vs Actuals-12M ${reference.toFixed(2)}t (${(dev * 100).toFixed(0)}%)`,
    reasoning: `Demand plan deviates ${(dev * 100).toFixed(0)}% from the 12-month actuals reference for this month. Threshold ±20%.`,
    actions:
      "1. Confirm with sales whether the revision is justified\n2. Cross-check against the Actuals 12M trend\n3. Adjust the safety buffer if validated",
    snapshot: { kind: "deviation", plan, reference, devPct: dev * 100, thresholdPct: 20 },
  });
}

function detectMoMChange(months) {
  let worst = null;
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1].sales_free_stock_in_tons;
    const curr = months[i].sales_free_stock_in_tons;
    if (Math.max(prev, curr) < MIN_TONS) continue;
    if (prev < 0.01) continue;
    const change = (curr - prev) / prev;
    if (Math.abs(change) < 0.3) continue;
    if (!worst || Math.abs(change) > Math.abs(worst.change)) worst = { r: months[i], change, prev, curr, prevDate: months[i - 1].date };
  }
  if (!worst) return null;
  const { r, change, prev, curr } = worst;
  const score = ratioScore(change);
  const dir = change > 0 ? "spike" : "drop";
  return baseSignal(r, {
    type: change > 0 ? "Demand surge" : "Demand drop",
    month: r.date,
    score,
    priority: PRIORITY(score),
    detail: `${dir} ${(change * 100).toFixed(0)}% MoM (${prev.toFixed(2)}t → ${curr.toFixed(2)}t)`,
    reasoning: `Demand plan ${dir}s ${Math.abs(change * 100).toFixed(0)}% versus the previous month. Threshold ±30%.`,
    actions:
      change > 0
        ? "1. Check plant capacity for the spike month\n2. Verify if a campaign/seasonal effect drives it\n3. Pre-build buffer if confirmed"
        : "1. Confirm the demand truly dropped\n2. Postpone open supply orders\n3. Reallocate incoming supply",
    snapshot: {
      kind: "mom_change",
      prevDate: worst.prevDate,
      prevVal: prev,
      currDate: r.date,
      currVal: curr,
      changePct: change * 100,
      thresholdPct: 30,
    },
  });
}

function detectLowInventory(months) {
  let worst = null;
  for (const r of months) {
    const inv = r.historic_inventory_12_free_stock_in_tons;
    const demand = r.sales_free_stock_in_tons;
    if (demand < MIN_TONS) continue;
    if (inv >= 1) continue;
    if (!worst || inv < worst.inv) worst = { r, inv, demand };
  }
  if (!worst) return null;
  const { r, inv, demand } = worst;
  const coverage = inv / demand;
  const score = inv <= 0 ? 85 : clamp(Math.round(80 - coverage * 40), 50, 85);
  return baseSignal(r, {
    type: "Stockout risk",
    month: r.date,
    score,
    priority: PRIORITY(score),
    detail: `Inventory ${inv.toFixed(2)}t with demand ${demand.toFixed(2)}t`,
    reasoning: `Inventory coverage is below the 1-ton threshold while demand is planned. Risk of stockout.`,
    actions:
      "1. Trigger replenishment order\n2. Reallocate stock from another plant\n3. Limit orders to existing contracts this week",
    snapshot: { kind: "low_inventory", inv, demand, thresholdTons: 1 },
  });
}

function detectNewDemand(months) {
  for (const r of months) {
    const hist = r.historic_sales_12_free_stock_in_tons + r.historic_sales_24_free_stock_in_tons;
    const plan = r.sales_free_stock_in_tons;
    if (plan >= MIN_TONS && hist === 0) {
      const score = 58;
      return baseSignal(r, {
        type: "New demand",
        month: r.date,
        score,
        priority: PRIORITY(score),
        detail: `Planned ${plan.toFixed(2)}t with no 12/24M sales history`,
        reasoning: `Demand is planned for a material/plant with no historic sales — verify the new forecast.`,
        actions:
          "1. Confirm the new demand with sales\n2. Check master-data setup for the material\n3. Plan initial safety stock",
        snapshot: { kind: "new_demand", plan },
      });
    }
  }
  return null;
}

const BUILTIN = [detectForecastDeviation, detectMoMChange, detectLowInventory, detectNewDemand];

// ---- formula evaluation (sandboxed, for AI-generated rules) -------------
// Compile each formula script once and reuse a single context per formula
// instead of creating a new V8 context per row (which is very slow at scale).
const _formulaRunners = new Map();

function getFormulaRunner(formula) {
  if (_formulaRunners.has(formula)) return _formulaRunners.get(formula);
  const script = new vm.Script(formula);
  const rowRef = {};
  const ctx = vm.createContext({ row: rowRef });
  const run = (row) => {
    // Overwrite the shared row object in-place — same schema for all rows
    Object.assign(rowRef, row);
    try { return Boolean(script.runInContext(ctx, { timeout: 50 })); }
    catch { return false; }
  };
  _formulaRunners.set(formula, run);
  return run;
}

function evalFormula(row, formula) {
  return getFormulaRunner(formula)(row);
}

// ---- custom rules -------------------------------------------------------

const OPS = {
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a === b,
};

// Evaluate a single condition against a row. Returns { passes, value } or null if data missing.
function evalCondition(r, cond) {
  const baselineCol = resolveColumn(cond.baseline);
  let value = r[cond.metric];
  if (value === undefined || value === null) return null;
  if (cond.comparison_type === "percent_change" && baselineCol) {
    const base = r[baselineCol];
    if (!base) return null;
    value = ((r[cond.metric] - base) / base) * 100;
  }
  const op = OPS[cond.operator] || OPS[">"];
  return { passes: op(value, Number(cond.threshold)), value };
}

// Decompose a simple AI formula — a chain of "row.col OP value" terms joined by
// && or || — into structured comparison conditions so custom-rule signals get
// the same visual snapshot as the built-in detectors. Returns null when the
// formula is too complex to map cleanly onto comparison cards (parentheses,
// mixed &&/|| since precedence can't be shown in a flat list, or unknown RHS
// shapes), in which case the caller falls back to the raw formula + value table.
function buildFormulaConditions(row, formula) {
  if (/[()]/.test(formula)) return null;
  const hasAnd = formula.includes("&&");
  const hasOr = formula.includes("||");
  if (hasAnd && hasOr) return null; // mixed logic → can't represent precedence in flat cards
  const logic = hasOr ? "OR" : "AND";
  const terms = formula.split(/\s*(?:&&|\|\|)\s*/).map((t) => t.trim()).filter(Boolean);
  if (!terms.length) return null;
  const conditions = [];
  for (const term of terms) {
    const m = term.match(/^row\.(\w+)\s*(<=|>=|<|>|===?)\s*(.+)$/);
    if (!m) return null;
    const metric = m[1];
    const op = m[2] === "===" ? "==" : m[2];
    const rhs = m[3].trim();
    const value = row[metric];
    if (value == null) return null;
    const num = rhs.match(/^([\d.]+)$/);
    const fc1 = rhs.match(/^([\d.]+)\s*\*\s*row\.(\w+)$/);
    const fc2 = rhs.match(/^row\.(\w+)\s*\*\s*([\d.]+)$/);
    const bare = rhs.match(/^row\.(\w+)$/);
    if (num) {
      conditions.push({ mode: "threshold", metric, value, op, threshold: Number(num[1]) });
    } else if (fc1 || fc2 || bare) {
      const factor = bare ? 1 : Number(fc1 ? fc1[1] : fc2[2]);
      const baseline = bare ? bare[1] : (fc1 ? fc1[2] : fc2[1]);
      const baselineValue = row[baseline];
      if (baselineValue == null) return null;
      conditions.push({ mode: "ratio", metric, value, op, factor, baseline, baselineValue, reference: factor * baselineValue });
    } else {
      return null;
    }
  }
  return { logic, conditions };
}

// Same idea for structured (non-formula) custom rules built from groups/conditions.
function buildStructuredConditions(row, groups, groupLogic) {
  const conditions = [];
  for (const group of groups) {
    for (const cond of group.conditions || []) {
      const value = row[cond.metric];
      if (value == null) return null;
      if (cond.comparison_type === "percent_change") {
        const baseline = resolveColumn(cond.baseline);
        const baselineValue = baseline ? row[baseline] : null;
        if (!baselineValue) return null;
        conditions.push({
          mode: "percent", metric: cond.metric, value, op: cond.operator,
          threshold: Number(cond.threshold), baseline, baselineValue,
          pct: ((value - baselineValue) / baselineValue) * 100,
        });
      } else {
        conditions.push({ mode: "threshold", metric: cond.metric, value, op: cond.operator, threshold: Number(cond.threshold) });
      }
    }
  }
  if (!conditions.length) return null;
  const logic = groups.length > 1 ? (groupLogic || "OR") : (groups[0]?.logic || "AND");
  return { logic, conditions };
}

// Returns ALL matching rows as individual signals (not just the single worst)
function detectCustomRule(months, rule) {
  // Accept both the current low/medium/high labels and the legacy info/warning/
  // critical values that may still be stored on older rules.
  const score = ["high", "critical"].includes(rule.severity) ? 90
    : ["medium", "warning"].includes(rule.severity) ? 65
    : 50;
  const results = [];

  // ── Formula path (AI-generated arbitrary expression) ────────────────────
  if (rule.formula) {
    for (const r of months) {
      if (!evalFormula(r, rule.formula)) continue;
      // Prefer a structured comparison snapshot (matches the built-in signal
      // look); fall back to the raw formula + values table if it can't be parsed.
      const parsed = buildFormulaConditions(r, rule.formula);
      let snapshot;
      if (parsed) {
        snapshot = { kind: "conditions", logic: parsed.logic, conditions: parsed.conditions, formula: rule.formula };
      } else {
        const vals = {};
        for (const col of Object.keys(METRICS)) if (r[col] != null) vals[col] = r[col];
        snapshot = { kind: "formula", formula: rule.formula, values: vals };
      }
      results.push(baseSignal(r, {
        type: rule.name || "Custom rule",
        month: r.date,
        score,
        priority: PRIORITY(score),
        detail: rule.detail_label || "Formula condition matched",
        reasoning: rule.raw_sentence || rule.formula,
        actions: "1. Review flagged rows\n2. Confirm with the planner\n3. Take corrective action",
        snapshot,
      }));
    }
    return results;
  }

  // ── Structured-condition path ────────────────────────────────────────────
  let groups;
  if (rule.groups?.length > 0) {
    groups = rule.groups;
  } else {
    const conditions = rule.conditions?.length > 0
      ? rule.conditions
      : [{ metric: rule.metric, comparison_type: rule.comparison_type, baseline: rule.baseline, operator: rule.operator, threshold: rule.threshold }];
    groups = [{ logic: rule.logic || "AND", conditions }];
  }
  const groupLogic = rule.groupLogic || "OR";

  for (const r of months) {
    const groupResults = groups.map((group) => {
      const evals = (group.conditions || []).map((cond) => evalCondition(r, cond));
      if (!evals.length || evals.some((e) => e === null)) return null;
      return (group.logic || "AND") === "OR"
        ? evals.some((e) => e.passes)
        : evals.every((e) => e.passes);
    });

    if (groupResults.some((p) => p === null)) continue;
    const passes = groupLogic === "OR"
      ? groupResults.some((p) => p)
      : groupResults.every((p) => p);
    if (!passes) continue;

    const totalConds = groups.reduce((s, g) => s + (g.conditions?.length || 0), 0);
    const structured = buildStructuredConditions(r, groups, groupLogic);
    results.push(baseSignal(r, {
      type: rule.name || "Custom rule",
      month: r.date,
      score,
      priority: PRIORITY(score),
      detail: `${groups.length} group(s), ${totalConds} condition(s) matched`,
      reasoning: rule.raw_sentence || `Custom rule: ${groups.length} group(s).`,
      actions: "1. Review flagged rows\n2. Confirm with the planner\n3. Take corrective action",
      ...(structured ? { snapshot: { kind: "conditions", logic: structured.logic, conditions: structured.conditions } } : {}),
    }));
  }

  return results;
}

// ---- public API ---------------------------------------------------------

export function detectSignals(rows, customRules = []) {
  const combos = groupByCombo(rows);
  const signals = [];
  for (const months of combos.values()) {
    for (const detector of BUILTIN) {
      const s = detector(months);
      if (s) signals.push(s);
    }
    for (const rule of customRules) {
      if (rule.active === false) continue;
      // push every matching row as its own signal
      for (const s of detectCustomRule(months, rule)) signals.push(s);
    }
  }
  signals.sort((a, b) => b.score - a.score);
  signals.forEach((s, i) => {
    s.id = i + 1;
    s.key = `${s.material}|${s.plant}|${s.salesOffice}|${s.type}|${s.month}`;
  });
  return signals;
}

export function buildDashboard(signals, rulesActive, { page = 0, pageSize = 100, allSignals = null } = {}) {
  // byType always uses the FULL signal set so dropdown is never missing types
  const sourceForStats = allSignals || signals;
  const byType = {};
  const byBucket = { "0–30": 0, "31–50": 0, "51–70": 0, "71–90": 0, "90+": 0 };

  for (const s of sourceForStats) {
    byType[s.type] = (byType[s.type] || 0) + 1;
    const sc = s.score;
    if (sc <= 30) byBucket["0–30"]++;
    else if (sc <= 50) byBucket["31–50"]++;
    else if (sc <= 70) byBucket["51–70"]++;
    else if (sc <= 90) byBucket["71–90"]++;
    else byBucket["90+"]++;
  }

  const totalSignals = signals.length;
  const totalPages = Math.max(1, Math.ceil(totalSignals / pageSize));
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
  const pagedSignals = signals.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  return {
    kpis: {
      total: sourceForStats.length,   // total across ALL signals including custom
      critical: sourceForStats.filter((s) => s.score >= 85).length,
      medium: sourceForStats.filter((s) => s.score >= 60 && s.score < 85).length,
      rulesActive,
    },
    byType,
    byBucket,
    signals: pagedSignals,
    page: currentPage,
    pageSize,
    totalPages,
  };
}
