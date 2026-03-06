var K="https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm",f=null,h=null,u=null;async function Z(){return f||(f=await import(K),f)}async function B(){if(u)return;let t=await Z(),r=t.getJsDelivrBundles(),e=await t.selectBundle(r),n=URL.createObjectURL(new Blob([`importScripts("${e.mainWorker}");`],{type:"text/javascript"})),s=new Worker(n),o=new t.ConsoleLogger;h=new t.AsyncDuckDB(o,s),await h.instantiate(e.mainModule,e.pthreadWorker),u=await h.connect()}function N(){return u!==null}async function tt(t){if(!u)throw new Error("DuckDB not initialized. Call initDuckDB() first.");await u.query(t)}async function T(t){if(!u)throw new Error("DuckDB not initialized. Call initDuckDB() first.");let r=await u.query(t);return et(r)}function b(){return{exec:tt,query:T}}function et(t){let r=[],e=t.schema.fields,n=t.numRows;for(let s=0;s<n;s++){let o={};for(let i of e){let c=t.getChild(i.name);o[i.name]=nt(c.get(s))}r.push(o)}return r}function nt(t){if(t==null)return t;if(typeof t=="bigint")return Number(t);if(typeof t=="object"&&t!==null&&!(t instanceof Date)){let r=t;if(typeof r.toString=="function"){let e=r.toString();if(e!==""&&e!=="[object Object]"&&!isNaN(Number(e)))return Number(e)}}return typeof t=="string"&&t!==""&&!isNaN(Number(t))?Number(t):t}function C(t){let r=t.trim().split(`
`),e=[],n=r[0].toLowerCase(),o=n.includes("date")||n.includes("isin")?1:0;for(let i=o;i<r.length;i++){let c=r[i].split(",").map(l=>l.trim());if(c.length>=5){let[l,m,y,E,O]=c;l&&m&&y&&E&&O&&e.push({date:l,isin:m.toUpperCase(),quantity:parseFloat(y),price:parseFloat(E),type:O.toUpperCase()})}else if(c.length>=4){let[l,m,y,E]=c;l&&m&&y&&E&&e.push({date:l,isin:m.toUpperCase(),quantity:parseFloat(y),price:parseFloat(E),type:"BUY"})}}return e}var d=`
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
    )`,k="DROP TABLE IF EXISTS transactions",I=`
    CREATE TABLE transactions (
        seq INTEGER,
        date DATE,
        isin VARCHAR,
        quantity DOUBLE,
        price DOUBLE,
        type VARCHAR
    )`;function M(t){return`
WITH ${d},

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
FROM raw`}function P(t){return`
WITH ${d},

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
ORDER BY date`}function F(){return`
WITH ${d}
SELECT isin, cost_basis AS cost_basis, shares
FROM remaining_lots
WHERE shares > 0
ORDER BY isin, cost_basis`}function U(){return`
WITH ${d}
SELECT
    sell_date::VARCHAR AS date,
    isin,
    matched_qty AS shares_sold,
    sell_price  AS sale_price,
    buy_price   AS cost_basis,
    matched_qty * (sell_price - buy_price) AS pnl
FROM fifo_matches
ORDER BY sell_date, isin, buy_price`}var it=`
    CREATE OR REPLACE TABLE dim_calendar AS
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
    FROM generate_series(
        (SELECT MIN(date) FROM transactions),
        (SELECT MAX(date) FROM transactions),
        INTERVAL 1 DAY
    ) AS t(d)`,st=`
    CREATE OR REPLACE TABLE dim_stock AS
    SELECT DISTINCT
        isin,
        NULL::VARCHAR AS name,
        NULL::VARCHAR AS sector,
        NULL::VARCHAR AS industry
    FROM transactions`,ot=`
    CREATE OR REPLACE TABLE fact_trades AS
    WITH ${d}
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
    FROM fifo_matches`,at=`
    CREATE OR REPLACE TABLE fact_positions AS
    WITH ${d}
    SELECT
        isin,
        date       AS buy_date,
        cost_basis,
        shares     AS quantity,
        shares * cost_basis AS value_at_cost
    FROM remaining_lots
    WHERE shares > 0`,q=[it,st,ot,at];function _(t,r="t.sell_date"){if(!t)return"";let e=[];return t.isin&&e.push(`t.isin = '${t.isin}'`),t.sector&&e.push(`s.sector = '${t.sector}'`),t.dateFrom&&e.push(`${r} >= '${t.dateFrom}'`),t.dateTo&&e.push(`${r} <= '${t.dateTo}'`),e.length>0?"WHERE "+e.join(" AND "):""}function x(t){return`
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
    ORDER BY total_pnl DESC`}function v(t,r){let e={week:"c.year_week",month:"c.year_month",quarter:"c.year_quarter",year:"c.year"}[t];return`
    SELECT
        ${e}                AS period,
        COUNT(*)              AS num_trades,
        SUM(t.pnl)           AS total_pnl,
        SUM(t.proceeds)      AS total_proceeds,
        SUM(t.cost_basis)    AS total_cost
    FROM fact_trades t
    JOIN dim_calendar c ON t.sell_date = c.date
    ${_(r)}
    GROUP BY ${e}
    ORDER BY ${e}`}function H(t,r,e=5,n){let s={week:"c.year_week",month:"c.year_month",quarter:"c.year_quarter",year:"c.year"}[t],o=r==="best"?"DESC":"ASC";return`
    SELECT
        ${s}                AS period,
        COUNT(*)              AS num_trades,
        SUM(t.pnl)           AS total_pnl
    FROM fact_trades t
    JOIN dim_calendar c ON t.sell_date = c.date
    ${_(n)}
    GROUP BY ${s}
    ORDER BY total_pnl ${o}
    LIMIT ${e}`}function $(){return`
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
    ORDER BY value DESC`}function Y(t){return`
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
    ORDER BY total_pnl DESC`}function W(t){return`
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
    ORDER BY t.sell_date DESC, t.pnl DESC`}async function G(t,r){if(await t.exec(k),await t.exec(I),r.length===0)return;let e=1e3;for(let n=0;n<r.length;n+=e){let o=r.slice(n,n+e).map((i,c)=>`(${n+c}, '${i.date}', '${i.isin}', ${i.quantity}, ${i.price}, '${i.type}')`).join(", ");await t.exec(`INSERT INTO transactions VALUES ${o}`)}await ct(t)}async function ct(t){for(let r of q)await t.exec(r)}async function V(t,r){let e=await t.query(M(r));if(e.length===0||e[0].first_date==null)return null;let n=e[0],s=await lt(t),o=await ut(t);return{totalInvested:Number(n.total_invested),totalProceeds:Number(n.total_proceeds),realizedPnL:Number(n.realized_pnl),costBasisRemaining:Number(n.cost_basis_remaining),cashBalance:Number(n.cash_balance),portfolioValue:Number(n.portfolio_value),totalReturn:Number(n.total_return),totalReturnPct:Number(n.total_return_pct),numStocks:Number(n.num_stocks),holdingDays:Number(n.holding_days),holdingYears:Number(n.holding_years),annualizedReturnPct:Number(n.annualized_return_pct),firstDate:String(n.first_date),lastDate:String(n.last_date),holdings:s,sellDetails:o}}async function z(t,r){return(await t.query(P(r))).map(n=>({date:String(n.date),cash:Number(n.cash),holdingsCost:Number(n.holdings_cost),portfolioValue:Number(n.portfolio_value),returnPct:Number(n.return_pct)}))}async function lt(t){return(await t.query(F())).map(e=>({isin:String(e.isin),shares:Number(e.shares),costBasis:Number(e.cost_basis)}))}async function ut(t){return(await t.query(U())).map(e=>({date:String(e.date),isin:String(e.isin),sharesSold:Number(e.shares_sold),salePrice:Number(e.sale_price),costBasis:Number(e.cost_basis),pnl:Number(e.pnl)}))}var S={isin:{type:"string",description:"Filter by ISIN (e.g. INE002A01018)"},sector:{type:"string",description:"Filter by sector"},dateFrom:{type:"string",description:"Start date (YYYY-MM-DD)"},dateTo:{type:"string",description:"End date (YYYY-MM-DD)"}},dt=[{type:"function",function:{name:"pnl_by_stock",description:"Get realized PnL breakdown by stock. Shows total PnL, return %, trade count, and avg holding days per ISIN.",parameters:{type:"object",properties:S,required:[]}}},{type:"function",function:{name:"pnl_by_period",description:"Get realized PnL aggregated by time period. Choose granularity: week, month, quarter, or year.",parameters:{type:"object",properties:{granularity:{type:"string",enum:["week","month","quarter","year"],description:"Time granularity"},...S},required:["granularity"]}}},{type:"function",function:{name:"top_periods",description:"Get the best or worst performing periods by PnL.",parameters:{type:"object",properties:{granularity:{type:"string",enum:["week","month","quarter","year"]},direction:{type:"string",enum:["best","worst"]},limit:{type:"number",description:"Number of periods to return (default 5)"},...S},required:["granularity","direction"]}}},{type:"function",function:{name:"holdings_concentration",description:"Get current portfolio holdings with concentration weights (% of total value).",parameters:{type:"object",properties:{},required:[]}}},{type:"function",function:{name:"pnl_by_sector",description:"Get realized PnL aggregated by sector.",parameters:{type:"object",properties:S,required:[]}}},{type:"function",function:{name:"trade_detail",description:"Get individual FIFO-matched trade details with buy/sell dates, prices, PnL, and holding days.",parameters:{type:"object",properties:S,required:[]}}},{type:"function",function:{name:"run_sql",description:"Run arbitrary read-only SQL against the portfolio database. Available tables: transactions (seq, date, isin, quantity, price, type), fact_trades (trade_id, isin, buy_date, sell_date, buy_price, sell_price, quantity, cost_basis, proceeds, pnl, return_pct, holding_days), fact_positions (isin, buy_date, cost_basis, quantity, value_at_cost), dim_calendar (date, year, quarter, month, week, year_month, year_week, year_quarter), dim_stock (isin, name, sector, industry).",parameters:{type:"object",properties:{sql:{type:"string",description:"SQL SELECT query to execute"}},required:["sql"]}}}];function g(t){let r={};return typeof t.isin=="string"&&(r.isin=t.isin),typeof t.sector=="string"&&(r.sector=t.sector),typeof t.dateFrom=="string"&&(r.dateFrom=t.dateFrom),typeof t.dateTo=="string"&&(r.dateTo=t.dateTo),Object.keys(r).length>0?r:void 0}async function pt(t,r,e){let n;switch(r){case"pnl_by_stock":n=x(g(e));break;case"pnl_by_period":n=v(e.granularity,g(e));break;case"top_periods":n=H(e.granularity,e.direction,typeof e.limit=="number"?e.limit:5,g(e));break;case"holdings_concentration":n=$();break;case"pnl_by_sector":n=Y(g(e));break;case"trade_detail":n=W(g(e));break;case"run_sql":{let i=String(e.sql).trim();if(!i.toUpperCase().startsWith("SELECT"))return JSON.stringify({error:"Only SELECT queries are allowed"});n=i;break}default:return JSON.stringify({error:`Unknown tool: ${r}`})}let s=await t.query(n),o=JSON.stringify(s);if(o.length>8e3){let i=s.slice(0,20);return JSON.stringify({rows:i,note:`Showing 20 of ${s.length} rows. Use filters to narrow results.`})}return o}var mt=`You are a concise portfolio analyst. You have access to a user's stock trading data through analysis tools.

Your job:
1. Use the tools to explore the portfolio data \u2014 look at PnL by stock, by period, concentration, trade details, etc.
2. Identify patterns, risks, and actionable observations.
3. Produce succinct, insightful analysis in 4-6 bullet points.

Guidelines:
- Start by getting an overview (PnL by stock, holdings concentration).
- Then drill into interesting patterns (best/worst periods, individual trades).
- Focus on non-obvious insights, not just restating numbers.
- Use specific numbers to support your points.
- Keep the final output brief and high-signal.
- Format the final output as markdown bullet points.
- Use INR (\u20B9) for currency values.`,yt=8;async function j(t,r,e){let n=[{role:"system",content:mt},{role:"user",content:"Analyze my portfolio and provide key insights."}];for(let s=0;s<yt;s++){e?.(`Thinking... (step ${s+1})`);let o=await Et(r,n);if(!o.tool_calls||o.tool_calls.length===0)return o.content||"No insights generated.";n.push({role:"assistant",content:o.content,tool_calls:o.tool_calls});for(let i of o.tool_calls){e?.(`Querying: ${i.function.name}...`);let c;try{let l=JSON.parse(i.function.arguments);c=await pt(t,i.function.name,l)}catch(l){c=JSON.stringify({error:String(l)})}n.push({role:"tool",tool_call_id:i.id,content:c})}}return"Analysis incomplete \u2014 reached maximum exploration steps."}async function Et(t,r){let e=await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${t}`,"Content-Type":"application/json"},body:JSON.stringify({model:"anthropic/claude-sonnet-4",messages:r,tools:dt,max_tokens:4096})});if(!e.ok){let o=await e.text();throw new Error(`API error ${e.status}: ${o}`)}let s=(await e.json()).choices?.[0]?.message;if(!s)throw new Error("No response from LLM");return{content:s.content??null,tool_calls:s.tool_calls}}var Q={dataPath:"data",benchmarks:{nifty50:"nifty50.parquet",bank_nifty:"bank_nifty.parquet",sensex:"sensex.parquet",nifty_midcap:"nifty_midcap.parquet",bse_500:"bse_500.parquet"}},L=null,A=null,a={csvInput:document.getElementById("csvInput"),benchmarkSelect:document.getElementById("benchmarkSelect"),initialCapital:document.getElementById("initialCapital"),loadingSection:document.getElementById("loadingSection"),loadingText:document.getElementById("loadingText"),errorSection:document.getElementById("errorSection"),errorMessage:document.getElementById("errorMessage"),retryBtn:document.getElementById("retryBtn"),insightsSection:document.getElementById("insightsSection"),apiKey:document.getElementById("apiKey"),generateInsightsBtn:document.getElementById("generateInsights"),insightsStatus:document.getElementById("insightsStatus"),insightsOutput:document.getElementById("insightsOutput")};async function D(){w("Initializing DuckDB...");try{await B(),p()}catch(t){p(),R("Failed to initialize DuckDB: "+(t instanceof Error?t.message:String(t)))}}function _t(){a.csvInput.addEventListener("change",J),a.retryBtn.addEventListener("click",()=>{a.errorSection.style.display="none",D()}),a.benchmarkSelect.addEventListener("change",async()=>{A&&await X()}),a.apiKey.addEventListener("input",()=>{a.generateInsightsBtn.disabled=!a.apiKey.value.trim()}),a.generateInsightsBtn.addEventListener("click",bt)}async function J(t){let e=t.target.files?.[0];if(e){w("Parsing transactions...");try{let n=await e.text(),s=C(n);if(s.length===0)throw new Error("No valid transactions found in CSV");if(s.sort((o,i)=>new Date(o.date).getTime()-new Date(i.date).getTime()),!N())throw new Error("Database not initialized. Please refresh the page and try again.");A=s,await G(b(),s),await X(),p()}catch(n){p(),R("Error processing CSV: "+(n instanceof Error?n.message:String(n)))}}}async function X(){if(A){w("Analyzing portfolio...");try{let t=parseFloat(a.initialCapital.value)||1e5,r=b(),e=await V(r,t);if(!e){R("No portfolio data available for analysis"),p();return}let n=await z(r,t),s=await St(a.benchmarkSelect.value);gt(e,n,s),a.insightsSection.style.display="block",p()}catch(t){p(),R("Analysis error: "+(t instanceof Error?t.message:String(t)))}}}async function St(t){let r=Q.benchmarks[t];try{return(await T(`
            SELECT
                date,
                close_price,
                (close_price - LAG(close_price) OVER (ORDER BY date)) /
                    NULLIF(LAG(close_price) OVER (ORDER BY date), 0) * 100 as daily_return_pct,
                SUM((close_price - LAG(close_price) OVER (ORDER BY date)) /
                    NULLIF(LAG(close_price) OVER (ORDER BY date), 0)) OVER (ORDER BY date) * 100 as cumulative_return_pct
            FROM parquet_scan('${Q.dataPath}/${r}')
            WHERE date IS NOT NULL AND close_price IS NOT NULL
            ORDER BY date
        `)).map(n=>({date:n.date,closePrice:Number(n.close_price)||0,cumulativeReturnPct:Number(n.cumulative_return_pct)||0}))}catch(e){return console.warn(`Could not load benchmark data for ${t}:`,e.message),[]}}function gt(t,r,e){let n=c=>document.getElementById(c),s=n("totalReturn");s.textContent=`${t.totalReturn>=0?"+":""}${t.totalReturnPct.toFixed(2)}%`,s.className="stat-value "+(t.totalReturn>=0?"positive":"negative");let o=n("annualizedReturn");o.textContent=`${t.annualizedReturnPct>=0?"+":""}${t.annualizedReturnPct.toFixed(2)}%`,o.className="stat-value "+(t.annualizedReturnPct>=0?"positive":"negative"),n("portfolioValue").textContent=`\u20B9${t.portfolioValue.toLocaleString("en-IN")}`,n("holdingPeriod").textContent=`${t.holdingDays} days (${t.holdingYears.toFixed(1)} years)`;let i=n("pnlGrid");if(t.realizedPnL!==0){i.style.display="grid";let c=n("totalRealizedPnL");c.textContent=`${t.realizedPnL>=0?"+":""}\u20B9${t.realizedPnL.toLocaleString("en-IN")}`,c.className="stat-value "+(t.realizedPnL>=0?"positive":"negative"),n("totalUnrealizedGain").textContent="-",n("fifoCostBasis").textContent=`\u20B9${t.costBasisRemaining.toLocaleString("en-IN")}`,n("stocksCount").textContent=`${t.numStocks}`}else i.style.display="none";ft(r,e)}function ft(t,r){let e=document.getElementById("returnsChart").getContext("2d"),n=t.map(i=>i.date),s=t.map(i=>i.returnPct),o;if(r.length>0){let i=new Set(t.map(c=>String(c.date)));o=r.filter(c=>i.has(String(c.date))).map(c=>c.cumulativeReturnPct)}else o=t.map(()=>0);L&&L.destroy(),L=new Chart(e,{type:"line",data:{labels:n.slice(0,100),datasets:[{label:"Portfolio",data:s.slice(0,100),borderColor:"#4facfe",backgroundColor:"rgba(79, 172, 254, 0.1)",borderWidth:2,pointRadius:2,fill:!0,tension:.1},{label:"Benchmark ("+a.benchmarkSelect.options[a.benchmarkSelect.selectedIndex].text+")",data:o.slice(0,100),borderColor:"#4caf50",borderWidth:2,pointRadius:2,fill:!1,tension:.1}]},options:{responsive:!0,maintainAspectRatio:!1,interaction:{mode:"index",intersect:!1},plugins:{legend:{position:"top",labels:{color:"#e0e0e0",font:{size:12}}},tooltip:{backgroundColor:"rgba(0,0,0,0.8)",titleColor:"#fff",bodyColor:"#e0e0e0",borderColor:"rgba(255,255,255,0.1)",borderWidth:1,callbacks:{label:i=>i.dataset.label+": "+i.parsed.y.toFixed(2)+"%"}},title:{display:!0,text:"Cumulative Returns Comparison",color:"#fff",font:{size:14}}},scales:{x:{grid:{color:"rgba(255,255,255,0.05)"},ticks:{color:"#888",maxTicksLimit:10}},y:{grid:{color:"rgba(255,255,255,0.05)"},ticks:{color:"#888",callback:i=>i+"%"},border:{color:"rgba(255,255,255,0.1)"}}}}})}async function bt(){let t=a.apiKey.value.trim();if(!(!t||!A)){a.generateInsightsBtn.disabled=!0,a.insightsStatus.style.display="block",a.insightsOutput.textContent="";try{let r=await j(b(),t,e=>{a.insightsStatus.textContent=e});a.insightsStatus.style.display="none",a.insightsOutput.innerHTML=Rt(r)}catch(r){a.insightsStatus.style.display="none",a.insightsOutput.textContent="Error: "+(r instanceof Error?r.message:String(r)),a.insightsOutput.className="insights-output error"}finally{a.generateInsightsBtn.disabled=!1}}}function Rt(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/\*(.+?)\*/g,"<em>$1</em>").replace(/`(.+?)`/g,"<code>$1</code>").replace(/^- (.+)$/gm,"<li>$1</li>").replace(/((?:<li>.*<\/li>\n?)+)/g,"<ul>$1</ul>").replace(/\n{2,}/g,"<br><br>").replace(/\n/g,"<br>")}function w(t){a.loadingText.textContent=t,a.loadingSection.style.display="flex"}function p(){a.loadingSection.style.display="none"}function R(t){a.loadingSection.style.display="none",a.errorMessage.textContent=t,a.errorSection.style.display="block",a.errorSection.style.visibility="visible",a.errorSection.style.opacity="1"}document.addEventListener("DOMContentLoaded",()=>{_t(),D()});window.PortfolioAnalysis={init:D,parseCSV:C,handleFileUpload:J};
