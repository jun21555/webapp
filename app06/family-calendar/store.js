// ===============================================================
//  データの読み書き（データ層）
// ---------------------------------------------------------------
//  画面（app.js）は、ここにある関数だけを使ってデータを扱います。
//  Firebase の設定があれば Firestore に、なければ端末内（デモ）に保存します。
//  どちらも同じ名前の関数を持っているので、画面側は違いを気にしなくて大丈夫です。
//
//  ■ Firestore のデータ構造（Notes でいうと…）
//
//  users/{uid}                      … ユーザーごとの文書（どの家族に入っているか）
//      familyId, name, color
//
//  families/{familyId}              … 家族の文書（Notes の「データベース」のイメージ）
//      name, inviteCode, createdBy, createdAt
//    ├ members/{uid}                … 家族のメンバー（ACL のエントリーのイメージ）
//    │   name, color, joinedAt
//    └ events/{eventId}             … 予定の文書（NotesDocument のイメージ）
//        title, date("2026-11-25"), allDay, start("10:00"), end("11:00"),
//        memberIds[], note, createdBy, updatedAt
//
//  invites/{招待コード}               … 招待コード → familyId の対応表
//      familyId
// ===============================================================

import { firebaseConfig } from './firebase-config.js';

export const COLORS = ['#ff7a59', '#3fa7d6', '#f5b700', '#59c48a', '#a77be0', '#ef5f8f', '#5a6acf', '#8d6e63'];

// 招待コード用の文字（0/O、1/I など見間違えやすい文字は除く）
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeInviteCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export const isDemo = !firebaseConfig.apiKey;

export async function createStore() {
  return isDemo ? createDemoStore() : createFirebaseStore();
}

// ===============================================================
//  Firebase 版
// ===============================================================
async function createFirebaseStore() {
  const V = '13.4.0';
  const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
  const A = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
  const F = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);

  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  // オフラインでも直前のデータを表示できるよう、端末にキャッシュを持たせる
  const db = F.initializeFirestore(app, {
    localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }),
  });

  const uid = () => auth.currentUser.uid;

  return {
    demo: false,

    // ---- ログイン ----
    onUser(cb) {
      return A.onAuthStateChanged(auth, u => cb(u ? { uid: u.uid, name: u.displayName || '', email: u.email || '' } : null));
    },
    signInGoogle: () => A.signInWithPopup(auth, new A.GoogleAuthProvider()),
    signInEmail: (email, pw) => A.signInWithEmailAndPassword(auth, email, pw),
    signUpEmail: (email, pw) => A.createUserWithEmailAndPassword(auth, email, pw),
    signOut: () => A.signOut(auth),

    // ---- 自分の情報（どの家族に入っているか） ----
    async getProfile() {
      const snap = await F.getDoc(F.doc(db, 'users', uid()));
      return snap.exists() ? snap.data() : null;
    },

    // ---- 家族を作る ----
    async createFamily({ familyName, myName, color }) {
      // 使われていない招待コードを探す
      let code;
      for (let i = 0; i < 5; i++) {
        code = makeInviteCode();
        if (!(await F.getDoc(F.doc(db, 'invites', code))).exists()) break;
      }
      const familyRef = F.doc(F.collection(db, 'families')); // ID だけ先に決める
      // 4つの文書をまとめて保存（全部成功するか、全部失敗するか）
      const batch = F.writeBatch(db);
      batch.set(familyRef, { name: familyName, inviteCode: code, createdBy: uid(), createdAt: F.serverTimestamp() });
      batch.set(F.doc(db, 'invites', code), { familyId: familyRef.id });
      batch.set(F.doc(db, 'families', familyRef.id, 'members', uid()), { name: myName, color, joinedAt: F.serverTimestamp() });
      batch.set(F.doc(db, 'users', uid()), { familyId: familyRef.id, name: myName, color });
      await batch.commit();
      return familyRef.id;
    },

    // ---- 招待コードで家族に参加する ----
    async joinFamily({ code, myName, color }) {
      code = code.trim().toUpperCase();
      const inv = await F.getDoc(F.doc(db, 'invites', code));
      if (!inv.exists()) throw new Error('招待コードが見つかりません');
      const familyId = inv.data().familyId;
      const batch = F.writeBatch(db);
      // inviteCode はセキュリティルールで「正しいコードを知っている人か」を確かめるために入れる
      batch.set(F.doc(db, 'families', familyId, 'members', uid()), { name: myName, color, inviteCode: code, joinedAt: F.serverTimestamp() });
      batch.set(F.doc(db, 'users', uid()), { familyId, name: myName, color });
      await batch.commit();
      return familyId;
    },

    // ---- 変更をリアルタイムに受け取る（onSnapshot） ----
    watchFamily(familyId, cb, onErr) {
      return F.onSnapshot(F.doc(db, 'families', familyId), s => cb(s.exists() ? { id: s.id, ...s.data() } : null), onErr);
    },
    watchMembers(familyId, cb, onErr) {
      return F.onSnapshot(F.collection(db, 'families', familyId, 'members'),
        s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), onErr);
    },
    // from〜to（"YYYY-MM-DD"）の予定。SQL なら WHERE date BETWEEN from AND to ORDER BY date
    watchEvents(familyId, from, to, cb, onErr) {
      const q = F.query(F.collection(db, 'families', familyId, 'events'),
        F.where('date', '>=', from), F.where('date', '<=', to), F.orderBy('date'));
      return F.onSnapshot(q, s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), onErr);
    },

    // ---- 予定の保存・削除 ----
    async saveEvent(familyId, ev) {
      const { id, ...data } = ev;
      data.updatedAt = F.serverTimestamp();
      if (id) {
        await F.updateDoc(F.doc(db, 'families', familyId, 'events', id), data);
      } else {
        data.createdBy = uid();
        await F.addDoc(F.collection(db, 'families', familyId, 'events'), data);
      }
    },
    deleteEvent: (familyId, id) => F.deleteDoc(F.doc(db, 'families', familyId, 'events', id)),

    // ---- 自分の名前・色を変える ----
    async updateMe(familyId, { name, color }) {
      const batch = F.writeBatch(db);
      batch.update(F.doc(db, 'families', familyId, 'members', uid()), { name, color });
      batch.update(F.doc(db, 'users', uid()), { name, color });
      await batch.commit();
    },
  };
}

// ===============================================================
//  デモ版（Firebase の設定がないとき。データはこの端末の localStorage だけ）
// ===============================================================
function createDemoStore() {
  const KEY = 'family-calendar-demo';
  const ME = 'demo-me';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) { return {}; } };
  let data = load(); // { signedIn, profile, family, members:{}, events:{} }
  const listeners = new Set();
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (_) {}
    listeners.forEach(fn => fn());
  };
  const watch = fn => { listeners.add(fn); fn(); return () => listeners.delete(fn); };
  const newId = () => Math.random().toString(36).slice(2, 10);
  let userCb = () => {};
  const emitUser = () => userCb(data.signedIn ? { uid: ME, name: '', email: 'demo' } : null);

  return {
    demo: true,
    onUser(cb) { userCb = cb; setTimeout(emitUser); return () => {}; },
    async signInGoogle() { data.signedIn = true; save(); emitUser(); },
    async signInEmail() { data.signedIn = true; save(); emitUser(); },
    async signUpEmail() { data.signedIn = true; save(); emitUser(); },
    async signOut() { data.signedIn = false; save(); emitUser(); },
    async getProfile() { return data.profile || null; },

    async createFamily({ familyName, myName, color }) {
      const familyId = 'demo-family';
      data.family = { id: familyId, name: familyName, inviteCode: makeInviteCode() };
      data.members = { [ME]: { name: myName, color } };
      // 雰囲気がわかるように、見本のメンバーと予定を入れておく
      const others = COLORS.filter(c => c !== color);
      data.members['demo-a'] = { name: 'ママ', color: others[0] };
      data.members['demo-b'] = { name: 'はると', color: others[1] };
      data.events = {};
      const d = new Date();
      const day = n => { const x = new Date(d); x.setDate(d.getDate() + n); return ymdOf(x); };
      const add = (ev) => { data.events[newId()] = { allDay: false, start: '', end: '', note: '', createdBy: ME, ...ev }; };
      add({ title: '保育園の面談', date: day(0), start: '10:00', end: '10:30', memberIds: ['demo-a'] });
      add({ title: 'スイミング', date: day(0), start: '16:00', end: '17:00', memberIds: ['demo-b'], note: '送迎：パパ' });
      add({ title: '燃えるゴミ', date: day(1), allDay: true, memberIds: [] });
      add({ title: '出張（大阪）', date: day(2), allDay: true, memberIds: [ME] });
      add({ title: '家族でお出かけ', date: day(5), start: '09:30', end: '15:00', memberIds: [ME, 'demo-a', 'demo-b'], note: 'お弁当' });
      data.profile = { familyId, name: myName, color };
      save();
      return familyId;
    },
    async joinFamily() { throw new Error('デモモードでは招待コードで参加できません。「家族を作る」で試してください'); },

    watchFamily(familyId, cb) { return watch(() => cb(data.family || null)); },
    watchMembers(familyId, cb) {
      return watch(() => cb(Object.entries(data.members || {}).map(([id, m]) => ({ id, ...m }))));
    },
    watchEvents(familyId, from, to, cb) {
      return watch(() => cb(Object.entries(data.events || {})
        .map(([id, e]) => ({ id, ...e }))
        .filter(e => e.date >= from && e.date <= to)));
    },
    async saveEvent(familyId, ev) {
      const { id, ...rest } = ev;
      data.events = data.events || {};
      data.events[id || newId()] = { ...(id ? data.events[id] : { createdBy: ME }), ...rest };
      save();
    },
    async deleteEvent(familyId, id) { delete data.events[id]; save(); },
    async updateMe(familyId, { name, color }) {
      data.members[ME] = { ...data.members[ME], name, color };
      data.profile = { ...data.profile, name, color };
      save();
    },
    resetDemo() { localStorage.removeItem(KEY); data = {}; listeners.forEach(fn => fn()); emitUser(); },
  };
}

export function ymdOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
