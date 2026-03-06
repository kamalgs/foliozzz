import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Sample CSV content for testing
const SAMPLE_CSV = `transaction_date,isin,quantity,price,type
2024-01-15,INE002A01018,10,2500,BUY
2024-02-20,INE002A01018,5,2600,BUY
2024-03-10,INE009A01013,20,1450,BUY
2024-09-15,INE002A01018,5,2700,SELL
2024-12-15,INE002A01018,3,2800,SELL`;

// Collect all console errors during a test
function collectConsoleErrors(page) {
    const errors = [];
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));
    return errors;
}

test.describe('Page load', () => {
    test('loads without JS errors', async ({ page }) => {
        const errors = collectConsoleErrors(page);
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        // Filter known benign warnings; fail on real errors
        const realErrors = errors.filter(e =>
            !e.includes('favicon') &&
            !e.includes('net::ERR_') // network errors for parquet files are expected until CSV uploaded
        );
        expect(realErrors, `Console errors: ${realErrors.join('\n')}`).toHaveLength(0);
    });

    test('shows correct page title', async ({ page }) => {
        await page.goto('/');
        await expect(page).toHaveTitle(/Portfolio Analysis/);
    });

    test('shows all main sections', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('h2', { hasText: 'Upload Transactions' })).toBeVisible();
        await expect(page.locator('h2', { hasText: 'Configuration' })).toBeVisible();
        await expect(page.locator('h2', { hasText: 'Performance Analysis' })).toBeVisible();
        await expect(page.locator('h2', { hasText: 'Returns Comparison' })).toBeVisible();
    });

    test('CSV format hint shows ISIN-based format', async ({ page }) => {
        await page.goto('/');
        const hint = page.locator('.upload-section .hint').first();
        await expect(hint).toContainText('isin');
        await expect(hint).toContainText('BUY');
    });

    test('benchmark selector has all 5 options', async ({ page }) => {
        await page.goto('/');
        const options = page.locator('#benchmarkSelect option');
        await expect(options).toHaveCount(5);
        await expect(options.nth(0)).toHaveText('NIFTY 50');
        await expect(options.nth(1)).toHaveText('NIFTY BANK');
        await expect(options.nth(2)).toHaveText('SENSEX');
    });

    test('no ReferenceError for module', async ({ page }) => {
        const errors = collectConsoleErrors(page);
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        const moduleErrors = errors.filter(e => e.includes('module is not defined'));
        expect(moduleErrors, 'Got "module is not defined" error').toHaveLength(0);
    });
});

test.describe('CSV upload', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
    });

    test('accepts valid CSV upload', async ({ page }) => {
        const errors = collectConsoleErrors(page);

        // Write sample CSV to a temp buffer and upload
        await page.locator('#csvInput').setInputFiles({
            name: 'transactions.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from(SAMPLE_CSV),
        });

        // Wait for processing - loading section should appear then disappear
        await expect(page.locator('#loadingSection')).toBeHidden({ timeout: 30000 });

        // Should not show error section
        await expect(page.locator('#errorSection')).toBeHidden();

        // Filter expected errors
        const realErrors = errors.filter(e =>
            !e.includes('favicon') &&
            !e.includes('parquet') &&   // parquet scan errors expected for missing ISIN data
            !e.includes('net::ERR_')
        );
        expect(realErrors).toHaveLength(0);
    });

    test('shows error for empty CSV', async ({ page }) => {
        await page.locator('#csvInput').setInputFiles({
            name: 'empty.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from('transaction_date,isin,quantity,price,type\n'),
        });

        await expect(page.locator('#errorSection')).toBeVisible({ timeout: 10000 });
        await expect(page.locator('#errorMessage')).toContainText('No valid transactions');
    });

    test('accepts backward-compatible 4-column CSV', async ({ page }) => {
        const oldFormat = `date,symbol,quantity,price
2024-01-15,RELIANCE,10,2500
2024-02-20,TCS,5,4200`;

        await page.locator('#csvInput').setInputFiles({
            name: 'old_format.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from(oldFormat),
        });

        // Should not show error
        await expect(page.locator('#loadingSection')).toBeHidden({ timeout: 30000 });
        await expect(page.locator('#errorSection')).toBeHidden();
    });
});

test.describe('Stats display after upload', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await page.locator('#csvInput').setInputFiles({
            name: 'transactions.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from(SAMPLE_CSV),
        });
        await expect(page.locator('#loadingSection')).toBeHidden({ timeout: 30000 });
    });

    test('stat cards show values (not just dashes)', async ({ page }) => {
        // At minimum, portfolio value and holding period should be populated
        const portfolioValue = page.locator('#portfolioValue');
        await expect(portfolioValue).not.toHaveText('-');
    });

    test('total return shows % sign', async ({ page }) => {
        const totalReturn = page.locator('#totalReturn');
        const text = await totalReturn.textContent();
        expect(text).toMatch(/%/);
    });
});

test.describe('FIFO sell logic', () => {
    // These tests verify the FIFO cost basis calculation via the UI
    test('sell transactions do not cause a JS error', async ({ page }) => {
        const errors = collectConsoleErrors(page);
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const csvWithSells = `transaction_date,isin,quantity,price,type
2024-01-10,INE002A01018,10,2500,BUY
2024-06-01,INE002A01018,5,3000,SELL`;

        await page.locator('#csvInput').setInputFiles({
            name: 'sells.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from(csvWithSells),
        });

        await expect(page.locator('#loadingSection')).toBeHidden({ timeout: 30000 });
        await expect(page.locator('#errorSection')).toBeHidden();

        const jsErrors = errors.filter(e =>
            e.includes('ReferenceError') ||
            e.includes('TypeError') ||
            e.includes('SyntaxError')
        );
        expect(jsErrors, `JS errors: ${jsErrors.join('\n')}`).toHaveLength(0);
    });
});

test.describe('OLAP cube materialization', () => {
    // This test validates that the OLAP cube (dim_calendar, dim_stock,
    // fact_trades, fact_positions) materializes correctly in DuckDB WASM.
    // This was the root cause of a production bug: generate_series doesn't
    // accept subquery parameters in WASM, unlike the Node.js DuckDB driver.
    const CSV_WITH_SELLS = `transaction_date,isin,quantity,price,type
2024-01-10,INE002A01018,10,2500,BUY
2024-03-15,INE009A01013,20,800,BUY
2024-06-01,INE002A01018,5,3000,SELL
2024-09-20,INE009A01013,10,900,SELL`;

    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
    });

    test('cube materializes without Binder Error', async ({ page }) => {
        const errors = collectConsoleErrors(page);
        await page.locator('#csvInput').setInputFiles({
            name: 'transactions.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from(CSV_WITH_SELLS),
        });
        await expect(page.locator('#loadingSection')).toBeHidden({ timeout: 30000 });
        await expect(page.locator('#errorSection')).toBeHidden();

        const binderErrors = errors.filter(e => e.includes('Binder Error'));
        expect(binderErrors, `Binder errors: ${binderErrors.join('\n')}`).toHaveLength(0);
    });

    test('stats display correctly after cube materialization', async ({ page }) => {
        await page.locator('#csvInput').setInputFiles({
            name: 'transactions.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from(CSV_WITH_SELLS),
        });
        await expect(page.locator('#loadingSection')).toBeHidden({ timeout: 30000 });
        await expect(page.locator('#errorSection')).toBeHidden();

        // Verify stats are populated (not dashes)
        await expect(page.locator('#totalReturn')).not.toHaveText('-');
        await expect(page.locator('#portfolioValue')).not.toHaveText('-');

        // Verify realized PnL section shows (we have sells)
        await expect(page.locator('#pnlGrid')).toBeVisible();
        await expect(page.locator('#totalRealizedPnL')).not.toHaveText('-');
        await expect(page.locator('#stocksCount')).not.toHaveText('-');
    });

    test('AI insights section appears after upload', async ({ page }) => {
        await page.locator('#csvInput').setInputFiles({
            name: 'transactions.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from(CSV_WITH_SELLS),
        });
        await expect(page.locator('#loadingSection')).toBeHidden({ timeout: 30000 });
        await expect(page.locator('#errorSection')).toBeHidden();

        await expect(page.locator('#insightsSection')).toBeVisible();
        await expect(page.locator('h2', { hasText: 'AI Insights' })).toBeVisible();
    });
});

test.describe('Benchmark selector', () => {
    test('changing benchmark does not crash', async ({ page }) => {
        const errors = collectConsoleErrors(page);
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        await page.locator('#csvInput').setInputFiles({
            name: 'transactions.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from(SAMPLE_CSV),
        });
        await expect(page.locator('#loadingSection')).toBeHidden({ timeout: 30000 });

        // Switch benchmark
        await page.locator('#benchmarkSelect').selectOption('sensex');
        await expect(page.locator('#loadingSection')).toBeHidden({ timeout: 30000 });

        const jsErrors = errors.filter(e =>
            e.includes('ReferenceError') ||
            e.includes('TypeError') ||
            e.includes('SyntaxError')
        );
        expect(jsErrors).toHaveLength(0);
    });
});

test.describe('Benchmark time series data', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await page.locator('#csvInput').setInputFiles({
            name: 'transactions.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from(SAMPLE_CSV),
        });
        await expect(page.locator('#loadingSection')).toBeHidden({ timeout: 30000 });
    });

    test('benchmark dataset has non-zero values', async ({ page }) => {
        const result = await page.evaluate(() => {
            const canvas = document.getElementById('returnsChart');
            const chart = Chart.getChart(canvas);
            if (!chart) return null;
            const data = chart.data.datasets[1]?.data ?? [];
            // Data points are {x, y} objects
            const values = data.map(p => typeof p === 'object' && p !== null ? p.y : p);
            return values;
        });

        expect(result, 'Benchmark dataset should exist').not.toBeNull();
        expect(result.length, 'Benchmark dataset should have data points').toBeGreaterThan(0);

        const nonZero = result.filter(v => v !== 0 && v !== null);
        expect(nonZero.length, 'Benchmark should have non-zero return values').toBeGreaterThan(0);
    });

    test('benchmark values are realistic percentages', async ({ page }) => {
        const result = await page.evaluate(() => {
            const canvas = document.getElementById('returnsChart');
            const chart = Chart.getChart(canvas);
            if (!chart) return null;
            const data = chart.data.datasets[1]?.data ?? [];
            return data.map(p => typeof p === 'object' && p !== null ? p.y : p);
        });

        expect(result).not.toBeNull();
        const values = result.filter(v => v !== null && v !== undefined);
        expect(values.length).toBeGreaterThan(0);

        for (const v of values) {
            expect(v, `Benchmark return ${v}% is unrealistic`).toBeGreaterThan(-50);
            expect(v, `Benchmark return ${v}% is unrealistic`).toBeLessThan(100);
        }
    });

    test('benchmark has variance (not flat)', async ({ page }) => {
        const result = await page.evaluate(() => {
            const canvas = document.getElementById('returnsChart');
            const chart = Chart.getChart(canvas);
            if (!chart) return null;
            const data = chart.data.datasets[1]?.data ?? [];
            return data.map(p => typeof p === 'object' && p !== null ? p.y : p);
        });

        expect(result).not.toBeNull();
        const values = result.filter(v => v !== null && v !== undefined);
        expect(values.length).toBeGreaterThanOrEqual(2);

        const uniqueValues = new Set(values);
        expect(uniqueValues.size, 'Benchmark data should not be flat (all same value)').toBeGreaterThan(1);
    });
});
