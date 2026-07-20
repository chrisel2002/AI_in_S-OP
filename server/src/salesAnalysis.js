// Deep-dive chatbot analysis over `underlying_sales` (order-level actuals) and,
// for demand-type mix, `sales_operations_tool` (planning-level) directly.
//
// The dashboard/chat context (chat.js) is built from `sales_operations_tool`
// and is enough for generic questions (signal counts, active rules, top
// materials...). Some planner questions need customer/order/geography-level
// detail that only lives in `underlying_sales`. This module detects those
// questions, pulls the minimum necessary slice of data, and reduces it to a
// compact backend-computed summary — the LLM only ever sees numbers we
// calculated, never raw records.
//
// Matching note: `sales_operations_tool` has no reliable `plant` join key
// against `underlying_sales` (which has separate `simulated_plant` /
// `historic_plant` fields) — see project memory. So everything here matches
// on material + sales_office, and every rendered section that crosses the two
// collections says so explicitly.
//
// Combining evidence across sources (e.g. "customer concentration" from
// underlying_sales with a "demand surge" signal from sales_operations_tool)
// is only ever done in code, at the exact material+sales_office pair — never
// left for the LLM to infer from two separately-rendered lists. When a
// candidate pair has no corroborating evidence at the same sales office, the
// rendered line says so explicitly instead of silently omitting the caveat.
import mongoose from "mongoose";
import { storageBackend } from "./store.js";

const COLLECTION = "underlying_sales";

const RECENT_MONTHS = 3;
const HISTORICAL_MONTHS = 12;

const MAX_CANDIDATE_MATERIALS = 6;
const MAX_OFFICES_PER_MATERIAL = 3;
const MAX_CANDIDATE_PAIRS = 10; // hard cap on material+office pairs sent to Mongo
const MAX_LISTED = 5; // customers/countries shown per section
const MAX_RENDERED_MATERIALS = 3; // per analysis section, in the final text

// Order-level quantities in `underlying_sales` run from ~0.0001t to ~0.065t
// per material/sales-office pair over a 3-month window (measured on the live
// dataset: median ≈0.0003t, p90 ≈0.003t, max ≈0.065t) — far smaller than the
// sales_operations_tool planning aggregates (tens to hundreds of tons/month).
// A fixed absolute floor calibrated to THIS collection's own scale, not the
// planning scale: below it, a finding is real but not business-critical.
const LOW_VOLUME_TONS = 0.003;

// sales_operations_tool is a different, much larger scale — reuse the
// convention from signals.js (MIN_TONS = 5) loosely: 1t floor to ignore
// near-zero planning rows for the type-mix comparison.
const MIN_TYPEMIX_TONS = 1;

const MATCH_NOTE =
  "matched by material, sales office, period, and sales type — plant was not used, " +
  "because plant mapping differs between sales_operations_tool and underlying_sales";

// ---- intent detection ----------------------------------------------------

const PATTERNS = {
  concentration: [/concentrat/i, /small number of customers/i, /single.?customer/i, /customer.?depend/i, /handful of customers/i],
  forecastDriver: [
    /forecast.{0,30}increas/i, /increas.{0,30}forecast/i,
    /driven by/i, /driving the (increase|growth|surge)/i, /primarily driven/i,
    /explains? the (increase|growth)/i,
  ],
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

// ---- signal indexing + cross-reference helpers ----------------------------
// Everything that combines a signal (sales_operations_tool) with an
// underlying_sales finding goes through this exact-pair lookup, never a
// material-only match.

function pairKey(material, salesOffice) {
  return `${material}|${salesOffice}`;
}

function indexSignalsByPair(signals) {
  const map = new Map();
  for (const s of signals || []) {
    const key = pairKey(Number(s.material), Number(s.salesOffice));
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return map;
}

const SHIFT_TYPES = new Set(["Demand surge", "Demand drop", "Forecast deviation"]);
function isShiftSignal(s) {
  return SHIFT_TYPES.has(s.type);
}

function isRisingSignal(s) {
  if (s.type === "Demand surge" || s.type === "New demand") return true;
  if (s.type === "Forecast deviation" && (s.snapshot?.devPct ?? 0) > 0) return true;
  return false;
}

function bestByScore(list) {
  if (!list?.length) return null;
  return list.reduce((a, b) => (b.score > a.score ? b : a));
}

// Used only for the "material-level indication only" caveat: is there a
// shift signal for this SAME material at a DIFFERENT sales office?
function findOtherOfficeShift(signalsByPair, material, excludeOffice) {
  for (const [key, list] of signalsByPair) {
    const sep = key.lastIndexOf("|");
    if (Number(key.slice(0, sep)) !== material) continue;
    const office = Number(key.slice(sep + 1));
    if (office === excludeOffice) continue;
    const shift = bestByScore(list.filter(isShiftSignal));
    if (shift) return { office, signal: shift };
  }
  return null;
}

function enrichWithSignals(materialMetrics, signalsByPair) {
  for (const m of materialMetrics) {
    const own = signalsByPair.get(pairKey(m.material, m.salesOffice)) || [];
    m.sameOfficeShiftSignal = bestByScore(own.filter(isShiftSignal));
    m.sameOfficeRisingSignal = bestByScore(own.filter(isRisingSignal));
    m.otherOfficeShift = m.sameOfficeShiftSignal ? null : findOtherOfficeShift(signalsByPair, m.material, m.salesOffice);
  }
}

const MIN_FORECAST_TONS = 1; // materiality floor, same convention as MIN_TYPEMIX_TONS

// Computes forecast change directly from sales_operations_tool rows — current
// total vs. historic-12mo total — independent of any signal/rule type name.
// This replaces relying on pre-existing signals to judge "did the forecast rise".
function forecastChangeForPair(rows, material, salesOffice) {
  let curr = 0, hist = 0;
  for (const r of rows) {
    if (Number(r.material) !== material || Number(r.sales_office) !== salesOffice) continue;
    curr += (r.sales_free_stock_in_tons || 0) + (r.sales_contracts_in_tons || 0) + (r.sales_scheduling_agreement_in_tons || 0);
    hist += (r.historic_sales_12_free_stock_in_tons || 0) + (r.historic_sales_12_contracts_in_tons || 0) + (r.historic_sales_12_scheduling_agreement_in_tons || 0);
  }
  if (curr < MIN_FORECAST_TONS && hist < MIN_FORECAST_TONS) return null; // not material enough to judge
  if (hist === 0) {
    return curr >= MIN_FORECAST_TONS ? { changePct: null, isNew: true, isRising: true, isFalling: false, curr, hist } : null;
  }
  const changePct = (curr - hist) / hist;
  return { changePct, isNew: false, isRising: changePct > 0.1, isFalling: changePct < -0.1, curr, hist };
}

function enrichWithForecastChange(materialMetrics, rows) {
  for (const m of materialMetrics) {
    m.forecastChange = forecastChangeForPair(rows, m.material, m.salesOffice);
  }
}

// ---- candidate material/sales_office selection ---------------------------

function extractMentionedMaterials(question, knownMaterials) {
  const nums = String(question || "").match(/\b\d{4,6}\b/g) || [];
  return [...new Set(nums.map(Number))].filter((n) => knownMaterials.has(n));
}

// Prefer signals whose type indicates a rising forecast (used for
// forecast-driver / geographic-causality questions). Falls back to all
// signals if none of that type are present.
function risingSignalsFirst(signals) {
  const rising = signals.filter(isRisingSignal);
  return rising.length ? rising : signals;
}

// Returns exact {material, salesOffice} pairs — never re-expands a signal's
// material to other offices of that material.
//
// Priority order:
//   1. Materials the user explicitly mentioned by number — always included,
//      regardless of signals.
//   2. Otherwise, scan ALL known material+sales_office combinations in the
//      dataset (not just ones tied to an existing signal) — ranked by total
//      recent-relevant volume so the most substantial pairs are checked
//      first. This avoids silently skipping a material just because it
//      never happened to trip a business rule.
//   3. Signals are still used, but only as a TIE-BREAKER / priority boost —
//      a pair linked to an existing signal is ranked slightly higher when
//      volumes are close, since it's more likely to be relevant to the
//      question — never as a hard filter that excludes everything else.
function pickCandidatePairs(question, rows, signals, intent) {
  const officesByMaterial = new Map();
  const totalsByPair = new Map(); // key: "material|office" -> forecast tons
  const knownMaterials = new Set();

  for (const r of rows) {
    const material = Number(r.material);
    const office = Number(r.sales_office);
    knownMaterials.add(material);
    if (!officesByMaterial.has(material)) officesByMaterial.set(material, new Set());
    officesByMaterial.get(material).add(office);
    const key = pairKey(material, office);
    const f = r.sales_free_stock_in_tons || 0;
    totalsByPair.set(key, (totalsByPair.get(key) || 0) + f);
  }

  // 1. Explicit mentions always win, regardless of signals or volume.
  const mentioned = extractMentionedMaterials(question, knownMaterials);
  if (mentioned.length) {
    const pairs = [];
    for (const material of mentioned.slice(0, MAX_CANDIDATE_MATERIALS)) {
      for (const salesOffice of [...(officesByMaterial.get(material) || [])].slice(0, MAX_OFFICES_PER_MATERIAL)) {
        pairs.push({ material, salesOffice });
      }
    }
    return pairs.slice(0, MAX_CANDIDATE_PAIRS);
  }

  // 2. Build a signal-boost lookup — pairs tied to a signal get ranked up,
  // but this no longer excludes pairs with no signal at all.
  const signalPairKeys = new Set(
    (signals || []).map((s) => pairKey(Number(s.material), Number(s.salesOffice)))
  );
  // For forecast-driver / geographic questions, further boost pairs whose
  // signal specifically indicates a rise — same intent as before, just no
  // longer a hard requirement.
  const risingPairKeys = new Set(
    (intent.forecastDriver || intent.geographic ? risingSignalsFirst(signals || []) : [])
      .map((s) => pairKey(Number(s.material), Number(s.salesOffice)))
  );

  // 3. Rank ALL known material+office pairs by volume, boosted if linked to
  // a signal (and further boosted if linked to a rising signal when relevant).
  const ranked = [...totalsByPair.entries()]
    .map(([key, tons]) => {
      let score = tons;
      if (signalPairKeys.has(key)) score *= 3; // boost, not a filter
      if (risingPairKeys.has(key)) score *= 2; // extra boost for rising-signal relevance
      return { key, score };
    })
    .sort((a, b) => b.score - a.score);

  const pairs = [];
  for (const { key } of ranked) {
    const sep = key.lastIndexOf("|");
    const material = Number(key.slice(0, sep));
    const salesOffice = Number(key.slice(sep + 1));
    pairs.push({ material, salesOffice });
    if (pairs.length >= MAX_CANDIDATE_PAIRS) break;
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
    const key = pairKey(material, salesOffice);
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
  return [...byKey.values()].filter((m) => m.totals.recent > 0);
}

function topEntries(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ---- per-material derived metrics ------------------------------------------
// Every "strength" score used for ranking multiplies the share by a volume
// dampener (min(1, tons / LOW_VOLUME_TONS)) so a 100%-share finding built on
// near-zero tons doesn't outrank a smaller-share finding built on real
// volume. Low-volume findings are still returned (never hard-filtered), just
// ranked lower and labelled.

function concentrationMetric(m) {
  const top = topEntries(m.byCustomer.recent, 3);
  if (!top.length) return null;
  const top3Share = top.reduce((s, [, v]) => s + v, 0) / m.totals.recent;
  const lowVolume = m.totals.recent < LOW_VOLUME_TONS;
  const strength = top3Share * Math.min(1, m.totals.recent / LOW_VOLUME_TONS);
  return { topCustomer: top[0][0], topCustomerShare: top[0][1] / m.totals.recent, top3Share, lowVolume, strength };
}

function newCustomersMetric(m) {
  const hist = m.byCustomer.historical;
  const entries = [...m.byCustomer.recent.entries()].filter(([c]) => !hist.has(c));
  if (!entries.length) return null;
  const newTons = entries.reduce((s, [, v]) => s + v, 0);
  const share = newTons / m.totals.recent;
  const top = entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_LISTED);
  const lowVolume = m.totals.recent < LOW_VOLUME_TONS;
  const strength = share * Math.min(1, m.totals.recent / LOW_VOLUME_TONS);
  return { share, count: entries.length, top, lowVolume, strength };
}

function lostCustomersMetric(m) {
  if (m.totals.historical <= 0) return null;
  const recent = m.byCustomer.recent;
  const candidates = [...m.byCustomer.historical.entries()]
    .filter(([c, v]) => v / m.totals.historical >= 0.05 && !(recent.get(c) > 0))
    .map(([customer, tons]) => ({ customer, tons, share: tons / m.totals.historical, lowVolume: tons < LOW_VOLUME_TONS }))
    // Prefer the strongest historical customers by absolute volume first,
    // not just by share — a 100%-share customer with 0.001t historical
    // demand is not "important" in the same sense as one with real volume.
    .sort((a, b) => b.tons - a.tons)
    .slice(0, MAX_LISTED);
  if (!candidates.length) return null;
  const totalLostTons = candidates.reduce((s, c) => s + c.tons, 0);
  const strength = (totalLostTons / m.totals.historical) * Math.min(1, totalLostTons / LOW_VOLUME_TONS);
  return { candidates, lowVolume: totalLostTons < LOW_VOLUME_TONS, strength };
}

function geographicMetric(m) {
  if (m.totals.recent <= 0) return null;
  const recentTop = topEntries(m.byCountry.recent, MAX_LISTED);
  const shifts = recentTop.map(([country, tons]) => {
    const recentShare = tons / m.totals.recent;
    const histTons = m.byCountry.historical.get(country) || 0;
    const histShare = m.totals.historical > 0 ? histTons / m.totals.historical : 0;
    return { country, recentTons: tons, recentShare, delta: recentShare - histShare, isNew: histTons === 0, lowVolume: tons < LOW_VOLUME_TONS };
  });
  const strongest = shifts.reduce((best, s) => (s.delta > (best?.delta ?? -Infinity) ? s : best), null);
  if (!strongest || strongest.delta < 0.1) return null;
  const strength = strongest.delta * Math.min(1, m.totals.recent / LOW_VOLUME_TONS);
  return { shifts: shifts.sort((a, b) => b.delta - a.delta), strength };
}

// ---- rendering: underlying_sales sections ----------------------------------

const pct = (n) => `${(n * 100).toFixed(0)}%`;
// For ratios that round to 0% but aren't actually zero (e.g. coverage of
// 0.3%) — "<1%" reads honestly, "0%" reads as "none", which is misleading.
const pctFine = (n) => (n > 0 && n < 0.01 ? "<1%" : pct(n));
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
  const base = `  - material ${m.material}, sales office ${m.salesOffice}: recent demand ${t(m.totals.recent)}${r.lowVolume ? " (low-volume)" : ""}; top customer ${r.topCustomer} = ${pct(r.topCustomerShare)} of it; top 3 customers = ${pct(r.top3Share)}.`;
  const fc = m.forecastChange;
  let tail;
  if (fc?.isRising) {
    tail = ` CONFIRMED: this same material and sales office also shows a forecast increase (+${(fc.changePct * 100).toFixed(0)}% vs 12 months ago) — concentration and demand shift match at the same sales office.`;
  } else if (fc?.isFalling) {
    tail = ` CONFIRMED: this same material and sales office also shows a forecast decline (${(fc.changePct * 100).toFixed(0)}% vs 12 months ago) — concentration and demand shift match at the same sales office.`;
  } else {
    tail = " No corroborating forecast shift found for this material/sales office in the current planning data.";
  }
  return base + tail;
}

// Extract a tons figure from a signal's snapshot comparable to underlying_sales
// `quantity_in_tons` sums, so we can flag when the customer-level breakdown
// covers only a sliver of the actual forecast volume (i.e. isn't
// representative of what actually drove the increase).
function signalForecastTons(s) {
  const snap = s?.snapshot;
  if (!snap) return null;
  if (snap.kind === "mom_change") return snap.currVal;
  if (snap.kind === "deviation") return snap.plan;
  if (snap.kind === "new_demand") return snap.plan;
  return null;
}

function lowCoverageCaveat(m, signal) {
  const forecastTons = signalForecastTons(signal);
  if (!forecastTons || forecastTons <= 0) return "";
  const coverage = m.totals.recent / forecastTons;
  if (coverage >= 0.1) return "";
  return ` Limitation: the underlying_sales customer breakdown (${t(m.totals.recent)}) covers only ~${pctFine(coverage)} of the signal's forecast volume (${forecastTons.toFixed(2)}t) — treat this as a partial, low-volume indication, not a full explanation of the increase.`;
}

// Forecast-driver framing is deliberately more cautious than the plain
// concentration+shift case (renderConcentration): we only ever measure a
// customer's share of recent underlying-order demand, never their specific
// contribution to the SIZE of the forecast increase — so the causal claim
// must stay hedged ("appears associated with"/"may be customer-driven"),
// never "confirmed", regardless of how strong the concentration share looks.
function renderConcentrationForDriver(m, r) {
  const fc = m.forecastChange;
  const changeTxt = fc.isNew ? "new demand (no forecast 12 months ago)" : `+${(fc.changePct * 100).toFixed(0)}% vs 12 months ago`;
  const base = `  - material ${m.material}, sales office ${m.salesOffice}: forecast increase detected (${changeTxt}); top customer ${r.topCustomer} = ${pct(r.topCustomerShare)} of recent underlying-order demand (${t(m.totals.recent)}${r.lowVolume ? ", low-volume" : ""}); top 3 customers = ${pct(r.top3Share)}.`;
  const caveat = " This is an indication, not proof, that customer concentration drove the increase — the backend measures each customer's share of recent order volume, not their specific contribution to the size of the increase itself. Describe the link as 'appears to be' or 'may be' customer-driven, not confirmed.";
  return base + caveat;
}

function renderNewCustomers(m, r) {
  const names = r.top.map(([c, v]) => `${c} (${t(v)})`).join(", ");
  const volTag = r.lowVolume ? " This is a low-volume finding — treat as a minor signal, not confirmed stable demand." : "";
  return `  - material ${m.material}, sales office ${m.salesOffice}: ${r.count} new customer(s) vs. the historical period, contributing ${pct(r.share)} of recent demand (${t(m.totals.recent)}).${volTag} Top new: ${names}.`;
}

function renderLostCustomers(m, r) {
  const names = r.candidates.map((c) => `${c.customer} (${t(c.tons)}, ${pct(c.share)} of historical demand${c.lowVolume ? ", low-volume" : ""})`).join(", ");
  const severity = r.lowVolume
    ? "minor, low-volume dormant customer(s) — not a major loss given the small historical volume"
    : "previously significant customer(s) with ~no recent demand";
  return `  - material ${m.material}, sales office ${m.salesOffice} (current recent demand: ${t(m.totals.recent)}): ${severity}: ${names}.`;
}

function renderGeographic(m, r) {
  const parts = r.shifts
    .filter((s) => s.delta > 0)
    .map((s) => `${s.country}${s.isNew ? " (new)" : ""} now ${pct(s.recentShare)} of recent demand (${t(s.recentTons)}${s.lowVolume ? ", low-volume" : ""})`)
    .join(", ");
  const fc = m.forecastChange;
  const causal = fc?.isRising
    ? ` This material/sales office also shows a forecast increase (${fc.isNew ? "new demand, no forecast 12 months ago" : `+${(fc.changePct * 100).toFixed(0)}% vs 12 months ago`}) — the geographic shift appears likely associated with it, though this is an indication rather than proof of causation.`
    : " I cannot confirm this geographic movement caused a forecast increase for this material/sales office — the planning data does not show a matching forecast increase at the same sales office.";
  return `  - material ${m.material}, sales office ${m.salesOffice}: growing/new regions — ${parts}.${causal}`;
}

// ---- demand-type mix: computed directly from sales_operations_tool rows ---
// No Mongo round trip needed — ROWS are already in memory (data.js), and each
// row carries both its current planning fields and its own trailing
// historic_sales_12_* reference. Independent of underlying_sales and of
// dashboard signals, so it never has to say "data unavailable".

function typeMixForRow(r) {
  const curr = {
    free_stock: r.sales_free_stock_in_tons || 0,
    contract: r.sales_contracts_in_tons || 0,
    scheduling_agreement: r.sales_scheduling_agreement_in_tons || 0,
  };
  const hist = {
    free_stock: r.historic_sales_12_free_stock_in_tons || 0,
    contract: r.historic_sales_12_contracts_in_tons || 0,
    scheduling_agreement: r.historic_sales_12_scheduling_agreement_in_tons || 0,
  };
  const currTotal = curr.free_stock + curr.contract + curr.scheduling_agreement;
  const histTotal = hist.free_stock + hist.contract + hist.scheduling_agreement;
  if (currTotal < MIN_TYPEMIX_TONS || histTotal < MIN_TYPEMIX_TONS) return null;

  const volumeChangePct = (currTotal - histTotal) / histTotal;
  if (Math.abs(volumeChangePct) >= 0.25) return null; // not "stable volume"

  const shares = ["free_stock", "contract", "scheduling_agreement"].map((type) => ({
    type,
    currShare: curr[type] / currTotal,
    histShare: hist[type] / histTotal,
    delta: curr[type] / currTotal - hist[type] / histTotal,
  }));
  const maxDelta = Math.max(...shares.map((s) => Math.abs(s.delta)));
  if (maxDelta < 0.15) return null; // not a "major shift" in mix

  return { material: r.material, salesOffice: r.sales_office, month: r.date, shares, volumeChangePct, currTotal, histTotal, maxDelta };
}

function computeTypeMixFromRows(rows) {
  const bestByPair = new Map();
  for (const r of rows) {
    const result = typeMixForRow(r);
    if (!result) continue;
    const key = pairKey(Number(r.material), Number(r.sales_office));
    const existing = bestByPair.get(key);
    if (!existing || result.maxDelta > existing.maxDelta) bestByPair.set(key, result);
  }
  return [...bestByPair.values()].sort((a, b) => b.maxDelta - a.maxDelta);
}

function renderTypeMixResult(r) {
  const parts = r.shares.map((s) => `${s.type} ${pct(s.histShare)} -> ${pct(s.currShare)}`).join(", ");
  const volTxt = `${r.volumeChangePct >= 0 ? "+" : ""}${(r.volumeChangePct * 100).toFixed(0)}%`;
  return `  - material ${r.material}, sales office ${r.salesOffice} (${String(r.month).slice(0, 10)}): total volume change ${volTxt} (current ${r.currTotal.toFixed(1)}t vs. historic-12mo ${r.histTotal.toFixed(1)}t) while mix shifted: ${parts}.`;
}

function renderTypeMixSection(rows) {
  const results = computeTypeMixFromRows(rows).slice(0, MAX_RENDERED_MATERIALS);
  if (!results.length) {
    return "DEMAND-TYPE MIX SHIFT (calculated directly from sales_operations_tool, current vs. historic-12mo, per material + sales office):\nI compared current and historical demand-type mix, but did not find strong cases where total volume stayed stable while the mix shifted significantly.";
  }
  const lines = results.map(renderTypeMixResult);
  return `DEMAND-TYPE MIX SHIFT (calculated directly from sales_operations_tool, current vs. historic-12mo, per material + sales office):\n${lines.join("\n")}`;
}

// ---- public entry point -----------------------------------------------------

export async function buildSalesAnalysisContext(question, { rows, signals }) {
  const intent = detectSalesAnalysisIntent(question);
  if (!intent.any) return null;

  const sections = [];

  // Demand-type mix is entirely in-memory (sales_operations_tool) — no Mongo,
  // no dependency on dashboard signals, always answerable.
  if (intent.typeMix) {
    sections.push(renderTypeMixSection(rows));
  }

  const needsUnderlyingSales = intent.concentration || intent.newCustomers || intent.lostCustomers || intent.geographic;
  if (needsUnderlyingSales && storageBackend() === "mongo") {
    const pairs = pickCandidatePairs(question, rows, signals, intent);
    if (pairs.length) {
      let bounds, groupRows;
      try {
        bounds = await getPeriodBounds();
        groupRows = await fetchGroupedDemand(pairs, bounds);
      } catch (e) {
        console.log("sales analysis query failed:", e.message);
        groupRows = null;
      }

      if (groupRows?.length) {
        const materialMetrics = foldByMaterial(groupRows);
        enrichWithForecastChange(materialMetrics, rows);

        const fmt = (d) => d.toISOString().slice(0, 10);
        sections.push(
          `Recent period: ${fmt(bounds.recentStart)} to ${fmt(bounds.maxDate)}. Historical comparison period: ${fmt(bounds.historicalStart)} to ${fmt(bounds.recentStart)}. Source: underlying_sales order-level records, scoped to ${pairs.length} material/sales-office pair(s) relevant to this question.`
        );

        if (intent.concentration) {
          if (intent.forecastDriver) {
            const withRisingSignal = materialMetrics.filter((m) => m.forecastChange?.isRising);
            const rendered = rankAndRender(withRisingSignal, concentrationMetric, renderConcentrationForDriver, "FORECAST INCREASE — CUSTOMER CONCENTRATION");
            sections.push(
              rendered ||
                "FORECAST INCREASE — CUSTOMER CONCENTRATION:\nI found forecast increases, but I do not have enough matching customer-level evidence to confirm that they are driven by a single customer or small customer group."
            );
          } else {
            sections.push(
              rankAndRender(
                materialMetrics, concentrationMetric, renderConcentration,
                "CUSTOMER CONCENTRATION (a large share of recent demand comes from one or a few customers)"
              )
            );
          }
        }
        if (intent.newCustomers) {
          sections.push(rankAndRender(materialMetrics, newCustomersMetric, renderNewCustomers, "NEW CUSTOMERS (recent vs. historical period)"));
        }
        if (intent.lostCustomers) {
          sections.push(rankAndRender(materialMetrics, lostCustomersMetric, renderLostCustomers, "LOST / DORMANT HISTORICAL CUSTOMERS"));
        }
        if (intent.geographic) {
          const rendered = rankAndRender(materialMetrics, geographicMetric, renderGeographic, "GEOGRAPHIC DEMAND SHIFT (by recipient country)");
          sections.push(
            rendered ||
              "GEOGRAPHIC DEMAND SHIFT: I did not find a material/sales-office pair with a significant geographic shift in the current scope of this question."
          );
        }
      }
    }
  }

  const rendered = sections.filter(Boolean);
  return rendered.length ? rendered.join("\n\n") : null;
}
