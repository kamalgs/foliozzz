import type { DB } from './types.ts';
import { fetchWithCache } from './opfs-cache.ts';

interface ArrowField { name: string; }
interface ArrowSchema { fields: ArrowField[]; }
interface ArrowColumn { get(index: number): unknown; }
interface ArrowTable {
    schema: ArrowSchema;
    numRows: number;
    getChild(name: string): ArrowColumn;
}

interface DuckDBConnection {
    query(sql: string): Promise<ArrowTable>;
    close(): Promise<void>;
}

interface DuckDBInstance {
    instantiate(mainModule: string, pthreadWorker?: string | null): Promise<void>;
    connect(): Promise<DuckDBConnection>;
    terminate(): Promise<void>;
}

interface DuckDBBundle {
    mainModule: string;
    mainWorker: string | null;
    pthreadWorker: string | null;
}

interface DuckDBModule {
    getJsDelivrBundles(): Record<string, DuckDBBundle>;
    selectBundle(bundles: Record<string, DuckDBBundle>): Promise<DuckDBBundle>;
    ConsoleLogger: new () => unknown;
    AsyncDuckDB: new (logger: unknown, worker: Worker) => DuckDBInstance;
}

const DUCKDB_CDN_URL = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm';

let duckdbModule: DuckDBModule | null = null;
let db: DuckDBInstance | null = null;
let conn: DuckDBConnection | null = null;

async function loadDuckDB(): Promise<DuckDBModule> {
    if (duckdbModule) return duckdbModule;
    duckdbModule = await import(/* @vite-ignore */ DUCKDB_CDN_URL) as unknown as DuckDBModule;
    return duckdbModule;
}

export async function initDuckDB(): Promise<void> {
    if (conn) return;

    const duckdb = await loadDuckDB();
    const BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(BUNDLES);

    const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger();

    db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    conn = await db.connect();
}

export function isReady(): boolean {
    return conn !== null;
}

export async function runSQL(sql: string): Promise<void> {
    if (!conn) throw new Error('DuckDB not initialized. Call initDuckDB() first.');
    await conn.query(sql);
}

export async function runQuery(sql: string): Promise<Record<string, unknown>[]> {
    if (!conn) throw new Error('DuckDB not initialized. Call initDuckDB() first.');
    const arrowResult = await conn.query(sql);
    return arrowToObjects(arrowResult);
}

export function getConnection(): DuckDBConnection {
    if (!conn) throw new Error('DuckDB not initialized. Call initDuckDB() first.');
    return conn;
}

export function getDB(): DuckDBInstance {
    if (!db) throw new Error('DuckDB not initialized. Call initDuckDB() first.');
    return db;
}

export async function registerParquet(name: string, url: string): Promise<void> {
    if (!db) throw new Error('DuckDB not initialized. Call initDuckDB() first.');
    const buffer = await fetchWithCache(name, url);
    await (db as unknown as { registerFileBuffer(name: string, buffer: Uint8Array): Promise<void> })
        .registerFileBuffer(name, new Uint8Array(buffer));
}

export async function closeDuckDB(): Promise<void> {
    if (conn) { await conn.close(); conn = null; }
    if (db) { await db.terminate(); db = null; }
}

export function asDB(): DB {
    return { exec: runSQL, query: runQuery };
}

function arrowToObjects(arrowTable: ArrowTable): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = [];
    const schema = arrowTable.schema.fields;
    const numRows = arrowTable.numRows;
    for (let i = 0; i < numRows; i++) {
        const row: Record<string, unknown> = {};
        for (const field of schema) {
            const col = arrowTable.getChild(field.name);
            row[field.name] = convertArrowValue(col.get(i));
        }
        rows.push(row);
    }
    return rows;
}

function convertArrowValue(val: unknown): unknown {
    if (val === null || val === undefined) return val;
    if (typeof val === 'bigint') return Number(val);
    if (typeof val === 'object' && val !== null && !(val instanceof Date)) {
        const obj = val as { toString?: () => string };
        if (typeof obj.toString === 'function') {
            const str = obj.toString();
            if (str !== '' && str !== '[object Object]' && !isNaN(Number(str))) {
                return Number(str);
            }
        }
    }
    if (typeof val === 'string' && val !== '' && !isNaN(Number(val))) {
        return Number(val);
    }
    return val;
}
