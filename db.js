/**
 * db.js — ACS System · Data Layer
 *
 * Estratégia: JSON persistido em Volume Railway (Railway Volume mount em /data).
 * Write-through com tmp→rename para evitar corrupção em crash.
 * Migração automática de schema via migrateState().
 *
 * Entidades: users · sessions · signals · webhook_log
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ── Storage path ──────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH
  || path.join(__dirname, "data", "alfa-db.json");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ── Schema inicial ────────────────────────────────────────────────────────────
function emptyDB() {
  return {
    _version:       2,          // bump ao adicionar campos obrigatórios
    _nextUserId:    1,
    _nextSessionId: 1,
    _nextSignalId:  1,
    _nextLogId:     1,
    users:          [],
    sessions:       [],
    signals:        [],
    webhook_log:    [],
  };
}

// ── Migração incremental de schema ────────────────────────────────────────────
function migrateState(data) {
  // v1 → v2: campos de trial nos users
  data.users.forEach(u => {
    if (u.trial_started_at === undefined) u.trial_started_at = null;
    if (u.trial_ends_at    === undefined) u.trial_ends_at    = null;
    if (u.must_change_password === undefined) u.must_change_password = false;
  });

  // signals: closed_at / result_pct / must_change_password
  data.signals.forEach(s => {
    if (s.closed_at   === undefined) s.closed_at   = null;
    if (s.result_pct  === undefined) s.result_pct  = null;
    if (s.profit_pct  === undefined) s.profit_pct  = null;
  });

  // Garante campos de controle
  if (!data._nextSessionId) data._nextSessionId = 1;
  if (!data.webhook_log)    data.webhook_log     = [];
  if (!data._nextLogId)     data._nextLogId      = 1;
  data._version = 2;
  return data;
}

// ── I/O ───────────────────────────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const fresh = emptyDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  try {
    const raw  = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return migrateState(data);
  } catch (err) {
    console.error("⚠️  DB corrompido, reiniciando:", err.message);
    const fresh = emptyDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

function saveDB(data) {
  const tmp = DB_PATH + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DB_PATH);
  } catch (err) {
    console.error("⚠️  Erro ao salvar DB:", err.message);
  }
}

let state = loadDB();
const nowISO = () => new Date().toISOString();

// ── Helpers de trial ──────────────────────────────────────────────────────────
const TRIAL_DAYS         = 10;
const TRIAL_SIGNAL_LIMIT = 2;   // sinais visíveis após expiração

function computeTrialInfo(user) {
  if (!user) return null;

  const isPaid = user.plan && user.plan !== "trial";
  if (isPaid) {
    return {
      isTrial:         false,
      isPaid:          true,
      isExpired:       false,
      isActive:        false,
      daysLeft:        null,
      signalLimit:     null,  // sem limite
      trialEndsAt:     null,
    };
  }

  const now    = Date.now();
  const end    = user.trial_ends_at ? new Date(user.trial_ends_at).getTime() : null;
  const msLeft = end ? end - now : Infinity;
  const daysLeft = end
    ? Math.max(0, Math.ceil(msLeft / 86_400_000))
    : TRIAL_DAYS;
  const isExpired = msLeft <= 0;

  return {
    isTrial:         true,
    isPaid:          false,
    isActive:        !isExpired,
    isExpired,
    daysLeft,
    signalLimit:     isExpired ? TRIAL_SIGNAL_LIMIT : null,
    trialEndsAt:     user.trial_ends_at,
    trialStartedAt:  user.trial_started_at,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// USERS
// ═════════════════════════════════════════════════════════════════════════════
const users = {
  findById    (id)    { return state.users.find(u => u.id === id)             || null; },
  findByEmail (email) { return state.users.find(u => u.email === email)       || null; },
  all()               { return [...state.users].sort((a,b) => new Date(b.created_at) - new Date(a.created_at)); },

  /**
   * Cria usuário.
   * Se nenhum `plan` for passado → trial de 10 dias começa imediatamente.
   * Se `plan` for passado (ex.: vindo do webhook Eduzz) → sem trial.
   */
  create({ email, password_hash, name = "", eduzz_customer_id = null, plan = null }) {
    const isTrial   = !plan;
    const trialEnd  = new Date();
    trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);

    const user = {
      id:                   state._nextUserId++,
      email:                email.toLowerCase().trim(),
      password_hash,
      name,
      eduzz_customer_id,
      status:               "active",          // active | suspended | banned
      plan:                 isTrial ? "trial" : plan,
      trial_started_at:     isTrial ? nowISO() : null,
      trial_ends_at:        isTrial ? trialEnd.toISOString() : null,
      // campos de plano pago
      plan_expires_at:      null,              // quando o plano pago vence
      must_change_password: false,
      created_at:           nowISO(),
      updated_at:           nowISO(),
    };
    state.users.push(user);
    saveDB(state);
    return user;
  },

  update(id, patch) {
    const u = users.findById(id);
    if (!u) return null;

    // Se estiver ativando um plano pago → limpa trial
    if (patch.plan && patch.plan !== "trial") {
      patch.trial_started_at = null;
      patch.trial_ends_at    = null;
    }

    Object.assign(u, patch, { updated_at: nowISO() });
    saveDB(state);
    return u;
  },

  updateByEmail(email, patch) {
    const u = users.findByEmail(email);
    if (!u) return null;
    return users.update(u.id, patch);
  },

  delete(id) {
    const before = state.users.length;
    state.users   = state.users.filter(u => u.id !== id);
    state.sessions = state.sessions.filter(s => s.user_id !== id);
    if (state.users.length !== before) { saveDB(state); return true; }
    return false;
  },

  /** Status completo de trial/plano — usado pelo frontend e API */
  getTrialInfo: computeTrialInfo,

  /** Campos que vão para o cliente (remove senha e campos internos) */
  sanitize(u) {
    if (!u) return null;
    const { password_hash, ...rest } = u;
    return { ...rest, trial: computeTrialInfo(u) };
  },

  stats() {
    const all    = state.users;
    const trials = all.filter(u => u.plan === "trial");
    const paid   = all.filter(u => u.plan && u.plan !== "trial" && u.status === "active");
    const expiredTrials = trials.filter(u => {
      const end = u.trial_ends_at ? new Date(u.trial_ends_at) : null;
      return end && end < new Date();
    });
    return {
      total:          all.length,
      active_trials:  trials.length - expiredTrials.length,
      expired_trials: expiredTrials.length,
      paid:           paid.length,
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// SESSIONS
// ═════════════════════════════════════════════════════════════════════════════
const sessions = {
  create(id, userId, expiresAt) {
    state.sessions.push({
      id, user_id: userId, expires_at: expiresAt, created_at: nowISO(),
    });
    saveDB(state);
  },

  find(id) {
    const s = state.sessions.find(s => s.id === id);
    if (!s) return null;
    if (new Date(s.expires_at) < new Date()) { sessions.destroy(id); return null; }
    return s;
  },

  destroy(id) {
    state.sessions = state.sessions.filter(s => s.id !== id);
    saveDB(state);
  },

  cleanExpired() {
    const before = state.sessions.length;
    state.sessions = state.sessions.filter(s => new Date(s.expires_at) >= new Date());
    if (state.sessions.length !== before) saveDB(state);
    return before - state.sessions.length;
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// SIGNALS
// ═════════════════════════════════════════════════════════════════════════════
const signals = {
  all()          { return [...state.signals].sort((a,b) => new Date(b.created_at) - new Date(a.created_at)); },
  active()       { return state.signals.filter(s => s.status === "active"); },
  findById(id)   { return state.signals.find(s => s.id === id) || null; },

  create({ pair, type, entry, leverage, stoploss, targets, reason, timeframe, setup, confidence, source }) {
    const sig = {
      id:          state._nextSignalId++,
      pair:        pair    || "BTC/USDT",
      type:        type    || "LONG",
      entry:       String(entry || "0"),
      leverage:    leverage || "10x-20x",
      stoploss:    stoploss || "Hold",
      targets:     targets  || ["3%","20%","40%","60%","80%","100%","120%","140%","160%","180%","200%+"],
      hit:         0,
      reason:      reason    || "",
      timeframe:   timeframe || "—",
      setup:       setup     || "MANUAL",
      confidence:  confidence || 3,
      source:      source     || "admin",   // admin | ai | webhook
      status:      "active",                // active | profit | loss | closed
      profit_pct:  null,
      time_to_hit: null,
      closed_at:   null,
      result_pct:  null,
      created_at:  nowISO(),
      updated_at:  nowISO(),
    };
    state.signals.push(sig);
    saveDB(state);
    return sig;
  },

  update(id, patch) {
    const s = signals.findById(id);
    if (!s) return null;
    Object.assign(s, patch, { updated_at: nowISO() });
    saveDB(state);
    return s;
  },

  delete(id) {
    const before = state.signals.length;
    state.signals = state.signals.filter(s => s.id !== id);
    if (state.signals.length !== before) { saveDB(state); return true; }
    return false;
  },

  /**
   * Verifica se currentPrice atingiu novos alvos.
   * Retorna { signal, newTargetsHit[] } para que o caller possa enviar notificações.
   */
  checkTargets(id, currentPrice) {
    const s = signals.findById(id);
    if (!s || s.status !== "active") return { signal: s, newTargetsHit: [] };

    const entryNum = parseFloat(s.entry.replace(/[^0-9.]/g, ""));
    if (!entryNum) return { signal: s, newTargetsHit: [] };

    const newTargetsHit = [];
    let newHit = s.hit;

    s.targets.forEach((tgt, i) => {
      const pct  = parseFloat(tgt);
      if (isNaN(pct) || i < s.hit) return;

      const price  = s.type === "LONG"
        ? entryNum * (1 + pct / 100)
        : entryNum * (1 - pct / 100);

      const reached = s.type === "LONG"
        ? currentPrice >= price
        : currentPrice <= price;

      if (reached) { newHit = i + 1; newTargetsHit.push(tgt); }
    });

    if (newHit > s.hit) {
      const elapsedMin = Math.floor((Date.now() - new Date(s.created_at).getTime()) / 60_000);
      const patch = { hit: newHit };

      if (newHit >= 3) {
        patch.status      = "profit";
        patch.profit_pct  = "+" + s.targets[newHit - 1];
        patch.result_pct  = parseFloat(s.targets[newHit - 1]);
        patch.time_to_hit = elapsedMin < 60
          ? `${elapsedMin}min`
          : `${Math.floor(elapsedMin / 60)}h ${elapsedMin % 60}min`;
        patch.closed_at   = nowISO();
      }

      signals.update(id, patch);
    }

    return { signal: signals.findById(id), newTargetsHit };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// WEBHOOK LOG
// ═════════════════════════════════════════════════════════════════════════════
const webhookLog = {
  add(source, event, payload) {
    state.webhook_log.push({
      id: state._nextLogId++, source, event,
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
      created_at: nowISO(),
    });
    // Mantém apenas últimos 500 registros
    if (state.webhook_log.length > 500)
      state.webhook_log = state.webhook_log.slice(-500);
    saveDB(state);
  },
  recent(limit = 50) { return [...state.webhook_log].reverse().slice(0, limit); },
};

// ═════════════════════════════════════════════════════════════════════════════
// REPORTS
// ═════════════════════════════════════════════════════════════════════════════
const reports = {
  byMonth(year, month) {
    return state.signals.filter(s => {
      const d = new Date(s.created_at);
      return d.getFullYear() === year && (d.getMonth() + 1) === month;
    });
  },

  byRange(from, to) {
    const f = new Date(from);
    const t = new Date(to); t.setHours(23, 59, 59, 999);
    return state.signals.filter(s => {
      const d = new Date(s.created_at);
      return d >= f && d <= t;
    });
  },

  metrics(sigs) {
    const profits    = sigs.filter(s => s.status === "profit");
    const losses     = sigs.filter(s => s.status === "loss");
    const closed     = sigs.filter(s => s.status === "closed");
    const encerrados = profits.length + losses.length + closed.length;

    const assertividade = encerrados > 0
      ? Math.round(profits.length / (profits.length + losses.length || 1) * 100)
      : null;

    const pcts = profits
      .map(s => parseFloat(s.result_pct || (s.profit_pct || "").replace(/[^0-9.-]/g, "")) || 0)
      .filter(v => v > 0);

    const pairsCount = {};
    sigs.forEach(s => { pairsCount[s.pair] = (pairsCount[s.pair] || 0) + 1; });
    const topPairs = Object.entries(pairsCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([pair, count]) => ({ pair, count }));

    return {
      total:        sigs.length,
      active:       sigs.filter(s => s.status === "active").length,
      encerrados,
      wins:         profits.length,
      losses:       losses.length,
      closed:       closed.length,
      assertividade,
      lucroMedio:   pcts.length ? (pcts.reduce((a,b) => a+b,0) / pcts.length).toFixed(1) : null,
      lucroTotal:   pcts.reduce((a,b) => a+b,0).toFixed(1),
      maiorLucro:   pcts.length ? Math.max(...pcts).toFixed(1) : null,
      topPairs,
    };
  },

  availableMonths() {
    const months = new Set(state.signals.map(s => {
      const d = new Date(s.created_at);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }));
    return [...months].sort().reverse();
  },
};

// ── Constantes exportadas ─────────────────────────────────────────────────────
module.exports = {
  users,
  sessions,
  signals,
  webhookLog,
  reports,
  TRIAL_DAYS,
  TRIAL_SIGNAL_LIMIT,
};
