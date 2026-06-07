// Thin wrapper around the backend REST API. The Vite dev server proxies /api -> :4000.
const json = (r) => r.json();

export const getDashboard = () => fetch("/api/dashboard").then(json);
export const getRules = () => fetch("/api/rules").then(json);

export const getOrders = ({ material, plant, salesOffice }) =>
  fetch(`/api/orders?material=${material}&plant=${plant}&sales_office=${salesOffice}`).then(json);

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
