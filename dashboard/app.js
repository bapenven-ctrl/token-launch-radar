// LaunchScope dashboard: runs model.js on the embedded snapshot, renders it.
(function () {
  var M = window.LaunchScopeModel, app = document.getElementById('app');
  if (!M || !window.SNAP) { app.innerHTML = '<div class="wrap"><p>No data: run main.ts first.</p></div>'; return; }
  var built = M.buildRadar(window.SNAP);
  var D = built.radar, COMPS = built.comps, CHECKS = built.checks, ME = D.method;
  var params = new URLSearchParams(location.search);
  var state = { q: params.get('q') || '', cat: params.get('cat') || '', chain: params.get('chain') || '',
    verdict: params.get('verd') || '', sort: params.get('sort') || 'implied', sel: params.get('sel') || null };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function money(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function pct(n) {
    return n == null ? '<span class="faint">n/a</span>' :
      '<span class="' + (n >= 0 ? 'up' : 'down') + '">' + (n >= 0 ? '+' : '') + n.toFixed(1) + '%</span>';
  }
  function ageTxt(d) { return d == null ? 'untracked' : d >= 365 ? (d / 365).toFixed(1) + ' yrs' : d + ' days'; }
  var catStats = {};
  COMPS.forEach(function (c) {
    var s = catStats[c.category] || (catStats[c.category] = { n: 0, lo: 1e9, hi: 0, big: null, bigMult: 0 }), m = c.mcap / c.tvl;
    s.n++; if (m < s.lo) s.lo = m; if (m > s.hi) s.hi = m;
    if (c.tvl > (s.big ? s.big.tvl : 0)) { s.big = c; s.bigMult = m; }
  });

  // Comps chart on canvas: log TVL vs log market cap, the fitted curve and
  // its leave-one-out band; dots outside the band are rose.
  function drawChart() {
    var cv = document.getElementById('chart');
    if (!cv) return;
    var g = cv.getContext('2d');
    g.scale(2, 2);
    var xs = COMPS.map(function (c) { return Math.log10(c.tvl); }), ys = COMPS.map(function (c) { return Math.log10(c.mcap); });
    var x0 = Math.floor(Math.min.apply(null, xs)), x1 = Math.ceil(Math.max.apply(null, xs));
    var y0 = Math.floor(Math.min.apply(null, ys)), y1 = Math.ceil(Math.max.apply(null, ys));
    function px(x) { return 46 + ((x - x0) / (x1 - x0)) * 502; }
    function py(y) { return 288 - ((y - y0) / (y1 - y0)) * 276; }
    var band = Math.log10(ME.loo_factor), ln10 = Math.LN10, i;
    function ly(x, off) { return (ME.curve_intercept + ME.curve_slope * x * ln10) / ln10 + off; }
    g.font = '10px sans-serif';
    g.strokeStyle = '#232a52'; g.fillStyle = '#6b74a3';
    for (i = x0; i <= x1; i += 2) { g.beginPath(); g.moveTo(px(i), 12); g.lineTo(px(i), 288); g.stroke(); g.fillText(money(Math.pow(10, i)), Math.min(px(i) - 8, 520), 310); }
    for (i = y0; i <= y1; i += 2) { g.beginPath(); g.moveTo(46, py(i)); g.lineTo(548, py(i)); g.stroke(); g.fillText(money(Math.pow(10, i)), 4, py(i) + 3); }
    g.strokeStyle = 'rgba(89,216,242,.65)'; g.setLineDash([5, 4]);
    [band, -band].forEach(function (off) { g.beginPath(); g.moveTo(px(x0), py(ly(x0, off))); g.lineTo(px(x1), py(ly(x1, off))); g.stroke(); });
    g.setLineDash([]); g.strokeStyle = '#ffb648'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(px(x0), py(ly(x0, 0))); g.lineTo(px(x1), py(ly(x1, 0))); g.stroke();
    COMPS.forEach(function (c) {
      var pred = Math.exp(ME.curve_intercept + ME.curve_slope * Math.log(c.tvl));
      var out = Math.abs(Math.log(pred / c.mcap)) > Math.log(ME.loo_factor);
      g.fillStyle = out ? '#ff7d9c' : 'rgba(89,216,242,.75)';
      g.beginPath(); g.arc(px(Math.log10(c.tvl)), py(Math.log10(c.mcap)), 3, 0, 7); g.fill();
    });
  }

  function methodPanel() {
    var rows = CHECKS.map(function (c) {
      return '<tr><td>' + esc(c.name) + '</td><td class="num">' + money(c.tvl) + '</td><td class="num">' + money(c.predicted) +
        '</td><td class="num">' + money(c.actual) + '</td><td class="num">x' + c.err.toFixed(2) + '</td></tr>'; }).join('');
    return '<section class="method"><div class="mhead"><h2>How every value is earned — the method, backtested</h2>' +
      '<span class="mcap">' + ME.comps_count + ' comps · band ' + ME.band_lo + 'x–' + ME.band_hi + 'x · slope ' + ME.curve_slope.toFixed(2) + '</span></div>' +
      '<div class="mgrid"><div><canvas id="chart" width="1120" height="636" class="chart"></canvas>' +
      '<div class="mnote">The ' + ME.comps_count + ' trading comps, the robust size curve and its leave-one-out band (dashed). Rose dots price outside the band even in-sample — that dispersion is priced into every row\u2019s band.</div></div>' +
      '<div><table class="mtab"><thead><tr><th>Backtest</th><th class="num">Median miss</th></tr></thead><tbody>' +
      '<tr><td>Blend — the headline</td><td class="num"><b>x' + ME.loo_factor.toFixed(2) + '</b></td></tr>' +
      '<tr><td>Size curve alone</td><td class="num">x' + ME.loo_curve_factor.toFixed(2) + '</td></tr>' +
      '<tr><td>Category median alone</td><td class="num">x' + ME.loo_median_factor.toFixed(2) + '</td></tr>' +
      '<tr><td>Time split: fit oldest ' + ME.time_split_trained + ', test newest ' + ME.time_split_tested + '</td><td class="num">x' + (ME.time_split_factor || 0).toFixed(2) + '</td></tr></tbody></table>' +
      '<div class="mnote">Leave-one-out, predicted vs actual, spread over the size range:</div>' +
      '<table class="mtab"><thead><tr><th>Comp</th><th class="num">TVL</th><th class="num">Pred</th><th class="num">Actual</th><th class="num">Miss</th></tr></thead><tbody>' +
      rows + '</tbody></table></div></div></section>';
  }

  var maxTvl = Math.max.apply(null, D.rows.map(function (r) { return r.tvl_usd; }));
  function filtered() {
    var rows = D.rows.filter(function (r) {
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.verdict && r.farm_verdict !== state.verdict) return false;
      if (state.q) { var q = state.q.toLowerCase(); if (r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false; }
      return true;
    });
    var key = { implied: function (r) { return r.implied_value_usd; }, tvl: function (r) { return r.tvl_usd; },
      growth: function (r) { return r.change_7d == null ? -1e9 : r.change_7d; },
      age: function (r) { return r.age_days == null ? -1 : r.age_days; } }[state.sort];
    rows.sort(function (a, b) { return key(b) - key(a) || a.rank - b.rank; });
    return rows;
  }
  function bandBar(r) {
    var lo = Math.log(r.implied_low_usd), span = Math.log(r.implied_high_usd) - lo || 1;
    var adj = r.model.momentum_multiplier * r.model.maturity_multiplier * r.model.reach_multiplier;
    function pos(v) { return Math.max(0, Math.min(100, ((Math.log(v) - lo) / span) * 100)).toFixed(1); }
    return '<div class="bandbar" title="Band ' + money(r.implied_low_usd) + ' – ' + money(r.implied_high_usd) + ' (LOO x' + ME.loo_factor.toFixed(2) + '). Ticks: curve | median value.">' +
      '<i style="width:' + pos(r.implied_value_usd) + '%"></i>' +
      '<b class="tick curve" style="left:' + pos(r.tvl_usd * r.model.curve_multiple * adj) + '%"></b>' +
      '<b class="tick med" style="left:' + pos(r.tvl_usd * r.model.category_median_multiple * adj) + '%"></b></div>';
  }
  function rowHtml(r) {
    var chips = (r.category ? '<span class="chip cat">' + esc(r.category) + '</span>' : '') +
      r.chains.slice(0, 3).map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') +
      (r.chains.length > 3 ? '<span class="chip">+' + (r.chains.length - 3) + '</span>' : '');
    return '<tr data-slug="' + esc(r.slug) + '"' + (state.sel === r.slug ? ' class="sel"' : '') + '>' +
      '<td class="rk' + (r.rank <= 3 ? ' top' : '') + '">#' + r.rank + '</td>' +
      '<td><div class="pname">' + esc(r.name) + (r.watchlist ? ' <span class="chip wl">WATCHLIST</span>' : '') +
      (r.model.methods_disagree ? ' <span class="chip dis">METHODS DISAGREE</span>' : '') + '</div>' +
      '<div class="pslug">' + esc(r.slug) + '</div><div>' + chips + '</div></td>' +
      '<td class="num"><div class="money">' + money(r.tvl_usd) + '</div><div class="bar"><i style="width:' + Math.max(2, (r.tvl_usd / maxTvl) * 100) + '%"></i></div></td>' +
      '<td class="num">' + pct(r.change_7d) + '</td>' +
      '<td class="num"><div class="money big">' + money(r.implied_value_usd) + '</div>' + bandBar(r) +
      '<div class="bandline">band ' + money(r.implied_low_usd) + ' – ' + money(r.implied_high_usd) + '</div></td>' +
      '<td class="num"><div class="money">' + r.model.fdv_tvl_multiple.toFixed(2) + 'x</div>' +
      '<div class="bandline">curve ' + r.model.curve_multiple.toFixed(2) + 'x · med ' + r.model.category_median_multiple.toFixed(2) + 'x</div></td>' +
      '<td class="num dim">' + ageTxt(r.age_days) + '</td>' +
      '<td><span class="chip verd ' + r.farm_verdict.toLowerCase() + '">' + r.farm_verdict + '</span><div class="bandline">plan $' + r.plan_cost_usd + '</div></td></tr>';
  }
  function whyBox(r) {
    if (!r.model.methods_disagree && r.model.fdv_tvl_multiple >= 0.1) return '';
    var s = catStats[r.category];
    return '<div class="whybox"><b>Why this multiple, in the open:</b> the size curve is sub-linear (slope ' + ME.curve_slope.toFixed(2) +
      '), so at ' + money(r.tvl_usd) + ' of TVL its multiple is mechanically low — the comps price scale this way' +
      (s && s.big ? ' (largest ' + esc(r.category || '') + ' comp ' + esc(s.big.name) + ' trades at ' + s.bigMult.toFixed(2) + 'x on ' + money(s.big.tvl) + ')' : '') +
      (s ? (s.n > 1 ? '; this category\u2019s ' + s.n + ' comps span ' + s.lo.toFixed(2) + 'x–' + s.hi.toFixed(2) + 'x' : '; it is the category\u2019s only comp') : '') +
      '. The median cross-check says ' + r.model.category_median_multiple.toFixed(2) + 'x vs the curve\u2019s ' + r.model.curve_multiple.toFixed(2) +
      'x; the blend keeps 90% curve weight because leave-one-out scores the curve x' + ME.loo_curve_factor.toFixed(2) + ' vs the median\u2019s x' + ME.loo_median_factor.toFixed(2) +
      ' — and the gap is flagged on the row, not averaged away.</div>';
  }
  function detailHtml(r) {
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    return '<section class="detail" id="detail"><div class="dhead"><div>' +
      '<h2>' + esc(r.name) + ' <span class="faint" style="font-size:14px">#' + r.rank + ' on the board</span></h2>' +
      '<div class="sub">' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorised') + ' · ' + r.chains.map(esc).join(', ') +
      ' · no token for ' + ageTxt(r.age_days) + (r.watchlist ? ' · house watchlist' : ' · early find below the $50M floor') + '</div></div>' +
      '<div class="bigval"><div class="k">Implied launch value</div><div class="v">' + money(r.implied_value_usd) + '</div></div></div>' +
      '<div class="dgrid">' +
      '<div class="dcell"><div class="k">TVL (snapshot)</div><div class="v">' + money(r.tvl_usd) + '</div><div class="s">7d ' + (r.change_7d == null ? 'unreported' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + ' · tracked since ' + esc(r.listed_at || 'an unrecorded date') + '</div></div>' +
      '<div class="dcell"><div class="k">Backtested band</div><div class="v">' + money(r.implied_low_usd) + ' – ' + money(r.implied_high_usd) + '</div><div class="s">leave-one-out x' + ME.loo_factor.toFixed(2) + ' on ' + ME.comps_count + ' comps</div></div>' +
      '<div class="dcell"><div class="k">Two methods, one blend</div><div class="v">' + r.model.curve_multiple.toFixed(2) + 'x / ' + r.model.category_median_multiple.toFixed(2) + 'x</div><div class="s">curve / category median, 90/10 → ' + r.model.fdv_tvl_multiple.toFixed(2) + 'x · ' + r.model.category_comps + (r.model.category_comps === 1 ? ' comp' : ' comps') + ' here · adj ' + r.model.momentum_multiplier.toFixed(2) + '/' + r.model.maturity_multiplier.toFixed(2) + '/' + r.model.reach_multiplier.toFixed(2) + ' mom/mat/reach' + (r.model.methods_disagree ? ' · <b class="disTxt">methods disagree</b>' : '') + '</div></div>' +
      '</div>' + whyBox(r) +
      '<div class="farm"><h3>Farm plan — week by week, before any launch</h3><ol>' + steps + '</ol>' +
      '<div class="netbox"><div class="nb"><div class="k">All-in plan cost</div><div class="v">$' + r.plan_cost_usd + '</div><div class="s">gas + fees over the hold; capital is separate and returns on unwind</div></div>' +
      '<div class="nb"><div class="k">Verdict at band low</div><div class="v verd-' + r.farm_verdict.toLowerCase() + '">' + r.farm_verdict + '</div><div class="s">netted against ' + money(r.implied_low_usd) + ' implied</div></div></div>' +
      '</div></section>';
  }
  function opts(list, cur) {
    return list.map(function (c) { return '<option' + (cur === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
  }
  function stat(k, v, s, cls) {
    return '<div class="stat' + (cls ? ' ' + cls : '') + '"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + s + '</div></div>';
  }
  function render() {
    var rows = filtered(), sel = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === state.sel) sel = rows[i];
    if (!sel && rows.length) sel = rows[0];
    app.innerHTML = '<div class="wrap">' +
      '<div class="top"><div class="brand"><div class="ring"></div><div>' +
      '<h1>Launch<span class="scope">Scope</span></h1>' +
      '<div class="tagline">Protocols that record no token yet: what a launch would be worth on today\u2019s record, and how to farm each one before it happens.</div>' +
      '</div></div><div class="asof">SNAPSHOT <b>' + esc(D.as_of) + '</b><br>MODEL <b>' + esc(D.model_version) + '</b><br>SOURCE <b>DefiLlama, sealed</b></div></div>' +
      '<div class="stats">' +
      stat('Pre-token audited', D.audited_count, 'of ' + D.scanned + ' protocols scanned') +
      stat('Watchlist covered', D.watchlist_size + ' / ' + D.watchlist_size, 'pre-token, over the $50M floor', 'cool') +
      stat('Board rows', D.board_size, D.early_size + ' early finds below the floor') +
      stat('Total implied value', money(D.total_implied_usd), 'across the whole board', 'hot') +
      stat('Backtest, median miss', 'x' + ME.loo_factor.toFixed(2), 'leave-one-out; time split x' + (ME.time_split_factor || 0).toFixed(2)) + '</div>' +
      methodPanel() +
      '<div class="modelnote"><b>How a value is earned:</b> ' + esc(D.model_note) + '</div>' +
      '<div class="controls">' +
      '<input type="search" id="q" placeholder="Search name or slug…" value="' + esc(state.q) + '">' +
      '<select id="cat"><option value="">All categories</option>' + opts(D.categories, state.cat) + '</select>' +
      '<select id="chain"><option value="">All chains</option>' + opts(D.chains, state.chain) + '</select>' +
      '<select id="verd"><option value=""' + (state.verdict === '' ? ' selected' : '') + '>All verdicts</option>' +
      ['FARM', 'WATCH', 'SKIP'].map(function (v) { return '<option value="' + v + '"' + (state.verdict === v ? ' selected' : '') + '>' + v.charAt(0) + v.slice(1).toLowerCase() + '</option>'; }).join('') + '</select>' +
      '<select id="sort">' +
      [['implied', 'implied value'], ['tvl', 'TVL'], ['growth', '7d growth'], ['age', 'age']].map(function (p) {
        return '<option value="' + p[0] + '"' + (state.sort === p[0] ? ' selected' : '') + '>Sort: ' + p[1] + '</option>'; }).join('') + '</select>' +
      '<span class="count">' + rows.length + ' shown</span></div>' +
      '<div class="board"><table><thead><tr><th>Rank</th><th>Protocol</th><th class="num">TVL</th><th class="num">7d</th><th class="num">Implied value</th><th class="num">Multiple</th><th class="num">No-token age</th><th>Verdict</th></tr></thead>' +
      '<tbody>' + (rows.length ? rows.map(rowHtml).join('') : '<tr><td colspan="8" class="empty">No protocol matches this filter.</td></tr>') + '</tbody></table></div>' +
      (sel ? detailHtml(sel) : '') +
      '<footer>One sealed DefiLlama snapshot (' + esc(D.as_of) + '), nothing live: the same snapshot always draws the same board. ' +
      'The model lives in this page\u2019s own source (model.js) and prices board.json too. Verdicts are netted at the band\u2019s low end. ' +
      'An implied value is a model claim about a launch that may never happen, not a prediction that a token will be issued.</footer></div>';
    app.setAttribute('aria-busy', 'false');
    drawChart();
    wire();
    var det = document.getElementById('detail');
    if (det && sel && sel.slug === state.sel) det.scrollIntoView({ block: 'nearest' });
  }
  function wire() {
    var q = document.getElementById('q');
    q.addEventListener('input', function () {
      var pos = q.selectionStart;
      state.q = q.value; render();
      var nq = document.getElementById('q'); nq.focus();
      try { nq.setSelectionRange(pos, pos); } catch (e) {}
    });
    [['cat', 'cat'], ['chain', 'chain'], ['verd', 'verdict'], ['sort', 'sort']].forEach(function (pair) {
      document.getElementById(pair[0]).addEventListener('change', function (e) { state[pair[1]] = e.target.value; render(); });
    });
    var trs = app.querySelectorAll('tbody tr[data-slug]');
    for (var i = 0; i < trs.length; i++)
      trs[i].addEventListener('click', function () { state.sel = this.getAttribute('data-slug'); render(); });
  }
  render();
})();
