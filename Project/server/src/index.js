import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";

import { loadDataFromMongo, getRows } from "./data.js";
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

  // Detect signals for ALL rules (built-in + custom) — full dataset
  const allSignals = detectSignals(getRows(), rules);

  const rawPage = Number.parseInt(req.query.page, 10);
  const rawPageSize = Number.parseInt(req.query.pageSize, 10);
  const page = Number.isFinite(rawPage) && rawPage >= 0 ? rawPage : 0;
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(rawPageSize, 200) : 100;

  // Optional type filter — applied AFTER detecting all signals so byType stays complete
  const typeFilter = (req.query.type || "").trim();
  const filteredSignals = typeFilter && typeFilter !== "all"
    ? allSignals.filter((s) => s.type === typeFilter)
    : allSignals;

  const dash = buildDashboard(filteredSignals, rules.filter((r) => r.active !== false).length, {
    page,
    pageSize,
    allSignals, // always pass full set so byType / KPI totals are correct
  });

  res.json({
    ...dash,
    briefing: generateBriefing(allSignals),
    storage: storageBackend(),
  });
});

// --- drill-down: underlying sales orders behind a signal -----------------
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

app.post("/api/rules", async (req, res) => {
  try {
    const rule = await insertRule(req.body);
    console.log("✅ Rule saved to DB:", JSON.stringify(rule));
    res.json(rule);
  } catch (e) {
    console.error("❌ Rule save failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/rules/:id", async (req, res) => res.json(await updateRule(req.params.id, req.body)));

app.delete("/api/rules/:id", async (req, res) => {
  await deleteRule(req.params.id);
  res.json({ ok: true });
});


// --- debug: inspect rules + signal counts in real time ------------------
app.get("/api/debug", async (req, res) => {
  const rules = await listRules();
  const rows = getRows();
  const allSignals = detectSignals(rows, rules);

  const ruleDebug = rules.map((rule) => {
    const hits = allSignals.filter((s) => s.type === rule.name);
    return {
      _id: rule._id,
      name: rule.name,
      metric: rule.metric,
      comparison_type: rule.comparison_type,
      baseline: rule.baseline,
      operator: rule.operator,
      threshold: rule.threshold,
      severity: rule.severity,
      active: rule.active,
      signalCount: hits.length,
      sampleDetail: hits[0]?.detail || null,
    };
  });

  res.json({
    totalRows: rows.length,
    totalSignals: allSignals.length,
    byType: allSignals.reduce((acc, s) => { acc[s.type] = (acc[s.type] || 0) + 1; return acc; }, {}),
    rules: ruleDebug,
  });
});


// --- migrate: fix rules that have label-based baselines or wrong metric/threshold ---
async function migrateRules() {
  const rules = await listRules();
  const LABEL_TO_COL = {
    "Forecast sales (free stock)": "sales_free_stock_in_tons",
    "Forecast sales (contracts)": "sales_contracts_in_tons",
    "Forecast sales (scheduling agreement)": "sales_scheduling_agreement_in_tons",
    "Inventory 12mo (free stock)": "historic_inventory_12_free_stock_in_tons",
    "Historic sales 12mo (free stock)": "historic_sales_12_free_stock_in_tons",
    "Historic sales 24mo (free stock)": "historic_sales_24_free_stock_in_tons",
  };
  const VALID_COLS = new Set(Object.values(LABEL_TO_COL));

  for (const rule of rules) {
    const patch = {};

    // Fix baseline: label → column key
    if (rule.baseline && LABEL_TO_COL[rule.baseline]) {
      patch.baseline = LABEL_TO_COL[rule.baseline];
      console.log(`🔧 Fix baseline for "${rule.name}": "${rule.baseline}" → "${patch.baseline}"`);
    }

    // Fix metric: label → column key
    if (rule.metric && LABEL_TO_COL[rule.metric]) {
      patch.metric = LABEL_TO_COL[rule.metric];
      console.log(`🔧 Fix metric for "${rule.name}": "${rule.metric}" → "${patch.metric}"`);
    }

    // Fix threshold stored as string
    if (typeof rule.threshold === "string") {
      patch.threshold = parseFloat(rule.threshold) || 0;
      console.log(`🔧 Fix threshold for "${rule.name}": "${rule.threshold}" → ${patch.threshold}`);
    }

    // Ensure active is set
    if (rule.active === undefined || rule.active === null) {
      patch.active = true;
    }

    if (Object.keys(patch).length > 0) {
      await updateRule(rule._id, { ...rule, ...patch });
      console.log(`✅ Migrated rule "${rule.name}"`);
    }
  }
  console.log(`✅ Rule migration complete (${rules.length} rules checked)`);
}

// --- boot ---------------------------------------------------------------
async function start() {
  await initStore(MONGO_URI);
  if (storageBackend() !== "mongo") {
    console.error("❌ Cannot start: MongoDB is required but not reachable. Check MONGO_URI / network access.");
    process.exit(1);
  }
  await loadDataFromMongo();
  await migrateRules();
  app.listen(PORT, () => console.log(`API ready on http://localhost:${PORT}`));
}
start();
