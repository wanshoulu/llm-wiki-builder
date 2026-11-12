'use strict';

/**
 * Knowledge Studio 精简版 —— 仅保留知识问答页（tools/knowledge-qa.html）依赖的两个端点：
 *   GET /api/knowledge/projects      wiki 项目清单（含页数/状态/更新时间）
 *   GET /api/knowledge/pages/get     读取指定 wiki 页面的 Markdown 原文
 *
 * 上游完整版 routes/knowledge-studio.js 承载知识工作台/公文审核等大块能力，
 * 独立图谱工具用不到，这里基于同一份 knowledge-builder-wiki-libraries 存储
 * 重新实现最小读写面，返回结构与完整版保持一致。
 */

const path = require('node:path');
const fs = require('node:fs');
const { createWikiLibraryStore } = require('./knowledge-builder-wiki-libraries');

const WORKSPACE_ROOT = path.join(__dirname, '..');
// 独立打包版把 wiki/sources 收进 data/（挂卷持久化）；上游 ai-harbor 布局在 workspaceRoot 根
const WIKI_ROOT = process.env.WIKI_ROOT || path.join(WORKSPACE_ROOT, 'wiki');

const libraryStore = createWikiLibraryStore({
  workspaceRoot: WORKSPACE_ROOT,
  wikiRoot: WIKI_ROOT,
  sourcesRoot: path.join(WORKSPACE_ROOT, 'data', 'sources'),
  dataRoot: path.join(WORKSPACE_ROOT, 'data', 'knowledge-builder'),
});

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json;charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function handleListProjects(req, res) {
  try {
    const projects = libraryStore.listLibraries({ status: 'ALL' }).libraries.map((library) => ({
      name: library.name,
      slug: library.wiki_id,
      project: library.wiki_id,
      pages: library.page_count,
      page_count: library.page_count,
      source_count: library.source_count,
      status: library.status,
      updated: library.updated_at ? String(library.updated_at).split('T')[0] : '-',
    }));
    sendJSON(res, 200, { success: true, projects });
  } catch (e) { sendJSON(res, e.statusCode || 500, { success: false, error: e.message, code: e.code }); }
}

function resolveWikiPage(project, page) {
  const library = libraryStore.getLibrary(project);
  const root = path.resolve(WIKI_ROOT, library.wiki_id);
  const normalized = String(page || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const withExtension = normalized.endsWith('.md') ? normalized : normalized + '.md';
  const resolved = path.resolve(root, withExtension);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    const error = new Error('Wiki page path is outside the selected library');
    error.code = 'WIKI_PAGE_PATH_INVALID';
    error.statusCode = 400;
    throw error;
  }
  return { root, file: resolved, relative: withExtension };
}

function handleGetPage(req, res, url) {
  const project = url.searchParams.get('wiki') || url.searchParams.get('project');
  let page = url.searchParams.get('page');
  if (project && page) {
    // page 参数可能已带项目前缀（历史行为），剥掉避免路径翻倍
    const projPrefix = project + '/';
    while (page.startsWith(projPrefix)) page = page.slice(projPrefix.length);
    try {
      const target = resolveWikiPage(project, page);
      if (!fs.existsSync(target.file)) { sendJSON(res, 404, { success: false, error: 'Page not found' }); return; }
      sendJSON(res, 200, { success: true, project, page: target.relative, content: fs.readFileSync(target.file, 'utf-8') });
    } catch (error) { sendJSON(res, error.statusCode || 500, { success: false, error: error.message, code: error.code }); }
    return;
  }
  sendJSON(res, 400, { success: false, error: 'Missing wiki/project and page', code: 'WIKI_LIBRARY_REQUIRED' });
}

function handleKnowledgeStudioLiteRequest(req, res, url) {
  if (req.method === 'GET' && req.pathname === '/api/knowledge/projects') { handleListProjects(req, res); return true; }
  if (req.method === 'GET' && req.pathname === '/api/knowledge/pages/get') { handleGetPage(req, res, url); return true; }
  return false;
}

module.exports = { handleKnowledgeStudioLiteRequest };
