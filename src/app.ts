import { initDuckDB, runQuery, runSQL, isReady } from './duckdb-module.js';
import { parseCSV, computeStats, buildTimeSeries } from './portfolio.js';
import type { Transaction, PortfolioStats, TimeSeriesPoint } from './portfolio.js';

// Chart.js global (loaded via <script> tag)
declare const Chart: {
    new (ctx: CanvasRenderingContext2D, config: Record<string, unknown>): ChartInstance;
};

interface ChartInstance {
    destroy(): void;
}

interface BenchmarkConfig {
    [key: string]: string;
}

interface BenchmarkReturn {
    date: string | Date;
    closePrice: number;
    cumulativeReturnPct: number;
}

const CONFIG = {
    dataPath: 'data',
    benchmarks: {
        nifty50: 'nifty50.parquet',
        bank_nifty: 'bank_nifty.parquet',
        sensex: 'sensex.parquet',
        nifty_midcap: 'nifty_midcap.parquet',
        bse_500: 'bse_500.parquet'
    } as BenchmarkConfig
};

let chart: ChartInstance | null = null;
let currentTransactions: Transaction[] | null = null;

interface DOMElements {
    csvInput: HTMLInputElement;
    benchmarkSelect: HTMLSelectElement;
    initialCapital: HTMLInputElement;
    statsGrid: HTMLElement;
    loadingSection: HTMLElement;
    loadingText: HTMLElement;
    errorSection: HTMLElement;
    errorMessage: HTMLElement;
    retryBtn: HTMLButtonElement;
}

const elements: DOMElements = {
    csvInput: document.getElementById('csvInput') as HTMLInputElement,
    benchmarkSelect: document.getElementById('benchmarkSelect') as HTMLSelectElement,
    initialCapital: document.getElementById('initialCapital') as HTMLInputElement,
    statsGrid: document.getElementById('statsGrid') as HTMLElement,
    loadingSection: document.getElementById('loadingSection') as HTMLElement,
    loadingText: document.getElementById('loadingText') as HTMLElement,
    errorSection: document.getElementById('errorSection') as HTMLElement,
    errorMessage: document.getElementById('errorMessage') as HTMLElement,
    retryBtn: document.getElementById('retryBtn') as HTMLButtonElement
};

async function init(): Promise<void> {
    showLoading('Initializing DuckDB...');

    try {
        await initDuckDB();
        hideLoading();
        console.log('Portfolio Analysis initialized successfully');
    } catch (error) {
        hideLoading();
        showError('Failed to initialize DuckDB: ' + (error instanceof Error ? error.message : String(error)));
        console.error('Initialization error:', error);
    }
}

function setupEventListeners(): void {
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

async function handleFileUpload(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    showLoading('Parsing transactions...');

    try {
        const content = await file.text();
        const transactions = parseCSV(content);

        if (transactions.length === 0) {
            throw new Error('No valid transactions found in CSV');
        }

        transactions.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

        if (!isReady()) {
            throw new Error('Database not initialized. Please refresh the page and try again.');
        }

        currentTransactions = transactions;

        await createTransactionsTable(transactions);
        await runAnalysis();
        hideLoading();

    } catch (error) {
        hideLoading();
        const errorMsg = error instanceof Error ? error.message : String(error) || 'Unknown error processing CSV';
        showError('Error processing CSV: ' + errorMsg);
        console.error('File upload error:', error);
    }
}

async function createTransactionsTable(transactions: Transaction[]): Promise<void> {
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

async function runAnalysis(): Promise<void> {
    if (!currentTransactions) return;

    showLoading('Analyzing portfolio...');

    try {
        const initialCapital = parseFloat(elements.initialCapital.value) || 100000;

        const stats = computeStats(currentTransactions, initialCapital);

        if (!stats) {
            showError('No portfolio data available for analysis');
            hideLoading();
            return;
        }

        const timeSeries = buildTimeSeries(currentTransactions, initialCapital);

        const benchmark = elements.benchmarkSelect.value;
        const benchmarkReturns = await calculateBenchmarkReturns(benchmark);

        renderResults(stats, timeSeries, benchmarkReturns, initialCapital);
        hideLoading();

    } catch (error) {
        hideLoading();
        showError('Analysis error: ' + (error instanceof Error ? error.message : String(error)));
        console.error('Analysis error:', error);
    }
}

async function calculateBenchmarkReturns(benchmarkKey: string): Promise<BenchmarkReturn[]> {
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
            date: r.date as string | Date,
            closePrice: Number(r.close_price) || 0,
            cumulativeReturnPct: Number(r.cumulative_return_pct) || 0
        }));

    } catch (error) {
        console.warn(`Could not load benchmark data for ${benchmarkKey}:`, (error as Error).message);
        return [];
    }
}

function renderResults(
    stats: PortfolioStats,
    timeSeries: TimeSeriesPoint[],
    benchmarkReturns: BenchmarkReturn[],
    _initialCapital: number
): void {
    updateStats({
        totalReturnPct: `${stats.totalReturn >= 0 ? '+' : ''}${stats.totalReturnPct.toFixed(2)}%`,
        annualizedReturn: `${stats.annualizedReturnPct >= 0 ? '+' : ''}${stats.annualizedReturnPct.toFixed(2)}%`,
        portfolioValue: `\u20B9${stats.portfolioValue.toLocaleString('en-IN')}`,
        holdingPeriod: `${stats.holdingDays} days (${stats.holdingYears.toFixed(1)} years)`
    });

    const pnlGrid = document.getElementById('pnlGrid') as HTMLElement;
    if (stats.realizedPnL !== 0) {
        pnlGrid.style.display = 'grid';
        updatePnLStats({
            totalRealizedPnL: `${stats.realizedPnL >= 0 ? '+' : ''}\u20B9${stats.realizedPnL.toLocaleString('en-IN')}`,
            totalUnrealizedGain: '-',
            fifoCostBasis: `\u20B9${stats.costBasisRemaining.toLocaleString('en-IN')}`,
            stocksCount: `${stats.numStocks}`
        });
    } else {
        pnlGrid.style.display = 'none';
    }

    renderChart(timeSeries, benchmarkReturns);
}

interface PnLDisplayStats {
    totalRealizedPnL: string;
    totalUnrealizedGain: string;
    fifoCostBasis: string;
    stocksCount: string;
}

function updatePnLStats(stats: PnLDisplayStats): void {
    const totalRealizedPnLEl = document.getElementById('totalRealizedPnL') as HTMLElement;
    const totalRealizedPnL = parseFloat(stats.totalRealizedPnL.replace(/[+%\u20B9,]/g, ''));
    totalRealizedPnLEl.textContent = stats.totalRealizedPnL;
    totalRealizedPnLEl.className = 'stat-value ' + (totalRealizedPnL >= 0 ? 'positive' : 'negative');

    const totalUnrealizedGainEl = document.getElementById('totalUnrealizedGain') as HTMLElement;
    totalUnrealizedGainEl.textContent = stats.totalUnrealizedGain;

    (document.getElementById('fifoCostBasis') as HTMLElement).textContent = stats.fifoCostBasis;
    (document.getElementById('stocksCount') as HTMLElement).textContent = stats.stocksCount;
}

interface DisplayStats {
    totalReturnPct: string;
    annualizedReturn: string;
    portfolioValue: string;
    holdingPeriod: string;
}

function updateStats(stats: DisplayStats): void {
    const totalReturnEl = document.getElementById('totalReturn') as HTMLElement;
    const totalReturn = parseFloat(stats.totalReturnPct.replace(/[+%]/g, ''));
    totalReturnEl.textContent = stats.totalReturnPct;
    totalReturnEl.className = 'stat-value ' + (totalReturn >= 0 ? 'positive' : 'negative');

    const annualizedReturnEl = document.getElementById('annualizedReturn') as HTMLElement;
    annualizedReturnEl.textContent = stats.annualizedReturn;
    annualizedReturnEl.className = 'stat-value ' + (parseFloat(stats.annualizedReturn.replace(/[+%]/g, '')) >= 0 ? 'positive' : 'negative');

    (document.getElementById('portfolioValue') as HTMLElement).textContent = stats.portfolioValue;
    (document.getElementById('holdingPeriod') as HTMLElement).textContent = stats.holdingPeriod;
}

function renderChart(timeSeries: TimeSeriesPoint[], benchmarkReturns: BenchmarkReturn[]): void {
    const ctx = (document.getElementById('returnsChart') as HTMLCanvasElement).getContext('2d')!;

    const labels = timeSeries.map(r => r.date);
    const portfolioData = timeSeries.map(r => r.returnPct);

    let benchmarkData: number[];
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
                        label: function(context: { dataset: { label: string }; parsed: { y: number } }) {
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
                        callback: function(value: number) { return value + '%'; }
                    },
                    border: { color: 'rgba(255, 255, 255, 0.1)' }
                }
            }
        }
    });
}

function showLoading(text: string): void {
    elements.loadingText.textContent = text || 'Loading...';
    elements.loadingSection.style.display = 'flex';
}

function hideLoading(): void {
    elements.loadingSection.style.display = 'none';
}

function showError(message: string): void {
    elements.loadingSection.style.display = 'none';
    elements.errorMessage.textContent = message;
    elements.errorSection.style.display = 'block';
    elements.errorSection.style.visibility = 'visible';
    elements.errorSection.style.opacity = '1';
}

document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    init();
});

// Expose functions for testing
(window as unknown as Record<string, unknown>).PortfolioAnalysis = {
    init,
    parseCSV,
    handleFileUpload
};
