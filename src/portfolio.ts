export type { Transaction, Holding, SellDetail, PortfolioStats, TimeSeriesPoint, DB } from './types.ts';

import type { Transaction } from './types.ts';

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
