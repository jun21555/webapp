// ===============================================================
//  かぞくカレンダー 画面の動き
// ---------------------------------------------------------------
//  流れ：  ログイン → （家族がまだなら）はじめの設定 → カレンダー
//  データの読み書きは store.js にまとめてあります。
// ===============================================================
import { createStore, COLORS, ymdOf } from './store.js';
import { DEFAULT_HINTS, buildPrompt, parseImportText, sameEvent } from './import.js';

const $ = id => document.getElementById(id);
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

// ---- 画面の状態（ここが変わったら render し直す） ----
const state = {
  user: null,          // ログイン中のユーザー
  familyId: null,
  family: null,        // { name, inviteCode }
  members: [],         // [{ id, name, color }]
  events: [],          // 表示中の月の予定
  month: firstOfMonth(new Date()), // 表示している月の1日
  selected: ymdOf(new Date()),     // 選んでいる日 "YYYY-MM-DD"
  filter: null,        // 絞り込み中のメンバーID（null なら全員）
};
let store;
let unsub = [];          // onSnapshot の解除用
let unsubEvents = null;

// ---------------------------------------------------------------
//  ちいさな道具
// ---------------------------------------------------------------
// 要素を作る（textContent を使うので、入力された文字がそのまま安全に表示される）
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2600);
}
function avatar(m) {
  return h('span', { class: 'avatar', style: `background:${m.color}` }, (m.name || '?').slice(0, 1));
}
function memberById(id) { return state.members.find(m => m.id === id); }

function showScreen(id) {
  for (const s of ['loadingScreen', 'loginScreen', 'setupScreen', 'mainScreen', 'importScreen']) $(s).classList.toggle('hidden', s !== id);
}

// 色を選ぶボタンを並べる
function colorPicker(box, initial, onPick) {
  box.replaceChildren(...COLORS.map(c => h('button', {
    type: 'button', style: `background:${c}`, 'data-color': c, 'aria-label': '色', 'aria-pressed': String(c === initial),
    onclick: () => {
      box.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === c)));
      onPick(c);
    },
  })));
}

// エラーを日本語に
function errText(e) {
  const code = e && e.code || '';
  const map = {
    'auth/popup-closed-by-user': 'ログインがキャンセルされました',
    'auth/cancelled-popup-request': 'ログインがキャンセルされました',
    'auth/popup-blocked': 'ポップアップがブロックされました。もう一度押すか、メールでログインしてください',
    'auth/invalid-credential': 'メールアドレスかパスワードが違います',
    'auth/invalid-email': 'メールアドレスの形が正しくありません',
    'auth/email-already-in-use': 'このメールアドレスはもう登録されています。「ログイン」を押してください',
    'auth/weak-password': 'パスワードは6文字以上にしてください',
    'auth/unauthorized-domain': 'このURLが Firebase の「承認済みドメイン」に入っていません（README 参照）',
    'auth/operation-not-allowed': 'このログイン方法が Firebase で有効になっていません（README 参照）',
    'auth/network-request-failed': 'インターネットにつながっていません',
    'permission-denied': '権限がありません。セキュリティルールを確認してください',
    'unavailable': 'オフラインのため保存できませんでした。つながったら自動で送られます',
  };
  return map[code] || (e && e.message) || 'エラーが起きました';
}

// ===============================================================
//  起動
// ===============================================================
async function start() {
  // ホームボタンを各画面の左上に置く
  document.querySelectorAll('[data-home]').forEach(slot => slot.replaceWith($('homeBtn').content.cloneNode(true)));
  document.querySelectorAll('a.home').forEach(a => a.addEventListener('click', e => {
    if ((isEditorDirty() || isImportPending()) && !confirm('入力中の内容は保存されていません。ホームに戻りますか？')) e.preventDefault();
  }));

  try {
    store = await createStore();
  } catch (e) {
    console.error(e);
    $('loadingScreen').querySelector('.loading').textContent = 'Firebase を読み込めませんでした。通信状態を確認してください';
    return;
  }
  if (store.demo) {
    $('demoNote').classList.remove('hidden');
    $('demoBar').classList.remove('hidden');
    $('resetDemo').classList.remove('hidden');
    $('googleBtn').querySelector('span').textContent = 'デモで試す';
    $('googleBtn').querySelector('svg').remove();
    $('emailForm').classList.add('hidden');
    document.querySelector('#loginScreen .or').classList.add('hidden');
  }
  bindLogin();
  bindSetup();
  bindMain();
  bindEditor();
  bindSettings();
  bindImport();

  store.onUser(async user => {
    stopWatching();
    state.user = user;
    if (!user) { showScreen('loginScreen'); return; }
    showScreen('loadingScreen');
    try {
      const profile = await store.getProfile();
      if (profile && profile.familyId) enterFamily(profile.familyId);
      else openSetup(user);
    } catch (e) {
      console.error(e); toast(errText(e)); openSetup(user);
    }
  });
}

// ===============================================================
//  ログイン画面
// ===============================================================
function bindLogin() {
  const err = $('loginErr');
  $('googleBtn').addEventListener('click', async () => {
    err.textContent = '';
    try { await store.signInGoogle(); } catch (e) { err.textContent = errText(e); }
  });
  $('emailForm').addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    const mode = e.submitter && e.submitter.dataset.mode;
    const email = $('email').value.trim(), pw = $('password').value;
    try {
      if (mode === 'signup') await store.signUpEmail(email, pw);
      else await store.signInEmail(email, pw);
    } catch (e2) { err.textContent = errText(e2); }
  });
}

// ===============================================================
//  はじめの設定（家族を作る／招待コードで参加）
// ===============================================================
let setupTab = 'create';
let setupColor = COLORS[0];
function bindSetup() {
  document.querySelectorAll('#setupScreen [data-tab]').forEach(b => b.addEventListener('click', () => {
    setupTab = b.dataset.tab;
    document.querySelectorAll('#setupScreen [data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('#setupScreen [data-for]').forEach(x => x.classList.toggle('hidden', x.dataset.for !== setupTab));
    $('setupSubmit').textContent = setupTab === 'create' ? '家族を作ってはじめる' : 'この家族に参加する';
    $('setupErr').textContent = '';
  }));
  document.querySelectorAll('#setupScreen [data-for]').forEach(x => x.classList.toggle('hidden', x.dataset.for !== 'create'));
  $('setupLogout').addEventListener('click', () => { stopWatching(); store.signOut(); });

  $('setupForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('setupErr'); err.textContent = '';
    const myName = $('myName').value.trim();
    if (!myName) { err.textContent = '呼び名を入れてください'; return; }
    const btn = $('setupSubmit'); btn.disabled = true;
    try {
      let familyId;
      if (setupTab === 'create') {
        const familyName = $('familyName').value.trim() || `${myName}の家族`;
        familyId = await store.createFamily({ familyName, myName, color: setupColor });
      } else {
        const code = $('inviteCode').value.trim();
        if (code.length !== 6) throw new Error('招待コードは6文字です');
        familyId = await store.joinFamily({ code, myName, color: setupColor });
      }
      enterFamily(familyId);
    } catch (e2) {
      console.error(e2); err.textContent = errText(e2);
    } finally { btn.disabled = false; }
  });
}
function openSetup(user) {
  if (user.name && !$('myName').value) $('myName').value = user.name.split(' ')[0];
  colorPicker($('setupColors'), setupColor, c => { setupColor = c; });
  showScreen('setupScreen');
}

// ===============================================================
//  カレンダー（メイン画面）
// ===============================================================
function enterFamily(familyId) {
  state.familyId = familyId;
  state.filter = null;
  const onErr = e => { console.error(e); toast(errText(e)); };
  unsub.push(store.watchFamily(familyId, f => { state.family = f; renderSettings(); }, onErr));
  unsub.push(store.watchMembers(familyId, ms => { state.members = ms; renderAll(); renderSettings(); }, onErr));
  watchMonth();
  showScreen('mainScreen');
  renderAll();
}
function stopWatching() {
  unsub.forEach(fn => fn && fn()); unsub = [];
  if (unsubEvents) { unsubEvents(); unsubEvents = null; }
  state.familyId = null; state.family = null; state.members = []; state.events = [];
}

// 表示中の月（前後の週も含めた6週間ぶん）の予定を監視する
function gridRange() {
  const first = state.month;
  const start = new Date(first); start.setDate(1 - first.getDay());
  const end = new Date(start); end.setDate(start.getDate() + 41);
  return { start, end };
}
function watchMonth() {
  if (unsubEvents) unsubEvents();
  const { start, end } = gridRange();
  unsubEvents = store.watchEvents(state.familyId, ymdOf(start), ymdOf(end),
    evs => { state.events = evs; renderAll(); },
    e => { console.error(e); toast(errText(e)); });
}

function bindMain() {
  const move = n => {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + n, 1);
    // 選んでいる日も、その月の中に動かす（今月なら今日）
    const today = new Date();
    state.selected = ymdOf(state.month.getFullYear() === today.getFullYear() && state.month.getMonth() === today.getMonth() ? today : state.month);
    watchMonth(); renderAll();
  };
  $('prevMonth').addEventListener('click', () => move(-1));
  $('nextMonth').addEventListener('click', () => move(1));
  $('monthTitle').addEventListener('click', () => {
    state.month = firstOfMonth(new Date()); state.selected = ymdOf(new Date()); watchMonth(); renderAll();
  });
  // 左右スワイプで月を移動
  let sx = null, sy = 0;
  $('cal').addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  $('cal').addEventListener('touchend', e => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1);
    sx = null;
  });
  $('addBtn').addEventListener('click', () => openEditor(null));
  $('settingsBtn').addEventListener('click', () => openSheet('settingsSheet'));
  $('importBtn').addEventListener('click', openImport);
}

// 絞り込み中のメンバーの予定だけにする（「だれの予定」が空の予定は全員向けとして常に出す）
function visibleEvents() {
  if (!state.filter) return state.events;
  return state.events.filter(e => !e.memberIds || !e.memberIds.length || e.memberIds.includes(state.filter));
}
function sortEvents(list) {
  return [...list].sort((a, b) => (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1) || (a.start || '').localeCompare(b.start || '') || a.title.localeCompare(b.title));
}
function eventColor(e) {
  const ids = e.memberIds || [];
  if (ids.length === 1) return (memberById(ids[0]) || {}).color || '#b9aea6';
  return ids.length > 1 ? '#2b2522' : '#b9aea6'; // 複数人 → 濃い色、だれでもない → グレー
}

function renderAll() {
  if (!state.familyId) return;
  renderFilter();
  renderMonth();
  renderAgenda();
}

function renderFilter() {
  const box = $('filter');
  const chips = [h('button', { type: 'button', class: 'chip all', 'aria-pressed': String(!state.filter), onclick: () => { state.filter = null; renderAll(); } }, '全員')];
  for (const m of state.members) {
    chips.push(h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(state.filter === m.id),
      onclick: () => { state.filter = state.filter === m.id ? null : m.id; renderAll(); },
    }, avatar(m), m.name));
  }
  box.replaceChildren(...chips);
}

function renderMonth() {
  const m = state.month;
  $('monthTitle').textContent = `${m.getFullYear()}年${m.getMonth() + 1}月`;
  const { start } = gridRange();
  const today = ymdOf(new Date());
  // 日付ごとに予定をまとめる（SQL の GROUP BY date のイメージ）
  const byDate = {};
  for (const e of visibleEvents()) (byDate[e.date] = byDate[e.date] || []).push(e);

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = ymdOf(d);
    const evs = sortEvents(byDate[key] || []);
    const cls = ['day'];
    if (d.getMonth() !== m.getMonth()) cls.push('out');
    if (d.getDay() === 0) cls.push('sun');
    if (d.getDay() === 6) cls.push('sat');
    if (key === today) cls.push('today');
    if (key === state.selected) cls.push('sel');
    cells.push(h('button', {
      type: 'button', class: cls.join(' '), 'aria-label': `${d.getMonth() + 1}月${d.getDate()}日 予定${evs.length}件`,
      onclick: () => {
        state.selected = key;
        if (d.getMonth() !== m.getMonth()) { state.month = firstOfMonth(d); watchMonth(); }
        renderAll();
      },
    }, h('span', { class: 'n' }, String(d.getDate())),
       h('span', { class: 'dots' }, evs.slice(0, 4).map(e => h('i', { style: `background:${eventColor(e)}` })))));
  }
  $('days').replaceChildren(...cells);
}

function renderAgenda() {
  const d = parseYmd(state.selected);
  const isToday = state.selected === ymdOf(new Date());
  $('agendaTitle').replaceChildren(`${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`, isToday ? h('small', {}, '今日') : '');
  const list = sortEvents(visibleEvents().filter(e => e.date === state.selected));
  if (!list.length) {
    $('agendaList').replaceChildren(h('div', { class: 'empty' }, '予定はありません', h('br'), '右下の ＋ から追加できます'));
    return;
  }
  $('agendaList').replaceChildren(...list.map(e => h('button', {
    type: 'button', class: 'ev', style: `--c:${eventColor(e)}`, onclick: () => openEditor(e),
  },
    h('div', { class: 'time' }, e.allDay ? '終日' : (e.start || '—'), !e.allDay && e.end ? h('small', {}, `〜${e.end}`) : null),
    h('div', { class: 'body' },
      h('p', { class: 'title' }, e.title),
      e.note ? h('p', { class: 'memo' }, e.note) : null,
      h('div', { class: 'who' }, (e.memberIds || []).map(memberById).filter(Boolean).map(avatar)),
    ),
  )));
}

// ===============================================================
//  シート（下から出る画面）
// ===============================================================
let openSheetId = null;
function openSheet(id) {
  openSheetId = id;
  $('sheetBg').classList.add('on');
  $(id).classList.add('on');
}
function closeSheet() {
  if (openSheetId) $(openSheetId).classList.remove('on');
  $('sheetBg').classList.remove('on');
  openSheetId = null;
}

// ===============================================================
//  予定の追加・編集
// ===============================================================
let editing = null;        // 編集中の予定（新規なら null）
let editMembers = [];      // 「だれの予定？」で選ばれているメンバーID
let editorSnapshot = '';   // 開いたときの内容（変更があったか調べる用）

function editorValue() {
  return JSON.stringify([$('evTitle').value, $('evDate').value, $('evAllDay').checked, $('evStart').value, $('evEnd').value, editMembers, $('evNote').value]);
}
function isEditorDirty() { return openSheetId === 'eventSheet' && editorValue() !== editorSnapshot; }

function bindEditor() {
  $('sheetBg').addEventListener('click', tryCloseSheet);
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', tryCloseSheet));
  $('evAllDay').addEventListener('change', () => $('evTimes').classList.toggle('hidden', $('evAllDay').checked));
  $('evStart').addEventListener('change', () => {
    // 終了が空 or 開始より前なら、開始の1時間後を入れておく
    const s = $('evStart').value;
    if (s && (!$('evEnd').value || $('evEnd').value <= s)) {
      const [hh, mm] = s.split(':').map(Number);
      $('evEnd').value = `${String(Math.min(hh + 1, 23)).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
  });

  $('eventForm').addEventListener('submit', async e => {
    e.preventDefault();
    const title = $('evTitle').value.trim();
    if (!title) { toast('タイトルを入れてください'); return; }
    const allDay = $('evAllDay').checked;
    const ev = {
      title,
      date: $('evDate').value,
      allDay,
      start: allDay ? '' : $('evStart').value,
      end: allDay ? '' : $('evEnd').value,
      memberIds: editMembers,
      note: $('evNote').value.trim(),
    };
    if (editorHooks) { closeSheet(); editorHooks.onSave(ev); return; } // 取り込みの確認画面から開いたとき
    if (editing) ev.id = editing.id;
    closeSheet();
    state.selected = ev.date;
    const d = parseYmd(ev.date);
    if (d.getMonth() !== state.month.getMonth() || d.getFullYear() !== state.month.getFullYear()) { state.month = firstOfMonth(d); watchMonth(); }
    renderAll();
    try {
      await store.saveEvent(state.familyId, ev);
      toast('保存しました');
    } catch (e2) { console.error(e2); toast(errText(e2)); }
  });

  $('evDelete').addEventListener('click', async () => {
    if (editorHooks) { closeSheet(); editorHooks.onDelete(); return; }
    if (!editing || !confirm(`「${editing.title}」を削除しますか？`)) return;
    const id = editing.id;
    closeSheet();
    try { await store.deleteEvent(state.familyId, id); toast('削除しました'); }
    catch (e) { console.error(e); toast(errText(e)); }
  });
}
function tryCloseSheet() {
  if (isEditorDirty() && !confirm('入力中の内容を破棄しますか？')) return;
  closeSheet();
}

// hooks を渡すと、保存・削除をデータベースではなく hooks に任せる（取り込みの確認画面用）
let editorHooks = null;
function openEditor(ev, hooks = null) {
  editing = ev;
  editorHooks = hooks;
  $('eventSheetTitle').textContent = hooks ? '取り込む予定を直す' : ev ? '予定を編集' : '予定を追加';
  $('evDelete').textContent = hooks ? 'この予定は取り込まない' : 'この予定を削除';
  $('evTitle').value = ev ? ev.title : '';
  $('evDate').value = ev ? ev.date : state.selected;
  $('evAllDay').checked = ev ? !!ev.allDay : false;
  $('evStart').value = ev ? (ev.start || '') : '';
  $('evEnd').value = ev ? (ev.end || '') : '';
  $('evNote').value = ev ? (ev.note || '') : '';
  $('evTimes').classList.toggle('hidden', $('evAllDay').checked);
  $('evDelete').classList.toggle('hidden', !ev);
  // 新しい予定は「自分」（絞り込み中ならその人）を最初から選んでおく
  editMembers = ev ? [...(ev.memberIds || [])] : [state.filter || state.user.uid];
  renderMemberPick();
  editorSnapshot = editorValue();
  openSheet('eventSheet');
}

function renderMemberPick() {
  const all = state.members.length > 0 && state.members.every(m => editMembers.includes(m.id));
  const chips = [h('button', {
    type: 'button', class: 'chip all', 'aria-pressed': String(all),
    onclick: () => { editMembers = all ? [] : state.members.map(m => m.id); renderMemberPick(); },
  }, '全員')];
  for (const m of state.members) {
    const on = editMembers.includes(m.id);
    chips.push(h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(on),
      onclick: () => { editMembers = on ? editMembers.filter(x => x !== m.id) : [...editMembers, m.id]; renderMemberPick(); },
    }, avatar(m), m.name));
  }
  $('evMembers').replaceChildren(...chips);
}

// ===============================================================
//  設定
// ===============================================================
let myColor = COLORS[0];
function bindSettings() {
  $('shareCode').addEventListener('click', async () => {
    const code = state.family && state.family.inviteCode;
    if (!code) return;
    const url = location.href.split('#')[0].split('?')[0];
    const text = `かぞくカレンダーに参加してね！\n招待コード：${code}\n${url}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); toast('コピーしました'); }
    } catch (_) {}
  });
  $('saveMe').addEventListener('click', async () => {
    const name = $('setMyName').value.trim();
    if (!name) { toast('呼び名を入れてください'); return; }
    try { await store.updateMe(state.familyId, { name, color: myColor }); toast('保存しました'); }
    catch (e) { console.error(e); toast(errText(e)); }
  });
  $('logout').addEventListener('click', () => { closeSheet(); stopWatching(); store.signOut(); });
  $('resetDemo').addEventListener('click', () => {
    if (!confirm('デモのデータをすべて消して、最初からやり直しますか？')) return;
    closeSheet(); store.resetDemo();
  });
}
function renderSettings() {
  if (!state.familyId) return;
  $('setFamilyName').textContent = state.family ? state.family.name : '';
  $('setCode').textContent = state.family ? state.family.inviteCode : '';
  $('setMembers').replaceChildren(...state.members.map(m =>
    h('li', {}, avatar(m), m.name, m.id === state.user.uid ? h('small', {}, 'あなた') : null)));
  const me = memberById(state.user.uid);
  if (me && openSheetId !== 'settingsSheet') {
    $('setMyName').value = me.name;
    myColor = me.color;
    colorPicker($('setColors'), myColor, c => { myColor = c; });
  }
}

// ===============================================================
//  写真から取り込み（Claude で読み取ったテキストを貼り付けて登録）
// ===============================================================
let importItems = [];   // 確認中の予定 [{ ...予定, on:登録するか, dup:登録済みと同じか, check:要確認か }]

function isImportPending() {
  return !$('importScreen').classList.contains('hidden') && importItems.some(it => it.on);
}

function openImport() {
  $('hintsText').value = (state.family && state.family.importHints) || DEFAULT_HINTS;
  showScreen('importScreen');
  window.scrollTo(0, 0);
}
function closeImport() {
  if (isImportPending() && !confirm('まだ登録していない予定があります。閉じますか？')) return;
  resetImport();
  showScreen('mainScreen');
}
function resetImport() {
  importItems = [];
  $('importText').value = '';
  $('importErr').textContent = '';
  $('importErr').classList.add('hidden');
  renderImport();
}

function bindImport() {
  $('importClose').addEventListener('click', closeImport);

  $('copyPrompt').addEventListener('click', async () => {
    const text = buildPrompt({ members: state.members, hints: $('hintsText').value, year: state.month.getFullYear() });
    try {
      await navigator.clipboard.writeText(text);
      toast('指示文をコピーしました。Claude に貼り付けてください');
    } catch (_) {
      // コピーできない環境では、貼り付け欄に出して手でコピーしてもらう
      $('importText').value = text;
      toast('自動でコピーできませんでした。下の欄から手でコピーしてください');
    }
  });

  $('hintsSave').addEventListener('click', async () => {
    try { await store.updateFamily(state.familyId, { importHints: $('hintsText').value.trim() }); toast('ヒントを保存しました'); }
    catch (e) { console.error(e); toast(errText(e)); }
  });
  $('hintsReset').addEventListener('click', () => { $('hintsText').value = DEFAULT_HINTS; });

  $('parseBtn').addEventListener('click', async () => {
    const { items, errors } = parseImportText($('importText').value, { members: state.members, year: state.month.getFullYear() });
    $('importErr').classList.toggle('hidden', !errors.length);
    $('importErr').textContent = errors.length ? `読み取れなかった行（${errors.length}件）\n${errors.join('\n')}` : '';
    if (!items.length) {
      importItems = [];
      renderImport();
      toast('予定が見つかりませんでした。Claude の返事をそのまま貼り付けてください');
      return;
    }
    // すでに登録してある予定と同じものは、最初からチェックを外しておく
    const dates = items.map(it => it.date).sort();
    let existing = [];
    try { existing = await store.getEvents(state.familyId, dates[0], dates[dates.length - 1]); }
    catch (e) { console.error(e); }
    importItems = items.map(it => {
      const dup = existing.some(ex => sameEvent(ex, it));
      return { ...it, dup, on: !dup };
    });
    renderImport();
    $('importResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('toggleAll').addEventListener('click', () => {
    const anyOn = importItems.some(it => it.on);
    importItems.forEach(it => { it.on = !anyOn; });
    renderImport();
  });

  $('importSave').addEventListener('click', async () => {
    const list = importItems.filter(it => it.on)
      .map(({ date, allDay, start, end, title, memberIds, note }) => ({ date, allDay, start, end, title, memberIds, note }));
    if (!list.length || !confirm(`${list.length}件の予定を登録します。よろしいですか？`)) return;
    $('importSave').disabled = true;
    try {
      await store.saveEvents(state.familyId, list);
      toast(`${list.length}件を登録しました`);
      resetImport();
      // 登録した最初の予定の月を表示する
      state.month = firstOfMonth(parseYmd(list[0].date));
      state.selected = list[0].date;
      watchMonth(); renderAll();
      showScreen('mainScreen');
    } catch (e) { console.error(e); toast(errText(e)); }
    finally { renderImport(); }
  });
}

function renderImport() {
  const on = importItems.filter(it => it.on).length;
  const has = importItems.length > 0;
  $('importResult').classList.toggle('hidden', !has && $('importErr').classList.contains('hidden'));
  $('importBar').classList.toggle('hidden', !has);
  $('importCount').textContent = has ? `${importItems.length}件中 ${on}件を登録` : '';
  $('toggleAll').classList.toggle('hidden', !has);
  $('toggleAll').textContent = on ? 'すべて外す' : 'すべて選ぶ';
  $('importSave').textContent = `${on}件を登録する`;
  $('importSave').disabled = !on;

  $('importList').replaceChildren(...importItems.map((it, i) => {
    const d = parseYmd(it.date);
    const time = it.allDay ? '終日' : it.start + (it.end ? `〜${it.end}` : '');
    return h('div', { class: 'imp-item' + (it.on ? '' : ' off') },
      h('button', {
        type: 'button', class: 'tick', 'aria-label': it.on ? '登録しない' : '登録する',
        onclick: () => { it.on = !it.on; renderImport(); },
      }, h('i', {}, it.on ? '✓' : '')),
      h('button', { type: 'button', class: 'main', onclick: () => editImportItem(i) },
        h('div', { class: 'when' }, `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}） ${time}`,
          it.dup ? h('span', { class: 'badge dup' }, '登録済み') : null,
          it.check ? h('span', { class: 'badge chk' }, '要確認') : null),
        h('div', { class: 'title' }, it.title),
        it.note ? h('div', { class: 'memo' }, it.note) : null,
        h('div', { class: 'who' }, it.memberIds.map(memberById).filter(Boolean).map(avatar)),
      ));
  }));
}

// 確認画面の予定をタップ → いつもの編集シートで直す（保存先はデータベースではなく確認リスト）
function editImportItem(i) {
  openEditor(importItems[i], {
    onSave: ev => { importItems[i] = { ...importItems[i], ...ev, on: true, check: false }; renderImport(); },
    onDelete: () => { importItems[i].on = false; renderImport(); },
  });
}

start();
