// LaunchScope model: one sealed DefiLlama snapshot in, one ranked pre-token board out.
//
// The board ranks protocols that record no token yet by the value a token would
// plausibly carry if it launched against today's record. The value is not a
// guess per name: it is the snapshot's own market evidence, reused.
//
//   comps        = every protocol in the snapshot whose token already trades,
//                  grouped by category; for each, ratio = mcap_usd / tvl_usd.
//   multiple(c)  = the category's median ratio, shrunk toward the global median
//                  by sample size ((n * med + 6 * global) / (n + 6)) and clamped
//                  to [0.04, 2.5], so a thin category cannot invent a price.
//   momentum     = 1 + 0.6 * clamp(change_7d, -50, 100) / 100
//   maturity     = 0.65 + 0.5 * min(age_days, 1460) / 1460   (unknown age: 365)
//   reach        = 1 + 0.03 * min(chains - 1, 6)
//   implied      = round(tvl_usd * multiple * momentum * maturity * reach)
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
}

export const MODEL_VERSION = 'launchscope-2';
export const MODEL_NOTE =
  'Implied value = TVL x the FDV/TVL multiple that already-trading protocols in the same category carry in this snapshot (category median, shrunk toward the global median by sample size), adjusted for 7-day TVL momentum, years tracked with no token, and chain reach. No name is special-cased, and no protocol that already trades is ranked.';

/** How many pre-token protocols below the watchlist floor the early radar adds. */
export const EARLY_ROWS = 140;
/** How many live-token protocols the dashboard's live strip carries. */
export const LIVE_ROWS = 24;

const SHRINK_K = 6;
const MULT_FLOOR = 0.04;
const MULT_CAP = 2.5;
const UNKNOWN_AGE_DAYS = 365;

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

/** The category evidence table: shrunk FDV/TVL multiples derived from the snapshot itself. */
export function categoryMultiples(snapshot: Snapshot): { global: number; byCategory: Map<string, { multiple: number; comps: number }> } {
  const all: number[] = [];
  const groups = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const key = p.category ?? '(uncategorised)';
    const arr = groups.get(key) ?? [];
    arr.push(ratio);
    groups.set(key, arr);
  }
  all.sort((a, b) => a - b);
  const global = median(all);
  const byCategory = new Map<string, { multiple: number; comps: number }>();
  for (const [key, arr] of groups) {
    arr.sort((a, b) => a - b);
    const med = median(arr);
    const shrunk = (arr.length * med + SHRINK_K * global) / (arr.length + SHRINK_K);
    byCategory.set(key, { multiple: Math.min(MULT_CAP, Math.max(MULT_FLOOR, shrunk)), comps: arr.length });
  }
  return { global, byCategory };
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Rankable on the early radar: pre-token, not an exchange, not a versioned pool of another protocol. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The multipliers and implied value one protocol gets. Pure in the snapshot's figures. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  table: { global: number; byCategory: Map<string, { multiple: number; comps: number }> },
): { implied: number; multiple: number; comps: number; momentum: number; maturity: number; reach: number; age: number | null } {
  const entry = table.byCategory.get(p.category ?? '(uncategorised)');
  const multiple = entry?.multiple ?? table.global;
  const comps = entry?.comps ?? 0;
  const growth = Math.min(100, Math.max(-50, finite(p.change_7d, 0)));
  const momentum = 1 + 0.6 * (growth / 100);
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? UNKNOWN_AGE_DAYS;
  const maturity = 0.65 + 0.5 * (Math.min(Math.max(ageForModel, 0), 1460) / 1460);
  const reach = 1 + 0.03 * Math.min(Math.max(p.chains.length - 1, 0), 6);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * momentum * maturity * reach));
  return { implied, multiple, comps, momentum, maturity, reach, age };
}

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

/** A five-step farm plan derived from the protocol's own record: category, chains, TVL and age. */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const chain2 = p.chains.length > 1 ? p.chains[1]! : chain;
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const gas = capital >= 150 ? 8 : capital >= 100 ? 6 : 4;
  return [
    `Start from a fresh wallet funded only with the farm budget, and bridge $${capital + 25} of USDC to ${chain} first so every later action is native to that chain. Cost: about $${gas} in bridge and gas fees. Time: 15 minutes.`,
    `${coreAction(p, capital, chain)} Cost: $${capital} of working capital plus about $${gas} of gas. Time: 20 minutes to set up.`,
    `Repeat one qualifying action every week — a top-up, a swap, a vote or a claim — and add a second chain (${chain2}) in week two if the app supports it, so the wallet shows breadth as well as depth. Cost: about $2 of gas a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days without a full withdrawal, so the activity spans more than one weekly snapshot of the protocol's books. Cost: the $${capital} stays deployed and exposed to the protocol. Time: ${hold} days.`,
    `Each Friday, open ${p.name}'s own points, rewards or governance page from the app itself, screenshot the wallet's standing into a farm log with dates and transaction hashes, and claim only from links the app publishes — never from messages or search ads. Cost: nothing to check, and never pay to claim. Time: 10 minutes a week.`,
  ];
}

/** The board: every watchlist slug, plus the strongest early pre-token protocols below the floor. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const table = categoryMultiples(snapshot);
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

  const scored = [...chosen.values()].map((p) => ({ p, v: impliedValue(p, snapshot.as_of, table) }));
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
    farm_steps: farmSteps(s.p, s.v.age),
  }));
}

/** Live-token protocols by market cap: the evidence set, shown apart from the ranked board. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd !== null)
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
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const table = categoryMultiples(snapshot);
  const cats = new Set<string>();
  const chains = new Set<string>();
  for (const r of board) {
    if (r.category !== null) cats.add(r.category);
    for (const c of r.chains) chains.add(c);
  }
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model_note: MODEL_NOTE,
    global_multiple: round4(table.global),
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
