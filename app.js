var D,A=new Map;function lt(t){return t.replace(/\//g,"__").replace(/[^A-Za-z0-9._-]/g,"_")}function ut(){return D||(D=(async()=>{try{let r=await(await navigator.storage.getDirectory()).getDirectoryHandle("parquet-cache",{create:!0}),n=await(await r.getFileHandle("__probe__",{create:!0})).createWritable();return await n.write(new Uint8Array([0])),await n.close(),await r.removeEntry("__probe__"),r}catch{return null}})()),D}async function dt(t,r){try{let n=await(await t.getFileHandle(r+".meta")).getFile();return JSON.parse(await n.text())}catch{return null}}async function F(t,r){try{return await(await(await t.getFileHandle(r)).getFile()).arrayBuffer()}catch{return null}}function P(t,r,e,n){(async()=>{try{let s=await(await t.getFileHandle(r,{create:!0})).createWritable();await s.write(e),await s.close();let c=await(await t.getFileHandle(r+".meta",{create:!0})).createWritable();await c.write(JSON.stringify(n)),await c.close()}catch(i){console.warn("[opfs-cache] write failed:",i)}})()}async function pt(t,r){await Promise.all([t.removeEntry(r).catch(()=>{}),t.removeEntry(r+".meta").catch(()=>{})])}async function x(t,r){let e=lt(t),n=A.get(e);if(n)return n;let i=mt(r,e);return A.set(e,i),i.then(()=>A.delete(e),()=>A.delete(e)),i}async function mt(t,r){let e=await ut();if(!e){let a=await fetch(t);if(!a.ok)throw new Error(`Failed to fetch ${t}: ${a.status}`);return a.arrayBuffer()}let n=await dt(e,r);if(n){let a={};if(n.etag?a["If-None-Match"]=n.etag:n.lastModified&&(a["If-Modified-Since"]=n.lastModified),Object.keys(a).length>0){let c=null,l=null;try{c=await fetch(t,{headers:a})}catch(u){l=u}if(l||c&&c.status>=500){let u=await F(e,r);if(u)return u;throw l||new Error(`Failed to fetch ${t}: ${c.status}`)}if(c.status>=400)throw await pt(e,r),new Error(`Failed to fetch ${t}: ${c.status}`);if(c.status===304){let u=await F(e,r);if(u)return u}else{let u=await c.arrayBuffer();return P(e,r,u,{etag:c.headers.get("etag")??void 0,lastModified:c.headers.get("last-modified")??void 0}),u}}}let i=await fetch(t);if(!i.ok)throw new Error(`Failed to fetch ${t}: ${i.status}`);let s=await i.arrayBuffer();return P(e,r,s,{etag:i.headers.get("etag")??void 0,lastModified:i.headers.get("last-modified")??void 0}),s}var yt="https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm",b=null,S=null,p=null;async function Et(){return b||(b=await import(yt),b)}async function U(){if(p)return;let t=await Et(),r=t.getJsDelivrBundles(),e=await t.selectBundle(r),n=URL.createObjectURL(new Blob([`importScripts("${e.mainWorker}");`],{type:"text/javascript"})),i=new Worker(n),s=new t.ConsoleLogger;S=new t.AsyncDuckDB(s,i),await S.instantiate(e.mainModule,e.pthreadWorker),p=await S.connect()}function v(){return p!==null}async function St(t){if(!p)throw new Error("DuckDB not initialized. Call initDuckDB() first.");await p.query(t)}async function O(t){if(!p)throw new Error("DuckDB not initialized. Call initDuckDB() first.");let r=await p.query(t);return gt(r)}async function T(t,r){if(!S)throw new Error("DuckDB not initialized. Call initDuckDB() first.");let e=await x(t,r);await S.registerFileBuffer(t,new Uint8Array(e))}function R(){return{exec:St,query:O}}function gt(t){let r=[],e=t.schema.fields,n=t.numRows;for(let i=0;i<n;i++){let s={};for(let a of e){let c=t.getChild(a.name);s[a.name]=ft(c.get(i))}r.push(s)}return r}function ft(t){if(t==null)return t;if(typeof t=="bigint")return Number(t);if(typeof t=="object"&&t!==null&&!(t instanceof Date)){let r=t;if(typeof r.toString=="function"){let e=r.toString();if(e!==""&&e!=="[object Object]"&&!isNaN(Number(e)))return Number(e)}}return typeof t=="string"&&t!==""&&!isNaN(Number(t))?Number(t):t}function N(t){let r=t.trim().split(`
`),e=[],n=r[0].toLowerCase(),s=n.includes("date")||n.includes("isin")?1:0;for(let a=s;a<r.length;a++){let c=r[a].split(",").map(l=>l.trim());if(c.length>=5){let[l,u,d,E,I]=c;l&&u&&d&&E&&I&&e.push({date:l,isin:u.toUpperCase(),quantity:parseFloat(d),price:parseFloat(E),type:I.toUpperCase()})}else if(c.length>=4){let[l,u,d,E]=c;l&&u&&d&&E&&e.push({date:l,isin:u.toUpperCase(),quantity:parseFloat(d),price:parseFloat(E),type:"BUY"})}}return e}var y=`
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
    )`,q="DROP TABLE IF EXISTS transactions",H=`
    CREATE TABLE transactions (
        seq INTEGER,
        date DATE,
        isin VARCHAR,
        quantity DOUBLE,
        price DOUBLE,
        type VARCHAR
    )`;function $(t){return`
WITH ${y},

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
FROM raw`}function W(){return`
WITH ${y}
SELECT isin, cost_basis AS cost_basis, shares
FROM remaining_lots
WHERE shares > 0
ORDER BY isin, cost_basis`}function Y(){return`
WITH ${y}
SELECT
    sell_date::VARCHAR AS date,
    isin,
    matched_qty AS shares_sold,
    sell_price  AS sale_price,
    buy_price   AS cost_basis,
    matched_qty * (sell_price - buy_price) AS pnl
FROM fifo_matches
ORDER BY sell_date, isin, buy_price`}var ht=`
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
    FROM dates`,At=`
    CREATE OR REPLACE TABLE dim_stock AS
    SELECT DISTINCT
        isin,
        NULL::VARCHAR AS name,
        NULL::VARCHAR AS sector,
        NULL::VARCHAR AS industry
    FROM transactions`,bt=`
    CREATE OR REPLACE TABLE fact_trades AS
    WITH ${y}
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
    FROM fifo_matches`,Tt=`
    CREATE OR REPLACE TABLE fact_positions AS
    WITH ${y}
    SELECT
        isin,
        date       AS buy_date,
        cost_basis,
        shares     AS quantity,
        shares * cost_basis AS value_at_cost
    FROM remaining_lots
    WHERE shares > 0`,V=[ht,At,bt,Tt];function g(t,r="t.sell_date"){if(!t)return"";let e=[];return t.isin&&e.push(`t.isin = '${t.isin}'`),t.sector&&e.push(`s.sector = '${t.sector}'`),t.dateFrom&&e.push(`${r} >= '${t.dateFrom}'`),t.dateTo&&e.push(`${r} <= '${t.dateTo}'`),e.length>0?"WHERE "+e.join(" AND "):""}function z(t){return`
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
    ${g(t)}
    GROUP BY t.isin, s.name, s.sector
    ORDER BY total_pnl DESC`}function G(t,r){let e={week:"c.year_week",month:"c.year_month",quarter:"c.year_quarter",year:"c.year"}[t];return`
    SELECT
        ${e}                AS period,
        COUNT(*)              AS num_trades,
        SUM(t.pnl)           AS total_pnl,
        SUM(t.proceeds)      AS total_proceeds,
        SUM(t.cost_basis)    AS total_cost
    FROM fact_trades t
    JOIN dim_calendar c ON t.sell_date = c.date
    ${g(r)}
    GROUP BY ${e}
    ORDER BY ${e}`}function j(t,r,e=5,n){let i={week:"c.year_week",month:"c.year_month",quarter:"c.year_quarter",year:"c.year"}[t],s=r==="best"?"DESC":"ASC";return`
    SELECT
        ${i}                AS period,
        COUNT(*)              AS num_trades,
        SUM(t.pnl)           AS total_pnl
    FROM fact_trades t
    JOIN dim_calendar c ON t.sell_date = c.date
    ${g(n)}
    GROUP BY ${i}
    ORDER BY total_pnl ${s}
    LIMIT ${e}`}function J(){return`
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
    ORDER BY value DESC`}function Q(t){return`
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
    ${g(t)}
    GROUP BY COALESCE(s.sector, 'Unknown')
    ORDER BY total_pnl DESC`}function X(t){return`
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
    ${g(t)}
    ORDER BY t.sell_date DESC, t.pnl DESC`}async function K(t,r){if(await t.exec(q),await t.exec(H),r.length===0)return;let e=1e3;for(let n=0;n<r.length;n+=e){let s=r.slice(n,n+e).map((a,c)=>`(${n+c}, '${a.date}', '${a.isin}', ${a.quantity}, ${a.price}, '${a.type}')`).join(", ");await t.exec(`INSERT INTO transactions VALUES ${s}`)}await Rt(t)}async function Rt(t){for(let r of V)await t.exec(r)}async function Z(t,r){let e=await t.query($(r));if(e.length===0||e[0].first_date==null)return null;let n=e[0],i=await wt(t),s=await Ct(t);return{totalInvested:Number(n.total_invested),totalProceeds:Number(n.total_proceeds),realizedPnL:Number(n.realized_pnl),costBasisRemaining:Number(n.cost_basis_remaining),cashBalance:Number(n.cash_balance),portfolioValue:Number(n.portfolio_value),totalReturn:Number(n.total_return),totalReturnPct:Number(n.total_return_pct),numStocks:Number(n.num_stocks),holdingDays:Number(n.holding_days),holdingYears:Number(n.holding_years),annualizedReturnPct:Number(n.annualized_return_pct),firstDate:String(n.first_date),lastDate:String(n.last_date),holdings:i,sellDetails:s}}async function wt(t){return(await t.query(W())).map(e=>({isin:String(e.isin),shares:Number(e.shares),costBasis:Number(e.cost_basis)}))}async function Ct(t){return(await t.query(Y())).map(e=>({date:String(e.date),isin:String(e.isin),sharesSold:Number(e.shares_sold),salePrice:Number(e.sale_price),costBasis:Number(e.cost_basis),pnl:Number(e.pnl)}))}var f={isin:{type:"string",description:"Filter by ISIN (e.g. INE002A01018)"},sector:{type:"string",description:"Filter by sector"},dateFrom:{type:"string",description:"Start date (YYYY-MM-DD)"},dateTo:{type:"string",description:"End date (YYYY-MM-DD)"}},Lt=[{type:"function",function:{name:"pnl_by_stock",description:"Get realized PnL breakdown by stock. Shows total PnL, return %, trade count, and avg holding days per ISIN.",parameters:{type:"object",properties:f,required:[]}}},{type:"function",function:{name:"pnl_by_period",description:"Get realized PnL aggregated by time period. Choose granularity: week, month, quarter, or year.",parameters:{type:"object",properties:{granularity:{type:"string",enum:["week","month","quarter","year"],description:"Time granularity"},...f},required:["granularity"]}}},{type:"function",function:{name:"top_periods",description:"Get the best or worst performing periods by PnL.",parameters:{type:"object",properties:{granularity:{type:"string",enum:["week","month","quarter","year"]},direction:{type:"string",enum:["best","worst"]},limit:{type:"number",description:"Number of periods to return (default 5)"},...f},required:["granularity","direction"]}}},{type:"function",function:{name:"holdings_concentration",description:"Get current portfolio holdings with concentration weights (% of total value).",parameters:{type:"object",properties:{},required:[]}}},{type:"function",function:{name:"pnl_by_sector",description:"Get realized PnL aggregated by sector.",parameters:{type:"object",properties:f,required:[]}}},{type:"function",function:{name:"trade_detail",description:"Get individual FIFO-matched trade details with buy/sell dates, prices, PnL, and holding days.",parameters:{type:"object",properties:f,required:[]}}},{type:"function",function:{name:"run_sql",description:"Run arbitrary read-only SQL against the portfolio database. Available tables: transactions (seq, date, isin, quantity, price, type), fact_trades (trade_id, isin, buy_date, sell_date, buy_price, sell_price, quantity, cost_basis, proceeds, pnl, return_pct, holding_days), fact_positions (isin, buy_date, cost_basis, quantity, value_at_cost), dim_calendar (date, year, quarter, month, week, year_month, year_week, year_quarter), dim_stock (isin, name, sector, industry).",parameters:{type:"object",properties:{sql:{type:"string",description:"SQL SELECT query to execute"}},required:["sql"]}}}];function _(t){let r={};return typeof t.isin=="string"&&(r.isin=t.isin),typeof t.sector=="string"&&(r.sector=t.sector),typeof t.dateFrom=="string"&&(r.dateFrom=t.dateFrom),typeof t.dateTo=="string"&&(r.dateTo=t.dateTo),Object.keys(r).length>0?r:void 0}async function Dt(t,r,e){let n;switch(r){case"pnl_by_stock":n=z(_(e));break;case"pnl_by_period":n=G(e.granularity,_(e));break;case"top_periods":n=j(e.granularity,e.direction,typeof e.limit=="number"?e.limit:5,_(e));break;case"holdings_concentration":n=J();break;case"pnl_by_sector":n=Q(_(e));break;case"trade_detail":n=X(_(e));break;case"run_sql":{let a=String(e.sql).trim();if(!a.toUpperCase().startsWith("SELECT"))return JSON.stringify({error:"Only SELECT queries are allowed"});n=a;break}default:return JSON.stringify({error:`Unknown tool: ${r}`})}let i=await t.query(n),s=JSON.stringify(i);if(s.length>8e3){let a=i.slice(0,20);return JSON.stringify({rows:a,note:`Showing 20 of ${i.length} rows. Use filters to narrow results.`})}return s}var M="__OPENROUTER_API_KEY__",Ot=["stepfun/step-3.5-flash:free","meta-llama/llama-3.3-70b-instruct:free"],Nt="anthropic/claude-sonnet-4";function tt(){return M.length>0&&!M.startsWith("__OPENROUTER_")}var Mt=`You are an expert portfolio analyst. Analyze the user's stock trading data using the available tools.

**Process:**
1. First call pnl_by_stock and holdings_concentration to get the full picture.
2. Then drill into one or two specifics (e.g. trade_detail for notable trades, top_periods for timing patterns).
3. Only state findings you can back with data from tool results. Never speculate or infer beyond what the data shows.

**Output rules:**
- Exactly 3-5 bullet points. No preamble, no summary header, no closing remarks.
- Each bullet must cite a specific number (\u20B9 amount, %, count, or date).
- Focus on: concentration risk, realized gains/losses, cost basis efficiency, and holding period patterns.
- Skip obvious observations (e.g. "you bought stocks"). Surface what the investor might not notice themselves.
- Use \u20B9 for currency. Keep each bullet to 1-2 sentences max.`,Bt=8;async function et(t,r,e){let n=r.apiKey||M,i=r.model?[r.model]:r.apiKey?[Nt]:Ot;if(!n||n.startsWith("__OPENROUTER_"))throw new Error("No API key configured. Please enter your OpenRouter API key.");let s=[{role:"system",content:Mt},{role:"user",content:"Analyze my portfolio and provide key insights."}];for(let a=0;a<Bt;a++){e?.(`Thinking... (step ${a+1})`);let c=await kt(n,i,s);if(!c.tool_calls||c.tool_calls.length===0)return c.content||"No insights generated.";s.push({role:"assistant",content:c.content,tool_calls:c.tool_calls});for(let l of c.tool_calls){e?.(`Querying: ${l.function.name}...`);let u;try{let d=JSON.parse(l.function.arguments);u=await Dt(t,l.function.name,d)}catch(d){u=JSON.stringify({error:String(d)})}s.push({role:"tool",tool_call_id:l.id,content:u})}}return"Analysis incomplete \u2014 reached maximum exploration steps."}async function kt(t,r,e){let n=null;for(let i of r)try{return await It(t,i,e)}catch(s){if(n=s instanceof Error?s:new Error(String(s)),!/429|404|403/.test(n.message))throw n}throw n||new Error("All models failed")}async function It(t,r,e){for(let i=0;i<3;i++){let s=await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${t}`,"Content-Type":"application/json"},body:JSON.stringify({model:r,messages:e,tools:Lt,max_tokens:1024})});if(s.status===429&&i<2){await new Promise(l=>setTimeout(l,3e3*(i+1)));continue}if(!s.ok){let l=await s.text();throw new Error(`API error ${s.status}: ${l}`)}let c=(await s.json()).choices?.[0]?.message;if(!c)throw new Error("No response from LLM");return{content:c.content??null,tool_calls:c.tool_calls}}throw new Error("Max retries exceeded")}var w=null;async function Ft(){if(w)return w;let t=await fetch("data/isin_map.json");if(!t.ok)throw new Error("Failed to load ISIN map");return w=await t.json(),w}async function Pt(t,r){await t.exec("DROP TABLE IF EXISTS stock_prices"),await t.exec("CREATE TABLE stock_prices (date DATE, symbol VARCHAR, isin VARCHAR, close DOUBLE)");let e=await t.query("SELECT DISTINCT isin FROM transactions");for(let n of e){let i=String(n.isin),s=r[i];if(!s)continue;let a=`${s}.parquet`;try{await T(`stock_prices/${a}`,`data/stock_prices/${a}`),await t.exec(`
                INSERT INTO stock_prices
                SELECT date, symbol, '${i}' as isin, close
                FROM parquet_scan('stock_prices/${a}')
                WHERE close IS NOT NULL
            `)}catch{}}}var xt=t=>`
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
`;async function nt(t,r){let e=await Ft();return await Pt(t,e),(await t.query(xt(r))).map(i=>{let s=i.date,a;return typeof s=="number"?a=s:s instanceof Date?a=s.getTime():a=new Date(String(s)).getTime(),{date:a,value:Number(i.portfolio_value)||0,cash:Number(i.cash)||0,returnPct:Number(i.return_pct)||0}})}var rt={dataPath:"data",benchmarks:{nifty50:"nifty50.parquet",bank_nifty:"bank_nifty.parquet",sensex:"sensex.parquet",nifty_midcap:"nifty_midcap.parquet",bse_500:"bse_500.parquet"}},B=null,L=null,it=1e5,o={csvInput:document.getElementById("csvInput"),benchmarkSelect:document.getElementById("benchmarkSelect"),loadingSection:document.getElementById("loadingSection"),loadingText:document.getElementById("loadingText"),errorSection:document.getElementById("errorSection"),errorMessage:document.getElementById("errorMessage"),retryBtn:document.getElementById("retryBtn"),uploadSection:document.getElementById("uploadSection"),changeFileBtn:document.getElementById("changeFile"),insightsSection:document.getElementById("insightsSection"),insightsSummary:document.getElementById("insightsSummary"),insightsFull:document.getElementById("insightsFull"),insightsToggle:document.getElementById("insightsToggle"),apiKey:document.getElementById("apiKey"),generateInsightsBtn:document.getElementById("generateInsights"),insightsStatus:document.getElementById("insightsStatus")};async function k(){h("Initializing DuckDB...");try{await U(),m()}catch(t){m(),C("Failed to initialize DuckDB: "+(t instanceof Error?t.message:String(t)))}}function Ut(){o.csvInput.addEventListener("change",at),o.retryBtn.addEventListener("click",()=>{o.errorSection.style.display="none",k()}),o.benchmarkSelect.addEventListener("change",async()=>{L&&await ot()}),o.apiKey.addEventListener("input",()=>{o.generateInsightsBtn.disabled=!o.apiKey.value.trim()}),o.generateInsightsBtn.addEventListener("click",$t),o.insightsToggle.addEventListener("click",()=>{let t=o.insightsFull.style.display!=="none";o.insightsFull.style.display=t?"none":"block",o.insightsToggle.textContent=t?"Show more":"Show less"}),o.changeFileBtn.addEventListener("click",()=>{o.insightsSection.style.display="none",o.uploadSection.style.display="block",o.csvInput.value=""})}async function at(t){let e=t.target.files?.[0];if(e){h("Parsing transactions...");try{let n=await e.text(),i=N(n);if(i.length===0)throw new Error("No valid transactions found in CSV");if(i.sort((s,a)=>new Date(s.date).getTime()-new Date(a.date).getTime()),!v())throw new Error("Database not initialized. Please refresh the page and try again.");if(L=i,await K(R(),i),await ot(),m(),tt())ct();else{let s=document.querySelector(".insights-upgrade");s&&(s.open=!0)}}catch(n){m(),C("Error processing CSV: "+(n instanceof Error?n.message:String(n)))}}}async function ot(){if(L){h("Analyzing portfolio...");try{let t=R(),r=await Z(t,it);if(!r){C("No portfolio data available for analysis"),m();return}h("Loading stock prices...");let e=await nt(t,it);h("Loading benchmark...");let n=await vt(o.benchmarkSelect.value,e.length>0?e[0].date:0,e.length>0?e[e.length-1].date:0);qt(r,e,n),o.uploadSection.style.display="none",o.insightsSection.style.display="block",m()}catch(t){m(),C("Analysis error: "+(t instanceof Error?t.message:String(t)))}}}async function vt(t,r,e){if(!r||!e)return[];let n=rt.benchmarks[t];try{await T(n,`${rt.dataPath}/${n}`);let i=new Date(r).toISOString().slice(0,10),s=new Date(e).toISOString().slice(0,10);return(await O(`
            WITH base AS (
                SELECT date, close
                FROM parquet_scan('${n}')
                WHERE date IS NOT NULL AND close IS NOT NULL
                  AND date >= '${i}' AND date <= '${s}'
                ORDER BY date
            ),
            first_close AS (
                SELECT close AS c0 FROM base LIMIT 1
            )
            SELECT b.date, ((b.close - fc.c0) / fc.c0) * 100 AS return_pct
            FROM base b, first_close fc
            ORDER BY b.date
        `)).map(c=>{let l=c.date,u;return typeof l=="number"?u=l:l instanceof Date?u=l.getTime():u=new Date(String(l)).getTime(),{x:u,y:Number(c.return_pct)||0}})}catch(i){return console.warn(`Could not load benchmark data for ${t}:`,i.message),[]}}function qt(t,r,e){let n=c=>document.getElementById(c),i=n("totalReturn");i.textContent=`${t.totalReturn>=0?"+":""}${t.totalReturnPct.toFixed(2)}%`,i.className="stat-value "+(t.totalReturn>=0?"positive":"negative");let s=n("annualizedReturn");s.textContent=`${t.annualizedReturnPct>=0?"+":""}${t.annualizedReturnPct.toFixed(2)}%`,s.className="stat-value "+(t.annualizedReturnPct>=0?"positive":"negative"),n("portfolioValue").textContent=`\u20B9${t.portfolioValue.toLocaleString("en-IN")}`,n("holdingPeriod").textContent=`${t.holdingDays} days (${t.holdingYears.toFixed(1)} years)`;let a=n("pnlGrid");if(t.realizedPnL!==0){a.style.display="grid";let c=n("totalRealizedPnL");c.textContent=`${t.realizedPnL>=0?"+":""}\u20B9${t.realizedPnL.toLocaleString("en-IN")}`,c.className="stat-value "+(t.realizedPnL>=0?"positive":"negative"),n("totalUnrealizedGain").textContent="-",n("fifoCostBasis").textContent=`\u20B9${t.costBasisRemaining.toLocaleString("en-IN")}`,n("stocksCount").textContent=`${t.numStocks}`}else a.style.display="none";Ht(r,e)}function Ht(t,r){let e=document.getElementById("returnsChart").getContext("2d"),n=t.map(i=>({x:i.date,y:i.returnPct}));B&&B.destroy(),B=new Chart(e,{type:"line",data:{datasets:[{label:"Portfolio",data:n,borderColor:"#5367ff",backgroundColor:"rgba(83, 103, 255, 0.08)",borderWidth:2,pointRadius:0,fill:!0,tension:.1},{label:o.benchmarkSelect.options[o.benchmarkSelect.selectedIndex].text,data:r,borderColor:"#00d09c",borderWidth:2,pointRadius:0,fill:!1,tension:.1}]},options:{responsive:!0,maintainAspectRatio:!1,interaction:{mode:"nearest",intersect:!1,axis:"x"},plugins:{legend:{position:"top",labels:{color:"#44475b",font:{size:12}}},tooltip:{backgroundColor:"#fff",titleColor:"#44475b",bodyColor:"#7c7e8c",borderColor:"#e8e8eb",borderWidth:1,callbacks:{label:i=>i.dataset.label+": "+i.parsed.y.toFixed(2)+"%"}}},scales:{x:{type:"time",time:{unit:"month",displayFormats:{month:"MMM yyyy"}},grid:{color:"#f0f0f3"},ticks:{color:"#9b9dab",maxTicksLimit:10}},y:{grid:{color:"#f0f0f3"},ticks:{color:"#9b9dab",callback:i=>i+"%"},border:{color:"#e8e8eb"}}}}})}async function ct(t){if(!L)return;o.generateInsightsBtn.disabled=!0,o.insightsStatus.style.display="block",o.insightsSummary.textContent="",o.insightsSummary.className="insights-summary",o.insightsFull.style.display="none",o.insightsToggle.style.display="none";let r=!!t;try{let e=await et(R(),t?{apiKey:t}:{},a=>{o.insightsStatus.textContent=a});o.insightsStatus.style.display="none";let n=e.split(`
`).filter(a=>a.trim().startsWith("-")),i=n.slice(0,2).join(`
`),s=n.slice(2).join(`
`);o.insightsSummary.innerHTML=st(i),s.trim()&&(o.insightsFull.innerHTML=st(s)+(r?"":'<p class="insights-tier-note">Free model. Use your own API key for deeper analysis.</p>'),o.insightsToggle.style.display="inline-block",o.insightsToggle.textContent="Show more")}catch(e){o.insightsStatus.style.display="none",o.insightsSummary.textContent="Error: "+(e instanceof Error?e.message:String(e)),o.insightsSummary.className="insights-summary error"}finally{o.generateInsightsBtn.disabled=!o.apiKey.value.trim()}}async function $t(){let t=o.apiKey.value.trim();t&&await ct(t)}function st(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/\*(.+?)\*/g,"<em>$1</em>").replace(/`(.+?)`/g,"<code>$1</code>").replace(/^- (.+)$/gm,"<li>$1</li>").replace(/((?:<li>.*<\/li>\n?)+)/g,"<ul>$1</ul>").replace(/\n{2,}/g,"<br><br>").replace(/\n/g,"<br>")}function h(t){o.loadingText.textContent=t,o.loadingSection.style.display="flex"}function m(){o.loadingSection.style.display="none"}function C(t){o.loadingSection.style.display="none",o.errorMessage.textContent=t,o.errorSection.style.display="block",o.errorSection.style.visibility="visible",o.errorSection.style.opacity="1"}document.addEventListener("DOMContentLoaded",()=>{Ut(),k()});window.PortfolioAnalysis={init:k,parseCSV:N,handleFileUpload:at};
