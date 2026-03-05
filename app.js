/**
 * Portfolio Analysis Application
 * Browser-based stock portfolio analysis using DuckDB WebAssembly
 */

import * as duckdb from 'duckdb';

// Configuration
const CONFIG = {
    dataPath: 'data',
    benchmarks: {
        nifty50: 'nifty50.parquet',
        bank_nifty: 'bank_nifty.parquet',
        sensex: 'sensex.parquet',
        nifty_midcap: 'nifty_midcap.parquet',
        bse_500: 'bse_500.parquet'
    },
    stockDataPath: 'stock_prices'
};

// Global variables
let db = null;
let chart = null;

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
        // Initialize DuckDB using ESM module
        const client = await duckdb.create();
        db = await client.connect();

        // Register file system for accessing bundled data
        await registerDataDirectory(db);

        // Setup event listeners
        setupEventListeners();

        hideLoading();
        console.log('Portfolio Analysis initialized successfully');

    } catch (error) {
        hideLoading();
        showError('Failed to initialize DuckDB: ' + error.message);
        console.error('Initialization error:', error);
    }
}

/**
 * Register the data directory for accessing bundled Parquet files
 */
async function registerDataDirectory(db) {
    try {
        // Try to load benchmark data to verify data is available
        const result = await db.all(`
            SELECT * FROM parquet_scan('${CONFIG.dataPath}/nifty50.parquet') LIMIT 1
        `);
        console.log('Data directory registered successfully');
    } catch (error) {
        console.warn('Data directory not pre-registered, will load dynamically:', error.message);
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
        if (hasTransactions()) {
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
        // Read file content
        const content = await file.text();

        // Parse CSV
        const transactions = parseCSV(content);

        if (transactions.length === 0) {
            throw new Error('No valid transactions found in CSV');
        }

        // Create transactions table in DuckDB
        await createTransactionsTable(transactions);

        // Run analysis
        await runAnalysis();

        hideLoading();

    } catch (error) {
        hideLoading();
        showError('Error processing CSV: ' + error.message);
        console.error('File upload error:', error);
    }
}

/**
 * Parse CSV content
 */
function parseCSV(content) {
    const lines = content.trim().split('\n');
    const transactions = [];

    // Skip header if present
    const startIndex = lines[0].toLowerCase().includes('date') ? 1 : 0;

    for (let i = startIndex; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim());

        if (parts.length >= 4) {
            const [date, symbol, quantity, price] = parts;

            // Validate data
            if (date && symbol && quantity && price) {
                transactions.push({
                    date,
                    symbol: symbol.toUpperCase(),
                    quantity: parseFloat(quantity),
                    price: parseFloat(price)
                });
            }
        }
    }

    return transactions;
}

/**
 * Create transactions table in DuckDB
 */
async function createTransactionsTable(transactions) {
    // Drop existing table if exists
    await db.run('DROP TABLE IF EXISTS transactions');

    // Create table schema
    await db.run(`
        CREATE TABLE transactions (
            date DATE,
            symbol VARCHAR,
            quantity DOUBLE,
            price DOUBLE
        )
    `);

    // Insert data in batches
    const batchSize = 1000;
    for (let i = 0; i < transactions.length; i += batchSize) {
        const batch = transactions.slice(i, i + batchSize);
        const values = batch.map(t =>
            `('${t.date}', '${t.symbol}', ${t.quantity}, ${t.price})`
        ).join(', ');

        await db.run(`INSERT INTO transactions VALUES ${values}`);
    }
}

/**
 * Run portfolio analysis
 */
async function runAnalysis() {
    if (!hasTransactions()) {
        return;
    }

    showLoading('Analyzing portfolio...');

    try {
        const benchmark = elements.benchmarkSelect.value;
        const initialCapital = parseFloat(elements.initialCapital.value) || 100000;

        // Get unique stocks from portfolio
        const stocksResult = await db.all('SELECT DISTINCT symbol FROM transactions');
        const stocks = stocksResult.map(r => r['symbol']);

        // Load stock price data for each stock
        await loadStockPriceData(stocks);

        // Calculate portfolio returns
        const portfolioReturns = await calculatePortfolioReturns();

        // Calculate benchmark returns
        const benchmarkReturns = await calculateBenchmarkReturns(benchmark);

        // Merge and render results
        renderResults(portfolioReturns, benchmarkReturns, initialCapital);

        hideLoading();

    } catch (error) {
        hideLoading();
        showError('Analysis error: ' + error.message);
        console.error('Analysis error:', error);
    }
}

/**
 * Check if transactions table has data
 */
function hasTransactions() {
    return true; // We'll check this in DuckDB
}

/**
 * Load stock price data for given symbols
 */
async function loadStockPriceData(stocks) {
    // Check if stock prices table already exists
    const checkResult = await db.all(
        "SELECT name FROM duckdb_tables() WHERE name = 'stock_prices'"
    );

    if (checkResult.length > 0) {
        // Stock prices already loaded, return
        return;
    }

    // Create stock_prices table with all available stock data
    await db.run('DROP TABLE IF EXISTS stock_prices');

    // Load stock data from Parquet files
    await db.run(`
        CREATE TABLE stock_prices AS SELECT * FROM parquet_scan('${CONFIG.dataPath}/${CONFIG.stockDataPath}/*.parquet')
    `);
}

/**
 * Calculate portfolio returns
 */
async function calculatePortfolioReturns() {
    const initialCapital = parseFloat(elements.initialCapital.value) || 100000;

    // SQL query to calculate portfolio returns
    // First calculate the purchase value and build holdings
    const query = `
        WITH purchase_info AS (
            SELECT
                t.date,
                t.symbol,
                t.quantity,
                t.price as purchase_price,
                sp.close_price as current_price
            FROM transactions t
            LEFT JOIN stock_prices sp ON t.symbol = sp.symbol AND t.date = sp.date
        ),
        holding_value AS (
            SELECT
                date,
                symbol,
                quantity,
                current_price,
                quantity * current_price as market_value
            FROM purchase_info
            WHERE current_price IS NOT NULL
        ),
        daily_portfolio AS (
            SELECT
                date,
                SUM(market_value) as portfolio_value
            FROM holding_value
            GROUP BY date
            ORDER BY date
        ),
        returns AS (
            SELECT
                date,
                portfolio_value,
                LAG(portfolio_value, 1, ${initialCapital}) OVER (ORDER BY date) as prev_value,
                (portfolio_value - LAG(portfolio_value, 1, ${initialCapital}) OVER (ORDER BY date)) /
                    NULLIF(LAG(portfolio_value, 1, ${initialCapital}) OVER (ORDER BY date), 0) as daily_return_pct
            FROM daily_portfolio
        )
        SELECT
            date,
            portfolio_value,
            daily_return_pct,
            SUM(daily_return_pct) OVER (ORDER BY date) as cumulative_return_pct
        FROM returns
        ORDER BY date
    `;

    const result = await db.all(query);
    return result.map(r => ({
        date: r['date'],
        portfolioValue: parseFloat(r['portfolio_value']) || 0,
        cumulativeReturnPct: parseFloat(r['cumulative_return_pct']) || 0
    }));
}

/**
 * Calculate benchmark returns
 */
async function calculateBenchmarkReturns(benchmarkKey) {
    const parquetFile = CONFIG.benchmarks[benchmarkKey];

    // Try to load benchmark data
    try {
        const query = `
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
        `;

        const result = await db.all(query);
        return result.map(r => ({
            date: r['date'],
            closePrice: parseFloat(r['close_price']) || 0,
            cumulativeReturnPct: parseFloat(r['cumulative_return_pct']) || 0
        }));

    } catch (error) {
        console.warn(`Could not load benchmark data for ${benchmarkKey}:`, error.message);
        return [];
    }
}

/**
 * Render analysis results
 */
function renderResults(portfolioReturns, benchmarkReturns, initialCapital) {
    if (portfolioReturns.length === 0) {
        showError('No portfolio data available for analysis');
        return;
    }

    // Calculate summary statistics
    const startDate = portfolioReturns[0].date;
    const endDate = portfolioReturns[portfolioReturns.length - 1].date;
    const finalPortfolioValue = portfolioReturns[portfolioReturns.length - 1].portfolioValue;
    const totalReturn = finalPortfolioValue - initialCapital;
    const totalReturnPct = (totalReturn / initialCapital) * 100;
    const days = Math.ceil((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24));
    const years = days / 365;
    const annualizedReturn = years > 0 ? ((finalPortfolioValue / initialCapital) ** (1 / years) - 1) * 100 : 0;

    // Update stats
    updateStats({
        totalReturn: `${totalReturn >= 0 ? '+' : ''}₹${totalReturn.toLocaleString('en-IN')}`,
        totalReturnPct: `${totalReturn >= 0 ? '+' : ''}${totalReturnPct.toFixed(2)}%`,
        annualizedReturn: `${annualizedReturn >= 0 ? '+' : ''}${annualizedReturn.toFixed(2)}%`,
        portfolioValue: `₹${finalPortfolioValue.toLocaleString('en-IN')}`,
        holdingPeriod: `${days} days (${years.toFixed(1)} years)`
    });

    // Render chart
    renderChart(portfolioReturns, benchmarkReturns);
}

/**
 * Update stats display
 */
function updateStats(stats) {
    // Total Return
    const totalReturnEl = document.getElementById('totalReturn');
    const totalReturn = parseFloat(stats.totalReturnPct.replace(/[+%]/g, ''));
    totalReturnEl.textContent = stats.totalReturnPct;
    totalReturnEl.className = 'stat-value ' + (totalReturn >= 0 ? 'positive' : 'negative');

    // Annualized Return
    const annualizedReturnEl = document.getElementById('annualizedReturn');
    annualizedReturnEl.textContent = stats.annualizedReturn;
    annualizedReturnEl.className = 'stat-value ' + (parseFloat(stats.annualizedReturn.replace(/[+%]/g, '')) >= 0 ? 'positive' : 'negative');

    // Portfolio Value
    document.getElementById('portfolioValue').textContent = stats.portfolioValue;
    document.getElementById('holdingPeriod').textContent = stats.holdingPeriod;
}

/**
 * Render returns chart
 */
function renderChart(portfolioReturns, benchmarkReturns) {
    const ctx = document.getElementById('returnsChart').getContext('2d');

    // Prepare data
    const labels = portfolioReturns.map(r => r.date);
    const portfolioData = portfolioReturns.map(r => r.cumulativeReturnPct);

    // Prepare benchmark data
    let benchmarkData = [];
    if (benchmarkReturns.length > 0) {
        // Find overlapping dates
        const portfolioDates = new Set(portfolioReturns.map(r => r.date));
        benchmarkData = benchmarkReturns
            .filter(r => portfolioDates.has(r.date))
            .map(r => r.cumulativeReturnPct);
    } else {
        // Create empty array of same length
        benchmarkData = portfolioReturns.map(() => 0);
    }

    // Destroy existing chart if any
    if (chart) {
        chart.destroy();
    }

    // Create new chart
    chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels.slice(0, 100), // Limit labels for readability
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
                    labels: {
                        color: '#e0e0e0',
                        font: {
                            size: 12
                        }
                    }
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
                    font: {
                        size: 14
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#888',
                        maxTicksLimit: 10
                    }
                },
                y: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#888',
                        callback: function(value) {
                            return value + '%';
                        }
                    },
                    border: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
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
    elements.errorMessage.textContent = message;
    elements.errorSection.style.display = 'block';
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    init();
});

// Expose functions for testing
window.PortfolioAnalysis = {
    init,
    parseCSV,
    handleFileUpload
};
