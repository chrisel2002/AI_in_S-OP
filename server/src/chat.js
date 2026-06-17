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
    `Signals this cycle: ${signals.length} total (${signals.filter((s) => s.score > 80).length} critical).`,
    `Active custom rules: ${rules.filter((r) => r.active !== false).map((r) => r.name).join("; ") || "none"}.`,
    `Top materials by total forecast (tons): ${topN(byMaterial, 8).map(([m, v]) => `${m}=${v.toFixed(1)}`).join(", ")}.`,
    `Top plants by total forecast (tons): ${topN(byPlant, 6).map(([p, v]) => `${p}=${v.toFixed(1)}`).join(", ")}.`,
    ``,
    `SIGNALS BY TYPE (real examples — cite these specific materials/plants/months):`,
    ...typeSections,
  ];
  return lines.join("\n");
}

export async function answerQuestion(question, context, history = []) {
  if (!llmEnabled()) return "The AI assistant is currently disabled (no API key configured).";
  const messages = [
    {
      role: "system",
      content:
        "You are an analyst assistant for a Sales & Operations Planning (S&OP) dashboard. " +
        "Every answer MUST be specific to the DATA CONTEXT below — cite the actual signal types, material numbers, plant numbers, months and figures from it. Do NOT invent materials, plants, or numbers that aren't present, and do NOT give generic textbook advice that isn't tied to a specific signal in the context. " +
        "When asked what to do or for suggestions, recommend concrete S&OP actions, but anchor each one to a specific signal or material/plant from the context (e.g. 'validate the +2357% surge on material 11681 at plant 28 with sales'). Match the recommendation to the signal TYPE: stockout-risk questions must use the Stockout risk signals listed, demand questions the Demand surge/drop signals, etc. — do not mix types. " +
        "If a detail the user asks about isn't in the context, say you don't have it in the current view. Keep answers focused.\n\nDATA CONTEXT:\n" +
        context,
    },
    ...history.slice(-6),
    { role: "user", content: question },
  ];
  try {
    return (await chatLLM(messages, { temperature: 0.3 })) || "I couldn't generate an answer.";
  } catch (e) {
    console.log("chat LLM failed:", e.message);
    return "Sorry, the assistant is unavailable right now.";
  }
}
