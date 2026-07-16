# Cyber Financial — Energy Plan Comparison Tool

Single-file offline HTML comparison tool for Australian **electricity, gas, and
dual-fuel** plans, plus a nightly harvester that feeds it live data from the AER
/ Victorian DEECA Energy Product Reference Data (CDR) APIs — the same source as
Energy Made Easy and Victoria Energy Compare.

## Files

| File | Role |
|------|------|
| `cyber-financial-energy-comparison.html` | The app. Runs standalone offline on embedded **sample data**. Point it at a harvested feed for live plans. |
| `harvest.js` | Node 18+ harvester (zero npm deps). Pulls all electricity/gas/dual plans, negotiates CDR API versions, shards by state, writes `data/`. |
| `update-energy.yml` | GitHub Actions workflow. Runs the harvester nightly and commits `data/`. |

## What it does

- **Fuel toggle:** electricity, gas, or dual fuel. Dual compares bundled plans on
  combined electricity + gas cost.
- **Postcode lookup:** resolves your state reliably, and auto-selects the network
  where it's unambiguous (single-network states + QLD's Energex/Ergon split). NSW
  gives a best-effort metro suggestion; VIC is left to "all networks" because its
  five distributors split Melbourne by suburb, not postcode — so it never
  silently filters you to the wrong network.
- **Usage-based cost engine:** the cheapest plan depends on *your* usage.
  Electricity handles single-rate, block, and time-of-use tariffs, controlled
  load, solar feed-in credits, and GreenPower. Gas is billed per **MJ** with
  declining-block rates.

## How it works

Energy PRD is served centrally, path-prefixed per retailer:

```
GET https://cdr.energymadeeasy.gov.au/<code>/cds-au/v1/energy/plans          (x-v: 1)
GET https://cdr.energymadeeasy.gov.au/<code>/cds-au/v1/energy/plans/{planId} (x-v: 2+)
```

Two reasons the app doesn't call these directly from the browser: CORS blocks it,
and the volume is huge (AGL alone lists ~1,300+ plans nationally). So the
harvester runs server-side, does the two-step list→detail fetch for all fuel
types across all ~78 AER-approved retailers, trims each plan (both its
electricity and gas contracts) to what the tool needs, and shards by state.

## Deploy (same pattern as the PHI tool)

1. Create a public repo with these three files at the root, renaming the app to
   `index.html`.
2. Put the workflow at `.github/workflows/update-energy.yml`.
3. **Settings → Actions → General → Workflow permissions → Read and write.**
   (Without this the commit step 403s.)
4. Enable GitHub Pages from the `main` branch root.
5. **First run — start scoped, not national.** A full national harvest is tens of
   thousands of per-plan detail calls. Don't run it blind first. From the Actions
   tab → Run workflow, set **scope** to something small to prove the pipeline in
   ~1–2 minutes:
   - `--state=QLD` — just your state
   - `--limit=5` — first 5 retailers only
   - `agl origin` — just those retailers

   Confirm `data/index.json` was committed and the app loads it, then run again
   with a blank scope for the full national feed.
6. In `index.html`, set `CONFIG.RAW_BASE` to your Pages data path, e.g.
   `"https://<user>.github.io/<repo>/data"`. Leave it empty to stay on sample data.

## Troubleshooting

**"It ran for 13 minutes and never finished."** That's the detail-fetch volume,
not a hang. The harvester now has a **time budget** (`HARVEST_MINUTES`, default
100 in the workflow): when it's reached it stops fetching and writes whatever it
has, so you always get a usable — if partial — feed, and the job never runs to
the timeout with nothing to show. `index.json` reports `"partial": true` when a
run was cut short. Each retailer is checkpointed to disk as it completes, so even
a cancelled run leaves committed data.

**Make it faster.** Raise `HARVEST_CONCURRENCY` (default 20) — this is the biggest
lever, since the per-plan detail fetch is the bottleneck. The central AER host
tolerates it well; if you start seeing 429s in the log, ease it back down.

**Nothing committed / "can't deploy."** Check three things: repo **Settings →
Actions → General → Workflow permissions → Read and write** is enabled; the run
actually produced `data/` (see the log's final line); and Pages is set to deploy
from the `main` branch root. The commit step runs `if: always()` so a partial
feed still gets pushed.

**A retailer hangs.** Every request now has a `HARVEST_TIMEOUT_MS` (default 15s)
abort, so one slow endpoint can no longer stall a worker indefinitely.

## Cost engine notes (verify against a live feed)

- **Units.** Live AER feeds publish prices in **cents** (e.g. supply `"92.00"`
  c/day, electricity `"33.58"` c/kWh, gas `~4.5` c/MJ), but the CDS docs show
  dollar examples. The engine auto-detects per value (`toDollars()`), converting
  to dollars internally. The per-kWh/MJ threshold sits at 1.5 so small solar
  feed-in tariffs (e.g. 5c) aren't misread as dollars. Confirm the convention
  against your first live pull.
- **Stepped/block rates** with a daily reset period (`P1D`) are approximated by
  scaling the volume threshold to annual — fine for the common flat and
  time-of-use cases; block tariffs are rare in residential.
- **Conditional discounts** (e.g. pay-on-time) are shown separately and are not
  included in the headline cost, since they depend on the customer meeting the
  condition.
- Figures are **estimates**, not quotes. Always confirm on the retailer's Basic
  Plan Information Document before switching.
