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
    promise.then(
        () => inFlight.delete(safeName),
        () => inFlight.delete(safeName),
    );
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
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    const bytes = await res.arrayBuffer();
    writeToCache(dir, safeName, bytes, {
        etag: res.headers.get('etag') ?? undefined,
        lastModified: res.headers.get('last-modified') ?? undefined,
    });
    return bytes;
}

// ── Test reset ───────────────────────────────────────────────

export function _resetForTesting(): void {
    opfsDirPromise = undefined;
    inFlight.clear();
}
