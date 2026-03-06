// Type declarations for @duckdb/duckdb-wasm loaded via CDN
// We declare just enough to type-check our usage without installing the full package.
// The CDN URL import — TypeScript can't resolve this, so we use a dynamic import
// and cast to our interface. The compiled JS will keep the URL string as-is.
const DUCKDB_CDN_URL = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm';
let duckdbModule = null;
let db = null;
let conn = null;
async function loadDuckDB() {
    if (duckdbModule)
        return duckdbModule;
    duckdbModule = await import(/* @vite-ignore */ DUCKDB_CDN_URL);
    return duckdbModule;
}
export async function initDuckDB() {
    if (conn)
        return;
    const duckdb = await loadDuckDB();
    const BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(BUNDLES);
    const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger();
    db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    conn = await db.connect();
}
export function getConnection() {
    if (!conn)
        throw new Error('DuckDB not initialized. Call initDuckDB() first.');
    return conn;
}
export function getDB() {
    if (!db)
        throw new Error('DuckDB not initialized. Call initDuckDB() first.');
    return db;
}
export async function runSQL(sql) {
    if (!conn)
        throw new Error('DuckDB not initialized. Call initDuckDB() first.');
    await conn.query(sql);
}
export async function runQuery(sql) {
    if (!conn)
        throw new Error('DuckDB not initialized. Call initDuckDB() first.');
    const arrowResult = await conn.query(sql);
    return arrowToObjects(arrowResult);
}
function arrowToObjects(arrowTable) {
    const rows = [];
    const schema = arrowTable.schema.fields;
    const numRows = arrowTable.numRows;
    for (let i = 0; i < numRows; i++) {
        const row = {};
        for (const field of schema) {
            const col = arrowTable.getChild(field.name);
            row[field.name] = convertArrowValue(col.get(i));
        }
        rows.push(row);
    }
    return rows;
}
function convertArrowValue(val) {
    if (val === null || val === undefined)
        return val;
    if (typeof val === 'bigint')
        return Number(val);
    if (typeof val === 'object' && val !== null && !(val instanceof Date)) {
        const obj = val;
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
export function isReady() {
    return conn !== null;
}
export async function closeDuckDB() {
    if (conn) {
        await conn.close();
        conn = null;
    }
    if (db) {
        await db.terminate();
        db = null;
    }
}
