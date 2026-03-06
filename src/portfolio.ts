export interface Transaction {
    date: string;
    isin: string;
    quantity: number;
    price: number;
    type: 'BUY' | 'SELL';
}

export interface Lot {
    isin: string;
    date: string;
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

export interface Holding {
    isin: string;
    shares: number;
    costBasis: number;
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

export function parseCSV(content: string): Transaction[] {
    const lines = content.trim().split('\n');
    const transactions: Transaction[] = [];

    const firstLine = lines[0].toLowerCase();
    const hasHeader = firstLine.includes('date') || firstLine.includes('isin');
    const startIndex = hasHeader ? 1 : 0;

    for (let i = startIndex; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim());

        if (parts.length >= 5) {
            const [date, isin, quantity, price, type] = parts;
            if (date && isin && quantity && price && type) {
                transactions.push({
                    date,
                    isin: isin.toUpperCase(),
                    quantity: parseFloat(quantity),
                    price: parseFloat(price),
                    type: type.toUpperCase() as 'BUY' | 'SELL'
                });
            }
        } else if (parts.length >= 4) {
            const [date, symbol, quantity, price] = parts;
            if (date && symbol && quantity && price) {
                transactions.push({
                    date,
                    isin: symbol.toUpperCase(),
                    quantity: parseFloat(quantity),
                    price: parseFloat(price),
                    type: 'BUY'
                });
            }
        }
    }

    return transactions;
}

export function buildLots(transactions: Transaction[]): Lot[] {
    return transactions
        .filter(t => t.type === 'BUY')
        .map(t => ({
            isin: t.isin,
            date: t.date,
            shares: t.quantity,
            costBasis: t.price
        }));
}

export function processSells(lots: Lot[], transactions: Transaction[]): SellDetail[] {
    const sells = transactions.filter(t => t.type === 'SELL');
    const results: SellDetail[] = [];

    for (const sell of sells) {
        let sharesToSell = sell.quantity;
        const salePrice = sell.price;

        for (const lot of lots) {
            if (sharesToSell <= 0) break;
            if (lot.isin !== sell.isin || lot.shares <= 0) continue;

            const matched = Math.min(sharesToSell, lot.shares);
            const pnl = matched * (salePrice - lot.costBasis);

            results.push({
                date: sell.date,
                isin: sell.isin,
                sharesSold: matched,
                salePrice,
                costBasis: lot.costBasis,
                pnl
            });

            lot.shares -= matched;
            sharesToSell -= matched;
        }
    }

    return results;
}

export function computeStats(transactions: Transaction[], initialCapital: number): PortfolioStats | null {
    if (!transactions || transactions.length === 0) {
        return null;
    }

    const lots = buildLots(transactions);
    const sellDetails = processSells(lots, transactions);

    const totalInvested = transactions
        .filter(t => t.type === 'BUY')
        .reduce((s, t) => s + t.quantity * t.price, 0);

    const totalProceeds = transactions
        .filter(t => t.type === 'SELL')
        .reduce((s, t) => s + t.quantity * t.price, 0);

    const realizedPnL = sellDetails.reduce((s, d) => s + d.pnl, 0);

    const holdings: Holding[] = lots
        .filter(l => l.shares > 0)
        .map(l => ({ isin: l.isin, shares: l.shares, costBasis: l.costBasis }));

    const costBasisRemaining = holdings.reduce((s, h) => s + h.shares * h.costBasis, 0);
    const cashBalance = initialCapital - totalInvested + totalProceeds;
    const portfolioValue = cashBalance + costBasisRemaining;
    const totalReturn = portfolioValue - initialCapital;
    const totalReturnPct = initialCapital > 0 ? (totalReturn / initialCapital) * 100 : 0;

    const firstDate = transactions[0].date;
    const lastDate = transactions[transactions.length - 1].date;
    const holdingDays = Math.ceil(
        (new Date(lastDate).getTime() - new Date(firstDate).getTime()) / (1000 * 60 * 60 * 24)
    );
    const holdingYears = holdingDays / 365;
    const annualizedReturnPct = holdingYears > 0
        ? ((portfolioValue / initialCapital) ** (1 / holdingYears) - 1) * 100
        : 0;

    const distinctIsins = new Set(holdings.map(h => h.isin));

    return {
        totalInvested,
        totalProceeds,
        realizedPnL,
        costBasisRemaining,
        cashBalance,
        portfolioValue,
        totalReturn,
        totalReturnPct,
        numStocks: distinctIsins.size,
        holdingDays,
        holdingYears,
        annualizedReturnPct,
        firstDate,
        lastDate,
        holdings,
        sellDetails
    };
}

export function buildTimeSeries(transactions: Transaction[], initialCapital: number): TimeSeriesPoint[] {
    if (!transactions || transactions.length === 0) return [];

    const activeLots: Lot[] = [];

    const dateMap = new Map<string, Transaction[]>();
    for (const t of transactions) {
        if (!dateMap.has(t.date)) dateMap.set(t.date, []);
        dateMap.get(t.date)!.push(t);
    }

    const series: TimeSeriesPoint[] = [];
    let cash = initialCapital;

    for (const [date, dayTxns] of dateMap) {
        for (const t of dayTxns) {
            if (t.type === 'BUY') {
                cash -= t.quantity * t.price;
                activeLots.push({
                    isin: t.isin,
                    date: t.date,
                    shares: t.quantity,
                    costBasis: t.price
                });
            }
        }
        for (const t of dayTxns) {
            if (t.type === 'SELL') {
                cash += t.quantity * t.price;
                let sharesToSell = t.quantity;
                for (const lot of activeLots) {
                    if (sharesToSell <= 0) break;
                    if (lot.isin !== t.isin || lot.shares <= 0) continue;
                    const matched = Math.min(sharesToSell, lot.shares);
                    lot.shares -= matched;
                    sharesToSell -= matched;
                }
            }
        }

        const holdingsCost = activeLots.reduce((s, l) => s + l.shares * l.costBasis, 0);
        const portfolioValue = cash + holdingsCost;
        const returnPct = initialCapital > 0
            ? ((portfolioValue - initialCapital) / initialCapital) * 100
            : 0;

        series.push({ date, cash, holdingsCost, portfolioValue, returnPct });
    }

    return series;
}
