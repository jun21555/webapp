// ===============================================================
//  オンラインオセロ
// ---------------------------------------------------------------
//  モード
//   - online : Firebase（Firestore）で別の端末の人と対戦
//   - cpu    : この端末で CPU と対戦
//   - local  : この端末をふたりで交互に使って対戦
//
//  Firestore のデータ（othello/{部屋コード}）
//    board     "........" … 64文字。'.'=空き 'b'=黒 'w'=白（左上から右へ）
//    turn      'b' | 'w'  … 次に打つ色
//    status    'waiting' | 'playing' | 'finished'
//    blackUid, blackName, whiteUid, whiteName
//    lastMove  最後に打たれたマス（-1 = なし）
//    pass      直前にパスした色（'' = なし）
//    resigned  投了した色（'' = なし）
//    rematchB, rematchW  「もう一度」を押したか
//    moves, createdAt, updatedAt
// ===============================================================

import { firebaseConfig } from './firebase-config.js';

const $ = id => document.getElementById(id);
const INIT = (() => { const a = Array(64).fill('.'); a[27] = 'w'; a[28] = 'b'; a[35] = 'b'; a[36] = 'w'; return a.join(''); })();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const opp = c => (c === 'b' ? 'w' : 'b');
const colorName = c => (c === 'b' ? '黒' : '白');

// ---------------------------------------------------------------
//  ルール（盤面の計算）
// ---------------------------------------------------------------
const D8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

function flipsFor(board, idx, c) {
  if (board[idx] !== '.') return [];
  const o = opp(c), r0 = idx >> 3, c0 = idx & 7, res = [];
  for (const [dr, dc] of D8) {
    let r = r0 + dr, k = c0 + dc;
    const line = [];
    while (r >= 0 && r < 8 && k >= 0 && k < 8 && board[r * 8 + k] === o) { line.push(r * 8 + k); r += dr; k += dc; }
    if (line.length && r >= 0 && r < 8 && k >= 0 && k < 8 && board[r * 8 + k] === c) res.push(...line);
  }
  return res;
}
function legalMoves(board, c) {
  const list = [];
  for (let i = 0; i < 64; i++) if (board[i] === '.' && flipsFor(board, i, c).length) list.push(i);
  return list;
}
function applyMove(board, idx, c) {
  const f = flipsFor(board, idx, c);
  if (!f.length) return null;
  const a = board.split('');
  a[idx] = c;
  for (const i of f) a[i] = c;
  return a.join('');
}
// 打った後に「次は誰の番か」「パスか」「終局か」を決める
function afterMove(board, mover) {
  const o = opp(mover);
  if (legalMoves(board, o).length) return { turn: o, pass: '', status: 'playing' };
  if (legalMoves(board, mover).length) return { turn: mover, pass: o, status: 'playing' };
  return { turn: o, pass: '', status: 'finished' };
}
function count(board) {
  let b = 0, w = 0;
  for (const ch of board) { if (ch === 'b') b++; else if (ch === 'w') w++; }
  return { b, w };
}

// ---------------------------------------------------------------
//  CPU（位置の重み＋相手の打てる数を見て2手先まで読む）
// ---------------------------------------------------------------
const W = [
  120, -20, 20, 5, 5, 20, -20, 120,
  -20, -40, -5, -5, -5, -5, -40, -20,
  20, -5, 15, 3, 3, 15, -5, 20,
  5, -5, 3, 3, 3, 3, -5, 5,
  5, -5, 3, 3, 3, 3, -5, 5,
  20, -5, 15, 3, 3, 15, -5, 20,
  -20, -40, -5, -5, -5, -5, -40, -20,
  120, -20, 20, 5, 5, 20, -20, 120,
];
function evaluate(board, me) {
  let s = 0;
  for (let i = 0; i < 64; i++) { if (board[i] === me) s += W[i]; else if (board[i] === opp(me)) s -= W[i]; }
  s += 4 * (legalMoves(board, me).length - legalMoves(board, opp(me)).length);
  return s;
}
function search(board, turn, me, depth, alpha, beta) {
  const moves = legalMoves(board, turn);
  if (depth === 0 || (!moves.length && !legalMoves(board, opp(turn)).length)) {
    if (!moves.length && !legalMoves(board, opp(turn)).length) {
      const { b, w } = count(board); const d = (me === 'b' ? b - w : w - b);
      return d * 1000;
    }
    return evaluate(board, me);
  }
  if (!moves.length) return search(board, opp(turn), me, depth - 1, alpha, beta);
  if (turn === me) {
    let best = -Infinity;
    for (const m of moves) { best = Math.max(best, search(applyMove(board, m, turn), opp(turn), me, depth - 1, alpha, beta)); alpha = Math.max(alpha, best); if (alpha >= beta) break; }
    return best;
  }
  let best = Infinity;
  for (const m of moves) { best = Math.min(best, search(applyMove(board, m, turn), opp(turn), me, depth - 1, alpha, beta)); beta = Math.min(beta, best); if (alpha >= beta) break; }
  return best;
}
function cpuChoose(board, me) {
  const moves = legalMoves(board, me);
  const empties = board.split('.').length - 1;
  const depth = empties <= 10 ? 8 : 3;
  let best = moves[0], bestScore = -Infinity;
  for (const m of moves) {
    const sc = search(applyMove(board, m, me), opp(me), me, depth - 1, -Infinity, Infinity) + Math.random() * 2;
    if (sc > bestScore) { bestScore = sc; best = m; }
  }
  return best;
}

// ---------------------------------------------------------------
//  画面
// ---------------------------------------------------------------
const views = { menu: $('menuView'), wait: $('waitView'), game: $('gameView') };
function show(name) {
  for (const [k, v] of Object.entries(views)) v.classList.toggle('hidden', k !== name);
  const inMenu = name === 'menu';
  $('backBtn').classList.toggle('hidden', inMenu);
  $('topSpacer').classList.toggle('hidden', !inMenu);
  $('title').textContent = inMenu ? 'オセロ' : (mode === 'online' ? `部屋 ${room || ''}` : mode === 'cpu' ? 'CPU対戦' : 'ふたりで対戦');
}
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function confirmBox(title, text, yes = 'OK') {
  return new Promise(res => {
    $('confirmTitle').textContent = title; $('confirmText').textContent = text; $('confirmYes').textContent = yes;
    $('confirmOverlay').classList.remove('hidden');
    const done = v => { $('confirmOverlay').classList.add('hidden'); $('confirmYes').onclick = $('confirmNo').onclick = null; res(v); };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
  });
}

// 盤のマスを作る
const boardEl = $('board');
const cells = [];
for (let i = 0; i < 64; i++) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'cell'; b.dataset.i = i;
  b.setAttribute('aria-label', `${'abcdefgh'[i & 7]}${(i >> 3) + 1}`);
  b.addEventListener('click', () => onCell(i));
  boardEl.appendChild(b); cells.push(b);
}
// 星（盤の4つの点）
for (const [x, y] of [[2, 2], [6, 2], [2, 6], [6, 6]]) {
  const s = document.createElement('div'); s.className = 'star';
  s.style.left = `${x * 12.5}%`; s.style.top = `${y * 12.5}%`;
  boardEl.appendChild(s);
}
boardEl.style.position = 'relative';

let mode = null;        // 'online' | 'cpu' | 'local'
let game = null;        // 今の状態（online なら Firestore の内容）
let myColor = null;     // online/cpu での自分の色。local は null
let prevBoard = null;
let showHints = localStorage.getItem('othello.hints') !== '0';
let resultShownFor = '';
let busy = false;

$('hintBtn').textContent = `ヒント: ${showHints ? 'ON' : 'OFF'}`;
$('hintBtn').onclick = () => {
  showHints = !showHints; localStorage.setItem('othello.hints', showHints ? '1' : '0');
  $('hintBtn').textContent = `ヒント: ${showHints ? 'ON' : 'OFF'}`; render();
};

function canIMove() {
  if (!game || game.status !== 'playing' || busy) return false;
  if (mode === 'local') return true;
  return game.turn === myColor;
}

function render() {
  if (!game) return;
  const board = game.board;
  const hints = canIMove() && showHints ? new Set(legalMoves(board, game.turn)) : new Set();
  for (let i = 0; i < 64; i++) {
    const cell = cells[i], ch = board[i], was = prevBoard ? prevBoard[i] : ch;
    cell.classList.toggle('hint', hints.has(i));
    cell.classList.toggle('last', i === game.lastMove);
    let d = cell.querySelector('.disc');
    if (ch === '.') { if (d) d.remove(); continue; }
    if (!d) { d = document.createElement('div'); cell.appendChild(d); }
    let anim = '';
    if (prevBoard && was === '.') anim = ' place';
    else if (prevBoard && was !== ch) anim = ' flip';
    d.className = `disc ${ch}${anim}`;
  }
  prevBoard = board;

  const { b, w } = count(board);
  $('scB').textContent = b; $('scW').textContent = w;
  const you = '<small>あなた</small>';
  const esc = s => String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  $('nmB').innerHTML = esc(game.blackName || '黒') + (myColor === 'b' ? you : '');
  $('nmW').innerHTML = esc(game.whiteName || '白') + (myColor === 'w' ? you : '');
  $('plB').classList.toggle('active', game.status === 'playing' && game.turn === 'b');
  $('plW').classList.toggle('active', game.status === 'playing' && game.turn === 'w');

  const st = $('status');
  st.classList.remove('mine');
  if (game.status === 'finished') {
    st.textContent = game.resigned ? `${colorName(game.resigned)}が投了しました` : '対局終了';
  } else if (mode === 'local') {
    st.textContent = `${colorName(game.turn)}の番です` + (game.pass ? `（${colorName(game.pass)}はパス）` : '');
  } else if (spectator) {
    st.textContent = `観戦中 ・ ${colorName(game.turn)}の番`;
  } else if (game.turn === myColor) {
    st.textContent = 'あなたの番です' + (game.pass ? `（相手はパス）` : '');
    st.classList.add('mine');
  } else {
    st.textContent = (mode === 'cpu' ? 'CPUが考えています…' : '相手の番です') + (game.pass ? '（あなたはパス）' : '');
  }
  $('resignBtn').classList.toggle('hidden', game.status !== 'playing' || spectator);

  if (game.status === 'finished') showResult();
  else { $('resultOverlay').classList.add('hidden'); resultShownFor = ''; }
}

function showResult() {
  const key = `${game.board}|${game.resigned}|${game.rematchB}|${game.rematchW}`;
  if (resultShownFor === key) return;
  const firstTime = !resultShownFor.startsWith(game.board);
  resultShownFor = key;
  const { b, w } = count(game.board);
  let winner = game.resigned ? opp(game.resigned) : (b > w ? 'b' : w > b ? 'w' : '');
  let title, text = `黒 ${b} － 白 ${w}`;
  if (!winner) title = '引き分け';
  else if (mode === 'local' || spectator) title = `${colorName(winner)}の勝ち！`;
  else title = winner === myColor ? 'あなたの勝ち！' : (mode === 'cpu' ? 'CPUの勝ち' : 'あなたの負け');
  if (game.resigned) text = `${colorName(game.resigned)}が投了しました\n` + text;
  $('resultTitle').textContent = title;
  $('resultText').textContent = text;
  $('resultText').style.whiteSpace = 'pre-line';
  const again = $('againBtn');
  again.disabled = false;
  again.classList.toggle('hidden', spectator);
  if (mode === 'online') {
    const mine = myColor === 'b' ? game.rematchB : game.rematchW;
    const theirs = myColor === 'b' ? game.rematchW : game.rematchB;
    again.textContent = mine ? '相手を待っています…' : theirs ? '再戦を受ける（色を交代）' : 'もう一度（色を交代）';
    again.disabled = !!mine;
  } else {
    again.textContent = 'もう一度';
  }
  setTimeout(() => { if (game && game.status === 'finished') $('resultOverlay').classList.remove('hidden'); }, firstTime ? 700 : 0);
}
$('viewBtn').onclick = () => $('resultOverlay').classList.add('hidden');
$('menuBtn').onclick = () => leaveGame();
$('againBtn').onclick = () => rematch();
$('backBtn').onclick = async () => {
  if (game && game.status === 'playing' && !spectator && mode !== 'online') {
    if (!await confirmBox('対局をやめる', 'この対局を終了してメニューに戻りますか？', 'やめる')) return;
  }
  if (mode === 'online' && views.wait.classList.contains('hidden') === false) return cancelRoom();
  leaveGame();
};
$('resignBtn').onclick = async () => {
  if (!await confirmBox('投了', '投了して負けにしますか？', '投了する')) return;
  if (mode === 'online') return onlineResign();
  game = { ...game, status: 'finished', resigned: mode === 'local' ? game.turn : myColor };
  render();
};

function onCell(i) {
  if (!canIMove()) return;
  const color = game.turn;
  const nb = applyMove(game.board, i, color);
  if (!nb) return;
  if (navigator.vibrate) navigator.vibrate(10);
  if (mode === 'online') return onlineMove(i);
  const nx = afterMove(nb, color);
  game = { ...game, board: nb, lastMove: i, ...nx };
  render();
  if (nx.pass) toast(`${colorName(nx.pass)}は打てる場所がないのでパスです`);
  if (mode === 'cpu') cpuTurn();
}

let cpuToken = 0;
function cpuTurn() {
  if (!game || game.status !== 'playing' || game.turn === myColor) return;
  busy = true; render();
  const token = ++cpuToken;
  setTimeout(() => {
    if (token !== cpuToken || mode !== 'cpu' || !game) return;
    const m = cpuChoose(game.board, game.turn);
    const nb = applyMove(game.board, m, game.turn);
    const nx = afterMove(nb, game.turn);
    game = { ...game, board: nb, lastMove: m, ...nx };
    busy = false; render();
    if (nx.pass) toast('あなたは打てる場所がないのでパスです');
    if (game.status === 'playing' && game.turn !== myColor) cpuTurn();
  }, 550);
}

function newLocalGame(m, color = 'b') {
  cpuToken++; busy = false;
  mode = m; spectator = false; resultShownFor = ''; prevBoard = null;
  const me = myName();
  if (m === 'cpu') {
    myColor = color;
    game = { board: INIT, turn: 'b', status: 'playing', lastMove: -1, pass: '', resigned: '',
      blackName: color === 'b' ? me : 'CPU', whiteName: color === 'w' ? me : 'CPU' };
  } else {
    myColor = null;
    game = { board: INIT, turn: 'b', status: 'playing', lastMove: -1, pass: '', resigned: '', blackName: '黒', whiteName: '白' };
  }
  show('game'); render();
  if (m === 'cpu' && myColor === 'w') cpuTurn();
}

function rematch() {
  $('resultOverlay').classList.add('hidden');
  if (mode === 'online') return onlineRematch();
  if (mode === 'cpu') return newLocalGame('cpu', opp(myColor));
  newLocalGame('local');
}

function leaveGame() {
  stopOnline(); cpuToken++;
  mode = null; game = null; myColor = null; prevBoard = null; spectator = false; busy = false;
  $('resultOverlay').classList.add('hidden');
  const u = new URL(location.href);
  if (u.searchParams.has('room')) { u.searchParams.delete('room'); history.replaceState(null, '', u); }
  refreshResume();
  show('menu');
}

// ---------------------------------------------------------------
//  名前
// ---------------------------------------------------------------
const nameInput = $('nameInput');
nameInput.value = localStorage.getItem('othello.name') || '';
nameInput.addEventListener('change', () => localStorage.setItem('othello.name', nameInput.value.trim()));
function myName() { return (nameInput.value.trim() || 'ゲスト').slice(0, 12); }

$('cpuBtn').onclick = () => newLocalGame('cpu', 'b');
$('localBtn').onclick = () => newLocalGame('local');

// ---------------------------------------------------------------
//  オンライン（Firebase）
// ---------------------------------------------------------------
let fb = null;          // { db, F, uid }
let unsub = null;
let room = null;
let spectator = false;
let lastSnap = null;

function showOnlineErr(msg) {
  const e = $('onlineErr');
  e.textContent = msg || ''; e.classList.toggle('hidden', !msg);
}
function fbErrorText(err) {
  const code = err && err.code || '';
  const map = {
    'auth/operation-not-allowed': 'Firebase で「匿名ログイン」が有効になっていません（README の手順を参照してください）',
    'auth/network-request-failed': '通信できませんでした。電波の状態を確認してください',
    'permission-denied': 'Firestore のルールで拒否されました（README の手順でルールを公開してください）',
    'unavailable': 'サーバーにつながりません。通信状態を確認してください',
  };
  if (/dynamically imported module|Importing a module script failed/i.test(err && err.message || '')) return 'Firebase を読み込めませんでした。通信状態を確認してください';
  return map[code] || map[code.replace(/^firestore\//, '')] || `エラー: ${err && err.message || err}`;
}

async function ensureFirebase() {
  if (fb) return fb;
  if (!firebaseConfig.apiKey) throw new Error('firebase-config.js に Firebase の設定がありません');
  if (!navigator.onLine) throw Object.assign(new Error('offline'), { code: 'auth/network-request-failed' });
  const V = '13.4.0';
  const [{ initializeApp, getApps, getApp }, A, F] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);
  // かぞく予定と同じ Firebase プロジェクトを使うので、アプリ名を分けておく
  const app = getApps().some(a => a.name === 'othello') ? getApp('othello') : initializeApp(firebaseConfig, 'othello');
  const auth = A.getAuth(app);
  await A.setPersistence(auth, A.browserLocalPersistence).catch(() => {});
  const user = await new Promise(res => { const u = A.onAuthStateChanged(auth, x => { u(); res(x); }); });
  const cred = user || (await A.signInAnonymously(auth)).user;
  const db = F.getFirestore(app);
  fb = { db, F, uid: cred.uid };
  return fb;
}

function makeCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

async function withBusyButton(btn, fn) {
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = '接続中…'; showOnlineErr('');
  try { await fn(); } catch (e) { console.error(e); showOnlineErr(fbErrorText(e)); }
  finally { btn.disabled = false; btn.textContent = label; }
}

$('createBtn').onclick = () => withBusyButton($('createBtn'), async () => {
  localStorage.setItem('othello.name', nameInput.value.trim());
  const { db, F, uid } = await ensureFirebase();
  let code;
  for (let tries = 0; tries < 5; tries++) {
    const c = makeCode();
    const ref = F.doc(db, 'othello', c);
    const ok = await F.runTransaction(db, async tx => {
      const s = await tx.get(ref);
      if (s.exists()) return false;
      tx.set(ref, {
        board: INIT, turn: 'b', status: 'waiting', lastMove: -1, pass: '', resigned: '', moves: 0,
        blackUid: uid, blackName: myName(), whiteUid: '', whiteName: '',
        rematchB: false, rematchW: false,
        createdAt: F.serverTimestamp(), updatedAt: F.serverTimestamp(),
      });
      return true;
    });
    if (ok) { code = c; break; }
  }
  if (!code) throw new Error('部屋を作れませんでした。もう一度お試しください');
  openRoom(code);
});

$('joinBtn').onclick = () => withBusyButton($('joinBtn'), () => joinRoom($('codeInput').value));
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
$('codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

async function joinRoom(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (code.length !== 5) throw new Error('5文字の部屋コードを入力してください');
  localStorage.setItem('othello.name', nameInput.value.trim());
  const { db, F, uid } = await ensureFirebase();
  const ref = F.doc(db, 'othello', code);
  await F.runTransaction(db, async tx => {
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error(`部屋 ${code} が見つかりません`);
    const d = s.data();
    if (d.blackUid === uid || d.whiteUid === uid) return; // 自分の部屋に戻る
    if (d.status === 'waiting' && !d.whiteUid) {
      tx.update(ref, { whiteUid: uid, whiteName: myName(), status: 'playing', updatedAt: F.serverTimestamp() });
    }
    // 満員なら観戦
  });
  openRoom(code);
}

function openRoom(code) {
  stopOnline();
  mode = 'online'; room = code; prevBoard = null; resultShownFor = '';
  localStorage.setItem('othello.lastRoom', code);
  const u = new URL(location.href); u.searchParams.set('room', code); history.replaceState(null, '', u);
  $('waitCode').textContent = code;
  const { db, F, uid } = fb;
  let firstSnap = true;
  unsub = F.onSnapshot(F.doc(db, 'othello', code), snap => {
    if (!snap.exists()) {
      toast('部屋が閉じられました'); localStorage.removeItem('othello.lastRoom'); leaveGame(); return;
    }
    const d = snap.data();
    const prevStatus = game && game.status;
    const prevColor = myColor;
    game = d; lastSnap = d;
    myColor = d.blackUid === uid ? 'b' : d.whiteUid === uid ? 'w' : null;
    spectator = !myColor;
    if (d.status === 'waiting') {
      if (spectator) { toast('この部屋はまだ準備中です'); }
      show('wait'); return;
    }
    if (views.game.classList.contains('hidden')) { show('game'); prevBoard = null; }
    if (prevStatus === 'waiting' && d.status === 'playing') toast(`${d.whiteName || '相手'}さんが参加しました！`);
    if (prevColor && myColor && prevColor !== myColor) { toast(`色を交代！あなたは${colorName(myColor)}です`); prevBoard = null; }
    if (firstSnap && spectator) toast('この部屋は満員なので観戦します');
    if (!firstSnap && d.pass && d.status === 'playing' && d.moves !== (render.lastMoves ?? -1)) {
      toast(d.pass === myColor ? 'あなたは打てる場所がないのでパスです' : `${colorName(d.pass)}はパスです`);
    }
    render.lastMoves = d.moves;
    firstSnap = false;
    busy = false;
    render();
  }, err => { console.error(err); toast(fbErrorText(err), 4000); leaveGame(); showOnlineErr(fbErrorText(err)); });
}

function stopOnline() { if (unsub) { unsub(); unsub = null; } room = null; }

async function onlineMove(i) {
  const { db, F } = fb;
  const ref = F.doc(db, 'othello', room);
  const color = myColor;
  // 先に画面だけ反映（すぐ反応するように）
  const optimistic = applyMove(game.board, i, color);
  busy = true;
  game = { ...game, board: optimistic, lastMove: i, turn: opp(color) };
  render();
  try {
    await F.runTransaction(db, async tx => {
      const s = await tx.get(ref);
      const d = s.data();
      if (!d || d.status !== 'playing' || d.turn !== color) throw new Error('今は打てません');
      const nb = applyMove(d.board, i, color);
      if (!nb) throw new Error('そこには打てません');
      const nx = afterMove(nb, color);
      tx.update(ref, { board: nb, lastMove: i, ...nx, moves: (d.moves || 0) + 1, updatedAt: F.serverTimestamp() });
    });
  } catch (e) {
    console.error(e); toast(e.code ? fbErrorText(e) : e.message);
    busy = false;
    if (lastSnap) { game = lastSnap; render(); }
  }
}

async function onlineResign() {
  const { db, F } = fb;
  try {
    await F.updateDoc(F.doc(db, 'othello', room), { status: 'finished', resigned: myColor, updatedAt: F.serverTimestamp() });
  } catch (e) { toast(fbErrorText(e)); }
}

async function onlineRematch() {
  const { db, F } = fb;
  const ref = F.doc(db, 'othello', room);
  try {
    await F.runTransaction(db, async tx => {
      const s = await tx.get(ref);
      const d = s.data();
      if (!d || d.status !== 'finished') return;
      const mineKey = myColor === 'b' ? 'rematchB' : 'rematchW';
      const theirKey = myColor === 'b' ? 'rematchW' : 'rematchB';
      if (d[theirKey]) {
        // ふたりとも「もう一度」→ 色を交代して新しい対局
        tx.update(ref, {
          board: INIT, turn: 'b', status: 'playing', lastMove: -1, pass: '', resigned: '', moves: 0,
          blackUid: d.whiteUid, blackName: d.whiteName, whiteUid: d.blackUid, whiteName: d.blackName,
          rematchB: false, rematchW: false, updatedAt: F.serverTimestamp(),
        });
      } else {
        tx.update(ref, { [mineKey]: true, updatedAt: F.serverTimestamp() });
      }
    });
  } catch (e) { toast(fbErrorText(e)); }
}

async function cancelRoom() {
  if (!await confirmBox('部屋を閉じる', '部屋を閉じてメニューに戻りますか？', '閉じる')) return;
  const code = room;
  stopOnline();
  try { await fb.F.deleteDoc(fb.F.doc(fb.db, 'othello', code)); } catch (e) { console.warn(e); }
  localStorage.removeItem('othello.lastRoom');
  leaveGame();
}
$('cancelBtn').onclick = cancelRoom;

function inviteUrl() {
  const u = new URL(location.href); u.search = `?room=${room}`; u.hash = ''; return u.toString();
}
$('copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText(room); toast('コードをコピーしました'); }
  catch { toast(`コード: ${room}`); }
};
$('shareBtn').onclick = async () => {
  const text = `オセロで対戦しよう！部屋コード: ${room}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'オセロ', text, url: inviteUrl() }); } catch { /* キャンセル */ }
  } else {
    try { await navigator.clipboard.writeText(`${text}\n${inviteUrl()}`); toast('招待リンクをコピーしました'); }
    catch { toast(inviteUrl(), 4000); }
  }
};

// 前回の部屋に戻る
function refreshResume() {
  const last = localStorage.getItem('othello.lastRoom');
  $('resumeBox').classList.toggle('hidden', !last);
  $('resumeCode').textContent = last || '';
}
$('resumeBtn').onclick = () => withBusyButton($('resumeBtn'), () => joinRoom(localStorage.getItem('othello.lastRoom')).catch(e => {
  localStorage.removeItem('othello.lastRoom'); refreshResume(); throw e;
}));

// ---------------------------------------------------------------
//  起動
// ---------------------------------------------------------------
refreshResume();
show('menu');
const qRoom = new URL(location.href).searchParams.get('room');
if (qRoom) {
  $('codeInput').value = qRoom.toUpperCase();
  if (nameInput.value.trim()) $('joinBtn').click();
  else { nameInput.focus(); toast('名前を入れて「参加する」を押してください', 3500); }
}

// テスト用に公開（ブラウザのコンソールから確認できるように）
window.__othello = { legalMoves, applyMove, afterMove, flipsFor, cpuChoose, INIT };
