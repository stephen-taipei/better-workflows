import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { scanHtml, escapeHtml } from './html-source.mjs';
import { homepagePath, PUBLIC_DOC_PAGES, publicDocPath } from './public-docs.mjs';
import { PUBLIC_RC1_LOCALE_IDS } from './website-locales.mjs';

// Stable inputs: build and source-bound public QA render the same complete page.
const assetHash = createHash('sha256');
for (const name of ['styles.css','site.js','better-workflows-mark.svg','favicon.svg']) { assetHash.update(name); assetHash.update('\0'); assetHash.update(readFileSync(new URL('../website/'+name,import.meta.url))); assetHash.update('\0'); }
export const SITE_SHELL_VERSION = assetHash.digest('hex').slice(0,12);
const repository = 'https://github.com/stephen-taipei/better-workflows';
const copy = {
  'zh-Hant-TW': { product:'產品',workflow:'工作流程',install:'開始使用',docs:'文件',support:'支援',menu:'選單',language:'語言',theme:'切換深淺色',dark:'深色',light:'淺色',skip:'跳到主要內容',tagline:'讓 AI 協作，走到可靠的交付。',about:'為 AI 程式開發加上檢查、審查與交付流程。',resources:'使用資源',project:'開源專案',sponsor:'支持開發',quick:'快速開始',cases:'使用情境',examples:'實用範例',cinema:'Evidence Cinema',guide:'文件總覽',security:'資安政策',contribute:'參與貢獻',governance:'專案治理',conduct:'行為準則',license:'核心 AGPL-3.0 · wire Apache-2.0',release:'V5.0 RC1 已公開 · GA 準備中',home:'首頁' },
  en: { product:'Product',workflow:'Workflow',install:'Get started',docs:'Docs',support:'Support',menu:'Menu',language:'Language',theme:'Switch color theme',dark:'Dark',light:'Light',skip:'Skip to content',tagline:'Take AI collaboration all the way to delivery.',about:'Checks, review, and delivery workflows for AI-assisted coding.',resources:'Resources',project:'Open source',sponsor:'Support development',quick:'Quick start',cases:'Use cases',examples:'Practical examples',cinema:'Evidence Cinema',guide:'Documentation',security:'Security',contribute:'Contributing',governance:'Governance',conduct:'Code of conduct',license:'Core AGPL-3.0 · wire Apache-2.0',release:'V5.0 RC1 available · GA in progress',home:'Home' }
};
export function siteCopy(code) { if(!copy[code]) throw new Error(`Unsupported site locale: ${code}`); return copy[code]; }
const e = escapeHtml;
const brand = (code) => `<a class="brand" href="${homepagePath(code)}"><img class="brand-mark brand-mark--converge" src="/better-workflows-mark.svg?v=${SITE_SHELL_VERSION}" width="36" height="36" alt="" aria-hidden="true"><span class="brand-copy"><strong>Better Workflows</strong></span></a>`;
const localizedPath = (code, path) => { if(path==='/404.html') return homepagePath(code); const withoutLocale = path.replace(/^\/en(?=\/)/, ''); return code === 'en' ? `/en${withoutLocale}` : withoutLocale; };
const docsLabels = (c) => [c.guide,c.quick,c.cases,c.examples,c.cinema];
export function siteHeader(code, currentPath) {
  const c=siteCopy(code), home=homepagePath(code);
  const localeLinks=PUBLIC_RC1_LOCALE_IDS.map(other => `<a data-locale-button="${other}" data-locale-link="${other}" data-locale-static="true" data-auto-locale="${other}" data-cinema-locale="${other}" lang="${other}" hreflang="${other}" href="${e(localizedPath(other,currentPath))}"${other===code?' aria-current="page"':''}>${other==='en'?'English':'繁體中文'}</a>`).join('');
  const docs = PUBLIC_DOC_PAGES.map((page,i) => `<a href="${publicDocPath(code,page.id)}"${currentPath===publicDocPath(code,page.id)?' aria-current="page"':''}>${docsLabels(c)[i]}</a>`).join('');
  return `<a class="skip-link" href="#main">${c.skip}</a><header class="site-header"><div class="shell header-inner">${brand(code)}<button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav" data-menu-toggle>${c.menu}</button><nav class="site-nav" id="site-nav" aria-label="${c.menu}" data-site-nav><a href="${home}#product">${c.product}</a><a href="${home}#workflow">${c.workflow}</a><a href="${home}#install">${c.install}</a><details class="nav-dropdown" data-site-dropdown><summary>${c.docs}</summary><div class="dropdown-panel">${docs}</div></details><a href="${home}#principles">${code==='en'?'Principles':'設計原則'}</a><a href="${localizedPath(code,'/support/')}"${currentPath===localizedPath(code,'/support/')?' aria-current="page"':''}>${c.support}</a><a href="${home}#sponsor">${code==='en'?'Sponsor':'贊助'}</a><a href="${repository}" target="_blank" rel="noopener noreferrer">GitHub</a></nav><div class="header-controls"><details class="locale-menu" data-site-dropdown><summary aria-label="${c.language}">${code==='en'?'EN':'中文'}</summary><nav class="dropdown-panel" aria-label="${c.language}" data-public-locale-buttons>${localeLinks}</nav></details><button class="theme-toggle" type="button" data-theme-toggle data-theme-label-light="${c.dark}" data-theme-label-dark="${c.light}" aria-label="${c.theme}" aria-pressed="false">${c.dark}</button></div></div></header>`;
}
export function siteFooter(code) {
  const c=siteCopy(code), prefix=code==='en'?'/en':'';
  return `<footer class="site-footer"><div class="shell footer-grid"><div class="footer-brand">${brand(code)}<p>${c.about}</p><span class="release-note">${c.release}</span></div><div><h2>${c.resources}</h2><a href="${publicDocPath(code,'quick')}">${c.quick}</a><a href="${publicDocPath(code,'use-cases')}">${c.cases}</a><a href="${publicDocPath(code,'evidence-cinema')}">${c.cinema}</a><a href="${prefix}/support/">${c.support}</a></div><div><h2>${c.project}</h2><a href="${repository}">GitHub</a><a href="${prefix}/policies/contributing/">${c.contribute}</a><a href="${prefix}/policies/security/">${c.security}</a><a href="${prefix}/policies/governance/">${c.governance}</a><a href="${prefix}/policies/conduct/">${c.conduct}</a><a href="${homepagePath(code)}#sponsor">${c.sponsor}</a></div></div><div class="shell footer-bottom"><span>© Better Workflows</span><span>${c.license}</span></div></footer>`;
}
export const siteHead = () => `<script>try{const t=localStorage.getItem('better-workflows-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch{}document.documentElement.classList.add('js');</script><link rel="stylesheet" href="/styles.css?v=${SITE_SHELL_VERSION}"><script src="/site.js?v=${SITE_SHELL_VERSION}" defer></script>`;

export function applyPublicSiteShell(html,{code,path,kind='document'}) {
  siteCopy(code);
  const tree=scanHtml(html), main=tree.elements.find(n=>n.tag==='main'), head=tree.elements.find(n=>n.tag==='head'), body=tree.elements.find(n=>n.tag==='body');
  if(!main||!head||!body||tree.elements.filter(n=>n.tag==='main').length!==1) throw new Error('Public shell requires one complete main/head/body');
  let metadata=html.slice(head.openEnd,head.contentEnd);
  // Cinema retains its pinned presentation stylesheet and complete runtime.
  if(kind!=='cinema') metadata=metadata.replace(/<style>[\s\S]*?<\/style>/g,'');
  metadata=metadata.replace(/<link\b[^>]*href="\/styles\.css[^>]*>/g,'').replace(/<script\b[^>]*src="\/site\.js[^>]*><\/script>/g,'');
  const attrs=html.slice(main.start,main.openEnd).replace(/\sclass="[^"]*"/,'').replace(/\sid="[^"]*"/,'').replace(/>$/,` id="main" class="${kind==='home'?'home-main':kind==='cinema'?'cinema-page':'document-page'}">`);
  const mainBody=html.slice(main.openEnd,main.contentEnd);
  const inner=kind==='document'?`<div class="shell document-layout"><aside class="document-sidebar" aria-label="${siteCopy(code).docs}"><p class="sidebar-label">${siteCopy(code).docs}</p>${PUBLIC_DOC_PAGES.map((p,i)=>`<a href="${publicDocPath(code,p.id)}"${path===publicDocPath(code,p.id)?' aria-current="page"':''}>${docsLabels(siteCopy(code))[i]}</a>`).join('')}<a href="${localizedPath(code,'/support/')}">${siteCopy(code).support}</a></aside><article class="document-content"><nav class="breadcrumbs" aria-label="${code==='en'?'Breadcrumb':'頁面位置'}"><a href="${homepagePath(code)}">${siteCopy(code).home}</a><span aria-hidden="true">/</span><a href="${publicDocPath(code,'guide')}">${siteCopy(code).docs}</a></nav>${mainBody}</article></div>`:mainBody;
  const tails=tree.elements.filter(n=>n.parent===body&&(n.tag==='script'||n.tag==='noscript')).map(n=>html.slice(n.start,n.end)).join('\n');
  const htmlOpen=html.slice(0,head.start);
  return `${htmlOpen}<head>${metadata}${siteHead()}</head><body class="site-page ${kind}-site">${siteHeader(code,path)}${attrs}${inner}</main>${siteFooter(code)}${tails}</body></html>\n`;
}
