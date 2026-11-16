// LaunchScope model — the whole valuation model, in the dashboard's own source.
// One model prices this page and board.json: main.ts loads this same file and
// runs it on the sealed snapshot; the page runs it again on the snapshot
// embedded in snapshot.js. Nothing is priced by hand — change the snapshot
// and every number moves. The pieces, in the order defined:
//   buildComps    trading protocols cleaned like-for-like: the category must
//                 also occur pre-token, CEX is dropped (an exchange token is
//                 not a protocol launch), one row per protocol, and pairs
//                 outside a 0.02x–8x FDV/TVL comparability band are dropped —
//                 above it the cap is not priced off this row's TVL (multi-
//                 version families, L1 bridge tokens), below it the record
//                 is partial or stale.
//   fitSizeCurve  log(mcap) = a + b * log(TVL) + category offset, fitted
//                 robustly (IRLS, Huber weights), backfit so line and offsets
//                 agree; offsets shrink toward zero by n/(n+8), so thin
//                 categories borrow the curve. Slope lands near 0.63: value
//                 grows slower than TVL, the published elasticity.
//   categoryMedians  the cross-check: each category's median multiple, shrunk
//                 toward the global median. The headline blends the two 90/10
//                 in log space; both print on every row, and a row is flagged
//                 "methods disagree" past 2x apart.
//   looBacktest   leave-one-out: every comp priced by a model that never saw
//                 it; the median miss is the band beside every value, and each
//                 method is backtested alone so the blend earns its place.
//   timeSplitBacktest  fit on the oldest 70% of dated comps, tested on the
//                 newest 30% — walk-forward, not a shuffle.
//   impliedValue  the blended base with bounded momentum, maturity and reach
//                 adjustments. farmPlan: a week-by-week plan per protocol,
//                 netted to the dollar, verdicted at the band's low end.
// snapshot.js embeds the snapshot compactly: C rows "slug|category|tvl $K|
// mcap $K|listed day" (trading), B rows "slug|name|category|chains|tvl $K|
// 7d change|listed day|watchlist flag" (board, all pre-token). Values are
// rounded to 4 significant figures in $K — the same figures feed both runs.
(function (global) {
'use strict';

var MODEL_VERSION = 'launchscope-4';
var EARLY_ROWS = 158;
var LIVE_ROWS = 24;
var RATIO_LO = 0.02;
var RATIO_HI = 8;
var OFFSET_SHRINK = 8;
var MEDIAN_SHRINK = 8;
var BLEND_CURVE = 0.9;
var UNKNOWN_AGE_DAYS = 365;
var FARM_SHARE_MAX = 2e-6;
var WATCH_SHARE_MAX = 1e-5;

function median(xs) {
  if (xs.length === 0) return 0;
  var s = xs.slice().sort(function (a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round4(n) { return Math.round(n * 1e4) / 1e4; }
function money(x) {
  if (x >= 1e9) return '$' + (x / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (x >= 1e6) return '$' + (x / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (x >= 1e3) return '$' + Math.round(x / 1e3) + 'K';
  return '$' + Math.round(x);
}
function dayNumber(iso) { return Math.floor(Date.parse(iso + 'T00:00:00Z') / 86400000) - 10957; }

// Snapshot decoding (the encoder lives in main.ts and uses the predicates above).

function isPreToken(p) { return p.mcap_usd === null && p.gecko_id === null && p.symbol === null; }

var VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
var WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
var EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Rankable on the early radar: pre-token, no exchanges, versioned re-launches, wrappers or exchange-fronted names. */
function isRankable(p) {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name) && !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_PREFIXES.some(function (x) { return p.name.indexOf(x) === 0; });
}

/** The compact snapshot back into plain protocol records both runs share. */
function decodeSnapshot(S) {
  var preCats = {};
  for (var i = 0; i < S.pre; i++) preCats[S.cats[i]] = true;
  var trading = S.C.split('\n').map(function (line) {
    var f = line.split('|');
    return { slug: f[0], name: f[0], category: S.cats[+f[1]], chains: [], tvl: +f[2] * 1000, mcap: +f[3] * 1000,
      change_7d: null, day: f[4] === '' ? null : +f[4] };
  });
  var watchlist = [];
  var board = S.B.split('\n').map(function (line) {
    var f = line.split('|');
    if (f[7] === 'w') watchlist.push(f[0]);
    return { slug: f[0], name: f[1], category: S.cats[+f[2]],
      chains: f[3] === '' ? [] : f[3].split(',').map(function (i) { return S.chains[+i]; }),
      tvl: +f[4] * 1000, change_7d: f[5] === '' ? null : +f[5], day: f[6] === '' ? null : +f[6],
      mcap: null, watchlist: f[7] === 'w' };
  });
  return { asOf: S.as_of, asOfDay: dayNumber(S.as_of), source: S.src, floor: S.floor, preCats: preCats,
    trading: trading, board: board, watchlist: watchlist, total: S.n, preCount: S.np };
}

// The comps set, the size curve, the category medians, the blend.

/** Trading protocols cleaned like-for-like, one row per protocol, slug order. */
function buildComps(snap) {
  var byFamily = {};
  snap.trading.forEach(function (p) {
    if (p.category === 'CEX') return;
    if (!snap.preCats[p.category]) return;
    var ratio = p.mcap / p.tvl;
    if (!isFinite(ratio) || ratio < RATIO_LO || ratio > RATIO_HI) return;
    var kept = byFamily[p.slug];
    if (kept === undefined || p.tvl > kept.tvl) byFamily[p.slug] = p;
  });
  return Object.keys(byFamily).sort().map(function (k) {
    var p = byFamily[k];
    return { slug: p.slug, name: p.name, category: p.category, tvl: p.tvl, mcap: p.mcap, day: p.day };
  });
}

/** One weighted least-squares line, log TVL -> log mcap, Huber-reweighted eight times. */
function irlsLine(xs, ys, adj) {
  var n = xs.length, w = [], slope = 0, intercept = 0, i;
  for (i = 0; i < n; i++) w.push(1);
  for (var it = 0; it < 8; it++) {
    var sw = 0, sx = 0, sy = 0;
    for (i = 0; i < n; i++) { sw += w[i]; sx += w[i] * xs[i]; sy += w[i] * (ys[i] - (adj ? adj[i] : 0)); }
    var mx = sx / sw, my = sy / sw, num = 0, den = 0;
    for (i = 0; i < n; i++) { num += w[i] * (xs[i] - mx) * (ys[i] - (adj ? adj[i] : 0) - my); den += w[i] * (xs[i] - mx) * (xs[i] - mx); }
    slope = den > 0 ? num / den : 0;
    intercept = my - slope * mx;
    var res = [];
    for (i = 0; i < n; i++) res.push(ys[i] - (adj ? adj[i] : 0) - (intercept + slope * xs[i]));
    var mad = median(res.map(Math.abs)) * 1.4826 || 1e-9;
    var k = 1.345 * mad;
    w = res.map(function (r) { return Math.abs(r) <= k ? 1 : k / Math.abs(r); });
  }
  return { intercept: intercept, slope: slope };
}

function rawOffsets(comps, line) {
  var sums = {}, counts = {};
  comps.forEach(function (c) {
    var r = Math.log(c.mcap) - (line.intercept + line.slope * Math.log(c.tvl));
    sums[c.category] = (sums[c.category] || 0) + r;
    counts[c.category] = (counts[c.category] || 0) + 1;
  });
  var offsets = {};
  Object.keys(sums).sort().forEach(function (cat) {
    offsets[cat] = (sums[cat] / counts[cat]) * (counts[cat] / (counts[cat] + OFFSET_SHRINK));
  });
  return { offsets: offsets, counts: counts };
}

/** The robust size curve: IRLS line plus shrunk category offsets, backfit three rounds. */
function fitSizeCurve(comps) {
  var xs = comps.map(function (c) { return Math.log(c.tvl); });
  var ys = comps.map(function (c) { return Math.log(c.mcap); });
  var line = irlsLine(xs, ys, null);
  var r = rawOffsets(comps, line);
  for (var round = 0; round < 3; round++) {
    var adj = comps.map(function (c) { return r.offsets[c.category] || 0; });
    line = irlsLine(xs, ys, adj);
    r = rawOffsets(comps, line);
  }
  return { intercept: line.intercept, slope: line.slope, offsets: r.offsets, counts: r.counts };
}

function curveValue(fit, tvl, category) {
  return Math.exp(fit.intercept + fit.slope * Math.log(tvl) + (fit.offsets[category] || 0));
}

/** Each category's median FDV/TVL multiple, shrunk toward the global median. */
function categoryMedians(comps) {
  var byCat = {};
  comps.forEach(function (c) { (byCat[c.category] = byCat[c.category] || []).push(c.mcap / c.tvl); });
  var global = median(comps.map(function (c) { return c.mcap / c.tvl; }));
  var by = {};
  Object.keys(byCat).sort().forEach(function (cat) {
    var med = median(byCat[cat]);
    by[cat] = Math.exp((Math.log(med) * byCat[cat].length + MEDIAN_SHRINK * Math.log(global)) / (byCat[cat].length + MEDIAN_SHRINK));
  });
  return { byCat: by, global: global };
}

function medianValue(medians, tvl, category) {
  return (medians.byCat[category] !== undefined ? medians.byCat[category] : medians.global) * tvl;
}

/** The blend: curve and category median side by side, combined 90/10 in log space. */
function blendValues(fit, medians, tvl, category) {
  var curve = curveValue(fit, tvl, category);
  var med = medianValue(medians, tvl, category);
  return { curve: curve, median: med, value: Math.exp(BLEND_CURVE * Math.log(curve) + (1 - BLEND_CURVE) * Math.log(med)) };
}

// The two backtests.

/** Leave-one-out: every comp priced by a model fitted without it; the median miss is the band. */
function looBacktest(comps) {
  var errors = [], curveErrors = [], medianErrors = [], preds = {};
  for (var i = 0; i < comps.length; i++) {
    var rest = comps.filter(function (_, j) { return j !== i; });
    var fit = fitSizeCurve(rest);
    var medians = categoryMedians(rest);
    var b = blendValues(fit, medians, comps[i].tvl, comps[i].category);
    preds[comps[i].slug] = b.value;
    errors.push(Math.abs(Math.log(b.value / comps[i].mcap)));
    curveErrors.push(Math.abs(Math.log(b.curve / comps[i].mcap)));
    medianErrors.push(Math.abs(Math.log(b.median / comps[i].mcap)));
  }
  var byTvl = comps.slice().sort(function (a, b) { return a.tvl - b.tvl; });
  var checks = [];
  for (var k = 0; k < 8; k++) {
    var c = byTvl[Math.round((k * (byTvl.length - 1)) / 7)];
    checks.push({ name: c.name, tvl: c.tvl, actual: c.mcap, predicted: Math.round(preds[c.slug]),
      err: round4(Math.exp(Math.abs(Math.log(preds[c.slug] / c.mcap)))) });
  }
  return { factor: Math.exp(median(errors)), curveFactor: Math.exp(median(curveErrors)),
    medianFactor: Math.exp(median(medianErrors)), checks: checks };
}

/** Time split: fit on the oldest 70% of dated comps, price the newest 30% the fit never saw. */
function timeSplitBacktest(comps) {
  var dated = comps.filter(function (c) { return c.day !== null; }).sort(function (a, b) { return b.day - a.day || (a.slug < b.slug ? -1 : 1); });
  if (dated.length < 10) return null;
  var cut = Math.floor(dated.length * 0.7);
  var train = dated.slice(0, cut), test = dated.slice(cut);
  var fit = fitSizeCurve(train);
  var medians = categoryMedians(train);
  var errors = test.map(function (c) {
    return Math.abs(Math.log(blendValues(fit, medians, c.tvl, c.category).value / c.mcap));
  });
  return { factor: Math.exp(median(errors)), trained: train.length, tested: test.length };
}

// Valuation of one protocol, and its farm plan.

function ageOf(snap, p) { return p.day === null ? null : Math.max(0, p.day); }

function impliedValue(snap, p, fit, medians) {
  var b = blendValues(fit, medians, p.tvl, p.category);
  var growth = Math.min(100, Math.max(-50, p.change_7d === null ? 0 : p.change_7d));
  var momentum = 1 + 0.6 * (growth / 100);
  var age = ageOf(snap, p);
  var ageForModel = age === null ? UNKNOWN_AGE_DAYS : age;
  var maturity = 0.65 + 0.5 * (Math.min(Math.max(ageForModel, 0), 1460) / 1460);
  var reach = 1 + 0.03 * Math.min(Math.max(p.chains.length - 1, 0), 6);
  var implied = Math.max(1, Math.round(b.value * momentum * maturity * reach));
  return { implied: implied, base: b.value, curve: b.curve, median: b.median,
    multiple: b.value / p.tvl, curveMultiple: b.curve / p.tvl, medianMultiple: b.median / p.tvl,
    comps: fit.counts[p.category] || 0,
    disagree: Math.max(b.curve / b.median, b.median / b.curve) > 2,
    momentum: momentum, maturity: maturity, reach: reach, age: age };
}

function capitalFor(tvl) {
  if (tvl >= 5e9) return 250;
  if (tvl >= 1e9) return 150;
  if (tvl >= 2.5e8) return 100;
  if (tvl >= 5e7) return 75;
  return 50;
}
function holdDaysFor(age) {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  if (age < 730) return 30;
  return 21;
}
function coreAction(p, capital, chain) {
  var c = p.category.toLowerCase(), n = p.name;
  if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0)
    return 'Supply $' + capital + ' USDC collateral to ' + n + ' on ' + chain + ', then borrow a little against it so both sides of the market record your wallet.';
  if (c.indexOf('dex') >= 0 || c.indexOf('liquidity') >= 0)
    return 'Add $' + capital + ' of paired liquidity to ' + n + "'s highest-volume pool on " + chain + ' and leave the LP untouched while it accrues fees.';
  if (c.indexOf('bridge') >= 0)
    return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + n + ', then spend the bridged funds inside the destination app instead of bridging back.';
  if (c.indexOf('liquid staking') >= 0 || c.indexOf('restak') >= 0 || c.indexOf('staking') >= 0)
    return 'Stake $' + capital + ' of the native asset through ' + n + ' on ' + chain + ' and hold the liquid receipt token in the same wallet all window.';
  if (c.indexOf('derivative') >= 0 || c.indexOf('option') >= 0 || c.indexOf('perpetual') >= 0)
    return 'Deposit $' + capital + ' of USDC margin on ' + n + ' and run one small hedged position a week, sized so fees stay under $5 a month.';
  if (c.indexOf('yield') >= 0 || c.indexOf('farm') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('curator') >= 0)
    return 'Deposit $' + capital + ' into a ' + n + ' vault on ' + chain + ' and keep the vault shares; compounding vaults count the shares, not the clicks.';
  if (c.indexOf('rwa') >= 0 || c.indexOf('stable') >= 0 || c.indexOf('basis') >= 0)
    return 'Mint or buy $' + capital + " of " + n + "'s yield-bearing asset on " + chain + ' and hold it; the holding itself is the qualifying activity.';
  if (c.indexOf('launchpad') >= 0)
    return 'Register on ' + n + ', complete its $' + capital + ' staking step on ' + chain + ', and keep the position until the next sale snapshot.';
  if (c.indexOf('prediction') >= 0)
    return 'Fund $' + capital + ' on ' + n + ' and hold one position in a market settling at least two weeks out, so the wallet ages on the book.';
  if (c.indexOf('insurance') >= 0)
    return 'Buy $' + capital + ' of cover from ' + n + ' on ' + chain + ' for the longest term offered; an open policy is a durable, dated record.';
  if (c.indexOf('chain') >= 0 || c.indexOf('payments') >= 0 || c.indexOf('card') >= 0)
    return 'Move $' + capital + ' of real activity onto ' + n + ' on ' + chain + ': bridge in, pay or swap weekly, keep a balance there between actions.';
  return 'Deposit $' + capital + ' of USDC into ' + n + ' on ' + chain + ' through its main app and keep the position open; idle deposits are what its record counts.';
}
function maintainAction(p, chain) {
  var c = p.category.toLowerCase(), n = p.name;
  if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0)
    return 'Check the position\u2019s health factor on ' + n + ' and top up $10 of collateral if it drifted; a liquidation would erase the wallet\u2019s whole record.';
  if (c.indexOf('dex') >= 0 || c.indexOf('liquidity') >= 0)
    return 'Check the ' + n + ' LP position is still earning fees on ' + chain + '; if the pool went quiet, move it to the week\u2019s highest-volume pool instead of withdrawing.';
  if (c.indexOf('liquid staking') >= 0 || c.indexOf('restak') >= 0 || c.indexOf('staking') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('farm') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('curator') >= 0)
    return 'Claim whatever rewards ' + n + ' shows for the wallet and put them straight back into the same position; compounding is fresh, dated activity in its own books.';
  if (c.indexOf('bridge') >= 0)
    return 'Route one real transfer of $25 through ' + n + ' to ' + chain + ' and spend it at the destination; one honest crossing a week beats a burst of round trips.';
  return 'Make one small qualifying action on ' + n + ' \u2014 a $10 top-up, a swap or a claim \u2014 so this week also lands in the protocol\u2019s record.';
}

/** A week-by-week farm plan for one protocol, netted and verdicted at the band's low end. */
function farmPlan(p, age, impliedLowUsd) {
  var chain = p.chains.length > 0 ? p.chains[0] : 'its main chain';
  var chain2 = p.chains.length > 1 ? p.chains[1] : chain;
  var capital = capitalFor(p.tvl);
  var hold = holdDaysFor(age);
  var weeks = Math.ceil(hold / 7);
  var gas = capital >= 150 ? 8 : capital >= 100 ? 6 : 4;
  var planCost = gas * 2 + 2 * weeks;
  var share = planCost / Math.max(1, impliedLowUsd);
  var oneIn = Math.round(1 / share).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  var verdict, why;
  if (share <= FARM_SHARE_MAX) {
    verdict = 'FARM';
    why = 'the plan breaks even if this wallet captures just 1 in ' + oneIn + ' of the low-band launch value \u2014 a very small share for an early, active wallet';
  } else if (share <= WATCH_SHARE_MAX) {
    verdict = 'WATCH';
    why = 'break-even needs 1 in ' + oneIn + ' of the low-band launch value \u2014 plausible only beside other farms on the same chain that share the wallet and the gas';
  } else {
    verdict = 'SKIP';
    why = 'break-even needs 1 in ' + oneIn + ' of the low-band launch value \u2014 too large a share to count on from one small wallet; revisit if TVL grows or the band moves';
  }
  var steps = [
    'Week 0 \u2014 one wallet, set up clean: a fresh wallet for this farm only, funded from one source. Protocols snapshot one consistent wallet; linked clusters farmed in parallel are cut first as Sybil. Bridge $' + (capital + 25) + ' of USDC to ' + chain + '. Cost: about $' + gas + ' bridge and gas. Time: 15 minutes.',
    'Week 1 \u2014 open the core position: ' + coreAction(p, capital, chain) + ' Cost: $' + capital + ' working capital plus about $' + gas + ' gas. Time: 20 minutes.'
  ];
  for (var w = 2; w <= weeks; w++) {
    if (w === 2 && p.chains.length > 1) {
      steps.push('Week 2 \u2014 add the second chain: repeat a $25 version of the core action on ' + chain2 + ', so the wallet\u2019s record spans two of ' + p.name + '\u2019s ' + p.chains.length + ' chains. Breadth across chains is cheap now, expensive to fake later. Cost: about $2 gas. Time: 10 minutes.');
    } else if (w % 3 === 0) {
      steps.push('Week ' + w + ' \u2014 show up for governance: open ' + p.name + '\u2019s governance page from inside the app (never a search ad), read any live proposal and vote if one is open; if none is, log the dated check. Wallets that vote read as users, not extractors. Cost: $0\u20132 gas. Time: 10 minutes.');
    } else if (w % 3 === 1) {
      steps.push('Week ' + w + ' \u2014 log the standing: open ' + p.name + '\u2019s points or rewards page from the app itself, screenshot the wallet\u2019s standing into a dated farm log with transaction hashes, and claim only from links the app publishes \u2014 never from messages, never pay to claim. Cost: nothing. Time: 10 minutes.');
    } else {
      steps.push('Week ' + w + ' \u2014 maintain, don\u2019t churn: ' + maintainAction(p, chain) + ' Cost: about $2 gas. Time: 10 minutes.');
    }
  }
  steps.push('After week ' + weeks + ' \u2014 hold to day ' + hold + ', then the netting: keep the position open the full ' + hold + ' days; snapshots reward duration, not volume \u2014 churning adds cost, not standing. Cash cost totals about $' + planCost + ' (bridge $' + gas + ', gas $' + gas + ', $2 a week for ' + weeks + ' weeks); the $' + capital + ' capital is separate and returns on unwind. Judged at the band\u2019s low end \u2014 ' + money(impliedLowUsd) + ', not the headline \u2014 the verdict is ' + verdict + ': ' + why + '.');
  return { steps: steps, verdict: verdict, planCostUsd: planCost };
}

// The board, the live set, and the radar.

function buildBoard(snap, fit, medians, factor) {
  var chosen = {};
  snap.board.forEach(function (p) { if (p.watchlist) chosen[p.slug] = p; });
  var early = snap.board
    .filter(function (p) { return !chosen[p.slug] && p.tvl < snap.floor; })
    .sort(function (a, b) { return b.tvl - a.tvl || (a.slug < b.slug ? -1 : 1); })
    .slice(0, EARLY_ROWS);
  early.forEach(function (p) { chosen[p.slug] = p; });
  var scored = Object.keys(chosen).map(function (slug) {
    var p = chosen[slug];
    var v = impliedValue(snap, p, fit, medians);
    var low = Math.max(1, Math.round(v.implied / factor));
    var high = Math.round(v.implied * factor);
    var plan = farmPlan(p, v.age, low);
    return { p: p, v: v, low: low, high: high, plan: plan };
  });
  scored.sort(function (a, b) { return b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : 1); });
  return scored.map(function (s, i) {
    return { rank: i + 1, slug: s.p.slug, name: s.p.name, category: s.p.category, chains: s.p.chains,
      tvl_usd: s.p.tvl, change_7d: s.p.change_7d,
      listed_at: s.p.day === null ? null : new Date((snap.asOfDay - s.p.day + 10957) * 86400000).toISOString().slice(0, 10), token_status: 'pre-token',
      watchlist: s.p.watchlist, age_days: s.v.age, implied_value_usd: s.v.implied,
      model: { fdv_tvl_multiple: round4(s.v.multiple), curve_multiple: round4(s.v.curveMultiple),
        category_median_multiple: round4(s.v.medianMultiple), category_comps: s.v.comps,
        methods_disagree: s.v.disagree, momentum_multiplier: round4(s.v.momentum),
        maturity_multiplier: round4(s.v.maturity), reach_multiplier: round4(s.v.reach) },
      farm_steps: s.plan.steps, implied_low_usd: s.low, implied_high_usd: s.high,
      farm_verdict: s.plan.verdict, plan_cost_usd: s.plan.planCostUsd };
  });
}

function liveRows(comps) {
  return comps.slice().sort(function (a, b) { return b.mcap - a.mcap || (a.slug < b.slug ? -1 : 1); }).slice(0, LIVE_ROWS)
    .map(function (c) {
      return { slug: c.slug, name: c.name, category: c.category, tvl_usd: c.tvl, mcap_usd: c.mcap,
        fdv_tvl: c.tvl > 0 ? round4(c.mcap / c.tvl) : null };
    });
}

/** Everything: decode, clean, fit, backtest twice, price the board. */
function buildRadar(S) {
  var snap = decodeSnapshot(S);
  var comps = buildComps(snap);
  var fit = fitSizeCurve(comps);
  var medians = categoryMedians(comps);
  var loo = looBacktest(comps);
  var split = timeSplitBacktest(comps);
  var board = buildBoard(snap, fit, medians, loo.factor);
  var live = liveRows(comps);
  var cats = {}, chains = {};
  board.forEach(function (r) { if (r.category !== null) cats[r.category] = true; r.chains.forEach(function (c) { chains[c] = true; }); });
  var modelNote =
    'Two methods fitted to this snapshot\u2019s own trading protocols price every row, printed side by side. ' +
    'A robust size curve (IRLS, Huber weights, backfit category offsets) reads log market cap = ' + fit.intercept.toFixed(2) + ' + ' + fit.slope.toFixed(2) +
    ' x log TVL off ' + comps.length + ' like-for-like comps in a 0.02x\u20138x comparability band; a category-median multiple cross-checks it; ' +
    'the headline blends them 90/10 in log space, then applies bounded momentum, maturity and reach adjustments. ' +
    'Leave-one-out \u2014 each comp priced by a model that never saw it \u2014 misses by x' + loo.factor.toFixed(2) + ' (curve alone x' + loo.curveFactor.toFixed(2) +
    ', median alone x' + loo.medianFactor.toFixed(2) + '); a time split fitted on the oldest comps misses the newest by x' + (split ? split.factor.toFixed(2) : '\u2014') +
    '. Every value carries the leave-one-out band, verdicts are netted at its low end, and rows where the methods differ by more than 2x are flagged, not hidden.';
  var radar = {
    as_of: snap.asOf, source: snap.source, floor_usd: snap.floor, model_version: MODEL_VERSION, model_note: modelNote,
    global_multiple: round4(medians.global), scanned: snap.total, audited_count: snap.preCount,
    watchlist_size: snap.watchlist.length, board_size: board.length,
    early_size: board.filter(function (r) { return !r.watchlist; }).length, live_size: live.length,
    total_implied_usd: board.reduce(function (sum, r) { return sum + r.implied_value_usd; }, 0),
    categories: Object.keys(cats).sort(), chains: Object.keys(chains).sort(), rows: board, live: live,
    method: { comps_count: comps.length, curve_slope: round4(fit.slope), curve_intercept: round4(fit.intercept),
      loo_factor: round4(loo.factor), loo_curve_factor: round4(loo.curveFactor), loo_median_factor: round4(loo.medianFactor),
      time_split_factor: split ? round4(split.factor) : null, time_split_trained: split ? split.trained : 0,
      time_split_tested: split ? split.tested : 0, band_lo: RATIO_LO, band_hi: RATIO_HI, blend_curve_weight: BLEND_CURVE }
  };
  return { board: board, radar: radar, comps: comps, checks: loo.checks, snap: snap };
}

var api = { MODEL_VERSION: MODEL_VERSION, EARLY_ROWS: EARLY_ROWS, RATIO_LO: RATIO_LO, RATIO_HI: RATIO_HI,
  decodeSnapshot: decodeSnapshot, isPreToken: isPreToken,
  isRankable: isRankable, buildComps: buildComps, fitSizeCurve: fitSizeCurve, categoryMedians: categoryMedians,
  blendValues: blendValues, looBacktest: looBacktest, timeSplitBacktest: timeSplitBacktest,
  impliedValue: impliedValue, farmPlan: farmPlan, buildBoard: buildBoard, buildRadar: buildRadar };
global.LaunchScopeModel = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
