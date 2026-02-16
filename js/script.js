let step = 1;
let cliente = "";

const loginView = document.getElementById("loginView");
const chatView = document.getElementById("chatView");

const loginError = document.getElementById("loginError");
const loginUser = document.getElementById("loginUser");
const loginPass = document.getElementById("loginPass");

const typingIndicator = document.getElementById("typingIndicator");
const sessionInfo = document.getElementById("sessionInfo");

const userInput = document.getElementById("userInput");
const sendBtn = document.getElementById("sendBtn");

// Credenciales del prototipo
const ADMIN_USER = "admin";
const ADMIN_PASS = "admin";

// “DB” ficticia
const erroresDB = {
  "E001": { descripcion: "Error de conexión con base de datos", solucion: "Verificar servidor SQL y credenciales." },
  "E002": { descripcion: "Timeout en API externa", solucion: "Revisar conectividad o estado del servicio." },
  "E003": { descripcion: "Error de autenticación", solucion: "Validar token o sesión del usuario." }
};

// Mantener sesión simple (prototipo)
window.addEventListener("load", () => {
  const isLogged = localStorage.getItem("isLogged") === "true";
  if (isLogged) showChat();
});

function handleLogin() {
  const u = loginUser.value.trim();
  const p = loginPass.value.trim();

  if (u === ADMIN_USER && p === ADMIN_PASS) {
    localStorage.setItem("isLogged", "true");
    showChat();
  } else {
    loginError.classList.remove("hidden");
  }
}

function showChat() {
  loginView.classList.add("hidden");
  chatView.classList.remove("hidden");

  loginError.classList.add("hidden");
  loginUser.value = "";
  loginPass.value = "";

  // habilitar chat
  userInput.disabled = false;
  sendBtn.disabled = false;

  // info sesión
  const now = new Date();
  sessionInfo.innerText = `Sesión iniciada: ${now.toLocaleString()}`;

  // foco al input
  userInput.focus();
}

function logout() {
  localStorage.removeItem("isLogged");
  location.reload();
}

function handleMessage() {
  const message = userInput.value.trim();
  if (message === "") return;

  addMessage(message, "user-message");
  userInput.value = "";

  showTyping();

  setTimeout(() => {
    botLogic(message);
    hideTyping();
  }, 1500); // delay mínimo
}

function addMessage(text, className) {
  const chatBox = document.getElementById("chatBox");
  const div = document.createElement("div");
  div.className = className;
  div.innerText = text;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function addErrorCard(errorData) {
  const chatBox = document.getElementById("chatBox");

  const card = document.createElement("div");
  card.className = "error-card";
  card.innerHTML = `
    <strong>⚠ Error detectado</strong><br>
    <b>Descripción:</b> ${errorData.descripcion}<br>
    <b>Solución:</b> ${errorData.solucion}
  `;

  chatBox.appendChild(card);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function showTyping() {
  typingIndicator.classList.remove("hidden");
}

function hideTyping() {
  typingIndicator.classList.add("hidden");
}

function botLogic(message) {
  if (step === 1) {
    cliente = message;
    addMessage(`Gracias ${cliente}. Ahora ingresá el código de error.`, "bot-message");
    step = 2;
  } else if (step === 2) {
    const error = erroresDB[message.toUpperCase()];

    if (error) {
      addMessage("Buscando información del error...", "bot-message");
      setTimeout(() => addErrorCard(error), 800);
    } else {
      addMessage("❌ No se encontró ese código de error.", "bot-message");
    }
  }
}

// Enter para login también
document.addEventListener("keydown", (e) => {
  const chatVisible = !chatView.classList.contains("hidden");
  const loginVisible = !loginView.classList.contains("hidden");

  if (loginVisible && e.key === "Enter") handleLogin();
  if (chatVisible && e.key === "Enter") handleMessage();
});
