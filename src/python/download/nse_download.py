"""
Download historic stock price data from NSE India public API.
"""

import requests
import pandas as pd
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Optional
import time


class NSEDownloader:
    """Downloader for NSE India historic price data."""

    BASE_URL = "https://www.nseindia.com"

    def __init__(self, download_dir: str = "data/raw"):
        self.download_dir = Path(download_dir)
        self.download_dir.mkdir(parents=True, exist_ok=True)
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.nseindia.com/',
        })
        # Pre-connect to get cookies
        self._init_session()

    def _init_session(self):
        """Initialize session with NSE."""
        try:
            response = self.session.get(f"{self.BASE_URL}/", timeout=10)
            response.raise_for_status()
        except Exception as e:
            print(f"Warning: Could not initialize session: {e}")

    def get_equity_symbol(self, symbol: str, from_date: str, to_date: str) -> Optional[pd.DataFrame]:
        """
        Download historic price data for a single equity symbol.

        Args:
            symbol: Stock symbol (e.g., RELIANCE, TCS)
            from_date: Start date in YYYY-MM-DD format
            to_date: End date in YYYY-MM-DD format

        Returns:
            DataFrame with OHLCV data or None if download fails
        """
        # NSE API endpoint for historic data
        url = f"{self.BASE_URL}/api/historical/cm/equity"

        params = {
            'symbol': symbol,
            'from': from_date,
            'to': to_date,
        }

        try:
            response = self.session.get(url, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()

            if 'data' not in data or not data['data']:
                print(f"No data for {symbol}")
                return None

            df = pd.DataFrame(data['data'])

            # Rename and select relevant columns
            column_mapping = {
                'open': 'open',
                'high': 'high',
                'low': 'low',
                'close': 'close',
                'tradedQuantity': 'volume',
                'turnover': 'turnover',
                'Date': 'date',
            }

            df = df.rename(columns=column_mapping)

            # Convert date column
            df['date'] = pd.to_datetime(df['date'])

            # Sort by date
            df = df.sort_values('date').reset_index(drop=True)

            return df

        except Exception as e:
            print(f"Error downloading {symbol}: {e}")
            return None

    def get_index_data(self, index_name: str, from_date: str, to_date: str) -> Optional[pd.DataFrame]:
        """
        Download historic data for an index.

        Args:
            index_name: Index name (NIFTY 50, BANK NIFTY, SENSEX, etc.)
            from_date: Start date in YYYY-MM-DD format
            to_date: End date in YYYY-MM-DD format

        Returns:
            DataFrame with index data
        """
        # For indices, we use a different approach
        # NSE provides NIFTY and BANK NIFTY data
        if index_name in ["NIFTY 50", "NIFTY50"]:
            return self._get_nifty_50(from_date, to_date)
        elif index_name in ["BANK NIFTY", "NIFTY BANK"]:
            return self._get_bank_nifty(from_date, to_date)
        elif index_name == "SENSEX":
            return self._get_sensex(from_date, to_date)
        elif index_name == "NIFTY MIDCAP 100":
            return self._get_nifty_midcap(from_date, to_date)
        elif index_name == "BSE 500":
            return self._get_bse_500(from_date, to_date)
        else:
            print(f"Index {index_name} not supported")
            return None

    def _get_nifty_50(self, from_date: str, to_date: str) -> Optional[pd.DataFrame]:
        """Download NIFTY 50 index data."""
        # Using public NSE data endpoint
        url = "https://www.nseindia.com/api/historical/indicesHistory"
        params = {
            'indexType': 'NIFTY 50',
            'from': from_date,
            'to': to_date,
        }

        try:
            response = self.session.get(url, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()

            if 'data' not in data:
                return None

            records = []
            for entry in data['data']:
                records.append({
                    'date': entry['date'],
                    'open': entry['open'],
                    'high': entry['high'],
                    'low': entry['low'],
                    'close': entry['close'],
                    'volume': entry.get('totalTradedVolume', 0),
                })

            df = pd.DataFrame(records)
            df['date'] = pd.to_datetime(df['date'])
            df = df.sort_values('date').reset_index(drop=True)
            return df

        except Exception as e:
            print(f"Error downloading NIFTY 50: {e}")
            return None

    def _get_bank_nifty(self, from_date: str, to_date: str) -> Optional[pd.DataFrame]:
        """Download BANK NIFTY index data."""
        url = "https://www.nseindia.com/api/historical/indicesHistory"
        params = {
            'indexType': 'NIFTY BANK',
            'from': from_date,
            'to': to_date,
        }

        try:
            response = self.session.get(url, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()

            if 'data' not in data:
                return None

            records = []
            for entry in data['data']:
                records.append({
                    'date': entry['date'],
                    'open': entry['open'],
                    'high': entry['high'],
                    'low': entry['low'],
                    'close': entry['close'],
                    'volume': entry.get('totalTradedVolume', 0),
                })

            df = pd.DataFrame(records)
            df['date'] = pd.to_datetime(df['date'])
            df = df.sort_values('date').reset_index(drop=True)
            return df

        except Exception as e:
            print(f"Error downloading BANK NIFTY: {e}")
            return None

    def _get_sensex(self, from_date: str, to_date: str) -> Optional[pd.DataFrame]:
        """Download SENSEX data from BSE API."""
        # Using BSE API for SENSEX
        url = "https://bseindia.com/BSEDataSvc_service/StockSearchService.svc/GetStockHistory"

        # BSE API parameters
        params = {
            'scripcd': '500002',  # SENSEX scrip code
            'fromdate': from_date,
            'todate': to_date,
            'cnt': '10000',  # Get enough records
        }

        try:
            # BSE API returns JSONP, need to handle it
            response = self.session.get(url, params=params, timeout=30)
            response.raise_for_status()

            # Parse the response (it might be JSONP)
            data_str = response.text.strip()
            if data_str.startswith(')'):
                data_str = data_str[data_str.find('{'):]

            data = response.json()

            if 'd' not in data:
                return None

            records = []
            for entry in data['d']:
                records.append({
                    'date': entry.get('TradeDate', ''),
                    'open': entry.get('Open', 0),
                    'high': entry.get('High', 0),
                    'low': entry.get('Low', 0),
                    'close': entry.get('Close', 0),
                    'volume': entry.get('TotTrdQty', 0),
                })

            df = pd.DataFrame(records)
            df['date'] = pd.to_datetime(df['date'], format='%d/%m%Y')
            df = df.sort_values('date').reset_index(drop=True)
            return df

        except Exception as e:
            print(f"Error downloading SENSEX: {e}")
            return None

    def _get_nifty_midcap(self, from_date: str, to_date: str) -> Optional[pd.DataFrame]:
        """Download NIFTY MIDCAP 100 index data."""
        url = "https://www.nseindia.com/api/historical/indicesHistory"
        params = {
            'indexType': 'NIFTY MIDCAP 100',
            'from': from_date,
            'to': to_date,
        }

        try:
            response = self.session.get(url, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()

            if 'data' not in data:
                return None

            records = []
            for entry in data['data']:
                records.append({
                    'date': entry['date'],
                    'open': entry['open'],
                    'high': entry['high'],
                    'low': entry['low'],
                    'close': entry['close'],
                    'volume': entry.get('totalTradedVolume', 0),
                })

            df = pd.DataFrame(records)
            df['date'] = pd.to_datetime(df['date'])
            df = df.sort_values('date').reset_index(drop=True)
            return df

        except Exception as e:
            print(f"Error downloading NIFTY MIDCAP: {e}")
            return None

    def _get_bse_500(self, from_date: str, to_date: str) -> Optional[pd.DataFrame]:
        """Download BSE 500 index data."""
        # BSE 500 is available via various APIs
        # Using public API that provides index data
        url = "https://api.bseindia.com/BseIndiaAPI/api/Indices/getIndicesData"

        params = {
            'fromdate': from_date,
            'todate': to_date,
            'indexname': 'S&P BSE 500',
        }

        try:
            response = self.session.get(url, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()

            if 'Result' not in data:
                return None

            records = []
            for entry in data['Result']:
                records.append({
                    'date': entry.get('DATE', ''),
                    'open': entry.get('OPEN', 0),
                    'high': entry.get('HIGH', 0),
                    'low': entry.get('LOW', 0),
                    'close': entry.get('CLOSE', 0),
                    'volume': entry.get('VOLUME', 0),
                })

            df = pd.DataFrame(records)
            df['date'] = pd.to_datetime(df['date'], format='%d-%b-%Y')
            df = df.sort_values('date').reset_index(drop=True)
            return df

        except Exception as e:
            print(f"Error downloading BSE 500: {e}")
            return None

    def download_bulk_equities(self, symbols: List[str], days: int = 365) -> Dict[str, Optional[pd.DataFrame]]:
        """
        Download data for multiple equity symbols.

        Args:
            symbols: List of stock symbols
            days: Number of days of history to fetch

        Returns:
            Dictionary mapping symbol to DataFrame
        """
        to_date = datetime.now().strftime('%Y-%m-%d')
        from_date = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')

        results = {}
        for symbol in symbols:
            print(f"Downloading {symbol}...")
            df = self.get_equity_symbol(symbol, from_date, to_date)
            results[symbol] = df
            time.sleep(0.5)  # Rate limiting

        return results

    def download_bulk_indices(self, indices: List[str], days: int = 365) -> Dict[str, Optional[pd.DataFrame]]:
        """
        Download data for multiple indices.

        Args:
            indices: List of index names
            days: Number of days of history to fetch

        Returns:
            Dictionary mapping index name to DataFrame
        """
        to_date = datetime.now().strftime('%Y-%m-%d')
        from_date = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')

        results = {}
        for index in indices:
            print(f"Downloading {index}...")
            df = self.get_index_data(index, from_date, to_date)
            results[index] = df
            time.sleep(0.5)  # Rate limiting

        return results


def download_default_data():
    """
    Download default dataset for common Indian stocks and indices.

    This creates a baseline dataset for the application.
    """
    downloader = NSEDownloader()

    # Default stocks to download
    default_stocks = [
        'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
        'HINDUNILVR', 'ITC', 'SBIN', 'BhartiAirtel', 'LT',
        'BAJFINANCE', 'KOTAKBANK', 'AXISBANK', 'SUNPHARMA', 'TITAN'
    ]

    # Default indices
    default_indices = ['NIFTY 50', 'BANK NIFTY', 'SENSEX', 'NIFTY MIDCAP 100', 'BSE 500']

    print("Downloading stock data...")
    stock_data = downloader.download_bulk_equities(default_stocks)

    print("\nDownloading index data...")
    index_data = downloader.download_bulk_indices(default_indices)

    # Save to raw data directory
    for symbol, df in stock_data.items():
        if df is not None:
            df.to_csv(downloader.download_dir / f"{symbol}.csv", index=False)
            print(f"Saved {symbol}.csv ({len(df)} rows)")

    for index, df in index_data.items():
        if df is not None:
            safe_name = index.replace(' ', '_').replace('/', '_')
            df.to_csv(downloader.download_dir / f"{safe_name}.csv", index=False)
            print(f"Saved {safe_name}.csv ({len(df)} rows)")

    return stock_data, index_data


if __name__ == "__main__":
    # Run data download
    stock_data, index_data = download_default_data()
    print("\nDownload complete!")
