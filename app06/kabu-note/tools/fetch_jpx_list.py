#!/usr/bin/env python3
"""株ノート: JPX（日本取引所グループ）の東証上場銘柄一覧を取得して data/jpx-list.json に保存する。

アプリの「銘柄を探す」で銘柄名・コード検索に使う。週に1回だけ更新する（--force で強制）。
"""
import datetime as dt
import io
import json
import pathlib
import sys
import urllib.request

import pandas as pd

URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls"
OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "jpx-list.json"
JST = dt.timezone(dt.timedelta(hours=9))


def main():
    if OUT.exists() and "--force" not in sys.argv:
        try:
            upd = dt.datetime.fromisoformat(json.loads(OUT.read_text(encoding="utf-8"))["updated"])
            if dt.datetime.now(JST) - upd < dt.timedelta(days=7):
                print("銘柄一覧は最新です")
                return
        except Exception:
            pass
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0 (kabu-note)"})
    raw = urllib.request.urlopen(req, timeout=60).read()
    df = pd.read_excel(io.BytesIO(raw), dtype=str, engine="xlrd")
    rows = []
    for _, r in df.iterrows():
        market = str(r.get("市場・商品区分", ""))
        if "内国株式" not in market:  # ETF・REIT・PRO Market などは除く
            continue
        code = str(r.get("コード", "")).strip().upper()
        if code.endswith(".0"):
            code = code[:-2]
        rows.append([code, str(r.get("銘柄名", "")).strip(),
                     market.replace("（内国株式）", ""), str(r.get("33業種区分", "")).strip()])
    if len(rows) < 1000:
        raise SystemExit(f"銘柄数が少なすぎます（{len(rows)}件）。形式が変わった可能性があります")
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"updated": dt.datetime.now(JST).isoformat(timespec="minutes"),
                               "columns": ["code", "name", "market", "sector"], "rows": rows},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(rows)} 銘柄を保存しました")


if __name__ == "__main__":
    main()
