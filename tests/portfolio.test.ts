import { describe, it, beforeEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { createRequire } from 'node:module';
import { parseCSV } from '../src/portfolio.ts';
import { loadTransactions, getStats, getTimeSeries, getHoldings, getSellDetails } from '../src/analysis.ts';
import type { DB } from '../src/types.ts';

// DuckDB Node.js bindings (CJS package)
const require = createRequire(import.meta.url);
const duckdb = require('duckdb');

function assertClose(actual: number, expected: number, eps: number, msg?: string): void {
    ok(Math.abs(actual - expected) <= eps,
        msg || `Expected ~${expected}, got ${actual} (diff ${Math.abs(actual - expected)} > ${eps})`);
}

// Wrap DuckDB Node callback API into our DB interface
function createDB(): DB {
    const instance = new duckdb.Database(':memory:');
    const connection = instance.connect();
    return {
        exec(sql: string): Promise<void> {
            return new Promise((resolve, reject) => {
                connection.run(sql, (err: Error | null) => err ? reject(err) : resolve());
            });
        },
        query(sql: string): Promise<Record<string, unknown>[]> {
            return new Promise((resolve, reject) => {
                connection.all(sql, (err: Error | null, rows: Record<string, unknown>[]) =>
                    err ? reject(err) : resolve(rows));
            });
        }
    };
}

// Helper: parse CSV + load into DuckDB
async function loadCSV(db: DB, csv: string): Promise<void> {
    const txns = parseCSV(csv);
    txns.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    await loadTransactions(db, txns);
}

const SAMPLE_CSV = `transaction_date,isin,quantity,price,type
2024-01-15,INE002A01018,10,2500,BUY
2024-02-20,INE002A01018,5,2600,BUY
2024-03-10,INE009A01013,20,1450,BUY
2024-09-15,INE002A01018,5,2700,SELL
2024-12-15,INE002A01018,3,2800,SELL`;

// ── parseCSV ─────────────────────────────────────────────────

describe('parseCSV', () => {
    it('parses 5-column format', () => {
        const txns = parseCSV(SAMPLE_CSV);
        strictEqual(txns.length, 5);
        strictEqual(txns[0].isin, 'INE002A01018');
        strictEqual(txns[0].quantity, 10);
        strictEqual(txns[0].price, 2500);
        strictEqual(txns[0].type, 'BUY');
        strictEqual(txns[3].type, 'SELL');
    });

    it('parses 4-column backward-compat format, defaults to BUY', () => {
        const csv = `date,symbol,quantity,price
2024-01-15,RELIANCE,10,2500
2024-02-20,TCS,5,4200`;
        const txns = parseCSV(csv);
        strictEqual(txns.length, 2);
        strictEqual(txns[0].type, 'BUY');
        strictEqual(txns[1].isin, 'TCS');
    });

    it('returns [] for empty body', () => {
        strictEqual(parseCSV('date,isin,quantity,price,type\n').length, 0);
    });

    it('parses rows without header', () => {
        strictEqual(parseCSV('2024-01-15,INE002A01018,10,2500,BUY').length, 1);
    });

    it('recognises Groww tab-delimited format, skips metadata rows', () => {
        const tsv = [
            'Name\tGovindaraj Kamal',
            'Unique Client Code\t9041298312',
            '',
            'Order history for stocks from 01-04-2025 to 16-03-2026',
            '',
            'Stock name\tSymbol\tISIN\tType\tQuantity\tValue\tExchange\tExchange Order Id\tExecution date and time\tOrder status',
            'ICICIPRAMC - ICICIBANKP\tPVTBANIETF\tINF109KC18U7\tBUY\t100\t2587\tNSE\tORD001\t01-04-2025 09:56 AM\tExecuted',
            'ETERNAL LIMITED\tETERNAL\tINE758T01015\tBUY\t10\t2038.7\tNSE\tORD002\t02-04-2025 09:44 AM\tExecuted',
        ].join('\n');
        const txns = parseCSV(tsv);
        strictEqual(txns.length, 2);
        strictEqual(txns[0].isin, 'INF109KC18U7');
        strictEqual(txns[0].quantity, 100);
        strictEqual(txns[0].price, 25.87);
        strictEqual(txns[0].type, 'BUY');
        strictEqual(txns[0].date, '2025-04-01');
        strictEqual(txns[1].isin, 'INE758T01015');
        strictEqual(txns[1].quantity, 10);
        strictEqual(txns[1].price, 203.87);
        strictEqual(txns[1].date, '2025-04-02');
    });

    it('Groww format: skips non-Executed rows', () => {
        const tsv = [
            'Stock name\tSymbol\tISIN\tType\tQuantity\tValue\tExchange\tExchange Order Id\tExecution date and time\tOrder status',
            'STOCK A\tSTKA\tINE001\tBUY\t10\t1000\tNSE\tORD001\t01-04-2025 09:00 AM\tExecuted',
            'STOCK B\tSTKB\tINE002\tBUY\t5\t500\tNSE\tORD002\t02-04-2025 09:00 AM\tCancelled',
            'STOCK C\tSTKC\tINE003\tSELL\t3\t600\tNSE\tORD003\t03-04-2025 09:00 AM\tRejected',
        ].join('\n');
        const txns = parseCSV(tsv);
        strictEqual(txns.length, 1);
        strictEqual(txns[0].isin, 'INE001');
    });

    it('Groww format: parses SELL type correctly', () => {
        const tsv = [
            'Stock name\tSymbol\tISIN\tType\tQuantity\tValue\tExchange\tExchange Order Id\tExecution date and time\tOrder status',
            'RELIANCE\tRELIANCE\tINE002A01018\tSELL\t5\t14000\tNSE\tORD001\t15-06-2025 10:00 AM\tExecuted',
        ].join('\n');
        const txns = parseCSV(tsv);
        strictEqual(txns.length, 1);
        strictEqual(txns[0].type, 'SELL');
        strictEqual(txns[0].price, 2800);
    });
});

// ── FIFO sell matching (SQL) ─────────────────────────────────

describe('FIFO sell matching', () => {
    let db: DB;
    beforeEach(() => { db = createDB(); });

    it('basic single sell', async () => {
        await loadCSV(db, `date,isin,qty,price,type
2024-01-10,X,10,100,BUY
2024-06-01,X,5,150,SELL`);
        const details = await getSellDetails(db);
        strictEqual(details.length, 1);
        strictEqual(details[0].sharesSold, 5);
        strictEqual(details[0].costBasis, 100);
        strictEqual(details[0].pnl, 250);
        const holdings = await getHoldings(db);
        strictEqual(holdings[0].shares, 5);
    });

    it('sell spans two lots', async () => {
        await loadCSV(db, `date,isin,quantity,price,type
2024-01-01,X,3,100,BUY
2024-02-01,X,5,120,BUY
2024-06-01,X,4,150,SELL`);
        const details = await getSellDetails(db);
        strictEqual(details.length, 2);
        strictEqual(details[0].sharesSold, 3);
        strictEqual(details[0].costBasis, 100);
        strictEqual(details[0].pnl, 150);
        strictEqual(details[1].sharesSold, 1);
        strictEqual(details[1].costBasis, 120);
        strictEqual(details[1].pnl, 30);
        const holdings = await getHoldings(db);
        strictEqual(holdings[0].shares, 4);
    });

    it('sell at a loss', async () => {
        await loadCSV(db, `date,isin,quantity,price,type
2024-01-01,X,10,200,BUY
2024-06-01,X,4,150,SELL`);
        const details = await getSellDetails(db);
        strictEqual(details[0].pnl, -200);
    });

    it('multiple ISINs are independent', async () => {
        await loadCSV(db, `date,isin,quantity,price,type
2024-01-01,A,10,100,BUY
2024-01-01,B,10,200,BUY
2024-06-01,B,5,250,SELL`);
        const details = await getSellDetails(db);
        strictEqual(details.length, 1);
        strictEqual(details[0].isin, 'B');
        strictEqual(details[0].costBasis, 200);
        const holdings = await getHoldings(db);
        const a = holdings.find(h => h.isin === 'A')!;
        const b = holdings.find(h => h.isin === 'B')!;
        strictEqual(a.shares, 10);
        strictEqual(b.shares, 5);
    });

    it('sell all shares', async () => {
        await loadCSV(db, `date,isin,quantity,price,type
2024-01-01,X,10,100,BUY
2024-06-01,X,10,120,SELL`);
        const holdings = await getHoldings(db);
        strictEqual(holdings.length, 0);
    });

    it('multiple sells deplete lots correctly', async () => {
        await loadCSV(db, SAMPLE_CSV);
        const holdings = await getHoldings(db);
        const ine002 = holdings.filter(h => h.isin === 'INE002A01018');
        const ine009 = holdings.filter(h => h.isin === 'INE009A01013');
        // Lot 1: 10 - 8 sold = 2, Lot 2: 5 untouched
        strictEqual(ine002.find(h => h.costBasis === 2500)!.shares, 2);
        strictEqual(ine002.find(h => h.costBasis === 2600)!.shares, 5);
        strictEqual(ine009[0].shares, 20);
        const details = await getSellDetails(db);
        const totalPnl = details.reduce((s, d) => s + d.pnl, 0);
        strictEqual(totalPnl, 1900);
    });
});

// ── Portfolio stats (SQL) ────────────────────────────────────

describe('getStats', () => {
    let db: DB;
    beforeEach(() => { db = createDB(); });

    it('sample CSV with capital=100000', async () => {
        await loadCSV(db, SAMPLE_CSV);
        const s = (await getStats(db, 100000))!;
        strictEqual(s.totalInvested, 67000);
        strictEqual(s.totalProceeds, 21900);
        strictEqual(s.realizedPnL, 1900);
        strictEqual(s.costBasisRemaining, 47000);
        strictEqual(s.cashBalance, 54900);
        strictEqual(s.portfolioValue, 101900);
        strictEqual(s.totalReturn, 1900);
        assertClose(s.totalReturnPct, 1.9, 0.01);
        strictEqual(s.numStocks, 2);
        strictEqual(s.holdingDays, 335);
        assertClose(s.annualizedReturnPct, 2.074, 0.1);
    });

    it('buy-only portfolio: value equals initial capital', async () => {
        await loadCSV(db, `date,isin,quantity,price,type
2024-01-15,X,10,2500,BUY
2024-02-20,Y,20,1450,BUY`);
        const s = (await getStats(db, 100000))!;
        strictEqual(s.totalInvested, 54000);
        strictEqual(s.totalProceeds, 0);
        strictEqual(s.realizedPnL, 0);
        strictEqual(s.costBasisRemaining, 54000);
        strictEqual(s.cashBalance, 46000);
        strictEqual(s.portfolioValue, 100000);
        strictEqual(s.totalReturn, 0);
        strictEqual(s.numStocks, 2);
    });

    it('sell everything at profit', async () => {
        await loadCSV(db, `date,isin,quantity,price,type
2024-01-01,X,10,100,BUY
2024-06-01,X,10,150,SELL`);
        const s = (await getStats(db, 10000))!;
        strictEqual(s.totalInvested, 1000);
        strictEqual(s.totalProceeds, 1500);
        strictEqual(s.realizedPnL, 500);
        strictEqual(s.costBasisRemaining, 0);
        strictEqual(s.cashBalance, 10500);
        strictEqual(s.portfolioValue, 10500);
        strictEqual(s.totalReturn, 500);
        strictEqual(s.totalReturnPct, 5);
        strictEqual(s.numStocks, 0);
    });

    it('sell everything at loss', async () => {
        await loadCSV(db, `date,isin,quantity,price,type
2024-01-01,X,10,200,BUY
2024-06-01,X,10,150,SELL`);
        const s = (await getStats(db, 10000))!;
        strictEqual(s.realizedPnL, -500);
        strictEqual(s.portfolioValue, 9500);
        strictEqual(s.totalReturn, -500);
    });

    it('returns null for empty transactions', async () => {
        await loadTransactions(db, []);
        const s = await getStats(db, 100000);
        strictEqual(s, null);
    });

    it('totalReturn equals realizedPnL at cost valuation', async () => {
        await loadCSV(db, SAMPLE_CSV);
        const s = (await getStats(db, 100000))!;
        strictEqual(s.totalReturn, s.realizedPnL);
    });

    it('cash + holdings = portfolioValue', async () => {
        await loadCSV(db, SAMPLE_CSV);
        const s = (await getStats(db, 100000))!;
        strictEqual(s.cashBalance + s.costBasisRemaining, s.portfolioValue);
    });
});

// ── Time series (SQL) ────────────────────────────────────────

describe('getTimeSeries', () => {
    let db: DB;
    beforeEach(() => { db = createDB(); });

    it('buy-only stays flat at cost', async () => {
        await loadCSV(db, `date,isin,quantity,price,type
2024-01-15,X,10,100,BUY
2024-02-15,Y,5,200,BUY`);
        const ts = await getTimeSeries(db, 10000);
        strictEqual(ts.length, 2);
        strictEqual(ts[0].portfolioValue, 10000);
        strictEqual(ts[0].cash, 9000);
        strictEqual(ts[1].portfolioValue, 10000);
        strictEqual(ts[1].returnPct, 0);
    });

    it('sell at profit increases value', async () => {
        await loadCSV(db, `date,isin,quantity,price,type
2024-01-01,X,10,100,BUY
2024-06-01,X,5,150,SELL`);
        const ts = await getTimeSeries(db, 10000);
        strictEqual(ts[0].portfolioValue, 10000);
        strictEqual(ts[1].cash, 9750);
        strictEqual(ts[1].holdingsCost, 500);
        strictEqual(ts[1].portfolioValue, 10250);
        assertClose(ts[1].returnPct, 2.5, 0.01);
    });

    it('sell at loss decreases value', async () => {
        await loadCSV(db, `date,isin,quantity,price,type
2024-01-01,X,10,200,BUY
2024-06-01,X,10,150,SELL`);
        const ts = await getTimeSeries(db, 10000);
        strictEqual(ts[1].portfolioValue, 9500);
        assertClose(ts[1].returnPct, -5, 0.01);
    });

    it('FIFO lot consumption across days', async () => {
        await loadCSV(db, SAMPLE_CSV);
        const ts = await getTimeSeries(db, 100000);

        strictEqual(ts[0].cash, 75000);
        strictEqual(ts[0].holdingsCost, 25000);
        strictEqual(ts[0].portfolioValue, 100000);

        strictEqual(ts[1].cash, 62000);
        strictEqual(ts[1].holdingsCost, 38000);
        strictEqual(ts[1].portfolioValue, 100000);

        strictEqual(ts[2].cash, 33000);
        strictEqual(ts[2].holdingsCost, 67000);
        strictEqual(ts[2].portfolioValue, 100000);

        strictEqual(ts[3].cash, 46500);
        strictEqual(ts[3].holdingsCost, 54500);
        strictEqual(ts[3].portfolioValue, 101000);

        strictEqual(ts[4].cash, 54900);
        strictEqual(ts[4].holdingsCost, 47000);
        strictEqual(ts[4].portfolioValue, 101900);
        assertClose(ts[4].returnPct, 1.9, 0.01);
    });

    it('empty transactions returns []', async () => {
        await loadTransactions(db, []);
        const ts = await getTimeSeries(db, 100000);
        strictEqual(ts.length, 0);
    });
});

// ── Edge cases ───────────────────────────────────────────────

describe('Edge cases', () => {
    let db: DB;
    beforeEach(() => { db = createDB(); });

    it('fractional shares', async () => {
        await loadCSV(db, `date,isin,quantity,price,type
2024-01-01,X,10.5,100,BUY
2024-06-01,X,3.5,120,SELL`);
        const s = (await getStats(db, 50000))!;
        strictEqual(s.totalInvested, 1050);
        strictEqual(s.totalProceeds, 420);
        assertClose(s.realizedPnL, 70, 0.001);
        strictEqual(s.holdings[0].shares, 7);
    });

    it('multiple sells same day same ISIN', async () => {
        await loadCSV(db, `date,isin,quantity,price,type
2024-01-01,X,20,100,BUY
2024-06-01,X,5,120,SELL
2024-06-01,X,3,130,SELL`);
        const s = (await getStats(db, 50000))!;
        strictEqual(s.realizedPnL, 190);
        strictEqual(s.holdings[0].shares, 12);
    });

    it('sell spanning three lots', async () => {
        await loadCSV(db, `date,isin,quantity,price,type
2024-01-01,X,5,100,BUY
2024-02-01,X,5,110,BUY
2024-03-01,X,5,120,BUY
2024-06-01,X,12,150,SELL`);
        const s = (await getStats(db, 50000))!;
        strictEqual(s.realizedPnL, 5 * 50 + 5 * 40 + 2 * 30);  // 510
        strictEqual(s.holdings[0].shares, 3);
        strictEqual(s.holdings[0].costBasis, 120);
    });
});
