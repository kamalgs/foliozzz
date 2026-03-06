import type { Transaction, PortfolioStats, TimeSeriesPoint, Holding, SellDetail, DB } from './types.ts';
import * as SQL from './sql.ts';

export async function loadTransactions(db: DB, transactions: Transaction[]): Promise<void> {
    await db.exec(SQL.DROP_TABLE);
    await db.exec(SQL.CREATE_TABLE);

    if (transactions.length === 0) return;

    const batchSize = 1000;
    for (let i = 0; i < transactions.length; i += batchSize) {
        const batch = transactions.slice(i, i + batchSize);
        const values = batch.map((t, j) =>
            `(${i + j}, '${t.date}', '${t.isin}', ${t.quantity}, ${t.price}, '${t.type}')`
        ).join(', ');
        await db.exec(`INSERT INTO transactions VALUES ${values}`);
    }
}

export async function getStats(db: DB, initialCapital: number): Promise<PortfolioStats | null> {
    const rows = await db.query(SQL.statsQuery(initialCapital));
    if (rows.length === 0 || rows[0].first_date == null) return null;

    const r = rows[0];
    const holdings = await getHoldings(db);
    const sellDetails = await getSellDetails(db);

    return {
        totalInvested: Number(r.total_invested),
        totalProceeds: Number(r.total_proceeds),
        realizedPnL: Number(r.realized_pnl),
        costBasisRemaining: Number(r.cost_basis_remaining),
        cashBalance: Number(r.cash_balance),
        portfolioValue: Number(r.portfolio_value),
        totalReturn: Number(r.total_return),
        totalReturnPct: Number(r.total_return_pct),
        numStocks: Number(r.num_stocks),
        holdingDays: Number(r.holding_days),
        holdingYears: Number(r.holding_years),
        annualizedReturnPct: Number(r.annualized_return_pct),
        firstDate: String(r.first_date),
        lastDate: String(r.last_date),
        holdings,
        sellDetails
    };
}

export async function getTimeSeries(db: DB, initialCapital: number): Promise<TimeSeriesPoint[]> {
    const rows = await db.query(SQL.timeSeriesQuery(initialCapital));
    return rows.map(r => ({
        date: String(r.date),
        cash: Number(r.cash),
        holdingsCost: Number(r.holdings_cost),
        portfolioValue: Number(r.portfolio_value),
        returnPct: Number(r.return_pct)
    }));
}

export async function getHoldings(db: DB): Promise<Holding[]> {
    const rows = await db.query(SQL.holdingsQuery());
    return rows.map(r => ({
        isin: String(r.isin),
        shares: Number(r.shares),
        costBasis: Number(r.cost_basis)
    }));
}

export async function getSellDetails(db: DB): Promise<SellDetail[]> {
    const rows = await db.query(SQL.sellDetailsQuery());
    return rows.map(r => ({
        date: String(r.date),
        isin: String(r.isin),
        sharesSold: Number(r.shares_sold),
        salePrice: Number(r.sale_price),
        costBasis: Number(r.cost_basis),
        pnl: Number(r.pnl)
    }));
}
