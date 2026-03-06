/**
 * OLAP cube layer for portfolio analysis.
 *
 * Architecture:
 *   ┌─────────────┐     ┌──────────────┐     ┌────────────────┐
 *   │ transactions │ ──► │ FIFO engine  │ ──► │ Fact tables    │
 *   │ (raw input)  │     │ (sql.ts CTEs)│     │ (materialized) │
 *   └─────────────┘     └──────────────┘     └───────┬────────┘
 *                                                     │
 *                        ┌──────────────┐             │
 *                        │  Dimensions  │◄────────────┘
 *                        │  (calendar,  │    JOIN for
 *                        │   stock)     │    slice & dice
 *                        └──────────────┘
 *
 * Fact tables (materialized after each CSV upload):
 *   fact_trades    — one row per FIFO-matched trade (realized PnL)
 *   fact_positions — one row per remaining lot (current holdings)
 *
 * Dimension tables:
 *   dim_calendar — date → week, month, quarter, year
 *   dim_stock    — isin → name, sector, industry (enrichable)
 *
 * Slice queries use fact+dimension JOINs with GROUP BY for any cut:
 *   by stock, by sector, by week/month, best/worst periods, concentration
 */

import { FIFO_CTES } from './sql.ts';

// ── Dimension tables ────────────────────────────────────────

export const CREATE_DIM_CALENDAR = `
    CREATE OR REPLACE TABLE dim_calendar AS
    WITH RECURSIVE bounds AS (
        SELECT MIN(date) AS min_d, MAX(date) AS max_d FROM transactions
    ),
    dates AS (
        SELECT min_d AS d, max_d FROM bounds
        UNION ALL
        SELECT d + INTERVAL 1 DAY, max_d FROM dates WHERE d < max_d
    )
    SELECT
        d::DATE                           AS date,
        EXTRACT(year    FROM d)::INTEGER  AS year,
        EXTRACT(quarter FROM d)::INTEGER  AS quarter,
        EXTRACT(month   FROM d)::INTEGER  AS month,
        EXTRACT(week    FROM d)::INTEGER  AS week,
        EXTRACT(dow     FROM d)::INTEGER  AS day_of_week,
        STRFTIME(d, '%Y-%m')              AS year_month,
        STRFTIME(d, '%Y-W') || LPAD(EXTRACT(week FROM d)::VARCHAR, 2, '0') AS year_week,
        STRFTIME(d, '%Y-Q') || EXTRACT(quarter FROM d) AS year_quarter
    FROM dates`;

export const CREATE_DIM_STOCK = `
    CREATE OR REPLACE TABLE dim_stock AS
    SELECT DISTINCT
        isin,
        NULL::VARCHAR AS name,
        NULL::VARCHAR AS sector,
        NULL::VARCHAR AS industry
    FROM transactions`;

// ── Fact tables (materialized from FIFO engine) ─────────────

export const CREATE_FACT_TRADES = `
    CREATE OR REPLACE TABLE fact_trades AS
    WITH ${FIFO_CTES}
    SELECT
        ROW_NUMBER() OVER (ORDER BY sell_date, isin, buy_price) AS trade_id,
        isin,
        buy_date,
        sell_date,
        buy_price,
        sell_price,
        matched_qty                                AS quantity,
        matched_qty * buy_price                    AS cost_basis,
        matched_qty * sell_price                   AS proceeds,
        matched_qty * (sell_price - buy_price)     AS pnl,
        CASE WHEN buy_price > 0
            THEN (sell_price - buy_price) / buy_price * 100
            ELSE 0
        END                                        AS return_pct,
        DATEDIFF('day', buy_date, sell_date)       AS holding_days
    FROM fifo_matches`;

export const CREATE_FACT_POSITIONS = `
    CREATE OR REPLACE TABLE fact_positions AS
    WITH ${FIFO_CTES}
    SELECT
        isin,
        date       AS buy_date,
        cost_basis,
        shares     AS quantity,
        shares * cost_basis AS value_at_cost
    FROM remaining_lots
    WHERE shares > 0`;

// ── Materialization (call after loading transactions) ───────

export const MATERIALIZE_ALL = [
    CREATE_DIM_CALENDAR,
    CREATE_DIM_STOCK,
    CREATE_FACT_TRADES,
    CREATE_FACT_POSITIONS
];

// ── Slice query builders ────────────────────────────────────
//
// Each returns a SQL string. Filters are optional WHERE clauses.
// New slices can be added by following the same pattern:
//   JOIN fact table(s) with dimension(s), GROUP BY dimension column(s).

export interface CubeFilter {
    isin?: string;
    sector?: string;
    dateFrom?: string;
    dateTo?: string;
}

function whereClause(filter?: CubeFilter, dateCol = 't.sell_date'): string {
    if (!filter) return '';
    const clauses: string[] = [];
    if (filter.isin)     clauses.push(`t.isin = '${filter.isin}'`);
    if (filter.sector)   clauses.push(`s.sector = '${filter.sector}'`);
    if (filter.dateFrom) clauses.push(`${dateCol} >= '${filter.dateFrom}'`);
    if (filter.dateTo)   clauses.push(`${dateCol} <= '${filter.dateTo}'`);
    return clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';
}

// ── Slice: PnL by stock ─────────────────────────────────────

export function pnlByStock(filter?: CubeFilter): string {
    return `
    SELECT
        t.isin,
        s.name,
        s.sector,
        COUNT(*)              AS num_trades,
        SUM(t.quantity)       AS total_quantity,
        SUM(t.pnl)           AS total_pnl,
        SUM(t.cost_basis)    AS total_cost,
        SUM(t.proceeds)      AS total_proceeds,
        CASE WHEN SUM(t.cost_basis) > 0
            THEN SUM(t.pnl) / SUM(t.cost_basis) * 100
            ELSE 0
        END                   AS return_pct,
        AVG(t.holding_days)   AS avg_holding_days
    FROM fact_trades t
    LEFT JOIN dim_stock s ON t.isin = s.isin
    ${whereClause(filter)}
    GROUP BY t.isin, s.name, s.sector
    ORDER BY total_pnl DESC`;
}

// ── Slice: PnL by time period ───────────────────────────────

export type TimeGranularity = 'week' | 'month' | 'quarter' | 'year';

export function pnlByPeriod(granularity: TimeGranularity, filter?: CubeFilter): string {
    const col = {
        week: 'c.year_week',
        month: 'c.year_month',
        quarter: 'c.year_quarter',
        year: 'c.year'
    }[granularity];

    return `
    SELECT
        ${col}                AS period,
        COUNT(*)              AS num_trades,
        SUM(t.pnl)           AS total_pnl,
        SUM(t.proceeds)      AS total_proceeds,
        SUM(t.cost_basis)    AS total_cost
    FROM fact_trades t
    JOIN dim_calendar c ON t.sell_date = c.date
    ${whereClause(filter)}
    GROUP BY ${col}
    ORDER BY ${col}`;
}

// ── Slice: Best / worst periods ─────────────────────────────

export function topPeriods(
    granularity: TimeGranularity,
    direction: 'best' | 'worst',
    limit: number = 5,
    filter?: CubeFilter
): string {
    const col = {
        week: 'c.year_week',
        month: 'c.year_month',
        quarter: 'c.year_quarter',
        year: 'c.year'
    }[granularity];
    const order = direction === 'best' ? 'DESC' : 'ASC';

    return `
    SELECT
        ${col}                AS period,
        COUNT(*)              AS num_trades,
        SUM(t.pnl)           AS total_pnl
    FROM fact_trades t
    JOIN dim_calendar c ON t.sell_date = c.date
    ${whereClause(filter)}
    GROUP BY ${col}
    ORDER BY total_pnl ${order}
    LIMIT ${limit}`;
}

// ── Slice: Holdings concentration ───────────────────────────

export function holdingsConcentration(): string {
    return `
    SELECT
        p.isin,
        s.name,
        s.sector,
        SUM(p.quantity)       AS shares,
        SUM(p.value_at_cost)  AS value,
        SUM(p.value_at_cost) * 100.0
            / NULLIF(SUM(SUM(p.value_at_cost)) OVER (), 0) AS weight_pct
    FROM fact_positions p
    LEFT JOIN dim_stock s ON p.isin = s.isin
    GROUP BY p.isin, s.name, s.sector
    ORDER BY value DESC`;
}

// ── Slice: PnL by sector ────────────────────────────────────

export function pnlBySector(filter?: CubeFilter): string {
    return `
    SELECT
        COALESCE(s.sector, 'Unknown') AS sector,
        COUNT(*)              AS num_trades,
        COUNT(DISTINCT t.isin) AS num_stocks,
        SUM(t.pnl)           AS total_pnl,
        CASE WHEN SUM(t.cost_basis) > 0
            THEN SUM(t.pnl) / SUM(t.cost_basis) * 100
            ELSE 0
        END                   AS return_pct
    FROM fact_trades t
    LEFT JOIN dim_stock s ON t.isin = s.isin
    ${whereClause(filter)}
    GROUP BY COALESCE(s.sector, 'Unknown')
    ORDER BY total_pnl DESC`;
}

// ── Slice: Trade-level detail ───────────────────────────────

export function tradeDetail(filter?: CubeFilter): string {
    return `
    SELECT
        t.trade_id,
        t.isin,
        s.name,
        t.buy_date::VARCHAR   AS buy_date,
        t.sell_date::VARCHAR  AS sell_date,
        t.quantity,
        t.buy_price,
        t.sell_price,
        t.pnl,
        t.return_pct,
        t.holding_days
    FROM fact_trades t
    LEFT JOIN dim_stock s ON t.isin = s.isin
    ${whereClause(filter)}
    ORDER BY t.sell_date DESC, t.pnl DESC`;
}
