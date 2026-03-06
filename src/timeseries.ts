/**
 * Daily portfolio valuation using stock prices.
 *
 * For each trading date from first buy to last transaction:
 *   portfolio_value = cash + sum(shares_held_i * close_price_i)
 *
 * Holdings tracked via cumulative buys/sells.
 * Stock prices come from per-symbol parquet files.
 */

import type { DB } from './types.ts';
import { registerParquet } from './duckdb-module.ts';

let isinMap: Record<string, string> | null = null;

async function loadIsinMap(): Promise<Record<string, string>> {
    if (isinMap) return isinMap;
    const res = await fetch('data/isin_map.json');
    if (!res.ok) throw new Error('Failed to load ISIN map');
    isinMap = await res.json();
    return isinMap!;
}

export interface DailyValue {
    date: number;   // epoch ms
    value: number;  // portfolio market value
    cash: number;
    returnPct: number;
}

/**
 * Load stock price parquets for held ISINs into DuckDB.
 */
export async function loadStockPrices(db: DB, isinToSymbol: Record<string, string>): Promise<void> {
    await db.exec('DROP TABLE IF EXISTS stock_prices');
    await db.exec(`CREATE TABLE stock_prices (date DATE, symbol VARCHAR, isin VARCHAR, close DOUBLE)`);

    const isins = await db.query('SELECT DISTINCT isin FROM transactions');
    for (const row of isins) {
        const isin = String(row.isin);
        const symbol = isinToSymbol[isin];
        if (!symbol) continue;
        const filename = `${symbol}.parquet`;
        try {
            await registerParquet(`stock_prices/${filename}`, `data/stock_prices/${filename}`);
            await db.exec(`
                INSERT INTO stock_prices
                SELECT date, symbol, '${isin}' as isin, close
                FROM parquet_scan('stock_prices/${filename}')
                WHERE close IS NOT NULL
            `);
        } catch {
            // Stock price file not available
        }
    }
}

/** SQL query that builds daily portfolio valuation. */
export const DAILY_VALUATION_SQL = (cap: number) => `
WITH
-- All unique trading dates from stock prices, plus transaction dates
all_dates AS (
    SELECT DISTINCT date FROM stock_prices
    UNION
    SELECT DISTINCT date FROM transactions
),
date_range AS (
    SELECT MIN(date) AS min_d, MAX(date) AS max_d FROM transactions
),
calendar AS (
    SELECT ad.date
    FROM all_dates ad, date_range dr
    WHERE ad.date >= dr.min_d AND ad.date <= dr.max_d
    ORDER BY ad.date
),
-- Net shares and cash flow per transaction date per ISIN
flows AS (
    SELECT
        date, isin,
        SUM(CASE WHEN type = 'BUY' THEN quantity ELSE -quantity END) AS net_shares,
        SUM(CASE WHEN type = 'BUY' THEN -quantity * price ELSE quantity * price END) AS net_cash
    FROM transactions
    GROUP BY date, isin
),
-- Cumulative shares per ISIN as of each calendar date
isin_list AS (SELECT DISTINCT isin FROM transactions),
holdings AS (
    SELECT
        c.date,
        il.isin,
        COALESCE((
            SELECT SUM(f.net_shares) FROM flows f
            WHERE f.isin = il.isin AND f.date <= c.date
        ), 0) AS shares
    FROM calendar c
    CROSS JOIN isin_list il
),
-- Cumulative cash
cash AS (
    SELECT
        c.date,
        ${cap} + COALESCE((
            SELECT SUM(f2.net_cash) FROM (
                SELECT date, SUM(net_cash) AS net_cash FROM flows GROUP BY date
            ) f2
            WHERE f2.date <= c.date
        ), 0) AS cash
    FROM calendar c
),
-- Market value of holdings
market_val AS (
    SELECT
        h.date,
        SUM(
            CASE WHEN h.shares > 0
                THEN h.shares * COALESCE(sp.close, 0)
                ELSE 0
            END
        ) AS market_value
    FROM holdings h
    LEFT JOIN stock_prices sp ON h.isin = sp.isin AND h.date = sp.date
    GROUP BY h.date
)
SELECT
    ca.date,
    ca.cash,
    COALESCE(mv.market_value, 0) AS market_value,
    ca.cash + COALESCE(mv.market_value, 0) AS portfolio_value,
    CASE WHEN ${cap} > 0
        THEN ((ca.cash + COALESCE(mv.market_value, 0)) - ${cap}) * 100.0 / ${cap}
        ELSE 0
    END AS return_pct
FROM cash ca
LEFT JOIN market_val mv ON ca.date = mv.date
ORDER BY ca.date
`;

export async function buildDailyTimeSeries(
    db: DB,
    initialCapital: number
): Promise<DailyValue[]> {
    const map = await loadIsinMap();
    await loadStockPrices(db, map);

    const rows = await db.query(DAILY_VALUATION_SQL(initialCapital));

    return rows.map(r => {
        const d = r.date;
        let ts: number;
        if (typeof d === 'number') ts = d;
        else if (d instanceof Date) ts = d.getTime();
        else ts = new Date(String(d)).getTime();
        return {
            date: ts,
            value: Number(r.portfolio_value) || 0,
            cash: Number(r.cash) || 0,
            returnPct: Number(r.return_pct) || 0
        };
    });
}
