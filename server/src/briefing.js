import { chatLLM, llmEnabled } from "./llm.js";

// Generates the narrative briefing from the top signals.
// generateBriefing() = fast deterministic template (used on dashboard load + as fallback).
// generateBriefingLLM() = richer LLM prose (used on demand via the "Regenerate" button).
export function generateBriefing(signals) {
  if (!signals.length) {
    return "No signals detected this cycle.\nAll demand plans are within tolerance versus the 12-month actuals.";
  }
  const critical = signals.filter((s) => s.score > 80).length;
  const medium = signals.filter((s) => s.score >= 50 && s.score <= 80).length;
  const top = signals.slice(0, 3);
  const topLines = top
    .map((s) => `  • ${s.type} — Material ${s.material}, Plant ${s.plant}\n    ${s.detail}`)
    .join("\n\n");
  return (
    `This cycle has ${critical} critical and ${medium} medium demand planning signals.\n\n` +
    `Top signals:\n${topLines}\n\n` +
    `Open any signal row below for full reasoning and suggested actions.`
  );
}

export async function generateBriefingLLM(signals) {
  if (!llmEnabled() || !signals.length) return generateBriefing(signals);
  const critical = signals.filter((s) => s.score > 80).length;
  const medium = signals.filter((s) => s.score >= 50 && s.score <= 80).length;
  const top = signals
    .slice(0, 8)
    .map((s) => `- ${s.type}: material ${s.material}, plant ${s.plant}, ${s.month}, score ${s.score} (${s.detail})`)
    .join("\n");
  try {
    const text = await chatLLM([
      {
        role: "system",
        content:
          "You are an S&OP planning analyst writing a briefing for the weekly Sales & Operations Planning meeting. " +
          "Use this exact format — plain text, no markdown:\n\n" +
          "Line 1: One sentence summarising the overall situation.\n\n" +
          "Then 2-3 focus points, each on its own line starting with '• '.\n" +
          "Each point names the issue, why it matters, and what the team should do.\n\n" +
          "CRITICAL — referencing signals: each focus point must call out ONE specific signal, " +
          "and you must refer to it using the EXACT phrase \"Material <material>, Plant <plant>\" " +
          "(e.g. \"Material 11681, Plant 28\"), copying the material and plant numbers verbatim from " +
          "the signal list below. The dashboard turns this exact phrase into a clickable link, so it " +
          "must match character-for-character: always one material and one plant, comma-separated, no " +
          "ranges, no 'plants 28 and 30', no lists of materials. If two signals matter, write two " +
          "separate focus points.\n\n" +
          "Keep it practical, specific, and under 90 words total.",
      },
      {
        role: "user",
        content: `This cycle: ${signals.length} signals (${critical} critical, ${medium} medium).\nTop signals:\n${top}`,
      },
    ]);
    return text || generateBriefing(signals);
  } catch (e) {
    console.log("briefing LLM failed, using template:", e.message);
    return generateBriefing(signals);
  }
}
