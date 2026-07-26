// Loads the cleaned S&OP plan data into memory once at startup.
// Primary source: MongoDB (collection `sales_operations_tool`). Fallback: the CSV.
// 76k rows fit comfortably in memory; signal detection then runs over this array.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLAN_COLLECTION = "sales_operations_tool";

// dates may arrive as JS Date (from Mongo) or string (from CSV) -> "YYYY-MM-DD"
function normalizeDate(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

// numeric columns we want parsed as floats
const NUMERIC = new Set([
  "historic_sales_12_free_stock_in_tons",
  "historic_sales_12_contracts_in_tons",
  "historic_sales_12_scheduling_agreement_in_tons",
  "historic_sales_24_free_stock_in_tons",
  "historic_sales_24_contracts_in_tons",
  "historic_sales_24_scheduling_agreement_in_tons",
  "sales_free_stock_in_tons",
  "sales_contracts_in_tons",
  "sales_scheduling_agreement_in_tons",
  "historic_inventory_12_free_stock_in_tons",
  "historic_inventory_24_free_stock_in_tons",
]);

let ROWS = [];

export function loadData() {
  const file = process.env.DATA_FILE
    ? path.resolve(__dirname, "../", process.env.DATA_FILE)
    : path.resolve(__dirname, "../../outputs/cleaned_sop_tool_data.csv");

  const text = fs.readFileSync(file, "utf8").trim();
  const lines = text.split("\n");
  const header = lines[0].split(",");

  ROWS = lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    header.forEach((col, i) => {
      const raw = cells[i];
      row[col] = NUMERIC.has(col) ? parseFloat(raw) || 0 : raw;
    });
    row.date = normalizeDate(row.date);
    return row;
  });

  console.log(`Loaded ${ROWS.length.toLocaleString()} plan rows from ${path.basename(file)}`);
  return ROWS;
}

// Primary loader: read the plan data straight from MongoDB Atlas.
// Assumes mongoose is already connected (see store.initStore).
export async function loadDataFromMongo() {
  const coll = mongoose.connection.db.collection(PLAN_COLLECTION);
  console.log("  fetching plan rows from Atlas...");
  const docs = await coll.find({}).maxTimeMS(60000).toArray();
  console.log(`  received ${docs.length.toLocaleString()} documents, mapping...`);
  ROWS = docs.map((d) => {
    const row = { ...d, _id: String(d._id), date: normalizeDate(d.date) };
    for (const col of NUMERIC) row[col] = Number(row[col]) || 0;
    return row;
  });
  console.log(`Loaded ${ROWS.length.toLocaleString()} plan rows from MongoDB.${PLAN_COLLECTION}`);
  return ROWS;
}

export function getRows() {
  return ROWS;
}

// Patch one in-memory row after a MongoDB update, so the signal cache stays
// consistent without a full reload. Only updates the fields that were changed.
export function updateRowById(id, fields) {
  const idx = ROWS.findIndex((r) => r._id === String(id));
  if (idx !== -1) ROWS[idx] = { ...ROWS[idx], ...fields };
}
