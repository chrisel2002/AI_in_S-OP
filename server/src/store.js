// Rule persistence. Primary: MongoDB (collection `rules`). Fallback: local JSON
// file, so the app runs for a demo even before MongoDB is installed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK = path.resolve(__dirname, "../rules_fallback.json");

let backend = "file"; // becomes "mongo" if connection succeeds

const ruleSchema = new mongoose.Schema(
  {
    name: String,
    metric: String,
    comparison_type: String,
    baseline: String,
    operator: String,
    threshold: Number,
    group_by: [String],
    severity: String,
    raw_sentence: String,
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
const Rule = mongoose.model("Rule", ruleSchema);

export async function initStore(uri) {
  try {
    // Atlas cold connects (DNS SRV + TLS) can take a few seconds; give it room.
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    backend = "mongo";
    console.log("Storage: MongoDB connected ✅");
  } catch (e) {
    backend = "file";
    if (!fs.existsSync(FALLBACK)) fs.writeFileSync(FALLBACK, "[]");
    console.log("Storage: MongoDB unreachable — using local file fallback ⚠️");
    console.log("  reason:", e.message);
  }
}

export function storageBackend() {
  return backend;
}

const readFile = () => JSON.parse(fs.readFileSync(FALLBACK, "utf8") || "[]");
const writeFile = (r) => fs.writeFileSync(FALLBACK, JSON.stringify(r, null, 2));

export async function listRules() {
  if (backend === "mongo") return (await Rule.find().lean()).map(normalize);
  return readFile();
}

export async function insertRule(rule) {
  if (backend === "mongo") return normalize((await Rule.create(rule)).toObject());
  const rules = readFile();
  rule._id = crypto.randomUUID();
  rules.push(rule);
  writeFile(rules);
  return rule;
}

export async function updateRule(id, patch) {
  delete patch._id;
  if (backend === "mongo") return normalize((await Rule.findByIdAndUpdate(id, patch, { new: true }).lean()));
  const rules = readFile().map((r) => (String(r._id) === String(id) ? { ...r, ...patch } : r));
  writeFile(rules);
  return rules.find((r) => String(r._id) === String(id));
}

export async function deleteRule(id) {
  if (backend === "mongo") return void (await Rule.findByIdAndDelete(id));
  writeFile(readFile().filter((r) => String(r._id) !== String(id)));
}

function normalize(doc) {
  if (!doc) return doc;
  return { ...doc, _id: String(doc._id) };
}
