/**
 * Portfolio Analysis Application
 * Browser-based stock portfolio analysis using DuckDB WebAssembly
 */

import { initDuckDB, runQuery, runSQL, isReady } from './duckdb-module.js';
import { parseCSV, computeStats, buildTimeSeries } from './portfolio.js';

// Configuration
const CONFIG = {
    dataPath: 'data',
    benchmarks: {
        nifty50: 'nifty50.parquet',
        bank_nifty: 'bank_nifty.parquet',
        sensex: 'sensex.parquet',
        nifty_midcap: 'nifty_midcap.parquet',
        bse_500: 'bse_500.parquet'
    }
};

// Global state
let chart = null;
let currentTransactions = null;

// DOM Elements
const elements = {
    csvInput: document.getElementById('csvInput'),
    benchmarkSelect: document.getElementById('benchmarkSelect'),
    initialCapital: document.getElementById('initialCapital'),
    statsGrid: document.getElementById('statsGrid'),
    loadingSection: document.getElementById('loadingSection'),
    loadingText: document.getElementById('loadingText'),
    errorSection: document.getElementById('errorSection'),
    errorMessage: document.getElementById('errorMessage'),
    retryBtn: document.getElementById('retryBtn')
};

/**
 * Initialize the application
 */
async function init() {
    showLoading('Initializing DuckDB...');

    try {
        await initDuckDB();
        hideLoading();
        console.log('Portfolio Analysis initialized successfully');
    } catch (error) {
        hideLoading();
        showError('Failed to initialize DuckDB: ' + error.message);
        console.error('Initialization error:', error);
    }
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
    elements.csvInput.addEventListener('change', handleFileUpload);
    elements.retryBtn.addEventListener('click', () => {
        elements.errorSection.style.display = 'none';
        init();
    });
    elements.benchmarkSelect.addEventListener('change', async () => {
        if (currentTransactions) {
            await runAnalysis();
        }
    });
}

/**
 * Handle CSV file upload
 */
async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    showLoading('Parsing transactions...');

    try {
        const content = await file.text();
        const transactions = parseCSV(content);

        if (transactions.length === 0) {
            throw new Error('No valid transactions found in CSV');
        }

        // Sort transactions by date for FIFO processing
        transactions.sort((a, b) => new Date(a.date) - new Date(b.date));

        if (!isReady()) {
            throw new Error('Database not initialized. Please refresh the page and try again.');
        }

        currentTransactions = transactions;

        // Store in DuckDB for benchmark queries
        await createTransactionsTable(transactions);
        await runAnalysis();
        hideLoading();

    } catch (error) {
        hideLoading();
        const errorMsg = error?.message || String(error) || 'Unknown error processing CSV';
        showError('Error processing CSV: ' + errorMsg);
        console.error('File upload error:', error);
    }
}

/**
 * Create transactions table in DuckDB (used only for benchmark date-range queries)
 */
async function createTransactionsTable(transactions) {
    await runSQL('DROP TABLE IF EXISTS transactions');

    await runSQL(`
        CREATE TABLE transactions (
            date DATE,
            isin VARCHAR,
            quantity DOUBLE,
            price DOUBLE,
            type VARCHAR
        )
    `);

    const batchSize = 1000;
    for (let i = 0; i < transactions.length; i += batchSize) {
        const batch = transactions.slice(i, i + batchSize);
        const values = batch.map(t =>
            `('${t.date}', '${t.isin}', ${t.quantity}, ${t.price}, '${t.type}')`
        ).join(', ');
        await runSQL(`INSERT INTO transactions VALUES ${values}`);
    }
}

/**
 * Run portfolio analysis
 */
async function runAnalysis() {
    if (!currentTransactions) return;

    showLoading('Analyzing portfolio...');

    try {
        const initialCapital = parseFloat(elements.initialCapital.value) || 100000;

        // Pure computation — no DuckDB needed for portfolio stats
        const stats = computeStats(currentTransactions, initialCapital);

        if (!stats) {
            showError('No portfolio data available for analysis');
            hideLoading();
            return;
        }

        const timeSeries = buildTimeSeries(currentTransactions, initialCapital);

        // Benchmark returns still use DuckDB for parquet loading
        const benchmark = elements.benchmarkSelect.value;
        const benchmarkReturns = await calculateBenchmarkReturns(benchmark);

        renderResults(stats, timeSeries, benchmarkReturns, initialCapital);
        hideLoading();

    } catch (error) {
        hideLoading();
        showError('Analysis error: ' + error.message);
        console.error('Analysis error:', error);
    }
}

/**
 * Calculate benchmark returns from parquet files via DuckDB
 */
async function calculateBenchmarkReturns(benchmarkKey) {
    const parquetFile = CONFIG.benchmarks[benchmarkKey];

    try {
        const rows = await runQuery(`
            SELECT
                date,
                close_price,
                LAG(close_price) OVER (ORDER BY date) as prev_close,
                (close_price - LAG(close_price) OVER (ORDER BY date)) /
                    NULLIF(LAG(close_price) OVER (ORDER BY date), 0) * 100 as daily_return_pct,
                SUM((close_price - LAG(close_price) OVER (ORDER BY date)) /
                    NULLIF(LAG(close_price) OVER (ORDER BY date), 0)) OVER (ORDER BY date) * 100 as cumulative_return_pct
            FROM parquet_scan('${CONFIG.dataPath}/${parquetFile}')
            WHERE date IS NOT NULL AND close_price IS NOT NULL
            ORDER BY date
        `);

        return rows.map(r => ({
            date: r.date,
            closePrice: Number(r.close_price) || 0,
            cumulativeReturnPct: Number(r.cumulative_return_pct) || 0
        }));

    } catch (error) {
        console.warn(`Could not load benchmark data for ${benchmarkKey}:`, error.message);
        return [];
    }
}

/**
 * Render analysis results
 */
function renderResults(stats, timeSeries, benchmarkReturns, initialCapital) {
    // Update main stats
    updateStats({
        totalReturnPct: `${stats.totalReturn >= 0 ? '+' : ''}${stats.totalReturnPct.toFixed(2)}%`,
        annualizedReturn: `${stats.annualizedReturnPct >= 0 ? '+' : ''}${stats.annualizedReturnPct.toFixed(2)}%`,
        portfolioValue: `₹${stats.portfolioValue.toLocaleString('en-IN')}`,
        holdingPeriod: `${stats.holdingDays} days (${stats.holdingYears.toFixed(1)} years)`
    });

    // Update PnL stats if there are sells
    const pnlGrid = document.getElementById('pnlGrid');
    if (stats.realizedPnL !== 0) {
        pnlGrid.style.display = 'grid';
        updatePnLStats({
            totalRealizedPnL: `${stats.realizedPnL >= 0 ? '+' : ''}₹${stats.realizedPnL.toLocaleString('en-IN')}`,
            totalUnrealizedGain: '-',
            fifoCostBasis: `₹${stats.costBasisRemaining.toLocaleString('en-IN')}`,
            stocksCount: `${stats.numStocks}`
        });
    } else {
        pnlGrid.style.display = 'none';
    }

    renderChart(timeSeries, benchmarkReturns);
}

/**
 * Update PnL stats display
 */
function updatePnLStats(stats) {
    const totalRealizedPnLEl = document.getElementById('totalRealizedPnL');
    const totalRealizedPnL = parseFloat(stats.totalRealizedPnL.replace(/[+%₹,]/g, ''));
    totalRealizedPnLEl.textContent = stats.totalRealizedPnL;
    totalRealizedPnLEl.className = 'stat-value ' + (totalRealizedPnL >= 0 ? 'positive' : 'negative');

    const totalUnrealizedGainEl = document.getElementById('totalUnrealizedGain');
    totalUnrealizedGainEl.textContent = stats.totalUnrealizedGain;

    document.getElementById('fifoCostBasis').textContent = stats.fifoCostBasis;
    document.getElementById('stocksCount').textContent = stats.stocksCount;
}

/**
 * Update stats display
 */
function updateStats(stats) {
    const totalReturnEl = document.getElementById('totalReturn');
    const totalReturn = parseFloat(stats.totalReturnPct.replace(/[+%]/g, ''));
    totalReturnEl.textContent = stats.totalReturnPct;
    totalReturnEl.className = 'stat-value ' + (totalReturn >= 0 ? 'positive' : 'negative');

    const annualizedReturnEl = document.getElementById('annualizedReturn');
    annualizedReturnEl.textContent = stats.annualizedReturn;
    annualizedReturnEl.className = 'stat-value ' + (parseFloat(stats.annualizedReturn.replace(/[+%]/g, '')) >= 0 ? 'positive' : 'negative');

    document.getElementById('portfolioValue').textContent = stats.portfolioValue;
    document.getElementById('holdingPeriod').textContent = stats.holdingPeriod;
}

/**
 * Render returns chart
 */
function renderChart(timeSeries, benchmarkReturns) {
    const ctx = document.getElementById('returnsChart').getContext('2d');

    const labels = timeSeries.map(r => r.date);
    const portfolioData = timeSeries.map(r => r.returnPct);

    let benchmarkData = [];
    if (benchmarkReturns.length > 0) {
        const portfolioDates = new Set(timeSeries.map(r => String(r.date)));
        benchmarkData = benchmarkReturns
            .filter(r => portfolioDates.has(String(r.date)))
            .map(r => r.cumulativeReturnPct);
    } else {
        benchmarkData = timeSeries.map(() => 0);
    }

    if (chart) {
        chart.destroy();
    }

    chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels.slice(0, 100),
            datasets: [
                {
                    label: 'Portfolio',
                    data: portfolioData.slice(0, 100),
                    borderColor: '#4facfe',
                    backgroundColor: 'rgba(79, 172, 254, 0.1)',
                    borderWidth: 2,
                    pointRadius: 2,
                    fill: true,
                    tension: 0.1
                },
                {
                    label: 'Benchmark (' + elements.benchmarkSelect.options[elements.benchmarkSelect.selectedIndex].text + ')',
                    data: benchmarkData.slice(0, 100),
                    borderColor: '#4caf50',
                    borderWidth: 2,
                    pointRadius: 2,
                    fill: false,
                    tension: 0.1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    position: 'top',
                    labels: { color: '#e0e0e0', font: { size: 12 } }
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    titleColor: '#fff',
                    bodyColor: '#e0e0e0',
                    borderColor: 'rgba(255, 255, 255, 0.1)',
                    borderWidth: 1,
                    callbacks: {
                        label: function(context) {
                            return context.dataset.label + ': ' + context.parsed.y.toFixed(2) + '%';
                        }
                    }
                },
                title: {
                    display: true,
                    text: 'Cumulative Returns Comparison',
                    color: '#fff',
                    font: { size: 14 }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#888', maxTicksLimit: 10 }
                },
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: {
                        color: '#888',
                        callback: function(value) { return value + '%'; }
                    },
                    border: { color: 'rgba(255, 255, 255, 0.1)' }
                }
            }
        }
    });
}

/**
 * Show loading indicator
 */
function showLoading(text) {
    elements.loadingText.textContent = text || 'Loading...';
    elements.loadingSection.style.display = 'flex';
}

/**
 * Hide loading indicator
 */
function hideLoading() {
    elements.loadingSection.style.display = 'none';
}

/**
 * Show error message
 */
function showError(message) {
    elements.loadingSection.style.display = 'none';
    elements.errorMessage.textContent = message;
    elements.errorSection.style.display = 'block';
    elements.errorSection.style.visibility = 'visible';
    elements.errorSection.style.opacity = '1';
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    init();
});

// Expose functions for testing
window.PortfolioAnalysis = {
    init,
    parseCSV,
    handleFileUpload
};
