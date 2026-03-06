import { initDuckDB, runQuery, isReady, asDB } from './duckdb-module.ts';
import { parseCSV } from './portfolio.ts';
import { loadTransactions, getStats, getTimeSeries } from './analysis.ts';
import { generateInsights } from './insights.ts';
import type { Transaction, PortfolioStats, TimeSeriesPoint } from './types.ts';

declare const Chart: {
    new (ctx: CanvasRenderingContext2D, config: Record<string, unknown>): ChartInstance;
};
interface ChartInstance { destroy(): void; }

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
    } as Record<string, string>
};

let chart: ChartInstance | null = null;
let currentTransactions: Transaction[] | null = null;

const elements = {
    csvInput: document.getElementById('csvInput') as HTMLInputElement,
    benchmarkSelect: document.getElementById('benchmarkSelect') as HTMLSelectElement,
    initialCapital: document.getElementById('initialCapital') as HTMLInputElement,
    loadingSection: document.getElementById('loadingSection') as HTMLElement,
    loadingText: document.getElementById('loadingText') as HTMLElement,
    errorSection: document.getElementById('errorSection') as HTMLElement,
    errorMessage: document.getElementById('errorMessage') as HTMLElement,
    retryBtn: document.getElementById('retryBtn') as HTMLButtonElement,
    insightsSection: document.getElementById('insightsSection') as HTMLElement,
    apiKey: document.getElementById('apiKey') as HTMLInputElement,
    generateInsightsBtn: document.getElementById('generateInsights') as HTMLButtonElement,
    insightsStatus: document.getElementById('insightsStatus') as HTMLElement,
    insightsOutput: document.getElementById('insightsOutput') as HTMLElement
};

async function init(): Promise<void> {
    showLoading('Initializing DuckDB...');
    try {
        await initDuckDB();
        hideLoading();
    } catch (error) {
        hideLoading();
        showError('Failed to initialize DuckDB: ' + (error instanceof Error ? error.message : String(error)));
    }
}

function setupEventListeners(): void {
    elements.csvInput.addEventListener('change', handleFileUpload);
    elements.retryBtn.addEventListener('click', () => {
        elements.errorSection.style.display = 'none';
        init();
    });
    elements.benchmarkSelect.addEventListener('change', async () => {
        if (currentTransactions) await runAnalysis();
    });
    elements.apiKey.addEventListener('input', () => {
        elements.generateInsightsBtn.disabled = !elements.apiKey.value.trim();
    });
    elements.generateInsightsBtn.addEventListener('click', handleGenerateInsights);
}

async function handleFileUpload(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    showLoading('Parsing transactions...');
    try {
        const content = await file.text();
        const transactions = parseCSV(content);
        if (transactions.length === 0) throw new Error('No valid transactions found in CSV');

        transactions.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        if (!isReady()) throw new Error('Database not initialized. Please refresh the page and try again.');

        currentTransactions = transactions;
        await loadTransactions(asDB(), transactions);
        await runAnalysis();
        hideLoading();
    } catch (error) {
        hideLoading();
        showError('Error processing CSV: ' + (error instanceof Error ? error.message : String(error)));
    }
}

async function runAnalysis(): Promise<void> {
    if (!currentTransactions) return;
    showLoading('Analyzing portfolio...');

    try {
        const initialCapital = parseFloat(elements.initialCapital.value) || 100000;
        const db = asDB();

        const stats = await getStats(db, initialCapital);
        if (!stats) { showError('No portfolio data available for analysis'); hideLoading(); return; }

        const timeSeries = await getTimeSeries(db, initialCapital);
        const benchmarkReturns = await calculateBenchmarkReturns(elements.benchmarkSelect.value);

        renderResults(stats, timeSeries, benchmarkReturns);
        elements.insightsSection.style.display = 'block';
        hideLoading();
    } catch (error) {
        hideLoading();
        showError('Analysis error: ' + (error instanceof Error ? error.message : String(error)));
    }
}

async function calculateBenchmarkReturns(benchmarkKey: string): Promise<BenchmarkReturn[]> {
    const parquetFile = CONFIG.benchmarks[benchmarkKey];
    try {
        const rows = await runQuery(`
            SELECT
                date,
                close_price,
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

function renderResults(stats: PortfolioStats, timeSeries: TimeSeriesPoint[], benchmarkReturns: BenchmarkReturn[]): void {
    const el = (id: string) => document.getElementById(id) as HTMLElement;

    const totalReturnEl = el('totalReturn');
    totalReturnEl.textContent = `${stats.totalReturn >= 0 ? '+' : ''}${stats.totalReturnPct.toFixed(2)}%`;
    totalReturnEl.className = 'stat-value ' + (stats.totalReturn >= 0 ? 'positive' : 'negative');

    const annualizedEl = el('annualizedReturn');
    annualizedEl.textContent = `${stats.annualizedReturnPct >= 0 ? '+' : ''}${stats.annualizedReturnPct.toFixed(2)}%`;
    annualizedEl.className = 'stat-value ' + (stats.annualizedReturnPct >= 0 ? 'positive' : 'negative');

    el('portfolioValue').textContent = `\u20B9${stats.portfolioValue.toLocaleString('en-IN')}`;
    el('holdingPeriod').textContent = `${stats.holdingDays} days (${stats.holdingYears.toFixed(1)} years)`;

    const pnlGrid = el('pnlGrid');
    if (stats.realizedPnL !== 0) {
        pnlGrid.style.display = 'grid';
        const pnlEl = el('totalRealizedPnL');
        pnlEl.textContent = `${stats.realizedPnL >= 0 ? '+' : ''}\u20B9${stats.realizedPnL.toLocaleString('en-IN')}`;
        pnlEl.className = 'stat-value ' + (stats.realizedPnL >= 0 ? 'positive' : 'negative');
        el('totalUnrealizedGain').textContent = '-';
        el('fifoCostBasis').textContent = `\u20B9${stats.costBasisRemaining.toLocaleString('en-IN')}`;
        el('stocksCount').textContent = `${stats.numStocks}`;
    } else {
        pnlGrid.style.display = 'none';
    }

    renderChart(timeSeries, benchmarkReturns);
}

function renderChart(timeSeries: TimeSeriesPoint[], benchmarkReturns: BenchmarkReturn[]): void {
    const ctx = (document.getElementById('returnsChart') as HTMLCanvasElement).getContext('2d')!;
    const labels = timeSeries.map(r => r.date);
    const portfolioData = timeSeries.map(r => r.returnPct);

    let benchmarkData: number[];
    if (benchmarkReturns.length > 0) {
        const dates = new Set(timeSeries.map(r => String(r.date)));
        benchmarkData = benchmarkReturns.filter(r => dates.has(String(r.date))).map(r => r.cumulativeReturnPct);
    } else {
        benchmarkData = timeSeries.map(() => 0);
    }

    if (chart) chart.destroy();

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
                    borderWidth: 2, pointRadius: 2, fill: true, tension: 0.1
                },
                {
                    label: 'Benchmark (' + elements.benchmarkSelect.options[elements.benchmarkSelect.selectedIndex].text + ')',
                    data: benchmarkData.slice(0, 100),
                    borderColor: '#4caf50',
                    borderWidth: 2, pointRadius: 2, fill: false, tension: 0.1
                }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { color: '#e0e0e0', font: { size: 12 } } },
                tooltip: {
                    backgroundColor: 'rgba(0,0,0,0.8)', titleColor: '#fff', bodyColor: '#e0e0e0',
                    borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1,
                    callbacks: {
                        label: (ctx: { dataset: { label: string }; parsed: { y: number } }) =>
                            ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + '%'
                    }
                },
                title: { display: true, text: 'Cumulative Returns Comparison', color: '#fff', font: { size: 14 } }
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#888', maxTicksLimit: 10 } },
                y: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#888', callback: (v: number) => v + '%' },
                    border: { color: 'rgba(255,255,255,0.1)' }
                }
            }
        }
    });
}

async function handleGenerateInsights(): Promise<void> {
    const apiKey = elements.apiKey.value.trim();
    if (!apiKey || !currentTransactions) return;

    elements.generateInsightsBtn.disabled = true;
    elements.insightsStatus.style.display = 'block';
    elements.insightsOutput.textContent = '';

    try {
        const result = await generateInsights(asDB(), apiKey, (msg) => {
            elements.insightsStatus.textContent = msg;
        });
        elements.insightsStatus.style.display = 'none';
        elements.insightsOutput.innerHTML = renderMarkdown(result);
    } catch (err) {
        elements.insightsStatus.style.display = 'none';
        elements.insightsOutput.textContent = 'Error: ' + (err instanceof Error ? err.message : String(err));
        elements.insightsOutput.className = 'insights-output error';
    } finally {
        elements.generateInsightsBtn.disabled = false;
    }
}

function renderMarkdown(md: string): string {
    const escaped = md
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Convert bullet lines to <li>, then wrap consecutive <li>s in <ul>
    const withLists = escaped
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
        .replace(/^- (.+)$/gm, '<li>$1</li>');
    // Wrap consecutive <li> blocks in <ul>
    const withUl = withLists.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
    return withUl.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
}

function showLoading(text: string): void {
    elements.loadingText.textContent = text;
    elements.loadingSection.style.display = 'flex';
}
function hideLoading(): void { elements.loadingSection.style.display = 'none'; }
function showError(message: string): void {
    elements.loadingSection.style.display = 'none';
    elements.errorMessage.textContent = message;
    elements.errorSection.style.display = 'block';
    elements.errorSection.style.visibility = 'visible';
    elements.errorSection.style.opacity = '1';
}

document.addEventListener('DOMContentLoaded', () => { setupEventListeners(); init(); });

(window as unknown as Record<string, unknown>).PortfolioAnalysis = { init, parseCSV, handleFileUpload };
