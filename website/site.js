(() => {
  const root = document.documentElement;
  const themeButton = document.querySelector('[data-theme-toggle]');
  const menuButton = document.querySelector('[data-menu-toggle]');
  const nav = document.querySelector('[data-site-nav]');
  const dropdowns = [...document.querySelectorAll('[data-site-dropdown]')];
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let explicitTheme = false;
  const setTheme = (theme, persist = false) => {
    root.dataset.theme = theme;
    if (themeButton) {
      themeButton.setAttribute('aria-pressed', String(theme === 'dark'));
      themeButton.textContent = theme === 'dark' ? themeButton.dataset.themeLabelDark : themeButton.dataset.themeLabelLight;
    }
    if (persist) { explicitTheme = true; try { localStorage.setItem('better-workflows-theme', theme); } catch {} }
  };
  try { const saved = localStorage.getItem('better-workflows-theme'); explicitTheme = saved === 'dark' || saved === 'light'; setTheme(explicitTheme ? saved : media.matches ? 'dark' : 'light'); }
  catch { setTheme(media.matches ? 'dark' : 'light'); }
  media.addEventListener('change', e => { if (!explicitTheme) setTheme(e.matches ? 'dark' : 'light'); });
  themeButton?.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true));
  const closeNav = (returnFocus = false) => {
    const wasOpen = nav?.classList.contains('is-open');
    nav?.classList.remove('is-open');
    menuButton?.setAttribute('aria-expanded', 'false');
    if (wasOpen && returnFocus) menuButton?.focus();
  };
  menuButton?.addEventListener('click', () => {
    const open = !nav.classList.contains('is-open');
    nav.classList.toggle('is-open', open);
    menuButton.setAttribute('aria-expanded', String(open));
    dropdowns.forEach(d => { d.open = false; });
  });
  dropdowns.forEach(dropdown => dropdown.addEventListener('toggle', () => {
    if (dropdown.open) dropdowns.forEach(other => { if (other !== dropdown) other.open = false; });
  }));
  document.addEventListener('click', event => {
    dropdowns.forEach(d => { if (d.open && !d.contains(event.target)) d.open = false; });
    if (nav?.classList.contains('is-open') && !nav.contains(event.target) && !menuButton.contains(event.target)) closeNav();
    if (event.target.closest('a')?.closest('[data-site-nav]')) { closeNav(); dropdowns.forEach(d => { d.open = false; }); }
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const open = dropdowns.find(d => d.open);
    if (open) { open.open = false; open.querySelector('summary')?.focus(); }
    else closeNav(true);
  });
  const desktop = window.matchMedia('(min-width: 1101px)');
  desktop.addEventListener('change', () => { closeNav(); dropdowns.forEach(d => { d.open = false; }); });
})();
