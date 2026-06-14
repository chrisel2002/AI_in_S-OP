// Step 3: natural-language sentence -> structured rule (mock).
// Swap parseWithLLM in later (e.g. the OpenAI API) and set USE_LLM = true. Nothing else changes.
const USE_LLM = false;

const GT = ["above", "over", "greater", "more than", "exceeds", "higher", "increase", "spike", "jump"];
const LT = ["below", "under", "less than", "fewer", "lower", "drop", "decrease", "falls", "decline"];

function pickMetric(t) {
  if (t.includes("scheduling agreement")) return "sales_scheduling_agreement_in_tons";
  if (t.includes("contract")) return "sales_contracts_in_tons";
  if (t.includes("inventory") || t.includes("stock level")) return "historic_inventory_12_free_stock_in_tons";
  return "sales_free_stock_in_tons";
}

function baselineFor(metric, t) {
  const h = t.includes("24") || t.includes("two year") ? "24" : "12";
  if (metric.includes("contract")) return `historic_sales_${h}_contracts_in_tons`;
  if (metric.includes("scheduling")) return `historic_sales_${h}_scheduling_agreement_in_tons`;
  return `historic_sales_${h}_free_stock_in_tons`;
}

export function parseMock(sentence) {
  const t = sentence.toLowerCase();
  const metric = pickMetric(t);
  const operator = GT.some((w) => t.includes(w)) ? ">" : LT.some((w) => t.includes(w)) ? "<" : ">";
  const m = t.match(/(-?\d+(?:\.\d+)?)/);
  const threshold = m ? parseFloat(m[1]) : 0;
  const isPercent = t.includes("%") || t.includes("percent");

  let group_by = [];
  if (t.includes("material")) group_by = ["material"];
  else if (t.includes("plant")) group_by = ["plant"];

  const severity = /critical|urgent|severe/.test(t) ? "critical" : "warning";

  return {
    name: sentence.length > 48 ? sentence.slice(0, 48) + "…" : sentence,
    metric,
    comparison_type: isPercent ? "percent_change" : "absolute",
    baseline: isPercent ? baselineFor(metric, t) : null,
    operator,
    threshold,
    group_by,
    severity,
    raw_sentence: sentence,
    active: true,
  };
}

export function parseSentence(sentence) {
  // if (USE_LLM) return parseWithLLM(sentence);
  return parseMock(sentence);
}
