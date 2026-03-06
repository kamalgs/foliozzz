import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { parseCSV, buildLots, processSells, computeStats, buildTimeSeries } from '../portfolio.js';

function assertClose(actual, expected, eps, msg) {
    ok(Math.abs(actual - expected) <= eps,
        msg || `Expected ~${expected}, got ${actual} (diff ${Math.abs(actual - expected)} > ${eps})`);
}

const SAMPLE_CSV = `transaction_date,isin,quantity,price,type
2024-01-15,INE002A01018,10,2500,BUY
2024-02-20,INE002A01018,5,2600,BUY
2024-03-10,INE009A01013,20,1450,BUY
2024-09-15,INE002A01018,5,2700,SELL
2024-12-15,INE002A01018,3,2800,SELL`;

/*  Hand-calculated expected values (initialCapital=100000):
 *
 *  Buys:  10×2500=25000 + 5×2600=13000 + 20×1450=29000 = 67000
 *  Sells: 5×2700=13500 + 3×2800=8400 = 21900
 *
 *  FIFO PnL:
 *    SELL 5@2700 vs lot1@2500 → 5×200 = 1000
 *    SELL 3@2800 vs lot1@2500 → 3×300 = 900
 *    Total = 1900
 *
 *  Remaining lots:
 *    lot1: 2 shares @2500 = 5000
 *    lot2: 5 shares @2600 = 13000
 *    lot3: 20 shares @1450 = 29000
 *    costBasisRemaining = 47000
 *
 *  cash = 100000 − 67000 + 21900 = 54900
 *  portfolioValue = 54900 + 47000 = 101900
 *  totalReturn = 1900 (1.90%)
 *  holdingDays = 335
 */

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
        const txns = parseCSV('2024-01-15,INE002A01018,10,2500,BUY');
        strictEqual(txns.length, 1);
    });
});

// ── buildLots ────────────────────────────────────────────────

describe('buildLots', () => {
    it('filters only BUY transactions', () => {
        const lots = buildLots(parseCSV(SAMPLE_CSV));
        strictEqual(lots.length, 3);
        strictEqual(lots[0].shares, 10);
        strictEqual(lots[0].costBasis, 2500);
        strictEqual(lots[2].isin, 'INE009A01013');
    });
});

// ── FIFO sell matching ───────────────────────────────────────

describe('FIFO sell matching', () => {
    it('basic single sell', () => {
        const txns = parseCSV(`date,isin,qty,price,type
2024-01-10,X,10,100,BUY
2024-06-01,X,5,150,SELL`);
        const lots = buildLots(txns);
        const details = processSells(lots, txns);
        strictEqual(details.length, 1);
        strictEqual(details[0].sharesSold, 5);
        strictEqual(details[0].costBasis, 100);
        strictEqual(details[0].pnl, 250);
        strictEqual(lots[0].shares, 5);
    });

    it('sell spans two lots', () => {
        const txns = parseCSV(`date,isin,quantity,price,type
2024-01-01,X,3,100,BUY
2024-02-01,X,5,120,BUY
2024-06-01,X,4,150,SELL`);
        const lots = buildLots(txns);
        const details = processSells(lots, txns);
        strictEqual(details.length, 2);
        strictEqual(details[0].sharesSold, 3);
        strictEqual(details[0].costBasis, 100);
        strictEqual(details[0].pnl, 150);
        strictEqual(details[1].sharesSold, 1);
        strictEqual(details[1].costBasis, 120);
        strictEqual(details[1].pnl, 30);
        strictEqual(lots[0].shares, 0);
        strictEqual(lots[1].shares, 4);
    });

    it('sell at a loss', () => {
        const txns = parseCSV(`date,isin,quantity,price,type
2024-01-01,X,10,200,BUY
2024-06-01,X,4,150,SELL`);
        const lots = buildLots(txns);
        const details = processSells(lots, txns);
        strictEqual(details[0].pnl, -200);
    });

    it('multiple ISINs are independent', () => {
        const txns = parseCSV(`date,isin,quantity,price,type
2024-01-01,A,10,100,BUY
2024-01-01,B,10,200,BUY
2024-06-01,B,5,250,SELL`);
        const lots = buildLots(txns);
        const details = processSells(lots, txns);
        strictEqual(details.length, 1);
        strictEqual(details[0].isin, 'B');
        strictEqual(details[0].costBasis, 200);
        strictEqual(lots[0].shares, 10);
        strictEqual(lots[1].shares, 5);
    });

    it('sell all shares', () => {
        const txns = parseCSV(`date,isin,quantity,price,type
2024-01-01,X,10,100,BUY
2024-06-01,X,10,120,SELL`);
        const lots = buildLots(txns);
        processSells(lots, txns);
        strictEqual(lots[0].shares, 0);
    });

    it('multiple sells deplete lots correctly', () => {
        const lots = buildLots(parseCSV(SAMPLE_CSV));
        const details = processSells(lots, parseCSV(SAMPLE_CSV));
        strictEqual(lots[0].shares, 2);
        strictEqual(lots[1].shares, 5);
        strictEqual(lots[2].shares, 20);
        strictEqual(details.reduce((s, d) => s + d.pnl, 0), 1900);
    });
});

// ── computeStats ─────────────────────────────────────────────

describe('computeStats', () => {
    it('sample CSV with capital=100000', () => {
        const s = computeStats(parseCSV(SAMPLE_CSV), 100000);
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

    it('buy-only portfolio: value equals initial capital', () => {
        const csv = `date,isin,quantity,price,type
2024-01-15,X,10,2500,BUY
2024-02-20,Y,20,1450,BUY`;
        const s = computeStats(parseCSV(csv), 100000);
        strictEqual(s.totalInvested, 54000);
        strictEqual(s.totalProceeds, 0);
        strictEqual(s.realizedPnL, 0);
        strictEqual(s.costBasisRemaining, 54000);
        strictEqual(s.cashBalance, 46000);
        strictEqual(s.portfolioValue, 100000);
        strictEqual(s.totalReturn, 0);
        strictEqual(s.numStocks, 2);
    });

    it('sell everything at profit', () => {
        const csv = `date,isin,quantity,price,type
2024-01-01,X,10,100,BUY
2024-06-01,X,10,150,SELL`;
        const s = computeStats(parseCSV(csv), 10000);
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

    it('sell everything at loss', () => {
        const csv = `date,isin,quantity,price,type
2024-01-01,X,10,200,BUY
2024-06-01,X,10,150,SELL`;
        const s = computeStats(parseCSV(csv), 10000);
        strictEqual(s.realizedPnL, -500);
        strictEqual(s.portfolioValue, 9500);
        strictEqual(s.totalReturn, -500);
    });

    it('returns null for empty transactions', () => {
        strictEqual(computeStats([], 100000), null);
    });

    it('totalReturn equals realizedPnL at cost valuation', () => {
        const s = computeStats(parseCSV(SAMPLE_CSV), 100000);
        strictEqual(s.totalReturn, s.realizedPnL);
    });

    it('cash + holdings = portfolioValue', () => {
        const s = computeStats(parseCSV(SAMPLE_CSV), 100000);
        strictEqual(s.cashBalance + s.costBasisRemaining, s.portfolioValue);
    });
});

// ── buildTimeSeries ──────────────────────────────────────────

describe('buildTimeSeries', () => {
    it('buy-only stays flat at cost', () => {
        const csv = `date,isin,quantity,price,type
2024-01-15,X,10,100,BUY
2024-02-15,Y,5,200,BUY`;
        const ts = buildTimeSeries(parseCSV(csv), 10000);
        strictEqual(ts.length, 2);
        strictEqual(ts[0].portfolioValue, 10000);
        strictEqual(ts[0].cash, 9000);
        strictEqual(ts[1].portfolioValue, 10000);
        strictEqual(ts[1].returnPct, 0);
    });

    it('sell at profit increases value', () => {
        const csv = `date,isin,quantity,price,type
2024-01-01,X,10,100,BUY
2024-06-01,X,5,150,SELL`;
        const ts = buildTimeSeries(parseCSV(csv), 10000);
        strictEqual(ts[0].portfolioValue, 10000);
        strictEqual(ts[1].cash, 9750);
        strictEqual(ts[1].holdingsCost, 500);
        strictEqual(ts[1].portfolioValue, 10250);
        assertClose(ts[1].returnPct, 2.5, 0.01);
    });

    it('sell at loss decreases value', () => {
        const csv = `date,isin,quantity,price,type
2024-01-01,X,10,200,BUY
2024-06-01,X,10,150,SELL`;
        const ts = buildTimeSeries(parseCSV(csv), 10000);
        strictEqual(ts[1].portfolioValue, 9500);
        assertClose(ts[1].returnPct, -5, 0.01);
    });

    it('FIFO lot consumption across days', () => {
        const ts = buildTimeSeries(parseCSV(SAMPLE_CSV), 100000);

        // Day 1: buy 10@2500
        strictEqual(ts[0].cash, 75000);
        strictEqual(ts[0].holdingsCost, 25000);
        strictEqual(ts[0].portfolioValue, 100000);

        // Day 2: buy 5@2600
        strictEqual(ts[1].cash, 62000);
        strictEqual(ts[1].holdingsCost, 38000);
        strictEqual(ts[1].portfolioValue, 100000);

        // Day 3: buy 20@1450
        strictEqual(ts[2].cash, 33000);
        strictEqual(ts[2].holdingsCost, 67000);
        strictEqual(ts[2].portfolioValue, 100000);

        // Day 4: sell 5 @2700
        strictEqual(ts[3].cash, 46500);
        strictEqual(ts[3].holdingsCost, 54500);
        strictEqual(ts[3].portfolioValue, 101000);

        // Day 5: sell 3 @2800
        strictEqual(ts[4].cash, 54900);
        strictEqual(ts[4].holdingsCost, 47000);
        strictEqual(ts[4].portfolioValue, 101900);
        assertClose(ts[4].returnPct, 1.9, 0.01);
    });

    it('empty transactions returns []', () => {
        strictEqual(buildTimeSeries([], 100000).length, 0);
    });
});

// ── Edge cases ───────────────────────────────────────────────

describe('Edge cases', () => {
    it('fractional shares', () => {
        const csv = `date,isin,quantity,price,type
2024-01-01,X,10.5,100,BUY
2024-06-01,X,3.5,120,SELL`;
        const s = computeStats(parseCSV(csv), 50000);
        strictEqual(s.totalInvested, 1050);
        strictEqual(s.totalProceeds, 420);
        assertClose(s.realizedPnL, 70, 0.001);
        strictEqual(s.holdings[0].shares, 7);
    });

    it('multiple sells same day same ISIN', () => {
        const csv = `date,isin,quantity,price,type
2024-01-01,X,20,100,BUY
2024-06-01,X,5,120,SELL
2024-06-01,X,3,130,SELL`;
        const s = computeStats(parseCSV(csv), 50000);
        strictEqual(s.realizedPnL, 190);
        strictEqual(s.holdings[0].shares, 12);
    });

    it('sell spanning three lots', () => {
        const csv = `date,isin,quantity,price,type
2024-01-01,X,5,100,BUY
2024-02-01,X,5,110,BUY
2024-03-01,X,5,120,BUY
2024-06-01,X,12,150,SELL`;
        const s = computeStats(parseCSV(csv), 50000);
        strictEqual(s.realizedPnL, 5 * 50 + 5 * 40 + 2 * 30);  // 510
        strictEqual(s.holdings[0].shares, 3);
        strictEqual(s.holdings[0].costBasis, 120);
    });
});
