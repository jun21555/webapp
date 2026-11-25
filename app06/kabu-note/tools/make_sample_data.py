#!/usr/bin/env python3
"""株ノート: 画面確認用のダミーデータを作る（ネットにつながらない環境での開発用）。

  python app06/kabu-note/tools/make_sample_data.py 出力先フォルダ

本物のデータではないので、出力先にリポジトリの data/ は指定しないこと。
"""
import datetime as dt
import json
import math
import pathlib
import random
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent


def walk(seed, start, n, vol=0.017, drift=0.0003):
    rnd = random.Random(seed)
    d = dt.date.today() - dt.timedelta(days=int(n * 1.45))
    p, rows = start, []
    while len(rows) < n:
        d += dt.timedelta(days=1)
        if d.weekday() >= 5:
            continue
        o = p * (1 + rnd.gauss(0, vol / 3))
        c = o * (1 + rnd.gauss(drift, vol))
        h = max(o, c) * (1 + abs(rnd.gauss(0, vol / 2)))
        l = min(o, c) * (1 - abs(rnd.gauss(0, vol / 2)))
        rows.append([d.isoformat(), round(o, 1), round(h, 1), round(l, 1), round(c, 1), int(abs(rnd.gauss(5e6, 2e6)))])
        p = c
    return rows


def weekly_closes(prices, years=5):
    last = dt.date.fromisoformat(prices[-1][0])
    start = (last - dt.timedelta(days=365 * years + 7)).isoformat()
    out, cur = [], None
    for p in prices:
        if p[0] < start:
            continue
        y, w, _ = dt.date.fromisoformat(p[0]).isocalendar()
        if (y, w) != cur:
            out.append([p[0], p[4]])
            cur = (y, w)
        else:
            out[-1] = [p[0], p[4]]
    return out


def main():
    out = pathlib.Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    watch = json.loads((BASE / "watchlist.json").read_text(encoding="utf-8"))
    items, benches = [], []
    for i, w in enumerate([{"code": "N225", "name": "日経平均株価", "bench": True}] + watch):
        rnd = random.Random(i)
        start = 38000 if w.get("bench") else rnd.choice([800, 1500, 2500, 4000, 7000])
        prices = walk(i, start, 2450)
        last = prices[-1][4]
        divs = [] if w.get("bench") else [[p[0], round(last * 0.012, 1)] for p in prices[::125]]
        info = {} if w.get("bench") else {
            "longName": w["name"] + " (sample)", "sector": "Industrials", "industry": "Sample Industry",
            "website": "https://example.com", "fullTimeEmployees": 12345,
            "longBusinessSummary": "This is sample data for layout testing.",
            "marketCap": int(last * 1.2e9), "trailingPE": round(rnd.uniform(8, 30), 2), "forwardPE": round(rnd.uniform(8, 28), 2),
            "priceToBook": round(rnd.uniform(0.6, 4), 2), "trailingEps": round(last / 15, 2), "bookValue": round(last / 1.4, 2),
            "returnOnEquity": round(rnd.uniform(0.03, 0.2), 4), "returnOnAssets": round(rnd.uniform(0.01, 0.08), 4),
            "operatingMargins": round(rnd.uniform(0.03, 0.2), 4), "profitMargins": round(rnd.uniform(0.02, 0.12), 4),
            "dividendRate": round(last * 0.024, 1), "payoutRatio": round(rnd.uniform(0.2, 0.6), 4), "beta": round(rnd.uniform(0.5, 1.4), 2),
            "fiftyTwoWeekHigh": max(p[2] for p in prices[-250:]), "fiftyTwoWeekLow": min(p[3] for p in prices[-250:]),
            "targetMeanPrice": round(last * 1.1), "recommendationKey": "buy", "numberOfAnalystOpinions": 12,
            "exDividendDate": "2027-03-30",
        }
        fin = [] if w.get("bench") else [
            {"date": f"{y}-03-31", "revenue": 1e12 * (1 + 0.06 * k), "operatingIncome": 1e11 * (1 + 0.1 * k),
             "netIncome": 6e10 * (1 + 0.08 * k), "eps": round(last / 16 * (1 + 0.08 * k), 1), "equityRatio": 0.4}
            for k, y in enumerate(range(2022, 2026))]
        code = w["code"]
        doc = {"code": code, "symbol": code if w.get("bench") else f"{code}.T", "name": w["name"],
               "updated": dt.datetime.now().isoformat(timespec="minutes"), "info": info,
               "calendar": {"earningsDate": "2027-02-06"}, "financials": fin,
               "prices": prices, "dividends": divs, "splits": []}
        (out / f"{code}.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        closes = [p[4] for p in prices]
        s = {"code": code, "symbol": doc["symbol"], "name": w["name"], "date": prices[-1][0], "close": last,
             "prev": closes[-2], "change": round(last - closes[-2], 1), "changePct": round((last / closes[-2] - 1) * 100, 2),
             "ret1y": round((last / closes[-250] - 1) * 100, 2), "spark": closes[-60:], "weekly": weekly_closes(prices),
             "per": info.get("trailingPE"), "fper": info.get("forwardPE"), "pbr": info.get("priceToBook"), "roe": info.get("returnOnEquity"),
             "divRate": info.get("dividendRate"), "divYield": round(info["dividendRate"] / last * 100, 2) if info else None,
             "marketCap": info.get("marketCap"), "sector": info.get("sector")}
        (benches if w.get("bench") else items).append(s)
    (out / "index.json").write_text(json.dumps({"updated": dt.datetime.now().isoformat(timespec="minutes"),
                                                "benchmarks": benches, "items": items, "errors": [], "sample": True},
                                               ensure_ascii=False), encoding="utf-8")
    jpx = [[w["code"], w["name"], "プライム", "サンプル"] for w in watch] + [["1301", "極洋", "プライム", "水産・農林業"], ["7974", "任天堂", "プライム", "その他製品"]]
    (out / "jpx-list.json").write_text(json.dumps({"updated": "2026-01-01T00:00", "rows": jpx}, ensure_ascii=False), encoding="utf-8")
    print("sample written to", out)


if __name__ == "__main__":
    main()
