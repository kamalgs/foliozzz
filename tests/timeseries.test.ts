import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DB } from '../src/types.ts';
import { DAILY_VALUATION_SQL } from '../src/timeseries.ts';

const require = createRequire(import.meta.url);
const duckdb = require('duckdb');

function createDB(): { db: DB; close: () => void } {
    const raw = new duckdb.Database(':memory:');
    const conn = raw.connect();
    const db: DB = {
        exec: (sql: string) => new Promise<void>((res, rej) =>
            conn.exec(sql, (e: Error | null) => e ? rej(e) : res())),
        query: (sql: string) => new Promise<Record<string, unknown>[]>((res, rej) =>
            conn.all(sql, (e: Error | null, r: Record<string, unknown>[]) => e ? rej(e) : res(r)))
    };
    return { db, close: () => raw.close() };
}

async function setupWithPrices(db: DB, transactions: string): Promise<void> {
    await db.exec(`CREATE TABLE transactions (
        seq INTEGER, date DATE, isin VARCHAR, quantity DOUBLE, price DOUBLE, type VARCHAR
    )`);
    await db.exec(`INSERT INTO transactions VALUES ${transactions}`);

    await db.exec(`CREATE TABLE stock_prices (date DATE, symbol VARCHAR, isin VARCHAR, close DOUBLE)`);

    const isins = await db.query('SELECT DISTINCT isin FROM transactions');
    const isinMap: Record<string, string> = {
        'INE002A01018': 'RELIANCE',
        'INE009A01013': 'INFY'
    };
    for (const row of isins) {
        const isin = String(row.isin);
        const sym = isinMap[isin];
        if (!sym) continue;
        await db.exec(`
            INSERT INTO stock_prices
            SELECT date, symbol, '${isin}' as isin, close
            FROM parquet_scan('data/stock_prices/${sym}.parquet')
            WHERE close IS NOT NULL
        `);
    }
}

describe('Daily portfolio valuation', () => {
    it('produces daily data points between first and last transaction', async () => {
        const { db, close } = createDB();
        try {
            await setupWithPrices(db, `
                (0, '2024-01-15', 'INE002A01018', 10, 2500, 'BUY'),
                (1, '2024-02-20', 'INE009A01013', 5, 1450, 'BUY'),
                (2, '2024-03-10', 'INE002A01018', 5, 2700, 'SELL')
            `);

            const rows = await db.query(DAILY_VALUATION_SQL(100000));
            const series = rows.map(r => ({
                date: (r.date as Date).toISOString().slice(0, 10),
                cash: Number(r.cash),
                marketValue: Number(r.market_value),
                portfolioValue: Number(r.portfolio_value),
                returnPct: Number(r.return_pct)
            }));

            // Should have many daily data points (trading days ~40)
            assert.ok(series.length > 30, `Expected >30 daily points, got ${series.length}`);

            // First day: bought 10 RELIANCE @ 2500 = 25000, cash = 75000
            assert.equal(series[0].cash, 75000);
            assert.ok(series[0].marketValue > 0, 'Should have market value from stock price');

            // After Feb 20 buy: cash = 75000 - 5*1450 = 67750
            const afterFebBuy = series.find(s => s.date >= '2024-02-20');
            assert.ok(afterFebBuy, 'Should have data on/after Feb 20');
            assert.equal(afterFebBuy!.cash, 67750);

            // After Mar 10 sell: cash = 67750 + 5*2700 = 81250
            const afterSell = series.find(s => s.date >= '2024-03-10');
            assert.ok(afterSell, 'Should have data on/after sell date');
            assert.equal(afterSell!.cash, 81250);
        } finally {
            close();
        }
    });

    it('market value varies daily based on stock prices', async () => {
        const { db, close } = createDB();
        try {
            await setupWithPrices(db, `
                (0, '2024-01-15', 'INE002A01018', 10, 2500, 'BUY'),
                (1, '2024-03-15', 'INE002A01018', 2, 2600, 'BUY')
            `);

            const rows = await db.query(DAILY_VALUATION_SQL(100000));
            const series = rows.map(r => ({
                returnPct: Number(r.return_pct)
            }));

            assert.ok(series.length > 0, 'Should have data');
            const unique = new Set(series.map(r => r.returnPct.toFixed(4)));
            assert.ok(unique.size > 1, `Returns should vary daily, got ${unique.size} unique values`);
        } finally {
            close();
        }
    });

    it('holdings reduce after sell', async () => {
        const { db, close } = createDB();
        try {
            await setupWithPrices(db, `
                (0, '2024-01-15', 'INE002A01018', 10, 2500, 'BUY'),
                (1, '2024-03-01', 'INE002A01018', 10, 2700, 'SELL')
            `);

            const rows = await db.query(DAILY_VALUATION_SQL(100000));
            const series = rows.map(r => ({
                date: (r.date as Date).toISOString().slice(0, 10),
                marketValue: Number(r.market_value),
                cash: Number(r.cash)
            }));

            // After selling all shares, market value should be 0
            const afterSell = series.find(s => s.date >= '2024-03-01');
            assert.ok(afterSell, 'Should have post-sell data');
            assert.equal(afterSell!.marketValue, 0, 'No holdings after full sell');
            // Cash = 100000 - 25000 + 27000 = 102000
            assert.equal(afterSell!.cash, 102000);
        } finally {
            close();
        }
    });
});
