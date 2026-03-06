var rt="https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm",A=null,S=null,p=null;async function it(){return A||(A=await import(rt),A)}async function k(){if(p)return;let t=await it(),s=t.getJsDelivrBundles(),e=await t.selectBundle(s),n=URL.createObjectURL(new Blob([`importScripts("${e.mainWorker}");`],{type:"text/javascript"})),r=new Worker(n),i=new t.ConsoleLogger;S=new t.AsyncDuckDB(i,r),await S.instantiate(e.mainModule,e.pthreadWorker),p=await S.connect()}function B(){return p!==null}async function at(t){if(!p)throw new Error("DuckDB not initialized. Call initDuckDB() first.");await p.query(t)}async function w(t){if(!p)throw new Error("DuckDB not initialized. Call initDuckDB() first.");let s=await p.query(t);return ot(s)}async function b(t,s){if(!S)throw new Error("DuckDB not initialized. Call initDuckDB() first.");let e=await fetch(s);if(!e.ok)throw new Error(`Failed to fetch ${s}: ${e.status}`);let n=await e.arrayBuffer();await S.registerFileBuffer(t,new Uint8Array(n))}function T(){return{exec:at,query:w}}function ot(t){let s=[],e=t.schema.fields,n=t.numRows;for(let r=0;r<n;r++){let i={};for(let o of e){let l=t.getChild(o.name);i[o.name]=lt(l.get(r))}s.push(i)}return s}function lt(t){if(t==null)return t;if(typeof t=="bigint")return Number(t);if(typeof t=="object"&&t!==null&&!(t instanceof Date)){let s=t;if(typeof s.toString=="function"){let e=s.toString();if(e!==""&&e!=="[object Object]"&&!isNaN(Number(e)))return Number(e)}}return typeof t=="string"&&t!==""&&!isNaN(Number(t))?Number(t):t}function D(t){let s=t.trim().split(`
`),e=[],n=s[0].toLowerCase(),i=n.includes("date")||n.includes("isin")?1:0;for(let o=i;o<s.length;o++){let l=s[o].split(",").map(c=>c.trim());if(l.length>=5){let[c,u,d,y,M]=l;c&&u&&d&&y&&M&&e.push({date:c,isin:u.toUpperCase(),quantity:parseFloat(d),price:parseFloat(y),type:M.toUpperCase()})}else if(l.length>=4){let[c,u,d,y]=l;c&&u&&d&&y&&e.push({date:c,isin:u.toUpperCase(),quantity:parseFloat(d),price:parseFloat(y),type:"BUY"})}}return e}var E=`
    -- Layer 1a: Buy lots with cumulative quantity ranges per ISIN
    buy_lots AS (
        SELECT isin, date, price, quantity,
            SUM(quantity) OVER (PARTITION BY isin ORDER BY seq) - quantity AS cum_before,
            SUM(quantity) OVER (PARTITION BY isin ORDER BY seq) AS cum_after
        FROM transactions
        WHERE type = 'BUY'
    ),

    -- Layer 1b: Sell orders with cumulative quantity ranges per ISIN
    sell_orders AS (
        SELECT isin, date, price, quantity,
            SUM(quantity) OVER (PARTITION BY isin ORDER BY seq) - quantity AS cum_before,
            SUM(quantity) OVER (PARTITION BY isin ORDER BY seq) AS cum_after
        FROM transactions
        WHERE type = 'SELL'
    ),

    -- Layer 2: FIFO matching via cumulative range overlap
    fifo_matches AS (
        SELECT
            b.isin,
            b.date AS buy_date, b.price AS buy_price,
            s.date AS sell_date, s.price AS sell_price,
            LEAST(b.cum_after, s.cum_after)
                - GREATEST(b.cum_before, s.cum_before) AS matched_qty
        FROM buy_lots b
        JOIN sell_orders s
            ON  b.isin = s.isin
            AND b.cum_before < s.cum_after
            AND s.cum_before < b.cum_after
    ),

    -- Layer 3a: Total sold per ISIN
    sold_per_isin AS (
        SELECT isin, SUM(quantity) AS total_sold
        FROM transactions
        WHERE type = 'SELL'
        GROUP BY isin
    ),

    -- Layer 3b: Remaining shares per buy lot after FIFO consumption
    --   Formula: remaining = max(0, cum_after - max(cum_before, total_sold))
    remaining_lots AS (
        SELECT
            b.isin, b.date, b.price AS cost_basis,
            GREATEST(0,
                b.cum_after - GREATEST(b.cum_before, COALESCE(s.total_sold, 0))
            ) AS shares
        FROM buy_lots b
        LEFT JOIN sold_per_isin s ON b.isin = s.isin
    )`,F="DROP TABLE IF EXISTS transactions",P=`
    CREATE TABLE transactions (
        seq INTEGER,
        date DATE,
        isin VARCHAR,
        quantity DOUBLE,
        price DOUBLE,
        type VARCHAR
    )`;function x(t){return`
WITH ${E},

raw AS (
    SELECT
        COALESCE(SUM(CASE WHEN type = 'BUY'  THEN quantity * price END), 0) AS total_invested,
        COALESCE(SUM(CASE WHEN type = 'SELL' THEN quantity * price END), 0) AS total_proceeds,
        (SELECT COALESCE(SUM(matched_qty * (sell_price - buy_price)), 0)
         FROM fifo_matches) AS realized_pnl,
        (SELECT COALESCE(SUM(shares * cost_basis), 0)
         FROM remaining_lots WHERE shares > 0) AS cost_basis_remaining,
        (SELECT COUNT(DISTINCT isin)
         FROM remaining_lots WHERE shares > 0) AS num_stocks,
        MIN(date) AS first_date,
        MAX(date) AS last_date,
        DATEDIFF('day', MIN(date), MAX(date)) AS holding_days
    FROM transactions
)

SELECT
    total_invested,
    total_proceeds,
    realized_pnl,
    cost_basis_remaining,
    num_stocks,
    first_date::VARCHAR AS first_date,
    last_date::VARCHAR  AS last_date,
    holding_days,
    ${t} - total_invested + total_proceeds AS cash_balance,
    ${t} - total_invested + total_proceeds + cost_basis_remaining AS portfolio_value,
    realized_pnl AS total_return,
    CASE WHEN ${t} > 0
        THEN realized_pnl * 100.0 / ${t}
        ELSE 0
    END AS total_return_pct,
    holding_days / 365.0 AS holding_years,
    CASE WHEN holding_days > 0
        THEN (POWER((${t} + realized_pnl) * 1.0 / ${t},
                     365.0 / holding_days) - 1) * 100
        ELSE 0
    END AS annualized_return_pct
FROM raw`}function U(){return`
WITH ${E}
SELECT isin, cost_basis AS cost_basis, shares
FROM remaining_lots
WHERE shares > 0
ORDER BY isin, cost_basis`}function q(){return`
WITH ${E}
SELECT
    sell_date::VARCHAR AS date,
    isin,
    matched_qty AS shares_sold,
    sell_price  AS sale_price,
    buy_price   AS cost_basis,
    matched_qty * (sell_price - buy_price) AS pnl
FROM fifo_matches
ORDER BY sell_date, isin, buy_price`}var ut=`
    CREATE OR REPLACE TABLE dim_calendar AS
    WITH RECURSIVE bounds AS (
        SELECT MIN(date) AS min_d, MAX(date) AS max_d FROM transactions
    ),
    dates AS (
        SELECT min_d AS d, max_d FROM bounds
        UNION ALL
        SELECT d + INTERVAL 1 DAY, max_d FROM dates WHERE d < max_d
    )
    SELECT
        d::DATE                           AS date,
        EXTRACT(year    FROM d)::INTEGER  AS year,
        EXTRACT(quarter FROM d)::INTEGER  AS quarter,
        EXTRACT(month   FROM d)::INTEGER  AS month,
        EXTRACT(week    FROM d)::INTEGER  AS week,
        EXTRACT(dow     FROM d)::INTEGER  AS day_of_week,
        STRFTIME(d, '%Y-%m')              AS year_month,
        STRFTIME(d, '%Y-W') || LPAD(EXTRACT(week FROM d)::VARCHAR, 2, '0') AS year_week,
        STRFTIME(d, '%Y-Q') || EXTRACT(quarter FROM d) AS year_quarter
    FROM dates`,dt=`
    CREATE OR REPLACE TABLE dim_stock AS
    SELECT DISTINCT
        isin,
        NULL::VARCHAR AS name,
        NULL::VARCHAR AS sector,
        NULL::VARCHAR AS industry
    FROM transactions`,pt=`
    CREATE OR REPLACE TABLE fact_trades AS
    WITH ${E}
    SELECT
        ROW_NUMBER() OVER (ORDER BY sell_date, isin, buy_price) AS trade_id,
        isin,
        buy_date,
        sell_date,
        buy_price,
        sell_price,
        matched_qty                                AS quantity,
        matched_qty * buy_price                    AS cost_basis,
        matched_qty * sell_price                   AS proceeds,
        matched_qty * (sell_price - buy_price)     AS pnl,
        CASE WHEN buy_price > 0
            THEN (sell_price - buy_price) / buy_price * 100
            ELSE 0
        END                                        AS return_pct,
        DATEDIFF('day', buy_date, sell_date)       AS holding_days
    FROM fifo_matches`,mt=`
    CREATE OR REPLACE TABLE fact_positions AS
    WITH ${E}
    SELECT
        isin,
        date       AS buy_date,
        cost_basis,
        shares     AS quantity,
        shares * cost_basis AS value_at_cost
    FROM remaining_lots
    WHERE shares > 0`,v=[ut,dt,pt,mt];function _(t,s="t.sell_date"){if(!t)return"";let e=[];return t.isin&&e.push(`t.isin = '${t.isin}'`),t.sector&&e.push(`s.sector = '${t.sector}'`),t.dateFrom&&e.push(`${s} >= '${t.dateFrom}'`),t.dateTo&&e.push(`${s} <= '${t.dateTo}'`),e.length>0?"WHERE "+e.join(" AND "):""}function H(t){return`
    SELECT
        t.isin,
        s.name,
        s.sector,
        COUNT(*)              AS num_trades,
        SUM(t.quantity)       AS total_quantity,
        SUM(t.pnl)           AS total_pnl,
        SUM(t.cost_basis)    AS total_cost,
        SUM(t.proceeds)      AS total_proceeds,
        CASE WHEN SUM(t.cost_basis) > 0
            THEN SUM(t.pnl) / SUM(t.cost_basis) * 100
            ELSE 0
        END                   AS return_pct,
        AVG(t.holding_days)   AS avg_holding_days
    FROM fact_trades t
    LEFT JOIN dim_stock s ON t.isin = s.isin
    ${_(t)}
    GROUP BY t.isin, s.name, s.sector
    ORDER BY total_pnl DESC`}function $(t,s){let e={week:"c.year_week",month:"c.year_month",quarter:"c.year_quarter",year:"c.year"}[t];return`
    SELECT
        ${e}                AS period,
        COUNT(*)              AS num_trades,
        SUM(t.pnl)           AS total_pnl,
        SUM(t.proceeds)      AS total_proceeds,
        SUM(t.cost_basis)    AS total_cost
    FROM fact_trades t
    JOIN dim_calendar c ON t.sell_date = c.date
    ${_(s)}
    GROUP BY ${e}
    ORDER BY ${e}`}function Y(t,s,e=5,n){let r={week:"c.year_week",month:"c.year_month",quarter:"c.year_quarter",year:"c.year"}[t],i=s==="best"?"DESC":"ASC";return`
    SELECT
        ${r}                AS period,
        COUNT(*)              AS num_trades,
        SUM(t.pnl)           AS total_pnl
    FROM fact_trades t
    JOIN dim_calendar c ON t.sell_date = c.date
    ${_(n)}
    GROUP BY ${r}
    ORDER BY total_pnl ${i}
    LIMIT ${e}`}function W(){return`
    SELECT
        p.isin,
        s.name,
        s.sector,
        SUM(p.quantity)       AS shares,
        SUM(p.value_at_cost)  AS value,
        SUM(p.value_at_cost) * 100.0
            / NULLIF(SUM(SUM(p.value_at_cost)) OVER (), 0) AS weight_pct
    FROM fact_positions p
    LEFT JOIN dim_stock s ON p.isin = s.isin
    GROUP BY p.isin, s.name, s.sector
    ORDER BY value DESC`}function V(t){return`
    SELECT
        COALESCE(s.sector, 'Unknown') AS sector,
        COUNT(*)              AS num_trades,
        COUNT(DISTINCT t.isin) AS num_stocks,
        SUM(t.pnl)           AS total_pnl,
        CASE WHEN SUM(t.cost_basis) > 0
            THEN SUM(t.pnl) / SUM(t.cost_basis) * 100
            ELSE 0
        END                   AS return_pct
    FROM fact_trades t
    LEFT JOIN dim_stock s ON t.isin = s.isin
    ${_(t)}
    GROUP BY COALESCE(s.sector, 'Unknown')
    ORDER BY total_pnl DESC`}function z(t){return`
    SELECT
        t.trade_id,
        t.isin,
        s.name,
        t.buy_date::VARCHAR   AS buy_date,
        t.sell_date::VARCHAR  AS sell_date,
        t.quantity,
        t.buy_price,
        t.sell_price,
        t.pnl,
        t.return_pct,
        t.holding_days
    FROM fact_trades t
    LEFT JOIN dim_stock s ON t.isin = s.isin
    ${_(t)}
    ORDER BY t.sell_date DESC, t.pnl DESC`}async function G(t,s){if(await t.exec(F),await t.exec(P),s.length===0)return;let e=1e3;for(let n=0;n<s.length;n+=e){let i=s.slice(n,n+e).map((o,l)=>`(${n+l}, '${o.date}', '${o.isin}', ${o.quantity}, ${o.price}, '${o.type}')`).join(", ");await t.exec(`INSERT INTO transactions VALUES ${i}`)}await Et(t)}async function Et(t){for(let s of v)await t.exec(s)}async function j(t,s){let e=await t.query(x(s));if(e.length===0||e[0].first_date==null)return null;let n=e[0],r=await yt(t),i=await St(t);return{totalInvested:Number(n.total_invested),totalProceeds:Number(n.total_proceeds),realizedPnL:Number(n.realized_pnl),costBasisRemaining:Number(n.cost_basis_remaining),cashBalance:Number(n.cash_balance),portfolioValue:Number(n.portfolio_value),totalReturn:Number(n.total_return),totalReturnPct:Number(n.total_return_pct),numStocks:Number(n.num_stocks),holdingDays:Number(n.holding_days),holdingYears:Number(n.holding_years),annualizedReturnPct:Number(n.annualized_return_pct),firstDate:String(n.first_date),lastDate:String(n.last_date),holdings:r,sellDetails:i}}async function yt(t){return(await t.query(U())).map(e=>({isin:String(e.isin),shares:Number(e.shares),costBasis:Number(e.cost_basis)}))}async function St(t){return(await t.query(q())).map(e=>({date:String(e.date),isin:String(e.isin),sharesSold:Number(e.shares_sold),salePrice:Number(e.sale_price),costBasis:Number(e.cost_basis),pnl:Number(e.pnl)}))}var g={isin:{type:"string",description:"Filter by ISIN (e.g. INE002A01018)"},sector:{type:"string",description:"Filter by sector"},dateFrom:{type:"string",description:"Start date (YYYY-MM-DD)"},dateTo:{type:"string",description:"End date (YYYY-MM-DD)"}},_t=[{type:"function",function:{name:"pnl_by_stock",description:"Get realized PnL breakdown by stock. Shows total PnL, return %, trade count, and avg holding days per ISIN.",parameters:{type:"object",properties:g,required:[]}}},{type:"function",function:{name:"pnl_by_period",description:"Get realized PnL aggregated by time period. Choose granularity: week, month, quarter, or year.",parameters:{type:"object",properties:{granularity:{type:"string",enum:["week","month","quarter","year"],description:"Time granularity"},...g},required:["granularity"]}}},{type:"function",function:{name:"top_periods",description:"Get the best or worst performing periods by PnL.",parameters:{type:"object",properties:{granularity:{type:"string",enum:["week","month","quarter","year"]},direction:{type:"string",enum:["best","worst"]},limit:{type:"number",description:"Number of periods to return (default 5)"},...g},required:["granularity","direction"]}}},{type:"function",function:{name:"holdings_concentration",description:"Get current portfolio holdings with concentration weights (% of total value).",parameters:{type:"object",properties:{},required:[]}}},{type:"function",function:{name:"pnl_by_sector",description:"Get realized PnL aggregated by sector.",parameters:{type:"object",properties:g,required:[]}}},{type:"function",function:{name:"trade_detail",description:"Get individual FIFO-matched trade details with buy/sell dates, prices, PnL, and holding days.",parameters:{type:"object",properties:g,required:[]}}},{type:"function",function:{name:"run_sql",description:"Run arbitrary read-only SQL against the portfolio database. Available tables: transactions (seq, date, isin, quantity, price, type), fact_trades (trade_id, isin, buy_date, sell_date, buy_price, sell_price, quantity, cost_basis, proceeds, pnl, return_pct, holding_days), fact_positions (isin, buy_date, cost_basis, quantity, value_at_cost), dim_calendar (date, year, quarter, month, week, year_month, year_week, year_quarter), dim_stock (isin, name, sector, industry).",parameters:{type:"object",properties:{sql:{type:"string",description:"SQL SELECT query to execute"}},required:["sql"]}}}];function f(t){let s={};return typeof t.isin=="string"&&(s.isin=t.isin),typeof t.sector=="string"&&(s.sector=t.sector),typeof t.dateFrom=="string"&&(s.dateFrom=t.dateFrom),typeof t.dateTo=="string"&&(s.dateTo=t.dateTo),Object.keys(s).length>0?s:void 0}async function gt(t,s,e){let n;switch(s){case"pnl_by_stock":n=H(f(e));break;case"pnl_by_period":n=$(e.granularity,f(e));break;case"top_periods":n=Y(e.granularity,e.direction,typeof e.limit=="number"?e.limit:5,f(e));break;case"holdings_concentration":n=W();break;case"pnl_by_sector":n=V(f(e));break;case"trade_detail":n=z(f(e));break;case"run_sql":{let o=String(e.sql).trim();if(!o.toUpperCase().startsWith("SELECT"))return JSON.stringify({error:"Only SELECT queries are allowed"});n=o;break}default:return JSON.stringify({error:`Unknown tool: ${s}`})}let r=await t.query(n),i=JSON.stringify(r);if(i.length>8e3){let o=r.slice(0,20);return JSON.stringify({rows:o,note:`Showing 20 of ${r.length} rows. Use filters to narrow results.`})}return i}var O="__OPENROUTER_API_KEY__",ft=["stepfun/step-3.5-flash:free","meta-llama/llama-3.3-70b-instruct:free"],ht="anthropic/claude-sonnet-4";function Q(){return O.length>0&&!O.startsWith("__OPENROUTER_")}var At=`You are an expert portfolio analyst. Analyze the user's stock trading data using the available tools.

**Process:**
1. First call pnl_by_stock and holdings_concentration to get the full picture.
2. Then drill into one or two specifics (e.g. trade_detail for notable trades, top_periods for timing patterns).
3. Only state findings you can back with data from tool results. Never speculate or infer beyond what the data shows.

**Output rules:**
- Exactly 3-5 bullet points. No preamble, no summary header, no closing remarks.
- Each bullet must cite a specific number (\u20B9 amount, %, count, or date).
- Focus on: concentration risk, realized gains/losses, cost basis efficiency, and holding period patterns.
- Skip obvious observations (e.g. "you bought stocks"). Surface what the investor might not notice themselves.
- Use \u20B9 for currency. Keep each bullet to 1-2 sentences max.`,bt=8;async function J(t,s,e){let n=s.apiKey||O,r=s.model?[s.model]:s.apiKey?[ht]:ft;if(!n||n.startsWith("__OPENROUTER_"))throw new Error("No API key configured. Please enter your OpenRouter API key.");let i=[{role:"system",content:At},{role:"user",content:"Analyze my portfolio and provide key insights."}];for(let o=0;o<bt;o++){e?.(`Thinking... (step ${o+1})`);let l=await Tt(n,r,i);if(!l.tool_calls||l.tool_calls.length===0)return l.content||"No insights generated.";i.push({role:"assistant",content:l.content,tool_calls:l.tool_calls});for(let c of l.tool_calls){e?.(`Querying: ${c.function.name}...`);let u;try{let d=JSON.parse(c.function.arguments);u=await gt(t,c.function.name,d)}catch(d){u=JSON.stringify({error:String(d)})}i.push({role:"tool",tool_call_id:c.id,content:u})}}return"Analysis incomplete \u2014 reached maximum exploration steps."}async function Tt(t,s,e){let n=null;for(let r of s)try{return await Rt(t,r,e)}catch(i){if(n=i instanceof Error?i:new Error(String(i)),!/429|404|403/.test(n.message))throw n}throw n||new Error("All models failed")}async function Rt(t,s,e){for(let r=0;r<3;r++){let i=await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${t}`,"Content-Type":"application/json"},body:JSON.stringify({model:s,messages:e,tools:_t,max_tokens:1024})});if(i.status===429&&r<2){await new Promise(c=>setTimeout(c,3e3*(r+1)));continue}if(!i.ok){let c=await i.text();throw new Error(`API error ${i.status}: ${c}`)}let l=(await i.json()).choices?.[0]?.message;if(!l)throw new Error("No response from LLM");return{content:l.content??null,tool_calls:l.tool_calls}}throw new Error("Max retries exceeded")}var R=null;async function Ct(){if(R)return R;let t=await fetch("data/isin_map.json");if(!t.ok)throw new Error("Failed to load ISIN map");return R=await t.json(),R}async function Lt(t,s){await t.exec("DROP TABLE IF EXISTS stock_prices"),await t.exec("CREATE TABLE stock_prices (date DATE, symbol VARCHAR, isin VARCHAR, close DOUBLE)");let e=await t.query("SELECT DISTINCT isin FROM transactions");for(let n of e){let r=String(n.isin),i=s[r];if(!i)continue;let o=`${i}.parquet`;try{await b(`stock_prices/${o}`,`data/stock_prices/${o}`),await t.exec(`
                INSERT INTO stock_prices
                SELECT date, symbol, '${r}' as isin, close
                FROM parquet_scan('stock_prices/${o}')
                WHERE close IS NOT NULL
            `)}catch{}}}var wt=t=>`
WITH
-- All unique trading dates from stock prices, plus transaction dates
all_dates AS (
    SELECT DISTINCT date FROM stock_prices
    UNION
    SELECT DISTINCT date FROM transactions
),
date_range AS (
    SELECT MIN(date) AS min_d, MAX(date) AS max_d FROM transactions
),
calendar AS (
    SELECT ad.date
    FROM all_dates ad, date_range dr
    WHERE ad.date >= dr.min_d AND ad.date <= dr.max_d
    ORDER BY ad.date
),
-- Net shares and cash flow per transaction date per ISIN
flows AS (
    SELECT
        date, isin,
        SUM(CASE WHEN type = 'BUY' THEN quantity ELSE -quantity END) AS net_shares,
        SUM(CASE WHEN type = 'BUY' THEN -quantity * price ELSE quantity * price END) AS net_cash
    FROM transactions
    GROUP BY date, isin
),
-- Cumulative shares per ISIN as of each calendar date
isin_list AS (SELECT DISTINCT isin FROM transactions),
holdings AS (
    SELECT
        c.date,
        il.isin,
        COALESCE((
            SELECT SUM(f.net_shares) FROM flows f
            WHERE f.isin = il.isin AND f.date <= c.date
        ), 0) AS shares
    FROM calendar c
    CROSS JOIN isin_list il
),
-- Cumulative cash
cash AS (
    SELECT
        c.date,
        ${t} + COALESCE((
            SELECT SUM(f2.net_cash) FROM (
                SELECT date, SUM(net_cash) AS net_cash FROM flows GROUP BY date
            ) f2
            WHERE f2.date <= c.date
        ), 0) AS cash
    FROM calendar c
),
-- Market value of holdings
market_val AS (
    SELECT
        h.date,
        SUM(
            CASE WHEN h.shares > 0
                THEN h.shares * COALESCE(sp.close, 0)
                ELSE 0
            END
        ) AS market_value
    FROM holdings h
    LEFT JOIN stock_prices sp ON h.isin = sp.isin AND h.date = sp.date
    GROUP BY h.date
)
SELECT
    ca.date,
    ca.cash,
    COALESCE(mv.market_value, 0) AS market_value,
    ca.cash + COALESCE(mv.market_value, 0) AS portfolio_value,
    CASE WHEN ${t} > 0
        THEN ((ca.cash + COALESCE(mv.market_value, 0)) - ${t}) * 100.0 / ${t}
        ELSE 0
    END AS return_pct
FROM cash ca
LEFT JOIN market_val mv ON ca.date = mv.date
ORDER BY ca.date
`;async function X(t,s){let e=await Ct();return await Lt(t,e),(await t.query(wt(s))).map(r=>{let i=r.date,o;return typeof i=="number"?o=i:i instanceof Date?o=i.getTime():o=new Date(String(i)).getTime(),{date:o,value:Number(r.portfolio_value)||0,cash:Number(r.cash)||0,returnPct:Number(r.return_pct)||0}})}var K={dataPath:"data",benchmarks:{nifty50:"nifty50.parquet",bank_nifty:"bank_nifty.parquet",sensex:"sensex.parquet",nifty_midcap:"nifty_midcap.parquet",bse_500:"bse_500.parquet"}},N=null,L=null,Z=1e5,a={csvInput:document.getElementById("csvInput"),benchmarkSelect:document.getElementById("benchmarkSelect"),loadingSection:document.getElementById("loadingSection"),loadingText:document.getElementById("loadingText"),errorSection:document.getElementById("errorSection"),errorMessage:document.getElementById("errorMessage"),retryBtn:document.getElementById("retryBtn"),uploadSection:document.getElementById("uploadSection"),changeFileBtn:document.getElementById("changeFile"),insightsSection:document.getElementById("insightsSection"),insightsSummary:document.getElementById("insightsSummary"),insightsFull:document.getElementById("insightsFull"),insightsToggle:document.getElementById("insightsToggle"),apiKey:document.getElementById("apiKey"),generateInsightsBtn:document.getElementById("generateInsights"),insightsStatus:document.getElementById("insightsStatus")};async function I(){h("Initializing DuckDB...");try{await k(),m()}catch(t){m(),C("Failed to initialize DuckDB: "+(t instanceof Error?t.message:String(t)))}}function Dt(){a.csvInput.addEventListener("change",et),a.retryBtn.addEventListener("click",()=>{a.errorSection.style.display="none",I()}),a.benchmarkSelect.addEventListener("change",async()=>{L&&await nt()}),a.apiKey.addEventListener("input",()=>{a.generateInsightsBtn.disabled=!a.apiKey.value.trim()}),a.generateInsightsBtn.addEventListener("click",Mt),a.insightsToggle.addEventListener("click",()=>{let t=a.insightsFull.style.display!=="none";a.insightsFull.style.display=t?"none":"block",a.insightsToggle.textContent=t?"Show more":"Show less"}),a.changeFileBtn.addEventListener("click",()=>{a.insightsSection.style.display="none",a.uploadSection.style.display="block",a.csvInput.value=""})}async function et(t){let e=t.target.files?.[0];if(e){h("Parsing transactions...");try{let n=await e.text(),r=D(n);if(r.length===0)throw new Error("No valid transactions found in CSV");if(r.sort((i,o)=>new Date(i.date).getTime()-new Date(o.date).getTime()),!B())throw new Error("Database not initialized. Please refresh the page and try again.");if(L=r,await G(T(),r),await nt(),m(),Q())st();else{let i=document.querySelector(".insights-upgrade");i&&(i.open=!0)}}catch(n){m(),C("Error processing CSV: "+(n instanceof Error?n.message:String(n)))}}}async function nt(){if(L){h("Analyzing portfolio...");try{let t=T(),s=await j(t,Z);if(!s){C("No portfolio data available for analysis"),m();return}h("Loading stock prices...");let e=await X(t,Z);h("Loading benchmark...");let n=await Ot(a.benchmarkSelect.value,e.length>0?e[0].date:0,e.length>0?e[e.length-1].date:0);Nt(s,e,n),a.uploadSection.style.display="none",a.insightsSection.style.display="block",m()}catch(t){m(),C("Analysis error: "+(t instanceof Error?t.message:String(t)))}}}async function Ot(t,s,e){if(!s||!e)return[];let n=K.benchmarks[t];try{await b(n,`${K.dataPath}/${n}`);let r=new Date(s).toISOString().slice(0,10),i=new Date(e).toISOString().slice(0,10);return(await w(`
            WITH base AS (
                SELECT date, close
                FROM parquet_scan('${n}')
                WHERE date IS NOT NULL AND close IS NOT NULL
                  AND date >= '${r}' AND date <= '${i}'
                ORDER BY date
            ),
            first_close AS (
                SELECT close AS c0 FROM base LIMIT 1
            )
            SELECT b.date, ((b.close - fc.c0) / fc.c0) * 100 AS return_pct
            FROM base b, first_close fc
            ORDER BY b.date
        `)).map(l=>{let c=l.date,u;return typeof c=="number"?u=c:c instanceof Date?u=c.getTime():u=new Date(String(c)).getTime(),{x:u,y:Number(l.return_pct)||0}})}catch(r){return console.warn(`Could not load benchmark data for ${t}:`,r.message),[]}}function Nt(t,s,e){let n=l=>document.getElementById(l),r=n("totalReturn");r.textContent=`${t.totalReturn>=0?"+":""}${t.totalReturnPct.toFixed(2)}%`,r.className="stat-value "+(t.totalReturn>=0?"positive":"negative");let i=n("annualizedReturn");i.textContent=`${t.annualizedReturnPct>=0?"+":""}${t.annualizedReturnPct.toFixed(2)}%`,i.className="stat-value "+(t.annualizedReturnPct>=0?"positive":"negative"),n("portfolioValue").textContent=`\u20B9${t.portfolioValue.toLocaleString("en-IN")}`,n("holdingPeriod").textContent=`${t.holdingDays} days (${t.holdingYears.toFixed(1)} years)`;let o=n("pnlGrid");if(t.realizedPnL!==0){o.style.display="grid";let l=n("totalRealizedPnL");l.textContent=`${t.realizedPnL>=0?"+":""}\u20B9${t.realizedPnL.toLocaleString("en-IN")}`,l.className="stat-value "+(t.realizedPnL>=0?"positive":"negative"),n("totalUnrealizedGain").textContent="-",n("fifoCostBasis").textContent=`\u20B9${t.costBasisRemaining.toLocaleString("en-IN")}`,n("stocksCount").textContent=`${t.numStocks}`}else o.style.display="none";It(s,e)}function It(t,s){let e=document.getElementById("returnsChart").getContext("2d"),n=t.map(r=>({x:r.date,y:r.returnPct}));N&&N.destroy(),N=new Chart(e,{type:"line",data:{datasets:[{label:"Portfolio",data:n,borderColor:"#5367ff",backgroundColor:"rgba(83, 103, 255, 0.08)",borderWidth:2,pointRadius:0,fill:!0,tension:.1},{label:a.benchmarkSelect.options[a.benchmarkSelect.selectedIndex].text,data:s,borderColor:"#00d09c",borderWidth:2,pointRadius:0,fill:!1,tension:.1}]},options:{responsive:!0,maintainAspectRatio:!1,interaction:{mode:"nearest",intersect:!1,axis:"x"},plugins:{legend:{position:"top",labels:{color:"#44475b",font:{size:12}}},tooltip:{backgroundColor:"#fff",titleColor:"#44475b",bodyColor:"#7c7e8c",borderColor:"#e8e8eb",borderWidth:1,callbacks:{label:r=>r.dataset.label+": "+r.parsed.y.toFixed(2)+"%"}}},scales:{x:{type:"time",time:{unit:"month",displayFormats:{month:"MMM yyyy"}},grid:{color:"#f0f0f3"},ticks:{color:"#9b9dab",maxTicksLimit:10}},y:{grid:{color:"#f0f0f3"},ticks:{color:"#9b9dab",callback:r=>r+"%"},border:{color:"#e8e8eb"}}}}})}async function st(t){if(!L)return;a.generateInsightsBtn.disabled=!0,a.insightsStatus.style.display="block",a.insightsSummary.textContent="",a.insightsSummary.className="insights-summary",a.insightsFull.style.display="none",a.insightsToggle.style.display="none";let s=!!t;try{let e=await J(T(),t?{apiKey:t}:{},o=>{a.insightsStatus.textContent=o});a.insightsStatus.style.display="none";let n=e.split(`
`).filter(o=>o.trim().startsWith("-")),r=n.slice(0,2).join(`
`),i=n.slice(2).join(`
`);a.insightsSummary.innerHTML=tt(r),i.trim()&&(a.insightsFull.innerHTML=tt(i)+(s?"":'<p class="insights-tier-note">Free model. Use your own API key for deeper analysis.</p>'),a.insightsToggle.style.display="inline-block",a.insightsToggle.textContent="Show more")}catch(e){a.insightsStatus.style.display="none",a.insightsSummary.textContent="Error: "+(e instanceof Error?e.message:String(e)),a.insightsSummary.className="insights-summary error"}finally{a.generateInsightsBtn.disabled=!a.apiKey.value.trim()}}async function Mt(){let t=a.apiKey.value.trim();t&&await st(t)}function tt(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/\*(.+?)\*/g,"<em>$1</em>").replace(/`(.+?)`/g,"<code>$1</code>").replace(/^- (.+)$/gm,"<li>$1</li>").replace(/((?:<li>.*<\/li>\n?)+)/g,"<ul>$1</ul>").replace(/\n{2,}/g,"<br><br>").replace(/\n/g,"<br>")}function h(t){a.loadingText.textContent=t,a.loadingSection.style.display="flex"}function m(){a.loadingSection.style.display="none"}function C(t){a.loadingSection.style.display="none",a.errorMessage.textContent=t,a.errorSection.style.display="block",a.errorSection.style.visibility="visible",a.errorSection.style.opacity="1"}document.addEventListener("DOMContentLoaded",()=>{Dt(),I()});window.PortfolioAnalysis={init:I,parseCSV:D,handleFileUpload:et};
