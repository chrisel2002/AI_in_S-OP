# S&OP Signal Dashboard — MERN app

Natural-language → rules → scored signals on the real S&OP plan data.
**M**ongoDB · **E**xpress · **R**eact · **N**ode.

## Run it (two terminals)

**Terminal 1 — backend (Express API on :4000)**
```bash
cd server
npm install        # first time only
npm run dev
```

**Terminal 2 — frontend (React/Vite on :5173)**
```bash
cd client
npm install        # first time only
npm run dev
```

Open **http://localhost:5173**. The Vite dev server proxies `/api/*` to the backend.

> MongoDB is optional to start: if it isn't running, rules are saved to
> `server/rules_fallback.json` and the sidebar shows "local file ⚠️". Signals
> always work (read straight from the cleaned CSV).

## Use it
1. Click **+ Add rule** → type a sentence (e.g. *"Flag when forecast sales are above 20 tons per material"*).
2. Click **✨ Generate rule** → the editable card appears (dropdowns + threshold).
3. Adjust anything → **💾 Save rule**. It becomes an active rule and generates its own signals.
4. The dashboard shows KPIs, charts, the AI briefing, and the prioritised signal table.
   Click **Suggest** on any row for reasoning + suggested actions.

## Turn on real MongoDB
```bash
brew tap mongodb/brew && brew install mongodb-community
brew services start mongodb-community
```
Restart the backend — the log will say "MongoDB connected ✅".
Optionally load the plan data into Mongo too: `cd server && npm run load`.

## Architecture
```
client/  React (Vite)        — Proto-1 signal dashboard + rule builder
server/  Express + Node      — REST API:
  src/data.js       loads cleaned CSV into memory
  src/signals.js    signal engine (4 built-in detectors + custom rules)
  src/parser.js     sentence -> rule (MOCK; swap to LLM later)
  src/briefing.js   narrative summary
  src/store.js      rule persistence (MongoDB + file fallback)
  src/index.js      routes & boot
```

## Built-in signal types (on your real data)
| Type | Logic |
|------|-------|
| Forecast deviation | Demand plan vs Actuals-12M reference, > ±20% |
| Demand surge / drop | Month-over-month change in the plan, > ±30% |
| Stockout risk | Inventory < 1t while demand ≥ 5t |
| New demand | Plan ≥ 5t where there is no 12/24M sales history |

Thresholds live in `server/src/signals.js` (`MIN_TONS`, the ±20%/±30% cutoffs).
These are exactly the knobs the rule builder is meant to let planners control.

## Going live with the LLM
Implement `parseWithLLM` in `server/src/parser.js` (e.g. the OpenAI API), feed it the
column names, ask for JSON matching the rule shape, then flip `USE_LLM = true`.
Nothing else changes.
```
