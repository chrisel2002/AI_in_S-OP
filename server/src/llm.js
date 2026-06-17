// Shared UniGPT (OpenAI-compatible) helper used by the briefing and suggestion
// features. Has a hard timeout so a slow API can never hang a request.
const BASE_URL = process.env.UNIGPT_BASE_URL || "https://gpt.uni-muenster.de/v1";
const API_KEY = process.env.UNIGPT_API_KEY;
const MODEL = process.env.UNIGPT_MODEL || "mistral-small";

export const llmEnabled = () => process.env.USE_LLM !== "false" && Boolean(API_KEY);

export async function chatLLM(messages, { temperature = 0.4, timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, temperature, messages }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`UniGPT HTTP ${res.status}`);
    const data = await res.json();
    return (data?.choices?.[0]?.message?.content ?? "").trim();
  } finally {
    clearTimeout(timer);
  }
}
