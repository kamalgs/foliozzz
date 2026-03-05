# Portfolio Analysis Application

A completely browser-based portfolio analysis application for Indian stocks using DuckDB WebAssembly.

## Features

- **Browser-based**: No server required - runs entirely in the browser
- **DuckDB WASM**: In-browser data processing with SQL
- **CSV Import**: Upload your transaction history
- **Benchmark Comparison**: Compare against NIFTY 50, NIFTY BANK, SENSEX, NIFTY MIDCAP, BSE 500
- **Visualizations**: Interactive line charts for returns comparison

## Quick Start

1. Open `index.html` in your browser
2. Upload a CSV file with your transactions
3. Select a benchmark index
4. View your portfolio returns vs the benchmark

## CSV Format

Your CSV file should have the following format:

```csv
date,symbol,quantity,price
2024-01-15,RELIANCE,10,2500
2024-02-20,TCS,5,4200
2024-03-10,HDFCBANK,20,1450
```

- **date**: Transaction date in YYYY-MM-DD format
- **symbol**: Stock symbol (NSE list, e.g., RELIANCE, TCS, HDFCBANK)
- **quantity**: Number of shares
- **price**: Purchase price per share

## Data Files

The application uses pre-bundled Parquet files for stock and benchmark prices:

```
data/
├── nifty50.parquet             # NIFTY 50 index data
├── bank_nifty.parquet          # NIFTY BANK index data
├── sensex.parquet              # SENSEX index data
├── nifty_midcap.parquet        # NIFTY MIDCAP 100 data
├── bse_500.parquet             # BSE 500 index data
└── stock_prices/
    ├── RELIANCE.parquet
    ├── TCS.parquet
    ├── HDFCBANK.parquet
    └── ... (all NSE stocks)
```

## Generating Sample Data

To generate sample Parquet data for testing:

```bash
pip install pandas pyarrow
python scripts/generate_sample_data.py
```

## Updating Data

To download updated stock data from Yahoo Finance:

```bash
pip install pandas pyarrow yfinance
python scripts/download_data.py
```

To refresh existing data:

```bash
python scripts/download_data.py --update
```

## Technology Stack

- **DuckDB WebAssembly**: In-browser SQL processing
- **Chart.js**: Data visualization
- **Vanilla JavaScript**: No build required

## Project Structure

```
portfolio-analysis/
├── index.html          # Main entry point
├── styles.css          # Styling
├── app.js              # Application logic
├── sample_transactions.csv  # Sample CSV for testing
├── data/               # Pre-bundled Parquet files
│   ├── nifty50.parquet
│   ├── bank_nifty.parquet
│   ├── sensex.parquet
│   ├── nifty_midcap.parquet
│   ├── bse_500.parquet
│   └── stock_prices/
└── scripts/
    ├── download_data.py      # Data collection script
    └── generate_sample_data.py  # Generate sample data
```

## Disclaimer

This application is for educational purposes only. The data provided is for demonstration and should not be used for actual investment decisions. Past performance does not guarantee future results.
