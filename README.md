<<<<<<< HEAD
This contains the codebase for the project AI in Supply and operations planning with the integration of LLM
=======
# AI in S&OP — Signal Dashboard

A collaboration with **ThyssenKrupp** that turns raw Sales & Operations Planning (S&OP)
data into a prioritized, explainable **signal dashboard**. Planners get automatic
detection of forecast risks (deviations, demand spikes/drops, stockouts, new demand),
can define their own detection **rules** in plain English or a visual builder, and can
ask an AI assistant questions about the live data — all grounded in the real planning
figures, not a black box.

---

## Tech stack

| Layer | Technology |
|---|---|
| Data cleaning | Python 3, **pandas**, **numpy** |
| Database | **MongoDB** (Mongoose ODM), with a local JSON-file fallback so the app runs without Mongo |
| Backend | **Node.js**, **Express** (REST API), ES modules |
| Frontend | **React 18**, **Vite**, plain CSS, `lucide-react` icons |
| AI / LLM | **UniGPT** (OpenAI-compatible gateway, `mistral-small` by default) — used for rule parsing, briefings, chat, and suggestions |

This is a **MERN**-style stack (MongoDB, Express, React, Node), fronted by a small
Python ETL step that prepares the source data.

---

## Repository layout

```
AI_in_S-OP/
├─ Data/                        raw input CSVs (S&OP tool export, underlying sales docs)
├─ src/
│  └─ data_cleaning.py          Python ETL: cleans column names, fixes decimal/date
│                               formats, dedupes, fills missing values
├─ outputs/                     cleaned CSVs produced by data_cleaning.py
│
├─ server/                      Express API
│  ├─ src/
│  │  ├─ index.js               routes, boot sequence, in-memory signal cache
│  │  ├─ data.js                loads plan rows (Mongo primary, CSV fallback) into memory
│  │  ├─ signals.js             signal engine: built-in detectors + custom-rule evaluation
│  │  ├─ parser.js              natural language → structured rule (UniGPT, with a
│  │  │                         keyword-based mock fallback if no API key is set)
│  │  ├─ briefing.js            narrative "Planning Briefing" summary (template + LLM)
│  │  ├─ chat.js                builds grounded context + answers chat questions
│  │  ├─ suggest.js             per-signal "what should I do" suggested actions (LLM)
│  │  ├─ llm.js                 shared UniGPT chat-completion helper
│  │  ├─ status.js              signal status tracking (acknowledged / resolved / etc.)
│  │  └─ store.js               rule persistence — MongoDB, or a JSON file fallback
│  └─ scripts/
│     ├─ loadData.js            one-off: load the cleaned CSV into MongoDB
│     └─ reloadPlanData.js      re-import + backup the plan collection in Atlas
│
├─ client/                      React (Vite) dashboard
│  └─ src/
│     ├─ App.jsx                dashboard shell: KPIs, charts, briefing, signal table
│     ├─ RuleBuilder.jsx        manual + AI-assisted custom rule creation UI
│     ├─ Chat.jsx               AI chat assistant panel
│     ├─ api.js                 fetch wrappers for every backend endpoint
│     └─ styles.css             app styling
│
├─ requirements.txt             Python deps for the data-cleaning step
└─ RUN_MERN.md                  condensed quick-start (see this README for full detail)
```

---

## End-to-end workflow

**1. Data cleaning (Python, offline step)**
`src/data_cleaning.py` reads the two raw exports in `Data/`
(`S&OP_Tool_Displayed_Data.csv`, `Underlying_SalesDocuments.csv`), then:
- lowercases/normalizes column names,
- converts German-style comma decimals (`"1.234,5"`) to floats,
- parses dates,
- drops duplicates and fills missing categorical fields,
- writes the result to `outputs/cleaned_sop_tool_data.csv` and
  `outputs/cleaned_sales_documents.csv`.

**2. Loading the data**
The Express server reads the cleaned CSV directly into memory on boot
(`server/src/data.js`) — this is the source of truth for signal detection. If you also
want the data queryable inside MongoDB (e.g. for a grid view or the "underlying
orders" drill-down), run `npm run load` once, or use `scripts/reloadPlanData.js` to
refresh an existing Atlas collection.

**3. Signal detection (`server/src/signals.js`)**
Every plan row is grouped by *material + plant + sales office* and run through:
- **4 built-in detectors** — forecast deviation, month-over-month demand
  surge/drop, stockout risk, new demand with no sales history — each producing a
  0–10 **score**.
- **Custom rules** — any active rule (manual or AI-generated) is evaluated against
  every row; every match becomes its own signal.

Signals are sorted by score, cached in memory, and rebuilt automatically whenever a
rule is created, edited, deleted, or a planning value is changed.

**4. The dashboard API (`server/src/index.js`)**
`GET /api/dashboard` returns everything the UI needs in one call: KPI counts,
a score-distribution chart, a signal-type chart, a narrative briefing, and the
(paginated) signal list. Other endpoints handle rule CRUD, signal status, chat,
and AI extras (see [API reference](#api-reference) below).

**5. The React dashboard (`client/src/App.jsx`)**
Renders the KPI cards, charts, the **AI Planning Briefing** (clickable — mentions of
"Material X, Plant Y" jump to that signal row), and the signal table. Each row can be
expanded for the full reasoning, marked with a status (acknowledged/resolved/etc.),
edited inline (with the signal recalculated live), and can request **AI
recommendations** — concrete suggested changes to the plan, which can be applied
with one click.

**6. Rule creation (`client/src/RuleBuilder.jsx`)**
Two ways to define a new detection rule:
- **Manual** — build one or more condition groups (`metric` `operator` `threshold`,
  optionally as a % change vs. a baseline column), each group combined with
  ALL/ANY logic. Each group has its own **0–10 score slider**; the rule's overall
  severity is auto-calculated (the worst/highest score across groups) and shown on
  a **score card**, so a single rule can express different severity levels depending
  on which condition group actually fired.
- **AI-assisted** — describe the rule in plain English (e.g. *"Flag as high severity
  when forecast sales are more than 20% above historic 12-month sales per
  material"*). The sentence is sent to `parser.js`, which asks UniGPT for both a
  structured rule *and* a formula-based version in parallel, and falls back to a
  keyword-based mock parser if no LLM key is configured.

Saved rules are persisted via `server/src/store.js` (MongoDB, or a local
`rules_fallback.json` if Mongo isn't reachable) and immediately feed back into the
signal engine.

**7. AI chat assistant (`client/src/Chat.jsx` → `/api/chat`)**
`chat.js` builds a compact, grounded context (dataset size, active signals, active
rules, top materials/plants) and forwards the conversation to UniGPT, so answers are
always tied to the current dataset rather than generic advice.

---

## Scoring model

Every signal (built-in or custom) carries a **score from 0 to 10**, used consistently
everywhere in the app (KPI cards, chart buckets, priority pills, rule severity):

| Score | Priority / Severity |
|---|---|
| ≥ 8 | **High** |
| ≥ 5 (and < 8) | **Medium** |
| < 5 | **Low** |

For custom rules built with the condition builder, each group's slider score is
saved, and the rule's stored score is the **maximum across its groups** (i.e. the
rule fires at at least its worst-case severity, whichever group's conditions match).

## Built-in signal detectors

| Signal type | Trigger logic |
|---|---|
| Forecast deviation | Demand plan vs. the 12-month historic-actuals reference deviates more than ±20% |
| Demand surge / drop | Month-over-month change in the plan exceeds ±30% |
| Stockout risk | Inventory < 1 ton while demand ≥ 5 tons |
| New demand | Plan ≥ 5 tons for a material/plant with no 12- or 24-month sales history |

Thresholds (`MIN_TONS`, ±20%, ±30%) live in `server/src/signals.js` — these are the
knobs the rule builder is designed to eventually expose to planners directly.

## AI-powered features

| Feature | Endpoint | Notes |
|---|---|---|
| Natural-language rule parsing | `POST /api/parse` | Falls back to a keyword mock parser if `UNIGPT_API_KEY` isn't set |
| Prompt clarity check | `POST /api/validate-prompt` | Asks the LLM if a rule description is specific enough before parsing |
| Executive briefing | `GET /api/briefing` | On-demand richer LLM version of the always-on template briefing |
| Chat assistant | `POST /api/chat` | Answers grounded in the live dataset, signals, and rules |
| Suggested actions | `POST /api/suggest` | 3 concrete actions for one signal, using its real underlying orders |
| AI recommendations | `POST /api/dashboard/signals/:id/ai-recommendations` | Suggests plan-value changes, applicable with one click |

If `USE_LLM=false` or no API key is configured, all of the above degrade gracefully
(template briefing, mock parser, empty recommendation lists) — the core dashboard and
signal engine never depend on the LLM being available.

## API reference

| Method & path | Purpose |
|---|---|
| `GET /api/dashboard` | KPIs, charts, briefing, paginated signals |
| `GET /api/signals` | All signals, unpaginated (CSV export) |
| `GET /api/orders` | Underlying historic sales orders for a signal (Mongo only) |
| `POST /api/validate-prompt` | Check if a rule sentence is clear enough |
| `POST /api/parse` | Sentence → structured rule draft |
| `GET /api/briefing` | LLM-generated executive briefing |
| `POST /api/chat` | Ask a grounded question |
| `POST /api/suggest` | Suggested actions for one signal |
| `GET/POST/PUT/DELETE /api/rules` | Custom rule CRUD |
| `GET/PUT/DELETE /api/signal-status/:key` | Track acknowledged/resolved status per signal |
| `PATCH /api/dashboard/signals/:id` | Edit a plan value, recalculate its signal |
| `POST /api/dashboard/signals/:id/ai-recommendations` | AI-suggested plan changes |
| `GET /api/debug` | Rule hit-counts and totals, for troubleshooting |

---

## Getting started

### 1. (Optional) Re-run the data cleaning step

```bash
pip install -r requirements.txt
python src/data_cleaning.py
```

The repo already ships with cleaned CSVs in `outputs/`, so this is only needed if the
raw files in `Data/` change.

### 2. Configure the backend

```bash
cd server
cp .env.example .env     # then fill in MONGO_URI and (optionally) UNIGPT_API_KEY
npm install
```

Key environment variables (`server/.env`):

| Variable | Purpose |
|---|---|
| `MONGO_URI` | MongoDB connection string. If unreachable, rules fall back to a local JSON file (signals still work — they read the CSV directly) |
| `PORT` | API port (default `4000`) |
| `DATA_FILE` | Path to the cleaned plan CSV |
| `UNIGPT_API_KEY` / `UNIGPT_BASE_URL` / `UNIGPT_MODEL` | UniGPT (OpenAI-compatible) credentials for all AI features |
| `USE_LLM` | Set to `false` to force the deterministic fallbacks even with a key configured |

### 3. Run it (two terminals)

```bash
# Terminal 1 — backend, http://localhost:4000
cd server && npm run dev

# Terminal 2 — frontend, http://localhost:5173
cd client && npm install && npm run dev
```

Open **http://localhost:5173** — the Vite dev server proxies `/api/*` to the backend.

### 4. Use it

1. The dashboard loads with KPIs, charts, an AI briefing, and the signal table.
2. Click **+ Add rule** → choose **Manual** (condition builder) or **AI-assisted**
   (describe it in plain English) → adjust → **Save rule**.
3. New signals from your rule appear immediately in the table and charts.
4. Click any signal row for full reasoning, suggested actions, and AI
   recommendations; use the chat panel to ask questions about the dataset.

---

## Notes for contributors

- The signal cache in `server/src/index.js` rebuilds automatically after any rule
  mutation or planning-value edit — no manual cache invalidation needed elsewhere.
- `migrateRules()` runs once at boot to normalize any rules saved in older formats
  (label-based baselines, string thresholds, etc.).
- All score-based thresholds (priority pills, KPI counts, chart buckets, rule
  severity) are intentionally kept on the same 0–10 scale and the same `≥8 / ≥5`
  boundaries — if you add a new place that classifies a score, match this convention.
>>>>>>> feature/mern-signal-dashboard
