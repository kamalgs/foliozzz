/**
 * LLM-powered portfolio insights via agentic tool-use loop.
 *
 * Architecture:
 *   1. Define tools that map to OLAP cube slice queries
 *   2. Send portfolio context + tools to LLM (OpenRouter API)
 *   3. LLM calls tools to explore data → we execute against DuckDB
 *   4. Loop until LLM produces final text insights
 *
 * The LLM sees the cube as a set of high-level analysis tools plus
 * a raw SQL escape hatch for flexible exploration.
 */

import type { DB } from './types.ts';
import {
    pnlByStock, pnlByPeriod, topPeriods, holdingsConcentration,
    pnlBySector, tradeDetail,
    type CubeFilter, type TimeGranularity
} from './cube.ts';

// ── Types ─────────────────────────────────────────────────────

interface Message {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

interface ToolDef {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

// ── Tool definitions for the LLM ──────────────────────────────

const FILTER_PROPS = {
    isin:     { type: 'string', description: 'Filter by ISIN (e.g. INE002A01018)' },
    sector:   { type: 'string', description: 'Filter by sector' },
    dateFrom: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
    dateTo:   { type: 'string', description: 'End date (YYYY-MM-DD)' }
};

const TOOLS: ToolDef[] = [
    {
        type: 'function',
        function: {
            name: 'pnl_by_stock',
            description: 'Get realized PnL breakdown by stock. Shows total PnL, return %, trade count, and avg holding days per ISIN.',
            parameters: {
                type: 'object',
                properties: FILTER_PROPS,
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'pnl_by_period',
            description: 'Get realized PnL aggregated by time period. Choose granularity: week, month, quarter, or year.',
            parameters: {
                type: 'object',
                properties: {
                    granularity: { type: 'string', enum: ['week', 'month', 'quarter', 'year'], description: 'Time granularity' },
                    ...FILTER_PROPS
                },
                required: ['granularity']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'top_periods',
            description: 'Get the best or worst performing periods by PnL.',
            parameters: {
                type: 'object',
                properties: {
                    granularity: { type: 'string', enum: ['week', 'month', 'quarter', 'year'] },
                    direction: { type: 'string', enum: ['best', 'worst'] },
                    limit: { type: 'number', description: 'Number of periods to return (default 5)' },
                    ...FILTER_PROPS
                },
                required: ['granularity', 'direction']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'holdings_concentration',
            description: 'Get current portfolio holdings with concentration weights (% of total value).',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'pnl_by_sector',
            description: 'Get realized PnL aggregated by sector.',
            parameters: {
                type: 'object',
                properties: FILTER_PROPS,
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'trade_detail',
            description: 'Get individual FIFO-matched trade details with buy/sell dates, prices, PnL, and holding days.',
            parameters: {
                type: 'object',
                properties: FILTER_PROPS,
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'run_sql',
            description: 'Run arbitrary read-only SQL against the portfolio database. Available tables: transactions (seq, date, isin, quantity, price, type), fact_trades (trade_id, isin, buy_date, sell_date, buy_price, sell_price, quantity, cost_basis, proceeds, pnl, return_pct, holding_days), fact_positions (isin, buy_date, cost_basis, quantity, value_at_cost), dim_calendar (date, year, quarter, month, week, year_month, year_week, year_quarter), dim_stock (isin, name, sector, industry).',
            parameters: {
                type: 'object',
                properties: {
                    sql: { type: 'string', description: 'SQL SELECT query to execute' }
                },
                required: ['sql']
            }
        }
    }
];

// ── Tool execution ────────────────────────────────────────────

function buildFilter(args: Record<string, unknown>): CubeFilter | undefined {
    const f: CubeFilter = {};
    if (typeof args.isin === 'string')     f.isin = args.isin;
    if (typeof args.sector === 'string')   f.sector = args.sector;
    if (typeof args.dateFrom === 'string') f.dateFrom = args.dateFrom;
    if (typeof args.dateTo === 'string')   f.dateTo = args.dateTo;
    return Object.keys(f).length > 0 ? f : undefined;
}

async function executeTool(db: DB, name: string, args: Record<string, unknown>): Promise<string> {
    let sql: string;
    switch (name) {
        case 'pnl_by_stock':
            sql = pnlByStock(buildFilter(args));
            break;
        case 'pnl_by_period':
            sql = pnlByPeriod(args.granularity as TimeGranularity, buildFilter(args));
            break;
        case 'top_periods':
            sql = topPeriods(
                args.granularity as TimeGranularity,
                args.direction as 'best' | 'worst',
                typeof args.limit === 'number' ? args.limit : 5,
                buildFilter(args)
            );
            break;
        case 'holdings_concentration':
            sql = holdingsConcentration();
            break;
        case 'pnl_by_sector':
            sql = pnlBySector(buildFilter(args));
            break;
        case 'trade_detail':
            sql = tradeDetail(buildFilter(args));
            break;
        case 'run_sql': {
            const userSql = String(args.sql).trim();
            if (!userSql.toUpperCase().startsWith('SELECT'))
                return JSON.stringify({ error: 'Only SELECT queries are allowed' });
            sql = userSql;
            break;
        }
        default:
            return JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    const rows = await db.query(sql);
    // Truncate large results to stay within context limits
    const json = JSON.stringify(rows);
    if (json.length > 8000) {
        const truncated = rows.slice(0, 20);
        return JSON.stringify({ rows: truncated, note: `Showing 20 of ${rows.length} rows. Use filters to narrow results.` });
    }
    return json;
}

// ── System prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a concise portfolio analyst. You have access to a user's stock trading data through analysis tools.

Your job:
1. Use the tools to explore the portfolio data — look at PnL by stock, by period, concentration, trade details, etc.
2. Identify patterns, risks, and actionable observations.
3. Produce succinct, insightful analysis in 4-6 bullet points.

Guidelines:
- Start by getting an overview (PnL by stock, holdings concentration).
- Then drill into interesting patterns (best/worst periods, individual trades).
- Focus on non-obvious insights, not just restating numbers.
- Use specific numbers to support your points.
- Keep the final output brief and high-signal.
- Format the final output as markdown bullet points.
- Use INR (₹) for currency values.`;

// ── Agentic loop ──────────────────────────────────────────────

const MAX_TURNS = 8;

export async function generateInsights(
    db: DB,
    apiKey: string,
    onStatus?: (msg: string) => void
): Promise<string> {
    const messages: Message[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'Analyze my portfolio and provide key insights.' }
    ];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
        onStatus?.(`Thinking... (step ${turn + 1})`);

        const response = await callLLM(apiKey, messages);

        if (!response.tool_calls || response.tool_calls.length === 0) {
            // Final text response
            return response.content || 'No insights generated.';
        }

        // Add assistant message with tool calls
        messages.push({
            role: 'assistant',
            content: response.content,
            tool_calls: response.tool_calls
        });

        // Execute each tool call and add results
        for (const tc of response.tool_calls) {
            onStatus?.(`Querying: ${tc.function.name}...`);
            let result: string;
            try {
                const args = JSON.parse(tc.function.arguments);
                result = await executeTool(db, tc.function.name, args);
            } catch (err) {
                result = JSON.stringify({ error: String(err) });
            }
            messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: result
            });
        }
    }

    return 'Analysis incomplete — reached maximum exploration steps.';
}

// ── LLM API call (OpenRouter) ─────────────────────────────────

async function callLLM(
    apiKey: string,
    messages: Message[]
): Promise<{ content: string | null; tool_calls?: ToolCall[] }> {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'anthropic/claude-sonnet-4',
            messages,
            tools: TOOLS,
            max_tokens: 4096
        })
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`API error ${res.status}: ${body}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0]?.message;
    if (!choice) throw new Error('No response from LLM');

    return {
        content: choice.content ?? null,
        tool_calls: choice.tool_calls
    };
}
