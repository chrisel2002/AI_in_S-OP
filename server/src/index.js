import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";

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
