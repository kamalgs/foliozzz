var nt="https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm",b=null,_=null,p=null;async function rt(){return b||(b=await import(nt),b)}async function N(){if(p)return;let t=await rt(),r=t.getJsDelivrBundles(),e=await t.selectBundle(r),n=URL.createObjectURL(new Blob([`importScripts("${e.mainWorker}");`],{type:"text/javascript"})),s=new Worker(n),i=new t.ConsoleLogger;_=new t.AsyncDuckDB(i,s),await _.instantiate(e.mainModule,e.pthreadWorker),p=await _.connect()}function k(){return p!==null}async function it(t){if(!p)throw new Error("DuckDB not initialized. Call initDuckDB() first.");await p.query(t)}async function T(t){if(!p)throw new Error("DuckDB not initialized. Call initDuckDB() first.");let r=await p.query(t);return st(r)}async function M(t,r){if(!_)throw new Error("DuckDB not initialized. Call initDuckDB() first.");let e=await fetch(r);if(!e.ok)throw new Error(`Failed to fetch ${r}: ${e.status}`);let n=await e.arrayBuffer();await _.registerFileBuffer(t,new Uint8Array(n))}function h(){return{exec:it,query:T}}function st(t){let r=[],e=t.schema.fields,n=t.numRows;for(let s=0;s<n;s++){let i={};for(let l of e){let a=t.getChild(l.name);i[l.name]=ot(a.get(s))}r.push(i)}return r}function ot(t){if(t==null)return t;if(typeof t=="bigint")return Number(t);if(typeof t=="object"&&t!==null&&!(t instanceof Date)){let r=t;if(typeof r.toString=="function"){let e=r.toString();if(e!==""&&e!=="[object Object]"&&!isNaN(Number(e)))return Number(e)}}return typeof t=="string"&&t!==""&&!isNaN(Number(t))?Number(t):t}function C(t){let r=t.trim().split(`
`),e=[],n=r[0].toLowerCase(),i=n.includes("date")||n.includes("isin")?1:0;for(let l=i;l<r.length;l++){let a=r[l].split(",").map(c=>c.trim());if(a.length>=5){let[c,u,d,E,B]=a;c&&u&&d&&E&&B&&e.push({date:c,isin:u.toUpperCase(),quantity:parseFloat(d),price:parseFloat(E),type:B.toUpperCase()})}else if(a.length>=4){let[c,u,d,E]=a;c&&u&&d&&E&&e.push({date:c,isin:u.toUpperCase(),quantity:parseFloat(d),price:parseFloat(E),type:"BUY"})}}return e}var m=`
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
    )`,I="DROP TABLE IF EXISTS transactions",P=`
    CREATE TABLE transactions (
        seq INTEGER,
        date DATE,
        isin VARCHAR,
        quantity DOUBLE,
        price DOUBLE,
        type VARCHAR
    )`;function F(t){return`
WITH ${m},

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
FROM raw`}function x(t){return`
WITH ${m},

-- Cost basis consumed by sells (FIFO), grouped by sell date
sell_cost_basis AS (
    SELECT sell_date AS date, SUM(matched_qty * buy_price) AS cost_sold
    FROM fifo_matches
    GROUP BY sell_date
),

-- Daily cash flows + cost consumed
date_flows AS (
    SELECT
        t.date,
        SUM(CASE WHEN t.type = 'BUY'  THEN t.quantity * t.price ELSE 0 END) AS buy_cost,
        SUM(CASE WHEN t.type = 'SELL' THEN t.quantity * t.price ELSE 0 END) AS sell_proceeds,
        COALESCE(MAX(scb.cost_sold), 0) AS cost_sold
    FROM transactions t
    LEFT JOIN sell_cost_basis scb ON t.date = scb.date
    GROUP BY t.date
)

SELECT
    date::VARCHAR AS date,
    ${t} + SUM(sell_proceeds - buy_cost) OVER w AS cash,
    SUM(buy_cost - cost_sold) OVER w AS holdings_cost,
    ${t} + SUM(sell_proceeds - buy_cost) OVER w
           + SUM(buy_cost - cost_sold) OVER w AS portfolio_value,
    CASE WHEN ${t} > 0
        THEN (SUM(sell_proceeds - buy_cost) OVER w
            + SUM(buy_cost - cost_sold) OVER w) * 100.0 / ${t}
        ELSE 0
    END AS return_pct
FROM date_flows
WINDOW w AS (ORDER BY date ROWS UNBOUNDED PRECEDING)
ORDER BY date`}function U(){return`
WITH ${m}
SELECT isin, cost_basis AS cost_basis, shares
FROM remaining_lots
WHERE shares > 0
ORDER BY isin, cost_basis`}function q(){return`
WITH ${m}
SELECT
    sell_date::VARCHAR AS date,
    isin,
    matched_qty AS shares_sold,
    sell_price  AS sale_price,
    buy_price   AS cost_basis,
    matched_qty * (sell_price - buy_price) AS pnl
FROM fifo_matches
ORDER BY sell_date, isin, buy_price`}var lt=`
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
    FROM dates`,ct=`
    CREATE OR REPLACE TABLE dim_stock AS
    SELECT DISTINCT
        isin,
        NULL::VARCHAR AS name,
        NULL::VARCHAR AS sector,
        NULL::VARCHAR AS industry
    FROM transactions`,ut=`
    CREATE OR REPLACE TABLE fact_trades AS
    WITH ${m}
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
    FROM fifo_matches`,dt=`
    CREATE OR REPLACE TABLE fact_positions AS
    WITH ${m}
    SELECT
        isin,
        date       AS buy_date,
        cost_basis,
        shares     AS quantity,
        shares * cost_basis AS value_at_cost
    FROM remaining_lots
    WHERE shares > 0`,v=[lt,ct,ut,dt];function S(t,r="t.sell_date"){if(!t)return"";let e=[];return t.isin&&e.push(`t.isin = '${t.isin}'`),t.sector&&e.push(`s.sector = '${t.sector}'`),t.dateFrom&&e.push(`${r} >= '${t.dateFrom}'`),t.dateTo&&e.push(`${r} <= '${t.dateTo}'`),e.length>0?"WHERE "+e.join(" AND "):""}function H(t){return`
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
    ${S(t)}
    GROUP BY t.isin, s.name, s.sector
    ORDER BY total_pnl DESC`}function $(t,r){let e={week:"c.year_week",month:"c.year_month",quarter:"c.year_quarter",year:"c.year"}[t];return`
    SELECT
        ${e}                AS period,
        COUNT(*)              AS num_trades,
        SUM(t.pnl)           AS total_pnl,
        SUM(t.proceeds)      AS total_proceeds,
        SUM(t.cost_basis)    AS total_cost
    FROM fact_trades t
    JOIN dim_calendar c ON t.sell_date = c.date
    ${S(r)}
    GROUP BY ${e}
    ORDER BY ${e}`}function Y(t,r,e=5,n){let s={week:"c.year_week",month:"c.year_month",quarter:"c.year_quarter",year:"c.year"}[t],i=r==="best"?"DESC":"ASC";return`
    SELECT
        ${s}                AS period,
        COUNT(*)              AS num_trades,
        SUM(t.pnl)           AS total_pnl
    FROM fact_trades t
    JOIN dim_calendar c ON t.sell_date = c.date
    ${S(n)}
    GROUP BY ${s}
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
    ORDER BY value DESC`}function z(t){return`
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
    ${S(t)}
    GROUP BY COALESCE(s.sector, 'Unknown')
    ORDER BY total_pnl DESC`}function V(t){return`
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
    ${S(t)}
    ORDER BY t.sell_date DESC, t.pnl DESC`}async function G(t,r){if(await t.exec(I),await t.exec(P),r.length===0)return;let e=1e3;for(let n=0;n<r.length;n+=e){let i=r.slice(n,n+e).map((l,a)=>`(${n+a}, '${l.date}', '${l.isin}', ${l.quantity}, ${l.price}, '${l.type}')`).join(", ");await t.exec(`INSERT INTO transactions VALUES ${i}`)}await pt(t)}async function pt(t){for(let r of v)await t.exec(r)}async function Q(t,r){let e=await t.query(F(r));if(e.length===0||e[0].first_date==null)return null;let n=e[0],s=await mt(t),i=await yt(t);return{totalInvested:Number(n.total_invested),totalProceeds:Number(n.total_proceeds),realizedPnL:Number(n.realized_pnl),costBasisRemaining:Number(n.cost_basis_remaining),cashBalance:Number(n.cash_balance),portfolioValue:Number(n.portfolio_value),totalReturn:Number(n.total_return),totalReturnPct:Number(n.total_return_pct),numStocks:Number(n.num_stocks),holdingDays:Number(n.holding_days),holdingYears:Number(n.holding_years),annualizedReturnPct:Number(n.annualized_return_pct),firstDate:String(n.first_date),lastDate:String(n.last_date),holdings:s,sellDetails:i}}async function j(t,r){return(await t.query(x(r))).map(n=>({date:String(n.date),cash:Number(n.cash),holdingsCost:Number(n.holdings_cost),portfolioValue:Number(n.portfolio_value),returnPct:Number(n.return_pct)}))}async function mt(t){return(await t.query(U())).map(e=>({isin:String(e.isin),shares:Number(e.shares),costBasis:Number(e.cost_basis)}))}async function yt(t){return(await t.query(q())).map(e=>({date:String(e.date),isin:String(e.isin),sharesSold:Number(e.shares_sold),salePrice:Number(e.sale_price),costBasis:Number(e.cost_basis),pnl:Number(e.pnl)}))}var g={isin:{type:"string",description:"Filter by ISIN (e.g. INE002A01018)"},sector:{type:"string",description:"Filter by sector"},dateFrom:{type:"string",description:"Start date (YYYY-MM-DD)"},dateTo:{type:"string",description:"End date (YYYY-MM-DD)"}},Et=[{type:"function",function:{name:"pnl_by_stock",description:"Get realized PnL breakdown by stock. Shows total PnL, return %, trade count, and avg holding days per ISIN.",parameters:{type:"object",properties:g,required:[]}}},{type:"function",function:{name:"pnl_by_period",description:"Get realized PnL aggregated by time period. Choose granularity: week, month, quarter, or year.",parameters:{type:"object",properties:{granularity:{type:"string",enum:["week","month","quarter","year"],description:"Time granularity"},...g},required:["granularity"]}}},{type:"function",function:{name:"top_periods",description:"Get the best or worst performing periods by PnL.",parameters:{type:"object",properties:{granularity:{type:"string",enum:["week","month","quarter","year"]},direction:{type:"string",enum:["best","worst"]},limit:{type:"number",description:"Number of periods to return (default 5)"},...g},required:["granularity","direction"]}}},{type:"function",function:{name:"holdings_concentration",description:"Get current portfolio holdings with concentration weights (% of total value).",parameters:{type:"object",properties:{},required:[]}}},{type:"function",function:{name:"pnl_by_sector",description:"Get realized PnL aggregated by sector.",parameters:{type:"object",properties:g,required:[]}}},{type:"function",function:{name:"trade_detail",description:"Get individual FIFO-matched trade details with buy/sell dates, prices, PnL, and holding days.",parameters:{type:"object",properties:g,required:[]}}},{type:"function",function:{name:"run_sql",description:"Run arbitrary read-only SQL against the portfolio database. Available tables: transactions (seq, date, isin, quantity, price, type), fact_trades (trade_id, isin, buy_date, sell_date, buy_price, sell_price, quantity, cost_basis, proceeds, pnl, return_pct, holding_days), fact_positions (isin, buy_date, cost_basis, quantity, value_at_cost), dim_calendar (date, year, quarter, month, week, year_month, year_week, year_quarter), dim_stock (isin, name, sector, industry).",parameters:{type:"object",properties:{sql:{type:"string",description:"SQL SELECT query to execute"}},required:["sql"]}}}];function f(t){let r={};return typeof t.isin=="string"&&(r.isin=t.isin),typeof t.sector=="string"&&(r.sector=t.sector),typeof t.dateFrom=="string"&&(r.dateFrom=t.dateFrom),typeof t.dateTo=="string"&&(r.dateTo=t.dateTo),Object.keys(r).length>0?r:void 0}async function _t(t,r,e){let n;switch(r){case"pnl_by_stock":n=H(f(e));break;case"pnl_by_period":n=$(e.granularity,f(e));break;case"top_periods":n=Y(e.granularity,e.direction,typeof e.limit=="number"?e.limit:5,f(e));break;case"holdings_concentration":n=W();break;case"pnl_by_sector":n=z(f(e));break;case"trade_detail":n=V(f(e));break;case"run_sql":{let l=String(e.sql).trim();if(!l.toUpperCase().startsWith("SELECT"))return JSON.stringify({error:"Only SELECT queries are allowed"});n=l;break}default:return JSON.stringify({error:`Unknown tool: ${r}`})}let s=await t.query(n),i=JSON.stringify(s);if(i.length>8e3){let l=s.slice(0,20);return JSON.stringify({rows:l,note:`Showing 20 of ${s.length} rows. Use filters to narrow results.`})}return i}var w="__OPENROUTER_API_KEY__",St=["stepfun/step-3.5-flash:free","meta-llama/llama-3.3-70b-instruct:free"],gt="anthropic/claude-sonnet-4";function J(){return w.length>0&&!w.startsWith("__OPENROUTER_")}var ft=`You are an expert portfolio analyst. Analyze the user's stock trading data using the available tools.

**Process:**
1. First call pnl_by_stock and holdings_concentration to get the full picture.
2. Then drill into one or two specifics (e.g. trade_detail for notable trades, top_periods for timing patterns).
3. Only state findings you can back with data from tool results. Never speculate or infer beyond what the data shows.

**Output rules:**
- Exactly 3-5 bullet points. No preamble, no summary header, no closing remarks.
- Each bullet must cite a specific number (\u20B9 amount, %, count, or date).
- Focus on: concentration risk, realized gains/losses, cost basis efficiency, and holding period patterns.
- Skip obvious observations (e.g. "you bought stocks"). Surface what the investor might not notice themselves.
- Use \u20B9 for currency. Keep each bullet to 1-2 sentences max.`,bt=8;async function K(t,r,e){let n=r.apiKey||w,s=r.model?[r.model]:r.apiKey?[gt]:St;if(!n||n.startsWith("__OPENROUTER_"))throw new Error("No API key configured. Please enter your OpenRouter API key.");let i=[{role:"system",content:ft},{role:"user",content:"Analyze my portfolio and provide key insights."}];for(let l=0;l<bt;l++){e?.(`Thinking... (step ${l+1})`);let a=await ht(n,s,i);if(!a.tool_calls||a.tool_calls.length===0)return a.content||"No insights generated.";i.push({role:"assistant",content:a.content,tool_calls:a.tool_calls});for(let c of a.tool_calls){e?.(`Querying: ${c.function.name}...`);let u;try{let d=JSON.parse(c.function.arguments);u=await _t(t,c.function.name,d)}catch(d){u=JSON.stringify({error:String(d)})}i.push({role:"tool",tool_call_id:c.id,content:u})}}return"Analysis incomplete \u2014 reached maximum exploration steps."}async function ht(t,r,e){let n=null;for(let s of r)try{return await Rt(t,s,e)}catch(i){if(n=i instanceof Error?i:new Error(String(i)),!/429|404|403/.test(n.message))throw n}throw n||new Error("All models failed")}async function Rt(t,r,e){for(let s=0;s<3;s++){let i=await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${t}`,"Content-Type":"application/json"},body:JSON.stringify({model:r,messages:e,tools:Et,max_tokens:1024})});if(i.status===429&&s<2){await new Promise(c=>setTimeout(c,3e3*(s+1)));continue}if(!i.ok){let c=await i.text();throw new Error(`API error ${i.status}: ${c}`)}let a=(await i.json()).choices?.[0]?.message;if(!a)throw new Error("No response from LLM");return{content:a.content??null,tool_calls:a.tool_calls}}throw new Error("Max retries exceeded")}var X={dataPath:"data",benchmarks:{nifty50:"nifty50.parquet",bank_nifty:"bank_nifty.parquet",sensex:"sensex.parquet",nifty_midcap:"nifty_midcap.parquet",bse_500:"bse_500.parquet"}},L=null,A=null,o={csvInput:document.getElementById("csvInput"),benchmarkSelect:document.getElementById("benchmarkSelect"),initialCapital:document.getElementById("initialCapital"),loadingSection:document.getElementById("loadingSection"),loadingText:document.getElementById("loadingText"),errorSection:document.getElementById("errorSection"),errorMessage:document.getElementById("errorMessage"),retryBtn:document.getElementById("retryBtn"),uploadSection:document.getElementById("uploadSection"),changeFileBtn:document.getElementById("changeFile"),insightsSection:document.getElementById("insightsSection"),apiKey:document.getElementById("apiKey"),generateInsightsBtn:document.getElementById("generateInsights"),insightsStatus:document.getElementById("insightsStatus"),insightsOutput:document.getElementById("insightsOutput")};async function D(){O("Initializing DuckDB...");try{await N(),y()}catch(t){y(),R("Failed to initialize DuckDB: "+(t instanceof Error?t.message:String(t)))}}function At(){o.csvInput.addEventListener("change",Z),o.retryBtn.addEventListener("click",()=>{o.errorSection.style.display="none",D()}),o.benchmarkSelect.addEventListener("change",async()=>{A&&await tt()}),o.apiKey.addEventListener("input",()=>{o.generateInsightsBtn.disabled=!o.apiKey.value.trim()}),o.generateInsightsBtn.addEventListener("click",Lt),o.changeFileBtn.addEventListener("click",()=>{o.insightsSection.style.display="none",o.uploadSection.style.display="block",o.csvInput.value=""})}async function Z(t){let e=t.target.files?.[0];if(e){O("Parsing transactions...");try{let n=await e.text(),s=C(n);if(s.length===0)throw new Error("No valid transactions found in CSV");if(s.sort((i,l)=>new Date(i.date).getTime()-new Date(l.date).getTime()),!k())throw new Error("Database not initialized. Please refresh the page and try again.");if(A=s,await G(h(),s),await tt(),y(),J())et();else{let i=document.querySelector(".insights-upgrade");i&&(i.open=!0)}}catch(n){y(),R("Error processing CSV: "+(n instanceof Error?n.message:String(n)))}}}async function tt(){if(A){O("Analyzing portfolio...");try{let t=parseFloat(o.initialCapital.value)||1e5,r=h(),e=await Q(r,t);if(!e){R("No portfolio data available for analysis"),y();return}let n=await j(r,t),s=await Tt(o.benchmarkSelect.value);Ct(e,n,s),o.uploadSection.style.display="none",o.insightsSection.style.display="block",y()}catch(t){y(),R("Analysis error: "+(t instanceof Error?t.message:String(t)))}}}async function Tt(t){let r=X.benchmarks[t];try{return await M(r,`${X.dataPath}/${r}`),(await T(`
            WITH daily AS (
                SELECT date, close,
                    (close - LAG(close) OVER (ORDER BY date)) /
                        NULLIF(LAG(close) OVER (ORDER BY date), 0) * 100 as daily_return_pct
                FROM parquet_scan('${r}')
                WHERE date IS NOT NULL AND close IS NOT NULL
            )
            SELECT date, close, daily_return_pct,
                SUM(daily_return_pct) OVER (ORDER BY date) as cumulative_return_pct
            FROM daily
            ORDER BY date
        `)).map(n=>{let s=n.date,i;return typeof s=="number"?i=new Date(s).toISOString().slice(0,10):s instanceof Date?i=s.toISOString().slice(0,10):i=String(s).slice(0,10),{date:i,closePrice:Number(n.close)||0,cumulativeReturnPct:Number(n.cumulative_return_pct)||0}})}catch(e){return console.warn(`Could not load benchmark data for ${t}:`,e.message),[]}}function Ct(t,r,e){let n=a=>document.getElementById(a),s=n("totalReturn");s.textContent=`${t.totalReturn>=0?"+":""}${t.totalReturnPct.toFixed(2)}%`,s.className="stat-value "+(t.totalReturn>=0?"positive":"negative");let i=n("annualizedReturn");i.textContent=`${t.annualizedReturnPct>=0?"+":""}${t.annualizedReturnPct.toFixed(2)}%`,i.className="stat-value "+(t.annualizedReturnPct>=0?"positive":"negative"),n("portfolioValue").textContent=`\u20B9${t.portfolioValue.toLocaleString("en-IN")}`,n("holdingPeriod").textContent=`${t.holdingDays} days (${t.holdingYears.toFixed(1)} years)`;let l=n("pnlGrid");if(t.realizedPnL!==0){l.style.display="grid";let a=n("totalRealizedPnL");a.textContent=`${t.realizedPnL>=0?"+":""}\u20B9${t.realizedPnL.toLocaleString("en-IN")}`,a.className="stat-value "+(t.realizedPnL>=0?"positive":"negative"),n("totalUnrealizedGain").textContent="-",n("fifoCostBasis").textContent=`\u20B9${t.costBasisRemaining.toLocaleString("en-IN")}`,n("stocksCount").textContent=`${t.numStocks}`}else l.style.display="none";wt(r,e)}function wt(t,r){let e=document.getElementById("returnsChart").getContext("2d"),n=t.map(i=>({x:new Date(String(i.date)).getTime(),y:i.returnPct})),s=[];if(r.length>0&&n.length>0){let i=n[0].x,l=n[n.length-1].x;s=r.map(a=>({x:new Date(String(a.date)).getTime(),y:a.cumulativeReturnPct})).filter(a=>a.x>=i&&a.x<=l)}L&&L.destroy(),L=new Chart(e,{type:"line",data:{datasets:[{label:"Portfolio",data:n,borderColor:"#5367ff",backgroundColor:"rgba(83, 103, 255, 0.08)",borderWidth:2,pointRadius:0,fill:!0,tension:.1,stepped:"before"},{label:"Benchmark ("+o.benchmarkSelect.options[o.benchmarkSelect.selectedIndex].text+")",data:s,borderColor:"#00d09c",borderWidth:2,pointRadius:0,fill:!1,tension:.1}]},options:{responsive:!0,maintainAspectRatio:!1,interaction:{mode:"nearest",intersect:!1,axis:"x"},plugins:{legend:{position:"top",labels:{color:"#44475b",font:{size:12}}},tooltip:{backgroundColor:"#fff",titleColor:"#44475b",bodyColor:"#7c7e8c",borderColor:"#e8e8eb",borderWidth:1,callbacks:{label:i=>i.dataset.label+": "+i.parsed.y.toFixed(2)+"%"}},title:{display:!0,text:"Cumulative Returns Comparison",color:"#44475b",font:{size:14}}},scales:{x:{type:"time",time:{unit:"month",displayFormats:{month:"MMM yyyy"}},grid:{color:"#f0f0f3"},ticks:{color:"#9b9dab",maxTicksLimit:10}},y:{grid:{color:"#f0f0f3"},ticks:{color:"#9b9dab",callback:i=>i+"%"},border:{color:"#e8e8eb"}}}}})}async function et(t){if(!A)return;o.generateInsightsBtn.disabled=!0,o.insightsStatus.style.display="block",o.insightsOutput.textContent="",o.insightsOutput.className="insights-output";let r=!!t;try{let e=await K(h(),t?{apiKey:t}:{},n=>{o.insightsStatus.textContent=n});o.insightsStatus.style.display="none",o.insightsOutput.innerHTML=Dt(e)+(r?"":'<p class="insights-tier-note">Generated with free model. Enter your OpenRouter API key below for deeper analysis.</p>')}catch(e){o.insightsStatus.style.display="none",o.insightsOutput.textContent="Error: "+(e instanceof Error?e.message:String(e)),o.insightsOutput.className="insights-output error"}finally{o.generateInsightsBtn.disabled=!o.apiKey.value.trim()}}async function Lt(){let t=o.apiKey.value.trim();t&&await et(t)}function Dt(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/\*(.+?)\*/g,"<em>$1</em>").replace(/`(.+?)`/g,"<code>$1</code>").replace(/^- (.+)$/gm,"<li>$1</li>").replace(/((?:<li>.*<\/li>\n?)+)/g,"<ul>$1</ul>").replace(/\n{2,}/g,"<br><br>").replace(/\n/g,"<br>")}function O(t){o.loadingText.textContent=t,o.loadingSection.style.display="flex"}function y(){o.loadingSection.style.display="none"}function R(t){o.loadingSection.style.display="none",o.errorMessage.textContent=t,o.errorSection.style.display="block",o.errorSection.style.visibility="visible",o.errorSection.style.opacity="1"}document.addEventListener("DOMContentLoaded",()=>{At(),D()});window.PortfolioAnalysis={init:D,parseCSV:C,handleFileUpload:Z};
