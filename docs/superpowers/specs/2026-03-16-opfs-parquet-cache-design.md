# OPFS Parquet Cache — Design Spec

**Date:** 2026-03-16
**Status:** Approved

## Problem

Parquet files (stock prices + benchmarks) are re-downloaded from the server on every page load via `fetch()` + `registerFileBuffer()` in `registerParquet`. There is no persistent cache, so:
- Each load incurs unnecessary network round-trips
- If the network is unavailable the app fails even though data was previously loaded

## Goals

1. **Avoid re-downloading** parquet files on every page load using OPFS as a persistent cache
2. **Never serve stale data** — validate cached files against the server using ETags
3. **Degrade gracefully** — if the network fails but a cached copy exists, use it

## Non-Goals

- DuckLake (not supported in DuckDB WASM)
- HTTP range requests / httpfs (not officially available in DuckDB WASM; files are ~18KB so range requests offer negligible benefit)
- Cache eviction (files are small; only portfolio-relevant files are ever cached)
- Bundling all files into a single archive (would force downloading all stocks regardless of portfolio)

## Architecture

### New module: `src/opfs-cache.ts`

Handles all OPFS operations and the conditional fetch logic. Exposes a single public function:

```typescript
export async function fetchWithCache(url: string): Promise<ArrayBuffer>
```

### Modified: `src/duckdb-module.ts`

`registerParquet` replaces its `fetch()` call with `fetchWithCache()`. No other changes to the public API.

```
src/
  opfs-cache.ts      ← new
  duckdb-module.ts   ← modified: registerParquet calls fetchWithCache
```

## OPFS Storage Layout

```
OPFS root/
  parquet-cache/
    stock_prices__RELIANCE.parquet   ← raw ArrayBuffer bytes
    stock_prices__RELIANCE.meta      ← JSON: { etag?, lastModified? }
    nifty50.parquet
    nifty50.meta
    ...
```

URL path separators (`/`) are replaced with `__` for flat filenames within the `parquet-cache` directory. The name passed to `registerParquet` (e.g. `stock_prices/RELIANCE.parquet`) is used as the cache key.

## Data Flow

```
fetchWithCache(url)
  ├── Read .meta from OPFS → has cached copy?
  │     YES → conditional GET (If-None-Match: etag / If-Modified-Since: lastModified)
  │           ├── 304 Not Modified → read .parquet from OPFS → return bytes
  │           ├── 200 OK           → write new bytes + etag to OPFS → return bytes
  │           └── network error    → read .parquet from OPFS → return bytes (fallback)
  │
  └── NO cached copy → normal GET
        ├── 200 OK        → write bytes + etag/lastModified to OPFS → return bytes
        └── network error → throw (no fallback available)
```

OPFS writes are fire-and-forget — a write failure logs a warning but does not interrupt the fetch result.

## Error Handling

| Scenario | Behaviour |
|---|---|
| Network fails, cache hit | Return cached bytes — app works offline |
| Network fails, no cache | Throw — same as current behaviour |
| Server returns no ETag or Last-Modified | Skip conditional GET; always re-fetch and overwrite cache |
| OPFS unavailable (e.g. private browsing) | Fall back to plain `fetch`, no caching |
| OPFS write fails | Log warning, continue — non-fatal |
| Corrupted cached bytes | DuckDB parse fails — caught by existing try/catch in `loadStockPrices`, stock silently skipped |
| Cache .parquet exists but .meta missing | Treat as no cache; do fresh unconditional fetch |

## Server Requirements

The server (Caddy or equivalent) must support:

1. **HTTP range requests** — `Accept-Ranges: bytes`, `206 Partial Content`
2. **ETag or Last-Modified headers** — for conditional GET support
3. **CORS headers** for browser access:
   ```
   Access-Control-Allow-Origin: *
   Access-Control-Allow-Headers: Range
   Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges, ETag, Last-Modified
   ```

Caddy serves static files with range request support and ETag generation natively. No blob storage (S3 etc.) required.

## Files Changed

| File | Change |
|---|---|
| `src/opfs-cache.ts` | New — OPFS read/write + conditional fetch |
| `src/duckdb-module.ts` | Modified — `registerParquet` calls `fetchWithCache` |
