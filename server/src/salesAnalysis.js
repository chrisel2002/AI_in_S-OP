// Deep-dive chatbot analysis over `underlying_sales` (order-level actuals).
//
// The dashboard/chat context (chat.js) is built from `sales_operations_tool`
// (planning-level, one row per material/plant/office/month) and is enough for
// generic questions (signal counts, active rules, top materials...). Some
// planner questions instead need customer/order/geography-level detail that
// only lives in `underlying_sales`. This module detects those questions,
// pulls the minimum necessary slice of `underlying_sales`, aggregates it in
// Mongo, and reduces it to a compact backend-computed summary — the LLM only
// ever sees numbers we calculated, never raw records.
//
// Matching note: `sales_operations_tool` has no reliable `plant` join key
// against `underlying_sales` (which has separate `simulated_plant` /
// `historic_plant` fields) — see project memory. So everything here matches
// on material + sales_office + period + sales type, and every rendered
// section says so explicitly for transparency.
import mongoose from "mongoose";
import { storageBackend } from "./store.js";

const COLLECTION = "underlying_sales";

const RECENT_MONTHS = 3;
const HISTORICAL_MONTHS = 12;

const MAX_CANDIDATE_MATERIALS = 6;
const MAX_OFFICES_PER_MATERIAL = 6;
const MAX_LISTED = 5; // customers/countries shown per section
const MAX_RENDERED_MATERIALS = 3; // per analysis section, in the final text
// Order-level quantities in this dataset run from ~0.0001t to a few tons per
// material/office/period — much finer-grained than the planning-level
// forecast totals. Only drop pairs with literally no recent volume.
const MIN_RECENT_TONS = 1e-6;

const MATCH_NOTE =
  "matched by material, sales office, period, and sales type — plant was not used, " +
  "because plant mapping differs between sales_operations_tool and underlying_sales";

// ---- intent detection ----------------------------------------------------

const PATTERNS = {
  concentration: [/concentrat/i, /small number of customers/i, /single.?customer/i, /customer.?depend/i, /handful of customers/i],
  forecastDriver: [/forecast increase/i, /driven by/i, /driving the increase/i, /primarily driven/i, /explains? the (increase|growth)/i],
  newCustomers: [/new customers?/i],
  lostCustomers: [/lost customers?/i, /no longer contribut/i, /churn/i, /stopped (ordering|buying|purchasing)/i, /important customers/i],
  typeMix: [/free.?stock/i, /scheduling agreement/i, /\bcontracts?\b/i, /demand type/i, /demand mix/i, /composition/i, /mix between/i],
  geographic: [/geographic/i, /\bcountr(y|ies)\b/i, /postal code/i, /\bregion/i, /shifted? geographically/i],
  customerGeneral: [/\bcustomers?\b/i, /\border(s)?\b/i, /sales order/i],
};

function matchesAny(text, patterns) {
  return patterns.some((p) => p.test(text));
}

export function detectSalesAnalysisIntent(question) {
  const q = String(question || "");
  const flags = {
    concentration: matchesAny(q, PATTERNS.concentration),
    forecastDriver: matchesAny(q, PATTERNS.forecastDriver),
    newCustomers: matchesAny(q, PATTERNS.newCustomers),
    lostCustomers: matchesAny(q, PATTERNS.lostCustomers),
    typeMix: matchesAny(q, PATTERNS.typeMix),
    geographic: matchesAny(q, PATTERNS.geographic),
  };
  const specific = Object.values(flags).some(Boolean);
  flags.any = specific || matchesAny(q, PATTERNS.customerGeneral);
  // Generic "customer"/"order" mentions with no specific angle -> run the
  // most broadly useful pair: concentration + new/lost customers.
  if (!specific && flags.any) {
    flags.concentration = true;
    flags.newCustomers = true;
    flags.lostCustomers = true;
  }
  return flags;
}

// ---- candidate material/sales_office selection ---------------------------

function extractMentionedMaterials(question, knownMaterials) {
  const nums = String(question || "").match(/\b\d{4,6}\b/g) || [];
  return [...new Set(nums.map(Number))].filter((n) => knownMaterials.has(n));
}

// Prefer signals whose type indicates a rising forecast (used for the
// "forecast increase driven by ..." question). Falls back to all signals if
// none of that type are present, so we still return something useful.
function risingSignalsFirst(signals) {
  const rising = signals.filter(
    (s) => s.type === "Demand surge" || s.type === "New demand" ||
      (s.type === "Forecast deviation" && (s.snapshot?.devPct ?? 0) > 0)
  );
  return rising.length ? rising : signals;
}

function pickCandidatePairs(question, rows, signals, intent) {
  const officesByMaterial = new Map();
  const totalsByMaterial = new Map();
  const knownMaterials = new Set();
  for (const r of rows) {
    const material = Number(r.material);
    const office = Number(r.sales_office);
    knownMaterials.add(material);
    if (!officesByMaterial.has(material)) officesByMaterial.set(material, new Set());
    officesByMaterial.get(material).add(office);
    totalsByMaterial.set(material, (totalsByMaterial.get(material) || 0) + (r.sales_free_stock_in_tons || 0));
  }

  let materials = extractMentionedMaterials(question, knownMaterials);

  if (!materials.length && signals?.length) {
    const source = intent.forecastDriver ? risingSignalsFirst(signals) : signals;
    const seen = new Set();
    materials = [];
    for (const s of source) {
      const m = Number(s.material);
      if (!seen.has(m)) { seen.add(m); materials.push(m); }
      if (materials.length >= MAX_CANDIDATE_MATERIALS) break;
    }
  }

  if (!materials.length) {
    materials = [...totalsByMaterial.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_CANDIDATE_MATERIALS)
      .map(([m]) => m);
  }

  materials = materials.slice(0, MAX_CANDIDATE_MATERIALS);

  const pairs = [];
  for (const material of materials) {
    const offices = [...(officesByMaterial.get(material) || [])].slice(0, MAX_OFFICES_PER_MATERIAL);
    for (const salesOffice of offices) pairs.push({ material, salesOffice });
  }
  return pairs;
}

// ---- period bounds (cached — underlying_sales is static during runtime) --

let _boundsPromise = null;

function addMonths(date, delta) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d;
}

async function getPeriodBounds() {
  if (!_boundsPromise) {
    _boundsPromise = mongoose.connection.db
      .collection(COLLECTION)
      .aggregate([{ $group: { _id: null, maxDate: { $max: "$date" } } }])
      .toArray()
      .then(([r]) => {
        const maxDate = r?.maxDate ? new Date(r.maxDate) : new Date();
        const recentStart = addMonths(maxDate, -RECENT_MONTHS);
        const historicalStart = addMonths(recentStart, -HISTORICAL_MONTHS);
        return { maxDate, recentStart, historicalStart };
      })
      .catch((e) => { _boundsPromise = null; throw e; });
  }
  return _boundsPromise;
}

// ---- aggregation + folding -------------------------------------------------

async function fetchGroupedDemand(pairs, bounds) {
  const coll = mongoose.connection.db.collection(COLLECTION);
  const match = {
    date: { $gte: bounds.historicalStart },
    $or: pairs.map((p) => ({ material: p.material, sales_office: p.salesOffice })),
  };
  return coll
    .aggregate([
      { $match: match },
      {
        $addFields: {
          period: { $cond: [{ $gte: ["$date", bounds.recentStart] }, "recent", "historical"] },
          salesType: {
            $switch: {
              branches: [
                { case: { $eq: ["$is_contract", true] }, then: "contract" },
                { case: { $eq: ["$is_scheduling_agreement", true] }, then: "scheduling_agreement" },
              ],
              default: "free_stock",
            },
          },
        },
      },
      {
        $group: {
          _id: {
            material: "$material", salesOffice: "$sales_office", customer: "$customer",
            country: "$recipient_country", salesType: "$salesType", period: "$period",
          },
          tons: { $sum: "$quantity_in_tons" },
        },
      },
    ])
    .toArray();
}

function foldByMaterial(groupRows) {
  const byKey = new Map();
  for (const g of groupRows) {
    const { material, salesOffice, customer, country, salesType, period } = g._id;
    const key = `${material}|${salesOffice}`;
    let m = byKey.get(key);
    if (!m) {
      m = {
        material, salesOffice,
        totals: { recent: 0, historical: 0 },
        byCustomer: { recent: new Map(), historical: new Map() },
        byCountry: { recent: new Map(), historical: new Map() },
        byType: { recent: new Map(), historical: new Map() },
      };
      byKey.set(key, m);
    }
    m.totals[period] += g.tons;
    m.byCustomer[period].set(customer, (m.byCustomer[period].get(customer) || 0) + g.tons);
    m.byCountry[period].set(country, (m.byCountry[period].get(country) || 0) + g.tons);
    m.byType[period].set(salesType, (m.byType[period].get(salesType) || 0) + g.tons);
  }
  return [...byKey.values()].filter((m) => m.totals.recent >= MIN_RECENT_TONS);
}

function topEntries(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ---- per-material derived metrics ------------------------------------------

function concentrationMetric(m) {
  const top = topEntries(m.byCustomer.recent, 3);
  if (!top.length) return null;
  const top3Share = top.reduce((s, [, v]) => s + v, 0) / m.totals.recent;
  return { topCustomer: top[0][0], topCustomerShare: top[0][1] / m.totals.recent, top3Share, strength: top3Share };
}

function newCustomersMetric(m) {
  const hist = m.byCustomer.historical;
  const entries = [...m.byCustomer.recent.entries()].filter(([c]) => !hist.has(c));
  if (!entries.length) return null;
  const newTons = entries.reduce((s, [, v]) => s + v, 0);
  const share = newTons / m.totals.recent;
  const top = entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_LISTED);
  return { share, count: entries.length, top, strength: share };
}

function lostCustomersMetric(m) {
  if (m.totals.historical <= 0) return null;
  const recent = m.byCustomer.recent;
  const lost = [...m.byCustomer.historical.entries()]
    .filter(([c, v]) => v / m.totals.historical >= 0.05 && !(recent.get(c) > 0))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_LISTED);
  if (!lost.length) return null;
  const strength = lost.reduce((s, [, v]) => s + v, 0) / m.totals.historical;
  return { lost, strength };
}

function typeMixMetric(m) {
  if (m.totals.recent <= 0 || m.totals.historical <= 0) return null;
  const types = ["free_stock", "contract", "scheduling_agreement"];
  const shares = types.map((t) => {
    const recentShare = (m.byType.recent.get(t) || 0) / m.totals.recent;
    const historicalShare = (m.byType.historical.get(t) || 0) / m.totals.historical;
    return { type: t, recentShare, historicalShare, delta: recentShare - historicalShare };
  });
  const recentMonthly = m.totals.recent / RECENT_MONTHS;
  const historicalMonthly = m.totals.historical / HISTORICAL_MONTHS;
  const volumeChangePct = historicalMonthly > 0 ? (recentMonthly - historicalMonthly) / historicalMonthly : null;
  const maxDelta = Math.max(...shares.map((s) => Math.abs(s.delta)));
  // Interesting = total volume roughly stable but composition shifted a lot.
  const stableVolume = volumeChangePct !== null && Math.abs(volumeChangePct) < 0.25;
  if (!stableVolume || maxDelta < 0.15) return null;
  return { shares, volumeChangePct, strength: maxDelta };
}

function geographicMetric(m) {
  if (m.totals.recent <= 0) return null;
  const recentTop = topEntries(m.byCountry.recent, MAX_LISTED);
  const shifts = recentTop.map(([country, tons]) => {
    const recentShare = tons / m.totals.recent;
    const histTons = m.byCountry.historical.get(country) || 0;
    const histShare = m.totals.historical > 0 ? histTons / m.totals.historical : 0;
    return { country, recentTons: tons, recentShare, delta: recentShare - histShare, isNew: histTons === 0 };
  });
  const maxDelta = Math.max(0, ...shifts.map((s) => s.delta));
  if (maxDelta < 0.1) return null;
  return { shifts: shifts.sort((a, b) => b.delta - a.delta), strength: maxDelta };
}

// ---- rendering -------------------------------------------------------------

const pct = (n) => `${(n * 100).toFixed(0)}%`;
const t = (n) => `${n.toFixed(3)}t`;

function rankAndRender(materialMetrics, metricFn, renderFn, header) {
  const scored = [];
  for (const m of materialMetrics) {
    const result = metricFn(m);
    if (result) scored.push({ m, result });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.result.strength - a.result.strength);
  const lines = scored.slice(0, MAX_RENDERED_MATERIALS).map(({ m, result }) => renderFn(m, result));
  return `${header} (${MATCH_NOTE}):\n${lines.join("\n")}`;
}

function renderConcentration(m, r) {
  return `  - material ${m.material}, sales office ${m.salesOffice}: recent demand ${t(m.totals.recent)}; top customer ${r.topCustomer} = ${pct(r.topCustomerShare)} of it; top 3 customers = ${pct(r.top3Share)}.`;
}

function renderNewCustomers(m, r) {
  const names = r.top.map(([c, v]) => `${c} (${t(v)})`).join(", ");
  return `  - material ${m.material}, sales office ${m.salesOffice}: ${r.count} new customer(s) vs the historical period, contributing ${pct(r.share)} of recent demand (${t(m.totals.recent)}). Top new: ${names}.`;
}

function renderLostCustomers(m, r) {
  const names = r.lost.map(([c, v]) => `${c} (${t(v)}, ${pct(v / m.totals.historical)} of historical demand)`).join(", ");
  return `  - material ${m.material}, sales office ${m.salesOffice}: previously significant customer(s) with ~no recent demand: ${names}.`;
}

function renderTypeMix(m, r) {
  const parts = r.shares.map((s) => `${s.type} ${pct(s.historicalShare)} -> ${pct(s.recentShare)}`).join(", ");
  const volTxt = r.volumeChangePct === null ? "n/a" : `${r.volumeChangePct >= 0 ? "+" : ""}${(r.volumeChangePct * 100).toFixed(0)}%`;
  return `  - material ${m.material}, sales office ${m.salesOffice}: total monthly volume change ${volTxt} while mix shifted: ${parts}.`;
}

function renderGeographic(m, r) {
  const parts = r.shifts
    .filter((s) => s.delta > 0)
    .map((s) => `${s.country}${s.isNew ? " (new)" : ""} now ${pct(s.recentShare)} of recent demand (${t(s.recentTons)})`)
    .join(", ");
  return `  - material ${m.material}, sales office ${m.salesOffice}: growing/new regions — ${parts}.`;
}

// ---- public entry point -----------------------------------------------------

export async function buildSalesAnalysisContext(question, { rows, signals }) {
  if (storageBackend() !== "mongo") return null;
  const intent = detectSalesAnalysisIntent(question);
  if (!intent.any) return null;

  const pairs = pickCandidatePairs(question, rows, signals, intent);
  if (!pairs.length) return null;

  let bounds, groupRows;
  try {
    bounds = await getPeriodBounds();
    groupRows = await fetchGroupedDemand(pairs, bounds);
  } catch (e) {
    console.log("sales analysis query failed:", e.message);
    return null;
  }
  if (!groupRows.length) return null;

  const materialMetrics = foldByMaterial(groupRows);
  if (!materialMetrics.length) return null;

  const fmt = (d) => d.toISOString().slice(0, 10);
  const sections = [
    `Recent period: ${fmt(bounds.recentStart)} to ${fmt(bounds.maxDate)}. Historical comparison period: ${fmt(bounds.historicalStart)} to ${fmt(bounds.recentStart)}. Source: underlying_sales order-level records, scoped to ${pairs.length} material/sales-office pair(s) relevant to this question.`,
  ];

  if (intent.concentration) {
    sections.push(rankAndRender(
      materialMetrics, concentrationMetric, renderConcentration,
      intent.forecastDriver ? "FORECAST INCREASE — CUSTOMER CONCENTRATION" : "CUSTOMER CONCENTRATION"
    ));
  }
  if (intent.newCustomers) {
    sections.push(rankAndRender(materialMetrics, newCustomersMetric, renderNewCustomers, "NEW CUSTOMERS (recent vs historical period)"));
  }
  if (intent.lostCustomers) {
    sections.push(rankAndRender(materialMetrics, lostCustomersMetric, renderLostCustomers, "LOST / DORMANT HISTORICAL CUSTOMERS"));
  }
  if (intent.typeMix) {
    sections.push(rankAndRender(materialMetrics, typeMixMetric, renderTypeMix, "DEMAND-TYPE MIX SHIFT (free stock / contract / scheduling agreement)"));
  }
  if (intent.geographic) {
    sections.push(rankAndRender(materialMetrics, geographicMetric, renderGeographic, "GEOGRAPHIC DEMAND SHIFT (by recipient country)"));
  }

  const rendered = sections.filter(Boolean);
  if (rendered.length <= 1) return null; // only the header — nothing qualified
  return rendered.join("\n\n");
}
