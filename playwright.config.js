import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    timeout: 60000,
    use: {
        baseURL: process.env.BASE_URL || 'https://foliozzz.gkamal.online',
        headless: true,
        // Capture console errors
        actionTimeout: 15000,
    },
    reporter: [['list'], ['html', { open: 'never' }]],
});
