import { initDuckDB, runQuery, isReady, asDB, registerParquet } from './duckdb-module.ts';
import { parseCSV, sanitiseCSV } from './portfolio.ts';
import { loadTransactions, getStats } from './analysis.ts';
import { generateInsights, hasDefaultKey } from './insights.ts';
import { buildDailyTimeSeries } from './timeseries.ts';
import type { Transaction, PortfolioStats } from './types.ts';
import type { DailyValue } from './timeseries.ts';

declare const Chart: {
    new (ctx: CanvasRenderingContext2D, config: Record<string, unknown>): ChartInstance;
};
interface ChartInstance { destroy(): void; }

interface BenchmarkPoint {
    x: number;  // epoch ms
    y: number;  // return %
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

const INITIAL_CAPITAL = 100000;

const elements = {
    csvInput: document.getElementById('csvInput') as HTMLInputElement,
    benchmarkSelect: document.getElementById('benchmarkSelect') as HTMLSelectElement,
    loadingSection: document.getElementById('loadingSection') as HTMLElement,
    loadingText: document.getElementById('loadingText') as HTMLElement,
    errorSection: document.getElementById('errorSection') as HTMLElement,
    errorMessage: document.getElementById('errorMessage') as HTMLElement,
    retryBtn: document.getElementById('retryBtn') as HTMLButtonElement,
    uploadSection: document.getElementById('uploadSection') as HTMLElement,
    changeFileBtn: document.getElementById('changeFile') as HTMLButtonElement,
    insightsSection: document.getElementById('insightsSection') as HTMLElement,
    insightsSummary: document.getElementById('insightsSummary') as HTMLElement,
    insightsFull: document.getElementById('insightsFull') as HTMLElement,
    insightsToggle: document.getElementById('insightsToggle') as HTMLButtonElement,
    apiKey: document.getElementById('apiKey') as HTMLInputElement,
    generateInsightsBtn: document.getElementById('generateInsights') as HTMLButtonElement,
    insightsStatus: document.getElementById('insightsStatus') as HTMLElement,
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
    elements.insightsToggle.addEventListener('click', () => {
        const expanded = elements.insightsFull.style.display !== 'none';
        elements.insightsFull.style.display = expanded ? 'none' : 'block';
        elements.insightsToggle.textContent = expanded ? 'Show more' : 'Show less';
    });
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
        const content = sanitiseCSV(await file.text());
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
        const db = asDB();

        const stats = await getStats(db, INITIAL_CAPITAL);
        if (!stats) { showError('No portfolio data available for analysis'); hideLoading(); return; }

        showLoading('Loading stock prices...');
        const dailySeries = await buildDailyTimeSeries(db, INITIAL_CAPITAL);

        showLoading('Loading benchmark...');
        const benchmarkPoints = await calculateBenchmarkReturns(
            elements.benchmarkSelect.value,
            dailySeries.length > 0 ? dailySeries[0].date : 0,
            dailySeries.length > 0 ? dailySeries[dailySeries.length - 1].date : 0
        );

        renderResults(stats, dailySeries, benchmarkPoints);
        elements.uploadSection.style.display = 'none';
        elements.insightsSection.style.display = 'block';
        hideLoading();
    } catch (error) {
        hideLoading();
        showError('Analysis error: ' + (error instanceof Error ? error.message : String(error)));
    }
}

async function calculateBenchmarkReturns(
    benchmarkKey: string, startMs: number, endMs: number
): Promise<BenchmarkPoint[]> {
    if (!startMs || !endMs) return [];
    const parquetFile = CONFIG.benchmarks[benchmarkKey];
    try {
        await registerParquet(parquetFile, `${CONFIG.dataPath}/${parquetFile}`);
        const startDate = new Date(startMs).toISOString().slice(0, 10);
        const endDate = new Date(endMs).toISOString().slice(0, 10);
        const rows = await runQuery(`
            WITH base AS (
                SELECT date, close
                FROM parquet_scan('${parquetFile}')
                WHERE date IS NOT NULL AND close IS NOT NULL
                  AND date >= '${startDate}' AND date <= '${endDate}'
                ORDER BY date
            ),
            first_close AS (
                SELECT close AS c0 FROM base LIMIT 1
            )
            SELECT b.date, ((b.close - fc.c0) / fc.c0) * 100 AS return_pct
            FROM base b, first_close fc
            ORDER BY b.date
        `);
        return rows.map(r => {
            const d = r.date;
            let ts: number;
            if (typeof d === 'number') ts = d;
            else if (d instanceof Date) ts = d.getTime();
            else ts = new Date(String(d)).getTime();
            return { x: ts, y: Number(r.return_pct) || 0 };
        });
    } catch (error) {
        console.warn(`Could not load benchmark data for ${benchmarkKey}:`, (error as Error).message);
        return [];
    }
}

function renderResults(stats: PortfolioStats, dailySeries: DailyValue[], benchmarkPoints: BenchmarkPoint[]): void {
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

    renderChart(dailySeries, benchmarkPoints);
}

function renderChart(dailySeries: DailyValue[], benchmarkPoints: BenchmarkPoint[]): void {
    const ctx = (document.getElementById('returnsChart') as HTMLCanvasElement).getContext('2d')!;

    const portfolioPoints = dailySeries.map(r => ({
        x: r.date,
        y: r.returnPct
    }));

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
                    borderWidth: 2, pointRadius: 0, fill: true, tension: 0.1
                },
                {
                    label: elements.benchmarkSelect.options[elements.benchmarkSelect.selectedIndex].text,
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
                }
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
    elements.insightsSummary.textContent = '';
    elements.insightsSummary.className = 'insights-summary';
    elements.insightsFull.style.display = 'none';
    elements.insightsToggle.style.display = 'none';

    const isPremium = !!userApiKey;

    try {
        const result = await generateInsights(
            asDB(),
            userApiKey ? { apiKey: userApiKey } : {},
            (msg) => { elements.insightsStatus.textContent = msg; }
        );
        elements.insightsStatus.style.display = 'none';

        // Split into bullet lines, show first 2 as summary, rest behind "Show more"
        const bullets = result.split('\n').filter(l => l.trim().startsWith('-'));
        const summaryMd = bullets.slice(0, 2).join('\n');
        const restMd = bullets.slice(2).join('\n');

        elements.insightsSummary.innerHTML = renderMarkdown(summaryMd);
        if (restMd.trim()) {
            elements.insightsFull.innerHTML = renderMarkdown(restMd)
                + (isPremium ? '' : '<p class="insights-tier-note">Free model. Use your own API key for deeper analysis.</p>');
            elements.insightsToggle.style.display = 'inline-block';
            elements.insightsToggle.textContent = 'Show more';
        }
    } catch (err) {
        elements.insightsStatus.style.display = 'none';
        elements.insightsSummary.textContent = 'Error: ' + (err instanceof Error ? err.message : String(err));
        elements.insightsSummary.className = 'insights-summary error';
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
