
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
    if (!worst || Math.abs(change) > Math.abs(worst.change)) worst = { r: months[i], change, prev, curr };
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
      });
    }
  }
  return null;
}

const BUILTIN = [detectForecastDeviation, detectMoMChange, detectLowInventory, detectNewDemand];

// ---- custom rules -------------------------------------------------------

const OPS = {
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a === b,
};

// Returns ALL matching rows as individual signals (not just the single worst)
function detectCustomRule(months, rule) {
  const baselineCol = resolveColumn(rule.baseline);
  const results = [];

  for (const r of months) {
    let value = r[rule.metric];
    if (value === undefined || value === null) continue;

    if (rule.comparison_type === "percent_change" && baselineCol) {
      const base = r[baselineCol];
      if (base === undefined || base === null || base === 0) continue;
      value = ((r[rule.metric] - base) / base) * 100;
    }

    const op = OPS[rule.operator] || OPS[">"];
    if (!op(value, Number(rule.threshold))) continue;

    const score = rule.severity === "critical" ? 90 : rule.severity === "warning" ? 65 : 50;
    results.push(baseSignal(r, {
      type: rule.name || "Custom rule",
      month: r.date,
      score,
      priority: PRIORITY(score),
      detail: `${METRICS[rule.metric] || rule.metric} ${rule.operator} ${rule.threshold} → ${value.toFixed(2)}`,
      reasoning: rule.raw_sentence || `Custom rule: ${rule.metric} ${rule.operator} ${rule.threshold}.`,
      actions: "1. Review flagged rows\n2. Confirm with the planner\n3. Take corrective action",
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
  signals.forEach((s, i) => (s.id = i + 1));
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
