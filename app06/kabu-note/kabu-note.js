/* 株ノート：株価・指標・株主優待を見るアプリ
 * データは GitHub Actions が data/ に毎日書き出す JSON（tools/fetch_data.py）を読む。
 * 保有株・メモ・優待の見積もり・表示設定は localStorage に保存する。 */
'use strict';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEFAULT_REPO = 'jun21555/webapp';
const LS_KEY = 'kabuNote.v1';

// ---------- 保存 ----------
const store = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (_) {}
  s.hold ||= {}; s.memo ||= {}; s.yval ||= {}; s.set ||= {};
  return {
    get: () => s,
    save() { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (_) {} },
  };
})();
const S = store.get();

// ---------- 状態 ----------
const st = {
  index: null, yutai: {}, jpx: null, docs: {},
  view: 'list', code: null, per: '1Y', type: 'candle', ov: { ma: true, bb: false, cmp: false }, sub: 'vol', sec: 'ind',
  cmpPer: '1Y', cmpSel: null, cmpSort: 'ret1y', cmpDir: -1, ym: 0,
};

// ---------- 書式 ----------
const nf = (v, d = 0) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
const px = v => v == null ? '—' : nf(v, Math.abs(v) < 1000 && v % 1 ? 1 : (v % 1 && Math.abs(v) < 100 ? 2 : 0));
const pct = (v, d = 2, sign = true) => v == null || !isFinite(v) ? '—' : (sign && v > 0 ? '+' : '') + nf(v, d) + '%';
const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
function big(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e12) return s + nf(a / 1e12, 2) + '兆円';
  if (a >= 1e8) return s + nf(a / 1e8, a >= 1e10 ? 0 : 1) + '億円';
  if (a >= 1e4) return s + nf(a / 1e4, 0) + '万円';
  return s + nf(a) + '円';
}
const md = d => d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : '';
const ymd = d => d ? `${d.slice(0, 4)}/${+d.slice(5, 7)}/${+d.slice(8, 10)}` : '—';
function toast(t) { const e = $('#toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('on'), 2600); }
const css = n => getComputedStyle(document.body).getPropertyValue(n).trim();

// ---------- データ読み込み ----------
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.json();
}
async function loadAll() {
  $('#updated').textContent = '読み込み中…';
  st.loading = true;
  const [idx, yu] = await Promise.allSettled([getJSON('data/index.json'), getJSON('yutai.json')]);
  st.yutai = yu.status === 'fulfilled' ? yu.value : {};
  st.index = idx.status === 'fulfilled' ? idx.value : null;
  st.docs = {}; st.loading = false;
  if (st.index) {
    const u = st.index.updated;
    $('#updated').textContent = (st.index.sample ? '【サンプル】' : '') + `データ ${ymd(u)} ${u.slice(11, 16)} 更新`;
  } else {
    $('#updated').textContent = 'データ未取得';
  }
  render();
  getJSON('data/jpx-list.json').then(j => { st.jpx = j.rows; }).catch(() => {});
}
async function loadDoc(code) {
  if (st.docs[code]) return st.docs[code];
  const d = await getJSON(`data/${encodeURIComponent(code)}.json`);
  st.docs[code] = d;
  return d;
}
const items = () => st.index?.items || [];
const bench = () => st.index?.benchmarks?.[0];
const item = code => items().find(i => i.code === code);

// ---------- 優待の計算 ----------
function yInfo(code) {
  const y = st.yutai[code];
  if (!y || y.none) return y || null;
  return y;
}
function yValue(code) {
  if (S.yval[code] != null && S.yval[code] !== '') return +S.yval[code];
  const y = yInfo(code);
  return y && !y.none ? y.valueYen : null;
}
function yYield(code) {
  const y = yInfo(code), it = item(code), v = yValue(code);
  if (!y || y.none || !it || !y.minShares || v == null) return null;
  return v / (it.close * y.minShares) * 100;
}
function totalYield(code) {
  const it = item(code); if (!it) return null;
  const a = it.divYield, b = yYield(code);
  if (a == null && b == null) return null;
  return (a || 0) + (b || 0);
}

// 東証の休業日（土日・祝日・年末年始）
const HOLI = new Set(('2026-01-01,2026-01-02,2026-01-12,2026-02-11,2026-02-23,2026-03-20,2026-04-29,2026-05-04,2026-05-05,2026-05-06,2026-07-20,2026-08-11,2026-09-21,2026-09-22,2026-09-23,2026-10-12,2026-11-03,2026-11-23,2026-12-31,' +
  '2027-01-01,2027-01-11,2027-02-11,2027-02-23,2027-03-22,2027-04-29,2027-05-03,2027-05-04,2027-05-05,2027-07-19,2027-08-11,2027-09-20,2027-09-23,2027-10-11,2027-11-03,2027-11-23,2027-12-31,' +
  '2028-01-03,2028-01-10,2028-02-11,2028-02-23,2028-03-20,2028-05-03,2028-05-04,2028-05-05,2028-07-17,2028-08-11,2028-09-18,2028-09-22,2028-10-09,2028-11-03,2028-11-23,2028-12-31').split(','));
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function isBiz(d) {
  const w = d.getDay(), m = d.getMonth(), day = d.getDate();
  if (w === 0 || w === 6) return false;
  if (m === 0 && day <= 3) return false;
  return !HOLI.has(iso(d));
}
// 権利確定月 month の権利付最終日（＝月末の最終営業日から2営業日前）
function lastBuyDay(year, month) {
  const d = new Date(year, month, 0);
  while (!isBiz(d)) d.setDate(d.getDate() - 1);
  for (let n = 0; n < 2;) { d.setDate(d.getDate() - 1); if (isBiz(d)) n++; }
  return d;
}
function nextBuyDay(months) {
  if (!months?.length) return null;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  let best = null;
  for (const m of months) for (const y of [now.getFullYear(), now.getFullYear() + 1]) {
    const d = lastBuyDay(y, m);
    if (d >= now && (!best || d < best)) best = d;
  }
  return best;
}
const jd = d => d ? `${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]})` : '—';

// ---------- 小さなチャート ----------
function setup(cv, h) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth || cv.parentNode.clientWidth;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px';
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}
function spark(cv, arr, color) {
  if (!arr?.length) return;
  const { g, w, h } = setup(cv, cv.clientHeight || 30);
  const mn = Math.min(...arr), mx = Math.max(...arr), r = mx - mn || 1;
  g.beginPath();
  arr.forEach((v, i) => { const x = i / (arr.length - 1) * (w - 2) + 1, y = h - 3 - (v - mn) / r * (h - 6); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.strokeStyle = color; g.lineWidth = 1.6; g.lineJoin = 'round'; g.stroke();
  g.lineTo(w - 1, h); g.lineTo(1, h); g.closePath();
  const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, color + '55'); gr.addColorStop(1, color + '00');
  g.fillStyle = gr; g.fill();
}

// ---------- 画面切り替え ----------
const TITLES = { list: '株ノート', cmp: '比較・分析', yutai: '株主優待', hold: '保有・設定' };
function setView(v) {
  st.view = v;
  document.querySelectorAll('.view').forEach(e => e.classList.toggle('on', e.id === 'v-' + v));
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('#vTitle').textContent = TITLES[v];
  render();
  window.scrollTo(0, 0);
}
function render() {
  if (st.view === 'list') renderList();
  else if (st.view === 'cmp') renderCmp();
  else if (st.view === 'yutai') renderYutai();
  else renderHold();
}
function noData() {
  return `<div class="card msg"><b>まだデータがありません</b>GitHub Actions が初回のデータ取得を行っています。数分後に右上の更新ボタンを押してください。<br><br>
  しばらく待っても表示されない場合は、リポジトリの「Actions」タブで「株ノート データ更新」を手動実行してください。</div>`;
}

// ---------- 銘柄一覧 ----------
function sortItems(list, key) {
  const k = {
    chg: i => i.changePct, ret1y: i => i.ret1y, div: i => i.divYield, total: i => totalYield(i.code),
    per: i => i.per == null || i.per <= 0 ? null : -i.per, pbr: i => i.pbr == null ? null : -i.pbr, mcap: i => i.marketCap,
  }[key];
  if (!k) return list;
  return [...list].sort((a, b) => (k(b) ?? -Infinity) - (k(a) ?? -Infinity));
}
function renderList() {
  const b = bench(), el = $('#bench');
  if (b) {
    el.hidden = false;
    el.innerHTML = `<div class="l"><div class="nm">${esc(b.name)}（${md(b.date)}）</div><div class="px num">${nf(b.close, 0)}</div>
      <div class="num ${cls(b.change)}" style="font-weight:700;font-size:13px">${b.change > 0 ? '+' : ''}${nf(b.change, 0)}（${pct(b.changePct)}）</div></div><canvas></canvas>`;
    el.onclick = () => openDetail(b.code);
    el.style.cursor = 'pointer';
    requestAnimationFrame(() => spark(el.querySelector('canvas'), b.spark, b.change >= 0 ? css('--up') : css('--down')));
  } else el.hidden = true;
  const q = $('#q').value.trim().toLowerCase();
  let list = items().filter(i => !q || i.code.toLowerCase().includes(q) || i.name.toLowerCase().includes(q));
  list = sortItems(list, $('#sort').value);
  const box = $('#list');
  if (!st.index) { box.innerHTML = st.loading ? '<div class="msg">読み込み中…</div>' : noData(); return; }
  if (!list.length) { box.innerHTML = '<div class="msg">該当する銘柄がありません</div>'; return; }
  box.innerHTML = list.map(i => {
    const y = yInfo(i.code), ty = totalYield(i.code);
    const tags = [];
    if (y && !y.none) tags.push(`<span class="tag">優待 ${y.months.map(m => m + '月').join('・')}</span>`);
    if (S.hold[i.code]?.shares) tags.push('<span class="tag b">保有</span>');
    if (i.stale) tags.push('<span class="tag g">更新失敗</span>');
    return `<div class="stock" data-code="${esc(i.code)}">
      <div class="l"><div class="nm">${esc(i.name)}</div>
        <div class="sub"><span>${esc(i.code)}</span><span>PER ${i.per ? nf(i.per, 1) : '—'}</span><span>利回り ${ty != null ? nf(ty, 2) + '%' : '—'}</span>${tags.join('')}</div></div>
      <canvas></canvas>
      <div class="r"><div class="px num">${px(i.close)}</div><div class="ch num ${cls(i.change)}">${pct(i.changePct)}</div></div></div>`;
  }).join('');
  box.querySelectorAll('.stock').forEach(e => {
    e.onclick = () => openDetail(e.dataset.code);
    const it = item(e.dataset.code);
    const a = it.spark || [];
    spark(e.querySelector('canvas'), a, a[a.length - 1] >= a[0] ? css('--up') : css('--down'));
  });
}

// ---------- 銘柄の追加・削除 ----------
function repo() {
  const h = location.hostname;
  if (h.endsWith('.github.io')) {
    const owner = h.split('.')[0], name = location.pathname.split('/')[1];
    if (name) return `${owner}/${name}`;
  }
  return DEFAULT_REPO;
}
function issueUrl(action, code, name) {
  const title = `株ノート: ${action} ${code}`;
  const body = `${name || ''}（${code}）をウォッチリストから${action}します。\n\nこのまま「Create」を押してください。数分で自動的に反映され、この Issue は閉じられます。`;
  return `https://github.com/${repo()}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
function renderAdd() {
  const q = $('#aq').value.trim().toLowerCase(), box = $('#ares');
  const watched = new Set(items().map(i => i.code));
  let rows;
  if (!q) {
    rows = items().map(i => [i.code, i.name, '', '']);
    box.innerHTML = `<p class="note" style="margin:10px 0 4px">ウォッチ中の銘柄（${rows.length}）</p>`;
  } else {
    const src = st.jpx || [];
    rows = src.filter(r => r[0].toLowerCase().startsWith(q) || r[1].toLowerCase().includes(q)).slice(0, 40);
    if (/^[0-9][0-9a-z]{3}$/.test(q) && !rows.some(r => r[0].toLowerCase() === q)) rows.unshift([q.toUpperCase(), '（銘柄一覧にない／未取得）', '', '']);
    box.innerHTML = !st.jpx ? '<p class="note" style="margin:10px 0">銘柄一覧を読み込めていません。4桁の証券コードを入力してください。</p>' : '';
  }
  box.innerHTML += rows.map(r => {
    const w = watched.has(r[0]);
    return `<div class="res"><div class="l"><b>${esc(r[1])}</b><span>${esc(r[0])} ${esc(r[2])} ${esc(r[3])}</span></div>
      <a class="btn ${w ? 'ghost' : ''}" target="_blank" rel="noopener" href="${issueUrl(w ? '削除' : '追加', r[0], r[1])}">${w ? '削除' : '追加'}</a></div>`;
  }).join('') || '<div class="msg">見つかりません</div>';
}

// ---------- 詳細 ----------
async function openDetail(code) {
  st.code = code;
  const it = item(code) || st.index?.benchmarks?.find(b => b.code === code);
  $('#dTitle').textContent = it?.name || code;
  $('#dSub').textContent = code === 'N225' ? '指数' : code + ' 東証';
  $('#dHead').innerHTML = '<div class="msg">読み込み中…</div>';
  ['#dStats', '#dSeason', '#dSec'].forEach(s => $(s).innerHTML = '');
  const d = $('#detail'); d.classList.add('on'); d.setAttribute('aria-hidden', 'false'); d.scrollTop = 0;
  if (location.hash !== '#' + code) history.pushState({ code }, '', '#' + code);
  try {
    const [doc] = await Promise.all([loadDoc(code), loadDoc('N225').catch(() => null)]);
    if (st.code !== code) return;
    renderDetail(doc);
  } catch (e) {
    $('#dHead').innerHTML = `<div class="msg"><b>データを読み込めませんでした</b>${esc(e.message)}</div>`;
  }
}
function closeDetail(fromPop) {
  const d = $('#detail'); d.classList.remove('on'); d.setAttribute('aria-hidden', 'true');
  st.code = null;
  if (!fromPop && location.hash) history.back();
  render();
}

function renderDetail(doc) {
  const p = doc.prices, last = p[p.length - 1], prev = p[p.length - 2] || last, info = doc.info || {};
  const ch = last[4] - prev[4], chp = ch / prev[4] * 100;
  const jp = st.jpx?.find(r => r[0] === doc.code);
  const sector = jp ? jp[3] : SECTOR_JA[info.sector] || info.sector;
  const y = yInfo(doc.code);
  $('#dHead').innerHTML = `<div class="px num">${px(last[4])}<span style="font-size:14px;color:var(--dim);font-weight:600"> 円</span></div>
    <div class="ch num ${cls(ch)}">${ch > 0 ? '+' : ''}${px(ch)}（${pct(chp)}）</div>
    <div class="meta"><span>${ymd(last[0])} 終値</span>${sector ? `<span class="badge">${esc(sector)}</span>` : ''}${jp ? `<span class="badge">${esc(jp[2])}</span>` : ''}
    ${y && !y.none ? `<span class="tag">優待 ${y.months.map(m => m + '月').join('・')}</span>` : ''}</div>`;
  if (doc.code === 'N225') { st.ov.cmp = false; }
  renderChartControls(doc);
  drawChart();
  renderStats(doc);
  renderSeason(doc);
  renderSecSeg(doc);
}

// ---------- 指標計算 ----------
function sma(a, n) { const o = Array(a.length).fill(null); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
function ema(a, n) { const o = Array(a.length).fill(null), k = 2 / (n + 1); let e = null; for (let i = 0; i < a.length; i++) { if (a[i] == null) continue; e = e == null ? a[i] : a[i] * k + e * (1 - k); o[i] = e; } return o; }
function boll(a, n = 20, m = 2) {
  const mid = sma(a, n), up = Array(a.length).fill(null), lo = Array(a.length).fill(null);
  for (let i = n - 1; i < a.length; i++) { let v = 0; for (let j = i - n + 1; j <= i; j++) v += (a[j] - mid[i]) ** 2; const sd = Math.sqrt(v / n); up[i] = mid[i] + m * sd; lo[i] = mid[i] - m * sd; }
  return { mid, up, lo };
}
function rsi(a, n = 14) {
  const o = Array(a.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < a.length; i++) {
    const d = a[i] - a[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; o[i] = l ? 100 - 100 / (1 + g / l) : 100; } }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = l ? 100 - 100 / (1 + g / l) : 100; }
  }
  return o;
}
function macd(a) {
  const e1 = ema(a, 12), e2 = ema(a, 26), m = a.map((_, i) => e1[i] - e2[i]);
  const sig = ema(m.map((v, i) => i >= 25 ? v : null), 9);
  return { m: m.map((v, i) => i >= 25 ? v : null), sig, hist: m.map((v, i) => i >= 25 && sig[i] != null ? v - sig[i] : null) };
}
function weekStart(ds) { const d = new Date(ds + 'T00:00:00'); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return iso(d); }
function aggregate(prices, unit) {
  if (unit === 'd') return prices.map(p => ({ d: p[0], o: p[1], h: p[2], l: p[3], c: p[4], v: p[5] }));
  const out = []; let key = null, cur = null;
  for (const p of prices) {
    const k = unit === 'w' ? weekStart(p[0]) : p[0].slice(0, 7);
    if (k !== key) { cur = { d: p[0], o: p[1], h: p[2], l: p[3], c: p[4], v: p[5] }; out.push(cur); key = k; }
    else { cur.h = Math.max(cur.h, p[2]); cur.l = Math.min(cur.l, p[3]); cur.c = p[4]; cur.v += p[5]; cur.d = p[0]; }
  }
  return out;
}
const PERIODS = { '1M': [1, 'd'], '3M': [3, 'd'], '6M': [6, 'd'], '1Y': [12, 'd'], '3Y': [36, 'w'], '5Y': [60, 'w'], '10Y': [120, 'm'] };
const MA_N = { d: [25, 75], w: [13, 26], m: [12, 24] };
const UNIT_JA = { d: '日足', w: '週足', m: '月足' };
function startDate(lastDate, months) { const d = new Date(lastDate + 'T00:00:00'); d.setMonth(d.getMonth() - months); return iso(d); }

// ---------- メインチャート ----------
let CH = null;
function seg(el, opts, cur, on) {
  el.innerHTML = opts.map(([v, t]) => `<button data-v="${v}" class="${v === cur ? 'on' : ''}">${t}</button>`).join('');
  el.querySelectorAll('button').forEach(b => b.onclick = () => { el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); on(b.dataset.v); });
}
function renderChartControls(doc) {
  seg($('#perSeg'), Object.keys(PERIODS).map(k => [k, k.replace('M', 'ヶ月').replace('Y', '年')]), st.per, v => { st.per = v; drawChart(); renderStats(st.docs[st.code]); });
  const ov = [['type', st.type === 'candle' ? 'ローソク足' : 'ライン'], ['ma', '移動平均'], ['bb', 'ボリンジャー']];
  if (doc.code !== 'N225' && st.docs.N225) ov.push(['cmp', '日経平均と比較']);
  const box = $('#ovChips');
  box.innerHTML = ov.map(([k, t]) => `<button class="chip ${k === 'type' || st.ov[k] ? 'on' : ''}" data-k="${k}">${k === 'type' ? '⇄ ' : ''}${t}</button>`).join('');
  box.querySelectorAll('.chip').forEach(b => b.onclick = () => {
    const k = b.dataset.k;
    if (k === 'type') { st.type = st.type === 'candle' ? 'line' : 'candle'; b.textContent = '⇄ ' + (st.type === 'candle' ? 'ローソク足' : 'ライン'); }
    else { st.ov[k] = !st.ov[k]; b.classList.toggle('on', st.ov[k]); }
    drawChart();
  });
  seg($('#subSeg'), [['vol', '出来高'], ['rsi', 'RSI'], ['macd', 'MACD'], ['none', 'なし']], st.sub, v => { st.sub = v; drawChart(); });
}
function buildChart(doc) {
  const [months, unit] = PERIODS[st.per];
  const all = aggregate(doc.prices, unit);
  const closes = all.map(b => b.c);
  const from = startDate(doc.prices[doc.prices.length - 1][0], months);
  let s = all.findIndex(b => b.d >= from); if (s < 0) s = 0;
  const [n1, n2] = MA_N[unit];
  const ma1 = sma(closes, n1), ma2 = sma(closes, n2), bb = boll(closes), r = rsi(closes), mc = macd(closes);
  const vis = all.slice(s), sl = a => a.slice(s);
  let cmp = null;
  if (st.ov.cmp && st.docs.N225 && doc.code !== 'N225') {
    const nk = aggregate(st.docs.N225.prices, unit), map = new Map(nk.map(b => [unit === 'd' ? b.d : unit === 'w' ? weekStart(b.d) : b.d.slice(0, 7), b.c]));
    let lastV = null; const raw = vis.map(b => { const k = unit === 'd' ? b.d : unit === 'w' ? weekStart(b.d) : b.d.slice(0, 7); const v = map.get(k); if (v != null) lastV = v; return lastV; });
    const base = raw.find(v => v != null);
    if (base) cmp = raw.map(v => v == null ? null : v / base * vis[0].c);
  }
  return { unit, vis, ma1: sl(ma1), ma2: sl(ma2), n1, n2, bb: { up: sl(bb.up), lo: sl(bb.lo), mid: sl(bb.mid) }, rsi: sl(r), macd: { m: sl(mc.m), sig: sl(mc.sig), hist: sl(mc.hist) }, cmp, hover: null };
}
function drawChart() {
  const doc = st.docs[st.code]; if (!doc) return;
  CH = buildChart(doc);
  paint();
}
function paint() {
  if (!CH) return;
  const c = CH, n = c.vis.length, UP = css('--up'), DN = css('--down');
  const M = setup($('#cvMain'), 240), g = M.g, W = M.w, H = M.h, PL = 6, PR = 52, PT = 10, PB = 20;
  const step = (W - PL - PR) / n, X = i => PL + step * (i + .5);
  let lo = Infinity, hi = -Infinity;
  const take = v => { if (v != null && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } };
  c.vis.forEach((b, i) => {
    if (st.type === 'candle') { take(b.h); take(b.l); } else take(b.c);
    if (st.ov.ma) { take(c.ma1[i]); take(c.ma2[i]); }
    if (st.ov.bb) { take(c.bb.up[i]); take(c.bb.lo[i]); }
    if (c.cmp) take(c.cmp[i]);
  });
  const pad = (hi - lo) * .06 || hi * .01; lo -= pad; hi += pad;
  const Y = v => PT + (hi - v) / (hi - lo) * (H - PT - PB);
  // グリッドと目盛り
  g.font = '10.5px -apple-system,sans-serif'; g.textBaseline = 'middle';
  const tick = niceStep((hi - lo) / 4);
  g.strokeStyle = 'rgba(255,255,255,.07)'; g.fillStyle = '#8c97ad'; g.lineWidth = 1;
  for (let v = Math.ceil(lo / tick) * tick; v <= hi; v += tick) {
    const y = Math.round(Y(v)) + .5; g.beginPath(); g.moveTo(PL, y); g.lineTo(W - PR, y); g.stroke();
    g.fillText(nf(v, tick < 1 ? 1 : 0), W - PR + 5, y);
  }
  const labels = 4; g.textBaseline = 'alphabetic'; g.textAlign = 'center';
  for (let k = 0; k < labels; k++) {
    const i = Math.round((n - 1) * (k + .5) / labels), d = c.vis[i].d;
    g.fillText(c.unit === 'd' && st.per !== '1Y' ? md(d) : `${d.slice(2, 4)}/${+d.slice(5, 7)}`, X(i), H - 5);
  }
  g.textAlign = 'left';
  // ボリンジャーバンド
  if (st.ov.bb) {
    g.beginPath(); let started = false;
    c.bb.up.forEach((v, i) => { if (v == null) return; started ? g.lineTo(X(i), Y(v)) : (g.moveTo(X(i), Y(v)), started = true); });
    for (let i = n - 1; i >= 0; i--) if (c.bb.lo[i] != null) g.lineTo(X(i), Y(c.bb.lo[i]));
    g.closePath(); g.fillStyle = 'rgba(92,200,255,.08)'; g.fill();
    line(g, c.bb.up, X, Y, 'rgba(92,200,255,.55)', 1); line(g, c.bb.lo, X, Y, 'rgba(92,200,255,.55)', 1);
  }
  // 価格
  if (st.type === 'candle') {
    const bw = Math.max(1, Math.min(10, step * .68));
    c.vis.forEach((b, i) => {
      const col = b.c >= b.o ? UP : DN, x = X(i);
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
      g.beginPath(); g.moveTo(Math.round(x) + .5, Y(b.h)); g.lineTo(Math.round(x) + .5, Y(b.l)); g.stroke();
      const y1 = Y(Math.max(b.o, b.c)), y2 = Y(Math.min(b.o, b.c));
      g.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
    });
  } else {
    const col = c.vis[n - 1].c >= c.vis[0].c ? UP : DN;
    g.beginPath(); c.vis.forEach((b, i) => i ? g.lineTo(X(i), Y(b.c)) : g.moveTo(X(i), Y(b.c)));
    g.strokeStyle = col; g.lineWidth = 1.8; g.lineJoin = 'round'; g.stroke();
    g.lineTo(X(n - 1), H - PB); g.lineTo(X(0), H - PB); g.closePath();
    const gr = g.createLinearGradient(0, PT, 0, H - PB); gr.addColorStop(0, col + '44'); gr.addColorStop(1, col + '00'); g.fillStyle = gr; g.fill();
  }
  if (st.ov.ma) { line(g, c.ma1, X, Y, '#f5b942', 1.4); line(g, c.ma2, X, Y, '#c084fc', 1.4); }
  if (c.cmp) { g.setLineDash([4, 3]); line(g, c.cmp, X, Y, '#e8ecf4', 1.3); g.setLineDash([]); }
  // 最新値
  const lc = c.vis[n - 1].c, ly = Y(lc);
  g.setLineDash([2, 3]); g.strokeStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.moveTo(PL, ly); g.lineTo(W - PR, ly); g.stroke(); g.setLineDash([]);
  g.fillStyle = lc >= c.vis[0].c ? UP : DN; roundRect(g, W - PR + 1, ly - 9, PR - 2, 18, 4); g.fill();
  g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.font = 'bold 10.5px -apple-system,sans-serif'; g.fillText(nf(lc, lc < 1000 && lc % 1 ? 1 : 0), W - PR + 4, ly);
  // サブチャート
  const sub = $('#cvSub');
  if (st.sub === 'none') { sub.style.display = 'none'; } else {
    sub.style.display = 'block';
    const Sx = setup(sub, 84), s = Sx.g, SH = Sx.h, top = 6, bot = SH - 4, yS = (v, a, b) => top + (b - v) / (b - a) * (bot - top);
    s.font = '10px -apple-system,sans-serif'; s.fillStyle = '#8c97ad'; s.textBaseline = 'middle';
    s.strokeStyle = 'rgba(255,255,255,.07)'; s.beginPath(); s.moveTo(PL, .5); s.lineTo(W - PR, .5); s.stroke();
    if (st.sub === 'vol') {
      const mx = Math.max(...c.vis.map(b => b.v)) || 1, bw = Math.max(1, step * .68);
      c.vis.forEach((b, i) => { s.fillStyle = (b.c >= b.o ? UP : DN) + '99'; const y = yS(b.v, 0, mx); s.fillRect(X(i) - bw / 2, y, bw, bot - y); });
      s.fillStyle = '#8c97ad'; s.fillText('出来高', W - PR + 5, 12); s.fillText(volFmt(mx), W - PR + 5, 26);
    } else if (st.sub === 'rsi') {
      [30, 70].forEach(v => { s.strokeStyle = 'rgba(255,255,255,.12)'; s.setLineDash([3, 3]); s.beginPath(); s.moveTo(PL, yS(v, 0, 100)); s.lineTo(W - PR, yS(v, 0, 100)); s.stroke(); s.setLineDash([]); s.fillText(v, W - PR + 5, yS(v, 0, 100)); });
      line(s, c.rsi, X, v => yS(v, 0, 100), '#5cc8ff', 1.4);
      s.fillText('RSI(14)', W - PR + 5, 10);
    } else {
      const vals = [...c.macd.m, ...c.macd.sig, ...c.macd.hist].filter(v => v != null);
      const a = Math.max(...vals.map(Math.abs)) || 1, Ys = v => yS(v, -a, a), bw = Math.max(1, step * .6);
      c.macd.hist.forEach((v, i) => { if (v == null) return; s.fillStyle = (v >= 0 ? UP : DN) + '88'; const y = Ys(v); s.fillRect(X(i) - bw / 2, Math.min(y, Ys(0)), bw, Math.abs(Ys(0) - y)); });
      line(s, c.macd.m, X, Ys, '#5cc8ff', 1.3); line(s, c.macd.sig, X, Ys, '#f5b942', 1.3);
      s.fillStyle = '#8c97ad'; s.fillText('MACD', W - PR + 5, 10);
    }
    if (c.hover != null) { s.strokeStyle = 'rgba(255,255,255,.45)'; s.beginPath(); s.moveTo(X(c.hover), 0); s.lineTo(X(c.hover), SH); s.stroke(); }
  }
  // カーソル
  const hi_ = c.hover ?? n - 1, b = c.vis[hi_], pb = c.vis[hi_ - 1];
  if (c.hover != null) {
    g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(X(c.hover), PT); g.lineTo(X(c.hover), H - PB); g.moveTo(PL, Y(b.c)); g.lineTo(W - PR, Y(b.c)); g.stroke();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(X(c.hover), Y(b.c), 3.5, 0, 7); g.fill();
  }
  const chg = pb ? (b.c / pb.c - 1) * 100 : null;
  const extra = st.sub === 'rsi' && c.rsi[hi_] != null ? ` <span>RSI <b>${nf(c.rsi[hi_], 1)}</b></span>` : '';
  const ma = st.ov.ma ? ` <span style="color:#f5b942">${c.n1}${c.unit === 'd' ? '日' : c.unit === 'w' ? '週' : 'ヶ月'} <b style="color:inherit">${px(c.ma1[hi_])}</b></span><span style="color:#c084fc">${c.n2} <b style="color:inherit">${px(c.ma2[hi_])}</b></span>` : '';
  $('#cInfo').innerHTML = `<span><b>${ymd(b.d)}</b> ${UNIT_JA[c.unit]}</span><span>始 <b>${px(b.o)}</b></span><span>高 <b>${px(b.h)}</b></span><span>安 <b>${px(b.l)}</b></span><span>終 <b>${px(b.c)}</b></span>
    <span class="${cls(chg)}">${pct(chg)}</span><span>出来高 <b>${volFmt(b.v)}</b></span>${ma}${extra}${c.cmp ? '<span>┄ 日経平均（同じ起点に換算）</span>' : ''}`;
}
function line(g, arr, X, Y, col, w) {
  g.beginPath(); let on = false;
  arr.forEach((v, i) => { if (v == null) { on = false; return; } on ? g.lineTo(X(i), Y(v)) : (g.moveTo(X(i), Y(v)), on = true); });
  g.strokeStyle = col; g.lineWidth = w; g.lineJoin = 'round'; g.stroke();
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function niceStep(raw) { const p = 10 ** Math.floor(Math.log10(raw || 1)), f = raw / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; }
const volFmt = v => v >= 1e8 ? nf(v / 1e8, 1) + '億' : v >= 1e4 ? nf(v / 1e4, 0) + '万' : nf(v);
function hoverAt(ev) {
  if (!CH) return;
  const r = $('#cvMain').getBoundingClientRect(), x = ev.clientX - r.left, n = CH.vis.length;
  const i = Math.floor((x - 6) / ((r.width - 58) / n));
  CH.hover = Math.max(0, Math.min(n - 1, i)); paint();
}
['#cvMain', '#cvSub'].forEach(s => {
  const cv = $(s);
  cv.addEventListener('pointerdown', e => { hoverAt(e); });
  cv.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' || e.buttons || e.pressure) hoverAt(e); });
  const clear = () => { if (CH && CH.hover != null) { setTimeout(() => { if (CH) { CH.hover = null; paint(); } }, 1600); } };
  cv.addEventListener('pointerup', clear); cv.addEventListener('pointercancel', clear); cv.addEventListener('pointerleave', clear);
});

// ---------- 期間分析 ----------
function returns(prices) { const r = []; for (let i = 1; i < prices.length; i++) r.push(prices[i][4] / prices[i - 1][4] - 1); return r; }
function renderStats(doc) {
  const [months] = PERIODS[st.per];
  const all = doc.prices, from = startDate(all[all.length - 1][0], months);
  const p = all.filter(x => x[0] >= from);
  if (p.length < 3) { $('#dStats').innerHTML = ''; return; }
  const c0 = p[0][4], c1 = p[p.length - 1][4], ret = (c1 / c0 - 1) * 100;
  const yrs = (new Date(p[p.length - 1][0]) - new Date(p[0][0])) / 31557600000;
  const cagr = yrs >= 1 ? ((c1 / c0) ** (1 / yrs) - 1) * 100 : null;
  const r = returns(p), mean = r.reduce((a, b) => a + b, 0) / r.length;
  const vol = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1)) * Math.sqrt(245) * 100;
  let peak = -Infinity, mdd = 0, hi = p[0], lo = p[0];
  for (const x of p) { peak = Math.max(peak, x[4]); mdd = Math.min(mdd, x[4] / peak - 1); if (x[2] > hi[2]) hi = x; if (x[3] < lo[3]) lo = x; }
  const upDays = r.filter(v => v > 0).length / r.length * 100;
  // 日経平均との相関・β
  let corr = null, beta = null;
  const nk = st.docs.N225;
  if (nk && doc.code !== 'N225') {
    const m = new Map(nk.prices.map(x => [x[0], x[4]])), a = [], b = [];
    for (let i = 1; i < p.length; i++) { const n0 = m.get(p[i - 1][0]), n1 = m.get(p[i][0]); if (n0 && n1) { a.push(p[i][4] / p[i - 1][4] - 1); b.push(n1 / n0 - 1); } }
    if (a.length > 15) {
      const ma = a.reduce((x, y) => x + y) / a.length, mb = b.reduce((x, y) => x + y) / b.length;
      let cov = 0, va = 0, vb = 0; a.forEach((v, i) => { cov += (v - ma) * (b[i] - mb); va += (v - ma) ** 2; vb += (b[i] - mb) ** 2; });
      corr = cov / Math.sqrt(va * vb); beta = cov / vb;
    }
  }
  // 52週レンジ
  const y1 = all.filter(x => x[0] >= startDate(all[all.length - 1][0], 12));
  const h52 = Math.max(...y1.map(x => x[2])), l52 = Math.min(...y1.map(x => x[3])), pos = (c1 - l52) / (h52 - l52 || 1) * 100;
  const label = st.per.replace('M', 'ヶ月').replace('Y', '年');
  const kv = (k, v, s = '', c = '') => `<div class="kv"><div class="k">${k}</div><div class="v num ${c}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  $('#dStats').innerHTML = `<h2>期間分析 <small>${label}・日次データ</small></h2><div class="grid">
    ${kv('期間騰落率', pct(ret), `${px(c0)} → ${px(c1)}`, cls(ret))}
    ${kv('年率リターン', cagr == null ? '—' : pct(cagr), cagr == null ? '1年以上の期間で表示' : '複利換算', cls(cagr))}
    ${kv('ボラティリティ', nf(vol, 1) + '%', '年率換算の値動きの大きさ')}
    ${kv('最大下落率', pct(mdd * 100), '高値からの最大の落ち込み', 'down')}
    ${kv('期間高値', px(hi[2]), ymd(hi[0]))}
    ${kv('期間安値', px(lo[3]), ymd(lo[0]))}
    ${kv('上昇した日', nf(upDays, 0) + '%', `${r.length} 営業日中`)}
    ${corr == null ? kv('平均出来高', volFmt(p.reduce((a, x) => a + x[5], 0) / p.length), '1日あたり') : kv('日経平均との連動', 'β ' + nf(beta, 2), `相関 ${nf(corr, 2)}（1＝同じ動き）`)}
  </div>
  <div style="margin-top:14px;font-size:12px;color:var(--dim)">52週レンジでの現在位置 <b style="color:var(--text)">${nf(pos, 0)}%</b></div>
  <div class="rng"><i style="left:${Math.max(0, Math.min(100, pos))}%"></i></div>
  <div class="rngl num"><span>安値 ${px(l52)}</span><span>高値 ${px(h52)}</span></div>`;
}
function renderSeason(doc) {
  const m = aggregate(doc.prices, 'm');
  if (m.length < 25) { $('#dSeason').innerHTML = ''; return; }
  const bucket = Array.from({ length: 12 }, () => []);
  for (let i = 1; i < m.length; i++) bucket[+m[i].d.slice(5, 7) - 1].push(m[i].c / m[i - 1].c - 1);
  const avg = bucket.map(b => b.length ? b.reduce((x, y) => x + y) / b.length * 100 : 0), win = bucket.map(b => b.length ? b.filter(v => v > 0).length / b.length * 100 : 0);
  const yrs = Math.round(m.length / 12);
  $('#dSeason').innerHTML = `<h2>月別の傾向 <small>過去約${yrs}年の平均騰落率</small></h2><canvas id="cvSeason"></canvas>
    <p class="note" style="margin-top:6px">棒＝その月の平均騰落率、数字＝上昇した年の割合。権利確定月の前後の値動きの確認などに。</p>`;
  requestAnimationFrame(() => {
    const { g, w, h } = setup($('#cvSeason'), 130), mx = Math.max(...avg.map(Math.abs), 1), mid = 58, bw = (w - 8) / 12;
    g.font = '10px -apple-system,sans-serif'; g.textAlign = 'center';
    g.strokeStyle = 'rgba(255,255,255,.15)'; g.beginPath(); g.moveTo(0, mid + .5); g.lineTo(w, mid + .5); g.stroke();
    avg.forEach((v, i) => {
      const x = 4 + bw * i, bh = v / mx * 46;
      g.fillStyle = v >= 0 ? css('--up') : css('--down'); g.fillRect(x + bw * .18, v >= 0 ? mid - bh : mid, bw * .64, Math.abs(bh));
      g.fillStyle = '#8c97ad'; g.fillText((i + 1) + '月', x + bw / 2, h - 18);
      g.fillStyle = win[i] >= 60 ? '#e8ecf4' : '#8c97ad'; g.fillText(nf(win[i], 0) + '%', x + bw / 2, h - 4);
    });
  });
}

// ---------- 詳細のセクション ----------
const SECTOR_JA = { Technology: 'テクノロジー', 'Consumer Cyclical': '一般消費財', 'Consumer Defensive': '生活必需品', 'Financial Services': '金融', 'Communication Services': '通信サービス', Industrials: '資本財', Healthcare: 'ヘルスケア', 'Basic Materials': '素材', Energy: 'エネルギー', Utilities: '公益', 'Real Estate': '不動産' };
const REC_JA = { strong_buy: '強気買い', buy: '買い', hold: '中立', underperform: 'やや売り', sell: '売り', none: '—' };
function renderSecSeg(doc) {
  const opts = doc.code === 'N225' ? [['div', '概要']] : [['ind', '指標'], ['fin', '業績'], ['div', '配当'], ['yutai', '優待'], ['co', '企業'], ['mine', '保有']];
  if (!opts.some(o => o[0] === st.sec)) st.sec = opts[0][0];
  seg($('#secSeg'), opts, st.sec, v => { st.sec = v; renderSec(); });
  renderSec();
}
function renderSec() {
  const doc = st.docs[st.code]; if (!doc) return;
  const f = { ind: secInd, fin: secFin, div: secDiv, yutai: secYutai, co: secCo, mine: secMine }[st.sec];
  $('#dSec').innerHTML = doc.code === 'N225' ? `<div class="card"><p class="note">日経平均株価（東証プライム上場の代表的な225銘柄の株価から算出する指数）。各銘柄の「日経平均と比較」や β の計算に使っています。</p></div>` : f(doc);
  if (st.sec === 'fin') drawFin(doc);
  if (st.sec === 'div') drawDiv(doc);
  bindSec(doc);
}
function lastClose(doc) { return doc.prices[doc.prices.length - 1][4]; }
function divRate(doc) {
  const i = doc.info || {}; if (i.dividendRate) return i.dividendRate; if (i.trailingAnnualDividendRate) return i.trailingAnnualDividendRate;
  const from = startDate(doc.prices[doc.prices.length - 1][0], 12); const s = (doc.dividends || []).filter(d => d[0] > from).reduce((a, d) => a + d[1], 0);
  return s || null;
}
const HELP = {
  PER: '株価 ÷ 1株あたり利益。利益の何年分で株価になるか。低いほど割安の目安（業種で水準が違う）。',
  PBR: '株価 ÷ 1株あたり純資産。1倍未満は解散価値を下回る水準。',
  ROE: '自己資本利益率。株主のお金でどれだけ効率よく稼いだか。8〜10%以上が一つの目安。',
  ROA: '総資産利益率。会社の資産全体でどれだけ稼いだか。',
  配当利回り: '1株配当（予想・実績）÷ 株価。',
  配当性向: '利益のうち配当に回した割合。高すぎると減配リスクも。',
  β: '日経平均などの市場全体が1%動いたとき、この株が平均で何%動くか（Yahoo Finance の値）。',
  自己資本比率: '総資産のうち返済不要の自己資本の割合。高いほど財務が安定。',
  目標株価: 'アナリスト予想の平均目標株価と、現在の株価からの乖離。',
};
function secInd(doc) {
  const i = doc.info || {}, c = lastClose(doc), dr = divRate(doc), fin = (doc.financials || []).slice(-1)[0];
  const kv = (k, v, s = '') => `<div class="kv ${HELP[k] ? 'tap' : ''}" data-help="${esc(k)}"><div class="k">${k}${HELP[k] ? ' ⓘ' : ''}</div><div class="v num">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  const x = (v, d = 2) => v == null ? '—' : nf(v, d) + '倍';
  const p = (v, d = 1) => v == null ? '—' : nf(v * 100, d) + '%';
  const tgt = i.targetMeanPrice ? (i.targetMeanPrice / c - 1) * 100 : null;
  return `<div class="card"><h2>主な指標 <small>Yahoo Finance・${ymd(doc.updated)}</small></h2><div class="grid">
    ${kv('時価総額', big(i.marketCap))}
    ${kv('PER', x(i.trailingPE), '実績' + (i.forwardPE ? `／予想 ${x(i.forwardPE)}` : ''))}
    ${kv('PBR', x(i.priceToBook))}
    ${kv('ROE', p(i.returnOnEquity))}
    ${kv('ROA', p(i.returnOnAssets))}
    ${kv('EPS', i.trailingEps == null ? '—' : nf(i.trailingEps, 1) + '円', '1株あたり利益' + (i.forwardEps ? `（予想 ${nf(i.forwardEps, 1)}円）` : ''))}
    ${kv('BPS', i.bookValue == null ? '—' : nf(i.bookValue, 0) + '円', '1株あたり純資産')}
    ${kv('配当利回り', dr ? nf(dr / c * 100, 2) + '%' : '—', dr ? `1株配当 ${nf(dr, 1)}円` : '')}
    ${kv('配当性向', p(i.payoutRatio, 0))}
    ${kv('営業利益率', p(i.operatingMargins))}
    ${kv('純利益率', p(i.profitMargins))}
    ${kv('自己資本比率', fin?.equityRatio ? nf(fin.equityRatio * 100, 1) + '%' : '—', fin ? ymd(fin.date) + ' 期' : '')}
    ${kv('売上成長率', p(i.revenueGrowth), '前年同期比')}
    ${kv('β', i.beta == null ? '—' : nf(i.beta, 2))}
    ${kv('目標株価', i.targetMeanPrice ? nf(i.targetMeanPrice, 0) + '円' : '—', tgt == null ? '' : `現在値から ${pct(tgt, 1)}・${REC_JA[i.recommendationKey] || ''}（${i.numberOfAnalystOpinions || '?'}人）`)}
    ${kv('次回決算', ymd(doc.calendar?.earningsDate || i.earningsTimestamp), '予定日（目安）')}
  </div><p class="note" style="margin-top:10px">ⓘ のついた項目はタップで説明を表示。指標はデータ元の計算方法により証券会社の表示と異なることがあります。</p></div>`;
}
function secFin(doc) {
  const f = doc.financials || [];
  if (!f.length) return '<div class="card msg">業績データがありません</div>';
  const oku = v => v == null ? '—' : nf(v / 1e8, 0);
  return `<div class="card"><h2>業績の推移 <small>年次・億円</small></h2>
    <div class="chips" id="finChips"><button class="chip on" data-k="revenue">売上高</button><button class="chip" data-k="operatingIncome">営業利益</button><button class="chip" data-k="netIncome">純利益</button><button class="chip" data-k="eps">EPS</button></div>
    <canvas id="cvFin" style="width:100%;margin-top:10px"></canvas>
    <div class="scrollx" style="margin-top:10px"><table class="t"><tr><th>決算期</th><th>売上高</th><th>営業利益</th><th>利益率</th><th>純利益</th><th>EPS</th></tr>
    ${f.slice().reverse().map(r => `<tr><td>${r.date.slice(0, 7).replace('-', '/')}</td><td class="num">${oku(r.revenue)}</td><td class="num">${oku(r.operatingIncome)}</td>
      <td class="num">${r.revenue && r.operatingIncome != null ? nf(r.operatingIncome / r.revenue * 100, 1) + '%' : '—'}</td><td class="num">${oku(r.netIncome)}</td><td class="num">${r.eps == null ? '—' : nf(r.eps, 1)}</td></tr>`).join('')}
    </table></div><p class="note" style="margin-top:8px">データ元が提供する直近4期程度まで。詳しい決算は企業の決算短信で確認を。</p></div>`;
}
function bars(cv, labels, vals, color, fmt) {
  const { g, w, h } = setup(cv, 150), n = vals.length, mx = Math.max(...vals.map(v => Math.abs(v || 0)), 1), hasNeg = vals.some(v => v < 0);
  const base = hasNeg ? 80 : h - 22, sc = (hasNeg ? 60 : h - 44) / mx, bw = (w - 10) / n;
  g.font = '10.5px -apple-system,sans-serif'; g.textAlign = 'center';
  vals.forEach((v, i) => {
    const x = 5 + bw * i, bh = (v || 0) * sc;
    g.fillStyle = v < 0 ? css('--down') : color; roundRect(g, x + bw * .2, v >= 0 ? base - bh : base, bw * .6, Math.max(1, Math.abs(bh)), 3); g.fill();
    g.fillStyle = '#e8ecf4'; g.fillText(v == null ? '' : fmt(v), x + bw / 2, v >= 0 ? base - bh - 5 : base - bh + 12);
    g.fillStyle = '#8c97ad'; g.fillText(labels[i], x + bw / 2, h - 6);
  });
}
function drawFin(doc, key = 'revenue') {
  const f = doc.financials || []; if (!f.length) return;
  const cv = $('#cvFin'); if (!cv) return;
  bars(cv, f.map(r => r.date.slice(0, 4) + '/' + +r.date.slice(5, 7)), f.map(r => r[key]), key === 'eps' ? '#c084fc' : '#5cc8ff', v => key === 'eps' ? nf(v, 0) : nf(v / 1e8, 0));
}
function divByYear(doc) {
  const m = {}; (doc.dividends || []).forEach(d => { const y = d[0].slice(0, 4); m[y] = (m[y] || 0) + d[1]; });
  return Object.entries(m).sort();
}
function secDiv(doc) {
  const dv = doc.dividends || [], c = lastClose(doc), dr = divRate(doc), yrs = divByYear(doc).slice(-10);
  if (!dv.length) return '<div class="card msg">配当の記録がありません</div>';
  return `<div class="card"><h2>配当 <small>1株あたり・権利落ち日ベース</small></h2>
    <div class="grid" style="margin-bottom:10px">
      <div class="kv"><div class="k">年間配当（予想・実績）</div><div class="v num">${dr ? nf(dr, 1) + '円' : '—'}</div></div>
      <div class="kv"><div class="k">配当利回り</div><div class="v num">${dr ? nf(dr / c * 100, 2) + '%' : '—'}</div></div>
      <div class="kv"><div class="k">次の権利落ち日</div><div class="v num" style="font-size:15px">${ymd(doc.calendar?.exDividendDate || doc.info?.exDividendDate)}</div><div class="s">データ元の予定（目安）</div></div>
      <div class="kv"><div class="k">100株の年間配当</div><div class="v num">${dr ? nf(dr * 100) + '円' : '—'}</div><div class="s">税引前</div></div>
    </div>
    <canvas id="cvDiv" style="width:100%"></canvas>
    <p class="note" style="margin:4px 0 8px">年ごとの合計（株式分割は調整済み）。今年はまだ途中の場合があります。</p>
    <table class="t"><tr><th>権利落ち日</th><th>1株配当</th></tr>${dv.slice(-8).reverse().map(d => `<tr><td>${ymd(d[0])}</td><td class="num">${nf(d[1], 2)}円</td></tr>`).join('')}</table></div>`;
}
function drawDiv(doc) {
  const cv = $('#cvDiv'); if (!cv) return;
  const y = divByYear(doc).slice(-10);
  bars(cv, y.map(r => r[0].slice(2) + '年'), y.map(r => r[1]), '#f5b942', v => nf(v, v < 10 ? 1 : 0));
}
function secYutai(doc) {
  const y = yInfo(doc.code), c = lastClose(doc), code = doc.code;
  const links = `<div class="links" style="margin-top:10px">
    <a href="https://finance.yahoo.co.jp/quote/${code}.T/incentive" target="_blank" rel="noopener">Yahoo!ファイナンス 優待</a>
    <a href="https://minkabu.jp/stock/${code}/yutai" target="_blank" rel="noopener">みんかぶ 優待</a>
    ${(y?.sources || []).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">出典${i + 1}</a>`).join('')}</div>`;
  if (!y) return `<div class="card"><h2>株主優待</h2><p class="note">この銘柄の優待情報はまだ登録されていません。下のリンクで最新情報を確認できます。<br>登録するにはリポジトリの <b>app06/kabu-note/yutai.json</b> に追記してください。</p>${links}</div>`;
  if (y.none) return `<div class="card"><h2>株主優待</h2><p style="font-size:15px">株主優待：<b>${esc(y.title)}</b></p><p class="note" style="margin-top:4px">確認日 ${ymd(y.checked)}</p>${links}</div>`;
  const inv = y.minShares ? c * y.minShares : null, v = yValue(code), yy = yYield(code), dr = divRate(doc), dy = dr ? dr / c * 100 : null;
  const nb = nextBuyDay(y.months), held = S.hold[code]?.shares || 0;
  return `<div class="card yt"><h2>株主優待 <small>確認日 ${ymd(y.checked)}</small></h2>
    <h3>${esc(y.title)}</h3>
    <div class="ymonths">${y.months.map(m => `<span class="tag">${m}月末 権利確定</span>`).join('')}${y.category ? `<span class="badge">${esc(y.category)}</span>` : ''}
      ${held ? `<span class="badge ${held >= y.minShares ? 'ok' : ''}">${held >= y.minShares ? '保有株数で対象' : `あと${nf(y.minShares - held)}株で対象`}</span>` : ''}</div>
    <div class="grid" style="margin:10px 0">
      <div class="kv"><div class="k">必要株数・最低投資金額</div><div class="v num" style="font-size:15px">${y.minShares ? nf(y.minShares) + '株' : '—'}</div><div class="s">${inv ? '約 ' + big(inv) : ''}</div></div>
      <div class="kv"><div class="k">次の権利付最終日</div><div class="v num" style="font-size:15px">${jd(nb)}</div><div class="s">この日の大引けまでに買う（目安）</div></div>
      <div class="kv"><div class="k">優待利回り</div><div class="v num">${yy == null ? '—' : nf(yy, 2) + '%'}</div><div class="s">${v == null ? '年間価値を入力すると計算' : `年間 ${nf(v)}円相当として`}</div></div>
      <div class="kv"><div class="k">総合利回り</div><div class="v num">${dy == null && yy == null ? '—' : nf((dy || 0) + (yy || 0), 2) + '%'}</div><div class="s">配当 ${dy == null ? '—' : nf(dy, 2) + '%'} ＋ 優待</div></div>
    </div>
    <table class="t"><tr><th>保有株数</th><th style="text-align:left">内容</th></tr>${(y.tiers || []).map(t => `<tr><td class="num">${nf(t.shares)}株〜</td><td style="text-align:left;white-space:normal">${esc(t.text)}</td></tr>`).join('')}</table>
    ${y.condition ? `<p class="sum" style="margin-top:10px"><b>条件</b>：${esc(y.condition)}</p>` : ''}
    ${y.detail ? `<p class="sum" style="margin-top:6px">${esc(y.detail)}</p>` : ''}
    <div style="margin-top:12px"><label class="f" for="yv">優待の年間価値（円換算・自分の見積もり）</label>
      <div class="row"><input class="inp num" id="yv" type="number" inputmode="numeric" placeholder="${y.valueYen ?? '例：13000'}" value="${S.yval[code] ?? ''}"><button class="btn ghost" id="yvClr">既定に戻す</button></div>
      <p class="note" style="margin-top:4px">最低株数で1年間にもらえる分の目安。比較画面の優待利回り・総合利回りにも反映されます。</p></div>
    ${links}<p class="note" style="margin-top:10px">優待は変更・廃止されることがあります。取引前に必ず企業の公式サイトで最新情報を確認してください。</p></div>`;
}
function secCo(doc) {
  const i = doc.info || {}, code = doc.code, jp = st.jpx?.find(r => r[0] === code);
  const sum = i.longBusinessSummary || '';
  const tr = sum ? `https://translate.google.com/?sl=en&tl=ja&op=translate&text=${encodeURIComponent(sum.slice(0, 1800))}` : '';
  const row = (k, v) => v ? `<tr><td>${k}</td><td style="text-align:left;white-space:normal">${v}</td></tr>` : '';
  return `<div class="card"><h2>企業情報</h2><table class="t">
    ${row('銘柄名', esc(doc.name))}${row('英語名', esc(i.longName))}${row('市場', esc(jp?.[2]))}${row('業種', esc(jp?.[3] || SECTOR_JA[i.sector] || i.sector))}
    ${row('業界', esc(i.industry))}${row('従業員数', i.fullTimeEmployees ? nf(i.fullTimeEmployees) + '人' : '')}${row('時価総額', big(i.marketCap))}
    ${row('発行済株式数', i.sharesOutstanding ? nf(i.sharesOutstanding / 1e4, 0) + '万株' : '')}${row('ウェブサイト', i.website ? `<a href="${esc(i.website)}" target="_blank" rel="noopener">${esc(i.website.replace(/^https?:\/\//, ''))}</a>` : '')}
    </table>
    ${sum ? `<h2 style="margin-top:14px">事業内容 <small>英語（データ元の記載）</small></h2><p class="sum">${esc(sum)}</p><div class="links" style="margin-top:8px"><a href="${tr}" target="_blank" rel="noopener">日本語に翻訳して読む</a></div>` : ''}
    <h2 style="margin-top:14px">ほかのサイトで調べる</h2>
    <div class="links">
      <a href="https://finance.yahoo.co.jp/quote/${code}.T" target="_blank" rel="noopener">Yahoo!ファイナンス</a>
      <a href="https://kabutan.jp/stock/?code=${code}" target="_blank" rel="noopener">株探</a>
      <a href="https://irbank.net/${code}" target="_blank" rel="noopener">IR BANK</a>
      <a href="https://www.buffett-code.com/company/${code}/" target="_blank" rel="noopener">バフェット・コード</a>
      <a href="https://minkabu.jp/stock/${code}" target="_blank" rel="noopener">みんかぶ</a>
    </div></div>`;
}
function mineResults(doc) {
  const code = doc.code, h = S.hold[code] || {}, c = lastClose(doc), dr = divRate(doc);
  const val = h.shares ? h.shares * c : null, pl = h.shares && h.cost ? (c - h.cost) * h.shares : null;
  return `<div class="kv"><div class="k">評価額</div><div class="v num">${val ? nf(val) + '円' : '—'}</div></div>
      <div class="kv"><div class="k">評価損益</div><div class="v num ${cls(pl)}">${pl == null ? '—' : (pl > 0 ? '+' : '') + nf(pl) + '円'}</div><div class="s">${pl == null ? '' : pct((c / h.cost - 1) * 100)}</div></div>
      <div class="kv"><div class="k">年間配当の見込み</div><div class="v num">${h.shares && dr ? nf(h.shares * dr) + '円' : '—'}</div><div class="s">税引前</div></div>
      <div class="kv"><div class="k">取得単価での配当利回り</div><div class="v num">${h.cost && dr ? nf(dr / h.cost * 100, 2) + '%' : '—'}</div></div>`;
}
function secMine(doc) {
  const code = doc.code, h = S.hold[code] || {};
  return `<div class="card"><h2>保有の登録 <small>入力すると自動保存</small></h2>
    <div class="grid">
      <div><label class="f" for="hs">株数</label><input class="inp num" id="hs" type="number" inputmode="numeric" placeholder="例：100" value="${h.shares ?? ''}" style="width:100%"></div>
      <div><label class="f" for="hc">平均取得単価（円）</label><input class="inp num" id="hc" type="number" inputmode="decimal" placeholder="例：2500" value="${h.cost ?? ''}" style="width:100%"></div>
    </div>
    <div class="grid" id="hRes" style="margin-top:10px">${mineResults(doc)}</div>
    <button class="btn ghost" id="hDel" style="margin-top:10px;width:100%">保有を削除</button>
  </div>
  <div class="card"><h2>メモ <small>自動保存</small></h2><textarea class="inp" id="memo" placeholder="買った理由、目標株価、気になるニュースなど">${esc(S.memo[code] || '')}</textarea></div>`;
}
function bindSec(doc) {
  const code = doc.code;
  document.querySelectorAll('#dSec .kv.tap').forEach(e => e.onclick = () => toast(HELP[e.dataset.help]));
  const fc = $('#finChips');
  if (fc) fc.querySelectorAll('.chip').forEach(b => b.onclick = () => { fc.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b)); drawFin(doc, b.dataset.k); });
  const yv = $('#yv');
  if (yv) {
    yv.onchange = () => { if (yv.value === '') delete S.yval[code]; else S.yval[code] = Math.max(0, +yv.value); store.save(); renderSec(); };
    $('#yvClr').onclick = () => { delete S.yval[code]; store.save(); renderSec(); };
  }
  const hs = $('#hs'), hc = $('#hc');
  if (hs) {
    const save = () => {
      const s = +hs.value || 0, c = +hc.value || 0;
      if (s > 0) S.hold[code] = { shares: s, cost: c || null }; else delete S.hold[code];
      store.save(); $('#hRes').innerHTML = mineResults(doc);
    };
    hs.oninput = save; hc.oninput = save;
    $('#hDel').onclick = () => { delete S.hold[code]; store.save(); hs.value = ''; hc.value = ''; $('#hRes').innerHTML = mineResults(doc); toast('保有を削除しました'); };
  }
  const memo = $('#memo');
  if (memo) memo.oninput = () => { S.memo[code] = memo.value; if (!memo.value) delete S.memo[code]; clearTimeout(memo.t); memo.t = setTimeout(() => store.save(), 400); };
}

// ---------- 比較 ----------
const PALETTE = ['#f5b942', '#5cc8ff', '#c084fc', '#4ade80', '#fb7185', '#fdba74', '#a3e635', '#67e8f9', '#f0abfc', '#fde047'];
function renderCmp() {
  if (!st.index) { $('#v-cmp').querySelector('.card').innerHTML = noData(); return; }
  const its = items();
  if (!st.cmpSel) st.cmpSel = its.slice(0, 4).map(i => i.code);
  seg($('#cmpPer'), [['3M', '3ヶ月'], ['6M', '6ヶ月'], ['1Y', '1年'], ['3Y', '3年'], ['5Y', '5年']], st.cmpPer, v => { st.cmpPer = v; drawCmp(); renderCmpTable(); });
  const colorOf = code => PALETTE[st.cmpSel.indexOf(code) % PALETTE.length];
  $('#cmpChips').innerHTML = its.map(i => {
    const on = st.cmpSel.includes(i.code);
    return `<button class="chip ${on ? 'on' : ''}" data-c="${esc(i.code)}">${on ? `<i style="background:${colorOf(i.code)}"></i>` : ''}${esc(shortName(i.name))}</button>`;
  }).join('') + '<span class="chip" style="cursor:default;border-style:dashed">┄ 日経平均</span>';
  $('#cmpChips').querySelectorAll('[data-c]').forEach(b => b.onclick = () => {
    const c = b.dataset.c;
    st.cmpSel = st.cmpSel.includes(c) ? st.cmpSel.filter(x => x !== c) : st.cmpSel.length >= 10 ? (toast('比較は10銘柄まで'), st.cmpSel) : [...st.cmpSel, c];
    renderCmp();
  });
  drawCmp();
  renderCmpTable();
}
const shortName = n => n.replace(/ホールディングス|フィナンシャル・グループ|グループ$/g, '').replace(/^日本/, '') || n;
function periodRet(it, months) {
  const w = it.weekly || []; if (w.length < 2) return null;
  const from = startDate(w[w.length - 1][0], months), base = w.find(x => x[0] >= from);
  return base ? (w[w.length - 1][1] / base[1] - 1) * 100 : null;
}
function drawCmp() {
  const cv = $('#cmpCv'), months = PERIODS[st.cmpPer][0];
  const { g, w, h } = setup(cv, 220), PL = 4, PR = 44, PT = 8, PB = 20;
  const series = st.cmpSel.map(c => item(c)).filter(Boolean).map(it => ({ it, col: PALETTE[st.cmpSel.indexOf(it.code) % PALETTE.length] }));
  const b = bench(); if (b) series.push({ it: b, col: '#e8ecf4', dash: true });
  if (!series.length) return;
  const lastD = series[0].it.weekly?.slice(-1)[0]?.[0]; if (!lastD) return;
  const from = startDate(lastD, months), t0 = +new Date(from), t1 = +new Date(lastD);
  let lo = 100, hi = 100;
  const lines = series.map(s => {
    const pts = (s.it.weekly || []).filter(x => x[0] >= from); if (!pts.length) return null;
    const base = pts[0][1]; const v = pts.map(x => [+new Date(x[0]), x[1] / base * 100]);
    v.forEach(p => { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); });
    return { ...s, v };
  }).filter(Boolean);
  const pad = (hi - lo) * .08 || 5; lo -= pad; hi += pad;
  const X = t => PL + (t - t0) / (t1 - t0 || 1) * (w - PL - PR), Y = v => PT + (hi - v) / (hi - lo) * (h - PT - PB);
  g.font = '10.5px -apple-system,sans-serif'; g.textBaseline = 'middle'; g.fillStyle = '#8c97ad';
  const tk = niceStep((hi - lo) / 4);
  for (let v = Math.ceil(lo / tk) * tk; v <= hi; v += tk) {
    g.strokeStyle = Math.abs(v - 100) < 1e-6 ? 'rgba(255,255,255,.3)' : 'rgba(255,255,255,.07)';
    g.beginPath(); g.moveTo(PL, Y(v) + .5); g.lineTo(w - PR, Y(v) + .5); g.stroke(); g.fillText(nf(v, 0), w - PR + 5, Y(v));
  }
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  for (let k = 0; k < 4; k++) { const t = t0 + (t1 - t0) * (k + .5) / 4, d = new Date(t); g.fillText(`${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}`, X(t), h - 5); }
  g.textAlign = 'left';
  lines.forEach(l => {
    g.setLineDash(l.dash ? [4, 3] : []); g.beginPath();
    l.v.forEach((p, i) => i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1])));
    g.strokeStyle = l.col; g.lineWidth = l.dash ? 1.3 : 1.8; g.lineJoin = 'round'; g.stroke();
  });
  g.setLineDash([]);
}
const CMP_COLS = [
  ['name', '銘柄', i => i.name, null],
  ['close', '株価', i => i.close, i => px(i.close)],
  ['ret', '期間騰落', i => periodRet(i, PERIODS[st.cmpPer][0]), (i, v) => `<span class="${cls(v)}">${pct(v, 1)}</span>`],
  ['per', 'PER', i => i.per, i => i.per ? nf(i.per, 1) : '—'],
  ['pbr', 'PBR', i => i.pbr, i => i.pbr ? nf(i.pbr, 2) : '—'],
  ['roe', 'ROE', i => i.roe, i => i.roe == null ? '—' : nf(i.roe * 100, 1) + '%'],
  ['div', '配当利回り', i => i.divYield, i => i.divYield == null ? '—' : nf(i.divYield, 2) + '%'],
  ['yy', '優待利回り', i => yYield(i.code), (i, v) => v == null ? (yInfo(i.code) && !yInfo(i.code).none ? '<span class="dim">要入力</span>' : '—') : nf(v, 2) + '%'],
  ['total', '総合利回り', i => totalYield(i.code), (i, v) => v == null ? '—' : `<b>${nf(v, 2)}%</b>`],
  ['mcap', '時価総額', i => i.marketCap, i => big(i.marketCap)],
];
function renderCmpTable() {
  const col = CMP_COLS.find(c => c[0] === st.cmpSort) || CMP_COLS[2];
  const list = [...items()].sort((a, b) => {
    const x = col[2](a), y = col[2](b);
    if (typeof x === 'string') return st.cmpDir * -x.localeCompare(y, 'ja');
    return st.cmpDir * ((x ?? -Infinity) - (y ?? -Infinity)) || 0;
  });
  if (st.cmpDir < 0) list.sort((a, b) => (col[2](a) == null) - (col[2](b) == null));
  $('#cmpTbl').innerHTML = `<tr>${CMP_COLS.map(c => `<th data-k="${c[0]}" class="${c[0] === col[0] ? 'on' : ''}">${c[1]}${c[0] === col[0] ? (st.cmpDir < 0 ? '↓' : '↑') : ''}</th>`).join('')}</tr>` +
    list.map(i => `<tr data-code="${esc(i.code)}">${CMP_COLS.map(c => c[0] === 'name' ? `<td>${esc(shortName(i.name))}</td>` : `<td class="num">${c[3](i, c[2](i))}</td>`).join('')}</tr>`).join('');
  $('#cmpTbl').querySelectorAll('th').forEach(th => th.onclick = () => {
    const k = th.dataset.k; if (st.cmpSort === k) st.cmpDir *= -1; else { st.cmpSort = k; st.cmpDir = ['per', 'pbr', 'name'].includes(k) ? 1 : -1; }
    renderCmpTable();
  });
  $('#cmpTbl').querySelectorAll('tr[data-code]').forEach(tr => tr.onclick = () => openDetail(tr.dataset.code));
}

// ---------- 優待カレンダー ----------
function renderYutai() {
  seg($('#ymSeg'), [['0', 'すべて'], ...Array.from({ length: 12 }, (_, i) => [String(i + 1), (i + 1) + '月'])], String(st.ym), v => { st.ym = +v; renderYutai(); });
  requestAnimationFrame(() => { const b = $('#ymSeg .on'); if (b) b.scrollIntoView({ inline: 'center', block: 'nearest' }); });
  const codes = Object.keys(st.yutai).filter(k => !k.startsWith('_') && !st.yutai[k].none && (st.ym === 0 || st.yutai[k].months.includes(st.ym)));
  const rows = codes.map(code => {
    const y = st.yutai[code], it = item(code), nb = st.ym ? lastBuyDay(nextYearFor(st.ym), st.ym) : nextBuyDay(y.months);
    return { code, y, it, nb };
  }).sort((a, b) => (a.nb || 0) - (b.nb || 0));
  $('#ylist').innerHTML = rows.length ? rows.map(({ code, y, it, nb }) => {
    const yy = yYield(code), dy = it?.divYield, inv = it && y.minShares ? it.close * y.minShares : null, held = S.hold[code]?.shares || 0;
    return `<div class="yitem" data-code="${esc(code)}"><div class="h"><b>${esc(it?.name || code)}</b><span class="num dim" style="font-size:12px;flex:none">${esc(code)}</span></div>
      <div class="c">🎁 ${esc(y.title)}</div>
      <div class="m"><span>${y.months.map(m => m + '月').join('・')}</span><span>権利付最終日 <b style="color:var(--text)">${jd(nb)}</b></span>
        <span>${y.minShares ? nf(y.minShares) + '株〜' : ''}${inv ? '（約' + big(inv) + '）' : ''}</span>
        <span>配当 ${dy == null ? '—' : nf(dy, 2) + '%'}</span><span>優待 ${yy == null ? '—' : nf(yy, 2) + '%'}</span>
        ${held ? `<span class="badge ${held >= y.minShares ? 'ok' : ''}">${held >= y.minShares ? '対象' : '保有株数不足'}</span>` : ''}</div></div>`;
  }).join('') : `<div class="card msg">${st.ym}月に権利が確定する登録済みの優待銘柄はありません</div>`;
  $('#ylist').querySelectorAll('.yitem').forEach(e => e.onclick = () => { if (item(e.dataset.code)) { st.sec = 'yutai'; openDetail(e.dataset.code); } else toast('この銘柄のデータがまだありません'); });
}
function nextYearFor(month) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const y = now.getFullYear(); return lastBuyDay(y, month) >= now ? y : y + 1;
}

// ---------- 保有 ----------
function renderHold() {
  seg($('#colorSeg'), [['jp', '日本式（上昇=赤）'], ['us', '米国式（上昇=緑）']], S.set.color || 'jp', v => { S.set.color = v; store.save(); applyColor(); });
  const codes = Object.keys(S.hold).filter(c => S.hold[c]?.shares);
  let val = 0, cost = 0, div = 0, prevVal = 0, yut = 0, costKnown = true;
  const rows = codes.map(code => {
    const h = S.hold[code], it = item(code);
    if (!it) return `<div class="stock"><div class="l"><div class="nm">${esc(code)}</div><div class="sub">データがありません（ウォッチから外れた可能性）</div></div></div>`;
    const v = it.close * h.shares, pl = h.cost ? (it.close - h.cost) * h.shares : null;
    val += v; prevVal += it.prev * h.shares; if (h.cost) cost += h.cost * h.shares; else costKnown = false;
    div += (it.divRate || 0) * h.shares;
    const y = yInfo(code); if (y && !y.none && h.shares >= y.minShares && yValue(code)) yut += yValue(code);
    return `<div class="stock" data-code="${esc(code)}"><div class="l"><div class="nm">${esc(it.name)}</div>
      <div class="sub"><span>${nf(h.shares)}株</span><span>取得 ${h.cost ? px(h.cost) : '—'}</span><span>評価 ${nf(v)}円</span>
      ${y && !y.none ? `<span class="tag" style="${h.shares >= y.minShares ? '' : 'opacity:.5'}">優待${h.shares >= y.minShares ? '対象' : '株数不足'}</span>` : ''}</div></div>
      <div class="r"><div class="px num ${cls(pl)}" style="font-size:15px">${pl == null ? '—' : (pl > 0 ? '+' : '') + nf(pl)}</div><div class="ch num ${cls(it.changePct)}">${pct(it.changePct)}</div></div></div>`;
  });
  const pl = costKnown && cost ? val - cost : null, dayCh = val - prevVal;
  $('#holdSum').innerHTML = codes.length ? `<h2>保有のまとめ <small>${st.index ? ymd(items()[0]?.date) + ' 終値' : ''}</small></h2><div class="grid">
    <div class="kv"><div class="k">評価額</div><div class="v num">${nf(val)}円</div><div class="s ${cls(dayCh)}">前日比 ${dayCh > 0 ? '+' : ''}${nf(dayCh)}円</div></div>
    <div class="kv"><div class="k">評価損益</div><div class="v num ${cls(pl)}">${pl == null ? '—' : (pl > 0 ? '+' : '') + nf(pl) + '円'}</div><div class="s">${pl == null ? '取得単価が未入力の銘柄あり' : pct(pl / cost * 100)}</div></div>
    <div class="kv"><div class="k">年間配当の見込み</div><div class="v num">${nf(div)}円</div><div class="s">税引前・利回り ${val ? nf(div / val * 100, 2) : '—'}%</div></div>
    <div class="kv"><div class="k">年間優待の見込み</div><div class="v num">${nf(yut)}円相当</div><div class="s">金額を入力した優待のみ</div></div>
  </div>` : `<div class="msg"><b>保有株はまだ登録されていません</b>銘柄の詳細画面の「保有」タブから株数と取得単価を登録すると、評価損益や配当・優待の見込みをまとめて確認できます。</div>`;
  $('#holdList').innerHTML = rows.join('');
  $('#holdList').querySelectorAll('.stock[data-code]').forEach(e => e.onclick = () => { st.sec = 'mine'; openDetail(e.dataset.code); });
}
function applyColor() { document.body.classList.toggle('us', S.set.color === 'us'); if (st.code) drawChart(); render(); }

// ---------- 起動 ----------
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => setView(b.dataset.v));
$('#q').oninput = renderList;
$('#sort').onchange = renderList;
$('#back').onclick = () => closeDetail(false);
window.addEventListener('popstate', () => {
  const code = location.hash.slice(1);
  if (code && st.index) openDetail(decodeURIComponent(code)); else if (st.code) closeDetail(true);
});
$('#addOpen').onclick = () => { $('#addSheet').classList.add('on'); renderAdd(); };
$('#addClose').onclick = () => $('#addSheet').classList.remove('on');
$('#addSheet').onclick = e => { if (e.target.id === 'addSheet') $('#addSheet').classList.remove('on'); };
$('#aq').oninput = renderAdd;
$('#reload').onclick = async e => {
  const b = e.currentTarget; b.classList.add('spin');
  try {
    if ('serviceWorker' in navigator) { const r = await navigator.serviceWorker.getRegistration(); if (r) await Promise.race([r.update(), new Promise(x => setTimeout(x, 1500))]); }
    await loadAll();
    if (st.code) { const c = st.code; delete st.docs[c]; openDetail(c); }
    toast('最新のデータを読み込みました');
  } catch (_) { toast('読み込みに失敗しました'); }
  b.classList.remove('spin');
};
let rsT; window.addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => { render(); if (st.code && st.docs[st.code]) { paint(); renderSeason(st.docs[st.code]); renderSec(); } }, 200); });
applyColor();
loadAll().then(() => {
  const code = decodeURIComponent(location.hash.slice(1));
  if (code && (item(code) || code === 'N225')) { history.replaceState(null, '', location.pathname); openDetail(code); }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
