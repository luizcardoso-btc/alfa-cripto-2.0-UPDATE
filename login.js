/* ACS SYSTEM — login.js
   Login simples: email + senha gerada pelo admin
   Sem troca obrigatória de senha */

const form     = document.getElementById("loginForm");
const emailEl  = document.getElementById("email");
const passEl   = document.getElementById("password");
const submitEl = document.getElementById("submitBtn");
const alertEl  = document.getElementById("alertBox");

function showAlert(msg) {
  alertEl.textContent = msg;
  alertEl.style.display = "";
}
function hideAlert() { alertEl.style.display = "none"; }

function setLoading(v) {
  submitEl.disabled    = v;
  submitEl.textContent = v ? "Entrando..." : "ENTRAR";
}

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAlert();

  const email    = emailEl.value.trim();
  const password = passEl.value;
  if (!email || !password) { showAlert("Preencha email e senha."); return; }

  setLoading(true);
  try {
    const res  = await fetch("/api/auth/login", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (!res.ok) {
      const msgs = {
        invalid_credentials:   "Email ou senha incorretos.",
        subscription_inactive: "Assinatura inativa. Entre em contato com o suporte.",
        subscription_pending:  "Pagamento em processamento. Aguarde alguns minutos.",
        subscription_expired:  "Sua assinatura expirou. Renove para continuar.",
      };
      showAlert(msgs[data.error] || data.message || "Erro ao fazer login.");
      return;
    }

    // Login OK — redireciona para o app
    window.location.href = "/";

  } catch (err) {
    showAlert("Erro de conexão. Verifique sua internet e tente novamente.");
  } finally {
    setLoading(false);
  }
});

// Se já estiver logado, vai direto para o app
(async () => {
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) window.location.href = "/";
  } catch {}
})();
