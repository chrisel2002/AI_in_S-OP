import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";

import { loadDataFromMongo, getRows, updateRowById } from "./data.js";
import { detectSignals, buildDashboard } from "./signals.js";
import { generateBriefing, generateBriefingLLM } from "./briefing.js";
import { parseSentence, checkPromptClarity } from "./parser.js";
import { getAllStatuses, upsertStatus, removeStatus } from "./status.js";
import { suggestActions } from "./suggest.js";
import { buildChatContext, answerQuestion } from "./chat.js";
import { buildSalesAnalysisContext } from "./salesAnalysis.js";
import { chatLLM, llmEnabled } from "./llm.js";
import {
  initStore,
  storageBackend,
  listRules,
  insertRule,
  updateRule,
  deleteRule,
} from "./store.js";
import { buildDeterministicRecommendations, getFieldsUsedByRule } from "./recommendations.js";

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/sop";

const app = express();
app.use(cors());
app.use(express.json());

// --- signal cache -----------------------------------------------------------
// Promise-based: concurrent requests share the same in-flight rebuild.
// Immediately restarts the rebuild after any rule mutation so the next
// request almost always hits a warm cache.
let _rulesPromise = null;
let _signalsPromise = null;

function getCachedRules() {
  if (!_rulesPromise) _rulesPromise = listRules();
  return _rulesPromise;
}

function getCachedSignals() {
  if (!_signalsPromise)
    _signalsPromise = getCachedRules().then((rules) => detectSignals(getRows(), rules));
  return _signalsPromise;
}

function invalidateAndRebuild() {
  _rulesPromise = listRules();
  _signalsPromise = _rulesPromise.then((rules) => detectSignals(getRows(), rules));
  _signalsPromise
    .then(() => console.log("✅ Signal cache rebuilt"))
    .catch(() => { _signalsPromise = null; });
}

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
  const [allSignals, rules] = await Promise.all([getCachedSignals(), getCachedRules()]);
  const dash = buildDashboard(allSignals, rules.filter((r) => r.active !== false).length, { allSignals });
  res.json({
    ...dash,
    allSignals,           // full list — client handles filtering + pagination
    briefing: generateBriefing(allSignals),
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
  const signals = await getCachedSignals();
  res.json({ briefing: await generateBriefingLLM(signals) });
});

// --- AI chatbot: answer questions grounded in the live data context ----------
app.post("/api/chat", async (req, res) => {
  const { question, history } = req.body || {};
  if (!question) return res.status(400).json({ error: "question required" });
  const [signals, rules] = await Promise.all([getCachedSignals(), getCachedRules()]);
  const context = buildChatContext(getRows(), signals, rules);

  let salesAnalysis = null;
  try {
    salesAnalysis = await buildSalesAnalysisContext(question, { rows: getRows(), signals });
  } catch (e) {
    console.log("sales analysis failed:", e.message);
  }

  res.json({
    answer: await answerQuestion(question, context, history || [], salesAnalysis),
    usedSalesAnalysis: Boolean(salesAnalysis),
  });
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
  const all = await getCachedSignals();
  const type = (req.query.type || "").trim();
  res.json(type && type !== "all" ? all.filter((s) => s.type === type) : all);
});

// --- rule CRUD ----------------------------------------------------------
app.get("/api/rules", async (_req, res) => res.json(await getCachedRules()));

app.post("/api/rules", async (req, res) => {
  try {
    const rule = await insertRule(req.body);
    console.log("✅ Rule saved to DB:", JSON.stringify(rule));
    invalidateAndRebuild();
    res.json(rule);
  } catch (e) {
    console.error("❌ Rule save failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/rules/:id", async (req, res) => {
  const rule = await updateRule(req.params.id, req.body);
  invalidateAndRebuild();
  res.json(rule);
});

app.delete("/api/rules/:id", async (req, res) => {
  await deleteRule(req.params.id);
  invalidateAndRebuild();
  res.json({ ok: true });
});


// ---- editable-field whitelist (backend source of truth) ----------------
// To allow more fields in the future, add them here only.
const ALLOWED_EDITABLE_FIELDS = new Set([
  "sales_free_stock_in_tons",
  "sales_contracts_in_tons",
  "sales_scheduling_agreement_in_tons",
]);

function sanitizeChanges(changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const result = {};
  for (const [key, value] of Object.entries(changes)) {
    if (ALLOWED_EDITABLE_FIELDS.has(key) && Number.isFinite(Number(value))) {
      result[key] = Number(value);
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

// --- PATCH: save edited planning values and recalculate signal ----------
app.patch("/api/dashboard/signals/:id", async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid signal ID" });
  }

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Request body must be a JSON object" });
  }

  // Reject unknown / non-editable fields
  const unknown = Object.keys(body).filter((k) => !ALLOWED_EDITABLE_FIELDS.has(k));
  if (unknown.length > 0) {
    return res.status(400).json({ error: `Non-editable fields not allowed: ${unknown.join(", ")}` });
  }

  // Validate and normalise to numbers
  const updates = {};
  for (const [key, raw] of Object.entries(body)) {
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      return res.status(400).json({ error: `Invalid value for "${key}": must be a finite number` });
    }
    updates[key] = num;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  try {
    const coll = mongoose.connection.db.collection("sales_operations_tool");
    const updated = await coll.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: updates },
      { returnDocument: "after" }
    );

    if (!updated) return res.status(404).json({ error: "Row not found" });

    // Patch the in-memory row so subsequent detection uses fresh values
    updateRowById(id, updates);

    // Recompute signals from the updated in-memory rows and refresh the cache
    const rules = await getCachedRules();
    const newSignals = detectSignals(getRows(), rules);
    // Replace cache directly — no background rebuild needed
    _signalsPromise = Promise.resolve(newSignals);

    // Return the signal(s) whose source row is this document
    const signal = newSignals.find((s) => s._id === id) || null;
    res.json({ signal });
  } catch (e) {
    console.error("PATCH signal error:", e.message);
    res.status(500).json({ error: "Failed to update signal row" });
  }
});

// --- POST: AI recommendations for one signal row -----------------------
// app.post("/api/dashboard/signals/:id/ai-recommendations", async (req, res) => {
//   const { id } = req.params;
//   if (!mongoose.Types.ObjectId.isValid(id)) {
//     return res.status(400).json({ error: "Invalid signal ID" });
//   }
//   if (!llmEnabled()) {
//     return res.json({ recommendations: [] });
//   }

//   try {
//     const coll = mongoose.connection.db.collection("sales_operations_tool");
//     const doc = await coll.findOne({ _id: new mongoose.Types.ObjectId(id) });
//     if (!doc) return res.status(404).json({ error: "Row not found" });

//     // Find the cached signal for this row to provide computed context
//     const signals = await getCachedSignals();
//     const sig = signals.find((s) => s._id === id);

//     const editableList = [...ALLOWED_EDITABLE_FIELDS].join(", ");
//     const raw = await chatLLM(
//       [
//         {
//           role: "system",
//           content: `You are an S&OP planning assistant. Analyze the given demand-plan signal and return a JSON object with EXACTLY this structure — no preamble, no markdown fences, valid JSON only:
// {"recommendations":[{"text":"...","changes":null},{"text":"...","changes":{"sales_free_stock_in_tons":5.2}}]}

// Rules:
// - Include 3 to 5 recommendations.
// - Some may be text-only observations or action items (set changes to null).
// - If you suggest changing a numeric planning field, include it in "changes" as a number.
// - Only use these field names inside "changes": ${editableList}.
// - Do not invent other field names.
// - Write each "text" as a natural sentence. Do not include labels like "Field:", "Current:", "Suggested:".
// - Return ONLY valid JSON, nothing else.`,
//         },
//         {
//           role: "user",
//           content: `Signal: ${sig?.type || "Unknown"} (score: ${sig?.score ?? "?"}, priority: ${sig?.priority ?? "?"})
// Material: ${doc.material}, Plant: ${doc.plant}, Sales Office: ${doc.sales_office}, Month: ${String(doc.date).slice(0, 10)}
// Detail: ${sig?.detail || ""}
// Reasoning: ${sig?.reasoning || ""}

// Current planning values:
// - Sales Free Stock: ${doc.sales_free_stock_in_tons}t
// - Sales Contracts: ${doc.sales_contracts_in_tons}t
// - Sales Scheduling Agreement: ${doc.sales_scheduling_agreement_in_tons}t

// Historic reference (free stock):
// - 12M historic sales: ${doc.historic_sales_12_free_stock_in_tons}t
// - 24M historic sales: ${doc.historic_sales_24_free_stock_in_tons}t
// - 12M historic inventory: ${doc.historic_inventory_12_free_stock_in_tons}t`,
//         },
//       ],
//       { temperature: 0.5 }
//     );

//     // Parse — try direct JSON, then try extracting the first {...} block
//     let parsed = null;
//     try {
//       parsed = JSON.parse(raw);
//     } catch {
//       const m = raw.match(/\{[\s\S]*\}/);
//       if (m) {
//         try { parsed = JSON.parse(m[0]); } catch { /* fall through */ }
//       }
//     }

//     if (!parsed || !Array.isArray(parsed.recommendations)) {
//       return res.json({ recommendations: [] });
//     }

//     const recommendations = parsed.recommendations
//       .filter((r) => r && typeof r.text === "string" && r.text.trim())
//       .map((r) => ({
//         text: String(r.text).trim().slice(0, 600),
//         changes: sanitizeChanges(r.changes),
//       }));

//     res.json({ recommendations });
//   } catch (e) {
//     console.error("AI recs error:", e.message);
//     res.json({ recommendations: [], error: "AI recommendations unavailable" });
//   }
// });


app.post("/api/dashboard/signals/:id/ai-recommendations", async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid signal ID" });
  }

  try {
    const coll = mongoose.connection.db.collection("sales_operations_tool");
    const doc = await coll.findOne({ _id: new mongoose.Types.ObjectId(id) });
    if (!doc) return res.status(404).json({ error: "Row not found" });

    const signals = await getCachedSignals();
    const sig = signals.find((s) => s._id === id);

    const rules = await getCachedRules();
    const rule = rules.find((r) => r.name === sig?.type) || null;

    // 1. Deterministic, formula-derived recommendations — guaranteed correct,
    // no LLM involved in computing the number. Empty array for formula rules
    // or if no rule was found.
    const deterministicRecs = buildDeterministicRecommendations(rule, doc);
    const editableFields = rule ? getFieldsUsedByRule(rule) : [];

    // 2. Descriptive-only LLM recommendation — written like a planner talking
    // to a colleague, not a system reporting statistics. NEVER allowed to
    // suggest a numeric change — those come only from the deterministic solver.
    let llmRecs = [];
    if (llmEnabled()) {
      const raw = await chatLLM(
        [
          {
            role: "system",
            content: `You are an experienced S&OP planner explaining a demand-planning risk to a colleague in a meeting. You are NOT a data analyst reciting numbers — you are a person who understands what these numbers mean for the business.

You will be given a flagged material and its data. Return a JSON object with EXACTLY this structure — no preamble, no markdown fences, valid JSON only:
{"recommendations":[{"text":"..."}]}

HOW MANY RECOMMENDATIONS:
- Include EXACTLY 1 recommendation, unless the data clearly supports a second, genuinely
  DIFFERENT angle (e.g. a separate risk, a separate likely cause, or a separate
  stakeholder to involve). In that case you may include a 2nd.
- Never include a 2nd or 3rd recommendation that just restates the 1st in different
  words to sound more thorough. If you only have one real insight, one is correct —
  do not pad it out.

WRITING STYLE:
1. Never state a percentage or raw number as the main point of a sentence. Numbers may
   appear as supporting evidence, but the sentence must lead with the business meaning.
   BAD:  "Sales rose 335% compared to 12 months ago."
   GOOD: "This material has seen an unusually large jump in orders — worth checking
          whether this is a new contract, a one-off bulk order, or a shift in customer
          behavior, since each implies a different response."

2. Never use the words "average", "deviation", "threshold", "baseline", or "% change" —
   these are internal system terms, not how a planner talks. Describe what actually
   happened instead.

3. Write ONE short, natural paragraph (2-3 sentences) that flows together — covering
   what's happening, why it matters, and one concrete thing to check. Do NOT label these
   as separate sections ("WHAT happened:", "WHY it matters:", etc.) and do NOT write them
   as separate bullet-style fragments. Blend them the way a person would say it out loud.

4. Point out something SPECIFIC about this exact material's numbers — not a generic
   statement that could apply to any flagged signal. Avoid vague filler like "there could
   be an issue with the sales process" — say what pattern in the data suggests that.

5. Where there's real ambiguity in the cause, name the 2 most likely explanations rather
   than asserting one as fact — e.g. "this usually means either a stalled customer
   relationship or a pricing gap — worth checking which." Use "likely", "worth checking
   whether", "this could mean" — never state a guess as if it were certain.

6. Do not suggest a specific numeric target value under any circumstances — you do not
   have enough context to know if a number is achievable. Suggest a DIRECTION ("look into
   reducing new spot orders") not a VALUE ("reduce to 8.2 tons").

7. Historic fields (e.g. "historic_sales_12_...", "historic_inventory_12_...") are single
   data points from 12 or 24 months ago — NOT rolling averages. Describe them as "the
   same period last year" or "12 months ago", never as an "average".

Return ONLY valid JSON, nothing else.`,
          },
          {
            role: "user",
            content: `Signal: ${sig?.type || "Unknown"} (score: ${sig?.score ?? "?"}, priority: ${sig?.priority ?? "?"})
Material: ${doc.material}, Plant: ${doc.plant}, Sales Office: ${doc.sales_office}, Month: ${String(doc.date).slice(0, 10)}
Detail: ${sig?.detail || ""}
Reasoning: ${sig?.reasoning || ""}

Current planning values:
- Sales Free Stock: ${doc.sales_free_stock_in_tons}t
- Sales Contracts: ${doc.sales_contracts_in_tons}t
- Sales Scheduling Agreement: ${doc.sales_scheduling_agreement_in_tons}t

Historic reference (single points, not averages):
- 12 months prior — free stock: ${doc.historic_sales_12_free_stock_in_tons}t, contracts: ${doc.historic_sales_12_contracts_in_tons}t, scheduling agreement: ${doc.historic_sales_12_scheduling_agreement_in_tons}t
- 24 months prior — free stock: ${doc.historic_sales_24_free_stock_in_tons}t, contracts: ${doc.historic_sales_24_contracts_in_tons}t, scheduling agreement: ${doc.historic_sales_24_scheduling_agreement_in_tons}t`,
          },
        ],
        { temperature: 0.6 }
      );

      let parsed = null;
      try { parsed = JSON.parse(raw); }
      catch {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch { /* ignore */ } }
      }

      if (parsed && Array.isArray(parsed.recommendations)) {
        llmRecs = parsed.recommendations
          .filter((r) => r && typeof r.text === "string" && r.text.trim())
          .map((r) => ({ text: String(r.text).trim().slice(0, 600), changes: null })); // changes forced null — safety net
      }
    }

    res.json({
      recommendations: [...deterministicRecs, ...llmRecs],
      editableFields,
    });
  } catch (e) {
    console.error("AI recs error:", e.message);
    res.json({ recommendations: [], editableFields: [], error: "AI recommendations unavailable" });
  }
});

// --- debug: inspect rules + signal counts in real time ------------------
app.get("/api/debug", async (req, res) => {
  const [allSignals, rules] = await Promise.all([getCachedSignals(), getCachedRules()]);
  const rows = getRows();

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
  // Warm up the cache so the first request is instant
  await getCachedSignals();
  console.log("✅ Signal cache warm");
  app.listen(PORT, () => console.log(`API ready on http://localhost:${PORT}`));
}
start();
