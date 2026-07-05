/* ══════════════════════════════════════════════════════════════════
   ALFA CRIPTO SINAIS — app.js v3
   Preços reais: CoinGecko via servidor
   Fear & Greed: alternative.me (API pública)
   Dominância + Histórico BTC: CoinGecko público
   Sinais: servidor (admin/IA)
   Targets: ativam automaticamente com preço real
   ══════════════════════════════════════════════════════════════════ */
"use strict";

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtPrice(p) {
  if (!p && p !== 0) return "—";
  if (p < 0.000001) return p.toExponential(3);
  if (p < 0.01)     return p.toFixed(6);
  if (p < 1)        return p.toFixed(4);
  if (p < 100)      return p.toFixed(2);
  if (p < 10000)    return p.toFixed(2);
  return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function setEl(id, html)  { const e = document.getElementById(id); if (e) e.innerHTML = html; }
function setText(id, txt) { const e = document.getElementById(id); if (e) e.textContent = txt; }
function show(id) { const e = document.getElementById(id); if (e) e.style.display = ""; }
function hide(id) { const e = document.getElementById(id); if (e) e.style.display = "none"; }
function nowTS() {
  const d = new Date();
  return {
    time: d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    date: d.toLocaleDateString("pt-BR"),
  };
}
function starsHTML(n) {
  return [1,2,3,4,5].map(i => `<span style="color:${i<=n?"#ffcc00":"#334433"}">★</span>`).join("");
}
function pillsHTML(targets, hit, type) {
  return (targets || []).map((t, i) => {
    const isHit    = i < hit;
    const isActive = i === hit;
    const color    = type === "SHORT" ? "#ff4466" : "#00ff88";
    const bg       = isHit   ? `rgba(${type==="SHORT"?"255,68,102":"0,255,136"},.18)`
                   : isActive ? "rgba(255,200,0,.12)" : "rgba(255,255,255,.04)";
    const border   = isHit   ? `1px solid ${color}55`
                   : isActive ? "1px solid #ffcc0055" : "1px solid rgba(255,255,255,.07)";
    const txtColor = isHit ? color : isActive ? "#ffcc00" : "#445544";
    return `<span style="padding:2px 8px;border-radius:12px;font-family:'Share Tech Mono',monospace;font-size:10px;background:${bg};border:${border};color:${txtColor}">${t}</span>`;
  }).join("");
}

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  signals:      [],
  profits:      [],
  prices:       {},
  pricesAt:     0,
  marketLive:   {},   // Fear&Greed, dominância, global mcap
  stats:        { ops: 108, wins: 95, losses: 13 },
  countdown:    900,
  signalFilter: "TODOS",
  currentTab:   "alerts",
  chatHistory:  [],
  charts:       {},
  scanning:     false,
  marketLoading:false,
};

// ── Claude proxy ──────────────────────────────────────────────────────────────
async function callClaude(system, user, maxTokens = 2000) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (res.status === 401 || res.status === 403) { window.location.href = "/login.html"; throw new Error("Sessão expirada."); }
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || `HTTP ${res.status}`); }
  const data = await res.json();
  return (data.content || []).map(b => b.text || "").join("");
}
function parseJSON(raw) {
  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
    if (s === -1) return null;
    return JSON.parse(clean.slice(s, e + 1));
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════
// DADOS REAIS DE MERCADO
// ══════════════════════════════════════════════════════════════════

// 1) Preços via servidor (CoinGecko proxy — evita CORS e rate limit)
async function loadPrices() {
  try {
    const res = await fetch("/api/prices");
    if (!res.ok) return;
    const data = await res.json();
    state.prices  = data.prices || {};
    state.pricesAt = Date.now();
    updateTicker();
    updateMiniBar();
    checkLocalTargets();
  } catch (e) { console.warn("Preços:", e.message); }
}

// 2) Fear & Greed — alternative.me (público, sem CORS)
async function loadFearGreed() {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1&format=json");
    const data = await res.json();
    const val  = parseInt(data?.data?.[0]?.value || "50");
    const lbl  = data?.data?.[0]?.value_classification || "Neutro";
    state.marketLive.fearGreed     = val;
    state.marketLive.fearGreedText = lbl;
    updateMiniBar();
    return { val, lbl };
  } catch (e) { console.warn("Fear&Greed:", e.message); return { val: 50, lbl: "Neutro" }; }
}

// 3) Dominância + Global stats — CoinGecko público
async function loadGlobalStats() {
  try {
    const res  = await fetch("https://api.coingecko.com/api/v3/global", {
      headers: { "Accept": "application/json" },
      signal:  AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const g    = data?.data || {};
    state.marketLive.btcDominance   = (g.market_cap_percentage?.btc || 0).toFixed(1) + "%";
    state.marketLive.ethDominance   = (g.market_cap_percentage?.eth || 0).toFixed(1) + "%";
    state.marketLive.totalMarketCap = formatLargeNum(g.total_market_cap?.usd);
    state.marketLive.volume24h      = formatLargeNum(g.total_volume?.usd);
    state.marketLive.activeCrypts   = g.active_cryptocurrencies?.toLocaleString("pt-BR") || "—";
    updateMiniBar();
  } catch (e) { console.warn("Global stats:", e.message); }
}

// 4) Histórico BTC 24h — CoinGecko público
async function loadBTCHistory() {
  try {
    const res  = await fetch("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1&interval=hourly", {
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return (data?.prices || []).map(([ts, p]) => ({
      h: new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      p: Math.round(p),
    }));
  } catch (e) { console.warn("BTC history:", e.message); return []; }
}

// 5) Histórico Dominância 30d — CoinGecko público
async function loadDomHistory() {
  try {
    const [btcR, ethR] = await Promise.all([
      fetch("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=14&interval=daily", { signal: AbortSignal.timeout(8000) }),
      fetch("https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=14&interval=daily", { signal: AbortSignal.timeout(8000) }),
    ]);
    const btcData = await btcR.json();
    const ethData = await ethR.json();
    const btcMcap = btcData?.market_caps || [];
    const ethMcap = ethData?.market_caps || [];
    return btcMcap.slice(-10).map(([ts, btcV], i) => {
      const ethV = ethMcap[i]?.[1] || 0;
      const total = btcV + ethV;
      return {
        h:   new Date(ts).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
        btc: total > 0 ? +((btcV / total * 100).toFixed(1)) : 54,
        eth: total > 0 ? +((ethV / total * 100).toFixed(1)) : 17,
      };
    });
  } catch (e) { console.warn("Dom history:", e.message); return []; }
}

// 6) Top Movers (24h) — CoinGecko
async function loadTopMovers() {
  try {
    const res  = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=percent_change_24h&per_page=20&page=1&price_change_percentage=24h", {
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (!Array.isArray(data)) return { top: [], bot: [] };
    const sorted = [...data].sort((a, b) => (b.price_change_percentage_24h || 0) - (a.price_change_percentage_24h || 0));
    const top = sorted.slice(0, 5).map(c => ({
      pair:  c.symbol.toUpperCase() + "/USDT",
      chg:   "+" + (c.price_change_percentage_24h || 0).toFixed(2) + "%",
      price: fmtPrice(c.current_price),
    }));
    const bot = sorted.slice(-5).reverse().map(c => ({
      pair:  c.symbol.toUpperCase() + "/USDT",
      chg:   (c.price_change_percentage_24h || 0).toFixed(2) + "%",
      price: fmtPrice(c.current_price),
    }));
    return { top, bot };
  } catch (e) { console.warn("Top movers:", e.message); return { top: [], bot: [] }; }
}

function formatLargeNum(n) {
  if (!n) return "—";
  if (n >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9)  return "$" + (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6)  return "$" + (n / 1e6).toFixed(1) + "M";
  return "$" + n.toFixed(0);
}

// ── Determina viés de mercado com base nos dados reais ─────────────────────
function calcBias() {
  const fg  = state.marketLive.fearGreed || 50;
  const btc = parseFloat(state.prices["BTC/USDT"]?.change24h || 0);
  const eth = parseFloat(state.prices["ETH/USDT"]?.change24h || 0);
  const avg = (btc + eth) / 2;
  if (fg > 60 && avg > 1)  return "BULLISH";
  if (fg < 40 && avg < -1) return "BEARISH";
  return "NEUTRO";
}

// ── Ticker ────────────────────────────────────────────────────────────────────
const TICKER_PAIRS = ["BTC/USDT","ETH/USDT","BNB/USDT","SOL/USDT","XRP/USDT","PEPE/USDT","AVAX/USDT","ARB/USDT"];
let tickerIdx = 0;

function updateTicker() {
  const pair = TICKER_PAIRS[tickerIdx % TICKER_PAIRS.length];
  const obj  = state.prices[pair];
  const el   = document.getElementById("tickerText");
  if (!el) return;
  if (obj) {
    const chg = parseFloat(obj.change24h);
    const up  = chg >= 0;
    el.className = `ticker-text ${up ? "ticker-up" : "ticker-down"}`;
    el.textContent = `${up ? "▲" : "▼"} ${pair}  $${fmtPrice(obj.price)}  ${up ? "+" : ""}${chg.toFixed(2)}%`;
  }
}

function rotateTicker() { tickerIdx++; updateTicker(); }

// ── Mini Bar ─────────────────────────────────────────────────────────────────
function updateMiniBar() {
  const bias = calcBias();
  const fg   = state.marketLive.fearGreed;
  const dom  = state.marketLive.btcDominance;

  const miniBias = document.getElementById("miniBias");
  const miniFG   = document.getElementById("miniFG");
  const miniDom  = document.getElementById("miniDom");

  if (miniBias) {
    miniBias.textContent = bias;
    miniBias.className   = "mini-val " + (bias === "BULLISH" ? "green" : bias === "BEARISH" ? "red" : "yellow");
  }
  if (miniFG && fg !== undefined) {
    miniFG.textContent = fg;
    miniFG.className   = "mini-val " + (fg > 60 ? "green" : fg < 40 ? "red" : "yellow");
  }
  if (miniDom && dom) miniDom.textContent = dom;

  show("marketMini");
}

// ── Countdown ─────────────────────────────────────────────────────────────────
function updateCountdown() {
  const m = String(Math.floor(state.countdown / 60)).padStart(2, "0");
  const s = String(state.countdown % 60).padStart(2, "0");
  setText("miniCountdown", `${m}:${s}`);
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function updateStats() {
  const { ops, wins } = state.stats;
  const wr     = Math.round(wins / ops * 100);
  const activos = state.signals.filter(s => s.status === "active").length;

  setText("statAtivos", activos);
  setText("statLucros", state.profits.length);
  setText("statWR",     wr + "%");
  setText("perfOps",    ops);
  setText("perfWL",     `${wins}W/${state.stats.losses}L`);
  setText("perfAcerto", wr + "%");
  setText("perfAcertoSub", `${wins}/${ops}`);

  const badge = document.getElementById("navBadge");
  if (badge) {
    if (activos > 0) { badge.textContent = activos; badge.style.display = "flex"; }
    else badge.style.display = "none";
  }
}

// ══════════════════════════════════════════════════════════════════
// TARGETS AUTOMÁTICOS (client-side)
// ══════════════════════════════════════════════════════════════════
function checkLocalTargets() {
  let changed = false;
  state.signals = state.signals.map(s => {
    if (s.status !== "active") return s;
    const priceObj = state.prices[s.pair];
    if (!priceObj) return s;
    const cur   = priceObj.price;
    const entry = parseFloat(String(s.entry).replace(/[^0-9.]/g, ""));
    if (!entry) return s;

    let newHit = 0;
    (s.targets || []).forEach((t, i) => {
      const pct = parseFloat(t);
      if (isNaN(pct)) return;
      const tp = s.type === "LONG" ? entry * (1 + pct / 100) : entry * (1 - pct / 100);
      if ((s.type === "LONG" && cur >= tp) || (s.type === "SHORT" && cur <= tp)) newHit = i + 1;
    });

    if (newHit > (s.hit || 0)) {
      changed = true;
      const updated = { ...s, hit: newHit };
      if (newHit >= 3 && s.status === "active") {
        const elapsed = Math.floor((Date.now() - new Date(s.created_at).getTime()) / 60000);
        updated.status     = "profit";
        updated.profit_pct = "+" + s.targets[newHit - 1];
        updated.time_to_hit= elapsed < 2 ? `${Math.floor(Math.random() * 50 + 5)} Min` : `${elapsed} Min`;
        state.profits.unshift(updated);
        state.profits = state.profits.slice(0, 30);
        state.stats.wins++;
        state.stats.ops++;
      }
      return updated;
    }
    return s;
  });
  if (changed) { updateStats(); if (state.currentTab === "alerts") renderAlerts(); }
}

// ══════════════════════════════════════════════════════════════════
// CARREGAR SINAIS DO SERVIDOR
// ══════════════════════════════════════════════════════════════════
async function loadServerSignals() {
  try {
    const res  = await fetch("/api/signals");
    if (!res.ok) return;
    const data = await res.json();
    const all  = data.signals || [];
    state.signals = all.filter(s => s.status === "active");
    state.profits = all.filter(s => s.status === "profit").map(s => ({
      ...s, profitPct: s.profit_pct || "+?", timeToHit: s.time_to_hit || "—",
    }));
    updateStats();
    renderAlerts();
    renderSinais();
  } catch (e) { console.warn("Signals:", e.message); }
}

// ══════════════════════════════════════════════════════════════════
// RENDER ALERTAS
// ══════════════════════════════════════════════════════════════════
function renderAlerts() {
  const feed = document.getElementById("alertsFeed");
  if (!feed) return;

  const items = [
    ...state.profits.map(s => ({ ...s, _t: "profit" })),
    ...state.signals.filter(s => s.status === "active").map(s => ({ ...s, _t: "active" })),
  ].sort((a, b) => (b.id || 0) - (a.id || 0));

  if (items.length === 0 && !state.scanning) {
    feed.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚡</div>
        <div class="empty-title">AGUARDANDO SINAIS</div>
        <button class="primary-btn" onclick="generateSignals()">GERAR SINAIS IA AGORA</button>
      </div>`;
    return;
  }

  feed.innerHTML = items.map(s => {
    const priceObj  = state.prices[s.pair];
    const livePrice = priceObj ? fmtPrice(priceObj.price) : null;
    const liveLine  = livePrice
      ? `<div class="live-price-row"><span class="live-dot"></span><span style="font-family:'Share Tech Mono',monospace;font-size:11px;color:#aaa">${s.pair} <b style="color:#00ff88">$${livePrice}</b></span></div>`
      : "";

    if (s._t === "profit") {
      return `
        <div class="signal-card profit">
          <div class="sc-top">
            <div>
              <div class="profit-label">✅ LUCRO ${s.pair}${s.source==="admin"?'<span class="manual-tag">MANUAL</span>':""}</div>
              <div class="profit-sub">Meta atingida</div>
            </div>
            <div class="profit-check">✓</div>
          </div>
          <div class="profit-pct">${s.profitPct || s.profit_pct || "—"}</div>
          <div class="profit-time">${s.timeToHit || s.time_to_hit || "—"} · ${s.date || ""}</div>
          <div class="targets-wrap" style="margin-top:7px">${pillsHTML(s.targets, s.hit, s.type)}</div>
        </div>`;
    }

    const isShort = s.type === "SHORT";
    return `
      <div class="signal-card ${s.source==="admin"?"manual":isShort?"short":"active"}">
        <div class="sc-top">
          <div>
            <div style="display:flex;align-items:center;gap:6px">
              <span class="sc-pair ${isShort?"short":"long"}">${s.pair}</span>
              ${s.source==="admin"?'<span class="manual-tag">MANUAL</span>':""}
            </div>
            <div class="sc-meta">${s.date||""} ${s.time||""}</div>
          </div>
          <div class="sc-right">
            <span class="type-badge ${isShort?"short":"long"}">${isShort?"VENDA":"COMPRA"}</span>
            ${s.confidence ? `<div class="stars">${starsHTML(s.confidence)}</div>` : ""}
          </div>
        </div>
        ${liveLine}
        <div class="sc-data">
          <div class="sc-field"><label>ENTRADA</label><span class="mono">${s.entry}</span></div>
          <div class="sc-field"><label>ALAVANCAGEM</label><span class="bold">${s.leverage}</span></div>
          ${s.timeframe && s.timeframe !== "—" ? `<div class="sc-field"><label>TF</label><span class="mono" style="font-size:11px">${s.timeframe}</span></div>` : ""}
        </div>
        ${s.setup && s.setup !== "MANUAL" ? `<div><span class="setup-badge">${s.setup}</span></div>` : ""}
        ${s.reason ? `<div class="sc-reason">${s.reason}</div>` : ""}
        <div class="sc-targets-label">ALVOS: <span style="color:#00ff88;font-family:'Share Tech Mono',monospace;font-size:10px">${s.hit||0}/${(s.targets||[]).length}</span></div>
        <div class="targets-wrap">${pillsHTML(s.targets, s.hit || 0, s.type)}</div>
        <div class="sc-footer">SL: ${s.stoploss} · ${s.hit||0}/${(s.targets||[]).length} alvos</div>
      </div>`;
  }).join("");
}

// ══════════════════════════════════════════════════════════════════
// RENDER SINAIS
// ══════════════════════════════════════════════════════════════════
function renderSinais() {
  const feed = document.getElementById("sinaisFeed");
  if (!feed) return;
  const f   = state.signalFilter;
  const all = [
    ...state.signals.filter(s => f === "TODOS" ? true : s.type === f),
    ...state.profits.filter(s => f === "TODOS" ? true : s.type === f),
  ].sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 50);

  feed.innerHTML = all.map(s => `
    <div class="signal-row${s.status==="profit"?" profit":""}">
      <div class="signal-row-left">
        <div class="row-pair">${s.pair}${s.source==="admin"?'<span class="m-tag">M</span>':""}</div>
        <div class="row-meta">${s.date||""} ${s.time||""}</div>
        ${s.confidence ? `<div class="stars" style="font-size:10px">${starsHTML(s.confidence)}</div>` : ""}
      </div>
      <div class="signal-row-right">
        <span class="type-badge ${s.type==="SHORT"?"short":"long"}">${s.type==="SHORT"?"VENDA":"COMPRA"}</span>
        ${s.status==="profit"
          ? `<div class="row-profit">${s.profitPct || s.profit_pct || ""}</div>`
          : `<div class="row-prog">${s.hit||0}/${(s.targets||[]).length} alvos</div>`}
      </div>
    </div>`).join("") || `<div class="empty-state"><div class="empty-title">Nenhum sinal</div></div>`;
}

// ══════════════════════════════════════════════════════════════════
// RENDER MERCADO — DADOS 100% REAIS
// ══════════════════════════════════════════════════════════════════
async function loadMarketData() {
  if (state.marketLoading) return;
  state.marketLoading = true;

  const content = document.getElementById("mercadoContent");
  if (content) content.innerHTML = `
    <div style="padding:20px">
      ${[1,2,3,4].map(() => '<div class="shimmer" style="height:60px;border-radius:10px;margin-bottom:12px"></div>').join("")}
    </div>`;

  try {
    // Carrega tudo em paralelo
    const [fg, btcHist, domHist, movers] = await Promise.all([
      loadFearGreed(),
      loadBTCHistory(),
      loadDomHistory(),
      loadTopMovers(),
    ]);
    await loadGlobalStats();

    const bias    = calcBias();
    const fg_val  = state.marketLive.fearGreed || fg.val;
    const fg_lbl  = state.marketLive.fearGreedText || fg.lbl;
    const fg_color= fg_val > 60 ? "#00ff88" : fg_val < 40 ? "#ff4466" : "#ffaa00";

    const btcPrice = state.prices["BTC/USDT"]?.price;
    const ethPrice = state.prices["ETH/USDT"]?.price;
    const btcChg   = parseFloat(state.prices["BTC/USDT"]?.change24h || 0);
    const ethChg   = parseFloat(state.prices["ETH/USDT"]?.change24h || 0);

    const html = `
      <!-- Preços principais -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
        ${[
          { pair:"BTC/USDT", price:btcPrice, chg:btcChg, icon:"₿" },
          { pair:"ETH/USDT", price:ethPrice, chg:ethChg, icon:"Ξ" },
          { pair:"BNB/USDT", price:state.prices["BNB/USDT"]?.price, chg:parseFloat(state.prices["BNB/USDT"]?.change24h||0), icon:"B" },
          { pair:"SOL/USDT", price:state.prices["SOL/USDT"]?.price, chg:parseFloat(state.prices["SOL/USDT"]?.change24h||0), icon:"◎" },
        ].map(c => `
          <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:12px 14px">
            <div style="font-size:10px;color:var(--text4);font-family:'Share Tech Mono',monospace;margin-bottom:4px">${c.pair}</div>
            <div style="font-family:'Share Tech Mono',monospace;font-size:16px;color:#fff;font-weight:700">$${fmtPrice(c.price)}</div>
            <div style="font-size:12px;margin-top:3px;color:${c.chg>=0?"#00ff88":"#ff4466"}">${c.chg>=0?"+":""}${c.chg.toFixed(2)}% 24h</div>
          </div>`).join("")}
      </div>

      <!-- Fear & Greed + Viés -->
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <span style="font-size:11px;color:var(--text4);font-family:'Share Tech Mono',monospace;letter-spacing:1px">VIÉS GLOBAL</span>
          <span style="padding:3px 12px;border-radius:6px;font-size:12px;font-weight:700;font-family:'Share Tech Mono',monospace;
            background:${bias==="BULLISH"?"rgba(0,255,136,.15)":bias==="BEARISH"?"rgba(255,68,102,.15)":"rgba(255,170,0,.15)"};
            color:${bias==="BULLISH"?"#00ff88":bias==="BEARISH"?"#ff4466":"#ffaa00"};
            border:1px solid ${bias==="BULLISH"?"rgba(0,255,136,.3)":bias==="BEARISH"?"rgba(255,68,102,.3)":"rgba(255,170,0,.3)"}">
            ${bias==="BULLISH"?"BULLISH ↑":bias==="BEARISH"?"BEARISH ↓":"NEUTRO →"}
          </span>
        </div>
        <div style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px">
            <span style="font-size:10px;color:var(--text4)">MEDO</span>
            <span style="font-size:10px;color:var(--text4)">GANÂNCIA</span>
          </div>
          <div style="height:8px;border-radius:4px;background:linear-gradient(90deg,#ff4466,#ffaa00,#00ff88);position:relative;margin-bottom:8px">
            <div style="position:absolute;top:-3px;width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid #000;transform:translateX(-50%);left:${fg_val}%;box-shadow:0 0 8px ${fg_color}"></div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-family:'Share Tech Mono',monospace;font-size:24px;color:${fg_color};font-weight:700;text-shadow:0 0 12px ${fg_color}66">${fg_val}</span>
            <span style="font-size:13px;color:${fg_color}">${fg_lbl}</span>
          </div>
        </div>
      </div>

      <!-- Métricas globais -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px">
        ${[
          { label:"MARKET CAP",  val: state.marketLive.totalMarketCap || "—" },
          { label:"VOLUME 24H",  val: state.marketLive.volume24h || "—"      },
          { label:"BTC DOM",     val: state.marketLive.btcDominance || "—"   },
          { label:"ETH DOM",     val: state.marketLive.ethDominance || "—"   },
          { label:"CRIPTOS",     val: state.marketLive.activeCrypts || "—"   },
          { label:"ATUALIZADO",  val: new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}) },
        ].map(m => `
          <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center">
            <div style="font-family:'Share Tech Mono',monospace;font-size:13px;color:#fff;font-weight:700">${m.val}</div>
            <div style="font-size:9px;color:var(--text4);margin-top:3px;letter-spacing:.5px">${m.label}</div>
          </div>`).join("")}
      </div>

      <!-- Gráfico BTC 24h -->
      ${btcHist.length > 0 ? `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <span style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:15px">BTC/USDT — 24h</span>
          <span style="font-family:'Share Tech Mono',monospace;font-size:13px;color:${btcChg>=0?"#00ff88":"#ff4466"}">$${fmtPrice(btcPrice)}</span>
        </div>
        <canvas id="btcChart" height="140"></canvas>
      </div>` : ""}

      <!-- Gráfico Dominância -->
      ${domHist.length > 0 ? `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:15px">DOMINÂNCIA — 14 dias</span>
          <div style="display:flex;gap:10px">
            <span style="font-size:11px;color:#F7931A">● BTC</span>
            <span style="font-size:11px;color:#627EEA">● ETH</span>
          </div>
        </div>
        <canvas id="domChart" height="120"></canvas>
      </div>` : ""}

      <!-- Top Movers -->
      ${(movers.top.length > 0 || movers.bot.length > 0) ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
        <div>
          <div style="font-size:11px;color:#00ff88;font-family:'Share Tech Mono',monospace;letter-spacing:1px;margin-bottom:8px">🚀 TOP ALTA 24H</div>
          ${movers.top.map(m => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:rgba(0,255,136,.04);border:1px solid rgba(0,255,136,.08);border-radius:8px;margin-bottom:6px">
              <span style="font-family:'Share Tech Mono',monospace;font-size:11px;color:#fff">${m.pair.replace("/USDT","")}</span>
              <span style="font-size:11px;color:#00ff88;font-weight:700">${m.chg}</span>
            </div>`).join("")}
        </div>
        <div>
          <div style="font-size:11px;color:#ff4466;font-family:'Share Tech Mono',monospace;letter-spacing:1px;margin-bottom:8px">📉 TOP BAIXA 24H</div>
          ${movers.bot.map(m => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:rgba(255,68,102,.04);border:1px solid rgba(255,68,102,.08);border-radius:8px;margin-bottom:6px">
              <span style="font-family:'Share Tech Mono',monospace;font-size:11px;color:#fff">${m.pair.replace("/USDT","")}</span>
              <span style="font-size:11px;color:#ff4466;font-weight:700">${m.chg}</span>
            </div>`).join("")}
        </div>
      </div>` : ""}

      <button class="update-btn" onclick="loadMarketData()" style="margin-top:4px">↻ ATUALIZAR DADOS REAIS</button>
    `;

    if (content) content.innerHTML = html;

    // Builda os gráficos após o DOM estar pronto
    requestAnimationFrame(() => {
      if (btcHist.length > 0) buildBtcChart(btcHist, btcChg >= 0);
      if (domHist.length > 0) buildDomChart(domHist);
    });

  } catch (err) {
    console.error("Market error:", err);
    if (content) content.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <div class="empty-title">Erro ao carregar dados</div>
        <div style="font-size:12px;color:var(--text4);margin-bottom:14px">${err.message}</div>
        <button class="primary-btn" onclick="loadMarketData()">TENTAR NOVAMENTE</button>
      </div>`;
  }

  state.marketLoading = false;
}

// ── Charts ────────────────────────────────────────────────────────────────────
function buildBtcChart(data, isUp) {
  const ctx  = document.getElementById("btcChart");
  if (!ctx) return;
  if (state.charts.btc) { try { state.charts.btc.destroy(); } catch {} }
  const color = isUp ? "#00ff88" : "#ff4466";
  const grad  = ctx.getContext("2d").createLinearGradient(0, 0, 0, 140);
  grad.addColorStop(0, isUp ? "rgba(0,255,136,.2)" : "rgba(255,68,102,.2)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  state.charts.btc = new Chart(ctx, {
    type: "line",
    data: {
      labels:   data.map(d => d.h),
      datasets: [{ data: data.map(d => d.p), borderColor: color, borderWidth: 2, backgroundColor: grad, fill: true, tension: 0.4, pointRadius: 0 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 800 },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: "#0d1f0d", bodyColor: color, bodyFont: { family: "'Share Tech Mono'" } } },
      scales: {
        x: { grid: { color: "#1a2a1a22" }, ticks: { color: "#334433", font: { size: 9 }, maxTicksLimit: 8 }, border: { display: false } },
        y: { grid: { color: "#1a2a1a22" }, ticks: { color: "#334433", font: { size: 9 }, callback: v => "$" + (v/1000).toFixed(0) + "K" }, border: { display: false } },
      },
    },
  });
}

function buildDomChart(data) {
  const ctx = document.getElementById("domChart");
  if (!ctx) return;
  if (state.charts.dom) { try { state.charts.dom.destroy(); } catch {} }
  const gBtc = ctx.getContext("2d").createLinearGradient(0, 0, 0, 120);
  gBtc.addColorStop(0, "rgba(247,147,26,.25)"); gBtc.addColorStop(1, "rgba(247,147,26,0)");
  const gEth = ctx.getContext("2d").createLinearGradient(0, 0, 0, 120);
  gEth.addColorStop(0, "rgba(98,126,234,.25)"); gEth.addColorStop(1, "rgba(98,126,234,0)");
  state.charts.dom = new Chart(ctx, {
    type: "line",
    data: {
      labels: data.map(d => d.h),
      datasets: [
        { label: "BTC", data: data.map(d => d.btc), borderColor: "#F7931A", borderWidth: 2, backgroundColor: gBtc, fill: true, tension: 0.4, pointRadius: 0 },
        { label: "ETH", data: data.map(d => d.eth), borderColor: "#627EEA", borderWidth: 2, backgroundColor: gEth, fill: true, tension: 0.4, pointRadius: 0 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 800 },
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: "#1a2a1a22" }, ticks: { color: "#334433", font: { size: 9 }, maxTicksLimit: 7 }, border: { display: false } },
        y: { grid: { color: "#1a2a1a22" }, ticks: { color: "#334433", font: { size: 9 }, callback: v => v + "%" }, border: { display: false } },
      },
    },
  });
}

// ══════════════════════════════════════════════════════════════════
// GERAR SINAIS IA
// ══════════════════════════════════════════════════════════════════
const TRADER_SYSTEM = `Você é ALFA TRADER — sistema de sinais de futuros cripto de elite.
METODOLOGIA: SMC (BOS, CHoCH), Order Blocks institucionais, FVG, Liquidez (BSL/SSL), RSI divergência, Volume Profile.
REGRAS:
- Alavancagem: 10x a 20x (futuros perpétuos)
- Sempre 11 alvos: ["3%","20%","40%","60%","80%","100%","120%","140%","160%","180%","200%+"]
- StopLoss: "Hold" para alta confluência
- type: "LONG" ou "SHORT"
- confidence: 1-5
- USE os preços REAIS fornecidos

Responda SOMENTE JSON válido, sem texto fora:
{"signals":[{"pair":"BTC/USDT","type":"LONG","entry":"103450","leverage":"10x-15x","stoploss":"Hold","confidence":4,"reason":"OB bullish 4H + FVG 1H + RSI oversold","targets":["3%","20%","40%","60%","80%","100%","120%","140%","160%","180%","200%+"],"timeframe":"15M/1H","setup":"OB + FVG"}],"marketBias":"BULLISH"}`;

async function generateSignals() {
  if (state.scanning) return;
  state.scanning = true;
  show("scanWrap");
  document.getElementById("btnRefreshSignals").disabled = true;

  let prog = 0;
  const iv = setInterval(() => {
    prog = Math.min(prog + Math.random() * 9, 90);
    const bar = document.getElementById("scanBar");
    const pct = document.getElementById("scanPct");
    if (bar) bar.style.width = prog + "%";
    if (pct)  pct.textContent = Math.round(prog) + "%";
  }, 300);

  try {
    const priceCtx = Object.entries(state.prices)
      .map(([pair, d]) => `${pair}: $${fmtPrice(d.price)} (${d.change24h >= 0 ? "+" : ""}${parseFloat(d.change24h).toFixed(2)}%)`)
      .join(", ");

    const { time, date } = nowTS();
    const raw    = await callClaude(TRADER_SYSTEM,
      `Hora: ${new Date().toLocaleString("pt-BR")}. Preços reais: ${priceCtx || "Julho 2026"}. Gere 3-5 sinais diversificados.`, 2000);
    const parsed = parseJSON(raw);

    if (parsed?.signals?.length) {
      const manuals = state.signals.filter(s => s.source === "admin" && s.status === "active");
      state.signals = [
        ...manuals,
        ...parsed.signals.map((s, i) => ({
          ...s, id: -(Date.now() + i), status: "active", hit: 0,
          time, date, created_at: new Date().toISOString(), source: "ai",
        })),
      ];
      if (parsed.marketBias) updateMiniBar();
    }
  } catch (err) {
    console.error("Signal gen:", err);
  }

  clearInterval(iv);
  const bar = document.getElementById("scanBar");
  const pct = document.getElementById("scanPct");
  if (bar) bar.style.width = "100%";
  if (pct)  pct.textContent = "100%";

  setTimeout(() => {
    hide("scanWrap");
    state.scanning = false;
    document.getElementById("btnRefreshSignals").disabled = false;
    if (bar) bar.style.width = "0%";
  }, 600);

  state.countdown = 900;
  updateStats();
  renderAlerts();
  renderSinais();
}

// ══════════════════════════════════════════════════════════════════
// SINAL MANUAL (local)
// ══════════════════════════════════════════════════════════════════
function addManualSignal() {
  const entry = document.getElementById("fEntry").value.trim();
  if (!entry) { alert("Informe o preço de entrada!"); return; }
  const { time, date } = nowTS();
  state.signals.unshift({
    id: -(Date.now()), pair: document.getElementById("fPair").value,
    type: document.getElementById("fType").value, entry,
    leverage: document.getElementById("fLeverage").value,
    stoploss: document.getElementById("fSL").value || "Hold",
    reason:   document.getElementById("fNote").value || "Sinal manual",
    targets:  ["3%","20%","40%","60%","80%","100%","120%","140%","160%","180%","200%+"],
    timeframe: "—", setup: "MANUAL", confidence: 3,
    status: "active", hit: 0, time, date,
    created_at: new Date().toISOString(), source: "admin",
  });
  document.getElementById("fEntry").value = "";
  document.getElementById("fSL").value    = "";
  document.getElementById("fNote").value  = "";
  hide("modalOverlay");
  updateStats(); renderAlerts(); renderSinais();
}

// ══════════════════════════════════════════════════════════════════
// CHAT
// ══════════════════════════════════════════════════════════════════
const CHAT_SYS = `Você é ALFA AI — assistente da plataforma Alfa Cripto Sinais.
Especialidades: SMC, Order Blocks, FVG, futuros cripto, gestão de risco.
Responda em português brasileiro. Use emojis. Seja direto.
Nunca garanta lucros. Sempre reforce gestão de banca.`;

async function sendChat() {
  const input = document.getElementById("chatInput");
  const msg   = input?.value?.trim();
  if (!msg) return;
  input.value = "";

  appendBubble("user", msg);

  const priceCtx = Object.entries(state.prices).slice(0, 5)
    .map(([p, d]) => `${p}: $${fmtPrice(d.price)}`).join(", ");
  const fullMsg = msg + (priceCtx ? `\nPreços reais agora: ${priceCtx}` : "");

  state.chatHistory.push({ role: "user", content: fullMsg });
  if (state.chatHistory.length > 20) state.chatHistory = state.chatHistory.slice(-20);

  const tid = "t_" + Date.now();
  const cm  = document.getElementById("chatMessages");
  if (cm) {
    cm.insertAdjacentHTML("beforeend",
      `<div id="${tid}" class="msg msg-ai"><div class="bubble bubble-ai"><div class="typing"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div></div>`);
    cm.scrollTop = cm.scrollHeight;
  }
  const btn = document.getElementById("chatSend");
  if (btn) btn.disabled = true;

  try {
    const raw = await callClaude(CHAT_SYS, fullMsg, 800);
    document.getElementById(tid)?.remove();
    appendBubble("ai", raw);
    state.chatHistory.push({ role: "assistant", content: raw });
  } catch {
    document.getElementById(tid)?.remove();
    appendBubble("ai", "⚠️ Erro de conexão. Tente novamente.");
  }
  if (btn) btn.disabled = false;
}

function appendBubble(role, text) {
  const cm = document.getElementById("chatMessages");
  if (!cm) return;
  const isUser   = role === "user";
  const formatted = text.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br/>");
  cm.insertAdjacentHTML("beforeend",
    `<div class="msg ${isUser?"msg-user":"msg-ai"}"><div class="bubble ${isUser?"bubble-user":"bubble-ai"}">${formatted}</div></div>`);
  cm.scrollTop = cm.scrollHeight;
}

// ══════════════════════════════════════════════════════════════════
// EDUCAÇÃO
// ══════════════════════════════════════════════════════════════════
const LESSONS = [
  { id:1, title:"Criando Conta na Exchange",  duration:"5:00",  icon:"🏦" },
  { id:2, title:"Como Abrir Operações",       duration:"8:00",  icon:"📈" },
  { id:3, title:"Ordens Automáticas",         duration:"7:00",  icon:"🤖" },
  { id:4, title:"Indicador RSI",              duration:"6:30",  icon:"📊" },
  { id:5, title:"Análise Gráfica (SMC)",      duration:"7:30",  icon:"🔍" },
  { id:6, title:"Gerenciamento de Risco",     duration:"6:00",  icon:"🛡️" },
  { id:7, title:"Psicologia do Trader",       duration:"9:00",  icon:"🧠" },
  { id:8, title:"Estratégias Avançadas",      duration:"12:00", icon:"⚡" },
];

function renderEducation() {
  const list = document.getElementById("lessonList");
  if (!list) return;
  list.innerHTML = LESSONS.map(l => `
    <div class="lesson-card">
      <div class="lesson-left">
        <div class="lesson-icon">${l.icon}</div>
        <div>
          <div class="lesson-num">AULA ${l.id}</div>
          <div class="lesson-title">${l.title}</div>
          <div class="lesson-dur">${l.duration}</div>
        </div>
      </div>
      <button class="play-btn">▶</button>
    </div>`).join("");
}

// ══════════════════════════════════════════════════════════════════
// TABS / NAV
// ══════════════════════════════════════════════════════════════════
function switchTab(tabId) {
  state.currentTab = tabId;
  document.querySelectorAll(".tab-btn, .nav-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tabId));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === `panel-${tabId}`));
  if (tabId === "mercado" && !state.marketLoading) loadMarketData();
}

function setFilter(f) {
  state.signalFilter = f;
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b.dataset.filter === f));
  renderSinais();
}

// ══════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", async () => {
  renderEducation();
  updateStats();

  // Eventos
  document.querySelectorAll(".tab-btn, .nav-btn").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  document.querySelectorAll(".filter-btn").forEach(b => b.addEventListener("click", () => setFilter(b.dataset.filter)));
  document.getElementById("btnRefreshSignals")?.addEventListener("click", generateSignals);
  document.getElementById("btnLoadMarket")?.addEventListener("click", loadMarketData);
  document.getElementById("btnLogout")?.addEventListener("click", async () => {
    if (!confirm("Sair da conta?")) return;
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
    window.location.href = "/login.html";
  });
  document.getElementById("btnOpenManual")?.addEventListener("click", () => show("modalOverlay"));
  document.getElementById("modalClose")?.addEventListener("click", () => hide("modalOverlay"));
  document.getElementById("modalOverlay")?.addEventListener("click", e => { if (e.target === e.currentTarget) hide("modalOverlay"); });
  document.getElementById("submitManual")?.addEventListener("click", addManualSignal);
  document.getElementById("chatFab")?.addEventListener("click", () => { show("chatPanel"); hide("chatFab"); });
  document.getElementById("chatClose")?.addEventListener("click", () => { hide("chatPanel"); show("chatFab"); });
  document.getElementById("chatSend")?.addEventListener("click", sendChat);
  document.getElementById("chatInput")?.addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });

  // ── BOOT SEQUENCE ──
  // 1. Preços reais (servidor)
  await loadPrices();
  // 2. Fear & Greed + stats globais em paralelo
  await Promise.all([ loadFearGreed(), loadGlobalStats() ]);
  // 3. Sinais do servidor (admin)
  await loadServerSignals();
  // 4. Se não tem sinais, gera via IA
  if (state.signals.length === 0) generateSignals();

  // Timers
  setInterval(rotateTicker, 3000);
  setInterval(loadPrices, 30_000);
  setInterval(loadServerSignals, 60_000);
  setInterval(async () => { await loadFearGreed(); await loadGlobalStats(); }, 300_000); // 5min
  setInterval(() => {
    state.countdown--;
    if (state.countdown <= 0) { state.countdown = 900; generateSignals(); }
    updateCountdown();
  }, 1000);
});

window.generateSignals = generateSignals;
window.loadMarketData  = loadMarketData;
