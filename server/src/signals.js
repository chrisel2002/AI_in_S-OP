// Signal engine: turns plan rows + active rules into scored, prioritised signals.
//
// Two sources of signals:
//   1) Built-in detectors (the 4 types that run on your real data)
//   2) Custom user rules (threshold filters created via the rule builder)
//
// Each combo = material × plant × sales_office (12 monthly rows). We emit at most
// one signal per (combo, type) — the worst month — so the list stays readable.

const PRIORITY = (score) => (score >= 80 ? "High" : score >= 50 ? "Medium" : "Low");
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Ignore tiny tonnages: a 1000% swing on 0.05t is noise, not a planning signal.
// Only volumes at or above this floor (in tons) can raise a signal.
const MIN_TONS = 5;

// Map a deviation/change ratio to a 0-100 score on a log curve so scores don't all
// saturate at 100. |dev| 0.2 -> ~56, 1.0 -> ~75, 2.0 -> ~90, 3.0+ -> 100 (critical).
const ratioScore = (ratio) =>
  clamp(Math.round(50 + 25 * Math.log2(1 + Math.abs(ratio))), 40, 100);

function comboKey(r) {
  return `${r.material}|${r.plant}|${r.sales_office}`;
}

function groupByCombo(rows) {
  const map = new Map();
  for (const r of rows) {
    const k = comboKey(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  // each combo's months sorted by date
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

// 1) Forecast deviation: demand plan vs Actuals-12M reference (same scale in this data)
function detectForecastDeviation(months) {
  let worst = null;
  for (const r of months) {
    const reference = r.historic_sales_12_free_stock_in_tons;
    if (reference <= 0) continue;
    const plan = r.sales_free_stock_in_tons;
    // require at least one side to be materially large
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

// 2) Month-over-month spike/drop within the 12-month plan horizon
function detectMoMChange(months) {
  let worst = null;
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1].sales_free_stock_in_tons;
    const curr = months[i].sales_free_stock_in_tons;
    if (Math.max(prev, curr) < MIN_TONS) continue;
    if (prev < 0.01) continue; // a jump from ~0 is new demand, not an infinite spike
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

// 3) Low inventory while demand exists
function detectLowInventory(months) {
  let worst = null;
  for (const r of months) {
    const inv = r.historic_inventory_12_free_stock_in_tons;
    const demand = r.sales_free_stock_in_tons;
    if (demand < MIN_TONS) continue; // only flag stockout risk on material demand
    if (inv >= 1) continue; // threshold: < 1 ton coverage
    if (!worst || inv < worst.inv) worst = { r, inv, demand };
  }
  if (!worst) return null;
  const { r, inv, demand } = worst;
  const score = inv <= 0 ? 90 : clamp(Math.round(85 - inv * 30), 50, 90);
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

// 4) New demand where there was no historic sales
function detectNewDemand(months) {
  for (const r of months) {
    const hist = r.historic_sales_12_free_stock_in_tons + r.historic_sales_24_free_stock_in_tons;
    const plan = r.sales_free_stock_in_tons;
    if (plan >= MIN_TONS && hist === 0) {
      const score = 65;
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

function detectCustomRule(months, rule) {
  let worst = null;
  for (const r of months) {
    let value = r[rule.metric];
    if (value === undefined) continue;
    if (rule.comparison_type === "percent_change" && rule.baseline) {
      const base = r[rule.baseline];
      if (!base) continue;
      value = ((r[rule.metric] - base) / base) * 100;
    }
    const op = OPS[rule.operator] || OPS[">"];
    if (!op(value, rule.threshold)) continue;
    if (!worst || Math.abs(value) > Math.abs(worst.value)) worst = { r, value };
  }
  if (!worst) return null;
  const { r, value } = worst;
  const score = rule.severity === "critical" ? 90 : rule.severity === "warning" ? 70 : 50;
  return baseSignal(r, {
    type: rule.name || "Custom rule",
    month: r.date,
    score,
    priority: PRIORITY(score),
    detail: `${rule.metric} ${rule.operator} ${rule.threshold} → ${value.toFixed(2)}`,
    reasoning: rule.raw_sentence || `Custom rule: ${rule.metric} ${rule.operator} ${rule.threshold}.`,
    actions: "1. Review flagged rows\n2. Confirm with the planner\n3. Take corrective action",
  });
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
      const s = detectCustomRule(months, rule);
      if (s) signals.push(s);
    }
  }
  signals.sort((a, b) => b.score - a.score);
  signals.forEach((s, i) => (s.id = i + 1));
  return signals;
}

export function buildDashboard(signals, rulesActive) {
  const byType = {};
  const byBucket = { "0–30": 0, "31–50": 0, "51–70": 0, "71–90": 0, "90+": 0 };
  for (const s of signals) {
    byType[s.type] = (byType[s.type] || 0) + 1;
    const sc = s.score;
    if (sc <= 30) byBucket["0–30"]++;
    else if (sc <= 50) byBucket["31–50"]++;
    else if (sc <= 70) byBucket["51–70"]++;
    else if (sc <= 90) byBucket["71–90"]++;
    else byBucket["90+"]++;
  }
  return {
    kpis: {
      total: signals.length,
      critical: signals.filter((s) => s.score > 80).length,
      medium: signals.filter((s) => s.score >= 50 && s.score <= 80).length,
      rulesActive,
    },
    byType,
    byBucket,
    signals: signals.slice(0, 100), // top 100 for the table
  };
}
