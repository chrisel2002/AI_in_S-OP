// Step 3: natural-language sentence -> structured rule.
// Primary: UniGPT (OpenAI-compatible LLM). Two parallel calls:
//   Call 1 — structured fields (name, severity, metric, operator, threshold)
//   Call 2 — focused formula generation (always, regardless of complexity)
// Fallback: a keyword mock parser used when the API key is missing or calls fail.

const USE_LLM = process.env.USE_LLM !== "false";
const BASE_URL = process.env.UNIGPT_BASE_URL || "https://gpt.uni-muenster.de/v1";
const API_KEY  = process.env.UNIGPT_API_KEY;
const MODEL    = process.env.UNIGPT_MODEL || "mistral-small";

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
const DIMENSIONS  = ["material", "material_group", "material_division", "plant", "plant_group", "sales_office", "sales_office_group"];
const OPERATORS   = [">", ">=", "<", "<=", "=="];
const COMPARISONS = ["absolute", "percent_change"];
const SEVERITIES  = ["info", "warning", "critical"];

// ── Call 1: structured fields ─────────────────────────────────────────────
const STRUCT_PROMPT = `You convert a planner's plain-English rule into a JSON object for an S&OP signal engine.

Return ONLY a JSON object with these fields:
- "name": short human-readable rule name
- "metric": one of ${JSON.stringify(METRIC_COLUMNS)}
- "comparison_type": "absolute" or "percent_change"
- "baseline": if percent_change, a metric column; otherwise null
- "operator": ">", ">=", "<", "<=", or "=="
- "threshold": a number
- "group_by": [] or subset of ${JSON.stringify(DIMENSIONS)}
- "severity": "info", "warning", or "critical"
- "detail_label": one short plain-text sentence describing what triggered

Guidance:
- "forecast"/"planned" → sales_free_stock_in_tons; "contract" → sales_contracts_in_tons; "inventory"/"stock" → historic_inventory_12_free_stock_in_tons.
- "above/over/exceeds" → ">"; "below/under/less than" → "<".
- "%" or "percent" → percent_change with a sensible historic baseline.
- "critical/urgent" → "critical"; otherwise "warning".
- For complex multi-column rules, pick the PRIMARY metric and approximate the threshold.

Example:
Input: "Flag when forecast is above 10 tons"
Output: {"name":"High forecast","metric":"sales_free_stock_in_tons","comparison_type":"absolute","baseline":null,"operator":">","threshold":10,"group_by":[],"severity":"warning","detail_label":"Forecast free stock above 10t"}`;

// ── Call 2: formula generation ────────────────────────────────────────────
const FORMULA_PROMPT = `You write JavaScript boolean expressions for an S&OP planning engine.

Available numeric variables (all values in tons):
  row.sales_free_stock_in_tons               — forecast free-stock sales
  row.sales_contracts_in_tons                — forecast contract sales
  row.sales_scheduling_agreement_in_tons     — forecast scheduling-agreement sales
  row.historic_inventory_12_free_stock_in_tons — 12-month average inventory
  row.historic_sales_12_free_stock_in_tons   — 12-month historic free-stock sales
  row.historic_sales_24_free_stock_in_tons   — 24-month historic free-stock sales
  row.historic_sales_12_contracts_in_tons    — 12-month historic contract sales
  row.historic_sales_24_contracts_in_tons    — 24-month historic contract sales
  row.historic_sales_12_scheduling_agreement_in_tons
  row.historic_sales_24_scheduling_agreement_in_tons

Rules:
- Return ONLY the boolean expression. No JSON. No markdown. No explanation. No semicolons.
- Use && for AND, || for OR, standard arithmetic operators.
- Every variable must start with row.

Examples:
"forecast above 10 tons"
→ row.sales_free_stock_in_tons > 10

"combined free stock and contracts exceed 80% of 12-month historic"
→ (row.sales_free_stock_in_tons + row.sales_contracts_in_tons) > 0.8 * row.historic_sales_12_free_stock_in_tons

"20% of forecast is below 70% of inventory"
→ (0.2 * row.sales_free_stock_in_tons) < (0.7 * row.historic_inventory_12_free_stock_in_tons)

"inventory below 2 months of planned sales AND forecast up more than 30% vs 12M historic"
→ row.historic_inventory_12_free_stock_in_tons < 2 * row.sales_free_stock_in_tons && row.sales_free_stock_in_tons > 1.3 * row.historic_sales_12_free_stock_in_tons`;

// ── Helpers ───────────────────────────────────────────────────────────────
function extractJson(text) {
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in LLM response");
  return text.slice(start, end + 1);
}

function normalizeStructured(raw, sentence) {
  const name         = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : sentence.slice(0, 48);
  const severity     = SEVERITIES.includes(raw.severity) ? raw.severity : "warning";
  const group_by     = Array.isArray(raw.group_by) ? raw.group_by.filter((d) => DIMENSIONS.includes(d)) : [];
  const detail_label = typeof raw.detail_label === "string" ? raw.detail_label.trim() : name;
  const metric       = METRIC_COLUMNS.includes(raw.metric) ? raw.metric : "sales_free_stock_in_tons";
  const comparison_type = COMPARISONS.includes(raw.comparison_type) ? raw.comparison_type : "absolute";
  const baseline     = comparison_type === "percent_change"
    ? (METRIC_COLUMNS.includes(raw.baseline) ? raw.baseline : "historic_sales_12_free_stock_in_tons")
    : null;
  const operator     = OPERATORS.includes(raw.operator) ? raw.operator : ">";
  const threshold    = Number.isFinite(Number(raw.threshold)) ? Number(raw.threshold) : 0;
  return { name, severity, group_by, detail_label, metric, comparison_type, baseline, operator, threshold, raw_sentence: sentence, active: true };
}

function extractFormula(raw) {
  if (!raw) return null;
  let t = raw
    .replace(/```[\w\s]*/g, "")   // strip code fence markers
    .replace(/`/g, "")             // strip inline backticks
    .replace(/^[^(\nrow]*?→\s*/m, "") // strip "input → " echo format
    .trim();

  // If multiline, keep only lines that look like formula fragments
  if (t.includes("\n")) {
    const parts = t.split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && (l.includes("row.") || /^[(&|!]/.test(l)));
    t = parts.length > 0 ? parts.join(" ") : t.split("\n")[0].trim();
  }

  if (!t.includes("row."))                          return null; // no column reference
  if (/{/.test(t) && /}/.test(t))                   return null; // looks like JSON
  if (t.includes(";")) t = t.split(";")[0].trim();  // take first statement only
  if (/\b(var|let|const|function|return)\b/.test(t)) return null;
  if (!/[><=]/.test(t))                              return null; // no comparison
  return t;
}

async function llmCall(systemPrompt, userContent) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userContent  },
      ],
    }),
  });
  if (!res.ok) throw new Error(`UniGPT HTTP ${res.status}`);
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content ?? "").trim();
}

// ── Mock fallback (no LLM) ────────────────────────────────────────────────
const GT = ["above", "over", "greater", "more than", "exceeds", "higher", "increase", "spike", "jump"];
const LT = ["below", "under", "less than", "fewer", "lower", "drop", "decrease", "falls", "decline"];

function pickMetric(t) {
  if (t.includes("scheduling agreement")) return "sales_scheduling_agreement_in_tons";
  if (t.includes("contract"))            return "sales_contracts_in_tons";
  if (t.includes("inventory") || t.includes("stock level")) return "historic_inventory_12_free_stock_in_tons";
  return "sales_free_stock_in_tons";
}
function baselineFor(metric, t) {
  const h = t.includes("24") || t.includes("two year") ? "24" : "12";
  if (metric.includes("contract"))   return `historic_sales_${h}_contracts_in_tons`;
  if (metric.includes("scheduling")) return `historic_sales_${h}_scheduling_agreement_in_tons`;
  return `historic_sales_${h}_free_stock_in_tons`;
}

export function parseMock(sentence) {
  const t        = sentence.toLowerCase();
  const metric   = pickMetric(t);
  const operator = GT.some((w) => t.includes(w)) ? ">" : LT.some((w) => t.includes(w)) ? "<" : ">";
  const m        = t.match(/(-?\d+(?:\.\d+)?)/);
  const threshold = m ? parseFloat(m[1]) : 0;
  const isPercent = t.includes("%") || t.includes("percent");
  let group_by = [];
  if (t.includes("material")) group_by = ["material"];
  else if (t.includes("plant")) group_by = ["plant"];
  const severity = /critical|urgent|severe/.test(t) ? "critical" : "warning";
  const name     = sentence.length > 48 ? sentence.slice(0, 48) + "…" : sentence;
  return { name, metric, comparison_type: isPercent ? "percent_change" : "absolute", baseline: isPercent ? baselineFor(metric, t) : null, operator, threshold, group_by, severity, detail_label: name, raw_sentence: sentence, active: true };
}

// ── Main LLM parse (two independent calls) ───────────────────────────────
export async function parseWithLLM(sentence) {
  if (!API_KEY) return parseMock(sentence);

  const [structRes, formulaRes] = await Promise.allSettled([
    llmCall(STRUCT_PROMPT,  sentence),
    llmCall(FORMULA_PROMPT, sentence),
  ]);

  // Structured call — required; fall back to mock if it failed
  let structured;
  if (structRes.status === "fulfilled") {
    try {
      structured = normalizeStructured(JSON.parse(extractJson(structRes.value)), sentence);
    } catch (e) {
      console.log("Structured parse failed:", e.message, "→ using mock");
      structured = parseMock(sentence);
    }
  } else {
    console.log("Structured LLM call failed:", structRes.reason?.message, "→ using mock");
    structured = parseMock(sentence);
  }

  // Formula call — optional; never blocks the structured result
  let formula = undefined;
  if (formulaRes.status === "fulfilled") {
    const raw = formulaRes.value;
    formula = extractFormula(raw) ?? undefined;
    console.log("📐 Formula raw response:", JSON.stringify(raw));
    console.log("📐 Formula extracted:", formula ?? "FAILED EXTRACTION");
  } else {
    console.log("Formula LLM call failed:", formulaRes.reason?.message);
  }

  return { ...structured, formula };
}

export async function parseSentence(sentence) {
  if (USE_LLM) return parseWithLLM(sentence);
  return parseMock(sentence);
}

// ── Prompt clarity check ──────────────────────────────────────────────────
const CLARITY_PROMPT = `You check if a user's description is clear enough to build an S&OP supply-chain signal rule.

A valid rule must contain:
1. A metric — e.g. forecast, sales, inventory, stock, contracts, scheduling agreement, historic sales
2. A condition — e.g. above, below, exceeds, less than, greater than, drops, spikes
3. A reference — a number, percentage, or another metric to compare against

Respond ONLY with a JSON object:
- If clear enough: {"clear": true}
- If unclear: {"clear": false, "suggestion": "one short sentence telling the user what to add or clarify"}

Examples of unclear: "flag something", "check the data", "alert me", "bad forecast"
Examples of clear: "flag when forecast exceeds 20% above 12-month historic sales", "alert when inventory drops below 50% of planned sales"`;

export async function checkPromptClarity(sentence) {
  if (!API_KEY) return { clear: true };
  try {
    const text = await llmCall(CLARITY_PROMPT, sentence);
    const json = JSON.parse(extractJson(text));
    return { clear: !!json.clear, suggestion: json.suggestion || null };
  } catch {
    return { clear: true }; // if check fails, let parse proceed
  }
}
