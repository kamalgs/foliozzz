/**
 * DuckDB WASM Module
 * Isolated module for initializing and interacting with DuckDB WebAssembly.
 *
 * Usage:
 *   import { initDuckDB, runQuery, runSQL, getConnection } from './duckdb-module.js';
 *   await initDuckDB();
 *   const rows = await runQuery('SELECT 1 as num');
 *   // rows = [{ num: 1 }]
 */

import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm';

let db = null;
let conn = null;

/**
 * Initialize DuckDB WASM. Must be called once before any queries.
 * @returns {Promise<void>}
 */
export async function initDuckDB() {
    if (conn) return; // Already initialized

    // Select the best bundle for this browser
    const BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(BUNDLES);

    // Create a Blob URL worker to bypass cross-origin Worker restriction.
    // Browsers block `new Worker(cdnUrl)` from a different origin, so we
    // wrap it via importScripts in a same-origin blob.
    const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger();

    // Instantiate the database
    db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

    // Open a connection
    conn = await db.connect();
}

/**
 * Get the raw DuckDB connection (for advanced usage).
 * @returns {AsyncDuckDBConnection}
 */
export function getConnection() {
    if (!conn) throw new Error('DuckDB not initialized. Call initDuckDB() first.');
    return conn;
}

/**
 * Get the raw DuckDB instance (for registering files, etc).
 * @returns {AsyncDuckDB}
 */
export function getDB() {
    if (!db) throw new Error('DuckDB not initialized. Call initDuckDB() first.');
    return db;
}

/**
 * Run a SQL statement that doesn't return results (CREATE, INSERT, DROP, etc).
 * @param {string} sql
 * @returns {Promise<void>}
 */
export async function runSQL(sql) {
    if (!conn) throw new Error('DuckDB not initialized. Call initDuckDB() first.');
    await conn.query(sql);
}

/**
 * Run a SQL query and return results as an array of plain JS objects.
 * DuckDB WASM returns Apache Arrow tables; this converts them for convenience.
 * @param {string} sql
 * @returns {Promise<Object[]>}
 */
export async function runQuery(sql) {
    if (!conn) throw new Error('DuckDB not initialized. Call initDuckDB() first.');
    const arrowResult = await conn.query(sql);
    return arrowToObjects(arrowResult);
}

/**
 * Convert an Apache Arrow table to an array of plain JS objects.
 * @param {Table} arrowTable
 * @returns {Object[]}
 */
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

/**
 * Convert Arrow values to plain JS types.
 * - BigInt -> Number (safe for portfolio-scale values)
 * - HUGEINT/DECIMAL objects (Uint32Array-like with numeric toString) -> Number
 * - Date objects stay as-is
 */
function convertArrowValue(val) {
    if (val === null || val === undefined) return val;
    if (typeof val === 'bigint') return Number(val);
    if (typeof val === 'object' && typeof val.toString === 'function' && !(val instanceof Date)) {
        // Arrow HUGEINT/DECIMAL are objects whose toString() gives the numeric value
        const str = val.toString();
        if (str !== '' && str !== '[object Object]' && !isNaN(str)) {
            return Number(str);
        }
    }
    if (typeof val === 'string' && val !== '' && !isNaN(val)) {
        return Number(val);
    }
    return val;
}

/**
 * Check if DuckDB is initialized and ready.
 * @returns {boolean}
 */
export function isReady() {
    return conn !== null;
}

/**
 * Close the connection and terminate the worker.
 * @returns {Promise<void>}
 */
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
