import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";

import { loadDataFromMongo, getRows } from "./data.js";
import { detectSignals, buildDashboard } from "./signals.js";
import { generateBriefing, generateBriefingLLM } from "./briefing.js";
import { parseSentence, checkPromptClarity } from "./parser.js";
import { getAllStatuses, upsertStatus, removeStatus } from "./status.js";
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
// app.get("/api/dashboard", async (req, res) => {
//   const rules = await listRules();
//   const signals = detectSignals(getRows(), rules);
//   const rawPage = Number.parseInt(req.query.page, 10);
//   const rawPageSize = Number.parseInt(req.query.pageSize, 10);
//   const page = Number.isFinite(rawPage) && rawPage >= 0 ? rawPage : 0;
//   const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(rawPageSize, 200) : 100;

//   // Optional type filter — applied AFTER detecting all signals so byType stays complete
//   const typeFilter = (req.query.type || "").trim();
//   const filteredSignals = typeFilter && typeFilter !== "all"
//     ? allSignals.filter((s) => s.type === typeFilter)
//     : allSignals;

//   const dash = buildDashboard(filteredSignals, rules.filter((r) => r.active !== false).length, {
//     page,
//     pageSize,
//     allSignals, // always pass full set so byType / KPI totals are correct
//   });

//   res.json({
//     ...dash,
//     briefing: generateBriefing(allSignals),
//     storage: storageBackend(),
//   });
// });
// ✅ FIXED
app.get("/api/dashboard", async (req, res) => {
  const rules = await listRules();
  const allSignals = detectSignals(getRows(), rules);  // ← rename to allSignals
  const rawPage = Number.parseInt(req.query.page, 10);
  const rawPageSize = Number.parseInt(req.query.pageSize, 10);
  const page = Number.isFinite(rawPage) && rawPage >= 0 ? rawPage : 0;
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(rawPageSize, 200) : 100;

  const typeFilter = (req.query.type || "").trim();
  const filteredSignals = typeFilter && typeFilter !== "all"
    ? allSignals.filter((s) => s.type === typeFilter)
    : allSignals;

  const dash = buildDashboard(filteredSignals, rules.filter((r) => r.active !== false).length, {
    page,
    pageSize,
    allSignals,
  });

  res.json({
    ...dash,
    briefing: generateBriefing(allSignals),
    topSignals: allSignals.slice(0, 5),
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

// --- prompt clarity check (before full parse) ---------------------------
app.post("/api/validate-prompt", async (req, res) => {
  const { sentence } = req.body;
  if (!sentence) return res.status(400).json({ clear: false, suggestion: "Please enter a rule description." });
  res.json(await checkPromptClarity(sentence));
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

// --- signal status CRUD -------------------------------------------------
app.get("/api/signal-status", async (_req, res) => res.json(await getAllStatuses()));

app.put("/api/signal-status/:key", async (req, res) => {
  await upsertStatus(decodeURIComponent(req.params.key), req.body);
  res.json({ ok: true });
});

app.delete("/api/signal-status/:key", async (req, res) => {
  await removeStatus(decodeURIComponent(req.params.key));
  res.json({ ok: true });
});

// --- all signals (unpaginated, for export) ------------------------------
app.get("/api/signals", async (req, res) => {
  const rules = await listRules();
  const all = detectSignals(getRows(), rules);
  const type = (req.query.type || "").trim();
  res.json(type && type !== "all" ? all.filter((s) => s.type === type) : all);
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
