/**
 * Portfolio computation module.
 * Pure logic — no DOM, no DuckDB. Operates on plain JS arrays.
 *
 * All monetary values are in the same currency unit (e.g. INR).
 */

/**
 * Parse CSV text into an array of transaction objects.
 * Supports:
 *   - 5-col: date, isin, quantity, price, type
 *   - 4-col: date, symbol, quantity, price  (defaults type to BUY)
 *
 * @param {string} content  Raw CSV text
 * @returns {{ date: string, isin: string, quantity: number, price: number, type: string }[]}
 */
export function parseCSV(content) {
    const lines = content.trim().split('\n');
    const transactions = [];

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
                    type: type.toUpperCase()
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

/**
 * Build FIFO buy-lots from a list of BUY transactions, ordered by date.
 * Each lot has { isin, date, shares, costBasis }.
 *
 * @param {{ date: string, isin: string, quantity: number, price: number, type: string }[]} transactions
 *        Must already be sorted by date ascending.
 * @returns {{ isin: string, date: string, shares: number, costBasis: number }[]}
 */
export function buildLots(transactions) {
    return transactions
        .filter(t => t.type === 'BUY')
        .map(t => ({
            isin: t.isin,
            date: t.date,
            shares: t.quantity,
            costBasis: t.price
        }));
}

/**
 * Process SELL transactions against FIFO lots (in-place mutation of lots).
 * Returns realized P&L details per sell.
 *
 * @param {{ isin: string, date: string, shares: number, costBasis: number }[]} lots
 * @param {{ date: string, isin: string, quantity: number, price: number, type: string }[]} transactions
 * @returns {{ date: string, isin: string, sharesSold: number, salePrice: number, costBasis: number, pnl: number }[]}
 */
export function processSells(lots, transactions) {
    const sells = transactions.filter(t => t.type === 'SELL');
    const results = [];

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

/**
 * Compute full portfolio statistics from transactions.
 *
 * @param {{ date: string, isin: string, quantity: number, price: number, type: string }[]} transactions
 *        Must be sorted by date ascending.
 * @param {number} initialCapital
 * @returns {PortfolioStats}
 *
 * @typedef {Object} PortfolioStats
 * @property {number} totalInvested       Sum of all BUY cost (qty * price)
 * @property {number} totalProceeds       Sum of all SELL proceeds (qty * price)
 * @property {number} realizedPnL         FIFO realized profit/loss
 * @property {number} costBasisRemaining  Cost basis of shares still held
 * @property {number} cashBalance         initialCapital − buys + sell proceeds
 * @property {number} portfolioValue      cashBalance + costBasisRemaining  (at-cost valuation)
 * @property {number} totalReturn         portfolioValue − initialCapital
 * @property {number} totalReturnPct      totalReturn / initialCapital * 100
 * @property {number} numStocks           Distinct ISINs with shares remaining
 * @property {number} holdingDays         Days between first and last transaction
 * @property {number} holdingYears        holdingDays / 365
 * @property {number} annualizedReturnPct CAGR
 * @property {string} firstDate
 * @property {string} lastDate
 * @property {{ isin: string, shares: number, costBasis: number }[]} holdings  remaining lots
 * @property {{ date: string, isin: string, sharesSold: number, salePrice: number, costBasis: number, pnl: number }[]} sellDetails
 */
export function computeStats(transactions, initialCapital) {
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

    // Remaining holdings (lots with shares > 0)
    const holdings = lots
        .filter(l => l.shares > 0)
        .map(l => ({ isin: l.isin, shares: l.shares, costBasis: l.costBasis }));

    const costBasisRemaining = holdings.reduce((s, h) => s + h.shares * h.costBasis, 0);

    const cashBalance = initialCapital - totalInvested + totalProceeds;

    // At-cost portfolio value: cash + holdings valued at purchase price.
    // Equivalently: initialCapital + realizedPnL  (since unrealized at cost = 0).
    const portfolioValue = cashBalance + costBasisRemaining;

    const totalReturn = portfolioValue - initialCapital;
    const totalReturnPct = initialCapital > 0 ? (totalReturn / initialCapital) * 100 : 0;

    const firstDate = transactions[0].date;
    const lastDate = transactions[transactions.length - 1].date;
    const holdingDays = Math.ceil(
        (new Date(lastDate) - new Date(firstDate)) / (1000 * 60 * 60 * 24)
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

/**
 * Build a daily time-series of portfolio value (at cost).
 *
 * @param {{ date: string, isin: string, quantity: number, price: number, type: string }[]} transactions
 * @param {number} initialCapital
 * @returns {{ date: string, cash: number, holdingsCost: number, portfolioValue: number, returnPct: number }[]}
 */
export function buildTimeSeries(transactions, initialCapital) {
    if (!transactions || transactions.length === 0) return [];

    // Active lots, added incrementally as BUYs are processed
    const activeLots = [];

    // Group transactions by date (transactions must be pre-sorted)
    const dateMap = new Map();
    for (const t of transactions) {
        if (!dateMap.has(t.date)) dateMap.set(t.date, []);
        dateMap.get(t.date).push(t);
    }

    const series = [];
    let cash = initialCapital;

    for (const [date, dayTxns] of dateMap) {
        // Process buys first (add lots), then sells (consume lots FIFO)
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
