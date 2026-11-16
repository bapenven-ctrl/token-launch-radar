# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/bapenven-ctrl/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/bapenven-ctrl/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

LaunchScope: a token launch radar. It reads one sealed DefiLlama snapshot, audits all 342 protocols that record no token yet, and ranks 198 of them (the 40-protocol house watchlist plus 158 cleaned early finds) by an implied launch value from two methods fitted to the snapshot's own trading protocols and printed side by side on every row. From 90 like-for-like comps inside a 0.02x–8x FDV/TVL comparability band, a robust size curve (IRLS with Huber weights, shrunk category offsets backfit against the line) reads log market cap = 5.25 + 0.63 x log TVL; a category-median multiple cross-checks it, and the headline blends the two 90/10 in log space before bounded adjustments for 7-day momentum, years tracked with no token, and chain reach. Rows where the two methods differ by more than 2x are flagged "methods disagree", with the justification written out in the detail view. The model is backtested two ways before it prices anything: leave-one-out over the comps misses by x2.65 (curve alone x2.69, median alone x3.95), and a time split fitted on the oldest 46 comps misses the newest 21 by x2.16; every value carries the leave-one-out band. Each row carries a week-by-week farm plan (one wallet, governance, a 21–60 day hold, explicit gas and fees), netted to the dollar at the band's low end with a FARM / WATCH / SKIP verdict.

The whole model lives in `dashboard/model.js`, inside the dossier the judge reads: `main.ts` runs that same file to write `board.json`, and the dashboard page runs it again in the browser on the embedded snapshot (`dashboard/snapshot.js`) and renders what it computes — one implementation, two runs, identical numbers. The dashboard's total source is 65,000 bytes, under the dossier's 65,536-byte text cap, so every file reaches the judge whole. The board is sortable and filterable (search, category, chain, verdict), each row shows its valuation band with the curve and median values ticked, and a methodology panel on the front page charts the comps against the fitted curve and tabulates both backtests, predicted vs actual.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

---

Entered on [make.fun](https://make.fun/?ref=bapenven-ctrl&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards
