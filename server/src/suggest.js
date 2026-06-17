// Generates contextual "what should the planner do" actions for a single signal,
// grounded in the signal details + a summary of the real underlying orders.
// Returns null if the LLM is off/fails, so the UI falls back to the templated actions.
import { chatLLM, llmEnabled } from "./llm.js";

export async function suggestActions(signal, orderSummary) {
  if (!llmEnabled()) return null;
  const ctx =
    orderSummary && orderSummary.orders
      ? `Underlying historic orders: ${orderSummary.orders} orders, ${Number(orderSummary.totalTons).toFixed(1)} tons total across ${orderSummary.customers} customers.`
      : "No underlying order history available.";
  try {
    return await chatLLM(
      [
        {
          role: "system",
          content:
            "You are an assistant to a Sales & Operations Planning (S&OP) planner. Given one demand-plan signal, propose exactly 3 concrete, specific actions the planner could take this week. Number them 1-3, one short line each. No preamble, no closing remarks.",
        },
        {
          role: "user",
          content: `Signal type: ${signal.type}\nMaterial: ${signal.material}, plant: ${signal.plant}, sales office: ${signal.salesOffice}, month: ${signal.month}\nDetail: ${signal.detail}\nReasoning: ${signal.reasoning}\n${ctx}`,
        },
      ],
      { temperature: 0.5 }
    );
  } catch (e) {
    console.log("suggest LLM failed:", e.message);
    return null;
  }
}
