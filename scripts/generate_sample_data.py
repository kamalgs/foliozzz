#!/usr/bin/env python3
"""
Generate sample Parquet data for testing the portfolio analysis app.
Creates synthetic but realistic stock price data.
"""

import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
import random

try:
    import pandas as pd
except ImportError:
    print("pandas is required. Install with: pip install pandas")
    sys.exit(1)


DATA_DIR = Path(__file__).parent.parent / 'data'
STOCK_DATA_DIR = DATA_DIR / 'stock_prices'
SYMBOLS = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HDFC', 'ITC', 'SBIN',
           'BHARTIARTL', 'KOTAKBANK', 'LT', 'AXISBANK', 'INDUSTOWER', 'HINDUNILVR',
           'BAJFINANCE', 'TITAN', 'ULTRACEMCO', 'WIPRO', 'TATASTEEL', 'ONGC',
           'POWERGRID', 'NTPC', 'MARUTI', 'TATAMOTORS', 'TECHM', 'HCLTECH',
           'ASIANPAINT', 'ADANIPORTS', 'BAJAJFINSV', 'LTIM', 'M&M', 'TATACONSUM',
           'BPCL', 'BRITANNIA', 'HEROMOTOCO', 'DIVISLAB', 'COALINDIA', 'EICHERMOT']


def generate_price_data(symbol: str, start_date: str = '2024-01-01', end_date: str = '2024-12-31') -> pd.DataFrame:
    """Generate realistic stock price data for a symbol."""
    # Generate date range (business days only)
    dates = pd.bdate_range(start=start_date, end=end_date)

    # Initial price based on symbol
    base_prices = {
        'RELIANCE': 2500, 'TCS': 4000, 'HDFCBANK': 1400, 'INFY': 1400, 'ICICIBANK': 800,
        'HDFC': 900, 'ITC': 400, 'SBIN': 600, 'BHARTIARTL': 800, 'KOTAKBANK': 1500,
        'LT': 2500, 'AXISBANK': 750, 'INDUSTOWER': 350, 'HINDUNILVR': 2800,
        'BAJFINANCE': 1400, 'TITAN': 1900, 'ULTRACEMCO': 3200, 'WIPRO': 600,
        'TATASTEEL': 1000, 'ONGC': 150, 'POWERGRID': 240, 'NTPC': 200,
        'MARUTI': 9500, 'TATAMOTORS': 700, 'TECHM': 1400, 'HCLTECH': 1200,
        'ASIANPAINT': 3000, 'ADANIPORTS': 700, 'BAJAJFINSV': 1700, 'LTIM': 2200,
        'M&M': 1000, 'TATACONSUM': 700, 'BPCL': 1200, 'BRITANNIA': 4200,
        'HEROMOTOCO': 3500, 'DIVISLAB': 1500, 'COALINDIA': 350, 'EICHERMOT': 3800
    }

    base_price = base_prices.get(symbol, 500)

    # Generate prices with some realistic volatility
    prices = [base_price]
    for _ in range(len(dates) - 1):
        change = random.uniform(-0.03, 0.03)  # Max 3% daily change
        new_price = prices[-1] * (1 + change)
        prices.append(new_price)

    # Create DataFrame
    df = pd.DataFrame({
        'date': dates,
        'open': [p * random.uniform(0.98, 1.02) for p in prices],
        'high': [max(open_p, close_p * random.uniform(1.0, 1.02)) for open_p, close_p in zip(
            [p * random.uniform(0.98, 1.02) for p in prices], prices)],
        'low': [min(open_p, close_p * random.uniform(0.98, 1.0)) for open_p, close_p in zip(
            [p * random.uniform(0.98, 1.02) for p in prices], prices)],
        'close': prices,
        'volume': [random.randint(1000000, 10000000) for _ in range(len(dates))],
        'symbol': [symbol] * len(dates)
    })

    # Fix high/low to be correct
    for i in range(len(df)):
        open_val = df.loc[i, 'open']
        close_val = df.loc[i, 'close']
        df.loc[i, 'high'] = max(open_val, close_val) * random.uniform(1.0, 1.01)
        df.loc[i, 'low'] = min(open_val, close_val) * random.uniform(0.99, 1.0)

    return df


def generate_benchmark_data(symbol: str, name: str, start_date: str = '2024-01-01', end_date: str = '2024-12-31') -> pd.DataFrame:
    """Generate benchmark index data."""
    dates = pd.bdate_range(start=start_date, end=end_date)

    # Base values for benchmarks
    base_values = {
        'nifty50': 20000,
        'bank_nifty': 40000,
        'sensex': 65000,
        'nifty_midcap': 25000,
        'bse_500': 80000
    }

    base_value = base_values.get(symbol, 20000)
    prices = [base_value]

    # Generate returns that are correlated but slightly different
    for _ in range(len(dates) - 1):
        change = random.uniform(-0.02, 0.02)  # Slightly less volatile than stocks
        prices.append(prices[-1] * (1 + change))

    df = pd.DataFrame({
        'date': dates,
        'open': [p * random.uniform(0.99, 1.01) for p in prices],
        'high': [max(open_p, close_p) * random.uniform(1.0, 1.005) for open_p, close_p in zip(
            [p * random.uniform(0.99, 1.01) for p in prices], prices)],
        'low': [min(open_p, close_p) * random.uniform(0.995, 1.0) for open_p, close_p in zip(
            [p * random.uniform(0.99, 1.01) for p in prices], prices)],
        'close': prices,
        'volume': [random.randint(50000000, 500000000) for _ in range(len(dates))],
        'symbol': [symbol] * len(dates)
    })

    return df


def main():
    """Generate all sample data."""
    print("Generating sample data for Portfolio Analysis app...")
    print("=" * 50)

    # Ensure directories exist
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STOCK_DATA_DIR.mkdir(parents=True, exist_ok=True)

    # Generate stock data
    print("\nGenerating stock price data...")
    for symbol in SYMBOLS:
        filepath = STOCK_DATA_DIR / f"{symbol}.parquet"
        df = generate_price_data(symbol)
        df.to_parquet(filepath, engine='pyarrow', compression='snappy')
        print(f"  Created {filepath.name} ({len(df)} rows)")

    # Generate benchmark data
    print("\nGenerating benchmark index data...")
    benchmarks = [
        ('nifty50', 'NIFTY 50'),
        ('bank_nifty', 'NIFTY BANK'),
        ('sensex', 'SENSEX'),
        ('nifty_midcap', 'NIFTY MIDCAP 100'),
        ('bse_500', 'BSE 500')
    ]

    for symbol, name in benchmarks:
        filepath = DATA_DIR / f"{symbol}.parquet"
        df = generate_benchmark_data(symbol, name)
        df.to_parquet(filepath, engine='pyarrow', compression='snappy')
        print(f"  Created {filepath.name} ({len(df)} rows)")

    print("\n" + "=" * 50)
    print(f"Sample data generated in: {DATA_DIR}")
    print("\nTo use the app:")
    print("1. Open index.html in a browser")
    print("2. Upload a CSV with transactions")
    print("3. Select a benchmark index")
    print("4. View the returns comparison chart")


if __name__ == '__main__':
    main()
