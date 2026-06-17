import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";

import { loadDataFromMongo, getRows } from "./data.js";
import { detectSignals, buildDashboard } from "./signals.js";
import { generateBriefing, generateBriefingLLM } from "./briefing.js";
import { parseSentence } from "./parser.js";
import { suggestActions } from "./suggest.js";
import { buildChatContext, answerQuestion } from "./chat.js";
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
  const rawPage = Number.parseInt(req.query.page, 10);
  const rawPageSize = Number.parseInt(req.query.pageSize, 10);
  const page = Number.isFinite(rawPage) && rawPage >= 0 ? rawPage : 0;
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(rawPageSize, 200) : 100;
  const dash = buildDashboard(signals, rules.filter((r) => r.active !== false).length, {
    page,
    pageSize,
  });
  res.json({
    ...dash,
    briefing: generateBriefing(signals),
    storage: storageBackend(),
  });
});

// --- drill-down: underlying sales orders behind a signal -----------------
// Returns the real historic orders (from `underlying_sales`) for the signal's
// material / plant / sales office, plus a small summary.
app.get("/api/orders", async (req, res) => {
  if (storageBackend() !== "mongo") return res.json({ available: false, summary: null, orders: [] });
  const material = Number(req.query.material);
  const plant = Number(req.query.plant);
  const salesOffice = Number(req.query.sales_office);
  const coll = mongoose.connection.db.collection("underlying_sales");
  const match = {
    material,
    sales_office: salesOffice,
    $or: [{ simulated_plant: plant }, { historic_plant: plant }],
  };

  const orders = await coll
    .find(match, {
      projection: {
        _id: 0, date: 1, customer: 1, recipient_country: 1, recipient_postal_code: 1,
        quantity_in_tons: 1, is_contract: 1, is_scheduling_agreement: 1,
      },
    })
    .sort({ date: -1 })
    .limit(50)
    .toArray();

  const [agg] = await coll
    .aggregate([
      { $match: match },
      { $group: { _id: null, orders: { $sum: 1 }, totalTons: { $sum: "$quantity_in_tons" }, customers: { $addToSet: "$customer" } } },
    ])
    .toArray();

  const byCountry = await coll
    .aggregate([
      { $match: match },
      { $group: { _id: "$recipient_country", tons: { $sum: "$quantity_in_tons" } } },
      { $sort: { tons: -1 } },
      { $limit: 5 },
    ])
    .toArray();

  res.json({
    available: true,
    summary: agg
      ? { orders: agg.orders, totalTons: agg.totalTons, customers: agg.customers.length }
      : { orders: 0, totalTons: 0, customers: 0 },
    byCountry: byCountry.map((c) => ({ country: c._id, tons: c.tons })),
    orders,
  });
});

// --- natural language -> rule draft -------------------------------------
app.post("/api/parse", async (req, res) => {
  const { sentence } = req.body;
  if (!sentence) return res.status(400).json({ error: "sentence required" });
  res.json(await parseSentence(sentence));
});

// --- AI briefing: LLM executive summary of the current signals (on demand) ---
app.get("/api/briefing", async (_req, res) => {
  const rules = await listRules();
  const signals = detectSignals(getRows(), rules);
  res.json({ briefing: await generateBriefingLLM(signals) });
});

// --- AI chatbot: answer questions grounded in the live data context ----------
app.post("/api/chat", async (req, res) => {
  const { question, history } = req.body || {};
  if (!question) return res.status(400).json({ error: "question required" });
  const rules = await listRules();
  const signals = detectSignals(getRows(), rules);
  const context = buildChatContext(getRows(), signals, rules);
  res.json({ answer: await answerQuestion(question, context, history || []) });
});

// --- AI suggested actions for one signal, grounded in its underlying orders ---
app.post("/api/suggest", async (req, res) => {
  const signal = req.body || {};
  let orderSummary = null;
  if (storageBackend() === "mongo" && signal.material != null) {
    const coll = mongoose.connection.db.collection("underlying_sales");
    const match = {
      material: Number(signal.material),
      sales_office: Number(signal.salesOffice),
      $or: [{ simulated_plant: Number(signal.plant) }, { historic_plant: Number(signal.plant) }],
    };
    const [agg] = await coll
      .aggregate([
        { $match: match },
        { $group: { _id: null, orders: { $sum: 1 }, totalTons: { $sum: "$quantity_in_tons" }, customers: { $addToSet: "$customer" } } },
      ])
      .toArray();
    if (agg) orderSummary = { orders: agg.orders, totalTons: agg.totalTons, customers: agg.customers.length };
  }
  res.json({ actions: await suggestActions(signal, orderSummary) });
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
  // MongoDB Atlas is required — no CSV fallback.
  if (storageBackend() !== "mongo") {
    console.error("❌ Cannot start: MongoDB is required but not reachable. Check MONGO_URI / network access.");
    process.exit(1);
  }
  await loadDataFromMongo();
  app.listen(PORT, () => console.log(`API ready on http://localhost:${PORT}`));
}
start();
