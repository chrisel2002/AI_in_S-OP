// Reloads the CORRECT cleaned plan CSV into Atlas `sales_operations_tool`.
// Backs up the existing collection first (-> sales_operations_tool_corrupted_backup),
// then replaces it. Run with: node scripts/reloadPlanData.js
import "dotenv/config";
import mongoose from "mongoose";
import { loadData, getRows } from "../src/data.js";

const INT_COLS = [
  "material", "material_group", "material_division",
  "plant", "plant_group", "sales_office", "sales_office_group",
];
const TARGET = "sales_operations_tool";
const BACKUP = "sales_operations_tool_corrupted_backup";

async function run() {
  // 1) read the correct cleaned CSV (floats parsed properly, German commas already fixed)
  loadData();
  const rows = getRows().map((r) => {
    const doc = { ...r };
    for (const c of INT_COLS) doc[c] = Number(doc[c]);
    doc.date = new Date(r.date); // store as Date to match the existing schema
    return doc;
  });

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  const db = mongoose.connection.db;

  // 2) back up the current (corrupted) collection
  const existing = await db.collection(TARGET).countDocuments();
  if (existing > 0) {
    await db.collection(TARGET).aggregate([{ $out: BACKUP }]).toArray();
    console.log(`Backed up ${existing.toLocaleString()} docs -> ${BACKUP}`);
  }

  // 3) replace with the correct data
  const coll = db.collection(TARGET);
  await coll.deleteMany({});
  for (let i = 0; i < rows.length; i += 5000) {
    await coll.insertMany(rows.slice(i, i + 5000));
  }
  console.log(`Reloaded ${rows.length.toLocaleString()} correct rows into ${TARGET}`);

  await mongoose.disconnect();
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
