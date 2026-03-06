var F="https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm",S=null,_=null,u=null;async function $(){return S||(S=await import(F),S)}async function w(){if(u)return;let e=await $(),r=e.getJsDelivrBundles(),n=await e.selectBundle(r),t=URL.createObjectURL(new Blob([`importScripts("${n.mainWorker}");`],{type:"text/javascript"})),o=new Worker(t),a=new e.ConsoleLogger;_=new e.AsyncDuckDB(a,o),await _.instantiate(n.mainModule,n.pthreadWorker),u=await _.connect()}function L(){return u!==null}async function z(e){if(!u)throw new Error("DuckDB not initialized. Call initDuckDB() first.");await u.query(e)}async function g(e){if(!u)throw new Error("DuckDB not initialized. Call initDuckDB() first.");let r=await u.query(e);return W(r)}function b(){return{exec:z,query:g}}function W(e){let r=[],n=e.schema.fields,t=e.numRows;for(let o=0;o<t;o++){let a={};for(let i of n){let s=e.getChild(i.name);a[i.name]=V(s.get(o))}r.push(a)}return r}function V(e){if(e==null)return e;if(typeof e=="bigint")return Number(e);if(typeof e=="object"&&e!==null&&!(e instanceof Date)){let r=e;if(typeof r.toString=="function"){let n=r.toString();if(n!==""&&n!=="[object Object]"&&!isNaN(Number(n)))return Number(n)}}return typeof e=="string"&&e!==""&&!isNaN(Number(e))?Number(e):e}function R(e){let r=e.trim().split(`
`),n=[],t=r[0].toLowerCase(),a=t.includes("date")||t.includes("isin")?1:0;for(let i=a;i<r.length;i++){let s=r[i].split(",").map(c=>c.trim());if(s.length>=5){let[c,m,p,E,C]=s;c&&m&&p&&E&&C&&n.push({date:c,isin:m.toUpperCase(),quantity:parseFloat(p),price:parseFloat(E),type:C.toUpperCase()})}else if(s.length>=4){let[c,m,p,E]=s;c&&m&&p&&E&&n.push({date:c,isin:m.toUpperCase(),quantity:parseFloat(p),price:parseFloat(E),type:"BUY"})}}return n}var f=`
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
    )`,T="DROP TABLE IF EXISTS transactions",N=`
    CREATE TABLE transactions (
        seq INTEGER,
        date DATE,
        isin VARCHAR,
        quantity DOUBLE,
        price DOUBLE,
        type VARCHAR
    )`;function k(e){return`
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
    ${e} - total_invested + total_proceeds AS cash_balance,
    ${e} - total_invested + total_proceeds + cost_basis_remaining AS portfolio_value,
    realized_pnl AS total_return,
    CASE WHEN ${e} > 0
        THEN realized_pnl * 100.0 / ${e}
        ELSE 0
    END AS total_return_pct,
    holding_days / 365.0 AS holding_years,
    CASE WHEN holding_days > 0
        THEN (POWER((${e} + realized_pnl) * 1.0 / ${e},
                     365.0 / holding_days) - 1) * 100
        ELSE 0
    END AS annualized_return_pct
FROM raw`}function O(e){return`
WITH ${f},

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
    ${e} + SUM(sell_proceeds - buy_cost) OVER w AS cash,
    SUM(buy_cost - cost_sold) OVER w AS holdings_cost,
    ${e} + SUM(sell_proceeds - buy_cost) OVER w
           + SUM(buy_cost - cost_sold) OVER w AS portfolio_value,
    CASE WHEN ${e} > 0
        THEN (SUM(sell_proceeds - buy_cost) OVER w
            + SUM(buy_cost - cost_sold) OVER w) * 100.0 / ${e}
        ELSE 0
    END AS return_pct
FROM date_flows
WINDOW w AS (ORDER BY date ROWS UNBOUNDED PRECEDING)
ORDER BY date`}function I(){return`
WITH ${f}
SELECT isin, cost_basis AS cost_basis, shares
FROM remaining_lots
WHERE shares > 0
ORDER BY isin, cost_basis`}function P(){return`
WITH ${f}
SELECT
    sell_date::VARCHAR AS date,
    isin,
    matched_qty AS shares_sold,
    sell_price  AS sale_price,
    buy_price   AS cost_basis,
    matched_qty * (sell_price - buy_price) AS pnl
FROM fifo_matches
ORDER BY sell_date, isin, buy_price`}async function M(e,r){if(await e.exec(T),await e.exec(N),r.length===0)return;let n=1e3;for(let t=0;t<r.length;t+=n){let a=r.slice(t,t+n).map((i,s)=>`(${t+s}, '${i.date}', '${i.isin}', ${i.quantity}, ${i.price}, '${i.type}')`).join(", ");await e.exec(`INSERT INTO transactions VALUES ${a}`)}}async function x(e,r){let n=await e.query(k(r));if(n.length===0||n[0].first_date==null)return null;let t=n[0],o=await Q(e),a=await G(e);return{totalInvested:Number(t.total_invested),totalProceeds:Number(t.total_proceeds),realizedPnL:Number(t.realized_pnl),costBasisRemaining:Number(t.cost_basis_remaining),cashBalance:Number(t.cash_balance),portfolioValue:Number(t.portfolio_value),totalReturn:Number(t.total_return),totalReturnPct:Number(t.total_return_pct),numStocks:Number(t.num_stocks),holdingDays:Number(t.holding_days),holdingYears:Number(t.holding_years),annualizedReturnPct:Number(t.annualized_return_pct),firstDate:String(t.first_date),lastDate:String(t.last_date),holdings:o,sellDetails:a}}async function v(e,r){return(await e.query(O(r))).map(t=>({date:String(t.date),cash:Number(t.cash),holdingsCost:Number(t.holdings_cost),portfolioValue:Number(t.portfolio_value),returnPct:Number(t.return_pct)}))}async function Q(e){return(await e.query(I())).map(n=>({isin:String(n.isin),shares:Number(n.shares),costBasis:Number(n.cost_basis)}))}async function G(e){return(await e.query(P())).map(n=>({date:String(n.date),isin:String(n.isin),sharesSold:Number(n.shares_sold),salePrice:Number(n.sale_price),costBasis:Number(n.cost_basis),pnl:Number(n.pnl)}))}var H={dataPath:"data",benchmarks:{nifty50:"nifty50.parquet",bank_nifty:"bank_nifty.parquet",sensex:"sensex.parquet",nifty_midcap:"nifty_midcap.parquet",bse_500:"bse_500.parquet"}},D=null,A=null,l={csvInput:document.getElementById("csvInput"),benchmarkSelect:document.getElementById("benchmarkSelect"),initialCapital:document.getElementById("initialCapital"),loadingSection:document.getElementById("loadingSection"),loadingText:document.getElementById("loadingText"),errorSection:document.getElementById("errorSection"),errorMessage:document.getElementById("errorMessage"),retryBtn:document.getElementById("retryBtn")};async function h(){B("Initializing DuckDB...");try{await w(),d()}catch(e){d(),y("Failed to initialize DuckDB: "+(e instanceof Error?e.message:String(e)))}}function j(){l.csvInput.addEventListener("change",U),l.retryBtn.addEventListener("click",()=>{l.errorSection.style.display="none",h()}),l.benchmarkSelect.addEventListener("change",async()=>{A&&await q()})}async function U(e){let n=e.target.files?.[0];if(n){B("Parsing transactions...");try{let t=await n.text(),o=R(t);if(o.length===0)throw new Error("No valid transactions found in CSV");if(o.sort((a,i)=>new Date(a.date).getTime()-new Date(i.date).getTime()),!L())throw new Error("Database not initialized. Please refresh the page and try again.");A=o,await M(b(),o),await q(),d()}catch(t){d(),y("Error processing CSV: "+(t instanceof Error?t.message:String(t)))}}}async function q(){if(A){B("Analyzing portfolio...");try{let e=parseFloat(l.initialCapital.value)||1e5,r=b(),n=await x(r,e);if(!n){y("No portfolio data available for analysis"),d();return}let t=await v(r,e),o=await J(l.benchmarkSelect.value);X(n,t,o),d()}catch(e){d(),y("Analysis error: "+(e instanceof Error?e.message:String(e)))}}}async function J(e){let r=H.benchmarks[e];try{return(await g(`
            SELECT
                date,
                close_price,
                (close_price - LAG(close_price) OVER (ORDER BY date)) /
                    NULLIF(LAG(close_price) OVER (ORDER BY date), 0) * 100 as daily_return_pct,
                SUM((close_price - LAG(close_price) OVER (ORDER BY date)) /
                    NULLIF(LAG(close_price) OVER (ORDER BY date), 0)) OVER (ORDER BY date) * 100 as cumulative_return_pct
            FROM parquet_scan('${H.dataPath}/${r}')
            WHERE date IS NOT NULL AND close_price IS NOT NULL
            ORDER BY date
        `)).map(t=>({date:t.date,closePrice:Number(t.close_price)||0,cumulativeReturnPct:Number(t.cumulative_return_pct)||0}))}catch(n){return console.warn(`Could not load benchmark data for ${e}:`,n.message),[]}}function X(e,r,n){let t=s=>document.getElementById(s),o=t("totalReturn");o.textContent=`${e.totalReturn>=0?"+":""}${e.totalReturnPct.toFixed(2)}%`,o.className="stat-value "+(e.totalReturn>=0?"positive":"negative");let a=t("annualizedReturn");a.textContent=`${e.annualizedReturnPct>=0?"+":""}${e.annualizedReturnPct.toFixed(2)}%`,a.className="stat-value "+(e.annualizedReturnPct>=0?"positive":"negative"),t("portfolioValue").textContent=`\u20B9${e.portfolioValue.toLocaleString("en-IN")}`,t("holdingPeriod").textContent=`${e.holdingDays} days (${e.holdingYears.toFixed(1)} years)`;let i=t("pnlGrid");if(e.realizedPnL!==0){i.style.display="grid";let s=t("totalRealizedPnL");s.textContent=`${e.realizedPnL>=0?"+":""}\u20B9${e.realizedPnL.toLocaleString("en-IN")}`,s.className="stat-value "+(e.realizedPnL>=0?"positive":"negative"),t("totalUnrealizedGain").textContent="-",t("fifoCostBasis").textContent=`\u20B9${e.costBasisRemaining.toLocaleString("en-IN")}`,t("stocksCount").textContent=`${e.numStocks}`}else i.style.display="none";K(r,n)}function K(e,r){let n=document.getElementById("returnsChart").getContext("2d"),t=e.map(i=>i.date),o=e.map(i=>i.returnPct),a;if(r.length>0){let i=new Set(e.map(s=>String(s.date)));a=r.filter(s=>i.has(String(s.date))).map(s=>s.cumulativeReturnPct)}else a=e.map(()=>0);D&&D.destroy(),D=new Chart(n,{type:"line",data:{labels:t.slice(0,100),datasets:[{label:"Portfolio",data:o.slice(0,100),borderColor:"#4facfe",backgroundColor:"rgba(79, 172, 254, 0.1)",borderWidth:2,pointRadius:2,fill:!0,tension:.1},{label:"Benchmark ("+l.benchmarkSelect.options[l.benchmarkSelect.selectedIndex].text+")",data:a.slice(0,100),borderColor:"#4caf50",borderWidth:2,pointRadius:2,fill:!1,tension:.1}]},options:{responsive:!0,maintainAspectRatio:!1,interaction:{mode:"index",intersect:!1},plugins:{legend:{position:"top",labels:{color:"#e0e0e0",font:{size:12}}},tooltip:{backgroundColor:"rgba(0,0,0,0.8)",titleColor:"#fff",bodyColor:"#e0e0e0",borderColor:"rgba(255,255,255,0.1)",borderWidth:1,callbacks:{label:i=>i.dataset.label+": "+i.parsed.y.toFixed(2)+"%"}},title:{display:!0,text:"Cumulative Returns Comparison",color:"#fff",font:{size:14}}},scales:{x:{grid:{color:"rgba(255,255,255,0.05)"},ticks:{color:"#888",maxTicksLimit:10}},y:{grid:{color:"rgba(255,255,255,0.05)"},ticks:{color:"#888",callback:i=>i+"%"},border:{color:"rgba(255,255,255,0.1)"}}}}})}function B(e){l.loadingText.textContent=e,l.loadingSection.style.display="flex"}function d(){l.loadingSection.style.display="none"}function y(e){l.loadingSection.style.display="none",l.errorMessage.textContent=e,l.errorSection.style.display="block",l.errorSection.style.visibility="visible",l.errorSection.style.opacity="1"}document.addEventListener("DOMContentLoaded",()=>{j(),h()});window.PortfolioAnalysis={init:h,parseCSV:R,handleFileUpload:U};
