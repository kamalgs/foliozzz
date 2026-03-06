import { test, expect } from '@playwright/test';

test.describe('Displayed stats correctness', () => {
    /*  Sample CSV hand-calculated values (initialCapital=100000):
     *  portfolioValue=101900, totalReturn=+1.90%, holdingDays=335
     *  realizedPnL=1900, costBasisRemaining=47000, numStocks=2
     */
    const SAMPLE_CSV = `transaction_date,isin,quantity,price,type
2024-01-15,INE002A01018,10,2500,BUY
2024-02-20,INE002A01018,5,2600,BUY
2024-03-10,INE009A01013,20,1450,BUY
2024-09-15,INE002A01018,5,2700,SELL
2024-12-15,INE002A01018,3,2800,SELL`;

    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await page.locator('#csvInput').setInputFiles({
            name: 'transactions.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from(SAMPLE_CSV),
        });
        await expect(page.locator('#loadingSection')).toBeHidden({ timeout: 30000 });
        await expect(page.locator('#errorSection')).toBeHidden();
    });

    test('total return shows +1.90%', async ({ page }) => {
        const text = await page.locator('#totalReturn').textContent();
        expect(text).toBe('+1.90%');
    });

    test('portfolio value shows ₹1,01,900', async ({ page }) => {
        const text = await page.locator('#portfolioValue').textContent();
        expect(text).toContain('1,01,900');
    });

    test('holding period shows 335 days', async ({ page }) => {
        const text = await page.locator('#holdingPeriod').textContent();
        expect(text).toContain('335 days');
    });

    test('realized PnL shows +₹1,900', async ({ page }) => {
        const text = await page.locator('#totalRealizedPnL').textContent();
        expect(text).toContain('1,900');
    });

    test('FIFO cost basis shows ₹47,000', async ({ page }) => {
        const text = await page.locator('#fifoCostBasis').textContent();
        expect(text).toContain('47,000');
    });

    test('stocks held shows 2', async ({ page }) => {
        const text = await page.locator('#stocksCount').textContent();
        expect(text).toBe('2');
    });

    test('buy-only portfolio shows 0% return', async ({ page }) => {
        const buyOnlyCsv = `date,isin,quantity,price,type
2024-01-15,INE002A01018,10,2500,BUY
2024-02-20,INE009A01013,20,1450,BUY`;

        await page.locator('#csvInput').setInputFiles({
            name: 'buy_only.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from(buyOnlyCsv),
        });
        await expect(page.locator('#loadingSection')).toBeHidden({ timeout: 30000 });

        const text = await page.locator('#totalReturn').textContent();
        expect(text).toBe('+0.00%');
    });
});
