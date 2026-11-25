#!/usr/bin/env python3
"""株ノート: Issue のタイトルからウォッチリストに銘柄を追加・削除する。

タイトルの形式（アプリの「追加」「削除」ボタンが自動で作る）:
  株ノート: 追加 7203
  株ノート: 追加 7203 6758   （複数可）
  株ノート: 削除 7203
"""
import json
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
WATCH = BASE / "watchlist.json"
CODE_RE = re.compile(r"^[0-9][0-9A-Z]{3}$")


def main():
    title = (sys.argv[1] if len(sys.argv) > 1 else "").replace("：", ":").replace("　", " ")
    m = re.match(r"^\s*株ノート\s*:\s*(追加|削除)\s+(.+)$", title)
    if not m:
        raise SystemExit(f"タイトルの形式が違います: {title}")
    action = m.group(1)
    codes = [c.upper() for c in re.split(r"[\s,、]+", m.group(2)) if c]
    bad = [c for c in codes if not CODE_RE.match(c)]
    if bad or not codes:
        raise SystemExit(f"銘柄コードが正しくありません: {bad or codes}")

    names = {}
    try:
        rows = json.loads((BASE / "data" / "jpx-list.json").read_text(encoding="utf-8"))["rows"]
        names = {r[0]: r[1] for r in rows}
    except Exception:
        pass

    watch = json.loads(WATCH.read_text(encoding="utf-8"))
    have = {w["code"] for w in watch}
    if action == "追加":
        for c in codes:
            if c not in have:
                watch.append({"code": c, "name": names.get(c, c)})
                print(f"追加: {c} {names.get(c, '')}")
        if len(watch) > 60:
            raise SystemExit("ウォッチできるのは60銘柄までです")
    else:
        watch = [w for w in watch if w["code"] not in codes]
        print(f"削除: {' '.join(codes)}")
    WATCH.write_text(json.dumps(watch, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
