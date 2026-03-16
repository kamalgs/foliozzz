# OPFS Parquet Cache Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent OPFS cache to `registerParquet` so parquet files survive page reloads and the app works offline when previously-loaded files are cached.

**Architecture:** A new `src/opfs-cache.ts` module exposes `fetchWithCache(name, url)` which checks OPFS for a cached copy, does a conditional GET (ETag/Last-Modified) if one exists, writes new responses to OPFS, and falls back to cached bytes on network/5xx failures. `registerParquet` in `duckdb-module.ts` calls this instead of raw `fetch`.

**Tech Stack:** TypeScript, browser OPFS API (`navigator.storage.getDirectory`, `createWritable`), Node.js built-in test runner (`node:test`), esbuild

---

## OPFS storage key convention

- Data file: `safeName` (e.g. `nifty50.parquet`, `stock_prices__RELIANCE.parquet`)
- Meta file: `safeName + '.meta'` (e.g. `nifty50.parquet.meta`)

`safeName` = `name` with `/` → `__`, any non-`[A-Za-z0-9._-]` → `_`.

---

## Chunk 1: `src/opfs-cache.ts` — implementation + tests

### Task 1: Write failing tests for `fetchWithCache`

**Files:**
- Create: `tests/opfs-cache.test.ts`

These tests run in Node.js and mock all browser globals (`navigator.storage`, `fetch`, `FileSystemDirectoryHandle`, etc.) via `globalThis`.

- [ ] **Step 1: Create the test file**

```typescript
// tests/opfs-cache.test.ts
import { describe, it, beforeEach } from 'node:test';
import { strictEqual, rejects, ok } from 'node:assert';

// ── OPFS mock helpers ────────────────────────────────────────

type MockFiles = Record<string, {
    content: Uint8Array | string;
    createWritable(): Promise<{
        write(d: unknown): Promise<void>;
        close(): Promise<void>;
    }>;
    getFile(): Promise<{
        arrayBuffer(): Promise<ArrayBuffer>;
        text(): Promise<string>;
    }>;
}>;

function makeMockDir(files: MockFiles, failWrite = false): {
    dir: object;
    written: Record<string, unknown[]>;
    removed: string[];
} {
    const written: Record<string, unknown[]> = {};
    const removed: string[] = [];

    const dir = {
        async getFileHandle(name: string, opts?: { create?: boolean }) {
            if (!files[name] && !opts?.create) {
                const e = new Error('File not found') as Error & { name: string };
                e.name = 'NotFoundError';
                throw e;
            }
            if (!files[name]) {
                const tracked: unknown[] = [];
                written[name] = tracked;
                files[name] = {
                    content: new Uint8Array(),
                    createWritable: async () => {
                        if (failWrite) throw new Error('write failed');
                        return {
                            async write(d: unknown) { tracked.push(d); },
                            async close() {},
                        };
                    },
                    getFile: async () => ({
                        arrayBuffer: async () => (files[name].content as Uint8Array).buffer as ArrayBuffer,
                        text: async () => files[name].content as string,
                    }),
                };
            }
            return files[name];
        },
        async removeEntry(name: string) {
            removed.push(name);
            delete files[name];
        },
    };

    return { dir, written, removed };
}

function makeOpfsMock(dir: object | null): void {
    if (dir === null) {
        (globalThis as Record<string, unknown>).navigator = {
            storage: { getDirectory: async () => { throw new Error('OPFS unavailable'); } },
        };
        return;
    }
    (globalThis as Record<string, unknown>).navigator = {
        storage: {
            getDirectory: async () => ({
                getDirectoryHandle: async () => dir,
            }),
        },
    };
}

type FakeResponse = {
    status: number;
    body?: ArrayBuffer;
    headers?: Record<string, string>;
    throws?: boolean;
};

function makeFetchMock(responses: FakeResponse[]): typeof fetch {
    let call = 0;
    return async (): Promise<Response> => {
        const r = responses[call] ?? responses[responses.length - 1];
        call++;
        if (r.throws) throw new TypeError('Network error');
        const body = r.body ?? new ArrayBuffer(0);
        return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            arrayBuffer: async () => body,
            headers: { get: (h: string) => (r.headers ?? {})[h.toLowerCase()] ?? null },
        } as unknown as Response;
    };
}

// ── Helpers ──────────────────────────────────────────────────

import { fetchWithCache, _resetForTesting } from '../src/opfs-cache.ts';

const BYTES  = new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer;
const BYTES2 = new Uint8Array([5, 6, 7, 8]).buffer as ArrayBuffer;

function setFetch(mock: typeof fetch): void {
    (globalThis as Record<string, unknown>).fetch = mock;
}

beforeEach(() => { _resetForTesting(); });

// ── Helper: pre-populate cache with bytes + meta ─────────────

function cachedFiles(
    safeName: string,
    cachedBytes: ArrayBuffer,
    metaObj: Record<string, string>
): MockFiles {
    return {
        [safeName]: {
            content: new Uint8Array(cachedBytes),
            createWritable: async () => ({ async write() {}, async close() {} }),
            getFile: async () => ({
                arrayBuffer: async () => cachedBytes,
                text: async () => '',
            }),
        },
        [safeName + '.meta']: {
            content: JSON.stringify(metaObj),
            createWritable: async () => ({ async write() {}, async close() {} }),
            getFile: async () => ({
                arrayBuffer: async () => new ArrayBuffer(0),
                text: async () => JSON.stringify(metaObj),
            }),
        },
    };
}

// ── Scenario 1: OPFS unavailable → plain fetch ───────────────

describe('OPFS unavailable', () => {
    it('falls back to plain fetch and returns bytes', async () => {
        makeOpfsMock(null);
        setFetch(makeFetchMock([{ status: 200, body: BYTES }]));
        const result = await fetchWithCache('nifty50.parquet', 'data/nifty50.parquet');
        strictEqual(result.byteLength, BYTES.byteLength);
    });

    it('throws when fetch returns 404 and OPFS unavailable', async () => {
        makeOpfsMock(null);
        setFetch(makeFetchMock([{ status: 404 }]));
        await rejects(
            () => fetchWithCache('nifty50.parquet', 'data/nifty50.parquet'),
            /404/
        );
    });
});

// ── Scenario 2: First load (no cache) ────────────────────────

describe('no cache, first load', () => {
    it('fetches, writes bytes+meta to OPFS, returns bytes', async () => {
        const files: MockFiles = {};
        const { dir, written } = makeMockDir(files);
        makeOpfsMock(dir);
        setFetch(makeFetchMock([{ status: 200, body: BYTES, headers: { etag: '"abc"' } }]));

        const result = await fetchWithCache('nifty50.parquet', 'data/nifty50.parquet');
        strictEqual(result.byteLength, BYTES.byteLength);

        await new Promise(r => setTimeout(r, 20));
        ok('nifty50.parquet' in written,       'bytes written to OPFS');
        ok('nifty50.parquet.meta' in written,  'meta written to OPFS');
    });

    it('throws on 4xx with no cache', async () => {
        const { dir } = makeMockDir({});
        makeOpfsMock(dir);
        setFetch(makeFetchMock([{ status: 404 }]));
        await rejects(
            () => fetchWithCache('nifty50.parquet', 'data/nifty50.parquet'),
            /404/
        );
    });

    it('throws on 5xx with no cache', async () => {
        const { dir } = makeMockDir({});
        makeOpfsMock(dir);
        setFetch(makeFetchMock([{ status: 503 }]));
        await rejects(
            () => fetchWithCache('nifty50.parquet', 'data/nifty50.parquet'),
            /503/
        );
    });

    it('throws on network error with no cache', async () => {
        const { dir } = makeMockDir({});
        makeOpfsMock(dir);
        setFetch(makeFetchMock([{ throws: true }]));
        await rejects(
            () => fetchWithCache('nifty50.parquet', 'data/nifty50.parquet'),
            /Network error/
        );
    });
});

// ── Scenario 3: Cache hit, 304 Not Modified ──────────────────

describe('cache hit, 304', () => {
    it('returns cached bytes, does not write', async () => {
        const cached = new Uint8Array([9, 10]).buffer as ArrayBuffer;
        const files = cachedFiles('nifty50.parquet', cached, { etag: '"v1"' });
        const { dir } = makeMockDir(files);
        makeOpfsMock(dir);
        setFetch(makeFetchMock([{ status: 304 }]));

        const result = await fetchWithCache('nifty50.parquet', 'data/nifty50.parquet');
        strictEqual(result.byteLength, cached.byteLength);
    });
});

// ── Scenario 4: Cache hit, 200 (stale → new content) ─────────

describe('cache hit, 200 new content', () => {
    it('updates cache with new bytes and returns them', async () => {
        const files: MockFiles = {};
        const { dir, written } = makeMockDir(files);
        // Pre-populate meta only (bytes don't matter for this path)
        files['nifty50.parquet.meta'] = {
            content: '{"etag":"\\"v1\\""}',
            createWritable: async () => ({ async write() {}, async close() {} }),
            getFile: async () => ({
                arrayBuffer: async () => new ArrayBuffer(0),
                text: async () => '{"etag":"\\"v1\\""}',
            }),
        };
        makeOpfsMock(dir);
        setFetch(makeFetchMock([{ status: 200, body: BYTES2, headers: { etag: '"v2"' } }]));

        const result = await fetchWithCache('nifty50.parquet', 'data/nifty50.parquet');
        strictEqual(result.byteLength, BYTES2.byteLength);

        await new Promise(r => setTimeout(r, 20));
        ok('nifty50.parquet' in written, 'new bytes written to OPFS');
    });
});

// ── Scenario 5: Cache hit, 4xx ───────────────────────────────

describe('cache hit, 4xx', () => {
    it('evicts cache entry and throws', async () => {
        const files = cachedFiles('nifty50.parquet', BYTES, { etag: '"v1"' });
        const { dir, removed } = makeMockDir(files);
        makeOpfsMock(dir);
        setFetch(makeFetchMock([{ status: 404 }]));

        await rejects(
            () => fetchWithCache('nifty50.parquet', 'data/nifty50.parquet'),
            /404/
        );
        ok(removed.includes('nifty50.parquet'),      '.parquet evicted');
        ok(removed.includes('nifty50.parquet.meta'), '.meta evicted');
    });
});

// ── Scenario 6: Cache hit, 5xx ───────────────────────────────

describe('cache hit, 5xx', () => {
    it('returns cached bytes instead of throwing', async () => {
        const cached = new Uint8Array([42]).buffer as ArrayBuffer;
        const files = cachedFiles('nifty50.parquet', cached, { etag: '"v1"' });
        const { dir } = makeMockDir(files);
        makeOpfsMock(dir);
        setFetch(makeFetchMock([{ status: 503 }]));

        const result = await fetchWithCache('nifty50.parquet', 'data/nifty50.parquet');
        strictEqual(result.byteLength, cached.byteLength);
    });
});

// ── Scenario 7: Cache hit, network error ─────────────────────

describe('cache hit, network error', () => {
    it('returns cached bytes', async () => {
        const cached = new Uint8Array([99]).buffer as ArrayBuffer;
        const files = cachedFiles('nifty50.parquet', cached, { etag: '"v1"' });
        const { dir } = makeMockDir(files);
        makeOpfsMock(dir);
        setFetch(makeFetchMock([{ throws: true }]));

        const result = await fetchWithCache('nifty50.parquet', 'data/nifty50.parquet');
        strictEqual(result.byteLength, cached.byteLength);
    });
});

// ── Scenario 8: .meta missing, .parquet exists ───────────────

describe('.parquet exists but .meta missing', () => {
    it('treats as no cache and does fresh unconditional fetch', async () => {
        const files: MockFiles = {};
        const { dir, written } = makeMockDir(files);
        // Only .parquet in OPFS, no .meta
        files['nifty50.parquet'] = {
            content: new Uint8Array([1]),
            createWritable: async () => ({ async write() {}, async close() {} }),
            getFile: async () => ({ arrayBuffer: async () => new ArrayBuffer(1), text: async () => '' }),
        };
        makeOpfsMock(dir);
        setFetch(makeFetchMock([{ status: 200, body: BYTES }]));

        const result = await fetchWithCache('nifty50.parquet', 'data/nifty50.parquet');
        strictEqual(result.byteLength, BYTES.byteLength);
        await new Promise(r => setTimeout(r, 20));
        // New bytes written over the old entry
        ok('nifty50.parquet' in written, 'bytes refreshed in OPFS');
    });
});

// ── Scenario 9: .meta exists, .parquet missing (304 path) ────

describe('.meta exists but .parquet missing (304 then fallthrough)', () => {
    it('falls through to unconditional GET and caches result', async () => {
        const files: MockFiles = {};
        const { dir, written } = makeMockDir(files);
        // Only .meta in OPFS, no .parquet
        files['nifty50.parquet.meta'] = {
            content: '{"etag":"\\"v1\\""}',
            createWritable: async () => ({ async write() {}, async close() {} }),
            getFile: async () => ({ arrayBuffer: async () => new ArrayBuffer(0), text: async () => '{"etag":"\\"v1\\""}' }),
        };
        makeOpfsMock(dir);
        // Server returns 304 first (parquet missing → fallthrough), then 200 for unconditional GET
        setFetch(makeFetchMock([
            { status: 304 },
            { status: 200, body: BYTES },
        ]));

        const result = await fetchWithCache('nifty50.parquet', 'data/nifty50.parquet');
        strictEqual(result.byteLength, BYTES.byteLength);
        await new Promise(r => setTimeout(r, 20));
        ok('nifty50.parquet' in written, 'bytes cached after fallthrough');
    });
});

// ── Scenario 10: No ETag or Last-Modified in meta ────────────

describe('no ETag or Last-Modified in meta', () => {
    it('skips conditional GET and issues unconditional fetch', async () => {
        const cached = new Uint8Array([77]).buffer as ArrayBuffer;
        const files = cachedFiles('nifty50.parquet', cached, {}); // empty meta — no etag/lastModified
        const { dir } = makeMockDir(files);
        makeOpfsMock(dir);
        // If conditional GET were sent, a 304 would be returned — but we expect an unconditional GET instead
        setFetch(makeFetchMock([{ status: 200, body: BYTES }]));

        const result = await fetchWithCache('nifty50.parquet', 'data/nifty50.parquet');
        strictEqual(result.byteLength, BYTES.byteLength);
    });
});

// ── Scenario 11: OPFS write fails ────────────────────────────

describe('OPFS write fails', () => {
    it('still returns fetched bytes (write failure is non-fatal)', async () => {
        const files: MockFiles = {};
        const { dir } = makeMockDir(files, /* failWrite */ true);
        makeOpfsMock(dir);
        setFetch(makeFetchMock([{ status: 200, body: BYTES }]));

        const result = await fetchWithCache('nifty50.parquet', 'data/nifty50.parquet');
        strictEqual(result.byteLength, BYTES.byteLength);
    });
});

// ── Scenario 12: In-flight deduplication ─────────────────────

describe('in-flight deduplication', () => {
    it('two concurrent calls for same name issue only one fetch', async () => {
        const { dir } = makeMockDir({});
        makeOpfsMock(dir);
        let fetchCallCount = 0;
        (globalThis as Record<string, unknown>).fetch = async () => {
            fetchCallCount++;
            await new Promise(r => setTimeout(r, 5));
            return {
                ok: true, status: 200,
                arrayBuffer: async () => BYTES,
                headers: { get: () => null },
            } as unknown as Response;
        };

        const [r1, r2] = await Promise.all([
            fetchWithCache('nifty50.parquet', 'data/nifty50.parquet'),
            fetchWithCache('nifty50.parquet', 'data/nifty50.parquet'),
        ]);
        strictEqual(fetchCallCount, 1, 'fetch called only once');
        strictEqual(r1.byteLength, BYTES.byteLength);
        strictEqual(r2.byteLength, BYTES.byteLength);
    });
});

// ── Scenario 13: Filename sanitisation ───────────────────────

describe('filename sanitisation', () => {
    it('slashes become __ in OPFS key', async () => {
        const files: MockFiles = {};
        const { dir, written } = makeMockDir(files);
        makeOpfsMock(dir);
        setFetch(makeFetchMock([{ status: 200, body: BYTES }]));

        await fetchWithCache(
            'stock_prices/RELIANCE.parquet',
            'data/stock_prices/RELIANCE.parquet'
        );
        await new Promise(r => setTimeout(r, 20));
        ok('stock_prices__RELIANCE.parquet' in written, 'sanitised key used for data file');
        ok('stock_prices__RELIANCE.parquet.meta' in written, 'sanitised key used for meta file');
    });
});
```

- [ ] **Step 2: Run tests — expect failure (module not yet created)**

```bash
cd /home/agent/projects/foliozzz && node --experimental-strip-types --experimental-transform-types --test tests/opfs-cache.test.ts 2>&1 | head -5
```

Expected: `Error: Cannot find module '../src/opfs-cache.ts'`

---

### Task 2: Implement `src/opfs-cache.ts`

**Files:**
- Create: `src/opfs-cache.ts`

- [ ] **Step 1: Create the module**

```typescript
// src/opfs-cache.ts

// ── Module-level singletons ──────────────────────────────────

let opfsDirPromise: Promise<FileSystemDirectoryHandle | null> | undefined;
const inFlight = new Map<string, Promise<ArrayBuffer>>();

// ── Filename sanitisation ────────────────────────────────────

function sanitiseName(name: string): string {
    return name.replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '_');
}

// OPFS storage keys:
//   data  → safeName            (e.g. "nifty50.parquet")
//   meta  → safeName + ".meta"  (e.g. "nifty50.parquet.meta")

// ── OPFS availability (Promise singleton) ────────────────────

function getOpfsDir(): Promise<FileSystemDirectoryHandle | null> {
    if (!opfsDirPromise) {
        opfsDirPromise = (async () => {
            try {
                const root = await navigator.storage.getDirectory();
                const dir = await root.getDirectoryHandle('parquet-cache', { create: true });
                // Probe actual write access — some private-browsing modes allow
                // getDirectory() but silently fail on writes.
                const sentinel = await dir.getFileHandle('__probe__', { create: true });
                const w = await sentinel.createWritable();
                await w.write(new Uint8Array([0]));
                await w.close();
                await dir.removeEntry('__probe__');
                return dir;
            } catch {
                return null;
            }
        })();
    }
    return opfsDirPromise;
}

// ── OPFS read helpers ────────────────────────────────────────

async function readMeta(
    dir: FileSystemDirectoryHandle,
    safeName: string
): Promise<{ etag?: string; lastModified?: string } | null> {
    try {
        const fh = await dir.getFileHandle(safeName + '.meta');
        const file = await fh.getFile();
        return JSON.parse(await file.text());
    } catch {
        return null;
    }
}

async function readBytes(
    dir: FileSystemDirectoryHandle,
    safeName: string
): Promise<ArrayBuffer | null> {
    try {
        const fh = await dir.getFileHandle(safeName);
        const file = await fh.getFile();
        return await file.arrayBuffer();
    } catch {
        return null;
    }
}

// ── OPFS write (fire-and-forget) ─────────────────────────────

function writeToCache(
    dir: FileSystemDirectoryHandle,
    safeName: string,
    bytes: ArrayBuffer,
    meta: { etag?: string; lastModified?: string }
): void {
    // Bytes written first; if meta write fails, next load treats entry as missing
    // and re-fetches unconditionally — safe by design.
    (async () => {
        try {
            const dataFh = await dir.getFileHandle(safeName, { create: true });
            const dataW = await dataFh.createWritable();
            await dataW.write(bytes);
            await dataW.close();

            const metaFh = await dir.getFileHandle(safeName + '.meta', { create: true });
            const metaW = await metaFh.createWritable();
            await metaW.write(JSON.stringify(meta));
            await metaW.close();
        } catch (e) {
            console.warn('[opfs-cache] write failed:', e);
        }
    })();
}

async function evict(dir: FileSystemDirectoryHandle, safeName: string): Promise<void> {
    await Promise.all([
        dir.removeEntry(safeName).catch(() => {}),
        dir.removeEntry(safeName + '.meta').catch(() => {}),
    ]);
}

// ── Public API ───────────────────────────────────────────────

export async function fetchWithCache(name: string, url: string): Promise<ArrayBuffer> {
    const safeName = sanitiseName(name);

    const existing = inFlight.get(safeName);
    if (existing) return existing;

    const promise = _fetch(url, safeName);
    inFlight.set(safeName, promise);
    promise.finally(() => inFlight.delete(safeName));
    return promise;
}

async function _fetch(url: string, safeName: string): Promise<ArrayBuffer> {
    const dir = await getOpfsDir();

    // OPFS unavailable — plain fetch, no caching
    if (!dir) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
        return res.arrayBuffer();
    }

    const meta = await readMeta(dir, safeName);

    if (meta) {
        // Only send conditional headers if we have something to validate against
        const headers: Record<string, string> = {};
        if (meta.etag) headers['If-None-Match'] = meta.etag;
        else if (meta.lastModified) headers['If-Modified-Since'] = meta.lastModified;

        // If no validators, skip conditional GET — fall through to unconditional GET below
        if (Object.keys(headers).length > 0) {
            let res: Response | null = null;
            let networkErr: unknown = null;

            try {
                res = await fetch(url, { headers });
            } catch (e) {
                networkErr = e;
            }

            if (networkErr || (res && res.status >= 500)) {
                const cached = await readBytes(dir, safeName);
                if (cached) return cached;
                if (networkErr) throw networkErr;
                throw new Error(`Failed to fetch ${url}: ${res!.status}`);
            }

            if (res!.status >= 400) {
                await evict(dir, safeName);
                throw new Error(`Failed to fetch ${url}: ${res!.status}`);
            }

            if (res!.status === 304) {
                const cached = await readBytes(dir, safeName);
                if (cached) return cached;
                // Bytes missing — fall through to unconditional GET
            } else {
                const bytes = await res!.arrayBuffer();
                writeToCache(dir, safeName, bytes, {
                    etag: res!.headers.get('etag') ?? undefined,
                    lastModified: res!.headers.get('last-modified') ?? undefined,
                });
                return bytes;
            }
        }
    }

    // Unconditional GET (no cache, no validators, or 304 with missing bytes)
    let res: Response;
    try {
        res = await fetch(url);
    } catch (e) {
        throw e;
    }
    if (!res!.ok) throw new Error(`Failed to fetch ${url}: ${res!.status}`);
    const bytes = await res!.arrayBuffer();
    writeToCache(dir, safeName, bytes, {
        etag: res!.headers.get('etag') ?? undefined,
        lastModified: res!.headers.get('last-modified') ?? undefined,
    });
    return bytes;
}

// ── Test reset ───────────────────────────────────────────────

export function _resetForTesting(): void {
    opfsDirPromise = undefined;
    inFlight.clear();
}
```

- [ ] **Step 2: Run opfs-cache tests — expect all to pass**

```bash
cd /home/agent/projects/foliozzz && node --experimental-strip-types --experimental-transform-types --test tests/opfs-cache.test.ts 2>&1
```

Expected: All 13 test scenarios pass (✓). No failures.

- [ ] **Step 3: Commit**

```bash
cd /home/agent/projects/foliozzz && git add src/opfs-cache.ts tests/opfs-cache.test.ts && git commit -m "feat: Add OPFS parquet cache with ETag validation and offline fallback"
```

---

## Chunk 2: Wire `fetchWithCache` into `registerParquet`

### Task 3: Modify `registerParquet` in `duckdb-module.ts`

**Files:**
- Modify: `src/duckdb-module.ts`

- [ ] **Step 1: Add import and update `registerParquet`**

At the top of `src/duckdb-module.ts`, after the existing `import type { DB }` line, add:

```typescript
import { fetchWithCache } from './opfs-cache.ts';
```

Replace the body of `registerParquet` (the 8 lines starting at `export async function registerParquet`):

```typescript
export async function registerParquet(name: string, url: string): Promise<void> {
    if (!db) throw new Error('DuckDB not initialized. Call initDuckDB() first.');
    const buffer = await fetchWithCache(name, url);
    await (db as unknown as { registerFileBuffer(name: string, buffer: Uint8Array): Promise<void> })
        .registerFileBuffer(name, new Uint8Array(buffer));
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/agent/projects/foliozzz && npx tsc --noEmit 2>&1
```

Expected: No errors.

- [ ] **Step 3: Update `package.json` test:unit to include opfs-cache tests**

In `package.json`, replace the `test:unit` script value:

Old:
```
"test:unit": "node --experimental-strip-types --experimental-transform-types --test tests/portfolio.test.ts"
```

New:
```
"test:unit": "node --experimental-strip-types --experimental-transform-types --test tests/portfolio.test.ts tests/opfs-cache.test.ts"
```

- [ ] **Step 4: Run full unit test suite**

```bash
cd /home/agent/projects/foliozzz && npm run test:unit 2>&1
```

Expected: All tests pass (portfolio tests + opfs-cache tests).

- [ ] **Step 5: Build**

```bash
cd /home/agent/projects/foliozzz && npm run build 2>&1
```

Expected: `app.js` and `duckdb-module.js` built successfully, no errors.

- [ ] **Step 6: Commit**

```bash
cd /home/agent/projects/foliozzz && git add src/duckdb-module.ts package.json && git commit -m "feat: Wire OPFS cache into registerParquet"
```

---

## Chunk 3: Push

- [ ] **Push to GitHub**

```bash
cd /home/agent/projects/foliozzz && git push
```

Expected: Commits pushed to `origin/master`.
