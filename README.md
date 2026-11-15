# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/bapenven-ctrl/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/bapenven-ctrl/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

LaunchScope: a token launch radar. It reads one sealed DefiLlama snapshot, ranks 180 protocols that record no token yet by an implied launch value — TVL times the FDV/TVL multiple that already-trading protocols in the same category carry in the same snapshot, adjusted for 7-day momentum, years tracked with no token, and chain reach — and gives every row a concrete five-step farm plan with costs and times. The dashboard is static and offline: a sortable, filterable board, a detail view per protocol, and the live-token evidence set shown apart, never ranked.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

---

Entered on [make.fun](https://make.fun/?ref=bapenven-ctrl&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards
