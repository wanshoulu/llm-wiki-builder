'use strict';

/**
 * Knowledge Builder Wiki API — Wiki 库 CRUD + 构建运行管理
 *
 * 端点（前端 axios baseURL /ontomind/wiki/api 去掉前缀后）：
 *   GET    /api/knowledge-builder/wiki/libraries              列表（?status=ACTIVE|ALL）
 *   POST   /api/knowledge-builder/wiki/libraries              创建
 *   PATCH  /api/knowledge-builder/wiki/libraries/:id          更新
 *   POST   /api/knowledge-builder/wiki/libraries/:id/archive  归档
 *   POST   /api/knowledge-builder/wiki/libraries/:id/restore  恢复
 *   DELETE /api/knowledge-builder/wiki/libraries/:id         删除（?purge=1 物理删除，默认软删入回收站）
 *   GET    /api/knowledge-builder/wiki/libraries/:id/pages    页面列表
 *   GET    /api/knowledge-builder/wiki/libraries/:id/build-history  构建历史
 *   GET    /api/knowledge-builder/wiki/runs                   构建运行列表（?project=<id>）
 *   POST   /api/knowledge-builder/wiki/runs/:id/resume        恢复构建运行
 */

const path = require('node:path');
const { createWikiLibraryStore } = require('./knowledge-builder-wiki-libraries');

const WORKSPACE_ROOT = path.join(__dirname, '..');
const WIKI_ROOT = process.env.WIKI_ROOT || path.join(WORKSPACE_ROOT, 'data', 'wiki');
// 老链路专用库根（只读展示）：doc-rules 等公文审核知识库由 doc-review-agent 直接消费，
// 纳入管理页列表便于查看内容，但编辑/构建操作仅限主根
const LEGACY_WIKI_ROOT = process.env.LEGACY_WIKI_ROOT || path.join(WORKSPACE_ROOT, 'wiki');

const store = createWikiLibraryStore({
  workspaceRoot: WORKSPACE_ROOT,
  wikiRoot: WIKI_ROOT,
  extraRoots: [LEGACY_WIKI_ROOT],
  sourcesRoot: path.join(WORKSPACE_ROOT, 'data', 'sources'),
  dataRoot: path.join(WORKSPACE_ROOT, 'data', 'knowledge-builder'),
});

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json;charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise(function (resolve) {
    var chunks = [];
    var total = 0;
    req.on('data', function (chunk) {
      total += chunk.length;
      if (total > 2 * 1024 * 1024) { req.destroy(); resolve({ error: 'Body too large' }); return; }
      chunks.push(chunk);
    });
    req.on('end', function () {
      try { resolve({ data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
      catch (e) { resolve({ error: 'Invalid JSON' }); }
    });
    req.on('error', function () { resolve({ error: 'Request aborted' }); });
  });
}

function handleKnowledgeBuilderWikiRequest(req, res, url) {
  if (req.method === 'OPTIONS') {
    sendJSON(res, 204, {});
    return true;
  }

  var p = req.pathname;
  var method = req.method;

  // ── Libraries collection ──

  // GET /api/knowledge-builder/wiki/libraries?status=ACTIVE|ALL
  if (method === 'GET' && p === '/api/knowledge-builder/wiki/libraries') {
    try {
      var status = url.searchParams.get('status') || 'ALL';
      var result = store.listLibraries({ status: status });
      sendJSON(res, 200, { data: result });
    } catch (e) { sendJSON(res, e.statusCode || 500, { error: e.message, code: e.code }); }
    return true;
  }

  // POST /api/knowledge-builder/wiki/libraries  (create)
  if (method === 'POST' && p === '/api/knowledge-builder/wiki/libraries') {
    parseBody(req).then(function (body) {
      if (body.error) { sendJSON(res, 400, { error: body.error }); return; }
      try {
        var library = store.createLibrary(body.data || {});
        sendJSON(res, 201, { data: library });
      } catch (e) { sendJSON(res, e.statusCode || 500, { error: e.message, code: e.code }); }
    });
    return true;
  }

  // ── Single library actions ──
  var libMatch = p.match(/^\/api\/knowledge-builder\/wiki\/libraries\/([^/]+)(?:\/(.+))?$/);
  if (libMatch) {
    var libraryId = libMatch[1];
    var action = libMatch[2];

    // PATCH /api/knowledge-builder/wiki/libraries/:id  (update)
    if (method === 'PATCH' && !action) {
      parseBody(req).then(function (body) {
        if (body.error) { sendJSON(res, 400, { error: body.error }); return; }
        try {
          var updated = store.updateLibrary(libraryId, body.data || {});
          sendJSON(res, 200, { data: updated });
        } catch (e) { sendJSON(res, e.statusCode || 500, { error: e.message, code: e.code }); }
      });
      return true;
    }

    // POST /api/knowledge-builder/wiki/libraries/:id/archive
    if (method === 'POST' && action === 'archive') {
      try {
        sendJSON(res, 200, { data: store.archiveLibrary(libraryId) });
      } catch (e) { sendJSON(res, e.statusCode || 500, { error: e.message, code: e.code }); }
      return true;
    }

    // POST /api/knowledge-builder/wiki/libraries/:id/restore
    if (method === 'POST' && action === 'restore') {
      try {
        sendJSON(res, 200, { data: store.restoreLibrary(libraryId) });
      } catch (e) { sendJSON(res, e.statusCode || 500, { error: e.message, code: e.code }); }
      return true;
    }

    // DELETE /api/knowledge-builder/wiki/libraries/:id[?purge=1]
    // 默认软删（移入 data/wiki/.trash/ 回收站）；purge=1 物理删除（需前端二次确认）
    if (method === 'DELETE' && !action) {
      try {
        var purge = url.searchParams.get('purge') === '1';
        sendJSON(res, 200, { data: store.deleteLibrary(libraryId, { purge: purge }) });
      } catch (e) { sendJSON(res, e.statusCode || 500, { error: e.message, code: e.code }); }
      return true;
    }

    // GET /api/knowledge-builder/wiki/libraries/:id/pages
    if (method === 'GET' && action === 'pages') {
      try {
        sendJSON(res, 200, { data: store.listPages(libraryId) });
      } catch (e) { sendJSON(res, e.statusCode || 500, { error: e.message, code: e.code }); }
      return true;
    }

    // GET /api/knowledge-builder/wiki/libraries/:id/build-history
    if (method === 'GET' && action === 'build-history') {
      try {
        var history = store.buildHistory(libraryId);
        sendJSON(res, 200, { data: { history: history, total: history.length } });
      } catch (e) { sendJSON(res, e.statusCode || 500, { error: e.message, code: e.code }); }
      return true;
    }
  }

  // ── Build runs ──

  // GET /api/knowledge-builder/wiki/runs?project=<id>
  if (method === 'GET' && p === '/api/knowledge-builder/wiki/runs') {
    try {
      var project = url.searchParams.get('project') || '';
      sendJSON(res, 200, { data: store.listRuns(project) });
    } catch (e) { sendJSON(res, e.statusCode || 500, { error: e.message, code: e.code }); }
    return true;
  }

  // POST /api/knowledge-builder/wiki/runs/:id/resume
  var runMatch = p.match(/^\/api\/knowledge-builder\/wiki\/runs\/([^/]+)\/resume$/);
  if (runMatch && method === 'POST') {
    sendJSON(res, 501, { error: 'Build run resume is not available in standalone mode', code: 'NOT_IMPLEMENTED' });
    return true;
  }

  return false;
}

module.exports = { handleKnowledgeBuilderWikiRequest };
