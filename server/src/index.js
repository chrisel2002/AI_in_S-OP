import "dotenv/config";
import express from "express";
import cors from "cors";

import { loadData, loadDataFromMongo, getRows } from "./data.js";
import { detectSignals, buildDashboard } from "./signals.js";
import { generateBriefing } from "./briefing.js";
import { parseSentence } from "./parser.js";
import {
  initStore,
  storageBackend,
  listRules,
  insertRule,
  updateRule,
  deleteRule,
} from "./store.js";

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/sop";

const app = express();
app.use(cors());
app.use(express.json());

// --- dashboard: signals + KPIs + briefing -------------------------------
app.get("/api/dashboard", async (req, res) => {
  const rules = await listRules();
  const signals = detectSignals(getRows(), rules);
  const dash = buildDashboard(signals, rules.filter((r) => r.active !== false).length);
  res.json({
    ...dash,
    briefing: generateBriefing(signals),
    storage: storageBackend(),
  });
});

// --- natural language -> rule draft -------------------------------------
app.post("/api/parse", (req, res) => {
  const { sentence } = req.body;
  if (!sentence) return res.status(400).json({ error: "sentence required" });
  res.json(parseSentence(sentence));
});

// --- rule CRUD ----------------------------------------------------------
app.get("/api/rules", async (_req, res) => res.json(await listRules()));
app.post("/api/rules", async (req, res) => res.json(await insertRule(req.body)));
app.put("/api/rules/:id", async (req, res) => res.json(await updateRule(req.params.id, req.body)));
app.delete("/api/rules/:id", async (req, res) => {
  await deleteRule(req.params.id);
  res.json({ ok: true });
});

// --- boot ---------------------------------------------------------------
async function start() {
  await initStore(MONGO_URI);
  // prefer reading the plan data from Atlas; fall back to the CSV if Mongo is down
  if (storageBackend() === "mongo") {
    try {
      await loadDataFromMongo();
    } catch (e) {
      console.log("Mongo data load failed, using CSV instead:", e.message);
      loadData();
    }
  } else {
    loadData();
  }
  app.listen(PORT, () => console.log(`API ready on http://localhost:${PORT}`));
}
start();
