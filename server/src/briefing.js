import { chatLLM, llmEnabled } from "./llm.js";

// Generates the narrative briefing from the top signals.
// generateBriefing() = fast deterministic template (used on dashboard load + as fallback).
// generateBriefingLLM() = richer LLM prose (used on demand via the "Regenerate" button).
export function generateBriefing(signals) {
  if (!signals.length) {
    return "No signals detected this cycle. All demand plans are within tolerance versus the 12-month actuals.";
  }
  const critical = signals.filter((s) => s.score > 80).length;
  const medium = signals.filter((s) => s.score >= 50 && s.score <= 80).length;
  const top = signals.slice(0, 3).map(
    (s) => `${s.type} on material ${s.material} / plant ${s.plant} (${s.detail})`
  );
  return (
    `${critical} critical and ${medium} medium signals require attention this cycle. ` +
    `Top items: ${top.join("; ")}. Open each signal for reasoning and suggested actions.`
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
          "You are an S&OP planning analyst. Write a concise executive briefing (3-4 sentences, plain prose, no markdown, no bullet lists) for the weekly Sales & Operations Planning meeting. Summarise the most important demand-plan signals and what the team should focus on.",
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
