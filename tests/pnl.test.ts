/**
 * P&L accuracy tests — verifies financial correctness of all analysis queries.
 *
 * Tests either assert hand-calculated values or accounting identities that
 * must hold for any valid portfolio. Identity failures indicate a systematic
 * bug in the FIFO engine, stat query, or CSV parser.
 *
 * Accounting identities (must hold for every portfolio):
 *   I1  portfolioValue = cashBalance + costBasisRemaining
 *   I2  portfolioValue = initialCapital + realizedPnL
 *   I3  realizedPnL    = Σ(sellDetail.pnl)
 *   I4  totalInvested  = Σ(BUY quantity × price)
 *   I5  totalProceeds  = Σ(SELL quantity × price)
 *   I6  holdingShares  = totalBought − totalSold  (per ISIN)
 *   I7  Σ(fifo matched qty per ISIN) = Σ(SELL qty per ISIN)  — no orphaned sells
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseCSV } from '../src/portfolio.ts';
import { loadTransactions, getStats, getSellDetails, getHoldings } from '../src/analysis.ts';
import { FIFO_CTES } from '../src/sql.ts';
import { pnlByStock } from '../src/cube.ts';
import type { DB } from '../src/types.ts';

const require = createRequire(import.meta.url);
const duckdb = require('duckdb');

// ── Test infrastructure ──────────────────────────────────────

function createDB(): DB {
    const instance = new duckdb.Database(':memory:');
    const conn = instance.connect();
    return {
        exec: (sql: string) => new Promise<void>((res, rej) =>
            conn.run(sql, (e: Error | null) => e ? rej(e) : res())),
        query: (sql: string) => new Promise<Record<string, unknown>[]>((res, rej) =>
            conn.all(sql, (e: Error | null, r: Record<string, unknown>[]) => e ? rej(e) : res(r)))
    };
}

type TxnType = 'BUY' | 'SELL';
const t = (date: string, isin: string, qty: number, price: number, type: TxnType) =>
    ({ date, isin, quantity: qty, price, type });

async function load(db: DB, txns: ReturnType<typeof t>[]): Promise<void> {
    const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));
    await loadTransactions(db, sorted);
}

const EPS = 0.001;
function close(a: number, b: number) { return Math.abs(a - b) <= EPS; }

// ── Invariant checker (reusable across all tests) ────────────

async function checkInvariants(db: DB, cap: number): Promise<void> {
    const stats = await getStats(db, cap);
    assert.ok(stats, 'getStats returned null — no transactions?');

    // I1: cash + cost basis = portfolio value
    assert.ok(close(stats.cashBalance + stats.costBasisRemaining, stats.portfolioValue),
        `I1: cash(${stats.cashBalance}) + cost(${stats.costBasisRemaining}) = ` +
        `${stats.cashBalance + stats.costBasisRemaining} ≠ portfolioValue(${stats.portfolioValue})`);

    // I2: initial capital + realized PnL = portfolio value
    assert.ok(close(cap + stats.realizedPnL, stats.portfolioValue),
        `I2: cap(${cap}) + realizedPnL(${stats.realizedPnL}) = ` +
        `${cap + stats.realizedPnL} ≠ portfolioValue(${stats.portfolioValue})`);

    // I3: sum of per-sell PnLs = aggregate realizedPnL
    const details = await getSellDetails(db);
    const sumPnl = details.reduce((s, d) => s + d.pnl, 0);
    assert.ok(close(sumPnl, stats.realizedPnL),
        `I3: Σ(sellDetail.pnl)(${sumPnl}) ≠ realizedPnL(${stats.realizedPnL})`);

    // I4: totalInvested matches raw BUY transactions
    const [buyRow] = await db.query(
        `SELECT COALESCE(SUM(quantity * price), 0) AS t FROM transactions WHERE type = 'BUY'`);
    assert.ok(close(Number(buyRow.t), stats.totalInvested),
        `I4: Σ(BUY qty×price)(${buyRow.t}) ≠ totalInvested(${stats.totalInvested})`);

    // I5: totalProceeds matches raw SELL transactions
    const [sellRow] = await db.query(
        `SELECT COALESCE(SUM(quantity * price), 0) AS t FROM transactions WHERE type = 'SELL'`);
    assert.ok(close(Number(sellRow.t), stats.totalProceeds),
        `I5: Σ(SELL qty×price)(${sellRow.t}) ≠ totalProceeds(${stats.totalProceeds})`);

    // I6: holdings shares = bought - sold per ISIN
    const holdings = await getHoldings(db);
    // Sum across lots — one ISIN can have multiple rows in getHoldings (one per cost-basis lot)
    const heldQty: Record<string, number> = {};
    for (const h of holdings) heldQty[h.isin] = (heldQty[h.isin] ?? 0) + h.shares;
    const bought = Object.fromEntries(
        (await db.query(`SELECT isin, SUM(quantity) AS q FROM transactions WHERE type='BUY' GROUP BY isin`))
            .map(r => [String(r.isin), Number(r.q)]));
    const sold = Object.fromEntries(
        (await db.query(`SELECT isin, SUM(quantity) AS q FROM transactions WHERE type='SELL' GROUP BY isin`))
            .map(r => [String(r.isin), Number(r.q)]));
    for (const [isin, bqty] of Object.entries(bought)) {
        const sqty = sold[isin] ?? 0;
        const expected = bqty - sqty;
        const actual = heldQty[isin] ?? 0;
        assert.ok(close(actual, expected),
            `I6(${isin}): holdings(${actual}) ≠ bought(${bqty}) − sold(${sqty}) = ${expected}`);
    }

    // I7: every SELL quantity is covered by a FIFO buy-lot match
    const orphans = await db.query(`
        WITH ${FIFO_CTES},
        sell_totals AS (
            SELECT isin, SUM(quantity) AS total_sold
            FROM transactions WHERE type = 'SELL' GROUP BY isin
        ),
        match_totals AS (
            SELECT isin, SUM(matched_qty) AS total_matched
            FROM fifo_matches GROUP BY isin
        )
        SELECT s.isin, s.total_sold, COALESCE(m.total_matched, 0) AS total_matched
        FROM sell_totals s
        LEFT JOIN match_totals m ON s.isin = m.isin
        WHERE ABS(s.total_sold - COALESCE(m.total_matched, 0)) > ${EPS}
    `);
    assert.equal(orphans.length, 0,
        `I7: unmatched sell quantity for: ${orphans.map(r =>
            `${r.isin}(sold=${r.total_sold}, matched=${r.total_matched})`).join(', ')}`);
}


// ── Tests ───────────────────────────────────────────────────

describe('Accounting invariants — simple portfolios', () => {
    it('buy-only: all invariants hold, PnL = 0', async () => {
        const db = createDB();
        await load(db, [
            t('2024-01-01', 'A', 100, 500, 'BUY'),
            t('2024-02-01', 'A',  50, 600, 'BUY'),
            t('2024-03-01', 'B', 200, 150, 'BUY'),
        ]);
        await checkInvariants(db, 200_000);
        const s = (await getStats(db, 200_000))!;
        assert.equal(s.realizedPnL, 0);
        assert.equal(s.portfolioValue, 200_000);
    });

    it('single buy + partial sell at profit: all invariants hold', async () => {
        const db = createDB();
        await load(db, [
            t('2024-01-01', 'A', 100, 100, 'BUY'),
            t('2024-06-01', 'A',  60, 150, 'SELL'),
        ]);
        await checkInvariants(db, 50_000);
        const s = (await getStats(db, 50_000))!;
        assert.equal(s.totalInvested,        10_000);
        assert.equal(s.totalProceeds,         9_000);
        assert.equal(s.realizedPnL,           3_000);   // 60 × (150-100)
        assert.equal(s.costBasisRemaining,    4_000);   // 40 × 100
        assert.equal(s.cashBalance,          49_000);   // 50000 - 10000 + 9000
        assert.equal(s.portfolioValue,       53_000);   // 49000 + 4000
    });

    it('complete sell at loss: all invariants hold', async () => {
        const db = createDB();
        await load(db, [
            t('2024-01-01', 'A', 10, 200, 'BUY'),
            t('2024-06-01', 'A', 10, 150, 'SELL'),
        ]);
        await checkInvariants(db, 10_000);
        const s = (await getStats(db, 10_000))!;
        assert.equal(s.realizedPnL,   -500);
        assert.equal(s.portfolioValue, 9_500);
        assert.equal(s.numStocks, 0);
    });

    it('multiple ISINs with partial sells: all invariants hold', async () => {
        const db = createDB();
        await load(db, [
            t('2022-01-01', 'A', 100, 500, 'BUY'),
            t('2022-06-01', 'A',  50, 600, 'BUY'),
            t('2023-01-01', 'A',  80, 800, 'SELL'),
            t('2024-01-01', 'A',  60, 900, 'SELL'),
            t('2022-03-01', 'B', 200, 150, 'BUY'),
            t('2022-09-01', 'B', 200, 120, 'SELL'),
        ]);
        await checkInvariants(db, 200_000);
    });

    it('many sells from many lots: all invariants hold', async () => {
        const db = createDB();
        const months = ['01','02','03','04','05','06','07','08','09','10'];
        const txns = [
            ...months.map((m, i) => t(`2020-${m}-01`, 'X', 10, (i + 1) * 100, 'BUY')),
            ...['01','02','03','04','05'].map((m, i) => t(`2021-${m}-01`, 'X', 8, (i + 1) * 200, 'SELL')),
        ];
        await load(db, txns);
        await checkInvariants(db, 500_000);
    });
});


describe('FIFO cost basis precision', () => {
    it('earlier lot is consumed first (FIFO, not LIFO)', async () => {
        const db = createDB();
        await load(db, [
            t('2024-01-01', 'X', 10, 100, 'BUY'),  // lot 1 — cheaper
            t('2024-02-01', 'X', 10, 200, 'BUY'),  // lot 2 — more expensive
            t('2024-06-01', 'X', 10, 300, 'SELL'),
        ]);
        const details = await getSellDetails(db);
        assert.equal(details.length, 1);
        assert.equal(details[0].costBasis, 100);       // lot 1 consumed, NOT lot 2
        assert.equal(details[0].pnl, 10 * (300 - 100)); // 2000, not 1000
        const holdings = await getHoldings(db);
        assert.equal(holdings[0].costBasis, 200);      // lot 2 still held
        assert.equal(holdings[0].shares, 10);
    });

    it('sell spanning two lots: correct PnL split', async () => {
        const db = createDB();
        await load(db, [
            t('2024-01-01', 'X', 3, 100, 'BUY'),
            t('2024-02-01', 'X', 5, 120, 'BUY'),
            t('2024-06-01', 'X', 6, 200, 'SELL'),
        ]);
        const details = await getSellDetails(db);
        assert.equal(details.length, 2);
        // Lot 1: 3 shares @ 100 fully consumed
        assert.equal(details[0].sharesSold, 3);
        assert.equal(details[0].costBasis, 100);
        assert.equal(details[0].pnl, 3 * (200 - 100));  // 300
        // Lot 2: 3 of 5 consumed
        assert.equal(details[1].sharesSold, 3);
        assert.equal(details[1].costBasis, 120);
        assert.equal(details[1].pnl, 3 * (200 - 120));  // 240
        const s = (await getStats(db, 100_000))!;
        assert.equal(s.realizedPnL, 540);
        assert.equal(s.costBasisRemaining, 2 * 120); // 2 shares left in lot 2
    });

    it('multiple sells across three lots: running PnL is correct', async () => {
        const db = createDB();
        await load(db, [
            t('2024-01-01', 'X',  5, 100, 'BUY'),
            t('2024-02-01', 'X',  5, 110, 'BUY'),
            t('2024-03-01', 'X',  5, 120, 'BUY'),
            t('2024-06-01', 'X',  7, 150, 'SELL'),  // consumes all lot1 + 2 of lot2
            t('2024-09-01', 'X',  5, 180, 'SELL'),  // consumes 3 of lot2 + 2 of lot3
        ]);
        await checkInvariants(db, 100_000);
        const s = (await getStats(db, 100_000))!;
        // Sell 1: 5×(150-100) + 2×(150-110) = 250 + 80 = 330
        // Sell 2: 3×(180-110) + 2×(180-120) = 210 + 120 = 330
        assert.equal(s.realizedPnL, 660);
        assert.equal(s.costBasisRemaining, 3 * 120); // 3 shares of lot3 remain
        assert.equal(s.numStocks, 1);
    });

    it('two ISINs do not cross-contaminate FIFO queues', async () => {
        const db = createDB();
        await load(db, [
            t('2024-01-01', 'A', 10, 100, 'BUY'),
            t('2024-01-01', 'B', 10, 200, 'BUY'),
            t('2024-06-01', 'A',  5, 150, 'SELL'),
        ]);
        const s = (await getStats(db, 100_000))!;
        assert.equal(s.realizedPnL, 5 * (150 - 100));   // only ISIN A sold
        assert.equal(s.numStocks, 2);                    // A and B still held
        const h = await getHoldings(db);
        const a = h.find(x => x.isin === 'A')!;
        const b = h.find(x => x.isin === 'B')!;
        assert.equal(a.shares, 5);
        assert.equal(b.shares, 10);  // B untouched
    });

    it('sell entire position: no remaining holdings for that ISIN', async () => {
        const db = createDB();
        await load(db, [
            t('2024-01-01', 'A', 20, 100, 'BUY'),
            t('2024-06-01', 'A', 20, 130, 'SELL'),
            t('2024-01-01', 'B', 10, 200, 'BUY'),
        ]);
        await checkInvariants(db, 50_000);
        const h = await getHoldings(db);
        assert.ok(!h.find(x => x.isin === 'A'), 'A fully sold, should not appear in holdings');
        assert.ok(h.find(x => x.isin === 'B'), 'B still held');
    });

    it('same-day sells deplete the same lot in sequence', async () => {
        const db = createDB();
        await load(db, [
            t('2024-01-01', 'X', 20, 100, 'BUY'),
            t('2024-06-01', 'X',  5, 120, 'SELL'),
            t('2024-06-01', 'X',  3, 130, 'SELL'),
        ]);
        await checkInvariants(db, 50_000);
        const s = (await getStats(db, 50_000))!;
        assert.equal(s.realizedPnL, 5 * 20 + 3 * 30);  // 100 + 90 = 190
        assert.equal(s.costBasisRemaining, 12 * 100);   // 12 shares remain
    });
});


describe('Bonus shares and 0-price BUY lots', () => {
    // Bonus shares are recorded as 0-price BUYs by brokers.
    // The FIFO engine must include them; the CSV parser must not drop them.

    it('0-price BUY lot is included in FIFO and accumulates in holdings', async () => {
        const db = createDB();
        // loadTransactions directly — bypass the CSV parser
        await load(db, [
            t('2024-01-01', 'A', 100, 200, 'BUY'),  // paid lot
            t('2024-07-01', 'A', 100,   0, 'BUY'),  // bonus issue (0-cost)
        ]);
        await checkInvariants(db, 100_000);
        const s = (await getStats(db, 100_000))!;
        assert.equal(s.totalInvested, 20_000);         // bonus contributes 0
        assert.equal(s.costBasisRemaining, 20_000);    // 100@200 + 100@0
        assert.equal(s.numStocks, 1);
        const h = await getHoldings(db);
        const totalShares = h.filter(x => x.isin === 'A').reduce((s, x) => s + x.shares, 0);
        assert.equal(totalShares, 200);  // 100 paid + 100 bonus
    });

    it('sell from paid lot first (FIFO), then 0-cost bonus lot', async () => {
        const db = createDB();
        await load(db, [
            t('2024-01-01', 'A', 100, 200, 'BUY'),
            t('2024-07-01', 'A', 100,   0, 'BUY'),
            t('2024-12-01', 'A', 150, 300, 'SELL'),
        ]);
        await checkInvariants(db, 100_000);
        const s = (await getStats(db, 100_000))!;
        // FIFO: 100 shares @ 200 (PnL=10000), then 50 shares @ 0 (PnL=15000)
        assert.equal(s.realizedPnL, 100 * (300 - 200) + 50 * (300 - 0));  // 25000
        assert.equal(s.totalProceeds, 150 * 300);      // 45000
        assert.equal(s.costBasisRemaining, 0);         // 50 bonus shares remain, cost = 0
    });

    it('complete sell including bonus shares: PnL and invariants correct', async () => {
        const db = createDB();
        await load(db, [
            t('2024-01-01', 'A', 100, 200, 'BUY'),
            t('2024-07-01', 'A', 100,   0, 'BUY'),
            t('2024-12-01', 'A', 200, 300, 'SELL'),  // sell everything
        ]);
        await checkInvariants(db, 100_000);
        const s = (await getStats(db, 100_000))!;
        // FIFO: 100@200 (PnL=10000) + 100@0 (PnL=30000) = 40000
        assert.equal(s.realizedPnL, 100 * 100 + 100 * 300);  // 40000
        assert.equal(s.numStocks, 0);
        assert.equal(s.costBasisRemaining, 0);
    });

    it('CSV parser: 0-price BUY must not be silently dropped', () => {
        // Bonus BUYs appear as 0-price (or 0-value) rows in broker exports.
        // Dropping them causes orphaned sells and broken invariants.
        const csv = [
            'date,isin,quantity,price,type',
            '2024-01-01,A,100,200,BUY',
            '2024-07-01,A,100,0,BUY',      // bonus issue
            '2024-12-01,A,50,300,SELL',
        ].join('\n');
        const txns = parseCSV(csv);
        const bonusBuy = txns.find(tx => tx.isin === 'A' && tx.type === 'BUY' && tx.price === 0);
        assert.ok(bonusBuy,
            'Bonus BUY at price=0 was dropped by the parser — shares count will be wrong and ' +
            'invariant I7 (all sells matched) will fail for post-bonus portfolios');
    });

    it('CSV parser: Groww 0-value bonus BUY must not be silently dropped', () => {
        // In Groww format, Value column is total cost. Bonus = 0 total value.
        const tsv = [
            'Stock name\tSymbol\tISIN\tType\tQuantity\tValue\tExchange\tExchange Order Id\tExecution date and time\tOrder status',
            'SOME STOCK\tSTK\tINE001A01018\tBUY\t100\t20000\tNSE\tO1\t01-01-2024 09:00 AM\tExecuted',
            'SOME STOCK\tSTK\tINE001A01018\tBUY\t100\t0\tNSE\tO2\t01-07-2024 09:00 AM\tExecuted',
        ].join('\n');
        const txns = parseCSV(tsv);
        assert.equal(txns.filter(tx => tx.isin === 'INE001A01018').length, 2,
            'Both BUY rows must be parsed — the 0-value bonus row must not be dropped');
    });
});


describe('Realistic multi-stock portfolio', () => {
    // Hand-calculated scenario:
    //
    // ISIN A (growth stock):
    //   2022-01-10: BUY  100 @ 500 = ₹50,000  (lot 1)
    //   2022-06-15: BUY   50 @ 600 = ₹30,000  (lot 2)
    //   2023-03-20: SELL  80 @ 800             (→ 80 from lot1, PnL = 80×300 = 24,000)
    //   2024-01-05: SELL  60 @ 900             (→ 20 from lot1 @ 500: 20×400=8000,
    //                                              40 from lot2 @ 600: 40×300=12000)
    //   Remaining: 10 shares of lot2 @ 600 = ₹6,000
    //
    // ISIN B (loss stock):
    //   2022-03-01: BUY  200 @ 150 = ₹30,000
    //   2022-09-01: SELL 200 @ 120             (PnL = 200×(−30) = −6,000)
    //
    // Summary with cap = ₹2,00,000:
    //   totalInvested      = 50000 + 30000 + 30000 = 1,10,000
    //   totalProceeds      = 64000 + 54000 + 24000 = 1,42,000
    //   realizedPnL        = 24000 + 8000 + 12000 + (−6000) = 38,000
    //   costBasisRemaining = 10 × 600 = 6,000
    //   cashBalance        = 2,00,000 − 1,10,000 + 1,42,000 = 2,32,000
    //   portfolioValue     = 2,32,000 + 6,000 = 2,38,000 = 2,00,000 + 38,000 ✓

    let db: DB;
    const CAP = 200_000;
    const TXNS = [
        t('2022-01-10', 'A', 100, 500, 'BUY'),
        t('2022-06-15', 'A',  50, 600, 'BUY'),
        t('2022-03-01', 'B', 200, 150, 'BUY'),
        t('2022-09-01', 'B', 200, 120, 'SELL'),
        t('2023-03-20', 'A',  80, 800, 'SELL'),
        t('2024-01-05', 'A',  60, 900, 'SELL'),
    ];

    it('all accounting invariants hold', async () => {
        db = createDB();
        await load(db, TXNS);
        await checkInvariants(db, CAP);
    });

    it('totalInvested and totalProceeds', async () => {
        db = createDB();
        await load(db, TXNS);
        const s = (await getStats(db, CAP))!;
        assert.equal(s.totalInvested, 110_000);
        assert.equal(s.totalProceeds, 142_000);
    });

    it('realizedPnL', async () => {
        db = createDB();
        await load(db, TXNS);
        const s = (await getStats(db, CAP))!;
        assert.equal(s.realizedPnL, 38_000);
    });

    it('costBasisRemaining and cashBalance', async () => {
        db = createDB();
        await load(db, TXNS);
        const s = (await getStats(db, CAP))!;
        assert.equal(s.costBasisRemaining, 6_000);   // 10 × 600
        assert.equal(s.cashBalance,      232_000);
        assert.equal(s.portfolioValue,   238_000);
    });

    it('holdings: only 10 shares of A @ 600 remain', async () => {
        db = createDB();
        await load(db, TXNS);
        const h = await getHoldings(db);
        assert.equal(h.length, 1);
        assert.equal(h[0].isin, 'A');
        assert.equal(h[0].shares, 10);
        assert.equal(h[0].costBasis, 600);
    });

    it('per-sell PnL matches hand calculations', async () => {
        db = createDB();
        await load(db, TXNS);
        const details = await getSellDetails(db);

        const bSell = details.filter(d => d.isin === 'B');
        assert.equal(bSell.length, 1);
        assert.equal(bSell[0].sharesSold, 200);
        assert.equal(bSell[0].pnl, -6_000);

        const aSells = details.filter(d => d.isin === 'A');
        const aTotalPnl = aSells.reduce((s, d) => s + d.pnl, 0);
        assert.equal(aTotalPnl, 44_000);  // 24000 + 8000 + 12000
    });

    it('pnlByStock cube query is consistent with getStats', async () => {
        db = createDB();
        await load(db, TXNS);
        const rows = await db.query(pnlByStock());
        const totalCubePnl = rows.reduce((s, r) => s + Number(r.total_pnl), 0);
        const s = (await getStats(db, CAP))!;
        assert.ok(close(totalCubePnl, s.realizedPnL),
            `Cube pnlByStock total (${totalCubePnl}) ≠ getStats realizedPnL (${s.realizedPnL})`);
    });
});


describe('Edge cases', () => {
    it('fractional shares: invariants and exact PnL', async () => {
        const db = createDB();
        await load(db, [
            t('2024-01-01', 'MF', 100.5, 10, 'BUY'),
            t('2024-06-01', 'MF',  50.5, 12, 'SELL'),
        ]);
        await checkInvariants(db, 10_000);
        const s = (await getStats(db, 10_000))!;
        assert.ok(close(s.realizedPnL, 50.5 * (12 - 10)),  // 101
            `Expected realizedPnL ≈ 101, got ${s.realizedPnL}`);
    });

    it('zero realizedPnL when buy price = sell price', async () => {
        const db = createDB();
        await load(db, [
            t('2024-01-01', 'X', 10, 200, 'BUY'),
            t('2024-06-01', 'X', 10, 200, 'SELL'),
        ]);
        await checkInvariants(db, 50_000);
        const s = (await getStats(db, 50_000))!;
        assert.equal(s.realizedPnL, 0);
        assert.equal(s.portfolioValue, 50_000);
    });

    it('totalReturnPct = realizedPnL / initialCapital × 100', async () => {
        const db = createDB();
        await load(db, [
            t('2024-01-01', 'X', 10, 100, 'BUY'),
            t('2024-06-01', 'X', 10, 150, 'SELL'),
        ]);
        const s = (await getStats(db, 10_000))!;
        const expected = s.realizedPnL / 10_000 * 100;
        assert.ok(close(s.totalReturnPct, expected),
            `totalReturnPct(${s.totalReturnPct}) ≠ ${expected}`);
    });

    it('cashBalance never negative for valid portfolios', async () => {
        const db = createDB();
        // Lots of buys but always sells at profit → cash should stay positive
        await load(db, [
            t('2024-01-01', 'X', 10, 1000, 'BUY'),
            t('2024-02-01', 'X', 10, 1200, 'BUY'),
            t('2024-06-01', 'X', 20, 1500, 'SELL'),
        ]);
        const s = (await getStats(db, 100_000))!;
        assert.ok(s.cashBalance >= 0,
            `cashBalance (${s.cashBalance}) should not be negative`);
    });

    it('large portfolio: 50 buys and 20 sells maintain all invariants', async () => {
        const db = createDB();
        // Generate valid dates: spread across 10 months of 2 years, 5 ISINs
        const buyMonths  = ['01','02','03','04','05','06','07','08','09','10'];
        const sellMonths = ['01','02','03','04','05','06','07','08','09','10'];
        const txns: ReturnType<typeof t>[] = [
            ...Array.from({ length: 50 }, (_, i) =>
                t(`2020-${buyMonths[Math.floor(i / 5)]}-${String((i % 5) * 5 + 1).padStart(2,'0')}`,
                    `STOCK${i % 5}`, 10, (i + 1) * 100, 'BUY')),
            ...Array.from({ length: 20 }, (_, i) =>
                t(`2022-${sellMonths[Math.floor(i / 2)]}-${i % 2 === 0 ? '10' : '20'}`,
                    `STOCK${i % 5}`, 5, (i + 1) * 200, 'SELL')),
        ];
        await load(db, txns);
        await checkInvariants(db, 1_000_000);
    });
});
