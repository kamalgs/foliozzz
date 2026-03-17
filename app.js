var F,C=new Map;function ht(t){return t.replace(/\//g,"__").replace(/[^A-Za-z0-9._-]/g,"_")}function At(){return F||(F=(async()=>{try{let n=await(await navigator.storage.getDirectory()).getDirectoryHandle("parquet-cache",{create:!0}),i=await(await n.getFileHandle("__probe__",{create:!0})).createWritable();return await i.write(new Uint8Array([0])),await i.close(),await n.removeEntry("__probe__"),n}catch{return null}})()),F}async function bt(t,n){try{let i=await(await t.getFileHandle(n+".meta")).getFile();return JSON.parse(await i.text())}catch{return null}}async function V(t,n){try{return await(await(await t.getFileHandle(n)).getFile()).arrayBuffer()}catch{return null}}function G(t,n,e,i){(async()=>{try{let s=await(await t.getFileHandle(n,{create:!0})).createWritable();await s.write(e),await s.close();let o=await(await t.getFileHandle(n+".meta",{create:!0})).createWritable();await o.write(JSON.stringify(i)),await o.close()}catch(r){console.warn("[opfs-cache] write failed:",r)}})()}async function Tt(t,n){await Promise.all([t.removeEntry(n).catch(()=>{}),t.removeEntry(n+".meta").catch(()=>{})])}async function z(t,n){let e=ht(t),i=C.get(e);if(i)return i;let r=Rt(n,e);return C.set(e,r),r.then(()=>C.delete(e),()=>C.delete(e)),r}async function Rt(t,n){let e=await At();if(!e){let a=await fetch(t);if(!a.ok)throw new Error(`Failed to fetch ${t}: ${a.status}`);return a.arrayBuffer()}let i=await bt(e,n);if(i){let a={};if(i.etag?a["If-None-Match"]=i.etag:i.lastModified&&(a["If-Modified-Since"]=i.lastModified),Object.keys(a).length>0){let o=null,l=null;try{o=await fetch(t,{headers:a})}catch(u){l=u}if(l||o&&o.status>=500){let u=await V(e,n);if(u)return u;throw l||new Error(`Failed to fetch ${t}: ${o.status}`)}if(o.status>=400)throw await Tt(e,n),new Error(`Failed to fetch ${t}: ${o.status}`);if(o.status===304){let u=await V(e,n);if(u)return u}else{let u=await o.arrayBuffer();return G(e,n,u,{etag:o.headers.get("etag")??void 0,lastModified:o.headers.get("last-modified")??void 0}),u}}}let r=await fetch(t);if(!r.ok)throw new Error(`Failed to fetch ${t}: ${r.status}`);let s=await r.arrayBuffer();return G(e,n,s,{etag:r.headers.get("etag")??void 0,lastModified:r.headers.get("last-modified")??void 0}),s}var wt="https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm",L=null,_=null,y=null;async function Ct(){return L||(L=await import(wt),L)}async function j(){if(y)return;let t=await Ct(),n=t.getJsDelivrBundles(),e=await t.selectBundle(n),i=URL.createObjectURL(new Blob([`importScripts("${e.mainWorker}");`],{type:"text/javascript"})),r=new Worker(i),s=new t.ConsoleLogger;_=new t.AsyncDuckDB(s,r),await _.instantiate(e.mainModule,e.pthreadWorker),y=await _.connect()}function J(){return y!==null}async function Lt(t){if(!y)throw new Error("DuckDB not initialized. Call initDuckDB() first.");await y.query(t)}async function P(t){if(!y)throw new Error("DuckDB not initialized. Call initDuckDB() first.");let n=await y.query(t);return Dt(n)}async function D(t,n){if(!_)throw new Error("DuckDB not initialized. Call initDuckDB() first.");let e=await z(t,n);await _.registerFileBuffer(t,new Uint8Array(e))}function O(){return{exec:Lt,query:P}}function Dt(t){let n=[],e=t.schema.fields,i=t.numRows;for(let r=0;r<i;r++){let s={};for(let a of e){let o=t.getChild(a.name);s[a.name]=Ot(o.get(r))}n.push(s)}return n}function Ot(t){if(t==null)return t;if(typeof t=="bigint")return Number(t);if(typeof t=="object"&&t!==null&&!(t instanceof Date)){let n=t;if(typeof n.toString=="function"){let e=n.toString();if(e!==""&&e!=="[object Object]"&&!isNaN(Number(e)))return Number(e)}}return typeof t=="string"&&t!==""&&!isNaN(Number(t))?Number(t):t}var Nt={name:"Groww",delimiter:"	",headerSignature:["isin","execution date"],columns:{isin:"isin",type:"type",quantity:"quantity",value:"value",date:"execution date",status:"status"},acceptStatus:["executed"]},Mt={name:"Generic CSV",delimiter:",",headerSignature:["isin"],columns:{isin:"isin",type:"type",quantity:"quantity",price:"price",value:"value",date:"date",status:"status"},acceptStatus:["executed"]},It=[Nt,Mt];function x(t,n){return t.split(n).map(e=>e.trim())}function Bt(t){let n=t.match(/^(\d{2})-(\d{2})-(\d{4})/);return n?`${n[3]}-${n[2]}-${n[1]}`:/^\d{4}-\d{2}-\d{2}/.test(t)?t.slice(0,10):null}function kt(t){for(let n=0;n<t.length;n++){let e=t[n].toLowerCase();if(!e.includes("isin"))continue;let i=(t[n].match(/\t/g)??[]).length>=2;for(let r of It){if(!(r.delimiter==="	"?i:!i)||!r.headerSignature.every(l=>e.includes(l)))continue;let a=x(t[n],r.delimiter).map(l=>l.toLowerCase()),o=l=>a.some(u=>u.includes(l));if(!(!o(r.columns.isin)||!o(r.columns.quantity)||!o(r.columns.date)))return{config:r,headerIdx:n}}}return null}function Ft(t,n,e){let i=[],r=x(t[e],n.delimiter).map(m=>m.toLowerCase()),s=m=>r.findIndex(R=>R.includes(m)),{columns:a}=n,o=s(a.isin),l=s(a.quantity),u=s(a.date),d=a.type!=null?s(a.type):-1,g=a.price!=null?s(a.price):-1,$=a.value!=null?s(a.value):-1,B=a.status!=null?s(a.status):-1;if(o<0||l<0||u<0)return i;for(let m=e+1;m<t.length;m++){let R=t[m].trim();if(!R)continue;let p=x(R,n.delimiter);if(p.length<3||B>=0&&n.acceptStatus&&p[B]&&!n.acceptStatus.includes(p[B].toLowerCase()))continue;let W=(p[o]??"").toUpperCase();if(!W)continue;let w=parseFloat(p[l]??"");if(!w||w<=0)continue;let Y=Bt(p[u]??"");if(!Y)continue;let _t=(d>=0?(p[d]??"").toUpperCase():"")==="SELL"?"SELL":n.defaultType??"BUY",S;if($>=0&&g<0){let k=parseFloat(p[$]??"");if(!k||k<=0)continue;S=k/w}else if(g>=0){if(S=parseFloat(p[g]??""),!S||S<=0)continue}else continue;i.push({date:Y,isin:W,quantity:w,price:S,type:_t})}return i}function Pt(t){let n=[],e=t[0]?.toLowerCase()??"",r=e.includes("date")||e.includes("symbol")?1:0;for(let s=r;s<t.length;s++){let a=t[s].split(",").map(o=>o.trim());if(a.length>=5){let[o,l,u,d,g]=a;o&&l&&u&&d&&g&&n.push({date:o,isin:l.toUpperCase(),quantity:parseFloat(u),price:parseFloat(d),type:g.toUpperCase()})}else if(a.length>=4){let[o,l,u,d]=a;o&&l&&u&&d&&n.push({date:o,isin:l.toUpperCase(),quantity:parseFloat(u),price:parseFloat(d),type:"BUY"})}}return n}function v(t){let n=t.split(`
`),e=kt(n);return e?Ft(n,e.config,e.headerIdx):Pt(n)}var f=`
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
    )`,Q="DROP TABLE IF EXISTS transactions",K=`
    CREATE TABLE transactions (
        seq INTEGER,
        date DATE,
        isin VARCHAR,
        quantity DOUBLE,
        price DOUBLE,
        type VARCHAR
    )`;function X(t){return`
WITH ${f},

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
FROM raw`}function Z(){return`
WITH ${f}
SELECT isin, cost_basis AS cost_basis, shares
FROM remaining_lots
WHERE shares > 0
ORDER BY isin, cost_basis`}function tt(){return`
WITH ${f}
SELECT
    sell_date::VARCHAR AS date,
    isin,
    matched_qty AS shares_sold,
    sell_price  AS sale_price,
    buy_price   AS cost_basis,
    matched_qty * (sell_price - buy_price) AS pnl
FROM fifo_matches
ORDER BY sell_date, isin, buy_price`}var vt=`
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
    FROM dates`,Ut=`
    CREATE OR REPLACE TABLE dim_stock AS
    SELECT DISTINCT
        isin,
        NULL::VARCHAR AS name,
        NULL::VARCHAR AS sector,
        NULL::VARCHAR AS industry
    FROM transactions`,qt=`
    CREATE OR REPLACE TABLE fact_trades AS
    WITH ${f}
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
    FROM fifo_matches`,Ht=`
    CREATE OR REPLACE TABLE fact_positions AS
    WITH ${f}
    SELECT
        isin,
        date       AS buy_date,
        cost_basis,
        shares     AS quantity,
        shares * cost_basis AS value_at_cost
    FROM remaining_lots
    WHERE shares > 0`,et=[vt,Ut,qt,Ht];function h(t,n="t.sell_date"){if(!t)return"";let e=[];return t.isin&&e.push(`t.isin = '${t.isin}'`),t.sector&&e.push(`s.sector = '${t.sector}'`),t.dateFrom&&e.push(`${n} >= '${t.dateFrom}'`),t.dateTo&&e.push(`${n} <= '${t.dateTo}'`),e.length>0?"WHERE "+e.join(" AND "):""}function nt(t){return`
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
    ${h(t)}
    GROUP BY t.isin, s.name, s.sector
    ORDER BY total_pnl DESC`}function it(t,n){let e={week:"c.year_week",month:"c.year_month",quarter:"c.year_quarter",year:"c.year"}[t];return`
    SELECT
        ${e}                AS period,
        COUNT(*)              AS num_trades,
        SUM(t.pnl)           AS total_pnl,
        SUM(t.proceeds)      AS total_proceeds,
        SUM(t.cost_basis)    AS total_cost
    FROM fact_trades t
    JOIN dim_calendar c ON t.sell_date = c.date
    ${h(n)}
    GROUP BY ${e}
    ORDER BY ${e}`}function rt(t,n,e=5,i){let r={week:"c.year_week",month:"c.year_month",quarter:"c.year_quarter",year:"c.year"}[t],s=n==="best"?"DESC":"ASC";return`
    SELECT
        ${r}                AS period,
        COUNT(*)              AS num_trades,
        SUM(t.pnl)           AS total_pnl
    FROM fact_trades t
    JOIN dim_calendar c ON t.sell_date = c.date
    ${h(i)}
    GROUP BY ${r}
    ORDER BY total_pnl ${s}
    LIMIT ${e}`}function st(){return`
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
    ORDER BY value DESC`}function at(t){return`
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
    ${h(t)}
    GROUP BY COALESCE(s.sector, 'Unknown')
    ORDER BY total_pnl DESC`}function ot(t){return`
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
    ${h(t)}
    ORDER BY t.sell_date DESC, t.pnl DESC`}async function ct(t,n){if(await t.exec(Q),await t.exec(K),n.length===0)return;let e=1e3;for(let i=0;i<n.length;i+=e){let s=n.slice(i,i+e).map((a,o)=>`(${i+o}, '${a.date}', '${a.isin}', ${a.quantity}, ${a.price}, '${a.type}')`).join(", ");await t.exec(`INSERT INTO transactions VALUES ${s}`)}await $t(t)}async function $t(t){for(let n of et)await t.exec(n)}async function lt(t,n){let e=await t.query(X(n));if(e.length===0||e[0].first_date==null)return null;let i=e[0],r=await Wt(t),s=await Yt(t);return{totalInvested:Number(i.total_invested),totalProceeds:Number(i.total_proceeds),realizedPnL:Number(i.realized_pnl),costBasisRemaining:Number(i.cost_basis_remaining),cashBalance:Number(i.cash_balance),portfolioValue:Number(i.portfolio_value),totalReturn:Number(i.total_return),totalReturnPct:Number(i.total_return_pct),numStocks:Number(i.num_stocks),holdingDays:Number(i.holding_days),holdingYears:Number(i.holding_years),annualizedReturnPct:Number(i.annualized_return_pct),firstDate:String(i.first_date),lastDate:String(i.last_date),holdings:r,sellDetails:s}}async function Wt(t){return(await t.query(Z())).map(e=>({isin:String(e.isin),shares:Number(e.shares),costBasis:Number(e.cost_basis)}))}async function Yt(t){return(await t.query(tt())).map(e=>({date:String(e.date),isin:String(e.isin),sharesSold:Number(e.shares_sold),salePrice:Number(e.sale_price),costBasis:Number(e.cost_basis),pnl:Number(e.pnl)}))}var A={isin:{type:"string",description:"Filter by ISIN (e.g. INE002A01018)"},sector:{type:"string",description:"Filter by sector"},dateFrom:{type:"string",description:"Start date (YYYY-MM-DD)"},dateTo:{type:"string",description:"End date (YYYY-MM-DD)"}},Vt=[{type:"function",function:{name:"pnl_by_stock",description:"Get realized PnL breakdown by stock. Shows total PnL, return %, trade count, and avg holding days per ISIN.",parameters:{type:"object",properties:A,required:[]}}},{type:"function",function:{name:"pnl_by_period",description:"Get realized PnL aggregated by time period. Choose granularity: week, month, quarter, or year.",parameters:{type:"object",properties:{granularity:{type:"string",enum:["week","month","quarter","year"],description:"Time granularity"},...A},required:["granularity"]}}},{type:"function",function:{name:"top_periods",description:"Get the best or worst performing periods by PnL.",parameters:{type:"object",properties:{granularity:{type:"string",enum:["week","month","quarter","year"]},direction:{type:"string",enum:["best","worst"]},limit:{type:"number",description:"Number of periods to return (default 5)"},...A},required:["granularity","direction"]}}},{type:"function",function:{name:"holdings_concentration",description:"Get current portfolio holdings with concentration weights (% of total value).",parameters:{type:"object",properties:{},required:[]}}},{type:"function",function:{name:"pnl_by_sector",description:"Get realized PnL aggregated by sector.",parameters:{type:"object",properties:A,required:[]}}},{type:"function",function:{name:"trade_detail",description:"Get individual FIFO-matched trade details with buy/sell dates, prices, PnL, and holding days.",parameters:{type:"object",properties:A,required:[]}}},{type:"function",function:{name:"run_sql",description:"Run arbitrary read-only SQL against the portfolio database. Available tables: transactions (seq, date, isin, quantity, price, type), fact_trades (trade_id, isin, buy_date, sell_date, buy_price, sell_price, quantity, cost_basis, proceeds, pnl, return_pct, holding_days), fact_positions (isin, buy_date, cost_basis, quantity, value_at_cost), dim_calendar (date, year, quarter, month, week, year_month, year_week, year_quarter), dim_stock (isin, name, sector, industry).",parameters:{type:"object",properties:{sql:{type:"string",description:"SQL SELECT query to execute"}},required:["sql"]}}}];function b(t){let n={};return typeof t.isin=="string"&&(n.isin=t.isin),typeof t.sector=="string"&&(n.sector=t.sector),typeof t.dateFrom=="string"&&(n.dateFrom=t.dateFrom),typeof t.dateTo=="string"&&(n.dateTo=t.dateTo),Object.keys(n).length>0?n:void 0}async function Gt(t,n,e){let i;switch(n){case"pnl_by_stock":i=nt(b(e));break;case"pnl_by_period":i=it(e.granularity,b(e));break;case"top_periods":i=rt(e.granularity,e.direction,typeof e.limit=="number"?e.limit:5,b(e));break;case"holdings_concentration":i=st();break;case"pnl_by_sector":i=at(b(e));break;case"trade_detail":i=ot(b(e));break;case"run_sql":{let a=String(e.sql).trim();if(!a.toUpperCase().startsWith("SELECT"))return JSON.stringify({error:"Only SELECT queries are allowed"});i=a;break}default:return JSON.stringify({error:`Unknown tool: ${n}`})}let r=await t.query(i),s=JSON.stringify(r);if(s.length>8e3){let a=r.slice(0,20);return JSON.stringify({rows:a,note:`Showing 20 of ${r.length} rows. Use filters to narrow results.`})}return s}var U="__OPENROUTER_API_KEY__",zt=["stepfun/step-3.5-flash:free","meta-llama/llama-3.3-70b-instruct:free"],jt="anthropic/claude-sonnet-4";function ut(){return U.length>0&&!U.startsWith("__OPENROUTER_")}var Jt=`You are an expert portfolio analyst. Analyze the user's stock trading data using the available tools.

**Process:**
1. First call pnl_by_stock and holdings_concentration to get the full picture.
2. Then drill into one or two specifics (e.g. trade_detail for notable trades, top_periods for timing patterns).
3. Only state findings you can back with data from tool results. Never speculate or infer beyond what the data shows.

**Output rules:**
- Exactly 3-5 bullet points. No preamble, no summary header, no closing remarks.
- Each bullet must cite a specific number (\u20B9 amount, %, count, or date).
- Focus on: concentration risk, realized gains/losses, cost basis efficiency, and holding period patterns.
- Skip obvious observations (e.g. "you bought stocks"). Surface what the investor might not notice themselves.
- Use \u20B9 for currency. Keep each bullet to 1-2 sentences max.`,Qt=8;async function dt(t,n,e){let i=n.apiKey||U,r=n.model?[n.model]:n.apiKey?[jt]:zt;if(!i||i.startsWith("__OPENROUTER_"))throw new Error("No API key configured. Please enter your OpenRouter API key.");let s=[{role:"system",content:Jt},{role:"user",content:"Analyze my portfolio and provide key insights."}];for(let a=0;a<Qt;a++){e?.(`Thinking... (step ${a+1})`);let o=await Kt(i,r,s);if(!o.tool_calls||o.tool_calls.length===0)return o.content||"No insights generated.";s.push({role:"assistant",content:o.content,tool_calls:o.tool_calls});for(let l of o.tool_calls){e?.(`Querying: ${l.function.name}...`);let u;try{let d=JSON.parse(l.function.arguments);u=await Gt(t,l.function.name,d)}catch(d){u=JSON.stringify({error:String(d)})}s.push({role:"tool",tool_call_id:l.id,content:u})}}return"Analysis incomplete \u2014 reached maximum exploration steps."}async function Kt(t,n,e){let i=null;for(let r of n)try{return await Xt(t,r,e)}catch(s){if(i=s instanceof Error?s:new Error(String(s)),!/429|404|403/.test(i.message))throw i}throw i||new Error("All models failed")}async function Xt(t,n,e){for(let r=0;r<3;r++){let s=await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${t}`,"Content-Type":"application/json"},body:JSON.stringify({model:n,messages:e,tools:Vt,max_tokens:1024})});if(s.status===429&&r<2){await new Promise(l=>setTimeout(l,3e3*(r+1)));continue}if(!s.ok){let l=await s.text();throw new Error(`API error ${s.status}: ${l}`)}let o=(await s.json()).choices?.[0]?.message;if(!o)throw new Error("No response from LLM");return{content:o.content??null,tool_calls:o.tool_calls}}throw new Error("Max retries exceeded")}var N=null;async function Zt(){if(N)return N;let t=await fetch("data/isin_map.json");if(!t.ok)throw new Error("Failed to load ISIN map");return N=await t.json(),N}async function te(t,n){await t.exec("DROP TABLE IF EXISTS stock_prices"),await t.exec("CREATE TABLE stock_prices (date DATE, symbol VARCHAR, isin VARCHAR, close DOUBLE)");let e=await t.query("SELECT DISTINCT isin FROM transactions");for(let i of e){let r=String(i.isin),s=n[r];if(!s)continue;let a=`${s}.parquet`;try{await D(`stock_prices/${a}`,`data/stock_prices/${a}`),await t.exec(`
                INSERT INTO stock_prices
                SELECT date, symbol, '${r}' as isin, close
                FROM parquet_scan('stock_prices/${a}')
                WHERE close IS NOT NULL
            `)}catch{}}}var ee=t=>`
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
`;async function pt(t,n){let e=await Zt();return await te(t,e),(await t.query(ee(n))).map(r=>{let s=r.date,a;return typeof s=="number"?a=s:s instanceof Date?a=s.getTime():a=new Date(String(s)).getTime(),{date:a,value:Number(r.portfolio_value)||0,cash:Number(r.cash)||0,returnPct:Number(r.return_pct)||0}})}var mt={dataPath:"data",benchmarks:{nifty50:"nifty50.parquet",bank_nifty:"bank_nifty.parquet",sensex:"sensex.parquet",nifty_midcap:"nifty_midcap.parquet",bse_500:"bse_500.parquet"}},q=null,I=null,yt=1e5,c={csvInput:document.getElementById("csvInput"),benchmarkSelect:document.getElementById("benchmarkSelect"),loadingSection:document.getElementById("loadingSection"),loadingText:document.getElementById("loadingText"),errorSection:document.getElementById("errorSection"),errorMessage:document.getElementById("errorMessage"),retryBtn:document.getElementById("retryBtn"),uploadSection:document.getElementById("uploadSection"),changeFileBtn:document.getElementById("changeFile"),insightsSection:document.getElementById("insightsSection"),insightsSummary:document.getElementById("insightsSummary"),insightsFull:document.getElementById("insightsFull"),insightsToggle:document.getElementById("insightsToggle"),apiKey:document.getElementById("apiKey"),generateInsightsBtn:document.getElementById("generateInsights"),insightsStatus:document.getElementById("insightsStatus")};async function H(){T("Initializing DuckDB...");try{await j(),E()}catch(t){E(),M("Failed to initialize DuckDB: "+(t instanceof Error?t.message:String(t)))}}function ne(){c.csvInput.addEventListener("change",gt),c.retryBtn.addEventListener("click",()=>{c.errorSection.style.display="none",H()}),c.benchmarkSelect.addEventListener("change",async()=>{I&&await ft()}),c.apiKey.addEventListener("input",()=>{c.generateInsightsBtn.disabled=!c.apiKey.value.trim()}),c.generateInsightsBtn.addEventListener("click",ae),c.insightsToggle.addEventListener("click",()=>{let t=c.insightsFull.style.display!=="none";c.insightsFull.style.display=t?"none":"block",c.insightsToggle.textContent=t?"Show more":"Show less"}),c.changeFileBtn.addEventListener("click",()=>{c.insightsSection.style.display="none",c.uploadSection.style.display="block",c.csvInput.value=""})}async function gt(t){let e=t.target.files?.[0];if(e){T("Parsing transactions...");try{let i=await e.text(),r=v(i);if(r.length===0)throw new Error("No valid transactions found in CSV");if(r.sort((s,a)=>new Date(s.date).getTime()-new Date(a.date).getTime()),!J())throw new Error("Database not initialized. Please refresh the page and try again.");if(I=r,await ct(O(),r),await ft(),E(),ut())St();else{let s=document.querySelector(".insights-upgrade");s&&(s.open=!0)}}catch(i){E(),M("Error processing CSV: "+(i instanceof Error?i.message:String(i)))}}}async function ft(){if(I){T("Analyzing portfolio...");try{let t=O(),n=await lt(t,yt);if(!n){M("No portfolio data available for analysis"),E();return}T("Loading stock prices...");let e=await pt(t,yt);T("Loading benchmark...");let i=await ie(c.benchmarkSelect.value,e.length>0?e[0].date:0,e.length>0?e[e.length-1].date:0);re(n,e,i),c.uploadSection.style.display="none",c.insightsSection.style.display="block",E()}catch(t){E(),M("Analysis error: "+(t instanceof Error?t.message:String(t)))}}}async function ie(t,n,e){if(!n||!e)return[];let i=mt.benchmarks[t];try{await D(i,`${mt.dataPath}/${i}`);let r=new Date(n).toISOString().slice(0,10),s=new Date(e).toISOString().slice(0,10);return(await P(`
            WITH base AS (
                SELECT date, close
                FROM parquet_scan('${i}')
                WHERE date IS NOT NULL AND close IS NOT NULL
                  AND date >= '${r}' AND date <= '${s}'
                ORDER BY date
            ),
            first_close AS (
                SELECT close AS c0 FROM base LIMIT 1
            )
            SELECT b.date, ((b.close - fc.c0) / fc.c0) * 100 AS return_pct
            FROM base b, first_close fc
            ORDER BY b.date
        `)).map(o=>{let l=o.date,u;return typeof l=="number"?u=l:l instanceof Date?u=l.getTime():u=new Date(String(l)).getTime(),{x:u,y:Number(o.return_pct)||0}})}catch(r){return console.warn(`Could not load benchmark data for ${t}:`,r.message),[]}}function re(t,n,e){let i=o=>document.getElementById(o),r=i("totalReturn");r.textContent=`${t.totalReturn>=0?"+":""}${t.totalReturnPct.toFixed(2)}%`,r.className="stat-value "+(t.totalReturn>=0?"positive":"negative");let s=i("annualizedReturn");s.textContent=`${t.annualizedReturnPct>=0?"+":""}${t.annualizedReturnPct.toFixed(2)}%`,s.className="stat-value "+(t.annualizedReturnPct>=0?"positive":"negative"),i("portfolioValue").textContent=`\u20B9${t.portfolioValue.toLocaleString("en-IN")}`,i("holdingPeriod").textContent=`${t.holdingDays} days (${t.holdingYears.toFixed(1)} years)`;let a=i("pnlGrid");if(t.realizedPnL!==0){a.style.display="grid";let o=i("totalRealizedPnL");o.textContent=`${t.realizedPnL>=0?"+":""}\u20B9${t.realizedPnL.toLocaleString("en-IN")}`,o.className="stat-value "+(t.realizedPnL>=0?"positive":"negative"),i("totalUnrealizedGain").textContent="-",i("fifoCostBasis").textContent=`\u20B9${t.costBasisRemaining.toLocaleString("en-IN")}`,i("stocksCount").textContent=`${t.numStocks}`}else a.style.display="none";se(n,e)}function se(t,n){let e=document.getElementById("returnsChart").getContext("2d"),i=t.map(r=>({x:r.date,y:r.returnPct}));q&&q.destroy(),q=new Chart(e,{type:"line",data:{datasets:[{label:"Portfolio",data:i,borderColor:"#5367ff",backgroundColor:"rgba(83, 103, 255, 0.08)",borderWidth:2,pointRadius:0,fill:!0,tension:.1},{label:c.benchmarkSelect.options[c.benchmarkSelect.selectedIndex].text,data:n,borderColor:"#00d09c",borderWidth:2,pointRadius:0,fill:!1,tension:.1}]},options:{responsive:!0,maintainAspectRatio:!1,interaction:{mode:"nearest",intersect:!1,axis:"x"},plugins:{legend:{position:"top",labels:{color:"#44475b",font:{size:12}}},tooltip:{backgroundColor:"#fff",titleColor:"#44475b",bodyColor:"#7c7e8c",borderColor:"#e8e8eb",borderWidth:1,callbacks:{label:r=>r.dataset.label+": "+r.parsed.y.toFixed(2)+"%"}}},scales:{x:{type:"time",time:{unit:"month",displayFormats:{month:"MMM yyyy"}},grid:{color:"#f0f0f3"},ticks:{color:"#9b9dab",maxTicksLimit:10}},y:{grid:{color:"#f0f0f3"},ticks:{color:"#9b9dab",callback:r=>r+"%"},border:{color:"#e8e8eb"}}}}})}async function St(t){if(!I)return;c.generateInsightsBtn.disabled=!0,c.insightsStatus.style.display="block",c.insightsSummary.textContent="",c.insightsSummary.className="insights-summary",c.insightsFull.style.display="none",c.insightsToggle.style.display="none";let n=!!t;try{let e=await dt(O(),t?{apiKey:t}:{},a=>{c.insightsStatus.textContent=a});c.insightsStatus.style.display="none";let i=e.split(`
`).filter(a=>a.trim().startsWith("-")),r=i.slice(0,2).join(`
`),s=i.slice(2).join(`
`);c.insightsSummary.innerHTML=Et(r),s.trim()&&(c.insightsFull.innerHTML=Et(s)+(n?"":'<p class="insights-tier-note">Free model. Use your own API key for deeper analysis.</p>'),c.insightsToggle.style.display="inline-block",c.insightsToggle.textContent="Show more")}catch(e){c.insightsStatus.style.display="none",c.insightsSummary.textContent="Error: "+(e instanceof Error?e.message:String(e)),c.insightsSummary.className="insights-summary error"}finally{c.generateInsightsBtn.disabled=!c.apiKey.value.trim()}}async function ae(){let t=c.apiKey.value.trim();t&&await St(t)}function Et(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/\*(.+?)\*/g,"<em>$1</em>").replace(/`(.+?)`/g,"<code>$1</code>").replace(/^- (.+)$/gm,"<li>$1</li>").replace(/((?:<li>.*<\/li>\n?)+)/g,"<ul>$1</ul>").replace(/\n{2,}/g,"<br><br>").replace(/\n/g,"<br>")}function T(t){c.loadingText.textContent=t,c.loadingSection.style.display="flex"}function E(){c.loadingSection.style.display="none"}function M(t){c.loadingSection.style.display="none",c.errorMessage.textContent=t,c.errorSection.style.display="block",c.errorSection.style.visibility="visible",c.errorSection.style.opacity="1"}document.addEventListener("DOMContentLoaded",()=>{ne(),H()});window.PortfolioAnalysis={init:H,parseCSV:v,handleFileUpload:gt};
