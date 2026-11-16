// LaunchScope: a token launch radar entry for make.fun's token-radar-01.
//
// Reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>),
// compacts it into dashboard/snapshot.js, and runs the valuation model —
// dashboard/model.js, the same file the page itself runs — to write the board
// to /output/board.json. Copies dashboard/ and screenshots/ into /output and
// finishes with /output/dossier.json from the vendored make.fun library: the
// dossier is written last because the scorer rebuilds it from the same
// /output and compares bytes.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './dashboard/model.js';
import { buildDossier } from './vendor/makefun-board.ts';

const M = (globalThis as any).LaunchScopeModel;
const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

// ---------------------------------------------------------------------------
// The sealed snapshot, validated (the model's own types live in model.js).

interface RawProtocol {
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
interface RawSnapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: RawProtocol[];
  watchlist: string[];
}

class SnapshotError extends Error {}

function parseSnapshot(text: string): RawSnapshot {
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

// ---------------------------------------------------------------------------
// The compact embed the page runs on (format documented in model.js).

const dayNumber = (iso: string): number => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000) - 10957;
function roundK(n: number): number {
  if (n === 0) return 0;
  const d = Math.pow(10, Math.floor(Math.log10(Math.abs(n))) - 3);
  return Math.round((Math.round(n / d) * d) / 1000);
}

function encodeSnapshot(raw: RawSnapshot): Record<string, unknown> {
  const preCats: string[] = [];
  for (const p of raw.protocols) {
    const c = p.category ?? '(uncategorised)';
    if (M.isPreToken(p) && !preCats.includes(c)) preCats.push(c);
  }
  preCats.sort();
  const cats = [...preCats];
  const catIdx = (c: string): number => {
    let i = cats.indexOf(c);
    if (i < 0) { cats.push(c); i = cats.length - 1; }
    return i;
  };
  const chains: string[] = [];
  const chIdx = (c: string): number => {
    let i = chains.indexOf(c);
    if (i < 0) { chains.push(c); i = chains.length - 1; }
    return i;
  };
  const asOfDay = dayNumber(raw.as_of);
  const day = (p: RawProtocol): string | number => (p.listed_at === null ? '' : asOfDay - dayNumber(p.listed_at));
  // Only records that can enter the comps set are embedded (the model's own
  // rules, applied to the same rounded figures the decoder will see).
  const C = raw.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 &&
      (p.category ?? '(uncategorised)') !== 'CEX' && preCats.includes(p.category ?? '(uncategorised)') &&
      roundK(p.mcap_usd) / roundK(p.tvl_usd) >= M.RATIO_LO && roundK(p.mcap_usd) / roundK(p.tvl_usd) <= M.RATIO_HI)
    .map((p) => [p.slug, catIdx(p.category ?? '(uncategorised)'), roundK(p.tvl_usd), roundK(p.mcap_usd!), day(p)].join('|'))
    .sort();
  const watch = new Set(raw.watchlist);
  const chosen = new Map<string, RawProtocol>();
  for (const p of raw.protocols) if (watch.has(p.slug)) chosen.set(p.slug, p);
  // The board universe: the watchlist plus the model's early slice, picked
  // with the model's own ordering on the rounded figures.
  raw.protocols
    .filter((p) => !watch.has(p.slug) && M.isRankable(p) && p.tvl_usd < raw.floor_usd)
    .sort((a, b) => roundK(b.tvl_usd) - roundK(a.tvl_usd) || (a.slug < b.slug ? -1 : 1))
    .slice(0, M.EARLY_ROWS)
    .forEach((p) => chosen.set(p.slug, p));
  const B = [...chosen.keys()].sort().map((slug) => {
    const p = chosen.get(slug)!;
    return [p.slug, p.name, catIdx(p.category ?? '(uncategorised)'), p.chains.map(chIdx).join(','), roundK(p.tvl_usd),
      p.change_7d === null ? '' : Math.round(p.change_7d * 10) / 10, day(p), watch.has(slug) ? 'w' : ''].join('|');
  });
  return {
    // The dashboard's source may not contain a URL anywhere, so the embed
    // carries the provenance with the fetch URL itself stripped out.
    as_of: raw.as_of, src: raw.source.replace(/https?:\/\/\S+/g, 'DefiLlama'), floor: raw.floor_usd, pre: preCats.length,
    n: raw.protocols.length, np: raw.protocols.filter((p) => M.isPreToken(p)).length,
    cats, chains, C: C.join('\n'), B: B.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Why a board is not one the gate will take, or null.

function boardIssue(board: any[], snapshot: RawSnapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not a protocol in the snapshot`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) if (byRank[i].rank !== i + 1) return `rank ${i + 1} is ${byRank[i].rank}`;
  for (let i = 1; i < byRank.length; i++) if (byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && byRank[0].implied_value_usd === byRank[byRank.length - 1].implied_value_usd) return 'every row shares one implied value';
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = (s as string).trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`launchscope: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const snap = encodeSnapshot(snapshot);
const { board, radar } = M.buildRadar(snap);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`launchscope: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
writeFileSync(join(out, 'dashboard', 'snapshot.js'), `window.SNAP=${JSON.stringify(snap)};\n`);
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`launchscope: screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`launchscope: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `launchscope: ${snapshot.protocols.length} protocols scanned, ${snapshot.watchlist.length} watchlist, ${board.length} rows ranked (${radar.early_size} early), ${radar.live_size} live set aside\n` +
    `launchscope: ${radar.method.comps_count} comps, slope ${radar.method.curve_slope}, leave-one-out x${radar.method.loo_factor}, time-split x${radar.method.time_split_factor}\n` +
    `launchscope: wrote board.json, dashboard/ (with snapshot.js), screenshots/ (${shots.length}) and dossier.json into ${out}\n`,
);
