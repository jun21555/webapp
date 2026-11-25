#!/usr/bin/env python3
"""株ノート: JPX（日本取引所グループ）の東証上場銘柄一覧を取得して data/jpx-list.json に保存する。

アプリの「銘柄を探す」で銘柄名・コード検索に使う。週に1回だけ更新する（--force で強制）。
"""
import datetime as dt
import io
import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request

import pandas as pd

PAGE = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html"
FALLBACK = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx"
UA = {"User-Agent": "Mozilla/5.0 (kabu-note)"}


def excel_url():
    """一覧ページから Excel のリンクを探す（.xls → .xlsx のようにファイル名が変わっても追従する）"""
    try:
        html = urllib.request.urlopen(urllib.request.Request(PAGE, headers=UA), timeout=60).read().decode("utf-8", "ignore")
        m = re.search(r'href="([^"]+data_j\.xlsx?)"', html)
        if m:
            return urllib.parse.urljoin(PAGE, m.group(1))
    except Exception as e:
        print(f"一覧ページを読めませんでした: {e}", file=sys.stderr)
    return FALLBACK
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
    url = excel_url()
    print(f"取得: {url}")
    raw = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()
    df = pd.read_excel(io.BytesIO(raw), dtype=str)  # 形式（xls / xlsx）は中身から自動判定
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
