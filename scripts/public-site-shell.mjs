import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { scanHtml, escapeHtml } from './html-source.mjs';
import { homepagePath, PUBLIC_DOC_PAGES, publicDocPath } from './public-docs.mjs';
import { DEFAULT_LOCALE, PUBLIC_RC1_LOCALE_IDS, locales } from './website-locales.mjs';
import { overlayLocales } from './locale-overlay.mjs';

// Stable inputs: build and source-bound public QA render the same complete page.
const assetHash = createHash('sha256');
for (const name of ['styles.css','site.js','better-workflows-mark.svg','favicon.svg','favicon.ico','apple-touch-icon.png']) { assetHash.update(name); assetHash.update('\0'); assetHash.update(readFileSync(new URL('../website/'+name,import.meta.url))); assetHash.update('\0'); }
export const SITE_SHELL_VERSION = assetHash.digest('hex').slice(0,12);
const repository = 'https://github.com/stephen-taipei/better-workflows';
const releaseNotes = `${repository}/releases/tag/V5.0.rc1`;
const copy = overlayLocales({
  'zh-Hant-TW': {
    skip:'跳到主要內容', product:'產品', workflow:'工作流程', install:'開始使用', docs:'文件', principles:'設計原則', support:'支援', sponsor:'贊助',
    menu:'選單', menuOpen:'開啟選單', menuClose:'關閉選單', language:'語言', themeToDark:'切換為深色模式', themeToLight:'切換為淺色模式', themeToggle:'切換深淺色模式',
    home:'首頁', breadcrumb:'頁面位置', homeLabel:'Better Workflows 首頁', onThisPage:'本頁內容',
    guide:'文件總覽', quick:'快速開始', cases:'使用情境', examples:'實用範例', cinema:'Evidence Cinema', cinemaSub:'證據劇場',
    tagline:'證據至上的 AI 工程 QA＋交付守門人。', status:'V5.0 RC1 已公開上架，GA 仍待完成。',
    resources:'使用資源', project:'開源專案', releaseNotes:'RC1 發布說明', contribute:'參與貢獻', security:'資安政策', governance:'專案治理', conduct:'行為準則', sponsorFooter:'支持開發',
    license:'核心 AGPL-3.0 · wire Apache-2.0', alias:'（betterworkflows.org 轉址至此）', chip:'V5.0 RC1 已公開 · GA 準備中', installCta:'開始安裝', overview:'產品導覽', hosts:'支援範圍', boundary:'證明邊界', statusNav:'發布狀態', faq:'常見問題', docDescriptions:['找到適合你下一個任務的使用指南','安裝 Better Workflows，執行第一個任務','從檢查、修改到交付，選擇適合的路線','複製需求範例，再依任務調整','證據劇場：互動示範檢查如何串起交付']
  },
  en: {
    skip:'Skip to main content', product:'Product', workflow:'Workflow', install:'Get started', docs:'Docs', principles:'Principles', support:'Support', sponsor:'Sponsor',
    menu:'Menu', menuOpen:'Open menu', menuClose:'Close menu', language:'Language', themeToDark:'Switch to dark theme', themeToLight:'Switch to light theme', themeToggle:'Toggle color theme',
    home:'Home', breadcrumb:'Breadcrumb', homeLabel:'Better Workflows home', onThisPage:'On this page',
    guide:'Documentation', quick:'Quick start', cases:'Use cases', examples:'Practical examples', cinema:'Evidence Cinema', cinemaSub:'Evidence Cinema',
    tagline:'Evidence-first AI engineering QA and delivery gatekeeper.', status:'V5.0 RC1 is publicly available. GA remains pending.',
    resources:'Resources', project:'Open source', releaseNotes:'RC1 release notes', contribute:'Contributing', security:'Security', governance:'Governance', conduct:'Code of conduct', sponsorFooter:'Support development',
    license:'Core AGPL-3.0 · wire Apache-2.0', alias:'(betterworkflows.org redirects here)', chip:'V5.0 RC1 available · GA pending', installCta:'Install', overview:'Overview', hosts:'Hosts', boundary:'Proof boundary', statusNav:'Release status', faq:'FAQ', docDescriptions:['Find the right guide for your next task','Install Better Workflows and run a first task','Choose a path for reviewing, changing code, or delivery','Start with a request you can adapt','An interactive demo of how checks lead to delivery']
  }
}, "site-shell", PUBLIC_RC1_LOCALE_IDS);
export function siteCopy(code) { if(!copy[code]) throw new Error(`Unsupported site locale: ${code}`); return copy[code]; }
const e = escapeHtml;
const SPRITE = '<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">'
  + '<symbol id="i-arrow" viewBox="0 0 16 16"><path d="M3 8h10M9 4l4 4-4 4"/></symbol>'
  + '<symbol id="i-down" viewBox="0 0 16 16"><path d="M8 3v10M4 9l4 4 4-4"/></symbol>'
  + '<symbol id="i-ext" viewBox="0 0 16 16"><path d="M6.5 3.5h-3v9h9v-3M9.5 3.5h3v3M12.5 3.5L7 9"/></symbol>'
  + '<symbol id="i-copy" viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5"/><path d="M3 10.5V4a1 1 0 011-1h6.5"/></symbol>'
  + '<symbol id="i-check" viewBox="0 0 16 16"><path d="M3 8.5l3.2 3.2L13 4.8"/></symbol>'
  + '<symbol id="i-x" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></symbol>'
  + '<symbol id="i-sun" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></symbol>'
  + '<symbol id="i-moon" viewBox="0 0 16 16"><path d="M13.2 9.6A5.6 5.6 0 016.4 2.8a5.6 5.6 0 106.8 6.8z"/></symbol>'
  + '<symbol id="i-menu" viewBox="0 0 16 16"><path d="M2.5 5h11M2.5 11h11"/></symbol>'
  + '<symbol id="i-chev" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></symbol>'
  + '<symbol id="i-replay" viewBox="0 0 16 16"><path d="M3 8a5 5 0 105-5H5.2M5.2 3L7 1.2M5.2 3L7 4.8"/></symbol>'
  + '<symbol id="i-step" viewBox="0 0 16 16"><path d="M4 3.5l6 4.5-6 4.5zM12.5 3.5v9"/></symbol>'
  + '<symbol id="i-stop" viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></symbol>'
  + '<symbol id="i-lock" viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="6.5" rx="1.5"/><path d="M5.2 7V5.2a2.8 2.8 0 015.6 0V7"/></symbol>'
  + '<symbol id="i-doc" viewBox="0 0 16 16"><path d="M4 2h5.5L13 5.5V14H4z"/><path d="M6.2 9.4l1.5 1.5 2.6-2.8"/></symbol>'
  + '<symbol id="i-root" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.4"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/></symbol>'
  + '</svg>';
const icon = (name, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const brand = (code, tag = true) => `<a class="brand" href="${homepagePath(code)}" aria-label="${e(siteCopy(code).homeLabel)}"><img class="brand-mark brand-mark--converge" src="/better-workflows-mark.svg?v=${SITE_SHELL_VERSION}" width="34" height="27" alt="" aria-hidden="true"><span class="brand-name">Better Workflows</span>${tag ? '<span class="brand-tag" title="V5.0 RC1">RC1</span>' : ''}</a>`;
// Strip any non-default locale prefix, then add the target locale's prefix.
const localePrefixPattern = new RegExp(`^/(?:${PUBLIC_RC1_LOCALE_IDS.filter((c) => c !== DEFAULT_LOCALE).map((c) => c.replace(/[-]/g, '\\-')).join('|')})(?=/)`);
const localeLabel = (code) => locales.find((locale) => locale.code === code).label;
const localizedPath = (code, path) => { if(path==='/404.html') return homepagePath(code); const withoutLocale = path.replace(localePrefixPattern, ''); return code === DEFAULT_LOCALE ? withoutLocale : `/${code}${withoutLocale}`; };
const docsLabels = (c) => [c.guide,c.quick,c.cases,c.examples,c.cinema];
const isDocsPath = (code, path) => PUBLIC_DOC_PAGES.some((page) => publicDocPath(code, page.id) === path);
export function siteHeader(code, currentPath) {
  const c=siteCopy(code), home=homepagePath(code);
  const onSupport = currentPath === localizedPath(code,'/support/');
  const localeLinks=PUBLIC_RC1_LOCALE_IDS.map(other => `<a data-locale-button="${other}" data-locale-link="${other}" data-locale-static="true" data-auto-locale="${other}" data-cinema-locale="${other}" lang="${other}" hreflang="${other}" href="${e(localizedPath(other,currentPath))}"${other===code?' aria-current="page"':''}>${e(localeLabel(other))}</a>`).join('');
  const docs = PUBLIC_DOC_PAGES.map((page,i) => { const href = publicDocPath(code,page.id); return `<a href="${href}"${currentPath===href?' aria-current="page"':''}><b>${docsLabels(c)[i]}</b><small>${c.docDescriptions[i]}</small></a>`; }).join('');
  const docsCurrent = isDocsPath(code, currentPath) ? ' aria-current="true"' : '';
  return `<a class="skip-link" href="#main">${c.skip}</a><header class="site-header" data-site-header><span class="read-bar" aria-hidden="true"></span><div class="shell header-inner">${brand(code)}`
    + `<nav class="site-nav" id="site-nav" aria-label="${c.menu}" data-site-nav><a href="${home}#product" data-spy="product">${c.product}</a><a href="${home}#principles" data-spy="principles">${c.principles}</a><a href="${home}#workflow" data-spy="workflow">${c.workflow}</a><a href="${home}#install" data-spy="install">${c.install}</a>`
    + `<details class="nav-dd" data-site-dropdown><summary data-spy="docs"${docsCurrent}><span>${c.docs}</span>${icon('chev')}</summary><div class="dd-panel">${docs}</div></details>`
    + `<a href="${localizedPath(code,'/support/')}"${onSupport?' aria-current="page"':''}>${c.support}</a><a href="${home}#sponsor" data-spy="sponsor">${c.sponsor}</a><a class="nav-gh" href="${repository}" target="_blank" rel="noopener noreferrer">GitHub${icon('ext')}</a><a class="nav-cta btn btn-primary" href="${home}#install">${c.installCta}${icon('arrow')}</a></nav>`
    + `<div class="header-tools"><details class="lang-menu"><summary aria-label="${c.language}">${e(localeLabel(code))}</summary><nav class="lang" aria-label="${c.language}" data-public-locale-buttons>${localeLinks}</nav></details>`
    + `<button class="icon-btn theme-toggle" type="button" data-theme-toggle data-label-to-dark="${c.themeToDark}" data-label-to-light="${c.themeToLight}" aria-label="${c.themeToggle}" aria-pressed="false">${icon('sun','ic ic-sun')}${icon('moon','ic ic-moon')}</button>`
    + `<button class="icon-btn nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav" data-menu-toggle data-label-open="${c.menuOpen}" data-label-close="${c.menuClose}" aria-label="${c.menuOpen}">${icon('menu','ic ic-menu')}${icon('x','ic ic-close')}</button></div></div></header>`;
}
export function siteFooter(code) {
  const c=siteCopy(code), prefix=code==='en'?'/en':'', home=homepagePath(code);
  const ext = 'target="_blank" rel="noopener noreferrer"';
  return `<footer class="site-footer"><div class="shell footer-grid"><div class="foot-brand">${brand(code, false)}<p>${c.tagline}</p><p class="foot-chip mono"><i class="led" aria-hidden="true"></i>${c.chip}</p></div>`
    + `<nav aria-labelledby="f-over"><h2 id="f-over" class="mono">${c.overview}</h2><a href="${home}#principles">${c.principles}</a><a href="${home}#workflow">${c.workflow}</a><a href="${home}#hosts">${c.hosts}</a><a href="${home}#install">${c.install}</a><a href="${home}#boundary">${c.boundary}</a><a href="${home}#v5-status">${c.statusNav}</a><a href="${home}#faq">${c.faq}</a></nav>`
    + `<nav aria-labelledby="f-res"><h2 id="f-res" class="mono">${c.resources}</h2>${PUBLIC_DOC_PAGES.map((page,i)=>`<a href="${publicDocPath(code,page.id)}">${docsLabels(c)[i]}</a>`).join('')}<a href="${prefix}/support/">${c.support}</a></nav>`
    + `<nav aria-labelledby="f-oss"><h2 id="f-oss" class="mono">${c.project}</h2><a href="${repository}" ${ext}>GitHub</a><a href="${releaseNotes}" ${ext}>${c.releaseNotes}</a><a href="${prefix}/policies/contributing/">${c.contribute}</a><a href="${prefix}/policies/security/">${c.security}</a><a href="${prefix}/policies/governance/">${c.governance}</a><a href="${prefix}/policies/conduct/">${c.conduct}</a><a href="${home}#sponsor">${c.sponsorFooter}</a></nav></div>`
    + `<div class="shell footer-bottom mono"><span>© Better Workflows</span><span>${c.license}</span><span>betterworkflows.dev <i>${c.alias}</i></span></div></footer>`;
}
const siteIcons = () => `<link rel="icon" href="/favicon.ico?v=${SITE_SHELL_VERSION}" sizes="48x48"><link rel="icon" href="/favicon.svg?v=${SITE_SHELL_VERSION}" type="image/svg+xml" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${SITE_SHELL_VERSION}">`;
const siteColors = () => '<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#f3eee2" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#13100b" media="(prefers-color-scheme: dark)">';
export const siteHead = () => `${siteIcons()}${siteColors()}<script>try{const t=localStorage.getItem('better-workflows-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch{}document.documentElement.classList.add('js');</script><link rel="stylesheet" href="/styles.css?v=${SITE_SHELL_VERSION}"><script src="/site.js?v=${SITE_SHELL_VERSION}" defer></script>`;
const MAIN_CLASS = { home:'home-main', cinema:'cinema-page', document:'document-page', notfound:'notfound-page' };

export function applyPublicSiteShell(html,{code,path,kind='document'}) {
  siteCopy(code);
  if (!MAIN_CLASS[kind]) throw new Error(`Unsupported public shell kind: ${kind}`);
  const tree=scanHtml(html), main=tree.elements.find(n=>n.tag==='main'), head=tree.elements.find(n=>n.tag==='head'), body=tree.elements.find(n=>n.tag==='body');
  if(!main||!head||!body||tree.elements.filter(n=>n.tag==='main').length!==1) throw new Error('Public shell requires one complete main/head/body');
  let metadata=html.slice(head.openEnd,head.contentEnd);
  // Cinema retains its pinned presentation stylesheet and complete runtime.
  if(kind!=='cinema') metadata=metadata.replace(/<style>[\s\S]*?<\/style>/g,'');
  metadata=metadata.replace(/<link\b[^>]*rel="(?:icon|apple-touch-icon)"[^>]*>/g,'').replace(/<meta\b[^>]*name="(?:theme-color|color-scheme)"[^>]*>/g,'').replace(/<link\b[^>]*href="\/styles\.css[^>]*>/g,'').replace(/<script\b[^>]*src="\/site\.js[^>]*><\/script>/g,'');
  const attrs=html.slice(main.start,main.openEnd).replace(/\sclass="[^"]*"/,'').replace(/\sid="[^"]*"/,'').replace(/>$/,` id="main" class="${MAIN_CLASS[kind]}">`);
  const mainBody=html.slice(main.openEnd,main.contentEnd);
  const c=siteCopy(code);
  const inner=kind==='document'?`<div class="shell document-layout"><aside class="document-sidebar" aria-label="${c.docs}" data-doc-sidebar data-toc-label="${e(c.onThisPage)}"><p class="sidebar-label">${c.docs}</p>${PUBLIC_DOC_PAGES.map((p,i) => `<a href="${publicDocPath(code,p.id)}"${path===publicDocPath(code,p.id)?' aria-current="page"':''}>${docsLabels(c)[i]}</a>`).join('')}<a href="${localizedPath(code,'/support/')}"${path===localizedPath(code,'/support/')?' aria-current="page"':''}>${c.support}</a></aside><article class="document-content"><nav class="breadcrumbs" aria-label="${c.breadcrumb}"><a href="${homepagePath(code)}">${c.home}</a><span aria-hidden="true">/</span><a href="${publicDocPath(code,'guide')}">${c.docs}</a></nav>${mainBody}</article></div>`:mainBody;
  const tails=tree.elements.filter(n=>n.parent===body&&(n.tag==='script'||n.tag==='noscript')).map(n=>html.slice(n.start,n.end)).join('\n');
  const htmlOpen=html.slice(0,head.start);
  return `${htmlOpen}<head>${metadata}${siteHead()}</head><body class="site-page ${kind}-site">${SPRITE}${siteHeader(code,path)}${attrs}${inner}</main>${siteFooter(code)}${tails}</body></html>\n`;
}
