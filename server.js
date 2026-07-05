/* ══════════════════════════════════════════════
   ACS SYSTEM — server.js v4
   Rotas de sinais admin COMPLETAS e na ordem certa
   ══════════════════════════════════════════════ */

require("dotenv").config();
const express = require("express");
const path    = require("path");
const db      = require("./db");
const auth    = require("./auth");
const eduzz   = require("./eduzz");

const app  = express();
const PORT = process.env.PORT || 3000;
const API_KEY   = process.env.ANTHROPIC_API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!API_KEY) {
  console.error("\n❌ ANTHROPIC_API_KEY não encontrada no .env\n");
  process.exit(1);
}

// ── Admin middleware ──────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(500).json({ error: "admin_not_configured" });
  const key = req.headers["x-admin-key"] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

// ── Demo user (modo local) ────────────────────────────────────────
const DEMO_EMAIL    = "teste@local.com";
const DEMO_PASSWORD = "teste123";
if (process.env.NODE_ENV !== "production" && db.users.all().length === 0) {
  const hash = auth.hashPassword(DEMO_PASSWORD);
  db.users.create({ email: DEMO_EMAIL, password_hash: hash, name: "Conta de Teste", plan: "Demo Local" });
  console.log(`\n👤 Conta de teste: ${DEMO_EMAIL} / ${DEMO_PASSWORD}\n`);
}

function sanitizeUser(user) {
  if (!user) return user;
  const { password_hash, ...safe } = user;
  return safe;
}

// ── Body parsing ──────────────────────────────────────────────────
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString("utf8"); },
}));

// ══════════════════════════════════════════════
// PREÇOS REAIS — CoinGecko (cache 30s)
// ══════════════════════════════════════════════
let priceCache = { data: null, fetchedAt: 0 };

const COINGECKO_IDS = [
  "bitcoin","ethereum","binancecoin","solana","ripple","cardano",
  "avalanche-2","chainlink","dogecoin","arbitrum","optimism",
  "injective-protocol","toncoin","sui","pepe","worldcoin-wld",
  "near","fantom","aptos"
].join(",");

const PAIR_MAP = {
  "bitcoin":            "BTC/USDT",
  "ethereum":           "ETH/USDT",
  "binancecoin":        "BNB/USDT",
  "solana":             "SOL/USDT",
  "ripple":             "XRP/USDT",
  "cardano":            "ADA/USDT",
  "avalanche-2":        "AVAX/USDT",
  "chainlink":          "LINK/USDT",
  "dogecoin":           "DOGE/USDT",
  "arbitrum":           "ARB/USDT",
  "optimism":           "OP/USDT",
  "injective-protocol": "INJ/USDT",
  "toncoin":            "TON/USDT",
  "sui":                "SUI/USDT",
  "pepe":               "PEPE/USDT",
  "worldcoin-wld":      "WLD/USDT",
  "near":               "NEAR/USDT",
  "fantom":             "FTM/USDT",
  "aptos":              "APT/USDT",
};

async function fetchPrices() {
  const now = Date.now();
  if (priceCache.data && now - priceCache.fetchedAt < 30_000) return priceCache.data;
  try {
    const url  = `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_IDS}&vs_currencies=usd&include_24hr_change=true`;
    const resp = await fetch(url, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
    const raw = await resp.json();
    const prices = {};
    for (const [id, pair] of Object.entries(PAIR_MAP)) {
      if (raw[id]) prices[pair] = { price: raw[id].usd, change24h: raw[id].usd_24h_change?.toFixed(2) ?? "0" };
    }
    priceCache = { data: prices, fetchedAt: Date.now() };
    return prices;
  } catch (err) {
    console.error("⚠️ CoinGecko:", err.message);
    return priceCache.data || null;
  }
}

// Verifica targets a cada 30s
async function checkSignalTargets() {
  const active = db.signals.active();
  if (!active.length) return;
  const prices = await fetchPrices();
  if (!prices) return;
  for (const sig of active) {
    const priceObj = prices[sig.pair];
    if (priceObj) db.signals.checkTargets(sig.id, priceObj.price);
  }
}
setInterval(checkSignalTargets, 30_000);

// ══════════════════════════════════════════════
// ROTAS PÚBLICAS — Preços e Sinais (usuário logado)
// ══════════════════════════════════════════════
app.get("/api/prices", auth.requireAuth, async (req, res) => {
  const prices = await fetchPrices();
  if (!prices) return res.status(503).json({ error: "prices_unavailable" });
  res.json({ prices, fetchedAt: new Date(priceCache.fetchedAt).toISOString() });
});

app.get("/api/signals", auth.requireAuth, (req, res) => {
  res.json({ signals: db.signals.all() });
});

// ══════════════════════════════════════════════
// WEBHOOK Eduzz
// ══════════════════════════════════════════════
app.post("/webhook/eduzz", eduzz.webhookHandler);

// ══════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: "missing_fields", message: "Informe email e senha." });
  const user = db.users.findByEmail(email.toLowerCase().trim());
  if (!user || !auth.verifyPassword(password, user.password_hash))
    return res.status(401).json({ error: "invalid_credentials", message: "Email ou senha incorretos." });
  if (user.status !== "active")
    return res.status(403).json({ error: "subscription_inactive", message: "Assinatura inativa." });
  if (user.expires_at && new Date(user.expires_at) < new Date()) {
    db.users.update(user.id, { status: "inactive" });
    return res.status(403).json({ error: "subscription_expired", message: "Assinatura expirada." });
  }
  const session = auth.createSession(user.id);
  auth.setSessionCookie(res, session.id);
  res.json({ ok: true, user: { email: user.email, name: user.name, plan: user.plan } });
});

app.post("/api/auth/logout", (req, res) => {
  const cookies = auth.parseCookies(req);
  if (cookies[auth.COOKIE_NAME]) auth.destroySession(cookies[auth.COOKIE_NAME]);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const cookies = auth.parseCookies(req);
  const user = auth.getSession(cookies[auth.COOKIE_NAME]);
  if (!user || user.status !== "active") return res.status(401).json({ error: "not_authenticated" });
  res.json({ email: user.email, name: user.name, plan: user.plan, expires_at: user.expires_at });
});

app.post("/api/auth/change-password", auth.requireAuth, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6)
    return res.status(400).json({ error: "weak_password", message: "Mínimo 6 caracteres." });
  db.users.update(req.user.id, { password_hash: auth.hashPassword(newPassword) });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════
// ADMIN — Usuários
// ══════════════════════════════════════════════
app.get("/api/admin/users", requireAdmin, (req, res) => {
  res.json({ users: db.users.all().map(sanitizeUser) });
});

app.post("/api/admin/users", requireAdmin, (req, res) => {
  const { email, password, name, plan } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: "missing_fields", message: "Email e senha obrigatórios." });
  const norm = email.toLowerCase().trim();
  if (db.users.findByEmail(norm))
    return res.status(409).json({ error: "already_exists", message: "Email já cadastrado." });
  const user = db.users.create({ email: norm, password_hash: auth.hashPassword(password), name, plan });
  res.json({ ok: true, user: sanitizeUser(user) });
});

app.patch("/api/admin/users/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { status, plan, name, expires_at, newPassword } = req.body || {};
  const patch = {};
  if (status     !== undefined) patch.status     = status;
  if (plan       !== undefined) patch.plan       = plan;
  if (name       !== undefined) patch.name       = name;
  if (expires_at !== undefined) patch.expires_at = expires_at;
  if (newPassword) patch.password_hash = auth.hashPassword(newPassword);
  const user = db.users.update(id, patch);
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true, user: sanitizeUser(user) });
});

app.get("/api/admin/webhook-log", requireAdmin, (req, res) => {
  res.json({ logs: db.webhookLog.recent(50) });
});

// ══════════════════════════════════════════════
// ADMIN — Sinais
// ATENÇÃO: rota estática (/check-targets) ANTES da dinâmica (/:id)
// ══════════════════════════════════════════════

// Listar todos
app.get("/api/admin/signals", requireAdmin, (req, res) => {
  res.json({ signals: db.signals.all() });
});

// ⚡ Rota estática ANTES de /:id para não ser capturada como parâmetro
app.post("/api/admin/signals/check-targets", requireAdmin, async (req, res) => {
  await checkSignalTargets();
  res.json({ ok: true, checked: db.signals.active().length });
});

// Criar sinal
app.post("/api/admin/signals", requireAdmin, (req, res) => {
  const { pair, type, entry, leverage, stoploss, targets, reason, timeframe, setup, confidence, source } = req.body || {};
  if (!pair || !entry)
    return res.status(400).json({ error: "missing_fields", message: "Par e entrada são obrigatórios." });
  const sig = db.signals.create({
    pair, type, entry, leverage, stoploss, targets, reason, timeframe, setup, confidence,
    source: source || "admin",
  });
  res.json({ ok: true, signal: sig });
});

// Editar sinal
app.patch("/api/admin/signals/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const allowed = ["pair","type","entry","leverage","stoploss","targets","reason","timeframe","setup","confidence","status","hit","profit_pct","time_to_hit"];
  const patch = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  }
  const sig = db.signals.update(id, patch);
  if (!sig) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true, signal: sig });
});

// Deletar sinal
app.delete("/api/admin/signals/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const ok = db.signals.delete(id);
  if (!ok) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════
// PROXY CLAUDE (sessão de usuário OU admin key)
// ══════════════════════════════════════════════
app.post("/api/claude", async (req, res) => {
  // Aceita tanto sessão de usuário quanto admin key
  const cookies  = auth.parseCookies(req);
  const userSess = auth.getSession(cookies[auth.COOKIE_NAME]);
  const adminKey = req.headers["x-admin-key"];
  const isAdmin  = ADMIN_KEY && adminKey === ADMIN_KEY;
  const isUser   = userSess && userSess.status === "active";

  if (!isAdmin && !isUser)
    return res.status(401).json({ error: "unauthorized" });

  try {
    const { system, messages, max_tokens } = req.body;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: max_tokens || 2000,
        system, messages,
      }),
    });
    const data = await response.json();
    if (!response.ok) { console.error("Anthropic erro:", data); return res.status(response.status).json(data); }
    res.json(data);
  } catch (err) {
    console.error("Proxy Claude:", err);
    res.status(500).json({ error: "internal_error", details: err.message });
  }
});

// ══════════════════════════════════════════════
// PÁGINAS
// ══════════════════════════════════════════════
const ROOT = path.join(__dirname);

// Admin — sem autenticação de sessão (usa ADMIN_KEY no frontend)
app.get("/admin.html", (req, res) => res.sendFile(path.join(ROOT, "admin.html")));

// App — protegido por sessão
app.get(["/", "/index.html"], auth.requirePageAuth, (req, res) => res.sendFile(path.join(ROOT, "index.html")));
app.get("/app.js",            auth.requirePageAuth, (req, res) => res.sendFile(path.join(ROOT, "app.js")));
app.get("/style.css",         auth.requirePageAuth, (req, res) => res.sendFile(path.join(ROOT, "style.css")));

// Arquivos estáticos públicos (login.html, login.css, login.js)
app.use(express.static(ROOT));

// ══════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🚀 ACS SYSTEM rodando na porta ${PORT}`);
  console.log(`   Login:   /login.html`);
  console.log(`   App:     /`);
  console.log(`   Admin:   /admin.html\n`);
});

setInterval(() => db.sessions.cleanExpired(), 60 * 60 * 1000).unref();
