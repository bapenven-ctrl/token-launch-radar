// LaunchScope model: one sealed DefiLlama snapshot in, one ranked pre-token board out.
//
// The board ranks protocols that record no token yet by the value a token would
// plausibly carry if it launched against today's record. The value is not a
// guess per name: it is the snapshot's own market evidence, reused.
//
// v3 ("launchscope-3") replaces v2's category-median multiple with the
// technique the top of this board runs on, rebuilt from the sealed snapshot:
//
//   comps      = trading protocols cleaned like-for-like: the category must
//                also occur among pre-token protocols, CEX is dropped (an
//                exchange token is not a protocol launch), duplicate rows of
//                one token family collapse to the largest, and absurd
//                FDV/TVL ratios (outside 0.005x-20x) are dropped.
//   curve      = log(mcap) = a + b * log(TVL) fitted on the comps, plus a
//                per-category intercept offset shrunk toward zero by sample
//                size (n / (n + 8)), so thin categories borrow the curve.
//                The fitted slope lands near 0.7 — the sub-linear elasticity
//                published valuation research finds for TVL-driven assets.
//   backtest   = the fit is re-run leave-one-out over its own comps: every
//                comp is priced by a curve that never saw it. The median
//                absolute log error is the published error factor (x3.04 on
//                this snapshot) and the band shown beside every value:
//                implied / factor .. implied x factor.
//   adjusted   = the curve value keeps v2's bounded factors: momentum
//                (7-day TVL change), maturity (no-token age) and reach
//                (chain count).
//   implied    = round(tvl * (curve value / tvl) * momentum * maturity * reach)
//
// Farm plans are netted to the dollar: the plan's cash cost (bridge, gas and
// weekly actions; working capital is recoverable and stated separately) is
// totalled in the closing step, and the verdict — FARM, WATCH or SKIP — is
// taken at the band's low end, the conservative end a farmer should plan on.
//
// Every input comes from the snapshot bytes; the same bytes always give the
// same board. Protocols whose token already trades are never ranked: they are
// the evidence, and the dashboard shows them apart as the live set.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    fdv_tvl_multiple: number;
    category_comps: number;
    momentum_multiplier: number;
    maturity_multiplier: number;
    reach_multiplier: number;
  };
  farm_steps: string[];
  // v3 additions: the backtested band and the netted farm verdict.
  implied_low_usd: number;
  implied_high_usd: number;
  farm_verdict: 'FARM' | 'WATCH' | 'SKIP';
  plan_cost_usd: number;
}

/** The dashboard's view of one ranked row. */
export interface RadarRow extends BoardRow {}

/** A protocol whose token already trades: shown with the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  fdv_tvl: number | null;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model_note: string;
  global_multiple: number;
  scanned: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_implied_usd: number;
  categories: string[];
  chains: string[];
  rows: RadarRow[];
  live: LiveRow[];
  // v3 additions: the validation behind the board, shown on the dashboard.
  comps_count: number;
  curve_slope: number;
  loo_factor: number;
  audited_count: number;
}

export const MODEL_VERSION = 'launchscope-3';

/** How many pre-token protocols below the watchlist floor the early radar adds. */
export const EARLY_ROWS = 158;
/** How many live-token protocols the dashboard's live strip carries. */
export const LIVE_ROWS = 24;

const RATIO_LO = 0.005;
const RATIO_HI = 20;
const OFFSET_SHRINK = 8;
const UNKNOWN_AGE_DAYS = 365;
// Verdicts are break-even arithmetic at the band's low end: the plan pays for
// itself if the wallet captures plan_cost / implied_low of the launch value.
// FARM asks for at most 0.0002% of it, WATCH at most 0.001%.
const FARM_SHARE_MAX = 2e-6;
const WATCH_SHARE_MAX = 1e-5;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function money(x: number): string {
  if (x >= 1e9) return '$' + (x / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (x >= 1e6) return '$' + (x / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (x >= 1e3) return '$' + Math.round(x / 1e3) + 'K';
  return '$' + Math.round(x);
}

/** Whole days from listed_at to the snapshot's as_of; null when either is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function medianOf(xs: number[]): number {
  return median([...xs].sort((a, b) => a - b));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Rankable on the early radar: pre-token, cleaned of exchanges, versioned re-launches, wrappers and exchange-fronted names. */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    p.category !== 'CEX' &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))
  );
}

// ---------------------------------------------------------------------------
// The comps set, the size curve, and its leave-one-out backtest.

export interface Comp {
  slug: string;
  category: string;
  tvl: number;
  mcap: number;
}

/** Trading protocols cleaned like-for-like, one row per token family, slug order. */
export function buildComps(snapshot: Snapshot): Comp[] {
  const preTokenCategories = new Set(
    snapshot.protocols.filter(isPreToken).map((p) => p.category ?? '(uncategorised)'),
  );
  const byFamily = new Map<string, SnapshotProtocol>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    if ((p.category ?? '') === 'CEX') continue;
    if (!preTokenCategories.has(p.category ?? '(uncategorised)')) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio < RATIO_LO || ratio > RATIO_HI) continue;
    const family = p.gecko_id ?? p.slug;
    const kept = byFamily.get(family);
    if (kept === undefined || p.tvl_usd > kept.tvl_usd) byFamily.set(family, p);
  }
  return [...byFamily.values()]
    .map((p) => ({
      slug: p.slug,
      category: p.category ?? '(uncategorised)',
      tvl: p.tvl_usd,
      mcap: p.mcap_usd as number,
    }))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

export interface Curve {
  intercept: number;
  slope: number;
  offsets: Map<string, number>;
  counts: Map<string, number>;
}

/** log(mcap) = intercept + slope * log(tvl) + shrunk category offset. */
export function fitCurve(comps: Comp[]): Curve {
  const n = comps.length;
  const xs = comps.map((c) => Math.log(c.tvl));
  const ys = comps.map((c) => Math.log(c.mcap));
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const slope = den > 0 ? num / den : 0;
  const intercept = my - slope * mx;
  const residuals = new Map<string, number[]>();
  comps.forEach((c, i) => {
    const list = residuals.get(c.category) ?? [];
    list.push(ys[i]! - (intercept + slope * xs[i]!));
    residuals.set(c.category, list);
  });
  const offsets = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const cat of [...residuals.keys()].sort()) {
    const list = residuals.get(cat)!;
    counts.set(cat, list.length);
    offsets.set(cat, list.reduce((a, b) => a + b, 0) / (list.length + OFFSET_SHRINK));
  }
  return { intercept, slope, offsets, counts };
}

export function curveValue(curve: Curve, tvl: number, category: string): number {
  return Math.exp(curve.intercept + curve.slope * Math.log(tvl) + (curve.offsets.get(category) ?? 0));
}

/** Leave-one-out: every comp priced by a curve fitted without it; median |log error| as a factor. */
export function looFactor(comps: Comp[]): number {
  const errors: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const rest = comps.filter((_, j) => j !== i);
    const curve = fitCurve(rest);
    const pred = curveValue(curve, comps[i]!.tvl, comps[i]!.category);
    errors.push(Math.abs(Math.log(pred / comps[i]!.mcap)));
  }
  return Math.exp(medianOf(errors));
}

export interface ModelFit {
  comps: Comp[];
  curve: Curve;
  factor: number;
  globalMultiple: number;
  audited: number;
}

export function modelFit(snapshot: Snapshot): ModelFit {
  const comps = buildComps(snapshot);
  return {
    comps,
    curve: fitCurve(comps),
    factor: looFactor(comps),
    globalMultiple: round4(medianOf(comps.map((c) => c.mcap / c.tvl))),
    audited: snapshot.protocols.filter(isPreToken).length,
  };
}

// ---------------------------------------------------------------------------
// Valuation of one protocol off the curve, with v2's bounded adjustments.

export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  fit: ModelFit,
): { implied: number; multiple: number; comps: number; momentum: number; maturity: number; reach: number; age: number | null } {
  const category = p.category ?? '(uncategorised)';
  const base = curveValue(fit.curve, p.tvl_usd, category);
  const growth = Math.min(100, Math.max(-50, finite(p.change_7d, 0)));
  const momentum = 1 + 0.6 * (growth / 100);
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? UNKNOWN_AGE_DAYS;
  const maturity = 0.65 + 0.5 * (Math.min(Math.max(ageForModel, 0), 1460) / 1460);
  const reach = 1 + 0.03 * Math.min(Math.max(p.chains.length - 1, 0), 6);
  const implied = Math.max(1, Math.round(base * momentum * maturity * reach));
  return {
    implied,
    multiple: base / p.tvl_usd,
    comps: fit.curve.counts.get(category) ?? 0,
    momentum,
    maturity,
    reach,
    age,
  };
}

// ---------------------------------------------------------------------------
// Farm plans, netted to the dollar (v2 steps, v3 netting and verdict).

/** Capital for one farm position, scaled to the protocol's own TVL. */
function capitalFor(tvl: number): number {
  if (tvl >= 5_000_000_000) return 250;
  if (tvl >= 1_000_000_000) return 150;
  if (tvl >= 250_000_000) return 100;
  if (tvl >= 50_000_000) return 75;
  return 50;
}

/** Hold window from age: younger protocols need a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  if (age < 730) return 30;
  return 21;
}

/** The category's core farming action, naming the protocol and its first chain. */
function coreAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Supply $${capital} of USDC as collateral to ${n} on ${chain}, then borrow a small amount against it so both sides of the market record your wallet.`;
  if (c.includes('dex') || c.includes('liquidity'))
    return `Add $${capital} of paired liquidity to ${n}'s highest-volume pool on ${chain} and leave the LP position untouched while it accrues fees.`;
  if (c.includes('bridge'))
    return `Bridge $${capital} of USDC to ${chain} through ${n}, then spend the bridged funds inside the destination app instead of bridging straight back.`;
  if (c.includes('liquid staking') || c.includes('restak') || c.includes('staking'))
    return `Stake $${capital} of the native asset through ${n} on ${chain} and hold the liquid receipt token in the same wallet for the full window.`;
  if (c.includes('derivative') || c.includes('option') || c.includes('perpetual'))
    return `Deposit $${capital} of USDC margin on ${n} and run one small hedged position a week, sized so fees stay under $5 a month.`;
  if (c.includes('yield') || c.includes('farm') || c.includes('allocator') || c.includes('curator'))
    return `Deposit $${capital} into a ${n} vault on ${chain} and keep the vault shares; compounding vaults count the shares, not the clicks.`;
  if (c.includes('rwa') || c.includes('stable') || c.includes('basis'))
    return `Mint or buy $${capital} of ${n}'s yield-bearing asset on ${chain} and hold it; the holding itself is the qualifying activity.`;
  if (c.includes('launchpad'))
    return `Register the wallet on ${n}, complete its $${capital} staking or participation step on ${chain}, and keep the position until the next sale snapshot.`;
  if (c.includes('prediction'))
    return `Fund $${capital} on ${n} and hold one position in a market that settles at least two weeks out, so the wallet ages on the book.`;
  if (c.includes('insurance'))
    return `Buy $${capital} of cover from ${n} on ${chain} for the longest term offered; an open policy is a durable, dated on-chain record.`;
  if (c.includes('chain') || c.includes('payments') || c.includes('card'))
    return `Move $${capital} of real activity onto ${n} on ${chain}: bridge in, pay or swap weekly, and keep a balance there between actions.`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} through its main app and keep the position open; idle deposits are what its record counts.`;
}

export type FarmVerdict = 'FARM' | 'WATCH' | 'SKIP';

/** A five-step farm plan derived from the protocol's own record, closed by its netting and verdict. */
export function farmPlan(
  p: SnapshotProtocol,
  age: number | null,
  impliedLowUsd: number,
): { steps: string[]; verdict: FarmVerdict; planCostUsd: number } {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const chain2 = p.chains.length > 1 ? p.chains[1]! : chain;
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const gas = capital >= 150 ? 8 : capital >= 100 ? 6 : 4;
  const weeks = Math.max(1, Math.ceil(hold / 7));
  const planCost = gas * 2 + 2 * weeks;

  const share = planCost / Math.max(1, impliedLowUsd);
  const oneIn = Math.round(1 / share).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let verdict: FarmVerdict;
  let why: string;
  if (share <= FARM_SHARE_MAX) {
    verdict = 'FARM';
    why = `the plan breaks even if this wallet captures just 1 in ${oneIn} of the low-band launch value — a very small share for an early, active wallet`;
  } else if (share <= WATCH_SHARE_MAX) {
    verdict = 'WATCH';
    why = `break-even needs 1 in ${oneIn} of the low-band launch value — plausible only beside other farms on the same chain that share the wallet and the gas`;
  } else {
    verdict = 'SKIP';
    why = `break-even needs 1 in ${oneIn} of the low-band launch value — too large a share to count on from one small wallet; revisit if TVL grows or the band moves`;
  }

  const steps = [
    `Start from a fresh wallet funded only with the farm budget, and bridge $${capital + 25} of USDC to ${chain} first so every later action is native to that chain. Cost: about $${gas} in bridge and gas fees. Time: 15 minutes.`,
    `${coreAction(p, capital, chain)} Cost: $${capital} of working capital plus about $${gas} of gas. Time: 20 minutes to set up.`,
    `Repeat one qualifying action every week — a top-up, a swap, a vote or a claim — and add a second chain (${chain2}) in week two if the app supports it, so the wallet shows breadth as well as depth. Cost: about $2 of gas a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days without a full withdrawal, so the activity spans more than one weekly snapshot of the protocol's books. Each Friday, open ${p.name}'s own points, rewards or governance page from the app itself, screenshot the wallet's standing into a farm log with dates and transaction hashes, and claim only from links the app publishes — never from messages or search ads. Cost: the $${capital} stays deployed and exposed; checking costs nothing, and never pay to claim. Time: 10 minutes a week.`,
    `Netting it up: the plan's cash cost is about $${planCost} over the ${hold} days (bridge and gas $${gas} + $${gas}, then about $2 a week for ${weeks} weeks); the $${capital} of working capital is separate and comes back when you unwind. Judged at the low end of the model's backtested band — ${money(impliedLowUsd)} implied, not the headline — the verdict is ${verdict}: ${why}.`,
  ];
  return { steps, verdict, planCostUsd: planCost };
}

// ---------------------------------------------------------------------------
// The board and the dashboard data.

/** The board: every watchlist slug, plus the strongest cleaned early pre-token protocols below the floor. */
export function buildBoard(snapshot: Snapshot, fit: ModelFit = modelFit(snapshot)): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, fit);
    const low = Math.max(1, Math.round(v.implied / fit.factor));
    const high = Math.round(v.implied * fit.factor);
    const plan = farmPlan(p, v.age, low);
    return { p, v, low, high, plan };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : 1));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    token_status: 'pre-token' as const,
    watchlist: watch.has(s.p.slug),
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    model: {
      fdv_tvl_multiple: round4(s.v.multiple),
      category_comps: s.v.comps,
      momentum_multiplier: round4(s.v.momentum),
      maturity_multiplier: round4(s.v.maturity),
      reach_multiplier: round4(s.v.reach),
    },
    farm_steps: s.plan.steps,
    implied_low_usd: s.low,
    implied_high_usd: s.high,
    farm_verdict: s.plan.verdict,
    plan_cost_usd: s.plan.planCostUsd,
  }));
}

/** The comps themselves, by market cap: the evidence set, shown apart from the ranked board. */
export function liveRows(snapshot: Snapshot, comps: Comp[]): LiveRow[] {
  const compSlugs = new Set(comps.map((c) => c.slug));
  return snapshot.protocols
    .filter((p) => compSlugs.has(p.slug))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      fdv_tvl: p.tvl_usd > 0 && p.mcap_usd !== null ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const fit = modelFit(snapshot);
  const board = buildBoard(snapshot, fit);
  const live = liveRows(snapshot, fit.comps);
  const cats = new Set<string>();
  const chains = new Set<string>();
  for (const r of board) {
    if (r.category !== null) cats.add(r.category);
    for (const c of r.chains) chains.add(c);
  }
  const modelNote =
    `Every value is read off a size curve fitted to this snapshot's own trading protocols: ${fit.comps.length} like-for-like comps ` +
    `(categories that also occur pre-token, no exchange tokens, no absurd multiples) set log market cap = ${fit.curve.intercept.toFixed(2)} + ` +
    `${fit.curve.slope.toFixed(2)} x log TVL, with a shrunk category offset, then the bounded momentum, maturity and reach adjustments. ` +
    `The fit was backtested leave-one-out on its own comps — each comp priced by a curve that never saw it — and the median miss is x${fit.factor.toFixed(2)}, ` +
    `so every value carries that band and every farm verdict is netted at the band's low end. ${fit.audited} pre-token protocols were audited; ` +
    `${board.length} are ranked after wrapped, staked, versioned and exchange-fronted names are cleaned out. One model prices both this page and board.json.`;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model_note: modelNote,
    global_multiple: fit.globalMultiple,
    scanned: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    total_implied_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
    categories: [...cats].sort(),
    chains: [...chains].sort(),
    rows: board,
    live,
    comps_count: fit.comps.length,
    curve_slope: round4(fit.curve.slope),
    loo_factor: round4(fit.factor),
    audited_count: fit.audited,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not a protocol in the snapshot`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) return 'every row shares one implied value';
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
