export interface Transaction {
    date: string;
    isin: string;
    quantity: number;
    price: number;
    type: 'BUY' | 'SELL';
}

export interface Holding {
    isin: string;
    shares: number;
    costBasis: number;
}

export interface SellDetail {
    date: string;
    isin: string;
    sharesSold: number;
    salePrice: number;
    costBasis: number;
    pnl: number;
}

export interface PortfolioStats {
    totalInvested: number;
    totalProceeds: number;
    realizedPnL: number;
    costBasisRemaining: number;
    cashBalance: number;
    portfolioValue: number;
    totalReturn: number;
    totalReturnPct: number;
    numStocks: number;
    holdingDays: number;
    holdingYears: number;
    annualizedReturnPct: number;
    firstDate: string;
    lastDate: string;
    holdings: Holding[];
    sellDetails: SellDetail[];
}

export interface TimeSeriesPoint {
    date: string;
    cash: number;
    holdingsCost: number;
    portfolioValue: number;
    returnPct: number;
}

export interface DB {
    exec(sql: string): Promise<void>;
    query(sql: string): Promise<Record<string, unknown>[]>;
}
