/**
 * 图谱应用统一顶栏注入脚本（单文件应用页共用，无框架依赖）。
 * 用法：在页面 <body> 起始处插入 <div id="gb-appbar"></div> 并引入本脚本（或内联）。
 * 设计基调与 web SPA（antd #2878b5）一致；品牌为 graph-builder，不含平台名。
 * 「工作台」链接默认指向 SPA builder 工作台（/builder）；部署在子路径时，
 * 在引入本脚本前设置 window.GB_HOME = '/your-spa-base/' 即可覆盖。
 */
(function () {
  'use strict';
  var HOME = (typeof window.GB_HOME === 'string' && window.GB_HOME) || '/tools/llm-wiki.html';
  var APPS = [
    { href: '/tools/llm-wiki.html', label: 'Wiki 工作台' },
    { href: '/tools/knowledge-qa.html', label: '知识问答' },
    { href: '/tools/doc-review-agent.html', label: '公文审核' },
  ];
  var mount = document.getElementById('gb-appbar');
  if (!mount) return;
  var path = location.pathname.replace(/\/+$/, '');
  var links = APPS.map(function (app) {
    var active = path.indexOf(app.href.replace('.html', '')) === 0 ? ' gb-tab-active' : '';
    return '<a class="gb-tab' + active + '" href="' + app.href + '">' + app.label + '</a>';
  }).join('');
  var bar = document.createElement('header');
  bar.className = 'gb-appbar';
  bar.innerHTML =
    '<a class="gb-brand" href="' + HOME + '" title="返回图谱工作台">' +
    '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">' +
    '<circle cx="4" cy="4" r="2.2" fill="#2878b5"/><circle cx="14" cy="4" r="2.2" fill="#2878b5"/>' +
    '<circle cx="9" cy="14" r="2.2" fill="#2878b5"/>' +
    '<path d="M4 4L14 4M4 4L9 14M14 4L9 14" stroke="#2878b5" stroke-width="1.2"/></svg>' +
    '<span>graph-builder</span></a>' +
    '<span class="gb-sep"></span>' +
    '<a class="gb-tab" href="' + HOME + '">工作台</a>' +
    '<span class="gb-sep"></span>' +
    links +
    '<span class="gb-drawer"></span>';
  mount.parentNode.insertBefore(bar, mount);

  var style = document.createElement('style');
  style.textContent =
    '.gb-appbar{display:flex;align-items:center;gap:10px;height:44px;padding:0 20px;' +
    'background:#fff;border-bottom:1px solid #e5e7eb;font:13px/1 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;position:relative;z-index:999}' +
    '.gb-brand{display:flex;align-items:center;gap:7px;color:#1f2937;text-decoration:none;font-weight:600;font-size:14px}' +
    '.gb-sep{width:1px;height:16px;background:#e5e7eb}' +
    '.gb-tab{color:#4b5563;text-decoration:none;padding:6px 12px;border-radius:6px;transition:background .15s,color .15s}' +
    '.gb-tab:hover{background:#f0f5fa;color:#2878b5}' +
    '.gb-tab-active{background:#e8f1f8;color:#2878b5;font-weight:600}' +
    '.gb-drawer{flex:1}' +
    '@media (prefers-color-scheme:dark){.gb-appbar{background:#1f2937;border-color:#374151}' +
    '.gb-brand{color:#f9fafb}.gb-sep{background:#374151}.gb-tab{color:#d1d5db}' +
    '.gb-tab:hover{background:#374151;color:#93c5fd}.gb-tab-active{background:#1e3a5f;color:#93c5fd}}';
  document.head.appendChild(style);
})();
