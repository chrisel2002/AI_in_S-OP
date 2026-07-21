import { resolveColumn, evalCondition, METRICS } from "./signals.js";

// Fields a planner is actually allowed to edit — must match ALLOWED_EDITABLE_FIELDS
// used in your PATCH /api/dashboard/signals/:id route.
const PLAN_OWNED_FIELDS = new Set([
  "sales_free_stock_in_tons",
  "sales_contracts_in_tons",
  "sales_scheduling_agreement_in_tons",
]);

function label(col) {
  return METRICS[col] || col;
}

// Normalizes a rule (any legacy shape) into { groups, groupLogic } — mirrors
// the same fallback logic detectCustomRule uses in signals.js.
function getRuleGroups(rule) {
  if (rule.groups?.length > 0) return { groups: rule.groups, groupLogic: rule.groupLogic || "OR" };
  const conditions = rule.conditions?.length > 0
    ? rule.conditions
    : [{ metric: rule.metric, comparison_type: rule.comparison_type, baseline: rule.baseline, operator: rule.operator, threshold: rule.threshold }];
  return { groups: [{ logic: rule.logic || "AND", conditions }], groupLogic: "OR" };
}

// Returns every condition that actually PASSED (i.e. is a real reason this
// row fired) — skips conditions that couldn't be evaluated (missing/zero baseline).
function findFiredConditions(rule, row) {
  const { groups } = getRuleGroups(rule);
  const fired = [];
  for (const group of groups) {
    for (const cond of group.conditions || []) {
      const ev = evalCondition(row, cond);
      if (!ev.skip && ev.passes) fired.push({ cond, value: ev.value });
    }
  }
  return fired;
}

// How far past its threshold a fired condition is — used to rank which
// condition is most worth generating a recommendation for.
function severityOf({ cond, value }) {
  const t = Number(cond.threshold);
  if (cond.comparison_type === "percent_change") return Math.abs(value - t);
  return Math.abs(value - t) / Math.max(Math.abs(t), 1);
}

// The core reverse-solver: given a condition that IS currently failing the
// business (i.e. passing the "risk" check), calculate the minimum field value
// that would flip it back to safe. Adds a small buffer past the boundary so
// the suggestion doesn't sit exactly on the edge.
function getBoundaryTarget(operator, threshold) {
  const eps = Math.max(Math.abs(threshold) * 0.02, 0.5);
  switch (operator) {
    case "<":  return threshold + eps; // need value >= threshold
    case "<=": return threshold + eps;
    case ">":  return threshold - eps; // need value <= threshold
    case ">=": return threshold - eps;
    case "==": return threshold + eps; // just needs to differ
    default:   return threshold;
  }
}

// Solves one condition. Returns null if it's not solvable (e.g. no baseline).
function solveTargetValue(cond, row) {
  const threshold = Number(cond.threshold);
  if (cond.comparison_type === "percent_change") {
    const baselineCol = resolveColumn(cond.baseline);
    const baseVal = row[baselineCol];
    if (!baselineCol || baseVal == null || baseVal === 0) return null;
    const targetPct = getBoundaryTarget(cond.operator, threshold);
    const targetValue = baseVal * (1 + targetPct / 100);
    return {
      field: cond.metric,
      targetValue,
      currentValue: row[cond.metric],
      baselineField: baselineCol,
      baselineValue: baseVal,
      currentPct: ((row[cond.metric] - baseVal) / baseVal) * 100,
      targetPct,
      threshold,
    };
  }
  // absolute
  const targetValue = getBoundaryTarget(cond.operator, threshold);
  return { field: cond.metric, targetValue, currentValue: row[cond.metric], threshold };
}

function formatRecommendationText(target) {
  const f = label(target.field);
  if (target.baselineField) {
    const b = label(target.baselineField);
    return `Adjusting ${f} to ${target.targetValue.toFixed(2)}t would bring it to ${target.targetPct.toFixed(1)}% vs ${b} (currently ${target.currentPct.toFixed(1)}%), resolving this signal.`;
  }
  return `Adjusting ${f} to ${target.targetValue.toFixed(2)}t (currently ${target.currentValue.toFixed(2)}t) would move it past the ${target.threshold}t threshold, resolving this signal.`;
}

// Extracts which plan-owned fields a rule actually references — used to scope
// the Planning Inputs panel to only show fields relevant to THIS signal.
export function getFieldsUsedByRule(rule) {
  const fields = new Set();
  if (rule.formula) {
    for (const m of rule.formula.matchAll(/row\.([a-zA-Z0-9_]+)/g)) fields.add(m[1]);
  } else {
    const { groups } = getRuleGroups(rule);
    for (const g of groups) {
      for (const c of g.conditions || []) {
        if (c.metric) fields.add(c.metric);
        const b = resolveColumn(c.baseline);
        if (b) fields.add(b);
      }
    }
  }
  return [...fields].filter((f) => PLAN_OWNED_FIELDS.has(f));
}

// Main entry point: builds guaranteed-correct, formula-derived recommendations
// for a structured rule. Returns [] for formula rules (not reverse-solvable) —
// caller should fall back to descriptive-only LLM text in that case.
export function buildDeterministicRecommendations(rule, row) {
  if (!rule || rule.formula) return [];
  const fired = findFiredConditions(rule, row)
    .sort((a, b) => severityOf(b) - severityOf(a))
    .slice(0, 2); // top 2 most severe conditions, avoid overwhelming the planner

  const recs = [];
  for (const item of fired) {
    if (!PLAN_OWNED_FIELDS.has(item.cond.metric)) continue; // can't suggest editing a non-editable field
    const target = solveTargetValue(item.cond, row);
    if (!target) continue;
    recs.push({
      text: formatRecommendationText(target),
      changes: { [target.field]: Number(target.targetValue.toFixed(3)) },
    });
  }
  return recs;
}