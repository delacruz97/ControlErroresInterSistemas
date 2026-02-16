// ----------------- Seguridad / sesión -----------------
window.addEventListener("load", async () => {
  const isLogged = localStorage.getItem("isLogged") === "true";
  if (!isLogged) {
    window.location.href = "../html/index.html";
    return;
  }

  const now = new Date();
  document.getElementById("sessionInfo").innerText =
    `Sesión iniciada: ${now.toLocaleString()}`;

  // Input deshabilitado mientras carga
  setInputEnabled(false);

  // Cargar bases SIN mostrar nada en el chat
  await loadClientesFromJson();
  await loadErroresFromJson();

  // Habilitar input al terminar
  setInputEnabled(true);
});

function logout() {
  localStorage.removeItem("isLogged");
  window.location.href = "../html/index.html";
}

function setInputEnabled(enabled) {
  const input = document.getElementById("userInput");
  const btn = document.getElementById("sendBtn");
  input.disabled = !enabled;
  btn.disabled = !enabled;
  if (enabled) input.focus();
}

// ----------------- DBs en memoria -----------------
let clientesList = [];
let clientesById = {};     // "1001" -> cliente
let erroresByCode = {};    // "VEN-001" -> error

async function loadClientesFromJson() {
  try {
    const res = await fetch("../data/clientes.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    clientesList = Array.isArray(data.Clientes) ? data.Clientes : [];
    clientesById = {};
    for (const c of clientesList) {
      clientesById[String(c.IdCliente)] = c;
    }
  } catch (e) {
    console.error("Error cargando clientes.json:", e);
    // si falla, avisamos de forma corta y útil
    addMessage("⚠ No se pudo cargar la base de clientes. Revisá el servidor local.", "bot-message");
  }
}

async function loadErroresFromJson() {
  try {
    const res = await fetch("../data/errores.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    erroresByCode = {};
    for (const err of (data.Errores || [])) {
      if (err.IdCodigo) erroresByCode[String(err.IdCodigo).toUpperCase()] = err;
    }
  } catch (e) {
    console.error("Error cargando errores.json:", e);
    addMessage("⚠ No se pudo cargar la base de errores. Revisá el servidor local.", "bot-message");
  }
}

// ----------------- Estado del chat -----------------
let step = 1;        // 1 = pedir cliente, 2 = pedir error
let cliente = null;  // objeto cliente validado

// ----------------- Historial último error por cliente -----------------
function saveLastErrorForClient(clientId, errorObj) {
  const store = JSON.parse(localStorage.getItem("lastErrorsByClient") || "{}");
  store[clientId] = {
    IdCodigo: errorObj.IdCodigo || "",
    Modulo: errorObj.Modulo || "",
    Procedimiento: errorObj.Procedimiento || "",
    Mensaje: errorObj.Mensaje || "",
    fecha: new Date().toISOString()
  };
  localStorage.setItem("lastErrorsByClient", JSON.stringify(store));
}

function getLastErrorForClient(clientId) {
  const store = JSON.parse(localStorage.getItem("lastErrorsByClient") || "{}");
  return store[clientId] || null;
}

// ----------------- Typing dinámico (solo antes de responder) -----------------
let typingElement = null;

function showTyping() {
  const chatBox = document.getElementById("chatBox");
  typingElement = document.createElement("div");
  typingElement.className = "bot-message typing";
  typingElement.innerHTML = `
    <div class="dot"></div>
    <div class="dot"></div>
    <div class="dot"></div>
  `;
  chatBox.appendChild(typingElement);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function removeTyping() {
  if (typingElement) {
    typingElement.remove();
    typingElement = null;
  }
}

// ----------------- UI helpers -----------------
function handleMessage() {
  const input = document.getElementById("userInput");
  const message = input.value.trim();
  if (!message) return;

  addMessage(message, "user-message");
  input.value = "";

  showTyping();
  setTimeout(() => {
    removeTyping();
    botLogic(message);
  }, 900);
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
    <b>Código:</b> ${escapeHtml(errorData.IdCodigo || "-")}<br>
    <b>Módulo:</b> ${escapeHtml(errorData.Modulo || "-")}<br>
    <b>Procedimiento:</b> ${escapeHtml(errorData.Procedimiento || "-")}<br>
    <b>Mensaje:</b> ${escapeHtml(errorData.Mensaje || "-")}
  `;
  chatBox.appendChild(card);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function addQuickActions(htmlButtons) {
  const chatBox = document.getElementById("chatBox");
  const wrap = document.createElement("div");
  wrap.className = "quick-actions";
  wrap.innerHTML = htmlButtons;
  chatBox.appendChild(wrap);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ----------------- Sugerencias de cliente -----------------
function normalizeText(s) {
  return String(s)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function levenshtein(a, b) {
  a = normalizeText(a);
  b = normalizeText(b);

  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function getClientSuggestions(input, max = 5) {
  const q = normalizeText(input);
  if (!q) return [];

  const scored = clientesList.map(c => {
    const name = normalizeText(c.Nombre);
    const id = String(c.IdCliente);

    let score = 999;
    if (q === id || q === name) score = 0;
    else if (name.startsWith(q) || id.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else score = 3 + Math.min(levenshtein(q, name), 20) / 10;

    return { c, score };
  });

  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, max)
    .map(x => x.c);
}

function findClient(input) {
  const raw = String(input).trim();
  if (!raw) return null;

  if (clientesById[raw]) return clientesById[raw];

  const q = normalizeText(raw);
  const found = clientesList.find(c => normalizeText(c.Nombre) === q);
  return found || null;
}

function selectClientById(id) {
  const c = clientesById[String(id)];
  if (!c) return;

  if (!c.Activo) {
    addMessage(`⚠ El cliente "${c.Nombre}" está inactivo.`, "bot-message");
    return;
  }

  cliente = c;
  step = 2;
  addMessage(`✅ Cliente validado: ${cliente.Nombre} (ID: ${cliente.IdCliente}). Ahora ingresá el código de error.`, "bot-message");
}

// ----------------- Botones (event delegation) -----------------
document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;

  const action = btn.getAttribute("data-action");

  if (action === "selectClient") {
    const id = btn.getAttribute("data-id");
    selectClientById(id);
    return;
  }

  if (action === "retryError") {
    addMessage("Ok. Ingresá otro código de error.", "bot-message");
    return;
  }

  if (action === "lastError") {
    if (!cliente) {
      addMessage("Primero validemos un cliente. Ingresá el ID o nombre.", "bot-message");
      step = 1;
      return;
    }
    const last = getLastErrorForClient(cliente.IdCliente);
    if (!last) {
      addMessage(`No tengo un último error guardado para "${cliente.Nombre}".`, "bot-message");
      return;
    }
    addMessage(`📌 Último error para ${cliente.Nombre}: ${last.IdCodigo}`, "bot-message");
    addErrorCard(last);
    return;
  }

  if (action === "listCodes") {
    const codes = Object.keys(erroresByCode);
    if (codes.length === 0) {
      addMessage("No hay códigos cargados. Revisá errores.json.", "bot-message");
      return;
    }
    addMessage(`Códigos disponibles: ${codes.join(", ")}`, "bot-message");
    return;
  }

  if (action === "changeClient") {
    cliente = null;
    step = 1;
    addMessage("Perfecto. Ingresá el número o el nombre del cliente.", "bot-message");
    return;
  }
});

// ----------------- Lógica principal -----------------
function botLogic(message) {
  if (step === 1) {
    const found = findClient(message);

    if (!found) {
      addMessage("❌ Cliente no encontrado. ¿Quisiste decir alguno de estos?", "bot-message");

      const sug = getClientSuggestions(message, 5);
      if (sug.length === 0) {
        addMessage("Probá con el ID exacto o el nombre completo.", "bot-message");
        return;
      }

      const buttons = sug.map(c => {
        const label = `${c.Nombre} (ID: ${c.IdCliente})${c.Activo ? "" : " [INACTIVO]"}`;
        const disabled = c.Activo ? "" : "disabled";
        return `<button data-action="selectClient" data-id="${c.IdCliente}" class="${c.Activo ? "" : "secondary"}" ${disabled}>${escapeHtml(label)}</button>`;
      }).join("");

      addQuickActions(buttons);
      return;
    }

    if (!found.Activo) {
      addMessage(`⚠ El cliente "${found.Nombre}" está inactivo.`, "bot-message");
      addMessage("Ingresá otro cliente o pedí activación.", "bot-message");
      return;
    }

    cliente = found;
    step = 2;
    addMessage(`✅ Cliente validado: ${cliente.Nombre} (ID: ${cliente.IdCliente}). Ahora ingresá el código de error.`, "bot-message");
    return;
  }

  const code = String(message).toUpperCase();
  const error = erroresByCode[code];

  if (error) {
    addMessage("Buscando información del error...", "bot-message");
    setTimeout(() => {
      addErrorCard(error);
      if (cliente) saveLastErrorForClient(cliente.IdCliente, error);
    }, 350);
  } else {
    addMessage("❌ No se encontró ese código de error.", "bot-message");
    addMessage("Te dejo accesos rápidos:", "bot-message");
    addQuickActions(`
      <button data-action="retryError">🔁 Reintentar</button>
      <button data-action="lastError">📌 Último error del cliente</button>
      <button data-action="listCodes">📋 Ver códigos disponibles</button>
      <button data-action="changeClient">🧹 Cambiar cliente</button>
    `);
  }
}
