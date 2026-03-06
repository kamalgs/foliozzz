import { test, expect } from '@playwright/test';

test.describe('DuckDB Module standalone tests', () => {
    test('all DuckDB module tests pass', async ({ page }) => {
        const errors = [];
        page.on('console', msg => {
            if (msg.type() === 'error') errors.push(msg.text());
        });
        page.on('pageerror', err => errors.push(err.message));

        await page.goto('/duckdb-test.html');

        // Wait for tests to complete (they set window.__testResults)
        await page.waitForFunction(() => window.__testResults, { timeout: 60000 });

        const results = await page.evaluate(() => window.__testResults);
        console.log(`DuckDB module tests: ${results.passed}/${results.total} passed`);

        // Check for "module is not defined" errors
        const moduleErrors = errors.filter(e => e.includes('module is not defined'));
        expect(moduleErrors, 'Should have no "module is not defined" errors').toHaveLength(0);

        // All tests should pass
        expect(results.failed, `${results.failed} test(s) failed`).toBe(0);
        expect(results.passed).toBeGreaterThan(0);
    });

    test('no console errors during DuckDB init', async ({ page }) => {
        const errors = [];
        page.on('console', msg => {
            if (msg.type() === 'error') errors.push(msg.text());
        });
        page.on('pageerror', err => errors.push(err.message));

        await page.goto('/duckdb-test.html');
        await page.waitForFunction(() => window.__testResults, { timeout: 60000 });

        // Filter known benign warnings
        const realErrors = errors.filter(e =>
            !e.includes('favicon') &&
            !e.includes('net::ERR_')
        );
        expect(realErrors, `Console errors: ${realErrors.join('\n')}`).toHaveLength(0);
    });
});
