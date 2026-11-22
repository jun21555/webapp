// ===============================================================
//  写真から取り込み：テキストの読み取り（画面に関係しない部分）
// ---------------------------------------------------------------
//  流れ：
//   1. アプリが「Claude への指示文」を作る（buildPrompt）
//   2. Claude のチャットに 手帳の写真 ＋ 指示文 を送る
//   3. Claude が返したテキストをアプリに貼り付ける
//   4. このファイルの parseImportText で予定の一覧に変換 → 確認画面へ
//
//  テキストの形式（1行＝1件、区切りは「|」）
//    日付 | 時間 | タイトル | だれ | メモ
//    2026-11-04 | 14:00 | Ash | ママ |
//    2026-11-04 | 17:30-18:00 | ピアノ | はると |
//    2026-11-03 | 終日 | ららぽーと | 全員 | コメダにも寄る
// ===============================================================

export const DEFAULT_HINTS = `- 消し線で消してある予定は登録しない
- 印刷されている六曜（大安・仏滅・先勝など）、祝日名、月齢のマークは予定ではない
- 欄外のメモ（左端の週の欄、ページ下の余白）は予定として登録しない
- 矢印で何日かにまたがる予定は、日ごとに1行ずつ書く
- マークやハンコは、次のタイトルにする
  - 「塾」のハンコ → 塾
  - 波のマーク → スイミング
  - ピアノの絵 → ピアノ
  - 音符 → 音楽教室
  - 赤い「休」のハンコ → 仕事休み（終日）
  - 丸で囲んだ「内」 → 内科`;

// Claude に渡す指示文
export function buildPrompt({ members, hints, year }) {
  const names = members.map(m => m.name).filter(Boolean);
  return `添付した手帳（カレンダー）の写真から予定を読み取って、下の形式のテキストにしてください。

【出力の形式】
- 1行に1件。「日付 | 時間 | タイトル | だれ | メモ」の順に、半角の「|」で区切る
- 日付：YYYY-MM-DD（写真に書かれた年月を使う。わからなければ ${year} 年）
- 時間：「終日」、「10:00」、「10:00-11:30」のどれか
- だれ：次の名前から選んで「,」区切り。家族全員なら「全員」、わからなければ空欄
  ${names.length ? names.join(' / ') : '（未登録）'}
- メモ：持ち物・場所・金額など。なければ空欄
- 読み取りに自信がない予定は、メモの先頭に「要確認」と書く
- 日付の順に並べ、全体を \`\`\` で囲む。前後の説明は不要

【読み取りのルール】
${(hints || DEFAULT_HINTS).trim()}`;
}

// 全角→半角などをそろえる（「１４：００」→「14:00」、「｜」→「|」）
function norm(s) { return s.normalize('NFKC').replace(/[​﻿]/g, '').trim(); }

function pad(n) { return String(n).padStart(2, '0'); }

function parseDate(s, year) {
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/月](\d{1,2})日?/);
  if (m) return valid(year, +m[1], +m[2]);
  return null;
}
function valid(y, mo, d) {
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

function parseTime(s) {
  s = s.replace(/\s/g, '');
  if (!s || /終日|全日|allday/i.test(s)) return { allDay: true, start: '', end: '' };
  const t = '(\\d{1,2})[:時](\\d{2})?分?';
  const m = s.match(new RegExp(`^${t}(?:[-~〜～ー―－–—]${t})?`));
  if (!m) return null;
  const hm = (h, mi) => (+h <= 24 && +(mi || 0) < 60) ? `${pad(Math.min(+h, 23))}:${pad(+(mi || 0))}` : null;
  const start = hm(m[1], m[2]);
  const end = m[3] != null ? hm(m[3], m[4]) : '';
  if (!start || end === null) return null;
  return { allDay: false, start, end };
}

// 貼り付けられたテキスト → { items:[予定], errors:[読めなかった行] }
export function parseImportText(text, { members = [], year = new Date().getFullYear() } = {}) {
  const items = [], errors = [];
  const byName = name => {
    name = name.trim();
    return members.find(m => m.name === name)
      || members.find(m => m.name && (m.name.startsWith(name) || name.startsWith(m.name)));
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = norm(raw);
    if (!line || line.startsWith('```') || line.startsWith('#')) continue;
    const cols = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (!line.includes('|')) continue; // 「|」のない行は説明文なので読み飛ばす
    if (/^日付/.test(cols[0]) || /^[-:\s]+$/.test(cols[0])) continue; // 見出し行・表の区切り線
    if (cols.length < 3) { errors.push(raw.trim()); continue; }
    const [d, t, title, who = '', ...rest] = cols;
    const date = parseDate(d, year);
    const time = parseTime(t);
    if (!date || !time || !title) { errors.push(raw.trim()); continue; }

    let note = rest.join(' | ').trim();
    const check = /^要確認/.test(note);
    const memberIds = [], unknown = [];
    for (const n of who.split(/[,、・/／\s]+/).filter(Boolean)) {
      if (n === '全員' || n === 'みんな') { members.forEach(m => memberIds.includes(m.id) || memberIds.push(m.id)); continue; }
      const m = byName(n);
      if (m) { if (!memberIds.includes(m.id)) memberIds.push(m.id); } else unknown.push(n);
    }
    if (unknown.length) note = [`だれ：${unknown.join('、')}`, note].filter(Boolean).join(' / ');
    items.push({ date, ...time, title: title.slice(0, 100), memberIds, note: note.slice(0, 500), check, unknown });
  }
  return { items, errors };
}

// すでに登録済みの予定と同じか（日付・タイトル・開始時刻で比べる）
export function sameEvent(a, b) {
  const k = s => (s || '').normalize('NFKC').replace(/\s/g, '').toLowerCase();
  return a.date === b.date && k(a.title) === k(b.title) && (a.allDay ? '' : a.start || '') === (b.allDay ? '' : b.start || '');
}
