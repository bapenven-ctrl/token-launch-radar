# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/bapenven-ctrl/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/bapenven-ctrl/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

LaunchScope: a token launch radar. It reads one sealed DefiLlama snapshot, audits all 342 protocols that record no token yet, and ranks 198 of them (the 40-protocol house watchlist plus 158 cleaned early finds) by an implied launch value read off a size curve fitted to the snapshot's own trading protocols: 102 like-for-like comps set log market cap = 3.99 + 0.69 x log TVL, with a shrunk category offset, then bounded adjustments for 7-day momentum, years tracked with no token, and chain reach. The fit is backtested leave-one-out on its own comps — the median miss is x3.04 — and every value is printed with that band. Each row carries a concrete five-step farm plan with costs and times, netted to the dollar at the band's low end with a FARM / WATCH / SKIP verdict. The dashboard is static and offline: a sortable, filterable board (including by verdict), a detail view per protocol with the netting broken out, and the comps evidence set shown apart, never ranked.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

---

Entered on [make.fun](https://make.fun/?ref=bapenven-ctrl&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards
