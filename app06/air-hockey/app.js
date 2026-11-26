// ===============================================================
//  オンライン エアホッケー
// ---------------------------------------------------------------
//  モード
//   - online : Firebase Realtime Database で別の端末の人と対戦
//   - cpu    : この端末で CPU と対戦
//   - local  : 1台を向かい合って、ふたりで対戦
//
//  座標（ワールド）… 幅 W=1、高さ H=1.6。部屋を作った人（h）が下、参加した人（g）が上。
//  参加した人の画面では上下左右を反転して、自分がいつも下に来るように描く。
//
//  オンラインの同期の考え方（「自分の陣地のパックは自分が計算する」方式）
//   - パックが自分の陣地にあるあいだは、自分の端末がパックの物理を計算して相手に送る（owner）。
//   - パックがセンターラインを越えたら、計算の担当を相手に渡す（epoch を 1 つ進める）。
//   - 担当でない側は、届いた最新の状態から壁の反射だけを計算して先読み表示する。
//   → 自分が打つときは通信を待たずに即座に反応するので、遅延を感じにくい。
//   - ゴールは必ず「ゴールされた側」の陣地で起きるので、その担当者が得点を書き込む。
//
//  Realtime Database のデータ（airhockey/{部屋コード}）
//    meta    { host, hostName, guest, guestName, status: 'waiting'|'playing', createdAt }
//    round   { n, h, g, serveTo, at, winner }  … n はゴールごとに 1 増える
//    st/h, st/g  各プレイヤーが 1 秒に 25 回書き込む状態
//                { x, y, vx, vy: マレット, r: round, e: epoch, o: 担当, p: [パック], pt: パックの時刻, t: 送信時刻 }
//    rematch/h, rematch/g, online/h, online/g
// ===============================================================

import { firebaseConfig } from './firebase-config.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const other = s => (s === 'h' ? 'g' : 'h');
const r4 = v => Math.round(v * 10000) / 10000;

// ---------------------------------------------------------------
//  定数
// ---------------------------------------------------------------
const W = 1, H = 1.6, MID = H / 2;
const PR = 0.042;               // パックの半径
const MR = 0.072;               // マレットの半径
const GOAL_W = 0.36, GX0 = (W - GOAL_W) / 2, GX1 = (W + GOAL_W) / 2;
const MAX_PUCK = 5.5;           // パックの最高速度（ワールド/秒）。マレットより速くして、すり抜けを防ぐ
const MAX_MALLET = 4.5;         // マレットの最高速度
const FRICTION = 0.18;          // 空気の上なので摩擦は小さめ
const WALL_E = 0.88, HIT_E = 0.92;
const WIN = 7;
const SUB = 1 / 240;            // 物理のこまかさ（すり抜け防止）
const SEND_MS = 40;             // 25 回/秒
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LEVELS = [
  { name: 'よわい', speed: 1.5, track: 0.55, err: 0.09 },
  { name: 'ふつう', speed: 2.4, track: 0.8, err: 0.04 },
  { name: 'つよい', speed: 3.8, track: 1, err: 0.01 },
];
const COLORS = { me: '#22e4ff', op: '#ff3d8b' };

// ---------------------------------------------------------------
//  ゲームの状態
// ---------------------------------------------------------------
let mode = null;      // 'cpu' | 'local' | 'online' | null
let me = 'h';         // 自分の側
let flip = false;     // 画面を反転して描くか
let level = Number(localStorage.getItem('airhockey.level') ?? 1) || 0;
if (!(level >= 0 && level <= 2)) level = 1;

const newMallet = (x, y) => ({ x, y, px: x, py: y, vx: 0, vy: 0, tx: x, ty: y });
const G = {
  puck: { x: 0.5, y: MID, vx: 0, vy: 0 },
  off: { x: 0, y: 0 },          // 表示だけのずれ（補正をなめらかに見せる）
  m: { h: newMallet(0.5, H - 0.18), g: newMallet(0.5, 0.18) },
  score: { h: 0, g: 0 },
  phase: 'idle',                // 'serve' | 'play' | 'goal' | 'over' | 'idle'
  at: 0,                        // サーブ開始時刻
  hideUntil: 0,                 // ゴール直後、パックを隠しておく時刻
  goalBy: null, goalTime: -1e9,
  first: true,                  // 試合最初のサーブ（カウントダウンを出す）
  round: 0,
  trail: [],
  sparks: [],
};

// オンライン用
let fb = null;           // { db, D, A, auth }
let room = null;         // 部屋コード
let owner = 'h';         // いまパックを計算している側
let epoch = 0;
let ghost = null;        // 担当でないときに表示に使う、相手から届いたパックの状態 { x,y,vx,vy,pt }
let ghostChanged = false;
let handoff = null;      // 担当を渡したときのパックの状態（受け取ってもらえるまで送り続ける）
let remote = null;       // 相手のマレット { x,y,vx,vy }
let lastRecv = 0, latency = 0, srvOffset = 0, lastSend = 0;
let unsubs = [];
let oppName = '';
let rematchState = {};
let oppWasOnline = false;

const clock = () => Date.now() + (mode === 'online' ? srvOffset : 0);

// ---------------------------------------------------------------
//  物理
// ---------------------------------------------------------------
function resetMallets() {
  Object.assign(G.m.h, newMallet(0.5, H - 0.18));
  Object.assign(G.m.g, newMallet(0.5, 0.18));
}
function servePos(side) {
  return { x: 0.5, y: side === 'h' ? H * 0.69 : H * 0.31, vx: 0, vy: 0 };
}
function clampMallet(m, side) {
  m.x = clamp(m.x, MR, W - MR);
  m.y = side === 'h' ? clamp(m.y, MID + MR * 0.4, H - MR) : clamp(m.y, MR, MID - MR * 0.4);
}
// マレットを目標に向かって動かす（速さの上限つき）
function driveMallet(m, side, dt, maxSpeed) {
  m.px = m.x; m.py = m.y;
  let dx = m.tx - m.x, dy = m.ty - m.y;
  const d = Math.hypot(dx, dy), lim = maxSpeed * dt;
  if (d > lim) { dx *= lim / d; dy *= lim / d; }
  m.x += dx; m.y += dy;
  clampMallet(m, side);
  const k = dt > 0 ? 1 / dt : 0;
  // 速度は少しだけならす（指のぶれで極端な値にならないように）
  m.vx = m.vx * 0.3 + (m.x - m.px) * k * 0.7;
  m.vy = m.vy * 0.3 + (m.y - m.py) * k * 0.7;
}

const POSTS = [[GX0, 0], [GX1, 0], [GX0, H], [GX1, H]];
function walls(p, ev) {
  const inMouth = p.x > GX0 && p.x < GX1;
  if (p.y > -PR && p.y < H + PR || !inMouth) {
    if (p.x < PR) { p.x = PR; if (p.vx < 0) { ev.wall = Math.max(ev.wall, -p.vx); p.vx = -p.vx * WALL_E; } }
    if (p.x > W - PR) { p.x = W - PR; if (p.vx > 0) { ev.wall = Math.max(ev.wall, p.vx); p.vx = -p.vx * WALL_E; } }
  }
  if (!inMouth) {
    if (p.y < PR) { p.y = PR; if (p.vy < 0) { ev.wall = Math.max(ev.wall, -p.vy); p.vy = -p.vy * WALL_E; } }
    if (p.y > H - PR) { p.y = H - PR; if (p.vy > 0) { ev.wall = Math.max(ev.wall, p.vy); p.vy = -p.vy * WALL_E; } }
  } else if (p.y < 0 || p.y > H) {
    // ゴールの中：左右の壁
    if (p.x < GX0 + PR) { p.x = GX0 + PR; if (p.vx < 0) p.vx = -p.vx * 0.5; }
    if (p.x > GX1 - PR) { p.x = GX1 - PR; if (p.vx > 0) p.vx = -p.vx * 0.5; }
  }
  // ゴールの角（点として当たる）
  for (const [cx, cy] of POSTS) {
    const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy);
    if (d < PR && d > 1e-6) {
      const nx = dx / d, ny = dy / d;
      p.x = cx + nx * PR; p.y = cy + ny * PR;
      const vn = p.vx * nx + p.vy * ny;
      if (vn < 0) { p.vx -= (1 + WALL_E) * vn * nx; p.vy -= (1 + WALL_E) * vn * ny; ev.wall = Math.max(ev.wall, -vn); }
    }
  }
}
function capSpeed(p) {
  const s = Math.hypot(p.vx, p.vy);
  if (s > MAX_PUCK) { p.vx *= MAX_PUCK / s; p.vy *= MAX_PUCK / s; }
}
// パックを dt 秒すすめる。mallets: [{x,y,vx,vy,side}]
function stepPuck(p, dt, mallets, ev) {
  p.x += p.vx * dt; p.y += p.vy * dt;
  const f = Math.exp(-FRICTION * dt);
  p.vx *= f; p.vy *= f;
  if (mallets) {
    for (const m of mallets) {
      const dx = p.x - m.x, dy = p.y - m.y, d = Math.hypot(dx, dy), R = PR + MR;
      if (d < R) {
        let nx, ny;
        if (d < 1e-6) { nx = 0; ny = m.side === 'h' ? -1 : 1; } else { nx = dx / d; ny = dy / d; }
        p.x = m.x + nx * R; p.y = m.y + ny * R;
        const vn = (p.vx - m.vx) * nx + (p.vy - m.vy) * ny;
        if (vn < 0) {
          p.vx -= (1 + HIT_E) * vn * nx; p.vy -= (1 + HIT_E) * vn * ny;
          ev.hit = Math.max(ev.hit, -vn); ev.hx = p.x - nx * PR; ev.hy = p.y - ny * PR;
        }
      }
    }
  }
  walls(p, ev);
  capSpeed(p);
}
// 壁だけを考えて先読み（担当でない側の表示用）
function advance(s, dt) {
  const p = { x: s.x, y: s.y, vx: s.vx, vy: s.vy };
  dt = clamp(dt, 0, 0.6);
  const n = Math.ceil(dt / SUB);
  const ev = { hit: 0, wall: 0 };
  for (let i = 0; i < n; i++) stepPuck(p, dt / n, null, ev);
  return p;
}
// パックの位置を差し替える（表示はなめらかにつなぐ）
function setPuck(s) {
  const ox = G.puck.x + G.off.x - s.x, oy = G.puck.y + G.off.y - s.y;
  if (Math.hypot(ox, oy) < 0.35) { G.off.x = ox; G.off.y = oy; } else { G.off.x = 0; G.off.y = 0; }
  Object.assign(G.puck, { x: s.x, y: s.y, vx: s.vx, vy: s.vy });
}
function goalCheck(p) {
  if (p.y < -PR * 1.1) return 'h';      // 上のゴール（g の陣地）に入った → h の得点
  if (p.y > H + PR * 1.1) return 'g';
  return null;
}

// ---------------------------------------------------------------
//  CPU
// ---------------------------------------------------------------
function predictX(p, y) {
  if (p.vy >= -0.05) return p.x;
  const t = (p.y - y) / -p.vy;
  let x = p.x + p.vx * t;
  const lo = PR, span = W - 2 * PR;
  x -= lo;
  x = ((x % (2 * span)) + 2 * span) % (2 * span);
  if (x > span) x = 2 * span - x;
  return x + lo;
}
let aiJitter = 0, aiJitterT = 0;
function aiThink(dt) {
  const lv = LEVELS[level], p = G.puck, m = G.m.g;
  aiJitterT -= dt;
  if (aiJitterT <= 0) { aiJitterT = 0.4; aiJitter = (Math.random() * 2 - 1) * lv.err; }
  let tx = 0.5, ty = 0.15;
  if (G.phase === 'play' || (G.phase === 'serve' && clock() >= G.at - 200)) {
    if (p.y < MID + 0.02) {
      if (p.y > m.y + 0.01) {
        // パックが自分の前にある → 後ろから相手ゴールへ向けて打つ
        const ax = 0.5 + aiJitter * 3 - p.x, ay = H - p.y, d = Math.hypot(ax, ay) || 1;
        const bx = p.x - ax / d * (PR + MR) * 0.9, by = p.y - ay / d * (PR + MR) * 0.9;
        if (Math.hypot(m.x - bx, m.y - by) < 0.06 || Math.hypot(p.vx, p.vy) > 1.2) { tx = p.x + ax / d * 0.2; ty = p.y + ay / d * 0.2; }
        else { tx = bx; ty = by; }
      } else {
        // パックが自分の後ろ → 横によけて回り込む
        tx = p.x + (p.x < 0.5 ? 0.16 : -0.16);
        ty = Math.max(MR, p.y - 0.14);
      }
    } else {
      // 守り：ゴール前で、パックが来る位置に先回り
      const px = predictX(p, 0.16) + aiJitter;
      tx = 0.5 + (clamp(px, GX0 - 0.04, GX1 + 0.04) - 0.5) * lv.track;
      ty = 0.14;
    }
  }
  m.tx = tx; m.ty = ty;
  driveMallet(m, 'g', dt, lv.speed);
}

// ---------------------------------------------------------------
//  音
// ---------------------------------------------------------------
let ac = null;
function unlockAudio() {
  try {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
  } catch (_) {}
}
function beep(freq, dur, vol = 0.12, type = 'sine', slide = 0) {
  if (!ac || ac.state !== 'running') return;
  const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + 0.02);
}
let lastSnd = 0;
function sndHit(v) { const n = performance.now(); if (n - lastSnd < 50) return; lastSnd = n; beep(500 + v * 180, 0.07, clamp(0.06 + v * 0.05, 0.06, 0.2), 'triangle', 0.6); }
function sndWall(v) { if (v < 0.25) return; const n = performance.now(); if (n - lastSnd < 50) return; lastSnd = n; beep(260, 0.05, clamp(v * 0.04, 0.02, 0.08), 'square', 0.7); }
function sndGoal(good) {
  const seq = good ? [523, 659, 784, 1047] : [392, 330, 262];
  seq.forEach((f, i) => setTimeout(() => beep(f, 0.16, 0.13, 'triangle'), i * 110));
}
function sndCount(hi) { beep(hi ? 1046 : 660, 0.12, 0.1, 'sine'); }

// ---------------------------------------------------------------
//  入力
// ---------------------------------------------------------------
const cv = $('cv'), ctx = cv.getContext('2d');
let F = { ox: 0, oy: 0, s: 100, dpr: 1, w: 0, h: 0 };
const pointers = new Map();   // pointerId → side

function toWorld(sx, sy) {
  let x = (sx - F.ox) / F.s, y = (sy - F.oy) / F.s;
  if (flip) { x = W - x; y = H - y; }
  return { x, y };
}
function toScreen(x, y) {
  if (flip) { x = W - x; y = H - y; }
  return [F.ox + x * F.s, F.oy + y * F.s];
}
function pointerPos(e) {
  const r = cv.getBoundingClientRect();
  return toWorld(e.clientX - r.left, e.clientY - r.top);
}
function aimMallet(side, w) {
  const m = G.m[side];
  // 指のすこし上にマレットを出す（指でマレットが隠れないように）
  const lift = mode === 'local' ? 0 : 0.05;
  m.tx = w.x; m.ty = side === 'h' ? w.y - lift : w.y + lift;
}
cv.addEventListener('pointerdown', e => {
  e.preventDefault(); unlockAudio();
  try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  const w = pointerPos(e);
  let side = me;
  if (mode === 'local') side = w.y < MID ? 'g' : 'h';
  pointers.set(e.pointerId, side);
  aimMallet(side, w);
});
cv.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  e.preventDefault();
  aimMallet(pointers.get(e.pointerId), pointerPos(e));
});
const endPointer = e => pointers.delete(e.pointerId);
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);
document.addEventListener('touchmove', e => { if (mode) e.preventDefault(); }, { passive: false });

// ---------------------------------------------------------------
//  ゲームの進行（この端末だけのモード）
// ---------------------------------------------------------------
function startOffline(kind) {
  mode = kind; me = 'h'; flip = false;
  G.score = { h: 0, g: 0 };
  G.first = true; G.goalBy = null; G.goalTime = -1e9;
  resetMallets();
  Object.assign(G.puck, servePos('h')); G.off.x = G.off.y = 0;
  G.phase = 'serve'; G.at = clock() + 3000; G.hideUntil = 0;
  $('title').textContent = kind === 'cpu' ? `CPU と対戦（${LEVELS[level].name}）` : 'ふたりで対戦';
  $('hudLeft').textContent = kind === 'cpu' ? 'あなた vs CPU' : '下の人 vs 上の人';
  $('hudRight').textContent = '7点先取';
  showView('game');
}
function onGoalOffline(scorer) {
  G.score[scorer]++;
  G.goalBy = scorer; G.goalTime = performance.now();
  sndGoal(mode === 'local' || scorer === me);
  if (G.score[scorer] >= WIN) {
    G.phase = 'over';
    setTimeout(() => showResult(scorer), 900);
    return;
  }
  const loser = other(scorer);
  G.first = false;
  G.phase = 'serve'; G.at = clock() + 1700; G.hideUntil = clock() + 650;
  setTimeout(() => { if (G.phase === 'serve') { Object.assign(G.puck, servePos(loser)); G.off.x = G.off.y = 0; } }, 650);
}

// ---------------------------------------------------------------
//  毎フレームの更新
// ---------------------------------------------------------------
let lastT = performance.now();
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0, (t - lastT) / 1000));
  lastT = t;
  if (!mode) return;
  update(dt);
  render(t);
}
requestAnimationFrame(frame);

function update(dt) {
  const now = clock();
  // マレット
  driveMallet(G.m[me], me, dt, MAX_MALLET);
  if (mode === 'local') driveMallet(G.m.g, 'g', dt, MAX_MALLET);
  else if (mode === 'cpu') aiThink(dt);
  else if (mode === 'online') {
    const m = G.m[other(me)];
    m.px = m.x; m.py = m.y;
    if (remote) {
      const k = 1 - Math.exp(-dt * 30);
      m.x += (remote.x - m.x) * k; m.y += (remote.y - m.y) * k;
      m.vx = remote.vx; m.vy = remote.vy;
    }
  }

  // サーブ待ちのあいだパックは止まっているので、マレットがパックを通り抜けないように押し戻す
  if (G.phase === 'serve' && now >= G.hideUntil) {
    const sides = mode === 'online' ? [me] : ['h', 'g'];
    for (const side of sides) {
      const m = G.m[side], dx = m.x - G.puck.x, dy = m.y - G.puck.y, d = Math.hypot(dx, dy), R = PR + MR;
      if (d < R) {
        const nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : (side === 'h' ? 1 : -1);
        m.x = G.puck.x + nx * R; m.y = G.puck.y + ny * R;
        clampMallet(m, side);
        m.vx = 0; m.vy = 0;
      }
    }
  }
  if (G.phase === 'serve' && now >= G.at) { G.phase = 'play'; G.first = false; }

  const simulating = mode !== 'online' || owner === me;
  if (G.phase === 'play' && simulating) {
    const ms = ['h', 'g'].map(s => ({ side: s, m: G.m[s] }));
    const n = Math.max(1, Math.ceil(dt / SUB)), h = dt / n;
    const ev = { hit: 0, wall: 0, hx: 0, hy: 0 };
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      const list = ms.map(({ side, m }) => ({
        side, x: m.px + (m.x - m.px) * k, y: m.py + (m.y - m.py) * k, vx: m.vx, vy: m.vy,
      }));
      stepPuck(G.puck, h, list, ev);
      const scorer = goalCheck(G.puck);
      if (scorer) {
        if (mode === 'online') onGoalOnline(scorer); else onGoalOffline(scorer);
        break;
      }
    }
    if (ev.hit > 0.2) { sndHit(ev.hit); if (ev.hit > 1.2) burst(ev.hx, ev.hy, ev.hit); }
    else if (ev.wall) sndWall(ev.wall);
    if (mode === 'online' && G.phase === 'play') checkHandoff();
  } else if (mode === 'online' && !simulating && (G.phase === 'play' || G.phase === 'serve') && ghost) {
    const prevVy = G.puck.vy;
    const s = advance(ghost, (now - ghost.pt) / 1000);
    if (ghostChanged) { setPuck(s); ghostChanged = false; if (prevVy * s.vy < 0 && Math.abs(s.vy) > 0.3) sndHit(Math.abs(s.vy)); }
    else Object.assign(G.puck, s);
  }

  // 表示のずれを少しずつ戻す
  const dk = Math.exp(-dt * 9);
  G.off.x *= dk; G.off.y *= dk;

  // 残像
  const dx = G.puck.x + G.off.x, dy = G.puck.y + G.off.y;
  G.trail.push([dx, dy]); if (G.trail.length > 10) G.trail.shift();
  for (const s of G.sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt; }
  G.sparks = G.sparks.filter(s => s.life > 0);

  if (mode === 'online') netTick(now);
}
function burst(x, y, v) {
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2, sp = 0.3 + Math.random() * v * 0.4;
    G.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.25 + Math.random() * 0.2 });
  }
}

// ---------------------------------------------------------------
//  描画
// ---------------------------------------------------------------
function resize() {
  const r = $('stage').getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  F.dpr = dpr; F.w = r.width; F.h = r.height;
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  const pad = 6;
  const s = Math.min((r.width - pad * 2) / W, (r.height - pad * 2) / (H + 0.06));
  F.s = s; F.ox = (r.width - W * s) / 2; F.oy = (r.height - H * s) / 2;
}
new ResizeObserver(resize).observe($('stage'));

function sideColor(side) {
  if (mode === 'online') return side === me ? COLORS.me : COLORS.op;
  return side === 'h' ? COLORS.me : COLORS.op;
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function render(t) {
  const { s, dpr } = F;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, F.w, F.h);
  const [x0, y0] = [F.ox, F.oy], fw = W * s, fh = H * s;
  // 画面の上＝相手側
  const topSide = flip ? 'h' : 'g', botSide = other(topSide);
  const topC = sideColor(topSide), botC = sideColor(botSide);

  // リンク
  const bg = ctx.createLinearGradient(0, y0, 0, y0 + fh);
  bg.addColorStop(0, '#1a0d3a'); bg.addColorStop(0.5, '#0b1040'); bg.addColorStop(1, '#06203f');
  roundRect(x0, y0, fw, fh, s * 0.09); ctx.fillStyle = bg; ctx.fill();

  // 線
  ctx.lineWidth = Math.max(1.5, s * 0.006);
  ctx.strokeStyle = 'rgba(255,255,255,.18)';
  ctx.beginPath(); ctx.moveTo(x0, y0 + fh / 2); ctx.lineTo(x0 + fw, y0 + fh / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(x0 + fw / 2, y0 + fh / 2, s * 0.15, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(x0 + fw / 2, y0 + fh / 2, s * 0.02, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fill();
  ctx.strokeStyle = topC + '55';
  ctx.beginPath(); ctx.arc(x0 + fw / 2, y0, s * 0.24, 0, Math.PI); ctx.stroke();
  ctx.strokeStyle = botC + '55';
  ctx.beginPath(); ctx.arc(x0 + fw / 2, y0 + fh, s * 0.24, Math.PI, Math.PI * 2); ctx.stroke();

  // 得点（大きな数字を各陣地に）
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  // センターラインの右はしに、上下それぞれの得点
  ctx.font = `800 ${Math.round(s * 0.15)}px -apple-system, system-ui, sans-serif`;
  const scx = x0 + fw * 0.86;
  ctx.fillStyle = topC + '88';
  if (mode === 'local') {
    ctx.save(); ctx.translate(scx, y0 + fh / 2 - s * 0.1); ctx.rotate(Math.PI); ctx.fillText(G.score[topSide], 0, 0); ctx.restore();
  } else ctx.fillText(G.score[topSide], scx, y0 + fh / 2 - s * 0.1);
  ctx.fillStyle = botC + '88';
  ctx.fillText(G.score[botSide], scx, y0 + fh / 2 + s * 0.1);

  // 外周（ネオン）とゴール
  ctx.save();
  ctx.lineWidth = Math.max(3, s * 0.014); ctx.lineCap = 'round';
  ctx.shadowBlur = 14;
  const gx0 = x0 + GX0 * s, gx1 = x0 + GX1 * s, r = s * 0.09;
  // 上半分
  ctx.strokeStyle = topC; ctx.shadowColor = topC;
  ctx.beginPath();
  ctx.moveTo(x0, y0 + fh / 2); ctx.lineTo(x0, y0 + r); ctx.arcTo(x0, y0, x0 + r, y0, r); ctx.lineTo(gx0, y0);
  ctx.moveTo(gx1, y0); ctx.lineTo(x0 + fw - r, y0); ctx.arcTo(x0 + fw, y0, x0 + fw, y0 + r, r); ctx.lineTo(x0 + fw, y0 + fh / 2);
  ctx.stroke();
  // 下半分
  ctx.strokeStyle = botC; ctx.shadowColor = botC;
  ctx.beginPath();
  ctx.moveTo(x0, y0 + fh / 2); ctx.lineTo(x0, y0 + fh - r); ctx.arcTo(x0, y0 + fh, x0 + r, y0 + fh, r); ctx.lineTo(gx0, y0 + fh);
  ctx.moveTo(gx1, y0 + fh); ctx.lineTo(x0 + fw - r, y0 + fh); ctx.arcTo(x0 + fw, y0 + fh, x0 + fw, y0 + fh - r, r); ctx.lineTo(x0 + fw, y0 + fh / 2);
  ctx.stroke();
  ctx.restore();
  // ゴールの口
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.fillRect(gx0, y0 - s * 0.03, gx1 - gx0, s * 0.03);
  ctx.fillRect(gx0, y0 + fh, gx1 - gx0, s * 0.03);

  // ゴール演出の光
  const since = performance.now() - G.goalTime;
  if (since < 900 && G.goalBy) {
    const into = other(G.goalBy); // ゴールされた側の陣地
    const atTop = into === topSide;
    const a = 1 - since / 900;
    const gy = atTop ? y0 : y0 + fh;
    const grd = ctx.createRadialGradient(x0 + fw / 2, gy, 0, x0 + fw / 2, gy, s * 0.6);
    const c = sideColor(G.goalBy);
    grd.addColorStop(0, c + Math.round(a * 200).toString(16).padStart(2, '0'));
    grd.addColorStop(1, c + '00');
    ctx.fillStyle = grd; ctx.fillRect(x0, atTop ? y0 : y0 + fh - s * 0.6, fw, s * 0.6);
  }

  // マレット
  for (const side of ['h', 'g']) drawMallet(G.m[side], sideColor(side));

  // パック
  const now = clock();
  const hidePuck = now < G.hideUntil || G.phase === 'idle';
  if (!hidePuck) {
    const px = G.puck.x + G.off.x, py = G.puck.y + G.off.y;
    // 残像
    for (let i = 0; i < G.trail.length - 1; i++) {
      const [tx, ty] = toScreen(G.trail[i][0], G.trail[i][1]);
      ctx.beginPath(); ctx.arc(tx, ty, PR * s * (0.4 + i / G.trail.length * 0.5), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,225,77,${0.04 + i * 0.02})`; ctx.fill();
    }
    const [sx, sy] = toScreen(px, py);
    ctx.save();
    ctx.shadowColor = '#ffe14d'; ctx.shadowBlur = 18;
    const pg = ctx.createRadialGradient(sx - PR * s * 0.3, sy - PR * s * 0.3, 1, sx, sy, PR * s);
    pg.addColorStop(0, '#fffbe0'); pg.addColorStop(0.6, '#ffe14d'); pg.addColorStop(1, '#f2a800');
    ctx.beginPath(); ctx.arc(sx, sy, PR * s, 0, Math.PI * 2); ctx.fillStyle = pg; ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.arc(sx, sy, PR * s * 0.55, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(160,100,0,.5)'; ctx.lineWidth = 1.5; ctx.stroke();
    // サーブ待ちのリング
    if (G.phase === 'serve' && now >= G.hideUntil) {
      const k = (t / 700) % 1;
      ctx.beginPath(); ctx.arc(sx, sy, PR * s * (1.3 + k * 1.2), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,225,77,${0.6 * (1 - k)})`; ctx.lineWidth = 2; ctx.stroke();
    }
  }
  // 火花
  for (const sp of G.sparks) {
    const [sx, sy] = toScreen(sp.x, sp.y);
    ctx.fillStyle = `rgba(255,240,180,${clamp(sp.life * 3, 0, 1)})`;
    ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
  }

  // 文字（カウントダウン・ゴール）
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (G.phase === 'serve' && G.first && now < G.at) {
    const n = Math.ceil((G.at - now) / 1000);
    if (n !== lastCount) { lastCount = n; if (n <= 3) sndCount(false); }
    ctx.font = `800 ${Math.round(s * 0.22)}px -apple-system, system-ui, sans-serif`;
    ctx.fillStyle = '#fff'; ctx.shadowColor = '#22e4ff'; ctx.shadowBlur = 20;
    ctx.fillText(n <= 3 ? String(n) : 'READY', x0 + fw / 2, y0 + fh / 2);
    ctx.shadowBlur = 0;
  } else if (lastCount !== 0 && G.phase === 'play') { lastCount = 0; sndCount(true); }
  if (since < 1500 && G.goalBy) {
    const a = clamp(1.5 - since / 1000, 0, 1);
    const good = mode === 'local' || G.goalBy === me;
    const txt = mode === 'local' ? 'GOAL!' : (good ? 'GOAL!' : '失点…');
    const c = sideColor(G.goalBy);
    ctx.save();
    ctx.globalAlpha = a;
    const scale = 1 + Math.max(0, 0.3 - since / 600);
    ctx.translate(x0 + fw / 2, y0 + fh / 2);
    if (mode === 'local' && G.goalBy === topSide) ctx.rotate(Math.PI);
    ctx.scale(scale, scale);
    ctx.font = `900 ${Math.round(s * 0.17)}px -apple-system, system-ui, sans-serif`;
    ctx.fillStyle = '#fff'; ctx.shadowColor = c; ctx.shadowBlur = 24;
    ctx.fillText(txt, 0, 0);
    ctx.restore();
  }
}
let lastCount = -1;
function drawMallet(m, c) {
  const [sx, sy] = toScreen(m.x, m.y), r = MR * F.s;
  ctx.save();
  ctx.shadowColor = c; ctx.shadowBlur = 16;
  const g = ctx.createRadialGradient(sx - r * 0.3, sy - r * 0.35, r * 0.1, sx, sy, r);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, c); g.addColorStop(1, shade(c));
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
  ctx.restore();
  ctx.beginPath(); ctx.arc(sx, sy, r * 0.48, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 2; ctx.stroke();
}
function shade(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = v => Math.round(v * 0.45).toString(16).padStart(2, '0');
  return '#' + f(n >> 16) + f((n >> 8) & 255) + f(n & 255);
}

// ---------------------------------------------------------------
//  画面の切り替え・ダイアログ
// ---------------------------------------------------------------
function showView(v) {
  $('menuView').classList.toggle('hidden', v !== 'menu');
  $('waitView').classList.toggle('hidden', v !== 'wait');
  $('gameView').classList.toggle('hidden', v !== 'game');
  $('quitBtn').classList.toggle('hidden', v === 'menu');
  $('topSpacer').classList.toggle('hidden', v !== 'menu');
  if (v === 'menu') $('title').textContent = 'エアホッケー';
  if (v === 'game') { resize(); keepAwake(true); } else keepAwake(false);
}
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (_) {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && mode) keepAwake(true); });

let dlgTag = null;
function dialog(title, text, buttons, tag = null) {
  $('dlgTitle').textContent = title;
  $('dlgText').textContent = text;
  const box = $('dlgBtns'); box.innerHTML = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'btn wide ' + (b.cls || ''); el.textContent = b.label;
    el.onclick = () => { if (!b.keep) closeDialog(); b.onClick && b.onClick(el); };
    box.appendChild(el);
  }
  dlgTag = tag;
  $('dlg').classList.remove('hidden');
}
function closeDialog() { $('dlg').classList.add('hidden'); dlgTag = null; }
function confirmBox(title, text, ok) {
  return new Promise(res => dialog(title, text, [
    { label: ok, cls: 'pink', onClick: () => res(true) },
    { label: 'キャンセル', onClick: () => res(false) },
  ]));
}
let toastTimer = 0;
function toast(msg, ms = 2200) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function showResult(winner) {
  const mine = G.score[me], theirs = G.score[other(me)];
  let title, text;
  if (mode === 'local') {
    title = winner === 'h' ? '下の人の勝ち！' : '上の人の勝ち！';
    text = `${G.score.h} - ${G.score.g}`;
  } else {
    title = winner === me ? 'あなたの勝ち！' : '負けちゃった…';
    text = `${mine} - ${theirs}` + (mode === 'cpu' ? `（CPU：${LEVELS[level].name}）` : oppName ? `（vs ${oppName}）` : '');
  }
  const buttons = mode === 'online'
    ? [
        { label: 'もう一度', cls: 'primary', keep: true, onClick: el => { el.disabled = true; el.textContent = '相手を待っています…'; requestRematch(); } },
        { label: 'メニューへ', onClick: () => quitGame() },
      ]
    : [
        { label: 'もう一度', cls: 'primary', onClick: () => startOffline(mode) },
        { label: 'メニューへ', onClick: () => quitGame() },
      ];
  dialog(title, text, buttons, 'result');
  if (mode === 'online' && rematchState[other(me)]) $('dlgText').textContent = text + '\n相手は「もう一度」を押しています';
}

async function quitGame() {
  closeDialog();
  if (mode === 'online' || room) await leaveOnline();
  mode = null; G.phase = 'idle';
  pointers.clear();
  showView('menu');
}
$('quitBtn').onclick = async () => {
  const inGame = mode && G.phase !== 'over';
  if (inGame && !await confirmBox('やめる', 'ゲームをやめてメニューに戻りますか？', 'やめる')) return;
  quitGame();
};

// ---------------------------------------------------------------
//  メニュー
// ---------------------------------------------------------------
const nameInput = $('nameInput');
nameInput.value = localStorage.getItem('airhockey.name') || localStorage.getItem('othello.name') || '';
nameInput.addEventListener('change', () => localStorage.setItem('airhockey.name', nameInput.value.trim()));
const myName = () => (nameInput.value.trim() || 'プレイヤー').slice(0, 12);

function paintLevel() {
  for (const b of $('levelSeg').children) b.classList.toggle('on', Number(b.dataset.lv) === level);
}
paintLevel();
$('levelSeg').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  level = Number(b.dataset.lv); localStorage.setItem('airhockey.level', level); paintLevel();
};
$('cpuBtn').onclick = () => { unlockAudio(); startOffline('cpu'); };
$('localBtn').onclick = () => { unlockAudio(); startOffline('local'); };

// ---------------------------------------------------------------
//  Firebase
// ---------------------------------------------------------------
function showOnlineErr(msg) { const el = $('onlineErr'); el.textContent = msg; el.classList.toggle('hidden', !msg); }
function fbErrorText(err) {
  const code = (err && err.code) || '';
  const map = {
    'auth/popup-closed-by-user': 'ログインがキャンセルされました',
    'auth/cancelled-popup-request': 'ログインがキャンセルされました',
    'auth/popup-blocked': 'ポップアップがブロックされました。もう一度押すか、メールでログインしてください',
    'auth/invalid-credential': 'メールアドレスかパスワードが違います',
    'auth/invalid-email': 'メールアドレスの形が正しくありません',
    'auth/email-already-in-use': 'このメールアドレスはもう登録されています。「ログイン」を押してください',
    'auth/weak-password': 'パスワードは6文字以上にしてください',
    'auth/unauthorized-domain': 'このURLが Firebase の「承認済みドメイン」に入っていません（README 参照）',
    'auth/too-many-requests': '試行回数が多すぎます。しばらく待ってからもう一度お試しください',
    'auth/network-request-failed': '通信できませんでした。電波の状態を確認してください',
  };
  const msg = (err && err.message) || String(err);
  if (/permission_denied|PERMISSION_DENIED/i.test(msg + code)) return 'Realtime Database のルールで拒否されました（README の手順でルールを公開してください）';
  if (/dynamically imported module|Importing a module script failed/i.test(msg)) return 'Firebase を読み込めませんでした。通信状態を確認してください';
  if (/databaseURL|Can't determine Firebase Database URL|FIREBASE FATAL/i.test(msg)) return 'Realtime Database が見つかりません（README の手順で作成し、firebase-config.js の databaseURL を確認してください）';
  return map[code] || `エラー: ${msg}`;
}

let fbLoading = null;
function loadFirebase() {
  if (fbLoading) return fbLoading;
  fbLoading = (async () => {
    if (!firebaseConfig.apiKey) throw new Error('firebase-config.js に Firebase の設定がありません');
    const V = '13.4.0';
    const [{ initializeApp, getApps, getApp }, A, D] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${V}/firebase-database.js`),
    ]);
    // オセロ・かぞく予定と同じ設定なので、ログイン状態も共有される
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    const auth = A.getAuth(app);
    fb = { A, D, auth, db: null, app };
    return fb;
  })();
  fbLoading.catch(() => { fbLoading = null; });
  return fbLoading;
}
async function ensureDb() {
  const f = await loadFirebase();
  const u = f.auth.currentUser;
  if (!u || u.isAnonymous) throw new Error('ログインしてください');
  if (!f.db) {
    f.db = f.D.getDatabase(f.app, firebaseConfig.databaseURL);
    f.D.onValue(f.D.ref(f.db, '.info/serverTimeOffset'), s => { srvOffset = s.val() || 0; });
  }
  return { db: f.db, D: f.D, uid: u.uid };
}

let pendingRoom = null;
{
  const q = new URLSearchParams(location.search).get('room');
  if (q && /^[A-Za-z2-9]{4}$/.test(q)) pendingRoom = q.toUpperCase();
}
function setAuthUI(state, user) {
  $('authLoading').classList.toggle('hidden', state !== 'loading');
  $('loginBox').classList.toggle('hidden', state !== 'out');
  $('onlineBox').classList.toggle('hidden', state !== 'in');
  if (state === 'in') {
    $('acctName').textContent = user.displayName || user.email || 'ユーザー';
    if (!nameInput.value.trim() && user.displayName) {
      nameInput.value = user.displayName.slice(0, 12);
      localStorage.setItem('airhockey.name', nameInput.value);
    }
  }
}
async function startAuth() {
  setAuthUI('loading');
  try {
    const { A, auth } = await loadFirebase();
    await A.setPersistence(auth, A.browserLocalPersistence).catch(() => {});
    A.onAuthStateChanged(auth, async user => {
      if (user && user.isAnonymous) { await A.signOut(auth); return; }
      if (!user) {
        if (mode === 'online') { toast('ログアウトしました'); quitGame(); }
        setAuthUI('out');
        if (pendingRoom) toast(`ログインすると部屋 ${pendingRoom} に参加します`, 3500);
        return;
      }
      setAuthUI('in', user);
      showOnlineErr('');
      if (pendingRoom) {
        const code = pendingRoom; pendingRoom = null;
        history.replaceState(null, '', location.pathname);
        $('codeInput').value = code;
        if (nameInput.value.trim()) $('joinBtn').click();
        else { nameInput.focus(); toast('名前を入れて「参加する」を押してください', 3500); }
      }
    });
  } catch (e) {
    console.error(e);
    $('authLoading').classList.add('hidden');
    showOnlineErr(fbErrorText(e) + '（CPU対戦・ふたりで対戦は遊べます）');
    addEventListener('online', () => { showOnlineErr(''); startAuth(); }, { once: true });
  }
}
startAuth();

$('googleBtn').onclick = async () => {
  showOnlineErr('');
  try { const { A, auth } = await loadFirebase(); await A.signInWithPopup(auth, new A.GoogleAuthProvider()); }
  catch (e) { showOnlineErr(fbErrorText(e)); }
};
$('emailForm').addEventListener('submit', async e => {
  e.preventDefault();
  showOnlineErr('');
  const signup = e.submitter && e.submitter.dataset.mode === 'signup';
  const email = $('email').value.trim(), pw = $('password').value;
  try {
    const { A, auth } = await loadFirebase();
    if (signup) await A.createUserWithEmailAndPassword(auth, email, pw);
    else await A.signInWithEmailAndPassword(auth, email, pw);
    $('password').value = '';
  } catch (e2) { showOnlineErr(fbErrorText(e2)); }
});
$('logoutBtn').onclick = async () => {
  if (!await confirmBox('ログアウト', 'ログアウトしますか？（オセロ・かぞく予定からもログアウトします）', 'ログアウト')) return;
  try { await fb.A.signOut(fb.auth); } catch (e) { toast(fbErrorText(e)); }
};

async function withBusy(btn, fn) {
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = '接続中…'; showOnlineErr('');
  try { await fn(); } catch (e) { console.error(e); showOnlineErr(fbErrorText(e)); }
  finally { btn.disabled = false; btn.textContent = label; }
}
// 通信に時間がかかりすぎたらあきらめる
function timeout(p, ms = 10000) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('サーバーにつながりません（Realtime Database が作成されているか確認してください）')), ms))]);
}
const makeCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const roomRef = (D, db, code, path = '') => D.ref(db, `airhockey/${code}${path ? '/' + path : ''}`);

$('createBtn').onclick = () => withBusy($('createBtn'), async () => {
  unlockAudio();
  localStorage.setItem('airhockey.name', nameInput.value.trim());
  const { db, D, uid } = await ensureDb();
  let code = null;
  for (let i = 0; i < 6 && !code; i++) {
    const c = makeCode();
    const res = await timeout(D.runTransaction(roomRef(D, db, c, 'meta'), cur => {
      if (cur) return; // 使用中
      return { host: uid, hostName: myName(), guest: '', guestName: '', status: 'waiting', createdAt: Date.now() };
    }));
    if (res.committed) code = c;
  }
  if (!code) throw new Error('部屋を作れませんでした。もう一度お試しください');
  await enterRoom(code, 'h');
});

$('codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('joinBtn').onclick = () => withBusy($('joinBtn'), async () => {
  unlockAudio();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!/^[A-Z2-9]{4}$/.test(code)) throw new Error('4文字の部屋コードを入れてください');
  localStorage.setItem('airhockey.name', nameInput.value.trim());
  const { db, D, uid } = await ensureDb();
  const metaRef = roomRef(D, db, code, 'meta');
  const snap = await timeout(D.get(metaRef));
  const m = snap.val();
  if (!m) throw new Error(`部屋 ${code} は見つかりませんでした`);
  if (m.host === uid) { await enterRoom(code, 'h'); return; }
  if (m.guest && m.guest !== uid) throw new Error('この部屋はもう満員です');
  const res = await timeout(D.runTransaction(metaRef, cur => {
    if (!cur) return cur;
    if (cur.guest && cur.guest !== uid) return; // 先に誰かが入った
    cur.guest = uid; cur.guestName = myName();
    return cur;
  }));
  if (!res.committed || !res.snapshot.val() || res.snapshot.val().guest !== uid) throw new Error('この部屋はもう満員です');
  await enterRoom(code, 'g');
});

// ---------------------------------------------------------------
//  オンライン対戦
// ---------------------------------------------------------------
async function enterRoom(code, side) {
  const { db, D } = await ensureDb();
  room = code; me = side; flip = side === 'g';
  G.round = 0; G.score = { h: 0, g: 0 }; G.phase = 'idle';
  remote = null; ghost = null; handoff = null; epoch = 0; owner = 'h';
  rematchState = {}; oppWasOnline = false; oppName = '';
  resetMallets();
  const R = p => roomRef(D, db, code, p);

  // 接続状態（切れたら自動で online/自分 を消す。つながり直したら付け直す）
  const myOnline = R('online/' + me);
  unsubs.push(D.onValue(D.ref(db, '.info/connected'), s => {
    if (s.val() !== true || room !== code) return;
    D.onDisconnect(myOnline).remove().then(() => D.set(myOnline, true)).catch(() => {});
  }));

  unsubs.push(D.onValue(R('meta'), s => onMeta(s.val())));
  unsubs.push(D.onValue(R('round'), s => applyRound(s.val())));
  unsubs.push(D.onValue(R('st/' + other(me)), s => onRemote(s.val())));
  unsubs.push(D.onValue(R('rematch'), s => onRematch(s.val() || {})));
  unsubs.push(D.onValue(R('online/' + other(me)), s => onOppOnline(s.val() === true)));

  $('codeText').textContent = code;
  $('waitText').textContent = side === 'h' ? '相手の参加を待っています…' : '参加しました。まもなく始まります…';
  $('shareBtn').classList.toggle('hidden', side !== 'h');
  $('title').textContent = `部屋 ${code}`;
  showView('wait');
}

async function leaveOnline() {
  const code = room;
  unsubs.forEach(f => { try { f(); } catch (_) {} });
  unsubs = [];
  room = null;
  if (!code || !fb || !fb.db) return;
  const { D, db } = fb;
  try {
    await D.onDisconnect(roomRef(D, db, code, 'online/' + me)).cancel();
    if (me === 'h') await D.remove(roomRef(D, db, code));       // 部屋を作った人が抜けたら部屋ごと消す
    else await D.remove(roomRef(D, db, code, 'online/' + me));
  } catch (e) { console.warn(e); }
}

function onMeta(m) {
  if (!room) return;
  if (!m) {
    if (mode === 'online' || me === 'g') {
      dialog('部屋が閉じられました', '相手が部屋を閉じました。', [{ label: 'メニューへ', onClick: () => quitGame() }]);
      mode = null;
    }
    return;
  }
  oppName = (me === 'h' ? m.guestName : m.hostName) || '';
  if (me === 'h' && m.guest && m.status === 'waiting') {
    // 相手が来たので試合開始
    const { D, db } = fb;
    D.update(roomRef(D, db, room), {
      'meta/status': 'playing',
      round: { n: 1, h: 0, g: 0, serveTo: Math.random() < 0.5 ? 'h' : 'g', at: Math.round(clock() + 3500), winner: '' },
    }).catch(e => toast(fbErrorText(e)));
  }
}

function applyRound(r) {
  if (!room || !r || r.n <= G.round) return;
  const fresh = r.h === 0 && r.g === 0;
  const scorer = !fresh && r.h > G.score.h ? 'h' : !fresh && r.g > G.score.g ? 'g' : null;
  if (mode !== 'online') {
    mode = 'online';
    $('hudLeft').textContent = `あなた vs ${oppName || '相手'}`;
    showView('game');
  }
  if (fresh) { closeDialog(); G.first = true; G.goalBy = null; resetMallets(); if (remote) remote = null; }
  // 自分がゴールを検出した場合は onGoalOnline で演出済み
  if (scorer && !(G.phase === 'goal' && G.goalBy === scorer)) {
    G.goalBy = scorer; G.goalTime = performance.now(); sndGoal(scorer === me);
  }
  G.round = r.n;
  G.score = { h: r.h, g: r.g };
  epoch = 0; owner = r.serveTo; handoff = null;
  const sp = servePos(r.serveTo);
  ghost = { ...sp, pt: r.at };
  ghostChanged = false;
  G.hideUntil = scorer ? clock() + 500 : 0;
  Object.assign(G.puck, sp); G.off.x = G.off.y = 0; G.trail = [];
  if (r.winner) {
    G.phase = 'over';
    setTimeout(() => { if (G.phase === 'over' && room) showResult(r.winner); }, 900);
  } else {
    G.phase = 'serve'; G.at = r.at;
    if (dlgTag === 'result') closeDialog();
  }
  rematchState = {};
}

function onGoalOnline(scorer) {
  G.phase = 'goal';
  G.goalBy = scorer; G.goalTime = performance.now();
  sndGoal(scorer === me);
  const { D, db } = fb;
  const myRound = G.round;
  D.runTransaction(roomRef(D, db, room, 'round'), cur => {
    if (!cur) return cur;
    if (cur.n !== myRound) return; // もう次のラウンドになっている
    cur.n += 1;
    cur[scorer] += 1;
    cur.serveTo = other(scorer);
    cur.at = Math.round(clock() + 1800);
    cur.winner = cur[scorer] >= WIN ? scorer : '';
    return cur;
  }).catch(e => toast(fbErrorText(e)));
}

// パックが相手の陣地に入ったら、計算の担当を相手に渡す
function checkHandoff() {
  const y = G.puck.y;
  const inOpp = me === 'h' ? y < MID - 0.01 : y > MID + 0.01;
  if (!inOpp) return;
  epoch += 1;
  owner = other(me);
  const now = clock();
  handoff = { x: G.puck.x, y: G.puck.y, vx: G.puck.vx, vy: G.puck.vy, pt: now };
  ghost = { ...handoff };
  ghostChanged = false;
  sendState(now);
}

function sendState(now) {
  if (!room || !fb) return;
  lastSend = now;
  const m = G.m[me];
  const msg = { x: r4(m.x), y: r4(m.y), vx: r4(clamp(m.vx, -20, 20)), vy: r4(clamp(m.vy, -20, 20)), r: G.round, e: epoch, o: owner, t: Math.round(now) };
  const p = owner === me ? { ...G.puck, pt: now } : handoff;
  if (p) { msg.p = [r4(p.x), r4(p.y), r4(p.vx), r4(p.vy)]; msg.pt = Math.round(p.pt); }
  fb.D.set(roomRef(fb.D, fb.db, room, 'st/' + me), msg).catch(() => {});
}
function netTick(now) {
  if (G.phase !== 'idle' && now - lastSend >= SEND_MS) sendState(now);
  // 通信の状態表示
  const silent = performance.now() - lastRecv;
  const el = $('hudRight');
  if (!remote || silent > 1500) el.innerHTML = '<span class="dot bad"></span>相手の通信を待っています';
  else el.innerHTML = `<span class="dot${latency > 250 ? ' bad' : ''}"></span>通信 ${Math.round(latency)}ms`;
}

function onRemote(v) {
  if (!v || !room) return;
  lastRecv = performance.now();
  const lat = clamp(clock() - v.t, 0, 2000);
  latency = latency ? latency * 0.8 + lat * 0.2 : lat;
  remote = { x: v.x, y: v.y, vx: v.vx || 0, vy: v.vy || 0 };
  if (v.r !== G.round || !v.p) return;
  const snap = { x: v.p[0], y: v.p[1], vx: v.p[2], vy: v.p[3], pt: v.pt };
  if (v.e > epoch) {
    epoch = v.e; owner = v.o;
    if (owner === me) {
      // 担当を受け取った：届いた状態を、経過した時間ぶん進めてから計算を引き継ぐ
      handoff = null;
      setPuck(advance(snap, (clock() - snap.pt) / 1000));
      if (G.phase === 'serve' && clock() >= G.at) G.phase = 'play';
    } else { ghost = snap; ghostChanged = true; }
  } else if (v.e === epoch && v.o === other(me) && owner === other(me)) {
    ghost = snap; ghostChanged = true;
  }
}

function onOppOnline(on) {
  if (on) {
    oppWasOnline = true;
    if (dlgTag === 'away') closeDialog();
    return;
  }
  if (oppWasOnline && mode === 'online' && G.phase !== 'over') {
    dialog('相手の通信が切れました', 'もどってくるまで待つか、メニューに戻ってください。', [{ label: 'メニューへ', onClick: () => quitGame() }], 'away');
  }
}

function requestRematch() {
  const { D, db } = fb;
  D.set(roomRef(D, db, room, 'rematch/' + me), true).catch(e => toast(fbErrorText(e)));
}
function onRematch(v) {
  rematchState = v;
  if (!room) return;
  if (dlgTag === 'result' && v[other(me)] && !v[me]) $('dlgText').textContent = $('dlgText').textContent.split('\n')[0] + '\n相手は「もう一度」を押しています';
  if (me === 'h' && v.h && v.g) {
    const { D, db } = fb;
    D.update(roomRef(D, db, room), {
      rematch: null,
      round: { n: G.round + 1, h: 0, g: 0, serveTo: Math.random() < 0.5 ? 'h' : 'g', at: Math.round(clock() + 3500), winner: '' },
    }).catch(e => toast(fbErrorText(e)));
  }
}

$('shareBtn').onclick = async () => {
  const url = `${location.origin}${location.pathname}?room=${room}`;
  const text = `エアホッケーで対戦しよう！ 部屋コード：${room}`;
  try {
    if (navigator.share) await navigator.share({ title: 'エアホッケー', text, url });
    else { await navigator.clipboard.writeText(`${text}\n${url}`); toast('招待リンクをコピーしました'); }
  } catch (_) {}
};

// テスト用（ブラウザのコンソールから状態を見られるように）
window.__airhockey = { G, get mode() { return mode; }, get owner() { return owner; }, get epoch() { return epoch; } };
