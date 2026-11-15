// LaunchScope dashboard: renders window.RADAR (written by main.ts beside this page).
// No network, no framework: search, category/chain filters, segment + sort, and a
// detail view whose farm plan is the same plan board.json carries for that row.
(function () {
  var D = window.RADAR;
  var app = document.getElementById('app');
  if (!D) { app.innerHTML = '<div class="wrap"><p>No data: run main.ts first.</p></div>'; return; }

  var state = { q: '', cat: '', chain: '', seg: 'all', sort: 'implied', sel: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n;
  }
  function pct(n) {
    if (n == null) return '<span class="faint">n/a</span>';
    var cls = n >= 0 ? 'up' : 'down';
    return '<span class="' + cls + '">' + (n >= 0 ? '+' : '') + n.toFixed(1) + '%</span>';
  }
  function ageTxt(days) {
    if (days == null) return 'untracked';
    if (days >= 365) return (days / 365).toFixed(1) + ' yrs';
    return days + ' days';
  }

  var maxTvl = Math.max.apply(null, D.rows.map(function (r) { return r.tvl_usd; }));
  var maxVal = Math.max.apply(null, D.rows.map(function (r) { return r.implied_value_usd; }));

  function filtered() {
    var rows = D.rows.filter(function (r) {
      if (state.seg === 'watch' && !r.watchlist) return false;
      if (state.seg === 'early' && r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if (r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = {
      implied: function (r) { return r.implied_value_usd; },
      tvl: function (r) { return r.tvl_usd; },
      growth: function (r) { return r.change_7d == null ? -1e9 : r.change_7d; },
      age: function (r) { return r.age_days == null ? -1 : r.age_days; }
    }[state.sort];
    rows.sort(function (a, b) { return key(b) - key(a) || a.rank - b.rank; });
    return rows;
  }

  function rowHtml(r) {
    var chips = (r.category ? '<span class="chip cat">' + esc(r.category) + '</span>' : '') +
      r.chains.slice(0, 3).map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') +
      (r.chains.length > 3 ? '<span class="chip">+' + (r.chains.length - 3) + '</span>' : '');
    return '<tr data-slug="' + esc(r.slug) + '"' + (state.sel === r.slug ? ' class="sel"' : '') + '>' +
      '<td class="rk' + (r.rank <= 3 ? ' top' : '') + '">#' + r.rank + '</td>' +
      '<td><div class="pname">' + esc(r.name) + (r.watchlist ? ' <span class="chip wl">WATCHLIST</span>' : '') + '</div>' +
      '<div class="pslug">' + esc(r.slug) + '</div><div>' + chips + '</div></td>' +
      '<td class="num"><div class="money">' + money(r.tvl_usd) + '</div><div class="bar"><i style="width:' + Math.max(2, (r.tvl_usd / maxTvl) * 100) + '%"></i></div></td>' +
      '<td class="num">' + pct(r.change_7d) + '</td>' +
      '<td class="num"><div class="money big">' + money(r.implied_value_usd) + '</div><div class="bar val"><i style="width:' + Math.max(2, (r.implied_value_usd / maxVal) * 100) + '%"></i></div></td>' +
      '<td class="num dim">' + ageTxt(r.age_days) + '</td>' +
      '<td class="num mono dim">' + r.model.fdv_tvl_multiple.toFixed(2) + 'x</td></tr>';
  }

  function detailHtml(r) {
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    return '<section class="detail" id="detail"><div class="dhead"><div>' +
      '<h2>' + esc(r.name) + ' <span class="faint" style="font-size:14px">#' + r.rank + ' on the board</span></h2>' +
      '<div class="sub">' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorised') + ' · ' +
      r.chains.map(esc).join(', ') + ' · records no token yet' + (r.watchlist ? ' · on the house watchlist' : ' · early radar find, below the $50M watchlist floor') + '</div></div>' +
      '<div class="bigval"><div class="k">Implied launch value</div><div class="v">' + money(r.implied_value_usd) + '</div></div></div>' +
      '<div class="dgrid">' +
      '<div class="dcell"><div class="k">TVL (snapshot)</div><div class="v">' + money(r.tvl_usd) + '</div><div class="s">7d change ' + (r.change_7d == null ? 'unreported' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</div></div>' +
      '<div class="dcell"><div class="k">Category multiple</div><div class="v">' + r.model.fdv_tvl_multiple.toFixed(2) + 'x FDV/TVL</div><div class="s">median of ' + r.model.category_comps + ' trading peer' + (r.model.category_comps === 1 ? '' : 's') + ' in this snapshot</div></div>' +
      '<div class="dcell"><div class="k">Model adjustments</div><div class="v">' + r.model.momentum_multiplier.toFixed(2) + ' / ' + r.model.maturity_multiplier.toFixed(2) + ' / ' + r.model.reach_multiplier.toFixed(2) + '</div><div class="s">momentum / maturity / chain reach</div></div>' +
      '<div class="dcell"><div class="k">Time with no token</div><div class="v">' + ageTxt(r.age_days) + '</div><div class="s">tracked since ' + esc(r.listed_at || 'an unrecorded date') + '</div></div>' +
      '</div><div class="farm"><h3>Farm plan — do this before any launch</h3><ol>' + steps + '</ol></div></section>';
  }

  function render() {
    var rows = filtered();
    var sel = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === state.sel) sel = rows[i];
    if (!sel && rows.length) sel = rows[0];

    var catOpts = '<option value="">All categories</option>' + D.categories.map(function (c) {
      return '<option' + (state.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
    var chainOpts = '<option value="">All chains</option>' + D.chains.map(function (c) {
      return '<option' + (state.chain === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');

    app.innerHTML = '<div class="wrap">' +
      '<div class="top"><div class="brand"><div class="ring"></div><div>' +
      '<h1>Launch<span class="scope">Scope</span></h1>' +
      '<div class="tagline">A radar for protocols that record no token yet: what a launch would be worth on today\'s record, and exactly how to farm each one before it happens.</div>' +
      '</div></div><div class="asof">SNAPSHOT <b>' + esc(D.as_of) + '</b><br>MODEL <b>' + esc(D.model_version) + '</b><br>SOURCE <b>DefiLlama, sealed</b></div></div>' +

      '<div class="stats">' +
      '<div class="stat"><div class="k">Protocols scanned</div><div class="v">' + D.scanned + '</div><div class="s">every protocol over $5M TVL</div></div>' +
      '<div class="stat cool"><div class="k">Watchlist covered</div><div class="v">' + D.watchlist_size + ' / ' + D.watchlist_size + '</div><div class="s">pre-token, over the $50M floor</div></div>' +
      '<div class="stat"><div class="k">Board rows</div><div class="v">' + D.board_size + '</div><div class="s">' + D.early_size + ' early finds below the floor</div></div>' +
      '<div class="stat hot"><div class="k">Total implied value</div><div class="v">' + money(D.total_implied_usd) + '</div><div class="s">across the whole board</div></div>' +
      '<div class="stat"><div class="k">Global FDV / TVL</div><div class="v">' + D.global_multiple.toFixed(2) + 'x</div><div class="s">median of trading protocols</div></div>' +
      '</div>' +

      '<div class="modelnote"><b>How a value is earned:</b> ' + esc(D.model_note) + '</div>' +

      '<div class="controls">' +
      '<input type="search" id="q" placeholder="Search name or slug…" value="' + esc(state.q) + '">' +
      '<select id="cat">' + catOpts + '</select>' +
      '<select id="chain">' + chainOpts + '</select>' +
      '<div class="seg" id="seg">' +
      '<button data-seg="all"' + (state.seg === 'all' ? ' class="on"' : '') + '>All rows</button>' +
      '<button data-seg="watch"' + (state.seg === 'watch' ? ' class="on"' : '') + '>Watchlist</button>' +
      '<button data-seg="early"' + (state.seg === 'early' ? ' class="on"' : '') + '>Early finds</button></div>' +
      '<select id="sort">' +
      '<option value="implied"' + (state.sort === 'implied' ? ' selected' : '') + '>Sort: implied value</option>' +
      '<option value="tvl"' + (state.sort === 'tvl' ? ' selected' : '') + '>Sort: TVL</option>' +
      '<option value="growth"' + (state.sort === 'growth' ? ' selected' : '') + '>Sort: 7d growth</option>' +
      '<option value="age"' + (state.sort === 'age' ? ' selected' : '') + '>Sort: age</option></select>' +
      '<span class="count">' + rows.length + ' shown</span></div>' +

      '<div class="board"><table><thead><tr><th>Rank</th><th>Protocol</th><th class="num">TVL</th><th class="num">7d</th><th class="num">Implied value</th><th class="num">No-token age</th><th class="num">Multiple</th></tr></thead>' +
      '<tbody>' + (rows.length ? rows.map(rowHtml).join('') : '<tr><td colspan="7" class="empty">No protocol matches this filter. Loosen the search or pick another category.</td></tr>') + '</tbody></table></div>' +

      (sel ? detailHtml(sel) : '') +

      '<div class="live"><h3>Already trading — the evidence set (never ranked)</h3><div class="livegrid">' +
      D.live.slice(0, 8).map(function (l) {
        return '<div class="livecard"><div class="n">' + esc(l.name) + '</div><div class="m">' + esc(l.category || '') + ' · mcap ' + money(l.mcap_usd) + ' · TVL ' + money(l.tvl_usd) + ' · ' + (l.fdv_tvl == null ? '—' : l.fdv_tvl.toFixed(2) + 'x') + '</div></div>';
      }).join('') + '</div></div>' +

      '<footer>LaunchScope reads one sealed DefiLlama snapshot (' + esc(D.as_of) + ') and nothing live: the same snapshot always draws the same board. ' +
      'Implied value is this entry\'s own model claim about a launch that may never happen — it is not a prediction that a token will be issued. ' +
      'A protocol shown here records no token on DefiLlama; that is not proof it has none.</footer>' +
      '</div>';
    app.setAttribute('aria-busy', 'false');
    wire();
    var det = document.getElementById('detail');
    if (det && sel && sel.slug === state.sel) det.scrollIntoView({ block: 'nearest' });
  }

  function wire() {
    var q = document.getElementById('q');
    q.addEventListener('input', function () {
      var pos = q.selectionStart;
      state.q = q.value;
      render();
      var nq = document.getElementById('q');
      nq.focus();
      try { nq.setSelectionRange(pos, pos); } catch (e) {}
    });
    document.getElementById('cat').addEventListener('change', function (e) { state.cat = e.target.value; render(); });
    document.getElementById('chain').addEventListener('change', function (e) { state.chain = e.target.value; render(); });
    document.getElementById('sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });
    var seg = document.getElementById('seg');
    seg.addEventListener('click', function (e) {
      if (e.target.dataset && e.target.dataset.seg) { state.seg = e.target.dataset.seg; render(); }
    });
    var trs = app.querySelectorAll('tbody tr[data-slug]');
    for (var i = 0; i < trs.length; i++) {
      trs[i].addEventListener('click', function () { state.sel = this.getAttribute('data-slug'); render(); });
    }
  }

  render();
})();
