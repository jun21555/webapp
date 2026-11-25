#!/usr/bin/env python3
"""株ノート: watchlist.json の銘柄の株価・指標・業績を Yahoo Finance (yfinance) から取得して data/ に保存する。

GitHub Actions から毎日実行される。ローカルでも `pip install yfinance pandas` のあと
`python app06/kabu-note/tools/fetch_data.py` で動く。
取得に失敗した銘柄は前回のファイルをそのまま残す。
"""
import datetime as dt
import json
import math
import pathlib
import sys
import time

import yfinance as yf

BASE = pathlib.Path(__file__).resolve().parent.parent
DATA = BASE / "data"
JST = dt.timezone(dt.timedelta(hours=9))
BENCHMARKS = [{"code": "N225", "symbol": "^N225", "name": "日経平均株価"}]
HISTORY_PERIOD = "10y"

INFO_KEYS = [
    "longName", "shortName", "sector", "industry", "website", "fullTimeEmployees", "longBusinessSummary",
    "city", "marketCap", "enterpriseValue", "sharesOutstanding", "floatShares",
    "trailingPE", "forwardPE", "priceToBook", "priceToSalesTrailing12Months", "enterpriseToEbitda",
    "trailingEps", "forwardEps", "bookValue", "returnOnEquity", "returnOnAssets",
    "profitMargins", "operatingMargins", "grossMargins", "revenueGrowth", "earningsGrowth",
    "dividendRate", "trailingAnnualDividendRate", "payoutRatio", "fiveYearAvgDividendYield",
    "exDividendDate", "beta", "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "averageVolume",
    "totalRevenue", "totalCash", "totalDebt", "debtToEquity", "currentRatio", "freeCashflow",
    "targetMeanPrice", "targetHighPrice", "targetLowPrice", "recommendationKey", "numberOfAnalystOpinions",
    "earningsTimestamp", "heldPercentInsiders", "heldPercentInstitutions",
]


def clean(v):
    """JSON に書ける値にする（NaN/inf → None、numpy 型 → Python 型）"""
    if v is None:
        return None
    if hasattr(v, "item"):
        try:
            v = v.item()
        except Exception:
            pass
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return round(v, 6)
    if isinstance(v, (int, str, bool)):
        return v
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()[:10]
    return str(v)


def num(v, nd=2):
    v = clean(v)
    if isinstance(v, (int, float)):
        return round(float(v), nd)
    return None


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def jpx_names():
    rows = load_json(DATA / "jpx-list.json", {}).get("rows", [])
    return {r[0]: r for r in rows}


def fetch_history(t):
    h = t.history(period=HISTORY_PERIOD, interval="1d", auto_adjust=False, actions=True)
    if h is None or h.empty:
        raise RuntimeError("株価データが空です")
    prices, dividends, splits = [], [], []
    for idx, r in h.iterrows():
        d = idx.strftime("%Y-%m-%d")
        o, hi, lo, c = (num(r.get(k)) for k in ("Open", "High", "Low", "Close"))
        if c is None:
            continue
        v = clean(r.get("Volume")) or 0
        prices.append([d, o if o is not None else c, hi if hi is not None else c, lo if lo is not None else c, c, int(v)])
        dv = num(r.get("Dividends"), 4)
        if dv:
            dividends.append([d, dv])
        sp = num(r.get("Stock Splits"), 4)
        if sp:
            splits.append([d, sp])
    return prices, dividends, splits


def pick_row(df, names):
    for n in names:
        if n in df.index:
            return df.loc[n]
    return None


def fetch_financials(t):
    """年次の売上・営業利益・純利益・EPS・自己資本比率（取れる範囲で）"""
    out = []
    try:
        inc = t.income_stmt
    except Exception:
        inc = None
    try:
        bs = t.balance_sheet
    except Exception:
        bs = None
    if inc is None or inc.empty:
        return out
    rev = pick_row(inc, ["Total Revenue", "Operating Revenue"])
    op = pick_row(inc, ["Operating Income", "Total Operating Income As Reported"])
    ni = pick_row(inc, ["Net Income Common Stockholders", "Net Income"])
    eps = pick_row(inc, ["Diluted EPS", "Basic EPS"])
    eq = pick_row(bs, ["Stockholders Equity", "Common Stock Equity"]) if bs is not None and not bs.empty else None
    ta = pick_row(bs, ["Total Assets"]) if bs is not None and not bs.empty else None
    for col in sorted(inc.columns):
        def g(row):
            if row is None:
                return None
            try:
                return num(row.get(col), 2)
            except Exception:
                return None
        e, a = g(eq), g(ta)
        out.append({
            "date": col.strftime("%Y-%m-%d"),
            "revenue": g(rev), "operatingIncome": g(op), "netIncome": g(ni), "eps": g(eps),
            "equityRatio": round(e / a, 4) if e and a else None,
        })
    return [r for r in out if any(r[k] is not None for k in ("revenue", "operatingIncome", "netIncome"))]


def fetch_calendar(t):
    try:
        cal = t.calendar or {}
    except Exception:
        return {}
    out = {}
    ed = cal.get("Earnings Date")
    if isinstance(ed, (list, tuple)) and ed:
        out["earningsDate"] = clean(ed[0])
    elif ed:
        out["earningsDate"] = clean(ed)
    for k, name in (("Ex-Dividend Date", "exDividendDate"), ("Dividend Date", "dividendDate")):
        if cal.get(k):
            out[name] = clean(cal.get(k))
    return out


def weekly_closes(prices, years=5):
    """週ごとの最後の終値（比較チャート用、直近 years 年）"""
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


def summarize(entry, prices, dividends, info):
    closes = [p[4] for p in prices]
    last = closes[-1]
    prev = closes[-2] if len(closes) > 1 else last
    last_date = dt.date.fromisoformat(prices[-1][0])
    one_year_ago = (last_date - dt.timedelta(days=365)).isoformat()
    div12 = sum(d[1] for d in dividends if d[0] > one_year_ago)
    rate = info.get("dividendRate") or info.get("trailingAnnualDividendRate") or (div12 or None)
    base_1y = next((p[4] for p in prices if p[0] >= one_year_ago), closes[0])
    return {
        "code": entry["code"], "symbol": entry["symbol"], "name": entry["name"],
        "date": prices[-1][0], "close": last, "prev": prev,
        "change": round(last - prev, 2), "changePct": round((last / prev - 1) * 100, 2) if prev else None,
        "ret1y": round((last / base_1y - 1) * 100, 2) if base_1y else None,
        "spark": closes[-60:], "weekly": weekly_closes(prices),
        "per": num(info.get("trailingPE")), "fper": num(info.get("forwardPE")), "pbr": num(info.get("priceToBook")),
        "roe": num(info.get("returnOnEquity"), 4),
        "divRate": num(rate), "divYield": round(rate / last * 100, 2) if rate and last else None,
        "marketCap": clean(info.get("marketCap")), "sector": info.get("sector"),
    }


def fetch_one(entry, retries=3):
    t = yf.Ticker(entry["symbol"])
    last_err = None
    for i in range(retries):
        try:
            prices, dividends, splits = fetch_history(t)
            break
        except Exception as e:  # レート制限などは少し待って再試行
            last_err = e
            time.sleep(5 * (i + 1))
    else:
        raise RuntimeError(f"株価の取得に失敗: {last_err}")
    info = {}
    try:
        raw = t.info or {}
        info = {k: clean(raw.get(k)) for k in INFO_KEYS if raw.get(k) is not None}
    except Exception as e:
        print(f"  info 取得失敗: {e}", file=sys.stderr)
    for k in ("exDividendDate", "earningsTimestamp"):
        if isinstance(info.get(k), int):
            info[k] = dt.datetime.fromtimestamp(info[k], JST).strftime("%Y-%m-%d")
    doc = {
        "code": entry["code"], "symbol": entry["symbol"], "name": entry["name"],
        "updated": dt.datetime.now(JST).isoformat(timespec="minutes"),
        "info": info, "calendar": fetch_calendar(t), "financials": fetch_financials(t),
        "prices": prices, "dividends": dividends, "splits": splits,
    }
    return doc, summarize(entry, prices, dividends, info)


def main():
    DATA.mkdir(exist_ok=True)
    watch = load_json(BASE / "watchlist.json", [])
    names = jpx_names()
    entries = []
    for w in watch:
        code = str(w["code"]).upper()
        jp = names.get(code)
        entries.append({"code": code, "symbol": w.get("symbol") or f"{code}.T",
                        "name": w.get("name") or (jp[1] if jp else code)})
    old_index = load_json(DATA / "index.json", {})
    old_items = {i["code"]: i for i in old_index.get("items", []) + old_index.get("benchmarks", [])}

    items, benches, errors = [], [], []
    for e in BENCHMARKS + entries:
        print(f"{e['code']} {e['name']} ...", flush=True)
        try:
            doc, summ = fetch_one(e)
            (DATA / f"{e['code']}.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        except Exception as ex:
            print(f"  失敗: {ex}", file=sys.stderr)
            errors.append({"code": e["code"], "error": str(ex)[:200]})
            summ = old_items.get(e["code"])  # 前回の値を残す
            if summ:
                summ = dict(summ, stale=True)
        if summ:
            (benches if e in BENCHMARKS else items).append(summ)
        time.sleep(1.2)

    # ウォッチから外れた銘柄のファイルを消す
    keep = {e["code"] for e in BENCHMARKS + entries} | {"index", "jpx-list"}
    for f in DATA.glob("*.json"):
        if f.stem not in keep:
            f.unlink()

    index = {"updated": dt.datetime.now(JST).isoformat(timespec="minutes"),
             "benchmarks": benches, "items": items, "errors": errors}
    (DATA / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"完了: {len(items)} 銘柄, 失敗 {len(errors)}")
    if entries and not items:
        sys.exit(1)


if __name__ == "__main__":
    main()
