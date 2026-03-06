/**
 * SQL query definitions for portfolio analysis.
 *
 * Architecture (layered CTEs):
 *   Layer 1: buy_lots / sell_orders — cumulative quantity ranges per ISIN
 *   Layer 2: fifo_matches — FIFO lot matching via range overlap
 *   Layer 3: remaining_lots — unsold shares per lot
 *   Layer 4: Derived queries (stats, time series, holdings, sell details)
 *
 * FIFO insight: each buy lot spans a range [cum_before, cum_after) in
 * cumulative-quantity space per ISIN. Sell orders span similar ranges.
 * The overlap between a buy range and a sell range gives the FIFO-matched
 * quantity. This is purely declarative — no mutation or iteration needed.
 */

// ── Shared CTE chain (reused by all analysis queries) ──────

const FIFO_CTES = `
    -- Layer 1a: Buy lots with cumulative quantity ranges per ISIN
    buy_lots AS (
        SELECT isin, date, price, quantity,
            SUM(quantity) OVER (PARTITION BY isin ORDER BY seq) - quantity AS cum_before,
            SUM(quantity) OVER (PARTITION BY isin ORDER BY seq) AS cum_after
        FROM transactions
        WHERE type = 'BUY'
    ),

    -- Layer 1b: Sell orders with cumulative quantity ranges per ISIN
    sell_orders AS (
        SELECT isin, date, price, quantity,
            SUM(quantity) OVER (PARTITION BY isin ORDER BY seq) - quantity AS cum_before,
            SUM(quantity) OVER (PARTITION BY isin ORDER BY seq) AS cum_after
        FROM transactions
        WHERE type = 'SELL'
    ),

    -- Layer 2: FIFO matching via cumulative range overlap
    fifo_matches AS (
        SELECT
            b.isin,
            b.date AS buy_date, b.price AS buy_price,
            s.date AS sell_date, s.price AS sell_price,
            LEAST(b.cum_after, s.cum_after)
                - GREATEST(b.cum_before, s.cum_before) AS matched_qty
        FROM buy_lots b
        JOIN sell_orders s
            ON  b.isin = s.isin
            AND b.cum_before < s.cum_after
            AND s.cum_before < b.cum_after
    ),

    -- Layer 3a: Total sold per ISIN
    sold_per_isin AS (
        SELECT isin, SUM(quantity) AS total_sold
        FROM transactions
        WHERE type = 'SELL'
        GROUP BY isin
    ),

    -- Layer 3b: Remaining shares per buy lot after FIFO consumption
    --   Formula: remaining = max(0, cum_after - max(cum_before, total_sold))
    remaining_lots AS (
        SELECT
            b.isin, b.date, b.price AS cost_basis,
            GREATEST(0,
                b.cum_after - GREATEST(b.cum_before, COALESCE(s.total_sold, 0))
            ) AS shares
        FROM buy_lots b
        LEFT JOIN sold_per_isin s ON b.isin = s.isin
    )`;

// ── Table management ────────────────────────────────────────

export const DROP_TABLE = 'DROP TABLE IF EXISTS transactions';

export const CREATE_TABLE = `
    CREATE TABLE transactions (
        seq INTEGER,
        date DATE,
        isin VARCHAR,
        quantity DOUBLE,
        price DOUBLE,
        type VARCHAR
    )`;

// ── Layer 4: Portfolio statistics ───────────────────────────

export function statsQuery(cap: number): string {
    return `
WITH ${FIFO_CTES},

raw AS (
    SELECT
        COALESCE(SUM(CASE WHEN type = 'BUY'  THEN quantity * price END), 0) AS total_invested,
        COALESCE(SUM(CASE WHEN type = 'SELL' THEN quantity * price END), 0) AS total_proceeds,
        (SELECT COALESCE(SUM(matched_qty * (sell_price - buy_price)), 0)
         FROM fifo_matches) AS realized_pnl,
        (SELECT COALESCE(SUM(shares * cost_basis), 0)
         FROM remaining_lots WHERE shares > 0) AS cost_basis_remaining,
        (SELECT COUNT(DISTINCT isin)
         FROM remaining_lots WHERE shares > 0) AS num_stocks,
        MIN(date) AS first_date,
        MAX(date) AS last_date,
        DATEDIFF('day', MIN(date), MAX(date)) AS holding_days
    FROM transactions
)

SELECT
    total_invested,
    total_proceeds,
    realized_pnl,
    cost_basis_remaining,
    num_stocks,
    first_date::VARCHAR AS first_date,
    last_date::VARCHAR  AS last_date,
    holding_days,
    ${cap} - total_invested + total_proceeds AS cash_balance,
    ${cap} - total_invested + total_proceeds + cost_basis_remaining AS portfolio_value,
    realized_pnl AS total_return,
    CASE WHEN ${cap} > 0
        THEN realized_pnl * 100.0 / ${cap}
        ELSE 0
    END AS total_return_pct,
    holding_days / 365.0 AS holding_years,
    CASE WHEN holding_days > 0
        THEN (POWER((${cap} + realized_pnl) * 1.0 / ${cap},
                     365.0 / holding_days) - 1) * 100
        ELSE 0
    END AS annualized_return_pct
FROM raw`;
}

// ── Layer 4: Time series ────────────────────────────────────

export function timeSeriesQuery(cap: number): string {
    return `
WITH ${FIFO_CTES},

-- Cost basis consumed by sells (FIFO), grouped by sell date
sell_cost_basis AS (
    SELECT sell_date AS date, SUM(matched_qty * buy_price) AS cost_sold
    FROM fifo_matches
    GROUP BY sell_date
),

-- Daily cash flows + cost consumed
date_flows AS (
    SELECT
        t.date,
        SUM(CASE WHEN t.type = 'BUY'  THEN t.quantity * t.price ELSE 0 END) AS buy_cost,
        SUM(CASE WHEN t.type = 'SELL' THEN t.quantity * t.price ELSE 0 END) AS sell_proceeds,
        COALESCE(MAX(scb.cost_sold), 0) AS cost_sold
    FROM transactions t
    LEFT JOIN sell_cost_basis scb ON t.date = scb.date
    GROUP BY t.date
)

SELECT
    date::VARCHAR AS date,
    ${cap} + SUM(sell_proceeds - buy_cost) OVER w AS cash,
    SUM(buy_cost - cost_sold) OVER w AS holdings_cost,
    ${cap} + SUM(sell_proceeds - buy_cost) OVER w
           + SUM(buy_cost - cost_sold) OVER w AS portfolio_value,
    CASE WHEN ${cap} > 0
        THEN (SUM(sell_proceeds - buy_cost) OVER w
            + SUM(buy_cost - cost_sold) OVER w) * 100.0 / ${cap}
        ELSE 0
    END AS return_pct
FROM date_flows
WINDOW w AS (ORDER BY date ROWS UNBOUNDED PRECEDING)
ORDER BY date`;
}

// ── Layer 4: Holdings detail ────────────────────────────────

export function holdingsQuery(): string {
    return `
WITH ${FIFO_CTES}
SELECT isin, cost_basis AS cost_basis, shares
FROM remaining_lots
WHERE shares > 0
ORDER BY isin, cost_basis`;
}

// ── Layer 4: Sell details (FIFO matches) ────────────────────

export function sellDetailsQuery(): string {
    return `
WITH ${FIFO_CTES}
SELECT
    sell_date::VARCHAR AS date,
    isin,
    matched_qty AS shares_sold,
    sell_price  AS sale_price,
    buy_price   AS cost_basis,
    matched_qty * (sell_price - buy_price) AS pnl
FROM fifo_matches
ORDER BY sell_date, isin, buy_price`;
}
