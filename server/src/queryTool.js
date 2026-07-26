// Safe MongoDB query execution layer for the agentic chat tool.
// The LLM generates aggregation pipelines; this module validates and runs them.
import mongoose from "mongoose";
import { storageBackend } from "./store.js";

const ALLOWED_COLLECTIONS = new Set(["underlying_sales", "sales_operations_tool"]);
const BLOCKED_OPERATORS = ["$where", "$function", "$accumulator", "$code", "$expr.$function"];
const MAX_ROWS = 100;
const QUERY_TIMEOUT_MS = 10000;

function validatePipeline(pipeline) {
  if (!Array.isArray(pipeline)) throw new Error("pipeline must be a JSON array");
  const str = JSON.stringify(pipeline);
  for (const op of BLOCKED_OPERATORS) {
    if (str.includes(`"${op}"`)) throw new Error(`Operator ${op} is not permitted`);
  }
}

export async function runQuery(collection, pipeline) {
  if (!ALLOWED_COLLECTIONS.has(collection)) {
    throw new Error(`Unknown collection "${collection}". Allowed: ${[...ALLOWED_COLLECTIONS].join(", ")}`);
  }
  if (storageBackend() !== "mongo") throw new Error("Database not connected — cannot run query");
  validatePipeline(pipeline);

  // Ensure there's always a row cap — append $limit only if the pipeline
  // doesn't already end with one.
  const safePipeline = [...pipeline];
  const last = safePipeline[safePipeline.length - 1];
  if (!last || !("$limit" in last)) safePipeline.push({ $limit: MAX_ROWS });

  const results = await mongoose.connection.db
    .collection(collection)
    .aggregate(safePipeline)
    .maxTimeMS(QUERY_TIMEOUT_MS)
    .toArray();

  // Strip internal Mongo _id from results to keep the payload clean.
  const cleaned = results.map(({ _id, ...rest }) => (Object.keys(rest).length ? rest : { _id }));

  return {
    collection,
    rowCount: cleaned.length,
    cappedAt: cleaned.length === MAX_ROWS ? MAX_ROWS : null,
    results: cleaned,
  };
}

// ---- Tool definition (OpenAI function-calling schema) ----------------------

export const QUERY_TOOL = {
  type: "function",
  function: {
    name: "query_database",
    description: `Run a MongoDB aggregation pipeline against the live S&OP database to answer any data question.
Use this whenever the pre-computed context doesn't contain the specific numbers, breakdowns, or comparisons the question needs.

COLLECTIONS:

1. "underlying_sales"  — actual order-level records
   Key fields:
   - material        (int)         — material number
   - sales_office    (int)         — sales office code
   - customer        (string)      — customer ID
   - recipient_country (string)    — 2-letter country code (e.g. "DE", "CZ")
   - date            (ISODate)     — order date; use ISODate strings in $gte/$lte, e.g. new Date("2026-01-01")
   - quantity_in_tons (float)      — order quantity
   - is_contract     (bool)
   - is_scheduling_agreement (bool)
   - simulated_plant (int), historic_plant (int)

2. "sales_operations_tool"  — monthly planning/forecast rows (one row = material + plant + sales_office + month)
   Key fields:
   - material, plant, sales_office  (string or int — compare with $eq after casting if needed)
   - date            (ISODate)     — planning month; horizon ~2026-06 to 2027-05
   - sales_free_stock_in_tons, sales_contracts_in_tons, sales_scheduling_agreement_in_tons (float)
   - historic_sales_12_free_stock_in_tons, historic_sales_12_contracts_in_tons, historic_sales_12_scheduling_agreement_in_tons (float)
   - historic_sales_24_*  (float)
   - historic_inventory_12_free_stock_in_tons, historic_inventory_24_free_stock_in_tons (float)

TIPS:
- Always $group + $sum/$avg/$count to summarise; avoid returning raw rows unless the user explicitly wants individual records.
- For top-N results add { $sort: { value: -1 } }, { $limit: N } at the end.
- Dates in underlying_sales are ISODate. In aggregation use: { $gte: new Date("2025-01-01") }
- You can run multiple sequential queries (one tool call at a time) if you need to refine after seeing results.
- Results are capped at ${MAX_ROWS} rows. If the result says cappedAt: ${MAX_ROWS}, your aggregation needs more grouping.`,
    parameters: {
      type: "object",
      required: ["collection", "pipeline"],
      properties: {
        collection: {
          type: "string",
          enum: ["underlying_sales", "sales_operations_tool"],
          description: "Which collection to query",
        },
        pipeline: {
          type: "array",
          description: "MongoDB aggregation pipeline — array of stage objects e.g. [{$match:...},{$group:...}]",
          items: { type: "object" },
        },
      },
    },
  },
};
