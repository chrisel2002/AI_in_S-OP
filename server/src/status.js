import mongoose from "mongoose";

function col() {
  return mongoose.connection.db.collection("signal_status");
}

export async function getAllStatuses() {
  const docs = await col().find({}).toArray();
  return Object.fromEntries(
    docs.map((d) => [d.key, { status: d.status, note: d.note || null, updatedAt: d.updatedAt }])
  );
}

export async function upsertStatus(key, { status, note = null }) {
  await col().updateOne(
    { key },
    { $set: { key, status, note, updatedAt: new Date() } },
    { upsert: true }
  );
}

export async function removeStatus(key) {
  await col().deleteOne({ key });
}
