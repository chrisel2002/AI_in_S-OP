// "Ask the assistant" — answers questions grounded ONLY in a compact context
// bundle built from the live data (signals, KPIs, aggregates). Keeps the model
// from hallucinating: if it's not in the context, it should say so.
import { chatLLM, llmEnabled } from "./llm.js";

const topN = (map, n) => Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);

export function buildChatContext(rows, signals, rules) {
  const materials = new Set(), plants = new Set(), offices = new Set();
  let totalForecast = 0;
  const byMaterial = {}, byPlant = {};
  for (const r of rows) {
    materials.add(r.material);
    plants.add(r.plant);
    offices.add(r.sales_office);
    const f = r.sales_free_stock_in_tons || 0;
    totalForecast += f;
    byMaterial[r.material] = (byMaterial[r.material] || 0) + f;
    byPlant[r.plant] = (byPlant[r.plant] || 0) + f;
  }
  // group signals by type so EVERY type has concrete examples in the context
  const byTypeSignals = {};
  for (const s of signals) (byTypeSignals[s.type] ||= []).push(s);

  const typeSections = Object.entries(byTypeSignals).map(([type, list]) => {
    const examples = list
      .slice(0, 6)
      .map((s) => `    - material ${s.material}, plant ${s.plant}, sales office ${s.salesOffice}, ${s.month}, score ${s.score}: ${s.detail}`)
      .join("\n");
    return `  ${type} — ${list.length} signal(s):\n${examples}`;
  });

  const lines = [
    `Dataset: ${rows.length} monthly plan rows; ${materials.size} materials, ${plants.size} plants, ${offices.size} sales offices; horizon 2026-06 to 2027-05.`,
    `Total planned free-stock forecast across the horizon: ${totalForecast.toFixed(1)} tons.`,
    `Signals this cycle: ${signals.length} total (${signals.filter((s) => s.score >= 8).length} high severity).`,
    `Active custom rules: ${rules.filter((r) => r.active !== false).map((r) => r.name).join("; ") || "none"}.`,
    `Top materials by total forecast (tons): ${topN(byMaterial, 8).map(([m, v]) => `${m}=${v.toFixed(1)}`).join(", ")}.`,
    `Top plants by total forecast (tons): ${topN(byPlant, 6).map(([p, v]) => `${p}=${v.toFixed(1)}`).join(", ")}.`,
    ``,
    `SIGNALS BY TYPE (real examples — cite these specific materials/plants/months):`,
    ...typeSections,
  ];
  return lines.join("\n");
}

export async function answerQuestion(question, context, history = [], salesAnalysis = null) {
  if (!llmEnabled()) return "The AI assistant is currently disabled (no API key configured).";

  const salesInstructions = salesAnalysis
    ? " A SALES ANALYSIS section is provided below, computed directly by the backend from order-level records (underlying_sales) and planning data (sales_operations_tool). Use it to answer any question the data supports — you do not need to restrict yourself to specific question types. Only use the customers, countries, quantities, shares, materials and sales offices that literally appear in it; never invent or extrapolate beyond the numbers given. Never combine findings from two different rows into a single confirmed story unless they share the exact same material AND sales office. " +
      "Confidence language rules: use 'CONFIRMED' or strong language only when the section text says so at the exact same material+sales office. Use 'appears to be', 'may indicate', 'likely associated' for causal claims about forecast increases (the backend measures order-share, not causal contribution to the increase). For 'low-volume' findings, use softer language ('a small amount of data suggests…') regardless of how large the percentage looks. When a row is marked as a limitation or caveat, repeat it faithfully — do not drop it. " +
      "Matching note: data is joined by material + sales office + period + sales type; plant was not used. State this when relevant. " +
      "For LOST/DORMANT CUSTOMERS: these have zero recent demand by definition — never add a 'recent tons' or 'recent share' column. For RETAINED CUSTOMERS: show both historical and recent figures as provided. " +
      "If the SALES ANALYSIS does not contain data that would answer the user's question, say so plainly rather than guessing."
    : "";
  const salesBlock = salesAnalysis ? `\n\nSALES ANALYSIS (backend-calculated):\n${salesAnalysis}` : "";

  const messages = [
    {
      role: "system",
      content:
        "You are an analyst assistant for a Sales & Operations Planning (S&OP) dashboard. " +
        "Every answer MUST be specific to the DATA CONTEXT below — cite the actual signal types, material numbers, plant numbers, months and figures from it. Do NOT invent materials, plants, or numbers that aren't present, and do NOT give generic textbook advice that isn't tied to a specific signal in the context. " +
        "When asked what to do or for suggestions, recommend concrete S&OP actions, but anchor each one to a specific signal or material/plant from the context (e.g. 'validate the +2357% surge on material 11681 at plant 28 with sales'). Match the recommendation to the signal TYPE: stockout-risk questions must use the Stockout risk signals listed, demand questions the Demand surge/drop signals, etc. — do not mix types. " +
        "Never give a generic follow-up like 'check demand and validate with sales' — name the specific customer, material, and sales office involved (e.g. 'validate whether customer 2102231's recent demand for material 11696 in sales office 76 is recurring or a one-time order'). Use cautious language ('appears to', 'may indicate', 'cannot confirm', 'material-level indication only') unless the evidence is a confirmed same material+sales-office match with meaningful volume — only then use stronger language. " +
        "If a detail the user asks about isn't in the context, say you don't have it in the current view. Keep answers focused. " +
        "FORMAT: Use markdown in your responses. When listing multiple items with comparable fields (materials, signals, customers, etc.), use a markdown table with clear column headers — this is strongly preferred over bullet lists for tabular data. Use **bold** for key numbers, material IDs, and important terms. Use bullet lists only for non-tabular action items or short enumerations. Keep responses concise and scannable. " +
        "If the SALES ANALYSIS text notes that the underlying-order volume is small relative to the signal's forecast volume, repeat that limitation/low-volume caveat rather than dropping it. " +
        "When a row is marked 'low-volume', its percentage or share figures must be treated as the LEAST confident evidence in your answer, regardless of how large the percentage looks — use softer language for it (e.g. 'a small amount of data suggests...', 'not a reliable pattern given the volume') even if a non-low-volume row in the same table uses stronger language like 'appears to be' or 'likely'. Never let a low-volume finding sound more confident than a non-low-volume finding in the same answer. " +
        "When rendering a LOST/DORMANT CUSTOMERS table, these customers have ZERO recent demand by definition — never invent or show a 'Recent Share' or 'Recent tons' column for them, since that value does not exist and would be misleading. Valid columns for that section are only: Customer ID, Historical Tons, Historical Share (% of historical demand), and a low-volume flag if present. Do not restructure any SALES ANALYSIS section into a table with columns that weren't part of the original computed data — only use the exact fields the backend actually provided. " +
        "If the user asks HOW a finding in the SALES ANALYSIS section was determined (e.g. 'how do you know this', 'how was this calculated', 'what data shows this'), explain the REAL methodology: the backend directly queries actual order-level records for the relevant time period and checks whether that specific customer/material/country has matching orders. A 'lost customer' finding specifically means the query returned zero matching orders for that customer in the recent period — this is a direct database check, not an inference from signals, rules, or forecasts. This same rule applies to ANY SALES ANALYSIS finding, not only lost customers: if asked how a concentration, new-customer, geographic, or forecast-change figure was determined, explain that it comes from direct calculation over order-level (underlying_sales) or planning (sales_operations_tool) records — never attribute any SALES ANALYSIS finding to 'signals' or 'rules', since those are a separate system. If you are unsure of the exact methodology behind something, say so plainly rather than inventing a plausible-sounding explanation. " +
        " If the user asks about the exact date range used ('which time period', 'what dates', 'how do you define recent vs historical'), look for the 'Recent period: ... Historical comparison period: ...' line included in the SALES ANALYSIS section — it states the exact dates and the fixed window lengths (3 months recent, 12 months historical comparison). State this directly rather than saying the information is unavailable, since it is always included whenever a SALES ANALYSIS section is present." +
        " This 'not an inference from signals/rules' clarification is for YOUR OWN reasoning only — only say it explicitly to the user if they specifically ask HOW something was determined or  where the data came from. In a normal answer that isn't questioning your methodology, just state the finding plainly without this caveat." +
        salesInstructions +
        "\n\nDATA CONTEXT:\n" + context + salesBlock,
    },
    ...history.slice(-6),
    { role: "user", content: question },
  ];
  try {
    const answer = (await chatLLM(messages, { temperature: 0.3 })) || "I couldn't generate an answer.";
    // Don't rely on the model to remember the matching disclosure every time —
    // append it deterministically whenever the sales analysis was actually used.
    if (salesAnalysis && !/sales office/i.test(answer)) {
      return `${answer}\n\n(This analysis matched by material, sales office, period, and sales type — plant was not used, since plant mapping differs between the planning and order-level collections.)`;
    }
    return answer;
  } catch (e) {
    console.log("chat LLM failed:", e.message);
    return "Sorry, the assistant is unavailable right now.";
  }
}