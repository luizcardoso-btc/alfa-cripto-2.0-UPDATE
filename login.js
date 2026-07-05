/* ══════════════════════════════════════════════
   login.js — Lógica do formulário de login
   ══════════════════════════════════════════════ */

"use strict";

const form = document.getElementById("loginForm");
const alertBox = document.getElementById("alertBox");
const submitBtn = document.getElementById("submitBtn");

function showAlert(message, type = "error") {
  alertBox.textContent = message;
  alertBox.className = "alert" + (type === "success" ? " success" : "");
  alertBox.style.display = "block";
}

function hideAlert() {
  alertBox.style.display = "none";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAlert();

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  submitBtn.disabled = true;
  submitBtn.textContent = "ENTRANDO...";

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (!res.ok) {
      const messages = {
        invalid_credentials: "Email ou senha incorretos.",
        subscription_inactive: "Sua assinatura não está ativa. Verifique seu pagamento ou contate o suporte.",
        subscription_expired: "Sua assinatura expirou. Renove para continuar acessando.",
        missing_fields: "Preencha email e senha.",
      };
      showAlert(messages[data.error] || data.message || "Não foi possível entrar. Tente novamente.");
      submitBtn.disabled = false;
      submitBtn.textContent = "ENTRAR";
      return;
    }

    showAlert("Login realizado! Redirecionando...", "success");
    setTimeout(() => { window.location.href = "/"; }, 600);
  } catch (err) {
    showAlert("Erro de conexão. Verifique sua internet e tente novamente.");
    submitBtn.disabled = false;
    submitBtn.textContent = "ENTRAR";
  }
});

// Se já estiver logado, manda direto pro app
fetch("/api/auth/me").then(res => {
  if (res.ok) window.location.href = "/";
}).catch(() => {});
