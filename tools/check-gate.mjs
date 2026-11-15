// Gate self-check for a token-radar-01 /output directory against the kit snapshot.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from '../vendor/makefun-board.ts';

const out = process.argv[2];
const snap = JSON.parse(readFileSync(process.argv[3], 'utf8'));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails++; };

// dashboard_files
const dashDir = join(out, 'dashboard');
const dashFiles = readdirSync(dashDir);
const dashBytes = dashFiles.reduce((s, f) => s + statSync(join(dashDir, f)).size, 0);
check('dashboard_files presence', dashFiles.includes('index.html') && dashFiles.some((f) => f.endsWith('.css')) && dashFiles.some((f) => f.endsWith('.js')), dashFiles.join(','));
check('dashboard size caps', dashFiles.length <= 400 && dashBytes <= 4_194_304, `${dashFiles.length} files, ${dashBytes} bytes`);
check('dashboard source < 64KB for dossier', dashBytes < 65_536, `${dashBytes} bytes`);
let urlHit = '';
for (const f of dashFiles) {
  const t = readFileSync(join(dashDir, f), 'utf8');
  if (/https?:\/\//.test(t)) urlHit = f;
}
check('no http(s) anywhere in dashboard source', urlHit === '', urlHit);

// board rules
const board = JSON.parse(readFileSync(join(out, 'board.json'), 'utf8'));
const rows = board.rows;
const known = new Set(snap.protocols.map((p) => p.slug));
check('board rows 100..4000', rows.length >= 100 && rows.length <= 4000, `${rows.length} rows`);
check('board <= 8MiB', statSync(join(out, 'board.json')).size <= 8 * 1024 * 1024);
check('slugs unique + known', new Set(rows.map((r) => r.slug)).size === rows.length && rows.every((r) => known.has(r.slug)));
const missing = snap.watchlist.filter((s) => !rows.some((r) => r.slug === s));
check('watchlist coverage 40/40', missing.length === 0, missing.join(','));
const byRank = [...rows].sort((a, b) => a.rank - b.rank);
check('ranks exactly 1..N', byRank.every((r, i) => r.rank === i + 1));
check('implied non-increasing by rank', byRank.every((r, i) => i === 0 || r.implied_value_usd <= byRank[i - 1].implied_value_usd));
check('implied not all equal', byRank[0].implied_value_usd !== byRank[byRank.length - 1].implied_value_usd);
check('implied positive int <= 1e14', rows.every((r) => Number.isSafeInteger(r.implied_value_usd) && r.implied_value_usd > 0 && r.implied_value_usd <= 1e14));
check('names non-empty', rows.every((r) => typeof r.name === 'string' && r.name.length > 0));
let stepBad = '';
for (const r of rows) {
  if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) { stepBad = `${r.slug} count`; break; }
  for (const s of r.farm_steps) { const t = s.trim(); if (t.length < 20 || t.length > 600) { stepBad = `${r.slug} len ${t.length}`; break; } }
  if (stepBad) break;
}
check('farm_steps 3..12 of 20..600 chars', stepBad === '', stepBad);

// screenshots
const shots = readdirSync(join(out, 'screenshots')).filter((f) => !f.startsWith('.'));
check('screenshots 3..4', shots.length >= 3 && shots.length <= 4, shots.join(','));
for (const f of shots) {
  const buf = readFileSync(join(out, 'screenshots', f));
  const isPng = buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50;
  let dims = '';
  if (isPng) { const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20); dims = `${w}x${h}`; check(`shot ${f} dims long<=1440 short>=800`, Math.max(w, h) <= 1440 && Math.min(w, h) >= 800, dims); }
  check(`shot ${f} whole png + <=512KiB`, isPng && buf.length <= 524_288, `${buf.length} bytes ${dims}`);
}

// dossier byte-for-byte
const rebuilt = Buffer.from(buildDossier(out, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));
const actual = readFileSync(join(out, 'dossier.json'));
check('dossier_matches byte-for-byte', rebuilt.equals(actual), `${actual.length} bytes`);
check('dossier <= 1.5MiB', actual.length <= 1_572_864);

console.log(fails === 0 ? 'ALL GATE CHECKS PASS' : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
