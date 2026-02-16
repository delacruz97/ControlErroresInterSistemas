const ADMIN_USER = "admin";
const ADMIN_PASS = "admin";

function handleLogin() {
  const u = document.getElementById("loginUser").value.trim();
  const p = document.getElementById("loginPass").value.trim();
  const err = document.getElementById("loginError");

  if (u === ADMIN_USER && p === ADMIN_PASS) {
    localStorage.setItem("isLogged", "true");
    window.location.href = "./chat.html";
  } else {
    err.classList.remove("hidden");
  }
}

// Enter para loguearse
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleLogin();
});

// Si ya está logueado, redirige directo al chat
window.addEventListener("load", () => {
  const isLogged = localStorage.getItem("isLogged") === "true";
  if (isLogged) window.location.href = "./chat.html";
});
