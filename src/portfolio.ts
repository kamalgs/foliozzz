export type { Transaction, Holding, SellDetail, PortfolioStats, TimeSeriesPoint, DB } from './types.ts';

import type { Transaction } from './types.ts';

// ── Format configuration ──────────────────────────────────────────────────────

interface FormatConfig {
    readonly name: string;
    readonly delimiter: '\t' | ',';
    /** All fragments must appear (case-insensitive) in the header row. */
    readonly headerSignature: readonly string[];
    readonly columns: {
        readonly isin: string;
        readonly type?: string;
        readonly quantity: string;
        /** Per-share price column. Mutually exclusive with `value`. */
        readonly price?: string;
        /** Total transaction value — per-share price = value / quantity. */
        readonly value?: string;
        readonly date: string;
        readonly status?: string;
    };
    /** Status values to accept (case-insensitive). Absent = accept all rows. */
    readonly acceptStatus?: readonly string[];
    /** Default type when no type column is present. */
    readonly defaultType?: 'BUY' | 'SELL';
}

// Groww broker export: tab-delimited, metadata rows before header,
// Value column = total cost, date format "DD-MM-YYYY HH:MM AM/PM"
const GROWW_FORMAT: FormatConfig = {
    name: 'Groww',
    delimiter: '\t',
    headerSignature: ['isin', 'execution date'],
    columns: {
        isin: 'isin',
        type: 'type',
        quantity: 'quantity',
        value: 'value',
        date: 'execution date',
        status: 'status',
    },
    acceptStatus: ['executed'],
};

// Generic named-column CSV (comma-delimited) — supports both price and value columns
const GENERIC_CSV_FORMAT: FormatConfig = {
    name: 'Generic CSV',
    delimiter: ',',
    headerSignature: ['isin'],
    columns: {
        isin: 'isin',
        type: 'type',
        quantity: 'quantity',
        price: 'price',
        value: 'value',
        date: 'date',
        status: 'status',
    },
    acceptStatus: ['executed'],
};

// Ordered most-specific first — first match wins
const KNOWN_FORMATS: readonly FormatConfig[] = [GROWW_FORMAT, GENERIC_CSV_FORMAT];

// ── Helpers ───────────────────────────────────────────────────────────────────

function splitLine(line: string, delimiter: '\t' | ','): string[] {
    return line.split(delimiter).map(p => p.trim());
}

// Accepts DD-MM-YYYY (and DD-MM-YYYY HH:MM …) and YYYY-MM-DD — returns YYYY-MM-DD or null
function normaliseDate(raw: string): string | null {
    const dmy = raw.match(/^(\d{2})-(\d{2})-(\d{4})/);
    if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    return null;
}

// ── Format recogniser ─────────────────────────────────────────────────────────

function recogniseFormat(lines: string[]): { config: FormatConfig; headerIdx: number } | null {
    for (let i = 0; i < lines.length; i++) {
        const lower = lines[i].toLowerCase();
        if (!lower.includes('isin')) continue;

        const isTab = (lines[i].match(/\t/g) ?? []).length >= 2;
        for (const config of KNOWN_FORMATS) {
            const delimMatch = config.delimiter === '\t' ? isTab : !isTab;
            if (!delimMatch) continue;
            if (!config.headerSignature.every(s => lower.includes(s))) continue;

            // Verify all required columns are actually present before committing
            const hdrs = splitLine(lines[i], config.delimiter).map(h => h.toLowerCase());
            const find = (needle: string) => hdrs.some(h => h.includes(needle));
            if (!find(config.columns.isin) || !find(config.columns.quantity) || !find(config.columns.date)) continue;

            return { config, headerIdx: i };
        }
    }
    return null;
}

// ── Config-based parser ───────────────────────────────────────────────────────

function parseWithConfig(lines: string[], config: FormatConfig, headerIdx: number): Transaction[] {
    const transactions: Transaction[] = [];
    const headers = splitLine(lines[headerIdx], config.delimiter).map(h => h.toLowerCase());
    const idx = (needle: string) => headers.findIndex(h => h.includes(needle));

    const { columns } = config;
    const isinIdx     = idx(columns.isin);
    const quantityIdx = idx(columns.quantity);
    const dateIdx     = idx(columns.date);
    const typeIdx     = columns.type   != null ? idx(columns.type)   : -1;
    const priceIdx    = columns.price  != null ? idx(columns.price)  : -1;
    const valueIdx    = columns.value  != null ? idx(columns.value)  : -1;
    const statusIdx   = columns.status != null ? idx(columns.status) : -1;

    if (isinIdx < 0 || quantityIdx < 0 || dateIdx < 0) return transactions;

    for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = splitLine(line, config.delimiter);
        if (parts.length < 3) continue;

        if (statusIdx >= 0 && config.acceptStatus && parts[statusIdx]) {
            if (!config.acceptStatus.includes(parts[statusIdx].toLowerCase())) continue;
        }

        const isin = (parts[isinIdx] ?? '').toUpperCase();
        if (!isin) continue;

        const quantity = parseFloat(parts[quantityIdx] ?? '');
        if (!quantity || quantity <= 0) continue;

        const date = normaliseDate(parts[dateIdx] ?? '');
        if (!date) continue;

        const typeRaw = typeIdx >= 0 ? (parts[typeIdx] ?? '').toUpperCase() : '';
        const type: 'BUY' | 'SELL' = typeRaw === 'SELL' ? 'SELL' : (config.defaultType ?? 'BUY');

        let price: number;
        if (valueIdx >= 0 && priceIdx < 0) {
            const total = parseFloat(parts[valueIdx] ?? '');
            if (!total || total <= 0) continue;
            price = total / quantity;
        } else if (priceIdx >= 0) {
            price = parseFloat(parts[priceIdx] ?? '');
            if (!price || price <= 0) continue;
        } else {
            continue;
        }

        transactions.push({ date, isin, quantity, price, type });
    }

    return transactions;
}

// ── Legacy positional parser (fallback) ──────────────────────────────────────

function parseLegacy(lines: string[]): Transaction[] {
    const transactions: Transaction[] = [];
    const firstLine = lines[0]?.toLowerCase() ?? '';
    const hasHeader = firstLine.includes('date') || firstLine.includes('symbol');
    const startIndex = hasHeader ? 1 : 0;

    for (let i = startIndex; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim());

        if (parts.length >= 5) {
            const [date, isin, quantity, price, type] = parts;
            if (date && isin && quantity && price && type) {
                transactions.push({
                    date,
                    isin: isin.toUpperCase(),
                    quantity: parseFloat(quantity),
                    price: parseFloat(price),
                    type: type.toUpperCase() as 'BUY' | 'SELL',
                });
            }
        } else if (parts.length >= 4) {
            const [date, symbol, quantity, price] = parts;
            if (date && symbol && quantity && price) {
                transactions.push({
                    date,
                    isin: symbol.toUpperCase(),
                    quantity: parseFloat(quantity),
                    price: parseFloat(price),
                    type: 'BUY',
                });
            }
        }
    }

    return transactions;
}

// ── PII sanitisation ──────────────────────────────────────────────────────────

// Broker metadata row keys that contain personal information.
// Matched case-insensitively against the first tab-delimited cell.
const PII_KEYS = ['name', 'unique client code', 'client code', 'client id', 'pan'];

/**
 * Replace the values of known PII metadata rows with [REDACTED].
 * Safe to call on any CSV/TSV content — non-matching lines are returned unchanged.
 */
export function sanitiseCSV(content: string): string {
    return content.split('\n').map(line => {
        const tabIdx = line.indexOf('\t');
        if (tabIdx < 0) return line;
        const key = line.slice(0, tabIdx).trim().toLowerCase();
        if (PII_KEYS.some(k => key === k)) return line.slice(0, tabIdx + 1) + '[REDACTED]';
        return line;
    }).join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

export function parseCSV(content: string): Transaction[] {
    const lines = content.split('\n');
    const match = recogniseFormat(lines);
    if (match) return parseWithConfig(lines, match.config, match.headerIdx);
    return parseLegacy(lines);
}
