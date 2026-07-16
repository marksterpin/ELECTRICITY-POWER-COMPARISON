#!/usr/bin/env node
/* ============================================================
 * Cyber Financial — Energy Plan Harvester (hardened)
 * ------------------------------------------------------------
 * Pulls generic electricity + gas + dual plan data from the AER /
 * Victorian DEECA Energy Product Reference Data (CDR) APIs and
 * writes a trimmed, state-sharded JSON feed for the comparison
 * tool. All PRD is served centrally, path-prefixed per retailer:
 *   GET https://cdr.energymadeeasy.gov.au/<code>/cds-au/v1/energy/plans
 *   GET .../energy/plans/{planId}
 *
 * Reliability features (why this version exists):
 *   - Per-request TIMEOUT via AbortController — no hung worker.
 *   - High CONCURRENCY on the per-plan detail fetch (the slow part;
 *     nationally this is tens of thousands of calls).
 *   - Global TIME BUDGET — stops fetching before the Action times
 *     out and always writes what it has.
 *   - INCREMENTAL writes — shards are flushed after every retailer,
 *     so a cancel/timeout still leaves a usable, committed feed.
 *   - Per-retailer version cache — negotiate x-v once, not per plan.
 *   - State pre-filter from the list summary — scoped runs skip
 *     detail fetches for out-of-scope states.
 *
 * Node 18+ (built-in fetch). Zero npm dependencies.
 *
 * Usage:
 *   node harvest.js                     # all retailers, all states
 *   node harvest.js --state=QLD         # only QLD plans (fast)
 *   node harvest.js --state=QLD,NSW
 *   node harvest.js --limit=5           # first 5 retailers only (smoke test)
 *   node harvest.js agl origin          # only these retailer codes
 *   node harvest.js --state=QLD agl     # combine
 *
 * Env overrides (used by the workflow):
 *   HARVEST_MINUTES     time budget, default 50
 *   HARVEST_CONCURRENCY parallel detail fetches, default 20
 *   HARVEST_TIMEOUT_MS  per-request timeout, default 15000
 * ============================================================ */

const fs = require("fs");
const path = require("path");

const ENDPOINTS_JSON =
  "https://raw.githubusercontent.com/jxeeno/energy-cdr-prd-endpoints/main/docs/energy-prd-endpoints.json";
const CENTRAL_HOST = "https://cdr.energymadeeasy.gov.au";
const OUT_DIR = path.join(__dirname, "data");

const CONCURRENCY = parseInt(process.env.HARVEST_CONCURRENCY || "20", 10);
const TIMEOUT_MS  = parseInt(process.env.HARVEST_TIMEOUT_MS || "15000", 10);
const BUDGET_MIN  = parseInt(process.env.HARVEST_MINUTES || "50", 10);
const DETAIL_START_V = 3;
const PAGE_SIZE = 1000;

const START = Date.now();
const DEADLINE = START + BUDGET_MIN * 60000;
const timeLeft = () => DEADLINE - Date.now();
const elapsed = () => ((Date.now() - START) / 1000).toFixed(0);
const outOfTime = () => Date.now() > DEADLINE;

/* ---------- CLI args ---------- */
const argv = process.argv.slice(2);
const flags = {};
const codesArg = [];
argv.forEach((a) => {
  if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); flags[k] = v === undefined ? true : v; }
  else codesArg.push(a);
});
const stateFilter = flags.state ? String(flags.state).toUpperCase().split(",") : null;
const retailerLimit = flags.limit ? parseInt(flags.limit, 10) : null;
const maxPlansPerRetailer = flags["max-plans"] ? parseInt(flags["max-plans"], 10) : null;

/* ---------- Seed (fallback if discovery fails) ---------- */
const SEED = ["agl","origin","energyaustralia","alinta","engie","red-energy","momentum",
  "powershop","globird","ovo-energy","nectr","tango","sumo-power","actewagl","aurora",
  "diamond","energy-locals","1st-energy","simply-energy","lumo","ergon","amber"];

/* ---------- Distributor -> state ---------- */
const NETWORK_STATE = [
  [/energex|ergon/i, "QLD"],
  [/ausgrid|endeavour|essential/i, "NSW"],
  [/citipower|powercor|united energy|jemena|ausnet/i, "VIC"],
  [/sa power|sapn/i, "SA"],
  [/evoenergy|actewagl/i, "ACT"],
  [/tasnetworks|aurora/i, "TAS"]
];
function deriveState(distributors, postcodes) {
  if (Array.isArray(distributors)) {
    for (const d of distributors) for (const [re, st] of NETWORK_STATE) if (re.test(String(d))) return st;
  }
  if (Array.isArray(postcodes) && postcodes.length) {
    const pc = parseInt(String(postcodes[0]).slice(0, 4), 10);
    if (pc >= 4000 && pc <= 4999) return "QLD";
    if ((pc >= 2000 && pc <= 2599) || (pc >= 2620 && pc <= 2899)) return "NSW";
    if (pc >= 3000 && pc <= 3999) return "VIC";
    if (pc >= 5000 && pc <= 5799) return "SA";
    if (pc >= 2600 && pc <= 2619) return "ACT";
    if (pc >= 7000 && pc <= 7799) return "TAS";
  }
  return "UNKNOWN";
}
function summaryState(summary) {
  const geo = summary.geography || {};
  return deriveState(geo.distributors || [], geo.includedPostcodes || geo.postcodes || []);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- fetch with timeout + retry ---------- */
async function fetchJSON(url, xv, tries = 3) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "x-v": String(xv), Accept: "application/json" },
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (res.status === 406) { const h = res.headers.get("x-v"); return { _406: true, hint: h ? parseInt(h, 10) : null }; }
      if (res.status === 429 || res.status >= 500) { await sleep(600 * (attempt + 1)); continue; }
      if (!res.ok) return { _err: res.status };
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      if (attempt === tries - 1) return { _err: e.name === "AbortError" ? "timeout" : "network" };
      await sleep(400 * (attempt + 1));
    }
  }
  return { _err: "exhausted" };
}

/* ---------- list plans (x-v 1), all fuels, state pre-filter ---------- */
async function listPlans(base) {
  const seen = new Set();
  const out = [];
  for (const fuel of ["ELECTRICITY", "GAS", "DUAL"]) {
    let page = 1, pages = 1;
    do {
      if (outOfTime()) return out;
      const url = `${base}/cds-au/v1/energy/plans?type=ALL&fuelType=${fuel}&effective=CURRENT&page=${page}&page-size=${PAGE_SIZE}`;
      const j = await fetchJSON(url, 1);
      if (j._406 || j._err) break;
      const plans = (j.data && j.data.plans) || [];
      for (const p of plans) {
        if (seen.has(p.planId)) continue;
        if (stateFilter && !stateFilter.includes(summaryState(p))) continue; // skip detail for out-of-scope
        seen.add(p.planId); out.push(p);
      }
      pages = (j.meta && j.meta.totalPages) || 1;
      page++;
    } while (page <= pages && page <= 50);
  }
  return out;
}

/* ---------- plan detail with per-retailer version cache ---------- */
async function planDetail(base, planId, verCache) {
  if (verCache.v) {
    const j = await fetchJSON(`${base}/cds-au/v1/energy/plans/${encodeURIComponent(planId)}`, verCache.v);
    if (!j._406 && !j._err) return j.data || j;
    if (j._err) return null;
    // fall through to renegotiate if the cached version stopped working
  }
  let v = DETAIL_START_V;
  while (v >= 1) {
    const j = await fetchJSON(`${base}/cds-au/v1/energy/plans/${encodeURIComponent(planId)}`, v);
    if (j._406) { v = j.hint && j.hint < v ? j.hint : v - 1; continue; }
    if (j._err) return null;
    verCache.v = v;
    return j.data || j;
  }
  return null;
}

/* ---------- concurrency pool with deadline ---------- */
async function pool(items, worker, concurrency) {
  const results = [];
  let i = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      if (outOfTime()) return;
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ---------- normalise (elec + gas) ---------- */
function trimContract(c) {
  return c ? {
    pricingModel: c.pricingModel, isFixed: c.isFixed, benefitPeriod: c.benefitPeriod,
    contractLength: c.contractLength, coolingOffDays: c.coolingOffDays,
    tariffPeriod: c.tariffPeriod || [], controlledLoad: c.controlledLoad || [],
    solarFeedInTariff: c.solarFeedInTariff || [], discounts: c.discounts || [],
    incentives: c.incentives || [], greenPowerCharges: c.greenPowerCharges || [],
    fees: c.fees || [], eligibility: c.eligibility || []
  } : null;
}
function normalise(brandName, summary, detail) {
  const ec = (detail && detail.electricityContract) || null;
  const gc = (detail && detail.gasContract) || null;
  const geo = (detail && detail.geography) || (summary && summary.geography) || {};
  const distributors = geo.distributors || geo.distributorList || [];
  const postcodes = geo.includedPostcodes || geo.postcodes || [];
  const fuelType = summary.fuelType || (detail && detail.fuelType) || (ec && gc ? "DUAL" : gc ? "GAS" : "ELECTRICITY");
  return {
    planId: summary.planId || (detail && detail.planId),
    brandName: brandName || summary.brandName || summary.brand,
    retailer: brandName || summary.brandName || summary.brand,
    displayName: summary.displayName || (detail && detail.displayName) || summary.planName || "Plan",
    fuelType, type: summary.type || (detail && detail.type) || "MARKET",
    customerType: summary.customerType || (detail && detail.customerType) || "RESIDENTIAL",
    planUrl: (detail && detail.planUrl) || summary.applicationUri || null,
    geography: { state: deriveState(distributors, postcodes), distributors, postcodeCount: postcodes.length || null },
    electricityContract: trimContract(ec),
    gasContract: trimContract(gc)
  };
}

/* ---------- discovery ---------- */
async function discoverRetailers() {
  try {
    const j = await fetch(ENDPOINTS_JSON).then((r) => r.json());
    const arr = j.data || j;
    const list = (arr || [])
      .filter((d) => d.productReferenceDataBaseUri)
      .map((d) => ({ base: d.productReferenceDataBaseUri.replace(/\/$/, ""), brand: d.brandName || null }))
      .filter((x) => /cdr\.energymadeeasy\.gov\.au/.test(x.base));
    if (list.length) { console.log(`Discovered ${list.length} energy retailers.`); return list; }
  } catch (e) { console.warn("Auto-discovery failed, using seed:", e.message); }
  return SEED.map((c) => ({ base: `${CENTRAL_HOST}/${c}`, brand: null }));
}

/* ---------- flush shards + index (incremental) ---------- */
function flush(byState, diag, partial) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const shards = [];
  let total = 0;
  for (const st of Object.keys(byState)) {
    const file = `plans-${st}.json`;
    fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify({ state: st, plans: byState[st] }));
    shards.push(file); total += byState[st].length;
  }
  const index = {
    generated: new Date().toISOString(),
    source: "AER / Victorian DEECA Energy Product Reference Data (CDR)",
    partial: !!partial, elapsedSeconds: +elapsed(), totalPlans: total,
    states: Object.fromEntries(Object.entries(byState).map(([k, v]) => [k, v.length])),
    shards
  };
  fs.writeFileSync(path.join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "_diagnostics.txt"), diag.join("\n"));
  return total;
}

/* ---------- main ---------- */
async function main() {
  console.log(`Config: concurrency=${CONCURRENCY} timeout=${TIMEOUT_MS}ms budget=${BUDGET_MIN}min` +
    (stateFilter ? ` states=${stateFilter.join(",")}` : "") + (retailerLimit ? ` limit=${retailerLimit}` : ""));

  let retailers = await discoverRetailers();
  if (codesArg.length) retailers = retailers.filter((r) => codesArg.some((c) => r.base.endsWith("/" + c)));
  if (retailerLimit) retailers = retailers.slice(0, retailerLimit);

  const byState = {};
  const diag = [];
  let done = 0;

  for (const { base, brand } of retailers) {
    if (outOfTime()) { console.log(`\n[budget reached at ${elapsed()}s] stopping early.`); break; }
    const code = base.split("/").pop();
    process.stdout.write(`\n[${++done}/${retailers.length}] ${code} listing… `);
    const summaries = await listPlans(base);
    if (!summaries.length) { process.stdout.write("0 in scope"); diag.push(`${code}: 0`); continue; }
    let list = summaries;
    if (maxPlansPerRetailer) list = list.slice(0, maxPlansPerRetailer);
    process.stdout.write(`${list.length} plans, detail…`);

    const verCache = {};
    let ok = 0;
    const details = await pool(list, async (s) => {
      const d = await planDetail(base, s.planId, verCache);
      return d ? normalise(brand || s.brandName, s, d) : null;
    }, CONCURRENCY);

    details.forEach((n) => {
      const hasE = n && n.electricityContract && n.electricityContract.tariffPeriod.length;
      const hasG = n && n.gasContract && n.gasContract.tariffPeriod.length;
      if (!hasE && !hasG) return;
      ok++;
      const st = n.geography.state || "UNKNOWN";
      (byState[st] = byState[st] || []).push(n);
    });
    diag.push(`${code}: ${summaries.length} listed, ${ok} usable`);
    const runningTotal = flush(byState, diag, done < retailers.length); // checkpoint after each retailer
    process.stdout.write(` -> ${ok} usable (total ${runningTotal}, ${elapsed()}s, ${Math.max(0, (timeLeft()/60000)).toFixed(0)}min left)`);
  }

  const total = flush(byState, diag, false);
  console.log(`\n\nDone in ${elapsed()}s. ${total} usable plans across ${Object.keys(byState).length} states.`);
  console.log("States:", JSON.stringify(Object.fromEntries(Object.entries(byState).map(([k, v]) => [k, v.length]))));
  console.log(`Written to ${OUT_DIR}/ (index.json + shards).`);
}

main().catch((e) => { console.error("Harvest failed:", e); process.exit(1); });
