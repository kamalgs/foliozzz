import { initDuckDB, runQuery, isReady, asDB, registerParquet } from './duckdb-module.ts';
import { parseCSV } from './portfolio.ts';
import { loadTransactions, getStats, getTimeSeries } from './analysis.ts';
import { generateInsights, hasDefaultKey } from './insights.ts';
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
    uploadSection: document.getElementById('uploadSection') as HTMLElement,
    changeFileBtn: document.getElementById('changeFile') as HTMLButtonElement,
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
    elements.changeFileBtn.addEventListener('click', () => {
        elements.insightsSection.style.display = 'none';
        elements.uploadSection.style.display = 'block';
        elements.csvInput.value = '';
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
        if (transactions.length === 0) throw new Error('No valid transactions found in CSV');

        transactions.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        if (!isReady()) throw new Error('Database not initialized. Please refresh the page and try again.');

        currentTransactions = transactions;
        await loadTransactions(asDB(), transactions);
        await runAnalysis();
        hideLoading();

        // Generate insights only on new file upload
        if (hasDefaultKey()) {
            runInsights();
        } else {
            const details = document.querySelector('.insights-upgrade') as HTMLDetailsElement;
            if (details) details.open = true;
        }
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
        elements.uploadSection.style.display = 'none';
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
        await registerParquet(parquetFile, `${CONFIG.dataPath}/${parquetFile}`);
        const rows = await runQuery(`
            WITH daily AS (
                SELECT date, close,
                    (close - LAG(close) OVER (ORDER BY date)) /
                        NULLIF(LAG(close) OVER (ORDER BY date), 0) * 100 as daily_return_pct
                FROM parquet_scan('${parquetFile}')
                WHERE date IS NOT NULL AND close IS NOT NULL
            )
            SELECT date, close, daily_return_pct,
                SUM(daily_return_pct) OVER (ORDER BY date) as cumulative_return_pct
            FROM daily
            ORDER BY date
        `);
        return rows.map(r => {
            const d = r.date;
            let dateStr: string;
            if (typeof d === 'number') {
                dateStr = new Date(d).toISOString().slice(0, 10);
            } else if (d instanceof Date) {
                dateStr = d.toISOString().slice(0, 10);
            } else {
                dateStr = String(d).slice(0, 10);
            }
            return {
                date: dateStr,
                closePrice: Number(r.close) || 0,
                cumulativeReturnPct: Number(r.cumulative_return_pct) || 0
            };
        });
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

    // Build portfolio {x: Date, y: returnPct} points
    const portfolioPoints = timeSeries.map(r => ({
        x: new Date(String(r.date)).getTime(),
        y: r.returnPct
    }));

    // Build benchmark {x: Date, y: cumulativeReturnPct} points within portfolio date range
    let benchmarkPoints: { x: number; y: number }[] = [];
    if (benchmarkReturns.length > 0 && portfolioPoints.length > 0) {
        const firstTime = portfolioPoints[0].x;
        const lastTime = portfolioPoints[portfolioPoints.length - 1].x;
        benchmarkPoints = benchmarkReturns
            .map(r => ({ x: new Date(String(r.date)).getTime(), y: r.cumulativeReturnPct }))
            .filter(p => p.x >= firstTime && p.x <= lastTime);
    }

    if (chart) chart.destroy();

    chart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [
                {
                    label: 'Portfolio',
                    data: portfolioPoints,
                    borderColor: '#5367ff',
                    backgroundColor: 'rgba(83, 103, 255, 0.08)',
                    borderWidth: 2, pointRadius: 0, fill: true, tension: 0.1,
                    stepped: 'before' as unknown as boolean
                },
                {
                    label: 'Benchmark (' + elements.benchmarkSelect.options[elements.benchmarkSelect.selectedIndex].text + ')',
                    data: benchmarkPoints,
                    borderColor: '#00d09c',
                    borderWidth: 2, pointRadius: 0, fill: false, tension: 0.1
                }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'nearest', intersect: false, axis: 'x' },
            plugins: {
                legend: { position: 'top', labels: { color: '#44475b', font: { size: 12 } } },
                tooltip: {
                    backgroundColor: '#fff', titleColor: '#44475b', bodyColor: '#7c7e8c',
                    borderColor: '#e8e8eb', borderWidth: 1,
                    callbacks: {
                        label: (ctx: { dataset: { label: string }; parsed: { y: number } }) =>
                            ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + '%'
                    }
                },
                title: { display: true, text: 'Cumulative Returns Comparison', color: '#44475b', font: { size: 14 } }
            },
            scales: {
                x: {
                    type: 'time',
                    time: { unit: 'month', displayFormats: { month: 'MMM yyyy' } },
                    grid: { color: '#f0f0f3' },
                    ticks: { color: '#9b9dab', maxTicksLimit: 10 }
                },
                y: {
                    grid: { color: '#f0f0f3' },
                    ticks: { color: '#9b9dab', callback: (v: number) => v + '%' },
                    border: { color: '#e8e8eb' }
                }
            }
        }
    });
}

async function runInsights(userApiKey?: string): Promise<void> {
    if (!currentTransactions) return;

    elements.generateInsightsBtn.disabled = true;
    elements.insightsStatus.style.display = 'block';
    elements.insightsOutput.textContent = '';
    elements.insightsOutput.className = 'insights-output';

    const isPremium = !!userApiKey;

    try {
        const result = await generateInsights(
            asDB(),
            userApiKey ? { apiKey: userApiKey } : {},
            (msg) => { elements.insightsStatus.textContent = msg; }
        );
        elements.insightsStatus.style.display = 'none';
        elements.insightsOutput.innerHTML = renderMarkdown(result)
            + (isPremium ? '' : '<p class="insights-tier-note">Generated with free model. Enter your OpenRouter API key below for deeper analysis.</p>');
    } catch (err) {
        elements.insightsStatus.style.display = 'none';
        elements.insightsOutput.textContent = 'Error: ' + (err instanceof Error ? err.message : String(err));
        elements.insightsOutput.className = 'insights-output error';
    } finally {
        elements.generateInsightsBtn.disabled = !elements.apiKey.value.trim();
    }
}

async function handleGenerateInsights(): Promise<void> {
    const apiKey = elements.apiKey.value.trim();
    if (!apiKey) return;
    await runInsights(apiKey);
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
