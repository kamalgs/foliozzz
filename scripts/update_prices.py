#!/usr/bin/env python3
"""
Incrementally update stock price and benchmark parquet files.

Stocks: fetched from NSE Bhavcopy (one ZIP per trading day, all EQ symbols).
        Raw ZIPs are cached in DATA_DIR/bhavcopy_zips/ for future processing.
Benchmarks: fetched from yfinance (unchanged).
Symbol/ISIN: fetched from NSE EQUITY_L.csv master file.

Usage:
  python3 update_prices.py                          # update all
  python3 update_prices.py --stocks                 # all stocks via Bhavcopy
  python3 update_prices.py --benchmarks             # benchmarks via yfinance
  python3 update_prices.py --symbol-isin            # symbol/ISIN lookup parquet
  python3 update_prices.py --stocks --from 2025-01-01
"""

import argparse
import io
import logging
import re
import time
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import requests
import yfinance as yf

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

DATA_DIR          = Path("/opt/nomad/volumes/foliozzz_data/data")
STOCK_DIR         = DATA_DIR / "stock_prices"
BHAVCOPY_DIR      = DATA_DIR / "bhavcopy_zips"
CORP_ACTIONS_PATH = DATA_DIR / "corporate_actions.parquet"

BHAVCOPY_RATE_LIMIT = 1.0  # seconds between HTTP requests (skipped for cache hits)

BENCHMARKS = {
    "nifty50":      "^NSEI",
    "bank_nifty":   "^NSEBANK",
    "sensex":       "^BSESN",
    "nifty_midcap": "^NSMIDCP",
    "bse_500":      "BSE-500.BO",
}

HISTORY_YEARS = 5
YFINANCE_RATE_LIMIT = 0.4  # seconds between yfinance calls

NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0"
}

PARQUET_SCHEMA = pa.schema([
    pa.field("date",   pa.timestamp("us")),
    pa.field("open",   pa.float64()),
    pa.field("high",   pa.float64()),
    pa.field("low",    pa.float64()),
    pa.field("close",  pa.float64()),
    pa.field("volume", pa.int64()),
    pa.field("symbol", pa.string()),
])

SYMBOL_ISIN_SCHEMA = pa.schema([
    pa.field("symbol", pa.string()),
    pa.field("isin",   pa.string()),
    pa.field("name",   pa.string()),
    pa.field("series", pa.string()),
])

CA_SCHEMA = pa.schema([
    pa.field("isin",        pa.string()),
    pa.field("symbol",      pa.string()),
    pa.field("ex_date",     pa.timestamp("us")),
    pa.field("action_type", pa.string()),
    pa.field("ratio",       pa.float64()),
    pa.field("subject",     pa.string()),
])


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def last_date_in(path: Path) -> date | None:
    """Return the most recent date in a parquet file, or None if unreadable."""
    try:
        table = pq.read_table(path, columns=["date"])
        series = table.column("date").to_pandas()
        if series.empty:
            return None
        return pd.to_datetime(series.max()).date()
    except Exception as e:
        log.warning("Could not read %s: %s", path.name, e)
        return None


def _strip_cols(df: pd.DataFrame) -> pd.DataFrame:
    """Strip quotes/whitespace from column names and string cell values."""
    df.columns = [c.strip().strip("'") for c in df.columns]
    for col in df.columns:
        if df[col].dtype == object:
            df[col] = df[col].str.strip()
    return df


def write_parquet(df: pd.DataFrame, path: Path, symbol: str) -> None:
    """Write / overwrite a parquet file with the given DataFrame.

    Writes to a sibling .tmp file first, then renames atomically so readers
    never see a partially-written file.
    """
    df = df.copy()
    df["symbol"] = symbol
    df = df.sort_values("date").drop_duplicates(subset=["date"]).reset_index(drop=True)
    table = pa.Table.from_pandas(
        df[["date", "open", "high", "low", "close", "volume", "symbol"]],
        schema=PARQUET_SCHEMA,
    )
    tmp = path.with_suffix(".tmp")
    pq.write_table(table, tmp, compression="snappy")
    tmp.rename(path)
    log.info("Wrote %d rows to %s (last: %s)", len(df), path.name, df["date"].max().date())


# ---------------------------------------------------------------------------
# NSE Bhavcopy (stocks)
# ---------------------------------------------------------------------------

def download_bhavcopy(d: date) -> tuple[pd.DataFrame | None, bool]:
    """
    Return (dataframe_of_EQ_rows_or_None, fetched_from_network).

    The raw ZIP is cached at BHAVCOPY_DIR/{d.isoformat()}.zip.
    If the cache exists it is used directly (no HTTP request, no sleep needed).
    """
    BHAVCOPY_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = BHAVCOPY_DIR / f"{d.isoformat()}.zip"

    if zip_path.exists():
        raw = zip_path.read_bytes()
        fetched = False
    else:
        date_str = d.strftime("%d-%b-%Y")
        url = (
            "https://www.nseindia.com/api/reports"
            "?archives=%5B%7B%22name%22%3A%22CM%20-%20Bhavcopy%20(PR.zip)%22"
            "%2C%22type%22%3A%22archives%22%2C%22category%22%3A%22capital-market%22"
            "%2C%22section%22%3A%22equities%22%7D%5D"
            f"&date={date_str}&type=equities&mode=single"
        )
        try:
            resp = requests.get(url, headers=NSE_HEADERS, timeout=30)
        except Exception as e:
            log.info("Bhavcopy request error for %s: %s", d, e)
            return None, True

        if resp.status_code != 200:
            log.info("Bhavcopy HTTP %d for %s (holiday/weekend?)", resp.status_code, d)
            return None, True

        raw = resp.content
        zip_path.write_bytes(raw)
        fetched = True

    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        if zip_path.exists():
            zip_path.unlink()  # evict corrupt cache entry
        log.info("Bhavcopy bad ZIP for %s (holiday/weekend?)", d)
        return None, fetched

    # Filename format varies: 2026+ pd17032026.csv, 2025 Pd020125.csv
    names = zf.namelist()
    csv_name = next(
        (n for n in names if n.lower().split("/")[-1].startswith("pd") and n.lower().endswith(".csv")),
        None,
    )
    if csv_name is None:
        log.warning("No pd*.csv in Bhavcopy ZIP for %s: %s", d, names)
        return None, fetched

    df = _strip_cols(pd.read_csv(io.BytesIO(zf.read(csv_name)), encoding="latin-1"))

    df = df[df["SERIES"] == "EQ"].copy()
    if df.empty:
        return None, fetched

    df = df.rename(columns={
        "SYMBOL":      "symbol",
        "OPEN_PRICE":  "open",
        "HIGH_PRICE":  "high",
        "LOW_PRICE":   "low",
        "CLOSE_PRICE": "close",
        "NET_TRDQTY":  "volume",
    })

    df = df[["symbol", "open", "high", "low", "close", "volume"]].copy()

    # Coerce numeric columns — some rows have blank values (index/header rows)
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["close"])
    df["volume"] = df["volume"].fillna(0).astype("int64")

    return (df if not df.empty else None), fetched


def determine_date_range(start_override: date | None = None) -> tuple[date, date] | None:
    """
    Return (start_date, end_date) for the Bhavcopy download loop, or None if
    nothing to do. start_date is derived from the earliest last-date across all
    existing parquets in STOCK_DIR (falling back to 1 year ago if none exist).
    """
    today = date.today()

    if start_override is not None:
        start = start_override
    else:
        last_dates = [
            last_date_in(p)
            for p in STOCK_DIR.glob("*.parquet")
            if (ld := last_date_in(p)) is not None
        ]
        start = (min(last_dates) + timedelta(days=1)) if last_dates else (today - timedelta(days=365))

    if start > today:
        log.info("All stocks are up to date.")
        return None

    return start, today


def collect_new_rows(start_date: date, end_date: date) -> dict[str, list[dict]]:
    """
    Walk each calendar day in [start_date, end_date], download (or load cached)
    Bhavcopy, and accumulate OHLCV rows for every EQ symbol found.
    """
    new_rows: dict[str, list[dict]] = {}

    d = start_date
    while d <= end_date:
        if d.weekday() >= 5:  # skip weekends — no HTTP, no sleep
            d += timedelta(days=1)
            continue

        df, fetched = download_bhavcopy(d)
        if df is not None:
            log.info("Bhavcopy %s: %d EQ symbols", d, len(df))
            ts = pd.Timestamp(d)
            for _, row in df.iterrows():
                sym = row["symbol"]
                new_rows.setdefault(sym, []).append({
                    "date":   ts,
                    "open":   float(row["open"]),
                    "high":   float(row["high"]),
                    "low":    float(row["low"]),
                    "close":  float(row["close"]),
                    "volume": int(row["volume"]),
                    "symbol": sym,
                })

        if fetched:
            time.sleep(BHAVCOPY_RATE_LIMIT)

        d += timedelta(days=1)

    return new_rows


def write_symbol_parquets(new_rows_by_symbol: dict[str, list[dict]]) -> None:
    """Merge new rows into existing parquets (or create new ones) and write."""
    STOCK_DIR.mkdir(parents=True, exist_ok=True)
    written = skipped = 0

    for sym, rows in new_rows_by_symbol.items():
        if not rows:
            skipped += 1
            continue

        path = STOCK_DIR / f"{sym}.parquet"
        new_df = pd.DataFrame(rows)

        if path.exists():
            try:
                existing = pq.read_table(path).to_pandas()
                existing["date"] = pd.to_datetime(existing["date"]).dt.tz_localize(None)
                combined = pd.concat([existing, new_df], ignore_index=True)
            except Exception as e:
                log.warning("Could not load %s (%s) — using new rows only", path.name, e)
                combined = new_df
        else:
            combined = new_df

        write_parquet(combined, path, sym)
        written += 1

    log.info("Parquets: %d written, %d had no new rows", written, skipped)


def update_stocks(start_date_override: date | None = None) -> None:
    result = determine_date_range(start_override=start_date_override)
    if result is None:
        return
    start_date, end_date = result

    log.info("Updating all NSE EQ stocks via Bhavcopy: %s → %s", start_date, end_date)
    new_rows = collect_new_rows(start_date, end_date)
    log.info("Symbols seen across date range: %d", len(new_rows))
    write_symbol_parquets(new_rows)
    log.info("Stocks update complete.")


# ---------------------------------------------------------------------------
# Symbol / ISIN lookup parquet
# ---------------------------------------------------------------------------

def update_symbol_isin() -> None:
    """
    Download NSE's EQUITY_L.csv master and write symbol_isin.parquet with
    columns: symbol, isin, name, series.
    """
    url = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"
    try:
        resp = requests.get(url, headers=NSE_HEADERS, timeout=30)
    except Exception as e:
        log.error("Could not download EQUITY_L.csv: %s", e)
        return

    if resp.status_code != 200:
        log.error("EQUITY_L.csv HTTP %d", resp.status_code)
        return

    df = _strip_cols(pd.read_csv(io.BytesIO(resp.content)))
    df = df.rename(columns={
        "SYMBOL":          "symbol",
        "NAME OF COMPANY": "name",
        "ISIN NUMBER":     "isin",
        "SERIES":          "series",
    })
    df = df[["symbol", "isin", "name", "series"]].copy()

    path = DATA_DIR / "symbol_isin.parquet"
    table = pa.Table.from_pandas(df, schema=SYMBOL_ISIN_SCHEMA)
    pq.write_table(table, path, compression="snappy")
    log.info("Wrote %d rows to %s", len(df), path.name)


# ---------------------------------------------------------------------------
# Corporate actions
# ---------------------------------------------------------------------------

def parse_ratio(subject: str) -> tuple[str, float] | None:
    """
    Extract (action_type, ratio) from NSE's free-text subject field.

    Bonus N:M  → ratio = (N+M)/M  (e.g. 1:1 → 2.0, 1:2 → 1.5)
    Split X→Y  → ratio = X/Y      (e.g. Rs.10 to Rs.2 → 5.0)
    Returns None for rights issues, dividends, mergers, and unrecognised text.
    """
    s = subject.lower()

    bonus_match = re.search(r"bonus.*?(\d+)\s*:\s*(\d+)", s)
    if bonus_match:
        n, m = int(bonus_match.group(1)), int(bonus_match.group(2))
        return ("BONUS", (n + m) / m)

    split_match = re.search(r"(?:split|sub-?division).*?rs\.?\s*(\d+(?:\.\d+)?)\s+to\s+rs\.?\s*(\d+(?:\.\d+)?)", s)
    if split_match:
        old_fv, new_fv = float(split_match.group(1)), float(split_match.group(2))
        if new_fv > 0 and old_fv > new_fv:
            return ("SPLIT", old_fv / new_fv)

    return None


def fetch_nse_corp_actions(from_date: date, to_date: date) -> list[dict]:
    """
    Fetch corporate actions from NSE API for the given date range.
    NSE requires a session cookie; visit homepage first to obtain it.
    """
    session = requests.Session()
    session.headers.update(NSE_HEADERS)
    try:
        session.get("https://www.nseindia.com", timeout=15)
    except Exception as e:
        log.warning("Could not establish NSE session: %s", e)
        return []

    url = (
        "https://www.nseindia.com/api/corporates-corporateActions"
        "?index=equities"
        f"&from_date={from_date.strftime('%d-%m-%Y')}"
        f"&to_date={to_date.strftime('%d-%m-%Y')}"
    )
    try:
        resp = session.get(url, timeout=30)
    except Exception as e:
        log.warning("Corp actions request error %s–%s: %s", from_date, to_date, e)
        return []

    if resp.status_code != 200:
        log.warning("Corp actions HTTP %d for %s–%s", resp.status_code, from_date, to_date)
        return []

    try:
        data = resp.json()
        return data if isinstance(data, list) else []
    except Exception as e:
        log.warning("Corp actions JSON parse error: %s", e)
        return []


def update_corporate_actions() -> None:
    """
    Fetch NSE corporate actions (bonus + splits) and write corporate_actions.parquet.
    Requires symbol_isin.parquet to exist (run --symbol-isin first).
    """
    si_path = DATA_DIR / "symbol_isin.parquet"
    if not si_path.exists():
        log.error("symbol_isin.parquet not found — run --symbol-isin first")
        return

    si_table = pq.read_table(si_path, columns=["symbol", "isin"])
    symbol_to_isin: dict[str, str] = {
        row["symbol"]: row["isin"]
        for row in si_table.to_pylist()
    }

    known_symbols = {p.stem for p in STOCK_DIR.glob("*.parquet")}
    symbol_to_isin = {s: i for s, i in symbol_to_isin.items() if s in known_symbols}
    log.info("Corp actions: resolving for %d symbols with price data", len(symbol_to_isin))

    start = date(2000, 1, 1)
    today = date.today()
    all_rows: list[dict] = []

    chunk_start = start
    while chunk_start <= today:
        chunk_end = min(date(chunk_start.year, 12, 31), today)
        log.info("Fetching corp actions %s → %s", chunk_start, chunk_end)
        rows = fetch_nse_corp_actions(chunk_start, chunk_end)
        all_rows.extend(rows)
        chunk_start = date(chunk_start.year + 1, 1, 1)
        if chunk_start <= today:
            time.sleep(2)

    log.info("Fetched %d raw corp action rows", len(all_rows))

    records: list[dict] = []
    seen: set[tuple[str, str]] = set()

    for row in all_rows:
        if row.get("series") != "EQ":
            continue
        symbol = row.get("symbol", "").strip()
        isin = symbol_to_isin.get(symbol)
        if not isin:
            continue
        subject = row.get("subject", "").strip()
        parsed = parse_ratio(subject)
        if parsed is None:
            continue
        action_type, ratio = parsed
        ex_date_str = row.get("exDate", "").strip()
        try:
            ex_date = datetime.strptime(ex_date_str, "%d-%b-%Y")
        except ValueError:
            log.warning("Could not parse ex_date %r for %s", ex_date_str, symbol)
            continue

        key = (isin, ex_date.isoformat())
        if key in seen:
            continue
        seen.add(key)

        records.append({
            "isin":        isin,
            "symbol":      symbol,
            "ex_date":     ex_date,
            "action_type": action_type,
            "ratio":       ratio,
            "subject":     subject,
        })

    records.sort(key=lambda r: (r["isin"], r["ex_date"]))

    df = pd.DataFrame(records) if records else pd.DataFrame(
        columns=["isin", "symbol", "ex_date", "action_type", "ratio", "subject"]
    )

    table = pa.Table.from_pandas(df, schema=CA_SCHEMA)
    pq.write_table(table, CORP_ACTIONS_PATH, compression="snappy")
    log.info("Wrote %d corp action rows to %s", len(records), CORP_ACTIONS_PATH.name)


# ---------------------------------------------------------------------------
# Benchmarks (yfinance — unchanged)
# ---------------------------------------------------------------------------

def fetch_yfinance(ticker_symbol: str, start: date, end: date) -> pd.DataFrame | None:
    """Download OHLCV data from yfinance for [start, end] inclusive."""
    try:
        raw = yf.download(
            ticker_symbol,
            start=start.isoformat(),
            end=(end + timedelta(days=1)).isoformat(),
            progress=False,
            auto_adjust=True,
        )
    except Exception as e:
        log.error("yfinance error for %s: %s", ticker_symbol, e)
        return None

    if raw is None or raw.empty:
        log.warning("No data returned for %s (%s–%s)", ticker_symbol, start, end)
        return None

    raw = raw.reset_index()
    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = [col[0].lower() for col in raw.columns]
    else:
        raw.columns = [c.lower() for c in raw.columns]

    for col in ("open", "high", "low", "close", "volume"):
        if col not in raw.columns:
            log.warning("Missing column '%s' for %s", col, ticker_symbol)
            return None

    df = raw[["date", "open", "high", "low", "close", "volume"]].copy()
    df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None)
    df["volume"] = df["volume"].fillna(0).astype("int64")
    df = df.dropna(subset=["close"])
    return df if not df.empty else None


def update_file_yfinance(path: Path, ticker_symbol: str, display_name: str) -> bool:
    """Append new rows to a benchmark parquet, or download full history if absent."""
    today = date.today()

    if path.exists():
        last = last_date_in(path)
        if last is None:
            log.warning("Unreadable file %s — re-downloading", path.name)
            start = today - timedelta(days=HISTORY_YEARS * 365)
            existing_df = None
        elif last >= today:
            log.info("%-20s already up to date (%s)", display_name, last)
            return True
        else:
            start = last + timedelta(days=1)
            try:
                existing_df = pq.read_table(path).to_pandas()
                existing_df["date"] = pd.to_datetime(existing_df["date"]).dt.tz_localize(None)
            except Exception as e:
                log.warning("Could not load existing %s (%s) — re-downloading", path.name, e)
                start = today - timedelta(days=HISTORY_YEARS * 365)
                existing_df = None
    else:
        log.info("%-20s new file — downloading %d years of history", display_name, HISTORY_YEARS)
        start = today - timedelta(days=HISTORY_YEARS * 365)
        existing_df = None

    new_df = fetch_yfinance(ticker_symbol, start, today)
    if new_df is None:
        if existing_df is not None:
            log.warning("%-20s no new rows — keeping existing data", display_name)
            return True
        return False

    combined = pd.concat([existing_df, new_df], ignore_index=True) if existing_df is not None else new_df
    write_parquet(combined, path, display_name)
    return True


def update_benchmarks() -> None:
    log.info("Updating %d benchmark files", len(BENCHMARKS))
    ok = fail = 0
    for name, ticker_symbol in BENCHMARKS.items():
        path = DATA_DIR / f"{name}.parquet"
        success = update_file_yfinance(path, ticker_symbol, name)
        if success:
            ok += 1
        else:
            fail += 1
        time.sleep(YFINANCE_RATE_LIMIT)
    log.info("Benchmarks: %d updated, %d failed", ok, fail)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Update stock price parquets.")
    parser.add_argument("--stocks",       action="store_true", help="Update all EQ stock parquets via NSE Bhavcopy")
    parser.add_argument("--benchmarks",   action="store_true", help="Update benchmark parquets via yfinance")
    parser.add_argument("--symbol-isin",  action="store_true", help="Refresh symbol/ISIN lookup parquet")
    parser.add_argument("--corp-actions", action="store_true", help="Refresh corporate actions parquet (bonus/splits)")
    parser.add_argument("--from",         dest="from_date", metavar="YYYY-MM-DD",
                        help="Override start date for stock downloads")
    args = parser.parse_args()

    any_explicit = args.stocks or args.benchmarks or args.symbol_isin or args.corp_actions
    run_stocks        = args.stocks       or not any_explicit
    run_benchmarks    = args.benchmarks   or not any_explicit
    run_symbol_isin   = args.symbol_isin  or not any_explicit
    run_corp_actions  = args.corp_actions or not any_explicit

    start_override = date.fromisoformat(args.from_date) if args.from_date else None

    if run_symbol_isin:
        update_symbol_isin()
    if run_corp_actions:
        update_corporate_actions()
    if run_stocks:
        update_stocks(start_date_override=start_override)
    if run_benchmarks:
        update_benchmarks()

    log.info("Done.")
