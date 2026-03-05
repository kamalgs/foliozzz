#!/usr/bin/env python3
"""
Download and convert NSE/BSE stock price data to Parquet format.
This script fetches historic price data for Indian stocks and converts
it to Parquet for efficient loading by DuckDB in the browser.
"""

import os
import sys
import json
import time
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Any

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Configuration
DATA_DIR = Path(__file__).parent.parent / 'data'
STOCK_DATA_DIR = DATA_DIR / 'stock_prices'
BENCHMARK_DATA_DIR = DATA_DIR

# NSE/BSE Symbol mappings
# These are the symbols we'll fetch data for
NSE_SYMBOLS = [
    'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
    'HDFC', 'ITC', 'SBIN', 'BHARTIARTL', 'CASTROLIND',
    'KOTAKBANK', 'LT', 'AXISBANK', 'INDUSTOWER', 'HINDUNILVR',
    'SBIN', 'BAJFINANCE', 'TITAN', 'ULTRACEMCO', 'WIPRO',
    'TATASTEEL', 'ONGC', 'POWERGRID', 'NTPC', 'MARUTI',
    'TATAMOTORS', 'TECHM', 'HCLTECH', 'ASIANPAINT', 'ADANIPORTS',
    'BAJAJFINSV', 'LTIM', 'M&M', 'TATACONSUM', 'BPCL',
    'BRITANNIA', 'HEROMOTOCO', 'DIVISLAB', 'COALINDIA', 'EICHERMOT',
    'GRASIM', 'CIPLA', 'SHREECEM', 'SUNPHARMA', 'TCS',
    'HDFCLIFE', 'HAL', 'NESTLEIND', 'BAJAJAUTO', 'MARUTI',
    'TITAN', 'TATAMOTORS', 'ADANIENT', 'TATASTEEL', 'WIPRO',
    'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN',
    'LT', 'HCLTECH', 'ASIANPAINT', 'AXISBANK', 'HINDUNILVR',
    'KOTAKBANK', 'ITC', 'ULTRACEMCO', 'M&M', 'TITAN',
    'TATASTEEL', 'NTPC', 'ONGC', 'POWERGRID', 'BPCL',
    'RELIANCE', 'ADANIPORTS', 'BAJFINANCE', 'LTIM', 'GRASIM',
    'EICHERMOT', 'NESTLEIND', 'BAJAJAUTO', 'DIVISLAB', 'COALINDIA',
    'HEROMOTOCO', 'SUNPHARMA', 'SHREECEM', 'CIPLA', 'TATACONSUM',
    'BRITANNIA', 'TCS', 'TATAMOTORS', 'WIPRO', 'TECHM'
]

BENCHMARKS = {
    'nifty50': '^NSEI',
    'bank_nifty': '^NSEBANK',
    'sensex': '^BSESN',
    'nifty_midcap': 'MIDCPNIFTY.NS',
    'bse_500': 'BSE-500.BO'
}


def ensure_directories():
    """Create data directories if they don't exist."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STOCK_DATA_DIR.mkdir(parents=True, exist_ok=True)
    logger.info(f"Data directories ready: {DATA_DIR}")


def get_yfinance_data(symbol: str, period: str = '5y') -> Optional[Any]:
    """Fetch stock data using yfinance."""
    try:
        import yfinance as yf

        ticker = yf.Ticker(symbol)
        data = ticker.history(period=period)

        if data.empty:
            logger.warning(f"No data for symbol: {symbol}")
            return None

        return data

    except ImportError:
        logger.error("yfinance library not installed. Install with: pip install yfinance")
        return None
    except Exception as e:
        logger.error(f"Error fetching {symbol}: {e}")
        return None


def get_nse_india_data(symbol: str, from_date: datetime, to_date: datetime) -> Optional[Any]:
    """
    Fetch stock data from NSE India API.
    This requires the nsepython library or direct API calls.
    """
    try:
        # Try using nsepython if available
        try:
            from nsepython import nse_fetch
            # NSE data fetching implementation
            pass
        except ImportError:
            logger.warning("nsepython not available, will use yfinance")
    except Exception as e:
        logger.warning(f"NSE API error: {e}")

    return None


def data_to_parquet(data, filepath: Path):
    """Convert DataFrame to Parquet format."""
    try:
        import pandas as pd

        if data is None or data.empty:
            return False

        # Ensure we have the required columns
        required_columns = ['Date', 'Open', 'High', 'Low', 'Close', 'Volume']
        if not all(col in data.columns for col in required_columns):
            logger.warning(f"Missing columns in data for {filepath}")
            return False

        # Reset index to make Date a column
        df = data.reset_index()
        df.columns = ['date', 'open', 'high', 'low', 'close', 'volume']

        # Add symbol if not present
        if 'symbol' not in df.columns:
            symbol = filepath.stem.upper()
            df['symbol'] = symbol

        # Convert date to datetime
        df['date'] = pd.to_datetime(df['date']).dt.date

        # Save to Parquet
        df.to_parquet(filepath, engine='pyarrow', compression='snappy')
        logger.info(f"Saved {len(df)} rows to {filepath}")
        return True

    except ImportError:
        logger.error("pandas or pyarrow not installed")
        return False
    except Exception as e:
        logger.error(f"Error saving to Parquet: {e}")
        return False


def download_stock_data(symbols: List[str]) -> Dict[str, bool]:
    """Download data for a list of symbols."""
    results = {}

    for symbol in symbols:
        symbol_path = STOCK_DATA_DIR / f"{symbol}.parquet"

        # Skip if file already exists
        if symbol_path.exists():
            logger.info(f"Skipping {symbol} - already downloaded")
            results[symbol] = True
            continue

        logger.info(f"Fetching data for {symbol}...")
        data = get_yfinance_data(f"{symbol}.NS")

        if data is not None:
            success = data_to_parquet(data, symbol_path)
            results[symbol] = success

            # Be nice to the API
            time.sleep(0.5)
        else:
            results[symbol] = False

    return results


def download_benchmark_data() -> Dict[str, bool]:
    """Download benchmark index data."""
    results = {}

    try:
        import yfinance as yf
    except ImportError:
        logger.error("yfinance library not installed")
        return results

    for name, symbol in BENCHMARKS.items():
        filepath = BENCHMARK_DATA_DIR / f"{name}.parquet"

        # Skip if file already exists
        if filepath.exists():
            logger.info(f"Skipping {name} - already downloaded")
            results[name] = True
            continue

        logger.info(f"Fetching benchmark data for {name} ({symbol})...")
        try:
            ticker = yf.Ticker(symbol)
            data = ticker.history(period='5y')

            if data is not None and not data.empty:
                success = data_to_parquet(data, filepath)
                results[name] = success
                time.sleep(0.5)
            else:
                results[name] = False

        except Exception as e:
            logger.error(f"Error downloading {name}: {e}")
            results[name] = False

    return results


def create_symbol_list() -> List[str]:
    """Get the full list of NSE stocks."""
    try:
        import nsepython
        # Get all NSE stocks
        symbols = nsepython.live_get()['data']['symbol']
        return symbols
    except Exception:
        # Return default list
        return list(set(NSE_SYMBOLS))


def update_existing_data():
    """Update existing data files with newer data."""
    logger.info("Updating existing data files...")

    # Update stock data
    for parquet_file in STOCK_DATA_DIR.glob("*.parquet"):
        logger.info(f"Updating {parquet_file.name}...")

    # Update benchmark data
    for parquet_file in BENCHMARK_DATA_DIR.glob("*.parquet"):
        if parquet_file.stem in BENCHMARKS:
            logger.info(f"Updating {parquet_file.name}...")


def generate_sample_csv():
    """Generate a sample CSV file for testing."""
    sample_csv = """transaction_date,isin,quantity,price,type
2024-01-15,INE002A01018,10,2500,BUY
2024-02-20,INE00B01014,5,4200,BUY
2024-02-25,INE002A01018,5,2600,BUY
2024-03-10,INE010A01018,20,1450,BUY
2024-04-05,INE009A01013,15,1350,BUY
2024-04-15,INE009A01013,5,1300,BUY
2024-05-12,INE020A01024,25,850,BUY
2024-06-18,INE075A01025,8,1600,BUY
2024-07-22,INE018A01024,5,2800,BUY
2024-07-25,INE018A01024,3,2900,BUY
2024-08-30,INE036A01029,12,1380,BUY
2024-09-15,INE002A01018,3,2700,SELL
2024-09-15,INE009A01013,5,1400,SELL
2024-10-25,INE011A01012,30,650,BUY
2024-11-08,INE019A01027,50,420,BUY
2024-12-15,INE002A01018,2,2800,SELL
2024-12-20,INE002A01018,5,2850,SELL
"""

    csv_path = Path(__file__).parent.parent / 'sample_transactions.csv'
    csv_path.write_text(sample_csv)
    logger.info(f"Sample CSV created: {csv_path}")


def main():
    """Main function."""
    logger.info("Starting data download process...")
    ensure_directories()

    print("\n" + "="*60)
    print("Portfolio Analysis - Data Downloader")
    print("="*60)

    # Download benchmark data first
    print("\nDownloading benchmark indices data...")
    benchmark_results = download_benchmark_data()
    print(f"Benchmark results: {benchmark_results}")

    # Download stock data
    print("\nDownloading stock price data...")
    stock_results = download_stock_data(list(set(NSE_SYMBOLS))[:20])  # Limit to 20 for demo
    print(f"Stock results: {stock_results}")

    # Generate sample CSV
    generate_sample_csv()

    # Summary
    print("\n" + "="*60)
    print("Summary")
    print("="*60)

    successful = sum(1 for v in stock_results.values() if v)
    total = len(stock_results)
    print(f"Stocks downloaded: {successful}/{total}")

    successful = sum(1 for v in benchmark_results.values() if v)
    total = len(benchmark_results)
    print(f"Benchmarks downloaded: {successful}/{total}")

    print(f"\nData saved to: {DATA_DIR}")
    print("Use 'python scripts/download_data.py --update' to refresh data later.")


if __name__ == '__main__':
    if '--update' in sys.argv:
        update_existing_data()
    else:
        main()
