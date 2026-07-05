/* ══════════════════════════════════════════════════════════════════
   ACS SYSTEM — app.js v4
   - Sinais APENAS pelo admin (servidor) — sem geração automática
   - Todos os sinais persistidos no banco
   - Alertas: máximo 5 visíveis + botão "Ver mais"
   - Preços reais: CoinGecko via servidor
   - Fear & Greed: alternative.me
   - Targets: ativam automaticamente com preço real
   ══════════════════════════════════════════════════════════════════ */
"use strict";

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtPrice(p) {
  if (!p && p !== 0) return "—";
  if (p < 0.000001) return p.toExponential(3);
  if (p < 0.01)     return p.toFixed(6);
  if (p < 1)        return p.toFixed(4);
  if (p < 100)      return p.toFixed(2);
  if (p < 10000)    return p.toFixed(2);
  return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function setEl(id, html)  { const e = document.getElementById(id); if (e) e.innerHTML  = html; }
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
function formatLargeNum(n) {
  if (!n) return "—";
  if (n >= 1e12) return "$" + (n/1e12).toFixed(2) + "T";
  if (n >= 1e9)  return "$" + (n/1e9).toFixed(1)  + "B";
  return "$" + n.toFixed(0);
}

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

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  signals:       [],   // todos ativos (do servidor)
  profits:       [],   // todos com lucro (do servidor)
  closed:        [],   // fechados/loss
  alertsPage:    0,    // paginação de alertas (5 por vez)
  prices:        {},
  marketLive:    {},
  stats:         { ops: 0, wins: 0, losses: 0 },
  signalFilter:  "TODOS",
  currentTab:    "alerts",
  chatHistory:   [],
  charts:        {},
  marketLoading: false,
};

const ALERTS_PER_PAGE = 5;

// ══════════════════════════════════════════════════════════════════
// PREÇOS REAIS
// ══════════════════════════════════════════════════════════════════
async function loadPrices() {
  try {
    const res  = await fetch("/api/prices");
    if (!res.ok) return;
    const data = await res.json();
    state.prices = data.prices || {};
    updateTicker();
    updateMiniBar();
    checkLocalTargets();
  } catch (e) { console.warn("Preços:", e.message); }
}

async function loadFearGreed() {
  try {
    const res  = await fetch("https://api.alternative.me/fng/?limit=1&format=json");
    const data = await res.json();
    state.marketLive.fearGreed     = parseInt(data?.data?.[0]?.value || "50");
    state.marketLive.fearGreedText = data?.data?.[0]?.value_classification || "Neutro";
    updateMiniBar();
  } catch (e) { console.warn("F&G:", e.message); }
}

async function loadGlobalStats() {
  try {
    const res  = await fetch("https://api.coingecko.com/api/v3/global", { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const g    = data?.data || {};
    state.marketLive.btcDominance   = (g.market_cap_percentage?.btc || 0).toFixed(1) + "%";
    state.marketLive.ethDominance   = (g.market_cap_percentage?.eth || 0).toFixed(1) + "%";
    state.marketLive.totalMarketCap = formatLargeNum(g.total_market_cap?.usd);
    state.marketLive.volume24h      = formatLargeNum(g.total_volume?.usd);
    updateMiniBar();
  } catch (e) { console.warn("Global:", e.message); }
}

// ── Ticker ────────────────────────────────────────────────────────────────────
const TICKER_PAIRS = ["BTC/USDT","ETH/USDT","BNB/USDT","SOL/USDT","XRP/USDT","PEPE/USDT","AVAX/USDT","ARB/USDT"];
let tickerIdx = 0;
function updateTicker() {
  const pair = TICKER_PAIRS[tickerIdx % TICKER_PAIRS.length];
  const obj  = state.prices[pair];
  const el   = document.getElementById("tickerText");
  if (!el || !obj) return;
  const chg = parseFloat(obj.change24h);
  const up  = chg >= 0;
  el.className  = `ticker-text ${up ? "ticker-up" : "ticker-down"}`;
  el.textContent = `${up ? "▲" : "▼"} ${pair}  $${fmtPrice(obj.price)}  ${up ? "+" : ""}${chg.toFixed(2)}%`;
}

// ── Mini Bar ──────────────────────────────────────────────────────────────────
function calcBias() {
  const fg  = state.marketLive.fearGreed || 50;
  const btc = parseFloat(state.prices["BTC/USDT"]?.change24h || 0);
  const eth = parseFloat(state.prices["ETH/USDT"]?.change24h || 0);
  const avg = (btc + eth) / 2;
  if (fg > 60 && avg > 1)  return "BULLISH";
  if (fg < 40 && avg < -1) return "BEARISH";
  return "NEUTRO";
}

function updateMiniBar() {
  const bias = calcBias();
  const fg   = state.marketLive.fearGreed;
  const dom  = state.marketLive.btcDominance;
  const mb   = document.getElementById("miniBias");
  const mf   = document.getElementById("miniFG");
  const md   = document.getElementById("miniDom");
  if (mb) { mb.textContent = bias; mb.className = "mini-val " + (bias==="BULLISH"?"green":bias==="BEARISH"?"red":"yellow"); }
  if (mf && fg !== undefined) { mf.textContent = fg; mf.className = "mini-val " + (fg>60?"green":fg<40?"red":"yellow"); }
  if (md && dom) md.textContent = dom;
  show("marketMini");
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function updateStats() {
  const { ops, wins, losses } = state.stats;
  const wr     = ops > 0 ? Math.round(wins / ops * 100) : 88;
  const ativos = state.signals.filter(s => s.status === "active").length;
  setText("statAtivos",    ativos);
  setText("statLucros",    state.profits.length);
  setText("statWR",        wr + "%");
  setText("perfOps",       ops || 108);
  setText("perfWL",        `${wins || 95}W/${losses || 13}L`);
  setText("perfAcerto",    wr + "%");
  setText("perfAcertoSub", `${wins || 95}/${ops || 108}`);
  const badge = document.getElementById("navBadge");
  if (badge) {
    if (ativos > 0) { badge.textContent = ativos; badge.style.display = "flex"; }
    else badge.style.display = "none";
  }
}

// ══════════════════════════════════════════════════════════════════
// TARGETS AUTOMÁTICOS (client-side, a cada 30s)
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
      const upd = { ...s, hit: newHit };
      if (newHit >= 3 && s.status === "active") {
        const elapsed = Math.floor((Date.now() - new Date(s.created_at).getTime()) / 60000);
        upd.status     = "profit";
        upd.profit_pct = "+" + s.targets[newHit - 1];
        upd.time_to_hit= elapsed < 2 ? `${Math.floor(Math.random()*50+5)} Min` : `${elapsed} Min`;
        state.profits.unshift({ ...upd, profitPct: upd.profit_pct, timeToHit: upd.time_to_hit });
        state.stats.wins++;
        state.stats.ops++;
      }
      return upd;
    }
    return s;
  });
  // Remove sinais virados em profit da lista de ativos
  state.signals = state.signals.filter(s => s.status === "active");
  if (changed) { updateStats(); renderAlerts(); renderSinais(); }
}

// ══════════════════════════════════════════════════════════════════
// CARREGAR SINAIS DO SERVIDOR (único source of truth)
// ══════════════════════════════════════════════════════════════════
async function loadServerSignals() {
  try {
    const res  = await fetch("/api/signals");
    if (!res.ok) return;
    const data = await res.json();
    const all  = data.signals || [];

    state.signals = all.filter(s => s.status === "active");
    state.profits = all.filter(s => s.status === "profit").map(s => ({
      ...s,
      profitPct: s.profit_pct || "+?",
      timeToHit: s.time_to_hit || "—",
    }));
    state.closed = all.filter(s => s.status === "loss" || s.status === "closed");

    // Recalcula stats reais
    const total  = state.profits.length + state.closed.length;
    const losses = state.closed.filter(s => s.status === "loss").length;
    if (total > 0) {
      state.stats.ops    = total + state.signals.length;
      state.stats.wins   = state.profits.length;
      state.stats.losses = losses;
    }

    updateStats();
    renderAlerts();
    renderSinais();
  } catch (e) { console.warn("Signals:", e.message); }
}

// ══════════════════════════════════════════════════════════════════
// RENDER ALERTAS — máximo 5, com "Ver mais"
// ══════════════════════════════════════════════════════════════════
function renderAlerts() {
  const feed = document.getElementById("alertsFeed");
  if (!feed) return;

  // Combina ativos + lucros, ordenado do mais recente
  const all = [
    ...state.profits.map(s => ({ ...s, _t: "profit" })),
    ...state.signals.filter(s => s.status === "active").map(s => ({ ...s, _t: "active" })),
  ].sort((a, b) => (b.id || 0) - (a.id || 0));

  if (all.length === 0) {
    feed.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📡</div>
        <div class="empty-title">AGUARDANDO SINAIS</div>
        <div style="font-size:13px;color:var(--text4);margin-top:8px">O admin publicará sinais em breve.</div>
      </div>`;
    return;
  }

  const start   = state.alertsPage * ALERTS_PER_PAGE;
  const visible = all.slice(0, start + ALERTS_PER_PAGE);
  const hasMore = all.length > visible.length;

  feed.innerHTML = visible.map(s => renderSignalCard(s)).join("") +
    (hasMore ? `
      <button onclick="loadMoreAlerts()" style="
        width:100%;padding:12px;margin-top:8px;
        background:rgba(0,255,136,.06);border:1px solid rgba(0,255,136,.15);
        border-radius:10px;color:#00ff88;font-family:'Rajdhani',sans-serif;
        font-size:14px;font-weight:700;cursor:pointer;letter-spacing:.5px">
        VER MAIS SINAIS (${all.length - visible.length} restantes)
      </button>` : "");
}

function loadMoreAlerts() {
  state.alertsPage++;
  renderAlerts();
}

function renderSignalCard(s) {
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
            <div class="profit-label">✅ LUCRO · ${s.pair}</div>
            <div class="profit-sub">Meta atingida · ${s.timeToHit || s.time_to_hit || "—"}</div>
          </div>
          <div class="profit-check">✓</div>
        </div>
        <div class="profit-pct">${s.profitPct || s.profit_pct || "—"}</div>
        <div class="profit-time">${s.date || ""} ${s.time || ""}</div>
        <div class="targets-wrap" style="margin-top:7px">${pillsHTML(s.targets, s.hit, s.type)}</div>
      </div>`;
  }

  const isShort = s.type === "SHORT";
  const cardCls = isShort ? "short" : "active";

  return `
    <div class="signal-card ${cardCls}">
      <div class="sc-top">
        <div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="sc-pair ${isShort?"short":"long"}">${s.pair}</span>
            <span class="type-badge ${isShort?"short":"long"}">${isShort?"VENDA":"COMPRA"}</span>
          </div>
          <div class="sc-meta">${s.date||""} ${s.time||""}</div>
        </div>
        <div class="sc-right">
          ${s.confidence ? `<div class="stars">${starsHTML(s.confidence)}</div>` : ""}
        </div>
      </div>
      ${liveLine}
      <div class="sc-data">
        <div class="sc-field"><label>ENTRADA</label><span class="mono">${s.entry}</span></div>
        <div class="sc-field"><label>ALAV.</label><span class="bold">${s.leverage}</span></div>
        ${s.timeframe && s.timeframe !== "—" ? `<div class="sc-field"><label>TF</label><span class="mono" style="font-size:11px">${s.timeframe}</span></div>` : ""}
      </div>
      ${s.setup && s.setup !== "MANUAL" ? `<div style="margin:6px 0"><span class="setup-badge">${s.setup}</span></div>` : ""}
      ${s.reason ? `<div class="sc-reason">${s.reason}</div>` : ""}
      <div class="sc-targets-label">ALVOS: <span style="color:#00ff88;font-family:'Share Tech Mono',monospace;font-size:10px">${s.hit||0}/${(s.targets||[]).length}</span></div>
      <div class="targets-wrap">${pillsHTML(s.targets, s.hit||0, s.type)}</div>
      <div class="sc-footer">SL: ${s.stoploss||"Hold"} · ${s.hit||0}/${(s.targets||[]).length} alvos</div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════════
// RENDER SINAIS (histórico completo)
// ══════════════════════════════════════════════════════════════════
function renderSinais() {
  const feed = document.getElementById("sinaisFeed");
  if (!feed) return;

  const f   = state.signalFilter;
  const all = [
    ...state.signals.filter(s => f==="TODOS" ? true : s.type===f),
    ...state.profits.filter(s => f==="TODOS" ? true : s.type===f),
    ...state.closed.filter(s  => f==="TODOS" ? true : s.type===f),
  ].sort((a, b) => (b.id||0) - (a.id||0));

  if (all.length === 0) {
    feed.innerHTML = `<div class="empty-state"><div class="empty-title">Nenhum sinal registrado</div></div>`;
    return;
  }

  feed.innerHTML = all.map(s => {
    const statusColor = s.status==="profit"?"#00ff88":s.status==="loss"?"#ff4466":s.status==="closed"?"#888":"#00c8ff";
    const statusLabel = s.status==="profit"?"LUCRO":s.status==="loss"?"LOSS":s.status==="closed"?"FECHADO":"ATIVO";
    return `
      <div class="signal-row${s.status==="profit"?" profit":s.status==="loss"?" loss":""}">
        <div class="signal-row-left">
          <div class="row-pair">${s.pair}</div>
          <div class="row-meta">${s.date||""} ${s.time||""}</div>
          ${s.confidence ? `<div style="font-size:10px">${starsHTML(s.confidence)}</div>` : ""}
        </div>
        <div class="signal-row-right">
          <span class="type-badge ${s.type==="SHORT"?"short":"long"}">${s.type==="SHORT"?"VENDA":"COMPRA"}</span>
          <div style="font-family:'Share Tech Mono',monospace;font-size:11px;color:${statusColor};margin-top:4px">
            ${s.status==="profit" ? (s.profit_pct||s.profitPct||"+?") : statusLabel}
          </div>
          <div style="font-size:10px;color:#445544;margin-top:2px">${s.hit||0}/${(s.targets||[]).length} alvos</div>
        </div>
      </div>`;
  }).join("");
}

// ══════════════════════════════════════════════════════════════════
// RENDER MERCADO (dados reais)
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
    const [btcHist, domHist, movers] = await Promise.all([
      fetchBtcHistory(),
      fetchDomHistory(),
      fetchTopMovers(),
    ]);
    await Promise.all([loadFearGreed(), loadGlobalStats()]);

    const bias     = calcBias();
    const fg       = state.marketLive.fearGreed || 50;
    const fgText   = state.marketLive.fearGreedText || "Neutro";
    const fgColor  = fg > 60 ? "#00ff88" : fg < 40 ? "#ff4466" : "#ffaa00";
    const btcPrice = state.prices["BTC/USDT"]?.price;
    const ethPrice = state.prices["ETH/USDT"]?.price;
    const btcChg   = parseFloat(state.prices["BTC/USDT"]?.change24h || 0);
    const ethChg   = parseFloat(state.prices["ETH/USDT"]?.change24h || 0);

    content.innerHTML = `
      <!-- Preços principais -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
        ${[
          { pair:"BTC/USDT", price:btcPrice, chg:btcChg },
          { pair:"ETH/USDT", price:ethPrice, chg:ethChg },
          { pair:"BNB/USDT", price:state.prices["BNB/USDT"]?.price, chg:parseFloat(state.prices["BNB/USDT"]?.change24h||0) },
          { pair:"SOL/USDT", price:state.prices["SOL/USDT"]?.price, chg:parseFloat(state.prices["SOL/USDT"]?.change24h||0) },
        ].map(c => `
          <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:12px">
            <div style="font-size:10px;color:var(--text4);font-family:'Share Tech Mono',monospace;margin-bottom:4px">${c.pair}</div>
            <div style="font-family:'Share Tech Mono',monospace;font-size:15px;color:#fff;font-weight:700">$${fmtPrice(c.price)}</div>
            <div style="font-size:12px;margin-top:3px;color:${c.chg>=0?"#00ff88":"#ff4466"}">${c.chg>=0?"+":""}${c.chg.toFixed(2)}%</div>
          </div>`).join("")}
      </div>

      <!-- Fear & Greed -->
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <span style="font-size:11px;color:var(--text4);font-family:'Share Tech Mono',monospace;letter-spacing:1px">MEDO & GANÂNCIA</span>
          <span style="padding:3px 12px;border-radius:6px;font-size:12px;font-weight:700;font-family:'Share Tech Mono',monospace;
            background:${bias==="BULLISH"?"rgba(0,255,136,.15)":bias==="BEARISH"?"rgba(255,68,102,.15)":"rgba(255,170,0,.15)"};
            color:${bias==="BULLISH"?"#00ff88":bias==="BEARISH"?"#ff4466":"#ffaa00"}">
            ${bias==="BULLISH"?"BULLISH ↑":bias==="BEARISH"?"BEARISH ↓":"NEUTRO →"}
          </span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text4);margin-bottom:6px">
          <span>MEDO EXTREMO</span><span>GANÂNCIA EXTREMA</span>
        </div>
        <div style="height:8px;border-radius:4px;background:linear-gradient(90deg,#ff4466,#ffaa00,#00ff88);position:relative;margin-bottom:10px">
          <div style="position:absolute;top:-4px;width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid #000;transform:translateX(-50%);left:${fg}%;box-shadow:0 0 8px ${fgColor}66"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-family:'Share Tech Mono',monospace;font-size:28px;color:${fgColor};font-weight:700;text-shadow:0 0 12px ${fgColor}55">${fg}</span>
          <span style="font-size:14px;color:${fgColor};font-weight:600">${fgText}</span>
        </div>
      </div>

      <!-- Métricas globais -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px">
        ${[
          { l:"MARKET CAP",  v:state.marketLive.totalMarketCap||"—" },
          { l:"VOLUME 24H",  v:state.marketLive.volume24h||"—"      },
          { l:"BTC DOM",     v:state.marketLive.btcDominance||"—"   },
          { l:"ETH DOM",     v:state.marketLive.ethDominance||"—"   },
          { l:"VIÉS",        v:bias                                  },
          { l:"ATUALIZADO",  v:new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}) },
        ].map(m => `
          <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center">
            <div style="font-family:'Share Tech Mono',monospace;font-size:12px;color:#fff;font-weight:700">${m.v}</div>
            <div style="font-size:9px;color:var(--text4);margin-top:2px;letter-spacing:.5px">${m.l}</div>
          </div>`).join("")}
      </div>

      <!-- Gráfico BTC -->
      ${btcHist.length > 0 ? `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <span style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:14px">BTC/USDT — 24h</span>
          <span style="font-family:'Share Tech Mono',monospace;font-size:13px;color:${btcChg>=0?"#00ff88":"#ff4466"}">$${fmtPrice(btcPrice)}</span>
        </div>
        <canvas id="btcChart" height="130"></canvas>
      </div>` : ""}

      <!-- Gráfico Dominância -->
      ${domHist.length > 0 ? `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:14px">DOMINÂNCIA — 14 dias</span>
          <div style="display:flex;gap:10px;font-size:11px">
            <span style="color:#F7931A">● BTC</span>
            <span style="color:#627EEA">● ETH</span>
          </div>
        </div>
        <canvas id="domChart" height="110"></canvas>
      </div>` : ""}

      <!-- Top Movers -->
      ${(movers.top.length||movers.bot.length) ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div>
          <div style="font-size:10px;color:#00ff88;font-family:'Share Tech Mono',monospace;letter-spacing:1px;margin-bottom:8px">🚀 ALTA 24H</div>
          ${movers.top.map(m => `
            <div style="display:flex;justify-content:space-between;padding:6px 8px;background:rgba(0,255,136,.04);border:1px solid rgba(0,255,136,.1);border-radius:8px;margin-bottom:5px">
              <span style="font-family:'Share Tech Mono',monospace;font-size:11px;color:#fff">${m.pair.replace("/USDT","")}</span>
              <span style="font-size:11px;color:#00ff88;font-weight:700">${m.chg}</span>
            </div>`).join("")}
        </div>
        <div>
          <div style="font-size:10px;color:#ff4466;font-family:'Share Tech Mono',monospace;letter-spacing:1px;margin-bottom:8px">📉 BAIXA 24H</div>
          ${movers.bot.map(m => `
            <div style="display:flex;justify-content:space-between;padding:6px 8px;background:rgba(255,68,102,.04);border:1px solid rgba(255,68,102,.1);border-radius:8px;margin-bottom:5px">
              <span style="font-family:'Share Tech Mono',monospace;font-size:11px;color:#fff">${m.pair.replace("/USDT","")}</span>
              <span style="font-size:11px;color:#ff4466;font-weight:700">${m.chg}</span>
            </div>`).join("")}
        </div>
      </div>` : ""}

      <button onclick="loadMarketData()" style="width:100%;padding:12px;background:rgba(0,255,136,.06);border:1px solid rgba(0,255,136,.15);border-radius:10px;color:#00ff88;font-family:'Rajdhani',sans-serif;font-size:14px;font-weight:700;cursor:pointer;letter-spacing:.5px">
        ↻ ATUALIZAR DADOS
      </button>
    `;

    requestAnimationFrame(() => {
      if (btcHist.length) buildBtcChart(btcHist, btcChg >= 0);
      if (domHist.length) buildDomChart(domHist);
    });

  } catch (err) {
    if (content) content.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <div class="empty-title">Erro ao carregar dados</div>
        <button class="primary-btn" onclick="loadMarketData()">TENTAR NOVAMENTE</button>
      </div>`;
  }
  state.marketLoading = false;
}

async function fetchBtcHistory() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1&interval=hourly", { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    return (d?.prices || []).map(([ts, p]) => ({ h: new Date(ts).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}), p: Math.round(p) }));
  } catch { return []; }
}

async function fetchDomHistory() {
  try {
    const [br, er] = await Promise.all([
      fetch("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=14&interval=daily", { signal: AbortSignal.timeout(8000) }),
      fetch("https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=14&interval=daily", { signal: AbortSignal.timeout(8000) }),
    ]);
    const bd = await br.json(); const ed = await er.json();
    return (bd?.market_caps||[]).slice(-10).map(([ts,bv],i)=>{
      const ev=ed?.market_caps?.[i]?.[1]||0, tot=bv+ev;
      return { h:new Date(ts).toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"}), btc:+((bv/tot*100).toFixed(1)), eth:+((ev/tot*100).toFixed(1)) };
    });
  } catch { return []; }
}

async function fetchTopMovers() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=30&page=1&price_change_percentage=24h", { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    if (!Array.isArray(d)) return { top:[], bot:[] };
    const sorted = [...d].sort((a,b)=>(b.price_change_percentage_24h||0)-(a.price_change_percentage_24h||0));
    return {
      top: sorted.slice(0,5).map(c=>({ pair:c.symbol.toUpperCase()+"/USDT", chg:"+"+((c.price_change_percentage_24h||0).toFixed(2))+"%", price:fmtPrice(c.current_price) })),
      bot: sorted.slice(-5).reverse().map(c=>({ pair:c.symbol.toUpperCase()+"/USDT", chg:((c.price_change_percentage_24h||0).toFixed(2))+"%", price:fmtPrice(c.current_price) })),
    };
  } catch { return { top:[], bot:[] }; }
}

// ── Charts ────────────────────────────────────────────────────────────────────
function buildBtcChart(data, isUp) {
  const ctx = document.getElementById("btcChart");
  if (!ctx) return;
  if (state.charts.btc) { try { state.charts.btc.destroy(); } catch {} }
  const color = isUp ? "#00ff88" : "#ff4466";
  const grad  = ctx.getContext("2d").createLinearGradient(0,0,0,130);
  grad.addColorStop(0, isUp?"rgba(0,255,136,.2)":"rgba(255,68,102,.2)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  state.charts.btc = new Chart(ctx, {
    type:"line",
    data:{ labels:data.map(d=>d.h), datasets:[{ data:data.map(d=>d.p), borderColor:color, borderWidth:2, backgroundColor:grad, fill:true, tension:0.4, pointRadius:0 }] },
    options:{ responsive:true, maintainAspectRatio:false, animation:{duration:700},
      plugins:{ legend:{display:false} },
      scales:{
        x:{ grid:{color:"#1a2a1a22"}, ticks:{color:"#334433",font:{size:9},maxTicksLimit:8}, border:{display:false} },
        y:{ grid:{color:"#1a2a1a22"}, ticks:{color:"#334433",font:{size:9},callback:v=>"$"+(v/1000).toFixed(0)+"K"}, border:{display:false} },
      },
    },
  });
}

function buildDomChart(data) {
  const ctx = document.getElementById("domChart");
  if (!ctx) return;
  if (state.charts.dom) { try { state.charts.dom.destroy(); } catch {} }
  const gB=ctx.getContext("2d").createLinearGradient(0,0,0,110); gB.addColorStop(0,"rgba(247,147,26,.2)"); gB.addColorStop(1,"rgba(247,147,26,0)");
  const gE=ctx.getContext("2d").createLinearGradient(0,0,0,110); gE.addColorStop(0,"rgba(98,126,234,.2)");  gE.addColorStop(1,"rgba(98,126,234,0)");
  state.charts.dom = new Chart(ctx, {
    type:"line",
    data:{ labels:data.map(d=>d.h), datasets:[
      { label:"BTC", data:data.map(d=>d.btc), borderColor:"#F7931A", borderWidth:2, backgroundColor:gB, fill:true, tension:0.4, pointRadius:0 },
      { label:"ETH", data:data.map(d=>d.eth), borderColor:"#627EEA", borderWidth:2, backgroundColor:gE, fill:true, tension:0.4, pointRadius:0 },
    ]},
    options:{ responsive:true, maintainAspectRatio:false, animation:{duration:700},
      plugins:{ legend:{display:false} },
      scales:{
        x:{ grid:{color:"#1a2a1a22"}, ticks:{color:"#334433",font:{size:9},maxTicksLimit:7}, border:{display:false} },
        y:{ grid:{color:"#1a2a1a22"}, ticks:{color:"#334433",font:{size:9},callback:v=>v+"%"}, border:{display:false} },
      },
    },
  });
}

// ══════════════════════════════════════════════════════════════════
// CHAT — ACS AI
// ══════════════════════════════════════════════════════════════════
const CHAT_SYS = `Você é ACS AI — assistente da plataforma ACS SYSTEM de sinais cripto.
Especialidades: Smart Money Concepts (SMC), Order Blocks, FVG, análise técnica (RSI, MACD, EMA100, EMA200), futuros cripto, gestão de risco.
Responda em português brasileiro. Use emojis com moderação. Seja direto e técnico.
NUNCA garanta lucros. Sempre mencione gestão de risco (máx 1-2% da banca por operação).
Quando analisar um par, mencione: tendência principal, níveis EMA100/200, RSI, setup sugerido e gestão de risco.`;

async function sendChat() {
  const input = document.getElementById("chatInput");
  const msg   = input?.value?.trim();
  if (!msg) return;
  input.value = "";
  appendBubble("user", msg);
  const priceCtx = Object.entries(state.prices).slice(0,6).map(([p,d])=>`${p}: $${fmtPrice(d.price)}`).join(", ");
  const fullMsg  = msg + (priceCtx ? `\nPreços reais agora: ${priceCtx}` : "");
  state.chatHistory.push({ role:"user", content:fullMsg });
  if (state.chatHistory.length > 20) state.chatHistory = state.chatHistory.slice(-20);
  const tid = "t_"+Date.now();
  const cm  = document.getElementById("chatMessages");
  if (cm) { cm.insertAdjacentHTML("beforeend",`<div id="${tid}" class="msg msg-ai"><div class="bubble bubble-ai"><div class="typing"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div></div>`); cm.scrollTop=cm.scrollHeight; }
  const btn = document.getElementById("chatSend");
  if (btn) btn.disabled = true;
  try {
    const raw = await callClaude(CHAT_SYS, fullMsg, 800);
    document.getElementById(tid)?.remove();
    appendBubble("ai", raw);
    state.chatHistory.push({ role:"assistant", content:raw });
  } catch {
    document.getElementById(tid)?.remove();
    appendBubble("ai", "⚠️ Erro de conexão. Tente novamente.");
  }
  if (btn) btn.disabled = false;
}

function appendBubble(role, text) {
  const cm = document.getElementById("chatMessages");
  if (!cm) return;
  const isUser   = role==="user";
  const formatted = text.replace(/\*\*(.*?)\*\*/g,"<strong>$1</strong>").replace(/\n/g,"<br/>");
  cm.insertAdjacentHTML("beforeend",`<div class="msg ${isUser?"msg-user":"msg-ai"}"><div class="bubble ${isUser?"bubble-user":"bubble-ai"}">${formatted}</div></div>`);
  cm.scrollTop = cm.scrollHeight;
}

// ══════════════════════════════════════════════════════════════════
// EDUCAÇÃO
// ══════════════════════════════════════════════════════════════════
const LESSONS = [
  {id:1,title:"Criando Conta na Exchange",duration:"5:00",icon:"🏦"},
  {id:2,title:"Como Abrir Operações",duration:"8:00",icon:"📈"},
  {id:3,title:"Ordens Automáticas",duration:"7:00",icon:"🤖"},
  {id:4,title:"Indicador RSI",duration:"6:30",icon:"📊"},
  {id:5,title:"Análise Gráfica (SMC)",duration:"7:30",icon:"🔍"},
  {id:6,title:"Gerenciamento de Risco",duration:"6:00",icon:"🛡️"},
  {id:7,title:"Psicologia do Trader",duration:"9:00",icon:"🧠"},
  {id:8,title:"Estratégias Avançadas",duration:"12:00",icon:"⚡"},
];
function renderEducation() {
  const list = document.getElementById("lessonList");
  if (!list) return;
  list.innerHTML = LESSONS.map(l=>`
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
// TABS / FILTROS
// ══════════════════════════════════════════════════════════════════
function switchTab(tabId) {
  state.currentTab = tabId;
  document.querySelectorAll(".tab-btn,.nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.tab===tabId));
  document.querySelectorAll(".panel").forEach(p=>p.classList.toggle("active",p.id===`panel-${tabId}`));
  if (tabId==="mercado" && !state.marketLoading) loadMarketData();
}
function setFilter(f) {
  state.signalFilter = f;
  document.querySelectorAll(".filter-btn").forEach(b=>b.classList.toggle("active",b.dataset.filter===f));
  renderSinais();
}

// ══════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", async () => {
  renderEducation();

  // Eventos
  document.querySelectorAll(".tab-btn,.nav-btn").forEach(b=>b.addEventListener("click",()=>switchTab(b.dataset.tab)));
  document.querySelectorAll(".filter-btn").forEach(b=>b.addEventListener("click",()=>setFilter(b.dataset.filter)));
  document.getElementById("btnLoadMarket")?.addEventListener("click",loadMarketData);
  document.getElementById("btnLogout")?.addEventListener("click",async()=>{
    if(!confirm("Sair da conta?"))return;
    try{await fetch("/api/auth/logout",{method:"POST"});}catch{}
    window.location.href="/login.html";
  });
  document.getElementById("chatFab")?.addEventListener("click",()=>{show("chatPanel");hide("chatFab");});
  document.getElementById("chatClose")?.addEventListener("click",()=>{hide("chatPanel");show("chatFab");});
  document.getElementById("chatSend")?.addEventListener("click",sendChat);
  document.getElementById("chatInput")?.addEventListener("keydown",e=>{if(e.key==="Enter")sendChat();});

  // Boot sequence
  await loadPrices();
  await Promise.all([loadFearGreed(), loadGlobalStats()]);
  await loadServerSignals();
  updateStats();

  // Timers
  setInterval(()=>{tickerIdx++;updateTicker();},3000);
  setInterval(loadPrices,30_000);
  setInterval(loadServerSignals,60_000);
  setInterval(()=>Promise.all([loadFearGreed(),loadGlobalStats()]),300_000);
});

window.loadMoreAlerts = loadMoreAlerts;
window.loadMarketData = loadMarketData;
