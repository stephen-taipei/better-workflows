const root = document.documentElement;
const themeToggle = document.querySelector("[data-theme-toggle]");
const menuToggle = document.querySelector(".menu-toggle");
const siteNav = document.querySelector("#site-nav");
const localeSelect = document.querySelector("[data-locale-select]");

function setTheme(theme) {
  root.dataset.theme = theme;
  themeToggle?.setAttribute("aria-pressed", String(theme === "dark"));
  const lightLabel = root.dataset.themeLabelLight || "Switch to light theme";
  const darkLabel = root.dataset.themeLabelDark || "Switch to dark theme";
  themeToggle?.setAttribute("aria-label", theme === "dark" ? lightLabel : darkLabel);
  try { localStorage.setItem("better-workflows-theme", theme); } catch { /* storage is optional */ }
}

let initialTheme = "light";
try {
  initialTheme = localStorage.getItem("better-workflows-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
} catch { /* use the light default */ }
setTheme(initialTheme);

themeToggle?.addEventListener("click", () => setTheme(root.dataset.theme === "dark" ? "light" : "dark"));
localeSelect?.addEventListener("change", () => {
  const destination = localeSelect.value;
  if (destination) window.location.assign(destination);
});
menuToggle?.addEventListener("click", () => {
  const open = siteNav?.classList.toggle("is-open") || false;
  menuToggle.setAttribute("aria-expanded", String(open));
});
siteNav?.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => {
  siteNav.classList.remove("is-open");
  menuToggle?.setAttribute("aria-expanded", "false");
}));
