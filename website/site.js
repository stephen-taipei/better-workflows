/* Better Workflows — vanilla progressive enhancement.
   Every page is readable without this file. */
(() => {
  'use strict';
  const d = document;
  const root = d.documentElement;
  const $ = (s, c = d) => c.querySelector(s);
  const $$ = (s, c = d) => Array.from(c.querySelectorAll(s));
  const mq = (q) => (window.matchMedia ? window.matchMedia(q) : { matches: false, addEventListener() {} });
  const reduceMotion = () => mq('(prefers-reduced-motion: reduce)').matches;
  const KEY = 'better-workflows-theme';
  const safe = (fn) => { try { return fn(); } catch (e) { return null; } };
  const en = (root.lang || '').toLowerCase().startsWith('en');
  const T = en ? {
    copied: 'Copied', copyFailed: 'Copy manually', copiedLive: 'Copied to the clipboard', copyFailedLive: 'Could not copy automatically; select the text manually', copy: 'Copy', copyCode: 'Copy this code',
    say: {
      5: 'VERIFY: evidence is fresh and reviewed. Passed.',
      6: 'AUTHORITY: this target is authorized. Passed.',
      8: { unknown: 'RECONCILE: provider outcome unknown. The gate is blocked and the run stops safely.', confirmed: 'RECONCILE: provider and repository state are consistent. Passed.' },
      9: { unknown: 'Walkthrough finished: the run stopped at reconcile with no retry and no completion claim.', confirmed: 'Walkthrough finished: complete, and task-owned resources are cleaned up.' }
    }
  } : {
    copied: '已複製', copyFailed: '請手動複製', copiedLive: '已複製到剪貼簿', copyFailedLive: '無法自動複製，請手動選取文字', copy: '複製', copyCode: '複製這段程式碼',
    say: {
      5: 'VERIFY：證據新鮮且已審查，通過。',
      6: 'AUTHORITY：此 target 已授權，通過。',
      8: { unknown: 'RECONCILE：provider 結果未知，閘門封鎖，流程安全停止。', confirmed: 'RECONCILE：provider 與 repository 狀態一致，通過。' },
      9: { unknown: '走查結束：流程停在 reconcile，不重試、不宣告完成。', confirmed: '走查結束：已完成並清理本任務擁有的資源。' }
    }
  };

  root.classList.add('js');

  /* ---------- Theme: saved choice > system ---------- */
  const systemDark = mq('(prefers-color-scheme: dark)');
  const stored = () => safe(() => localStorage.getItem(KEY));
  const current = () => (root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  const themeBtn = $('[data-theme-toggle]');
  if (!root.hasAttribute('data-theme')) root.setAttribute('data-theme', systemDark.matches ? 'dark' : 'light');
  function syncThemeBtn() {
    if (!themeBtn) return;
    const dark = current() === 'dark';
    const label = dark ? themeBtn.dataset.labelToLight : themeBtn.dataset.labelToDark;
    themeBtn.setAttribute('aria-pressed', String(dark));
    if (label) { themeBtn.setAttribute('aria-label', label); themeBtn.title = label; }
  }
  syncThemeBtn();
  themeBtn && themeBtn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    safe(() => localStorage.setItem(KEY, next));
    syncThemeBtn();
  });
  systemDark.addEventListener && systemDark.addEventListener('change', (e) => {
    if (stored()) return; // an explicit choice wins over the system
    root.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    syncThemeBtn();
  });

  /* ---------- Header: mobile menu + docs dropdown ---------- */
  const nav = $('[data-site-nav]');
  const menuBtn = $('[data-menu-toggle]');
  const dd = $('[data-site-dropdown]');
  const narrow = () => mq('(max-width: 1100px)').matches;
  function setMenu(open) {
    if (!nav || !menuBtn) return;
    nav.classList.toggle('is-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    const label = open ? menuBtn.dataset.labelClose : menuBtn.dataset.labelOpen;
    if (label) menuBtn.setAttribute('aria-label', label);
    if (open && dd && narrow()) dd.open = true;
  }
  menuBtn && menuBtn.addEventListener('click', () => setMenu(menuBtn.getAttribute('aria-expanded') !== 'true'));
  nav && nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) { setMenu(false); if (dd && !narrow()) dd.open = false; }
  });
  d.addEventListener('click', (e) => {
    if (dd && dd.open && !narrow() && !dd.contains(e.target)) dd.open = false;
    if (menuBtn && menuBtn.getAttribute('aria-expanded') === 'true' && !e.target.closest('.site-header')) setMenu(false);
  });
  d.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (dd && dd.open && !narrow()) { dd.open = false; const s = $('summary', dd); s && s.focus(); }
    if (menuBtn && menuBtn.getAttribute('aria-expanded') === 'true') { setMenu(false); menuBtn.focus(); }
  });
  window.addEventListener('resize', () => { if (!narrow()) setMenu(false); });

  /* ---------- Reading progress ---------- */
  const header = $('[data-site-header]');
  if (header) {
    let tick = false;
    const upd = () => {
      tick = false;
      const max = root.scrollHeight - window.innerHeight;
      header.style.setProperty('--p', max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)).toFixed(4) : '0');
    };
    window.addEventListener('scroll', () => { if (!tick) { tick = true; requestAnimationFrame(upd); } }, { passive: true });
    upd();
  }

  /* ---------- Scroll-spy (homepage sections) ---------- */
  const spyLinks = $$('[data-spy]');
  const sections = $$('main > section[id]');
  if (spyLinks.length && sections.length && 'IntersectionObserver' in window) {
    const visible = new Set();
    const apply = () => {
      const last = sections.filter((s) => visible.has(s.id)).pop();
      const id = last ? last.id : null;
      spyLinks.forEach((a) => {
        if (id && a.dataset.spy === id) a.setAttribute('aria-current', 'true');
        else if (a.getAttribute('aria-current') === 'true') a.removeAttribute('aria-current');
      });
    };
    const spy = new IntersectionObserver((entries) => {
      entries.forEach((en2) => (en2.isIntersecting ? visible.add(en2.target.id) : visible.delete(en2.target.id)));
      apply();
    }, { rootMargin: '-35% 0px -60% 0px', threshold: 0 });
    sections.forEach((s) => spy.observe(s));
  }

  /* ---------- Open collapsed <details> when linked by hash ---------- */
  function openForHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    const el = d.getElementById(id);
    const det = el && el.closest('details');
    if (det && !det.open) { det.open = true; el.scrollIntoView(); }
  }
  window.addEventListener('hashchange', openForHash);
  openForHash();

  /* ---------- Install tabs ---------- */
  $$('[data-tabs]').forEach((box) => {
    const tabs = $$('[role="tab"]', box);
    const panels = tabs.map((t) => d.getElementById(t.getAttribute('aria-controls')));
    const select = (i, focus) => {
      tabs.forEach((t, j) => {
        const on = i === j;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        if (panels[j]) panels[j].hidden = !on;
      });
      if (focus) tabs[i].focus();
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => select(i));
      t.addEventListener('keydown', (e) => {
        let n = null;
        if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = tabs.length - 1;
        if (n !== null) { e.preventDefault(); select(n, true); }
      });
    });
    select(0);
  });

  /* ---------- Documentation: copy buttons on code blocks + on-page contents ---------- */
  const docContent = $('.document-content');
  if (docContent) {
    $$('pre', docContent).forEach((pre) => {
      if (!$('code', pre)) return;
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'copy';
      btn.setAttribute('data-copy', '');
      btn.setAttribute('aria-label', T.copyCode);
      btn.innerHTML = '<svg class="ic ic-copy" aria-hidden="true"><use href="#i-copy"/></svg><svg class="ic ic-ok" aria-hidden="true"><use href="#i-check"/></svg><span class="copy-t"></span>';
      $('.copy-t', btn).textContent = T.copy;
      pre.classList.add('has-copy');
      pre.appendChild(btn);
    });
    const sidebar = $('[data-doc-sidebar]');
    const heads = $$('h2', docContent);
    if (sidebar && heads.length >= 3) {
      const toc = d.createElement('nav');
      toc.className = 'doc-toc';
      toc.setAttribute('aria-label', sidebar.dataset.tocLabel || '');
      const label = d.createElement('p');
      label.className = 'doc-toc-label';
      label.textContent = sidebar.dataset.tocLabel || '';
      toc.appendChild(label);
      const links = heads.map((h, i) => {
        if (!h.id) h.id = 'section-' + (i + 1);
        const a = d.createElement('a');
        a.href = '#' + h.id;
        a.textContent = h.textContent;
        toc.appendChild(a);
        return a;
      });
      sidebar.appendChild(toc);
      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            links.forEach((a) => (a.hash === '#' + entry.target.id ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
          });
        }, { rootMargin: '0px 0px -70% 0px' });
        heads.forEach((h) => io.observe(h));
      }
    }
  }

  /* ---------- Copy to clipboard ---------- */
  const copyLive = d.createElement('p');
  copyLive.className = 'sr-only';
  copyLive.setAttribute('role', 'status');
  copyLive.setAttribute('aria-live', 'polite');
  d.body.appendChild(copyLive);
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    const ta = d.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    d.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = d.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  $$('[data-copy]').forEach((btn) => {
    const label = $('.copy-t', btn);
    const idle = label ? label.textContent : '';
    let timer = 0;
    btn.addEventListener('click', async () => {
      const code = $('code', btn.closest('.cmd, .addr-row, pre'));
      if (!code) return;
      const ok = await copyText(code.textContent.trim());
      clearTimeout(timer);
      if (ok) btn.setAttribute('data-copied', '');
      if (label) label.textContent = ok ? T.copied : T.copyFailed;
      copyLive.textContent = ok ? T.copiedLive : T.copyFailedLive;
      timer = setTimeout(() => { btn.removeAttribute('data-copied'); if (label) label.textContent = idle; }, 1800);
    });
  });

  /* ---------- Lifecycle diagram: light up in sequence ---------- */
  const lc = $('[data-lifecycle]');
  if (lc && !reduceMotion() && 'IntersectionObserver' in window) {
    lc.classList.add('is-armed');
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { lc.classList.remove('is-armed'); io.disconnect(); }
    }, { threshold: 0.3 });
    io.observe(lc);
  }

  /* ---------- Gate demo (illustrative walkthrough) ---------- */
  const demo = $('[data-demo]');
  if (demo) {
    const lines = $$('.tl', demo);
    const gates = $$('.gate', demo);
    const progress = $('[data-progress]', demo);
    const live = $('[data-live]', demo);
    const N = gates.length;
    const LABEL = { pass: 'PASS', active: 'RUNNING', blocked: 'BLOCKED', skip: 'NOT REACHED', idle: '—' };
    let outcome = demo.dataset.outcome === 'confirmed' ? 'confirmed' : 'unknown';
    let token = 0;
    let cursor = 0;
    const pad = (n) => String(n).padStart(2, '0');
    const resultFor = (i) => (i === 8 ? (outcome === 'unknown' ? 'blocked' : 'pass') : i === 9 ? (outcome === 'unknown' ? 'skip' : 'pass') : 'pass');
    const setGate = (g, st) => { g.dataset.state = st; const t = $('.g-state', g); if (t) t.textContent = LABEL[st]; };
    const setRun = (v) => { demo.dataset.run = v; };
    function paint(shown, resolved, active) {
      lines.forEach((li) => {
        const s = parseFloat(li.dataset.step);
        li.classList.toggle('is-pending', s > shown);
        li.classList.toggle('is-active', active > 0 && s === active);
      });
      gates.forEach((g) => {
        const i = parseInt(g.dataset.gate, 10);
        setGate(g, i <= resolved ? resultFor(i) : i === active ? 'active' : 'idle');
      });
      if (progress) {
        if (active) progress.textContent = pad(active) + ' / ' + pad(N);
        else if (resolved >= N) progress.textContent = outcome === 'unknown' ? 'STOPPED AT 08 / 09' : pad(N) + ' / ' + pad(N);
        else progress.textContent = pad(Math.max(resolved, 0)) + ' / ' + pad(N);
      }
    }
    const say = (i) => {
      const msg = T.say[i];
      if (!live || !msg) return;
      live.textContent = typeof msg === 'string' ? msg : msg[outcome];
    };
    function finalState(announce) { token++; cursor = N + 1; paint(N, N, 0); setRun('done'); if (announce) say(9); }
    function reset() { token++; cursor = 0; setRun('running'); paint(-1, 0, 0); if (live) live.textContent = ''; }
    const wait = (ms, my) => new Promise((r) => setTimeout(() => r(my === token), ms));
    async function play() {
      if (reduceMotion()) { finalState(true); return; }
      reset();
      const my = token;
      if (!(await wait(250, my))) return;
      paint(0, 0, 0);
      if (!(await wait(520, my))) return;
      paint(0.5, 0, 0);
      for (let i = 1; i <= N; i++) {
        if (!(await wait(i === 1 ? 480 : 220, my))) return;
        if (i === 9 && outcome === 'unknown') { paint(9, 9, 0); break; }
        paint(i, i - 1, i);
        const decision = i === 5 || i === 6 || i === 8;
        if (!(await wait(decision ? 820 : 560, my))) return;
        paint(i, i, 0);
        say(i);
        if (i === 8 && outcome === 'unknown' && !(await wait(620, my))) return;
      }
      if (my !== token) return;
      cursor = N + 1; setRun('done'); say(9);
    }
    function stepOnce() {
      token++;
      if (cursor > N) reset();
      setRun('running');
      if (cursor === 0) { paint(0.5, 0, 0); cursor = 1; return; }
      const i = cursor;
      paint(i, i, 0); say(i);
      if (i === 8 && outcome === 'unknown') { paint(9, 9, 0); cursor = N + 1; setRun('done'); say(9); return; }
      cursor = i + 1;
      if (i === N) { cursor = N + 1; setRun('done'); say(9); }
    }
    const replayBtn = $('[data-act="replay"]', demo);
    const stepBtn = $('[data-act="step"]', demo);
    replayBtn && replayBtn.addEventListener('click', play);
    stepBtn && stepBtn.addEventListener('click', stepOnce);
    $$('[data-outcome-set]', demo).forEach((b) => b.addEventListener('click', () => {
      outcome = b.dataset.outcomeSet === 'confirmed' ? 'confirmed' : 'unknown';
      demo.dataset.outcome = outcome;
      $$('[data-outcome-set]', demo).forEach((x) => {
        const on = x === b;
        x.classList.toggle('is-on', on);
        x.setAttribute('aria-pressed', String(on));
      });
      play();
    }));
    // Start from the readable final state; autoplay once when the console scrolls into view.
    finalState(false);
    if (!reduceMotion() && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver((es) => {
        if (es.some((e) => e.isIntersecting)) { io.disconnect(); play(); }
      }, { threshold: 0.3 });
      io.observe(demo);
    }
  }
})();
