# OPFS Parquet Cache — Design Spec

**Date:** 2026-03-16
**Status:** Draft

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

Handles all OPFS operations and the conditional fetch logic. Runs on the **main thread** using the async `createWritable()` OPFS API (not `createSyncAccessHandle`, which requires a Worker). Exposes a single public function:

```typescript
export async function fetchWithCache(name: string, url: string): Promise<ArrayBuffer>
```

`name` is the logical cache key (e.g. `stock_prices/RELIANCE.parquet`) and matches the name passed to DuckDB's `registerFileBuffer`. `url` is the HTTP URL to fetch from.

### Modified: `src/duckdb-module.ts`

`registerParquet` replaces its `fetch()` call with `fetchWithCache(name, url)`. No other changes to the public API.

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

### Cache key / filename derivation

The `name` parameter (e.g. `stock_prices/RELIANCE.parquet`) is used as the cache key, not the full URL. This avoids issues with query strings or URL encoding. Filename sanitisation:

- Replace `/` with `__`
- Any character not in `[A-Za-z0-9._-]` is replaced with `_`

This scheme is collision-resistant for the actual filenames in this project. If two names would produce the same sanitised filename (e.g. a file literally containing `__`), the second write overwrites the first — acceptable given the small, known file set.

## Data Flow

```
fetchWithCache(name, url)
  ├── Get OPFS dir (module-level Promise singleton) → null? → plain fetch fallback (no caching)
  │
  ├── Check in-flight map for `name` → already in-flight? → await that Promise (dedup)
  │
  ├── Read .meta from OPFS → has cached copy?
  │     YES → conditional GET (If-None-Match: etag / If-Modified-Since: lastModified)
  │           ├── 304 Not Modified → read .parquet from OPFS
  │           │     ├── success     → return bytes
  │           │     └── read fails  → fall through to unconditional GET (treat as no cache)
  │           ├── 200 OK            → write bytes first, then meta (fire-and-forget)
  │           │                        → return bytes
  │           ├── 4xx (e.g. 404)    → evict cache entry (delete .parquet and .meta,
  │           │                        each with allowMissing semantics) → throw
  │           ├── 5xx               → read .parquet from OPFS → return bytes (fallback)
  │           └── network error     → read .parquet from OPFS → return bytes (fallback)
  │
  └── NO cached copy (or .meta missing, or .parquet read failed above)
        → unconditional GET
        ├── 200 OK        → write bytes first, then meta (fire-and-forget) → return bytes
        ├── 4xx           → throw (no fallback available)
        ├── 5xx           → throw (no fallback available)  [note: differs from 5xx with cache hit]
        └── network error → throw (no fallback available)
```

**Note:** 5xx behaviour differs based on cache presence: with a cache hit, fall back to cached bytes; without a cache hit, throw. Implementers must not apply 5xx-fallback logic uniformly.

### Write ordering

Bytes are always written before meta. This means:
- If bytes succeed but meta fails: next load finds `.parquet` without `.meta` → treated as no cache, does a fresh unconditional fetch and rewrites both. Safe.
- If bytes fail: meta is never written. Next load also finds no cache. Safe.

Both writes are fire-and-forget (non-blocking). A write failure logs a warning but does not interrupt returning the fetched bytes.

### In-flight deduplication

A module-level `Map<string, Promise<ArrayBuffer>>` tracks in-progress fetches keyed by sanitised filename. If `fetchWithCache` is called for the same `name` while a fetch is already in progress (e.g. two components requesting the same parquet file at startup), the second call awaits the existing Promise rather than issuing a duplicate network request. The entry is removed from the map when the Promise settles.

## Error Handling

| Scenario | Behaviour |
|---|---|
| Network fails, cache hit | Return cached bytes — app works offline |
| Network fails, no cache | Throw — same as current behaviour |
| 5xx response, cache hit | Return cached bytes |
| 5xx response, no cache | Throw |
| 4xx response (e.g. 404), cache hit | Evict cache entry (both files, allowMissing), throw |
| 4xx / network error, no cache | Throw |
| Server returns no ETag or Last-Modified | Skip conditional GET; always re-fetch and overwrite cache |
| OPFS unavailable (detection fails) | Fall back to plain `fetch`, no caching |
| OPFS write fails | Log warning, continue — non-fatal |
| `.meta` exists but `.parquet` missing or unreadable | Treat as no cache; do fresh unconditional fetch |
| `.parquet` exists but `.meta` missing | Treat as no cache; do fresh unconditional fetch |
| Corrupted cached bytes | DuckDB parse fails — caught by existing try/catch in `loadStockPrices`, stock silently skipped |

## OPFS Availability Detection

Detection is performed once and the result is stored as a **module-level Promise singleton**:

```typescript
// Module-level singleton — resolved once, reused for every fetchWithCache call
let opfsDirPromise: Promise<FileSystemDirectoryHandle | null> | undefined;

function getOpfsDir(): Promise<FileSystemDirectoryHandle | null> {
    if (!opfsDirPromise) {
        opfsDirPromise = (async () => {
            try {
                const root = await navigator.storage.getDirectory();
                const dir = await root.getDirectoryHandle('parquet-cache', { create: true });
                // Probe actual write access: create and delete a sentinel file.
                // Needed because getDirectory() may succeed but writes fail in some
                // private-browsing modes (Firefox, older Safari).
                const sentinel = await dir.getFileHandle('__probe__', { create: true });
                const w = await sentinel.createWritable();
                await w.write(new Uint8Array([0]));
                await w.close();
                await dir.removeEntry('__probe__');
                return dir;
            } catch {
                return null; // OPFS unavailable — use plain fetch
            }
        })();
    }
    return opfsDirPromise;
}
```

`null` means all `fetchWithCache` calls fall back to plain `fetch` with no caching.

## Concurrency / Multi-tab Behaviour

This module uses `createWritable()` (the async OPFS API), not `createSyncAccessHandle`. `createWritable()` does not require exclusive access, so concurrent writes from multiple tabs are safe at the API level — last write wins. For this use case (read-mostly cache, small files, identical content written by all tabs) last-write-wins is acceptable.

Intra-tab concurrent calls for the same file are deduplicated via the in-flight map (see Data Flow above).

## Server Requirements

The server (Caddy or equivalent) must support:

1. **ETag or Last-Modified headers** on static parquet files — for conditional GET support
2. **CORS headers** for browser access:
   ```
   Access-Control-Allow-Origin: *
   Access-Control-Expose-Headers: ETag, Last-Modified
   ```

Caddy generates ETags and serves Last-Modified headers for static files natively. No additional configuration needed beyond CORS.

## Files Changed

| File | Change |
|---|---|
| `src/opfs-cache.ts` | New — OPFS read/write + conditional fetch |
| `src/duckdb-module.ts` | Modified — `registerParquet` calls `fetchWithCache(name, url)` |
