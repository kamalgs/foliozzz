#!/usr/bin/env python3
"""
Incrementally update stock price and benchmark parquet files.

For each existing file, fetches new trading days from (last_date + 1) to today
using yfinance and appends them. New symbols found in isin_map.json are
downloaded from scratch (5 years of history).

Usage:
  python3 update_prices.py            # update all
  python3 update_prices.py --stocks   # stocks only
  python3 update_prices.py --benchmarks  # benchmarks only
"""

import json
import logging
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import yfinance as yf

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

DATA_DIR = Path("/opt/nomad/volumes/foliozzz_data/data")
STOCK_DIR = DATA_DIR / "stock_prices"
ISIN_MAP = DATA_DIR / "isin_map.json"

BENCHMARKS = {
    "nifty50":       "^NSEI",
    "bank_nifty":    "^NSEBANK",
    "sensex":        "^BSESN",
    "nifty_midcap":  "^NSMIDCP",
    "bse_500":       "BSE-500.BO",
}

HISTORY_YEARS = 5
RATE_LIMIT_SLEEP = 0.4  # seconds between yfinance calls


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


def fetch(ticker_symbol: str, start: date, end: date) -> pd.DataFrame | None:
    """
    Download OHLCV data from yfinance for [start, end] inclusive.
    Returns a cleaned DataFrame or None on failure / empty result.
    """
    try:
        raw = yf.download(
            ticker_symbol,
            start=start.isoformat(),
            end=(end + timedelta(days=1)).isoformat(),  # yfinance end is exclusive
            progress=False,
            auto_adjust=True,
        )
    except Exception as e:
        log.error("yfinance error for %s: %s", ticker_symbol, e)
        return None

    if raw is None or raw.empty:
        log.warning("No data returned for %s (%s–%s)", ticker_symbol, start, end)
        return None

    # reset_index first so Date index becomes a column, then flatten any MultiIndex
    raw = raw.reset_index()
    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = [col[0].lower() for col in raw.columns]
    else:
        raw.columns = [c.lower() for c in raw.columns]

    # Ensure required columns
    for col in ("open", "high", "low", "close", "volume"):
        if col not in raw.columns:
            log.warning("Missing column '%s' for %s", col, ticker_symbol)
            return None

    df = raw[["date", "open", "high", "low", "close", "volume"]].copy()
    df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None)
    df["volume"] = df["volume"].fillna(0).astype("int64")
    df = df.dropna(subset=["close"])
    return df if not df.empty else None


def write_parquet(df: pd.DataFrame, path: Path, symbol: str) -> None:
    """Write / overwrite a parquet file with the given DataFrame."""
    df = df.copy()
    df["symbol"] = symbol
    df = df.sort_values("date").drop_duplicates(subset=["date"]).reset_index(drop=True)
    schema = pa.schema([
        pa.field("date",   pa.timestamp("us")),
        pa.field("open",   pa.float64()),
        pa.field("high",   pa.float64()),
        pa.field("low",    pa.float64()),
        pa.field("close",  pa.float64()),
        pa.field("volume", pa.int64()),
        pa.field("symbol", pa.string()),
    ])
    table = pa.Table.from_pandas(df[["date", "open", "high", "low", "close", "volume", "symbol"]], schema=schema)
    pq.write_table(table, path, compression="snappy")
    log.info("Wrote %d rows to %s (last: %s)", len(df), path.name, df["date"].max().date())


def update_file(path: Path, ticker_symbol: str, display_name: str) -> bool:
    """
    Append new rows to an existing parquet file, or download full history if absent.
    Returns True on success.
    """
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

    new_df = fetch(ticker_symbol, start, today)
    if new_df is None:
        if existing_df is not None:
            log.warning("%-20s no new rows — keeping existing data", display_name)
            return True
        return False

    if existing_df is not None:
        combined = pd.concat([existing_df, new_df], ignore_index=True)
    else:
        combined = new_df

    write_parquet(combined, path, display_name)
    return True


def update_stocks() -> None:
    if not ISIN_MAP.exists():
        log.error("isin_map.json not found at %s", ISIN_MAP)
        return

    isin_map: dict[str, str] = json.loads(ISIN_MAP.read_text())
    symbols = sorted(set(isin_map.values()))
    log.info("Updating %d stock files", len(symbols))

    ok = fail = 0
    for symbol in symbols:
        path = STOCK_DIR / f"{symbol}.parquet"
        success = update_file(path, f"{symbol}.NS", symbol)
        if success:
            ok += 1
        else:
            fail += 1
        time.sleep(RATE_LIMIT_SLEEP)

    log.info("Stocks: %d updated, %d failed", ok, fail)


def update_benchmarks() -> None:
    log.info("Updating %d benchmark files", len(BENCHMARKS))
    ok = fail = 0
    for name, ticker_symbol in BENCHMARKS.items():
        path = DATA_DIR / f"{name}.parquet"
        success = update_file(path, ticker_symbol, name)
        if success:
            ok += 1
        else:
            fail += 1
        time.sleep(RATE_LIMIT_SLEEP)
    log.info("Benchmarks: %d updated, %d failed", ok, fail)


if __name__ == "__main__":
    args = set(sys.argv[1:])
    run_stocks     = "--stocks"     in args or not args
    run_benchmarks = "--benchmarks" in args or not args

    if run_stocks:
        update_stocks()
    if run_benchmarks:
        update_benchmarks()

    log.info("Done.")
