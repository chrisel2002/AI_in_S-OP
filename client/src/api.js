const json = (r) => r.json();

export const getDashboard = ({ page = 0, pageSize = 100, type = "" } = {}) => {
  
  const params = new URLSearchParams({ page, pageSize });
  if (type && type !== "all") params.set("type", type);
  return fetch(`/api/dashboard?${params}`).then(json);
};

export const getRules = () => fetch("/api/rules").then(json);

export const getOrders = ({ material, plant, salesOffice }) =>
  fetch(`/api/orders?material=${material}&plant=${plant}&sales_office=${salesOffice}`).then(json);

export const validatePrompt = (sentence) =>
  fetch("/api/validate-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sentence }),
  }).then(json);

export const parseSentence = (sentence) =>
  fetch("/api/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sentence }),
  }).then(json);

export const createRule = (rule) =>
  fetch("/api/rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rule),
  }).then(json);

export const updateRule = (id, rule) =>
  fetch(`/api/rules/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rule),
  }).then(json);

export const deleteRule = (id) => fetch(`/api/rules/${id}`, { method: "DELETE" }).then(json);

// AI: LLM-generated executive briefing of the current signals (on demand)
export const getAiBriefing = () => fetch("/api/briefing").then(json);

// AI: contextual suggested actions for one signal
export const suggestActions = (signal) =>
  fetch("/api/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signal),
  }).then(json);

// AI: chatbot answering questions grounded in the live data
export const askChat = (question, history) =>
  fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history }),
  }).then(json);

// Signal status tracking
export const getSignalStatuses = () => fetch("/api/signal-status").then(json);

export const setSignalStatus = (key, status, note = null) =>
  fetch(`/api/signal-status/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, note }),
  }).then(json);

export const clearSignalStatus = (key) =>
  fetch(`/api/signal-status/${encodeURIComponent(key)}`, { method: "DELETE" }).then(json);

// All signals unpaginated — for CSV export
export const getAllSignals = (type = "") => {
  const params = new URLSearchParams();
  if (type && type !== "all") params.set("type", type);
  return fetch(`/api/signals?${params}`).then(json);
};

// Save edited planning values and get the recalculated signal back
export const updateSignal = (id, changes) =>
  fetch(`/api/dashboard/signals/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  }).then(json);

// AI recommendations for one signal row (keyed by MongoDB _id)
export const getAiRecommendations = (id) =>
  fetch(`/api/dashboard/signals/${id}/ai-recommendations`, {
    method: "POST",
  }).then(json);