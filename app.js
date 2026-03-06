var $="https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm",m=null,R=null,u=null;async function Y(){return m||(m=await import($),m)}async function h(){if(u)return;let t=await Y(),r=t.getJsDelivrBundles(),n=await t.selectBundle(r),e=URL.createObjectURL(new Blob([`importScripts("${n.mainWorker}");`],{type:"text/javascript"})),s=new Worker(e),a=new t.ConsoleLogger;R=new t.AsyncDuckDB(a,s),await R.instantiate(n.mainModule,n.pthreadWorker),u=await R.connect()}function O(){return u!==null}async function V(t){if(!u)throw new Error("DuckDB not initialized. Call initDuckDB() first.");await u.query(t)}async function A(t){if(!u)throw new Error("DuckDB not initialized. Call initDuckDB() first.");let r=await u.query(t);return W(r)}function f(){return{exec:V,query:A}}function W(t){let r=[],n=t.schema.fields,e=t.numRows;for(let s=0;s<e;s++){let a={};for(let i of n){let o=t.getChild(i.name);a[i.name]=z(o.get(s))}r.push(a)}return r}function z(t){if(t==null)return t;if(typeof t=="bigint")return Number(t);if(typeof t=="object"&&t!==null&&!(t instanceof Date)){let r=t;if(typeof r.toString=="function"){let n=r.toString();if(n!==""&&n!=="[object Object]"&&!isNaN(Number(n)))return Number(n)}}return typeof t=="string"&&t!==""&&!isNaN(Number(t))?Number(t):t}function g(t){let r=t.trim().split(`
`),n=[],e=r[0].toLowerCase(),a=e.includes("date")||e.includes("isin")?1:0;for(let i=a;i<r.length;i++){let o=r[i].split(",").map(l=>l.trim());if(o.length>=5){let[l,S,_,p,L]=o;l&&S&&_&&p&&L&&n.push({date:l,isin:S.toUpperCase(),quantity:parseFloat(_),price:parseFloat(p),type:L.toUpperCase()})}else if(o.length>=4){let[l,S,_,p]=o;l&&S&&_&&p&&n.push({date:l,isin:S.toUpperCase(),quantity:parseFloat(_),price:parseFloat(p),type:"BUY"})}}return n}var d=`
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
    )`,B="DROP TABLE IF EXISTS transactions",N=`
    CREATE TABLE transactions (
        seq INTEGER,
        date DATE,
        isin VARCHAR,
        quantity DOUBLE,
        price DOUBLE,
        type VARCHAR
    )`;function w(t){return`
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
FROM raw`}function M(t){return`
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
ORDER BY date`}function k(){return`
WITH ${d}
SELECT isin, cost_basis AS cost_basis, shares
FROM remaining_lots
WHERE shares > 0
ORDER BY isin, cost_basis`}function I(){return`
WITH ${d}
SELECT
    sell_date::VARCHAR AS date,
    isin,
    matched_qty AS shares_sold,
    sell_price  AS sale_price,
    buy_price   AS cost_basis,
    matched_qty * (sell_price - buy_price) AS pnl
FROM fifo_matches
ORDER BY sell_date, isin, buy_price`}var Q=`
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
    ) AS t(d)`,X=`
    CREATE OR REPLACE TABLE dim_stock AS
    SELECT DISTINCT
        isin,
        NULL::VARCHAR AS name,
        NULL::VARCHAR AS sector,
        NULL::VARCHAR AS industry
    FROM transactions`,J=`
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
    FROM fifo_matches`,j=`
    CREATE OR REPLACE TABLE fact_positions AS
    WITH ${d}
    SELECT
        isin,
        date       AS buy_date,
        cost_basis,
        shares     AS quantity,
        shares * cost_basis AS value_at_cost
    FROM remaining_lots
    WHERE shares > 0`,F=[Q,X,J,j];async function P(t,r){if(await t.exec(B),await t.exec(N),r.length===0)return;let n=1e3;for(let e=0;e<r.length;e+=n){let a=r.slice(e,e+n).map((i,o)=>`(${e+o}, '${i.date}', '${i.isin}', ${i.quantity}, ${i.price}, '${i.type}')`).join(", ");await t.exec(`INSERT INTO transactions VALUES ${a}`)}await Z(t)}async function Z(t){for(let r of F)await t.exec(r)}async function U(t,r){let n=await t.query(w(r));if(n.length===0||n[0].first_date==null)return null;let e=n[0],s=await K(t),a=await tt(t);return{totalInvested:Number(e.total_invested),totalProceeds:Number(e.total_proceeds),realizedPnL:Number(e.realized_pnl),costBasisRemaining:Number(e.cost_basis_remaining),cashBalance:Number(e.cash_balance),portfolioValue:Number(e.portfolio_value),totalReturn:Number(e.total_return),totalReturnPct:Number(e.total_return_pct),numStocks:Number(e.num_stocks),holdingDays:Number(e.holding_days),holdingYears:Number(e.holding_years),annualizedReturnPct:Number(e.annualized_return_pct),firstDate:String(e.first_date),lastDate:String(e.last_date),holdings:s,sellDetails:a}}async function x(t,r){return(await t.query(M(r))).map(e=>({date:String(e.date),cash:Number(e.cash),holdingsCost:Number(e.holdings_cost),portfolioValue:Number(e.portfolio_value),returnPct:Number(e.return_pct)}))}async function K(t){return(await t.query(k())).map(n=>({isin:String(n.isin),shares:Number(n.shares),costBasis:Number(n.cost_basis)}))}async function tt(t){return(await t.query(I())).map(n=>({date:String(n.date),isin:String(n.isin),sharesSold:Number(n.shares_sold),salePrice:Number(n.sale_price),costBasis:Number(n.cost_basis),pnl:Number(n.pnl)}))}var q={dataPath:"data",benchmarks:{nifty50:"nifty50.parquet",bank_nifty:"bank_nifty.parquet",sensex:"sensex.parquet",nifty_midcap:"nifty_midcap.parquet",bse_500:"bse_500.parquet"}},b=null,T=null,c={csvInput:document.getElementById("csvInput"),benchmarkSelect:document.getElementById("benchmarkSelect"),initialCapital:document.getElementById("initialCapital"),loadingSection:document.getElementById("loadingSection"),loadingText:document.getElementById("loadingText"),errorSection:document.getElementById("errorSection"),errorMessage:document.getElementById("errorMessage"),retryBtn:document.getElementById("retryBtn")};async function C(){D("Initializing DuckDB...");try{await h(),E()}catch(t){E(),y("Failed to initialize DuckDB: "+(t instanceof Error?t.message:String(t)))}}function et(){c.csvInput.addEventListener("change",v),c.retryBtn.addEventListener("click",()=>{c.errorSection.style.display="none",C()}),c.benchmarkSelect.addEventListener("change",async()=>{T&&await H()})}async function v(t){let n=t.target.files?.[0];if(n){D("Parsing transactions...");try{let e=await n.text(),s=g(e);if(s.length===0)throw new Error("No valid transactions found in CSV");if(s.sort((a,i)=>new Date(a.date).getTime()-new Date(i.date).getTime()),!O())throw new Error("Database not initialized. Please refresh the page and try again.");T=s,await P(f(),s),await H(),E()}catch(e){E(),y("Error processing CSV: "+(e instanceof Error?e.message:String(e)))}}}async function H(){if(T){D("Analyzing portfolio...");try{let t=parseFloat(c.initialCapital.value)||1e5,r=f(),n=await U(r,t);if(!n){y("No portfolio data available for analysis"),E();return}let e=await x(r,t),s=await nt(c.benchmarkSelect.value);rt(n,e,s),E()}catch(t){E(),y("Analysis error: "+(t instanceof Error?t.message:String(t)))}}}async function nt(t){let r=q.benchmarks[t];try{return(await A(`
            SELECT
                date,
                close_price,
                (close_price - LAG(close_price) OVER (ORDER BY date)) /
                    NULLIF(LAG(close_price) OVER (ORDER BY date), 0) * 100 as daily_return_pct,
                SUM((close_price - LAG(close_price) OVER (ORDER BY date)) /
                    NULLIF(LAG(close_price) OVER (ORDER BY date), 0)) OVER (ORDER BY date) * 100 as cumulative_return_pct
            FROM parquet_scan('${q.dataPath}/${r}')
            WHERE date IS NOT NULL AND close_price IS NOT NULL
            ORDER BY date
        `)).map(e=>({date:e.date,closePrice:Number(e.close_price)||0,cumulativeReturnPct:Number(e.cumulative_return_pct)||0}))}catch(n){return console.warn(`Could not load benchmark data for ${t}:`,n.message),[]}}function rt(t,r,n){let e=o=>document.getElementById(o),s=e("totalReturn");s.textContent=`${t.totalReturn>=0?"+":""}${t.totalReturnPct.toFixed(2)}%`,s.className="stat-value "+(t.totalReturn>=0?"positive":"negative");let a=e("annualizedReturn");a.textContent=`${t.annualizedReturnPct>=0?"+":""}${t.annualizedReturnPct.toFixed(2)}%`,a.className="stat-value "+(t.annualizedReturnPct>=0?"positive":"negative"),e("portfolioValue").textContent=`\u20B9${t.portfolioValue.toLocaleString("en-IN")}`,e("holdingPeriod").textContent=`${t.holdingDays} days (${t.holdingYears.toFixed(1)} years)`;let i=e("pnlGrid");if(t.realizedPnL!==0){i.style.display="grid";let o=e("totalRealizedPnL");o.textContent=`${t.realizedPnL>=0?"+":""}\u20B9${t.realizedPnL.toLocaleString("en-IN")}`,o.className="stat-value "+(t.realizedPnL>=0?"positive":"negative"),e("totalUnrealizedGain").textContent="-",e("fifoCostBasis").textContent=`\u20B9${t.costBasisRemaining.toLocaleString("en-IN")}`,e("stocksCount").textContent=`${t.numStocks}`}else i.style.display="none";it(r,n)}function it(t,r){let n=document.getElementById("returnsChart").getContext("2d"),e=t.map(i=>i.date),s=t.map(i=>i.returnPct),a;if(r.length>0){let i=new Set(t.map(o=>String(o.date)));a=r.filter(o=>i.has(String(o.date))).map(o=>o.cumulativeReturnPct)}else a=t.map(()=>0);b&&b.destroy(),b=new Chart(n,{type:"line",data:{labels:e.slice(0,100),datasets:[{label:"Portfolio",data:s.slice(0,100),borderColor:"#4facfe",backgroundColor:"rgba(79, 172, 254, 0.1)",borderWidth:2,pointRadius:2,fill:!0,tension:.1},{label:"Benchmark ("+c.benchmarkSelect.options[c.benchmarkSelect.selectedIndex].text+")",data:a.slice(0,100),borderColor:"#4caf50",borderWidth:2,pointRadius:2,fill:!1,tension:.1}]},options:{responsive:!0,maintainAspectRatio:!1,interaction:{mode:"index",intersect:!1},plugins:{legend:{position:"top",labels:{color:"#e0e0e0",font:{size:12}}},tooltip:{backgroundColor:"rgba(0,0,0,0.8)",titleColor:"#fff",bodyColor:"#e0e0e0",borderColor:"rgba(255,255,255,0.1)",borderWidth:1,callbacks:{label:i=>i.dataset.label+": "+i.parsed.y.toFixed(2)+"%"}},title:{display:!0,text:"Cumulative Returns Comparison",color:"#fff",font:{size:14}}},scales:{x:{grid:{color:"rgba(255,255,255,0.05)"},ticks:{color:"#888",maxTicksLimit:10}},y:{grid:{color:"rgba(255,255,255,0.05)"},ticks:{color:"#888",callback:i=>i+"%"},border:{color:"rgba(255,255,255,0.1)"}}}}})}function D(t){c.loadingText.textContent=t,c.loadingSection.style.display="flex"}function E(){c.loadingSection.style.display="none"}function y(t){c.loadingSection.style.display="none",c.errorMessage.textContent=t,c.errorSection.style.display="block",c.errorSection.style.visibility="visible",c.errorSection.style.opacity="1"}document.addEventListener("DOMContentLoaded",()=>{et(),C()});window.PortfolioAnalysis={init:C,parseCSV:g,handleFileUpload:v};
