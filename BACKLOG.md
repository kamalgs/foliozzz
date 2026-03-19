# Backlog

## Merger / ISIN-change handling

**Problem**: When companies merge (e.g. HDFC Ltd → HDFC Bank, July 2023), the old ISIN ceases trading. If the merger SELL/BUY entries are missing from the broker CSV, the daily portfolio-value chart shows a cliff — old ISIN holdings stay non-zero but price data runs out on the effective date.

**Proposed approach (Option 3 — price continuity only)**:
- Add a curated `data/isin_mergers.json`: `[{old_isin, new_isin, effective_date, ratio}]`
- In `loadStockPrices`, the `stock_prices` VIEW UNIONs old ISIN prices from new ISIN's parquet for dates after `effective_date`
- Assumes broker CSV already contains the merger as SELL/BUY transactions (Groww does)
- Does not synthesise missing transactions — out of scope for now

**Why not auto-detect from NSE API**: Subject field is free-text ("Scheme of Amalgamation of HDFC Limited with HDFC Bank Limited"), new ISIN cannot be reliably resolved programmatically.

**Known examples to seed the mapping file**:
- HDFC Ltd (`INE001A01036`) → HDFC Bank (`INE040A01034`), effective 2023-07-01, ratio 42:25 (1.68)
