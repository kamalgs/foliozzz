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

async function loadCorporateActions(db: DB): Promise<void> {
    await db.exec('DROP TABLE IF EXISTS corporate_actions');
    await db.exec(`CREATE TABLE corporate_actions (
        isin VARCHAR, ex_date DATE, ratio DOUBLE, action_type VARCHAR
    )`);
    try {
        await registerParquet('corporate_actions.parquet', 'data/corporate_actions.parquet');
        await db.exec(`
            INSERT INTO corporate_actions
            SELECT isin, ex_date, ratio, action_type
            FROM parquet_scan('corporate_actions.parquet')
            WHERE ratio > 1.0
        `);
    } catch {
        // File absent, empty table, VIEW returns unadjusted prices
    }
}

/**
 * Load stock price parquets for held ISINs into DuckDB as an adjusted VIEW.
 * Historical prices are divided by the cumulative ratio product of all corporate
 * actions (bonus/split) that occurred strictly after each price date.
 */
export async function loadStockPrices(db: DB, isinToSymbol: Record<string, string>): Promise<void> {
    await db.exec('DROP VIEW IF EXISTS stock_prices');
    await db.exec('DROP TABLE IF EXISTS stock_prices');

    const isins = await db.query('SELECT DISTINCT isin FROM transactions');
    const parts: string[] = [];

    for (const row of isins) {
        const isin = String(row.isin);
        const symbol = isinToSymbol[isin];
        if (!symbol) continue;
        const filename = `${symbol}.parquet`;
        const regName = `sp_${symbol}.parquet`;
        try {
            await registerParquet(regName, `data/stock_prices/${filename}`);
            // Validate the file is a readable parquet before adding to VIEW
            await db.query(`SELECT close FROM parquet_scan('${regName}') LIMIT 0`);    }

    if (parts.length === 0) {
        await db.exec(`CREATE VIEW stock_prices AS
            SELECT NULL::DATE AS date, NULL::VARCHAR AS symbol,
                   NULL::VARCHAR AS isin, NULL::DOUBLE AS close WHERE false`);
        return;
    }

    const raw = parts.join('\nUNION ALL\n');
    await db.exec(`
        CREATE VIEW stock_prices AS
        WITH raw AS (${raw})
        SELECT
            r.date,
            r.symbol,
            r.isin,
            r.close / COALESCE(EXP(SUM(LN(ca.ratio))), 1.0) AS close
        FROM raw r
        LEFT JOIN corporate_actions ca
               ON  ca.isin    = r.isin
               AND ca.ex_date >  r.date
               AND ca.ex_date <= CURRENT_DATE::DATE
        GROUP BY r.date, r.symbol, r.isin, r.close
    `);
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
    await loadCorporateActions(db);
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
