(() => {
  const select = document.getElementById("locale-select");
  if (!select) return;
  const options = [...select.options];
  const allowedCodes = new Set(options.map((option) => option.value));
  const publicLocalePath = (code) => allowedCodes.has(code) && /^[A-Za-z][A-Za-z0-9-]*$/.test(code)
    ? `${code === "zh-Hant-TW" ? "" : `/${code}`}/docs/evidence-cinema/`
    : null;
  const root = document.documentElement;
  const currentLocale = root.dataset.bwReferenceLocale || root.dataset.locale || select.value;
  if (publicLocalePath(currentLocale)) select.value = currentLocale;

  select.addEventListener("change", () => {
    const target = publicLocalePath(select.value);
    if (!target) return;
    if (window.top !== window) window.top.location.assign(target);
    else location.assign(target);
  });

  const navs = document.querySelectorAll("[data-public-locale-nav], [data-public-locale-buttons]");
  for (const nav of navs) {
    const links = options.flatMap((option) => {
      const target = publicLocalePath(option.value);
      if (!target) return [];
      const link = document.createElement("a");
      link.href = target;
      link.lang = option.value;
      link.hreflang = option.value;
      link.dataset.publicLocaleLink = option.value;
      if (nav.hasAttribute("data-public-locale-buttons")) link.dataset.localeButton = option.value;
      link.textContent = option.textContent;
      link.setAttribute("aria-label", option.textContent);
      if (option.value === currentLocale) link.setAttribute("aria-current", "page");
      return [link];
    });
    nav.replaceChildren(...links);
  }
})();
