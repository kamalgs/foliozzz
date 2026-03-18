#!/usr/bin/env python3
"""
Incrementally update stock price and benchmark parquet files.

Stocks: fetched from NSE Bhavcopy (one ZIP per trading day, all symbols).
Benchmarks: fetched from yfinance (unchanged).

Usage:
  python3 update_prices.py                      # update all
  python3 update_prices.py --stocks             # stocks only
  python3 update_prices.py --benchmarks         # benchmarks only
  python3 update_prices.py --stocks --from 2025-01-01
"""

import argparse
import io
import json
import logging
import time
import zipfile
from datetime import date, timedelta
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

DATA_DIR  = Path("/opt/nomad/volumes/foliozzz_data/data")
STOCK_DIR = DATA_DIR / "stock_prices"
ISIN_MAP  = DATA_DIR / "isin_map.json"

BHAVCOPY_RATE_LIMIT = 1.0  # seconds between requests

BENCHMARKS = {
    "nifty50":      "^NSEI",
    "bank_nifty":   "^NSEBANK",
    "sensex":       "^BSESN",
    "nifty_midcap": "^NSMIDCP",
    "bse_500":      "BSE-500.BO",
}

HISTORY_YEARS = 5
RATE_LIMIT_SLEEP = 0.4  # seconds between yfinance calls

BHAVCOPY_HEADERS = {
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


def write_parquet(df: pd.DataFrame, path: Path, symbol: str) -> None:
    """Write / overwrite a parquet file with the given DataFrame."""
    df = df.copy()
    df["symbol"] = symbol
    df = df.sort_values("date").drop_duplicates(subset=["date"]).reset_index(drop=True)
    table = pa.Table.from_pandas(
        df[["date", "open", "high", "low", "close", "volume", "symbol"]],
        schema=PARQUET_SCHEMA,
    )
    pq.write_table(table, path, compression="snappy")
    log.info("Wrote %d rows to %s (last: %s)", len(df), path.name, df["date"].max().date())


# ---------------------------------------------------------------------------
# NSE Bhavcopy (stocks)
# ---------------------------------------------------------------------------

def download_bhavcopy(d: date) -> pd.DataFrame | None:
    """
    Download the NSE CM Bhavcopy ZIP for a given date and return a cleaned
    DataFrame of EQ-series rows, or None if unavailable (holiday / bad ZIP).
    """
    date_str = d.strftime("%d-%b-%Y")        # e.g. "04-Mar-2026"
    inner_csv = f"pd{d.strftime('%d%m%Y')}.csv"  # e.g. "pd04032026.csv"

    url = (
        "https://www.nseindia.com/api/reports"
        "?archives=%5B%7B%22name%22%3A%22CM%20-%20Bhavcopy%20(PR.zip)%22"
        "%2C%22type%22%3A%22archives%22%2C%22category%22%3A%22capital-market%22"
        "%2C%22section%22%3A%22equities%22%7D%5D"
        f"&date={date_str}&type=equities&mode=single"
    )

    try:
        resp = requests.get(url, headers=BHAVCOPY_HEADERS, timeout=30)
    except Exception as e:
        log.info("Bhavcopy request error for %s: %s", d, e)
        return None

    if resp.status_code != 200:
        log.info("Bhavcopy HTTP %d for %s (holiday/weekend?)", resp.status_code, d)
        return None

    try:
        zf = zipfile.ZipFile(io.BytesIO(resp.content))
    except zipfile.BadZipFile:
        log.info("Bhavcopy bad ZIP for %s (holiday/weekend?)", d)
        return None

    # Find the inner CSV — filename format varies by year:
    #   2026+: pd17032026.csv  (4-digit year, lowercase)
    #   2025:  Pd020125.csv    (2-digit year, mixed case)
    # Match any file whose basename starts with "pd" (case-insensitive).
    names = zf.namelist()
    csv_name = next(
        (n for n in names if n.lower().split("/")[-1].startswith("pd") and n.lower().endswith(".csv")),
        None,
    )
    if csv_name is None:
        log.warning("No CSV found in Bhavcopy ZIP for %s: %s", d, names)
        return None

    df = pd.read_csv(io.BytesIO(zf.read(csv_name)))

    # Strip quotes and whitespace from column names (NSE wraps them in single quotes)
    df.columns = [c.strip().strip("'") for c in df.columns]

    # Strip whitespace from all string columns
    for col in df.select_dtypes(include="str").columns:
        df[col] = df[col].str.strip()

    # Filter EQ series only
    df = df[df["SERIES"] == "EQ"].copy()
    if df.empty:
        return None

    df = df.rename(columns={
        "SYMBOL":      "symbol",
        "OPEN_PRICE":  "open",
        "HIGH_PRICE":  "high",
        "LOW_PRICE":   "low",
        "CLOSE_PRICE": "close",
        "NET_TRDQTY":  "volume",
    })

    return df[["symbol", "open", "high", "low", "close", "volume"]].copy()


def determine_date_range(symbols: list[str], start_override: date | None = None) -> tuple[date, date] | None:
    """
    Return (start_date, end_date) for the bhavcopy download loop, or None if
    nothing to do.
    """
    today = date.today()

    if start_override is not None:
        start = start_override
    else:
        last_dates = []
        for sym in symbols:
            path = STOCK_DIR / f"{sym}.parquet"
            ld = last_date_in(path)
            last_dates.append(ld if ld is not None else today - timedelta(days=365))
        start = min(last_dates) + timedelta(days=1)

    end = today

    if start > end:
        log.info("All symbols are up to date.")
        return None

    return start, end


def collect_new_rows(
    symbols: list[str], start_date: date, end_date: date
) -> dict[str, list[dict]]:
    """
    Walk each calendar day in [start_date, end_date], download the Bhavcopy,
    and accumulate per-symbol OHLCV rows.
    """
    symbol_set = set(symbols)
    new_rows: dict[str, list[dict]] = {sym: [] for sym in symbols}

    d = start_date
    while d <= end_date:
        if d.weekday() >= 5:  # Saturday=5, Sunday=6
            d += timedelta(days=1)
            continue

        df = download_bhavcopy(d)
        if df is not None:
            day_syms = set(df["symbol"]) & symbol_set
            log.info("Bhavcopy %s: %d of our symbols present", d, len(day_syms))
            for _, row in df[df["symbol"].isin(symbol_set)].iterrows():
                sym = row["symbol"]
                new_rows[sym].append({
                    "date":   pd.Timestamp(d),
                    "open":   float(row["open"]),
                    "high":   float(row["high"]),
                    "low":    float(row["low"]),
                    "close":  float(row["close"]),
                    "volume": int(row["volume"]),
                    "symbol": sym,
                })

        time.sleep(BHAVCOPY_RATE_LIMIT)
        d += timedelta(days=1)

    return new_rows


def write_symbol_parquets(symbols: list[str], new_rows_by_symbol: dict[str, list[dict]]) -> None:
    """Merge new rows into existing parquets and write."""
    STOCK_DIR.mkdir(parents=True, exist_ok=True)

    for sym in symbols:
        rows = new_rows_by_symbol.get(sym, [])
        path = STOCK_DIR / f"{sym}.parquet"

        if not rows:
            log.info("%-20s no new rows", sym)
            continue

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


def update_stocks(start_date_override: date | None = None) -> None:
    if not ISIN_MAP.exists():
        log.error("isin_map.json not found at %s", ISIN_MAP)
        return

    isin_map: dict[str, str] = json.loads(ISIN_MAP.read_text())
    symbols = sorted(set(isin_map.values()))
    log.info("Updating %d stock files via NSE Bhavcopy", len(symbols))

    result = determine_date_range(symbols, start_override=start_date_override)
    if result is None:
        return
    start_date, end_date = result

    log.info("Date range: %s → %s", start_date, end_date)
    new_rows = collect_new_rows(symbols, start_date, end_date)
    write_symbol_parquets(symbols, new_rows)
    log.info("Stocks update complete.")


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
        time.sleep(RATE_LIMIT_SLEEP)
    log.info("Benchmarks: %d updated, %d failed", ok, fail)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Update stock price parquets.")
    parser.add_argument("--stocks",     action="store_true", help="Update stock parquets via NSE Bhavcopy")
    parser.add_argument("--benchmarks", action="store_true", help="Update benchmark parquets via yfinance")
    parser.add_argument("--from",       dest="from_date", metavar="YYYY-MM-DD",
                        help="Override start date for stock downloads")
    args = parser.parse_args()

    run_stocks     = args.stocks     or (not args.stocks and not args.benchmarks)
    run_benchmarks = args.benchmarks or (not args.stocks and not args.benchmarks)

    start_override = None
    if args.from_date:
        start_override = date.fromisoformat(args.from_date)

    if run_stocks:
        update_stocks(start_date_override=start_override)
    if run_benchmarks:
        update_benchmarks()

    log.info("Done.")
