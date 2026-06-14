// Optional: load the cleaned plan CSV into MongoDB (collection `plan_data`).
// Run once with `npm run load`. The API itself reads the CSV directly, so this
// is only needed if you want the plan data queryable in Mongo (e.g. for the grid view).
import "dotenv/config";
import mongoose from "mongoose";
import { loadData, getRows } from "../src/data.js";

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/sop";

async function run() {
  loadData();
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
  const coll = mongoose.connection.collection("plan_data");
  await coll.deleteMany({});
  const rows = getRows();
  // insert in batches to keep memory flat
  for (let i = 0; i < rows.length; i += 5000) {
    await coll.insertMany(rows.slice(i, i + 5000));
  }
  console.log(`Inserted ${rows.length.toLocaleString()} rows into plan_data`);
  await mongoose.disconnect();
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
