// Agentic chat: the LLM can call query_database() as many times as it needs
// (up to MAX_ITERATIONS) before producing a final answer. This lets it answer
// any data question without pre-coded intent detection.
import { chatLLM, chatLLMWithTools, llmEnabled } from "./llm.js";
import { runQuery, QUERY_TOOL } from "./queryTool.js";

const MAX_ITERATIONS = 5;   // max tool-call rounds before forcing a final answer
const MAX_TOOL_RESULT_CHARS = 6000; // truncate large results before feeding back

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

function buildSystemPrompt(context, salesAnalysis) {
  return `You are an analyst assistant for a Sales & Operations Planning (S&OP) dashboard at ThyssenKrupp.

You have access to a query_database tool that runs MongoDB aggregation pipelines against the live database. Use it freely whenever you need specific numbers, trends, rankings, or comparisons that aren't already in the context below. You can call it multiple times in sequence — e.g. run a broad query first, see the results, then refine.

TOOL USAGE GUIDELINES:
- Always prefer $group + $sum / $avg / $count over returning raw rows.
- Add { $sort: { <field>: -1 } }, { $limit: N } to get top-N results.
- Dates in underlying_sales are ISODate objects — use ISO strings in comparisons: { $gte: new Date("2025-01-01") }.
- If a query returns cappedAt: 100, your grouping isn't specific enough — add more $group keys or narrow the $match.
- If a query errors, try a simpler version or a different approach and explain what you tried.
- Never fabricate numbers — only cite figures that came from the pre-computed context or from tool results you actually received.

ANSWER FORMAT:
- Use markdown. Tables for comparable data, bold for key numbers.
- Cite the actual material/plant/sales-office/customer IDs from results — never generic examples.
- If the data genuinely can't answer the question, say so clearly.

DATA CONTEXT (pre-computed summary — always available):
${context}
${salesAnalysis ? `\nSALES ANALYSIS (pre-computed from order-level + planning data):\n${salesAnalysis}` : ""}`;
}

export async function answerQuestion(question, context, history = [], salesAnalysis = null) {
  if (!llmEnabled()) return "The AI assistant is currently disabled (no API key configured).";

  const systemPrompt = buildSystemPrompt(context, salesAnalysis);
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-6),
    { role: "user", content: question },
  ];

  // Agentic loop — keep going while the model wants to call tools.
  const thread = [...messages];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let response;
    try {
      response = await chatLLMWithTools(thread, [QUERY_TOOL]);
    } catch (e) {
      console.log("chatLLMWithTools failed:", e.message);
      // Fall back to plain completion without tools.
      try {
        return (await chatLLM(thread)) || "Sorry, the assistant is unavailable right now.";
      } catch {
        return "Sorry, the assistant is unavailable right now.";
      }
    }

    // Model is done — return the final text.
    if (response.finish_reason !== "tool_calls" || !response.tool_calls.length) {
      return response.content || "I couldn't generate an answer.";
    }

    // Append the assistant message (with tool_calls) to the thread.
    thread.push(response.message);

    // Execute each tool call and append results.
    for (const toolCall of response.tool_calls) {
      let resultText;
      try {
        const args = JSON.parse(toolCall.function.arguments || "{}");
        const result = await runQuery(args.collection, args.pipeline);
        resultText = JSON.stringify(result, null, 2);
        if (resultText.length > MAX_TOOL_RESULT_CHARS) {
          resultText = resultText.slice(0, MAX_TOOL_RESULT_CHARS) +
            "\n... (truncated — results exceeded limit; refine your aggregation to reduce output)";
        }
      } catch (err) {
        resultText = JSON.stringify({ error: err.message, hint: "Check collection name, pipeline syntax, and field names." });
      }
      thread.push({ role: "tool", tool_call_id: toolCall.id, content: resultText });
      console.log(`[chat tool] query_database → ${resultText.slice(0, 120).replace(/\n/g, " ")}…`);
    }
  }

  // Hit iteration cap — ask for a final summary without tools.
  thread.push({ role: "user", content: "Please summarise your findings so far and give a final answer." });
  try {
    return (await chatLLM(thread)) || "I couldn't generate a final answer after multiple queries.";
  } catch {
    return "I couldn't generate a final answer after multiple queries.";
  }
}
