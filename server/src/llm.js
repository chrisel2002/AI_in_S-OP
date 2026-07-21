// Shared UniGPT (OpenAI-compatible) helper used by the briefing and suggestion
// features. Has a hard timeout so a slow API can never hang a request.
const BASE_URL = process.env.UNIGPT_BASE_URL || "https://gpt.uni-muenster.de/v1";
const API_KEY = process.env.UNIGPT_API_KEY;
const MODEL = process.env.UNIGPT_MODEL || "mistral-small";

export const llmEnabled = () => process.env.USE_LLM !== "false" && Boolean(API_KEY);

async function doFetch(body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`UniGPT HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function chatLLM(messages, { temperature = 0.4, timeoutMs = 25000 } = {}) {
  const data = await doFetch({ model: MODEL, temperature, messages }, timeoutMs);
  return (data?.choices?.[0]?.message?.content ?? "").trim();
}

// Returns the full choice object so callers can inspect finish_reason and tool_calls.
export async function chatLLMWithTools(messages, tools, { temperature = 0.3, timeoutMs = 30000 } = {}) {
  const data = await doFetch({ model: MODEL, temperature, messages, tools, tool_choice: "auto" }, timeoutMs);
  const choice = data?.choices?.[0];
  return {
    message: choice?.message ?? { role: "assistant", content: "" },
    finish_reason: choice?.finish_reason ?? "stop",
    content: (choice?.message?.content ?? "").trim(),
    tool_calls: choice?.message?.tool_calls ?? [],
  };
}
