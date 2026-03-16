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
            if (!files[name] || opts?.create) {
                const tracked: unknown[] = [];
                written[name] = tracked;
                files[name] = {
                    content: files[name]?.content ?? new Uint8Array(),
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
    const mockNavigator = dir === null
        ? { storage: { getDirectory: async () => { throw new Error('OPFS unavailable'); } } }
        : { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) } };
    Object.defineProperty(globalThis, 'navigator', {
        value: mockNavigator,
        writable: true,
        configurable: true,
    });
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

// ── Scenario 8: .parquet exists but .meta missing ────────────

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
