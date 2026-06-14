// Generates the narrative "AI briefing" from the top signals.
// Currently a deterministic template; swap to an LLM summary later for richer prose.
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
