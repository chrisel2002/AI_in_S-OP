// Step 3: natural-language sentence -> structured rule.
// Primary: UniGPT (OpenAI-compatible LLM). Fallback: a keyword mock parser, used
// automatically if the API key is missing or the call fails — so the app never breaks.

const USE_LLM = process.env.USE_LLM !== "false"; // LLM on by default
const BASE_URL = process.env.UNIGPT_BASE_URL || "https://gpt.uni-muenster.de/v1";
const API_KEY = process.env.UNIGPT_API_KEY;
const MODEL = process.env.UNIGPT_MODEL || "mistral-small";

// --- the vocabulary a rule may use (kept in sync with the data columns) ----
const METRIC_COLUMNS = [
  "sales_free_stock_in_tons",
  "sales_contracts_in_tons",
  "sales_scheduling_agreement_in_tons",
  "historic_inventory_12_free_stock_in_tons",
  "historic_inventory_24_free_stock_in_tons",
  "historic_sales_12_free_stock_in_tons",
  "historic_sales_12_contracts_in_tons",
  "historic_sales_12_scheduling_agreement_in_tons",
  "historic_sales_24_free_stock_in_tons",
  "historic_sales_24_contracts_in_tons",
  "historic_sales_24_scheduling_agreement_in_tons",
];
const DIMENSIONS = [
  "material", "material_group", "material_division",
  "plant", "plant_group", "sales_office", "sales_office_group",
];
const OPERATORS = [">", ">=", "<", "<=", "=="];
const COMPARISONS = ["absolute", "percent_change"];
const SEVERITIES = ["info", "warning", "critical"];

const SYSTEM_PROMPT = `You convert a planner's plain-English sentence into a single JSON rule for a Sales & Operations Planning (S&OP) signal engine. The data is monthly demand-plan data measured in tons.

Return ONLY a JSON object (no prose, no markdown) with EXACTLY these fields:
- "name": short human-readable rule name (string)
- "metric": one of ${JSON.stringify(METRIC_COLUMNS)}
- "comparison_type": "absolute" (compare the metric value in tons) or "percent_change" (percent change vs a baseline column)
- "baseline": if comparison_type is "percent_change", one of the metric columns; otherwise null
- "operator": one of ">", ">=", "<", "<=", "=="
- "threshold": a number
- "group_by": array, subset of ${JSON.stringify(DIMENSIONS)} (use [] if none mentioned)
- "severity": "info", "warning", or "critical"

Guidance:
- "forecast"/"planned sales" -> sales_free_stock_in_tons; "contract" -> sales_contracts_in_tons; "scheduling agreement" -> sales_scheduling_agreement_in_tons; "inventory"/"stock" -> historic_inventory_12_free_stock_in_tons.
- "above/over/more than/exceeds" -> ">"; "below/under/less than" -> "<".
- Mentions of "%" or "percent" -> comparison_type "percent_change" with a sensible historic baseline; otherwise "absolute" with baseline null.
- "critical/urgent" -> "critical"; otherwise "warning".

Example:
Input: "Flag as critical when forecast sales are above 10 tons per material"
Output: {"name":"High forecast demand","metric":"sales_free_stock_in_tons","comparison_type":"absolute","baseline":null,"operator":">","threshold":10,"group_by":["material"],"severity":"critical"}`;

// --- keyword mock parser (fallback) ---------------------------------------
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

// --- helpers ---------------------------------------------------------------
function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in LLM response");
  return text.slice(start, end + 1);
}

// Guard against hallucinated columns/values — clamp everything to the allowed set.
function normalizeRule(raw, sentence) {
  const metric = METRIC_COLUMNS.includes(raw.metric) ? raw.metric : "sales_free_stock_in_tons";
  const comparison_type = COMPARISONS.includes(raw.comparison_type) ? raw.comparison_type : "absolute";
  let baseline = null;
  if (comparison_type === "percent_change") {
    baseline = METRIC_COLUMNS.includes(raw.baseline) ? raw.baseline : "historic_sales_12_free_stock_in_tons";
  }
  const operator = OPERATORS.includes(raw.operator) ? raw.operator : ">";
  const severity = SEVERITIES.includes(raw.severity) ? raw.severity : "warning";
  const group_by = Array.isArray(raw.group_by) ? raw.group_by.filter((d) => DIMENSIONS.includes(d)) : [];
  const threshold = Number.isFinite(Number(raw.threshold)) ? Number(raw.threshold) : 0;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : sentence.slice(0, 48);
  return { name, metric, comparison_type, baseline, operator, threshold, group_by, severity, raw_sentence: sentence, active: true };
}

export async function parseWithLLM(sentence) {
  if (!API_KEY) return parseMock(sentence);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: sentence },
        ],
      }),
    });
    if (!res.ok) throw new Error(`UniGPT HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    return normalizeRule(JSON.parse(extractJson(text)), sentence);
  } catch (e) {
    console.log("LLM parse failed, falling back to mock:", e.message);
    return parseMock(sentence);
  }
}

export async function parseSentence(sentence) {
  if (USE_LLM) return parseWithLLM(sentence);
  return parseMock(sentence);
}
