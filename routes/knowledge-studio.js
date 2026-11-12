/**
 * Knowledge Studio — Unified Knowledge API Router
 * Merges: llm-wiki-api.js + knowledge-studio-api.js + wiki-graph-api.js + server.js inline /api/wiki/*
 * All endpoints under /api/knowledge/* with backward-compatible aliases for old paths.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const { ProjectScanner, WikiEngine, GraphBuilder, SearchEngine, WikiMaintainer, CONFIG, ensureDirs } = require('../tools/llm-wiki-engine');
const { WikiGraphBuilder } = require('../tools/wiki-graph-builder');
const { RAGEngine } = require('../tools/rag-engine');
const { GraphExtractor } = require('../tools/graph-extractor');
const { API_ROUTES, DEFAULT_CHAT_MODEL } = require('../config/api-keys');
const { searchWeb } = require('../tools/web-search-providers');
const usageEventLog = require('../tools/usage-event-log');
// 独立仓：MCP 域依赖懒加载（wiki 工具不路由 /api/mcp，无需启动时加载）
let evalDatasetTools = null; function getEvalDatasetTools(){ if(!evalDatasetTools) evalDatasetTools = require('../tools/eval-dataset-tools'); return evalDatasetTools; }
let intentTestsetTools = null; function getIntentTestsetTools(){ if(!intentTestsetTools) intentTestsetTools = require('./intent-testset'); return intentTestsetTools; }
const { createWikiLibraryStore } = require('./knowledge-builder-wiki-libraries');

CONFIG.wikiRoot = path.join(__dirname, '../wiki');
CONFIG.rawRoot = path.join(__dirname, '../wiki-raw');
CONFIG.indexPath = path.join(__dirname, '../wiki-index.json');
CONFIG.graphPath = path.join(__dirname, '../wiki-graph.json');

function createKnowledgeStudioWikiFacade(options) {
  const opts = options || {};
  const workspaceRoot = path.resolve(opts.workspaceRoot || path.join(__dirname, '..'));
  const wikiRoot = path.resolve(opts.wikiRoot || path.join(workspaceRoot, 'wiki'));
  const libraryStore = opts.wikiLibraryStore || createWikiLibraryStore({
    workspaceRoot,
    wikiRoot,
    sourcesRoot: opts.sourcesRoot || path.join(workspaceRoot, 'sources'),
    dataRoot: opts.dataRoot || path.join(workspaceRoot, 'data', 'knowledge-builder'),
  });

  function listProjects() {
    return libraryStore.listLibraries({ status: 'ALL' }).libraries.map((library) => ({
      name: library.name,
      slug: library.wiki_id,
      project: library.wiki_id,
      pages: library.page_count,
      page_count: library.page_count,
      source_count: library.source_count,
      status: library.status,
      updated: library.updated_at ? String(library.updated_at).split('T')[0] : '-',
    }));
  }

  function listAllPages(wikiId) {
    const library = libraryStore.getLibrary(wikiId);
    const root = path.join(wikiRoot, library.wiki_id);
    const docs = [];
    const scan = (directory, relativeRoot) => {
      fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
        if (entry.name.startsWith('.')) return;
        const fullPath = path.join(directory, entry.name);
        const relativePath = relativeRoot ? relativeRoot + '/' + entry.name : entry.name;
        if (entry.isDirectory()) scan(fullPath, relativePath);
        else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'log.md') {
          const stat = fs.statSync(fullPath);
          const content = fs.readFileSync(fullPath, 'utf8');
          let title = entry.name.replace(/\.md$/, '');
          let parent = '';
          const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          if (frontmatter) {
            const titleMatch = frontmatter[1].match(/title:\s*"?([^"\n]+)"?/);
            const parentMatch = frontmatter[1].match(/parent:\s*"?([^"\n]+)"?/);
            if (titleMatch) title = titleMatch[1].trim();
            if (parentMatch) parent = parentMatch[1].trim();
          }
          docs.push({
            id: relativePath.replace(/\.md$/, ''), title, fileName: relativePath, type: 'file',
            size: stat.size, modified: stat.mtime.toISOString(), parent, preview: content.slice(0, 200),
          });
        }
      });
    };
    if (fs.existsSync(root)) scan(root, '');
    const byId = Object.fromEntries(docs.map((doc) => [doc.id, doc]));
    const tree = [];
    docs.forEach((doc) => {
      if (doc.parent && byId[doc.parent]) {
        if (!byId[doc.parent].children) byId[doc.parent].children = [];
        byId[doc.parent].children.push(doc);
      } else tree.push(doc);
    });
    return { wiki_id: library.wiki_id, project: library.wiki_id, docs, tree, fsTree: buildFsTree(root, '').children || [], total: docs.length };
  }

  return { libraryStore, listProjects, listAllPages };
}

const knowledgeStudioWiki = createKnowledgeStudioWikiFacade({
  workspaceRoot: path.join(__dirname, '..'),
  wikiRoot: CONFIG.wikiRoot,
});
const { createKnowledgeSourceService } = require('../tools/doc-review-agent/knowledge-source');
const docReviewKnowledge = createKnowledgeSourceService({
  workspaceRoot: path.join(__dirname, '..'),
  wikiRoot: CONFIG.wikiRoot,
});

function publicDocReviewKnowledgeSource(source) {
  if (!source) return null;
  return {
    wiki_id: source.wiki_id,
    name: source.name,
    description: source.description,
    build_profile: source.build_profile,
    mode: source.mode,
    ready: source.ready,
    release_version: source.release_version,
    graph_available: source.graph_available,
    updated_at: source.updated_at,
    page_count: source.page_count,
    message: source.message,
  };
}

let scanner = new ProjectScanner('D:\\project');
const wikiEngine = new WikiEngine();
const wikiMaintainer = new WikiMaintainer(wikiEngine);
const graphBuilder = new GraphBuilder();
const searchEngine = new SearchEngine();
const { SemanticSearch } = require('../tools/semantic-search');
const semanticEngine = new SemanticSearch();  // 保留供 RAG 路径使用（不用于 Wiki 检索）

// Wiki 检索：轻量 manifest index（仅 YAML frontmatter，不读全文，不做 embedding）
// 流程：manifest 匹配 → 确定候选范围 → 按需 fs.readFileSync 加载全文
const { WikiManifestIndex, WikiStore } = require('../tools/wiki-manifest-index');
const wikiManifest = new WikiManifestIndex();

// WikiStore：文件读写 + manifest 索引维护。写入操作内部自动重建索引。
function _getWikiStore(wikiDir) {
  return new WikiStore(wikiDir, wikiManifest);
}

// Manifest index：Wiki 写入时生成，查询时加载。build() 内置 mtime 缓存，命中时 O(1)。
function _loadManifest(wikiDir) {
  if (!fs.existsSync(wikiDir)) return;
  wikiManifest.build(wikiDir);
}
function _listWikiPages(wikiDir) {
  var result = [];
  if (!fs.existsSync(wikiDir)) return result;
  function walk(dir, prefix) {
    prefix = prefix || '';
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.forEach(function(e) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        walk(path.join(dir, e.name), prefix + e.name + '/');
      } else if (e.isFile() && e.name.endsWith('.md')) {
        result.push(prefix + e.name);
      }
    });
  }
  walk(wikiDir);
  return result;
}

// Dynamic singletons — created per-project
const queues = {};    // projectName → IngestQueue
const watchers = {};  // projectName → SourceWatcher
const reviews = {};   // projectName → ReviewSystem

// RAG 引擎单例池已抽至 tools/rag-engine-pool.js（统一检索共享同一实例，防双份内存与缓存写冲突）
const ragEnginePool = require('../tools/rag-engine-pool');
let unifiedSearchCore = null; function getUnifiedSearchCore(){ if(!unifiedSearchCore) unifiedSearchCore = require('../tools/unified-search').unifiedSearchCore; return unifiedSearchCore; }

const { handleConvertStream } = require('./knowledge-converter');
const { IngestQueue } = require('../tools/ingest-queue');
const { SourceWatcher } = require('../tools/source-watcher');
const { ReviewSystem } = require('../tools/review-system');

// ── Helpers ──

function getWikiProjectPath(projectName) {
  const mappingFile = path.join(CONFIG.wikiRoot, '.mappings.json');
  if (fs.existsSync(mappingFile)) {
    try { const m = JSON.parse(fs.readFileSync(mappingFile, 'utf-8')); if (m[projectName]) return m[projectName]; } catch (e) {}
  }
  return path.join(CONFIG.wikiRoot, projectName);
}

function sendJSON(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json;charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ── Evaluation Findings Storage ──

const FINDINGS_FILE = path.join(__dirname, '..', 'data', 'wiki-evaluation-findings.json');

function readFindings() {
  try { return JSON.parse(fs.readFileSync(FINDINGS_FILE, 'utf8')); }
  catch (_) { return { findings: [] }; }
}

function writeFindings(store) {
  const dir = path.dirname(FINDINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FINDINGS_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function findFindingById(id) {
  const store = readFindings();
  return { store, finding: store.findings.find(function (f) { return f.id === id; }) };
}

function callLLM(prompt, systemPrompt) {
  var route = API_ROUTES[DEFAULT_CHAT_MODEL];
  if (!route) return Promise.resolve(null);
  var apiKey = route.getKey && route.getKey();
  if (!apiKey) return Promise.resolve(null);
  var pd = JSON.stringify({
    model: route.model || DEFAULT_CHAT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 4096, temperature: 0.3,
  });
  var opts = {
    hostname: route.host, port: 443, path: route.path, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Content-Length': Buffer.byteLength(pd) },
  };
  return new Promise(function (resolve) {
    var r = https.request(opts, function (resp) {
      var d = '';
      resp.on('data', function (c) { d += c; });
      resp.on('end', function () {
        try { var j = JSON.parse(d); resolve(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || null); }
        catch (e) { resolve(null); }
      });
    });
    r.on('error', function () { resolve(null); });
    r.write(pd); r.end();
  });
}

function createWikiEngineForModel(model) {
  const sm = model || DEFAULT_CHAT_MODEL;
  const route = API_ROUTES[sm];
  const apiKey = route && route.getKey && route.getKey();
  if (!route || !apiKey || route.path.includes('/embeddings')) return { engine: wikiEngine, model: 'local', provider: 'local' };
  return { engine: new WikiEngine({ chatRoute: route, chatApiKey: apiKey, chatModel: sm }), model: sm, provider: route.provider || 'unknown' };
}

function assertWikiWritable(project) {
  return knowledgeStudioWiki.libraryStore.assertWritable(project);
}

function resolveWikiPage(project, page) {
  const library = knowledgeStudioWiki.libraryStore.getLibrary(project);
  const root = path.resolve(CONFIG.wikiRoot, library.wiki_id);
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

// ── Obsidian-Wiki FS tree ──

const OW_FILE_ORDER = ['index.md', 'log.md', 'hot.md', '.manifest.json'];
const OW_DIR_ORDER = ['concepts', 'entities', 'sources', 'syntheses'];

function getOwSortKey(name, isDir) {
  if (isDir) { const di = OW_DIR_ORDER.indexOf(name); return di >= 0 ? 10 + di : 90; }
  const fi = OW_FILE_ORDER.indexOf(name); if (fi >= 0) return fi;
  if (name.endsWith('.md')) return 50; if (name.endsWith('.json')) return 51; return 99;
}

function buildFsTree(dirPath, relPath) {
  const node = { title: relPath || 'wiki/', key: relPath || 'wiki_root', children: [], isDir: true };
  if (!fs.existsSync(dirPath)) return node;
  fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => {
    const ak = getOwSortKey(a.name, a.isDirectory()), bk = getOwSortKey(b.name, b.isDirectory());
    return ak !== bk ? ak - bk : a.name.localeCompare(b.name);
  }).forEach(e => {
    if (e.isDirectory()) {
      node.children.push(buildFsTree(path.join(dirPath, e.name), relPath ? relPath + '/' + e.name : e.name));
    } else if (e.name.endsWith('.md') || e.name === '.manifest.json') {
      const fr = relPath ? relPath + '/' + e.name : e.name;
      const st = fs.statSync(path.join(dirPath, e.name));
      node.children.push({ title: e.name, key: 'f:' + fr, fileName: fr, size: st.size, modified: st.mtime.toISOString(), isLeaf: true, isDir: false });
    }
  });
  return node;
}

// ── System prompt ──

const LLM_WIKI_SYSTEM_PROMPT = '# LLM Wiki 结构化文档体系生成指令\n\n你是一名知识架构师,擅长将非结构化文档转化为结构化的Wiki知识体系。\n\n使用 `---DOCUMENT:文件名---` 作为文档分隔符输出5个文档。\n\n禁止使用"等"、"详见原文"、"以此类推", 所有内容必须来源于原始文档。';

// ═══════════════════════════════════════════════
// Main Dispatcher
// ═══════════════════════════════════════════════

function handleKnowledgeStudioRequest(req, res) {
  const rawUrl = req.url || '/';
  let url;
  try { url = new URL(rawUrl, 'http://' + (req.headers.host || 'localhost')); } catch (e) { return false; }
  const pathname = url.pathname;
  const method = req.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return true;
  }

  // ── Projects ──
  if (method === 'GET' && pathname === '/api/knowledge/projects') { handleListProjects(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/projects/scan') { handleScanProjects(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/projects/load') { handleLoadProject(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/projects/init') { handleInitProject(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/projects/delete') { handleDeleteProject(req, res); return true; }

  // ── Documents ──
  if (method === 'POST' && pathname === '/api/knowledge/documents/upload') { handleDocumentUpload(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/documents/convert-stream') { handleConvertStream(req, res); return true; }

  // ── Raw Document Library ──
  if (method === 'GET' && pathname === '/api/knowledge/raw/list') { handleRawList(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/raw/upload') { handleRawUpload(req, res); return true; }
  if (method === 'DELETE' && pathname === '/api/knowledge/raw/delete') { handleRawDelete(req, res); return true; }

  // ── Ingest ──
  if (method === 'POST' && pathname === '/api/knowledge/ingest') { handleIngest(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/ingest/generate-stream') { handleGenerateStream(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/ingest/detail') { handleIngestDetail(req, res); return true; }

  // ── Pages ──
  if (method === 'GET' && pathname === '/api/knowledge/pages/list') { handleListPages(req, res, url); return true; }
  if (method === 'GET' && pathname === '/api/knowledge/pages/list-all') { handleListAllPages(req, res, url); return true; }
  if (method === 'GET' && pathname === '/api/knowledge/pages/get') { handleGetPage(req, res, url); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/pages/save') { handleSavePage(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/pages/delete') { handleDeletePage(req, res); return true; }

  // ── Graph ──
  if (method === 'GET' && pathname === '/api/knowledge/graph') { handleGetGraph(req, res, url); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/graph/build') { handleBuildGraph(req, res); return true; }
  if (method === 'GET' && pathname === '/api/knowledge/graph/generate-stream') { handleGraphGenerateStream(req, res, url); return true; }
  if (method === 'GET' && pathname === '/api/knowledge/graph/data') { handleGraphData(req, res, url); return true; }

  // ── Search & QA ──
  if (method === 'POST' && pathname === '/api/knowledge/search') { handleSearch(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/qa') { handleQA(req, res); return true; }

  // ── Lint & Health ──
  if (method === 'POST' && pathname === '/api/knowledge/lint') { handleLint(req, res); return true; }
  if (method === 'GET' && pathname === '/api/knowledge/architecture') { handleArchitecture(req, res); return true; }
  if (method === 'GET' && pathname === '/api/knowledge/log') { handleGetLog(req, res, url); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/query-archive') { handleQueryArchive(req, res); return true; }

  // ── Ingest Queue ──
  if (method === 'GET' && pathname === '/api/knowledge/queue/status') { handleQueueStatus(req, res, url); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/queue/start') { handleQueueStart(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/queue/stop') { handleQueueStop(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/queue/pause') { handleQueuePause(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/queue/resume') { handleQueueResume(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/queue/remove') { handleQueueRemove(req, res); return true; }

  // ── Source Watcher ──
  if (method === 'POST' && pathname === '/api/knowledge/watcher/start') { handleWatcherStart(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/watcher/stop') { handleWatcherStop(req, res); return true; }

  // ── Review System ──
  if (method === 'GET' && pathname === '/api/knowledge/review/list') { handleReviewList(req, res, url); return true; }
  if (method === 'GET' && pathname === '/api/knowledge/review/stats') { handleReviewStats(req, res, url); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/review/approve') { handleReviewApprove(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/review/reject') { handleReviewReject(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/review/skip') { handleReviewSkip(req, res); return true; }

  // ── RAG ──
  if (method === 'POST' && pathname === '/api/knowledge/rag/build') { handleRAGBuild(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/rag/update') { handleRAGUpdate(req, res); return true; }
  if (method === 'GET' && pathname === '/api/knowledge/rag/status') { handleRAGStatus(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/rag/search') { handleRAGSearch(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/rag/graph-search') { handleRAGGraphSearch(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/rag/watch') { handleRAGWatch(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/rag/preview') { handleRAGPreview(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/rag/docs/delete') { handleRAGDocDelete(req, res); return true; }
  if (method === 'GET' && pathname === '/api/knowledge/rag/tasks') { handleRAGTasks(req, res); return true; }
  if (method === 'GET' && pathname === '/api/knowledge/rag/chunks') { handleRAGChunks(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/rag/chunk/update') { handleRAGChunkUpdate(req, res); return true; }

  // ── Graph Extraction ──
  if (method === 'POST' && pathname === '/api/knowledge/graph/extract') { handleGraphExtract(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/graph/fuse') { handleGraphFuse(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/graph/communities/summarize') { handleCommunitySummarize(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/graph/rag') { handleGraphRAG(req, res); return true; }

  // ── Dashboard ──
  if (method === 'GET' && pathname === '/api/knowledge/dashboard') { handleDashboard(req, res); return true; }

  // ── MCP ──
  if (method === 'POST' && pathname === '/api/knowledge/mcp') { handleMCP(req, res); return true; }
  // 短别名：外部经 nginx /ontomind/wiki/api/mcp → /api/mcp（与知识出口文档卡片一致）
  if (method === 'POST' && pathname === '/api/mcp') { handleMCP(req, res); return true; }

  // ── Agent (对公营销) 已迁移至 corporate-marketing-agent 独立服务 (openjiuwen DeepAgent) ──
  // 旧路由 /api/knowledge/agent/chat 和 /api/knowledge/agent/skills 已移除
  // 新路由：/api/corporate-marketing-agent/chat (SSE) 和 /api/corporate-marketing-agent/query (JSON)

  // ── Agent (公文审核) ──
  if (method === 'POST' && pathname === '/api/knowledge/doc-review-agent/chat') { handleDocReviewChat(req, res); return true; }
  if (method === 'GET'  && pathname === '/api/knowledge/doc-review-agent/skills') { handleDocReviewSkills(req, res); return true; }
  if (method === 'GET'  && pathname === '/api/knowledge/doc-review-agent/knowledge-sources') { handleDocReviewKnowledgeSources(req, res); return true; }
  if (method === 'GET'  && pathname === '/api/knowledge/doc-review-agent/wiki-page') { handleDocReviewWikiPage(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/doc-review-agent/review') { handleDocReviewRun(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/doc-review-agent/review-marks') { handleDocReviewMarks(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/doc-review-agent/apply-marks') { handleDocApplyMarks(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/doc-review-agent/upload-review') { handleDocUploadReview(req, res); return true; }
  if (method === 'GET'  && pathname === '/api/knowledge/doc-review-agent/wiki-graph') { handleDocReviewWikiGraph(req, res); return true; }

  // ── Evaluation Findings ──
  if (method === 'GET'  && pathname === '/api/knowledge/evaluation/findings') { handleListFindings(req, res); return true; }
  if (method === 'POST' && pathname === '/api/knowledge/evaluation/findings') { handleCreateFinding(req, res); return true; }
  var analyzeMatch = pathname.match(/^\/api\/knowledge\/evaluation\/findings\/([^/]+)\/analyze$/);
  if (analyzeMatch && method === 'POST') { handleAnalyzeBadcase(req, res, analyzeMatch[1]); return true; }
  var contextMatch = pathname.match(/^\/api\/knowledge\/evaluation\/findings\/([^/]+)\/context$/);
  if (contextMatch && method === 'GET') { handleGetBadcaseContext(req, res, url, contextMatch[1]); return true; }
  var retestMatch = pathname.match(/^\/api\/knowledge\/evaluation\/findings\/([^/]+)\/retest$/);
  if (retestMatch && method === 'POST') { handleRetestFinding(req, res, retestMatch[1]); return true; }
  var patchFindingMatch = pathname.match(/^\/api\/knowledge\/evaluation\/findings\/([^/]+)$/);
  if (patchFindingMatch && method === 'PATCH') { handleUpdateFinding(req, res, patchFindingMatch[1]); return true; }

  // ── Backward Compatibility Aliases ──

  // /api/llm-wiki/* → /api/knowledge/*
  if (pathname.startsWith('/api/llm-wiki/')) {
    const remap = {
      '/api/llm-wiki/scan': '/api/knowledge/projects/scan',
      '/api/llm-wiki/load': '/api/knowledge/projects/load',
      '/api/llm-wiki/delete': '/api/knowledge/projects/delete',
      '/api/llm-wiki/upload': '/api/knowledge/documents/upload',
      '/api/llm-wiki/generate': '/api/knowledge/ingest/generate-stream',
      '/api/llm-wiki/ingest': '/api/knowledge/ingest',
      '/api/llm-wiki/graph/build': '/api/knowledge/graph/build',
      '/api/llm-wiki/graph': '/api/knowledge/graph',
      '/api/llm-wiki/page': '/api/knowledge/pages/get',
      '/api/llm-wiki/pages': '/api/knowledge/pages/list',
      '/api/llm-wiki/page/save': '/api/knowledge/pages/save',
      '/api/llm-wiki/page/delete': '/api/knowledge/pages/delete',
      '/api/llm-wiki/search': '/api/knowledge/search',
      '/api/llm-wiki/qa': '/api/knowledge/qa',
      '/api/llm-wiki/projects': '/api/knowledge/projects',
    };
    const mapped = remap[pathname] || pathname.replace('/api/llm-wiki/', '/api/knowledge/');
    req.url = mapped + (rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '');
    return handleKnowledgeStudioRequest(req, res);
  }

  // /api/knowledge-studio/* → /api/knowledge/*
  if (pathname.startsWith('/api/knowledge-studio/')) {
    const remap = {
      '/api/knowledge-studio/architecture': '/api/knowledge/architecture',
      '/api/knowledge-studio/init-project': '/api/knowledge/projects/init',
      '/api/knowledge-studio/query-archive': '/api/knowledge/query-archive',
      '/api/knowledge-studio/lint': '/api/knowledge/lint',
      '/api/knowledge-studio/graph': '/api/knowledge/graph',
      '/api/knowledge-studio/log': '/api/knowledge/log',
      '/api/knowledge-studio/ingest-detail': '/api/knowledge/ingest/detail',
    };
    const mapped = remap[pathname] || pathname.replace('/api/knowledge-studio/', '/api/knowledge/');
    req.url = mapped + (rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '');
    return handleKnowledgeStudioRequest(req, res);
  }

  // /api/wiki/* → /api/knowledge/pages/*
  if (pathname === '/api/wiki/list' && method === 'GET') { req.url = '/api/knowledge/pages/list-all'; return handleKnowledgeStudioRequest(req, res); }
  if (pathname === '/api/wiki/detail' && method === 'GET') {
    const f = url.searchParams.get('file');
    req.url = '/api/knowledge/pages/get?page=' + encodeURIComponent(f || '');
    return handleKnowledgeStudioRequest(req, res);
  }
  if (pathname === '/api/wiki/save' && method === 'POST') { req.url = '/api/knowledge/pages/save'; return handleKnowledgeStudioRequest(req, res); }

  // /api/evaluation/findings → /api/knowledge/evaluation/findings
  if (pathname.startsWith('/api/evaluation/findings')) {
    req.url = pathname.replace('/api/evaluation/findings', '/api/knowledge/evaluation/findings') + (rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '');
    return handleKnowledgeStudioRequest(req, res);
  }

  // /api/wiki-graph/* → /api/knowledge/graph/*
  if (pathname === '/api/wiki-graph/generate' && method === 'GET') { req.url = '/api/knowledge/graph/generate-stream?' + url.searchParams.toString(); return handleKnowledgeStudioRequest(req, res); }
  if (pathname === '/api/wiki-graph/data' && method === 'GET') { req.url = '/api/knowledge/graph/data?' + url.searchParams.toString(); return handleKnowledgeStudioRequest(req, res); }

  // /llm-wiki tool page
  if (method === 'GET' && pathname === '/llm-wiki') {
    const lp = path.join(__dirname, '../tools/llm-wiki-light.html');
    const legacy = path.join(__dirname, '../tools/llm-wiki.html');
    const hp = fs.existsSync(lp) ? lp : legacy;
    if (fs.existsSync(hp)) { res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); res.end(fs.readFileSync(hp, 'utf-8')); }
    else { res.writeHead(404); res.end('Not found'); }
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════════
// PROJECT Handlers
// ═══════════════════════════════════════════════

function handleListProjects(req, res) {
  try {
    sendJSON(res, 200, { success: true, projects: knowledgeStudioWiki.listProjects() });
  } catch (e) { sendJSON(res, e.statusCode || 500, { success: false, error: e.message, code: e.code }); }
}

async function handleScanProjects(req, res) {
  try {
    const body = await parseBody(req);
    const sp = body.path || 'D:\\project';
    scanner = new ProjectScanner(sp);
    const projects = scanner.scan(sp, 0, 2);
    const meaningful = projects.filter(p => p.type === 'directory' && (p.docCount > 0 || p.codeCount > 0 || p.hasReadme || p.hasClaudeMd));
    sendJSON(res, 200, { success: true, path: sp, projects: meaningful.slice(0, 50), total: meaningful.length });
  } catch (e) { sendJSON(res, e.statusCode || 500, { success: false, error: e.message, code: e.code }); }
}

async function handleLoadProject(req, res) {
  try {
    const body = await parseBody(req);
    const { path: wp, name } = body;
    if (!wp) { sendJSON(res, 400, { success: false, error: 'Missing path' }); return; }
    if (!fs.existsSync(wp)) { sendJSON(res, 404, { success: false, error: 'Dir not found' }); return; }
    const files = fs.readdirSync(wp).filter(f => f.endsWith('.md'));
    const pn = name || path.basename(wp);
    const target = path.join(CONFIG.wikiRoot, pn);
    if (fs.existsSync(target)) { sendJSON(res, 200, { success: true, pages: files.length, path: wp, message: 'Already exists' }); return; }
    const mf = path.join(CONFIG.wikiRoot, '.mappings.json');
    let mappings = {};
    if (fs.existsSync(mf)) { try { mappings = JSON.parse(fs.readFileSync(mf, 'utf-8')); } catch (e) {} }
    mappings[pn] = wp;
    if (!fs.existsSync(CONFIG.wikiRoot)) fs.mkdirSync(CONFIG.wikiRoot, { recursive: true });
    fs.writeFileSync(mf, JSON.stringify(mappings, null, 2));
    sendJSON(res, 200, { success: true, pages: files.length, path: wp, name: pn });
  } catch (e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

async function handleInitProject(req, res) {
  try {
    const body = await parseBody(req);
    const project = body.project || body.wiki_id;
    if (!project) { sendJSON(res, 400, { success: false, error: 'Missing project', code: 'WIKI_LIBRARY_ID_INVALID' }); return; }
    let library;
    try { library = knowledgeStudioWiki.libraryStore.getLibrary(project); }
    catch (error) {
      if (error.code !== 'WIKI_LIBRARY_NOT_FOUND') throw error;
      library = knowledgeStudioWiki.libraryStore.createLibrary({ wiki_id: project, name: body.name || project, description: body.description });
    }
    sendJSON(res, 200, { success: true, project: library.wiki_id, wikiPath: getWikiProjectPath(library.wiki_id), library, message: 'Wiki library ready' });
  } catch (e) { sendJSON(res, e.statusCode || 500, { success: false, error: e.message, code: e.code }); }
}

async function handleDeleteProject(req, res) {
  try {
    const body = await parseBody(req);
    const { project } = body;
    if (!project) { sendJSON(res, 400, { success: false, error: 'Missing project' }); return; }
    const library = knowledgeStudioWiki.libraryStore.archiveLibrary(project);
    sendJSON(res, 200, { success: true, library, message: 'Archived without deleting content' });
  } catch (e) { sendJSON(res, e.statusCode || 500, { success: false, error: e.message, code: e.code }); }
}

// ═══════════════════════════════════════════════
// DOCUMENT Handlers
// ═══════════════════════════════════════════════

function handleDocumentUpload(req, res) {
  try {
    const formidable = require('formidable');
    const utd = path.join(CONFIG.rawRoot, 'upload-temp');
    const form = new formidable.IncomingForm({ uploadDir: utd, keepExtensions: true, maxFileSize: 50 * 1024 * 1024, multiples: true });
    if (!fs.existsSync(utd)) fs.mkdirSync(utd, { recursive: true });
    form.parse(req, async (err, fields, files) => {
      if (err) { sendJSON(res, 500, { error: 'Upload failed: ' + err.message }); return; }
      try {
        const uf = [].concat(files.files || []);
        if (!uf.length) { sendJSON(res, 400, { error: 'No files' }); return; }
        const pn = 'upload-' + Date.now();
        const pd = path.join(CONFIG.rawRoot, pn);
        fs.mkdirSync(pd, { recursive: true });
        for (const f of uf) { const dn = f.originalFilename || path.basename(f.filepath); fs.copyFileSync(f.filepath, path.join(pd, dn)); }
        const results = await wikiEngine.ingest(pd, { projectName: pn, recursive: true });
        try { fs.rmSync(pd, { recursive: true, force: true }); } catch (e) {}
        sendJSON(res, 200, { success: true, processed: results.processed || uf.length, project: results.slug || pn, results });
      } catch (e) { sendJSON(res, 500, { error: 'Wiki ingest failed: ' + e.message }); }
    });
  } catch (e) { sendJSON(res, 500, { error: 'Upload error: ' + e.message }); }
}

// ═══════════════════════════════════════════════
// RAW DOCUMENT LIBRARY Handlers
// ═══════════════════════════════════════════════

function getRawLibDir() {
  const dir = path.join(CONFIG.rawRoot, 'library');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function handleRawList(req, res) {
  try {
    const libDir = getRawLibDir();
    const files = [];
    const seen = new Set();

    // 1. Scan local wiki-raw/library/
    const scan = (dir, relPath) => {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) {
          scan(fp, relPath ? relPath + '/' + e.name : e.name);
        } else {
          const st = fs.statSync(fp);
          const ext = path.extname(e.name).toLowerCase().slice(1);
          seen.add(e.name);
          files.push({
            name: e.name,
            path: relPath ? relPath + '/' + e.name : e.name,
            size: st.size,
            ext: ext,
            source: 'local',
            uploadedAt: st.mtime.toISOString(),
          });
        }
      });
    };
    scan(libDir, '');

    // 2. Also fetch from OntoMind Java backend (port 8080)
    try {
      const http = require('http');
      const ontomindFiles = await new Promise((resolve, reject) => {
        http.get('http://localhost:8080/api/v1/file-uploads?tenantId=default&size=500', (r) => {
          let body = '';
          r.on('data', c => body += c);
          r.on('end', () => {
            try {
              const j = JSON.parse(body);
              resolve((j.data || []).filter(f => f.status === 'COMPLETED'));
            } catch { resolve([]); }
          });
        }).on('error', () => resolve([]));
      });
      ontomindFiles.forEach(f => {
        const ext = (f.originalFilename || '').split('.').pop().toLowerCase();
        const key = f.originalFilename || f.filename;
        if (!seen.has(key)) {
          seen.add(key);
          files.push({
            id: f.id,
            name: f.originalFilename,
            path: f.originalFilename,
            size: f.fileSize || 0,
            ext: ext || f.fileType?.toLowerCase() || 'txt',
            source: 'ontomind',
            uploadedAt: f.createdAt,
          });
        }
      });
    } catch (_) { /* ignore ontomind fetch errors */ }

    files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    sendJSON(res, 200, { files, total: files.length });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

async function handleRawUpload(req, res) {
  try {
    const formidable = require('formidable');
    const libDir = getRawLibDir();
    const form = new formidable.IncomingForm({
      uploadDir: libDir,
      keepExtensions: true,
      maxFileSize: 200 * 1024 * 1024, // 200MB
      multiples: true,
    });

    form.parse(req, (err, fields, uploadedFiles) => {
      if (err) { sendJSON(res, 500, { error: 'Upload failed: ' + err.message }); return; }
      const uf = [].concat(uploadedFiles.files || uploadedFiles.file || []);
      if (!uf.length) { sendJSON(res, 400, { error: 'No files' }); return; }

      const results = [];
      uf.forEach(f => {
        const originalName = f.originalFilename || path.basename(f.filepath);
        let destPath = path.join(libDir, originalName);
        // Handle name collisions
        if (fs.existsSync(destPath)) {
          const ext = path.extname(originalName);
          const base = path.basename(originalName, ext);
          destPath = path.join(libDir, base + '-' + Date.now() + ext);
        }
        fs.copyFileSync(f.filepath, destPath);
        // Clean up temp file
        try { fs.unlinkSync(f.filepath); } catch (_) { /* ignore */ }
        const st = fs.statSync(destPath);
        const ext = path.extname(destPath).toLowerCase().slice(1);
        results.push({
          name: path.basename(destPath),
          originalName: originalName,
          path: path.basename(destPath),
          size: st.size,
          ext: ext,
          uploadedAt: st.mtime.toISOString(),
        });
      });
      sendJSON(res, 200, { success: true, files: results });
    });
  } catch (e) {
    sendJSON(res, 500, { error: 'Upload error: ' + e.message });
  }
}

async function handleRawDelete(req, res) {
  try {
    const body = await parseBody(req);
    const filePath = body.path;
    if (!filePath) { sendJSON(res, 400, { error: 'Missing file path' }); return; }

    // Security: prevent directory traversal
    const safeName = path.basename(filePath);
    const fullPath = path.join(getRawLibDir(), safeName);

    if (!fs.existsSync(fullPath)) { sendJSON(res, 404, { error: 'File not found' }); return; }
    fs.unlinkSync(fullPath);
    sendJSON(res, 200, { success: true });
  } catch (e) {
    sendJSON(res, 500, { error: 'Delete failed: ' + e.message });
  }
}

// ═══════════════════════════════════════════════
// INGEST Handlers
// ═══════════════════════════════════════════════

async function handleIngest(req, res) {
  try {
    const body = await parseBody(req);
    const { path: pp, projectName, wikiModel } = body;
    if (!pp) { sendJSON(res, 400, { success: false, error: 'Missing path' }); return; }
    const targetProject = projectName || path.basename(pp);
    assertWikiWritable(targetProject);
    const rt = createWikiEngineForModel(wikiModel);
    const results = await rt.engine.ingest(pp, { projectName: targetProject, recursive: true });
    results.model = rt.model; results.provider = rt.provider;
    sendJSON(res, 200, { success: true, results, model: rt.model, provider: rt.provider });
  } catch (e) { sendJSON(res, e.statusCode || 500, { success: false, error: e.message, code: e.code }); }
}

async function handleGenerateStream(req, res) {
  try {
    const body = await parseBody(req);
    const { model, markdown, systemPrompt } = body;
    if (!markdown || !systemPrompt) { sendJSON(res, 400, { error: 'Missing markdown or systemPrompt' }); return; }
    let apiRoute = DEFAULT_CHAT_MODEL, modelId = DEFAULT_CHAT_MODEL;
    if (model && model.startsWith('qwen')) { apiRoute = 'qwen-plus'; modelId = 'qwen-plus'; }
    else if (model && model.startsWith('kimi')) { apiRoute = 'kimi-latest'; modelId = 'moonshot-v1-8k'; }
    const rc = API_ROUTES[apiRoute];
    if (!rc) { sendJSON(res, 500, { error: 'Route not configured' }); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain;charset=utf-8', 'Transfer-Encoding': 'chunked', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const lr = { model: modelId, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: 'Analyze and generate Wiki:\n\n' + markdown }], stream: true, temperature: 0.3, max_tokens: 8000 };
    try {
      const llmRes = await fetch(rc.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + rc.apiKey }, body: JSON.stringify(lr) });
      if (!llmRes.ok) { res.end('LLM API failed: ' + llmRes.status); return; }
      const reader = llmRes.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
            try { const d = JSON.parse(line.slice(6)); const c = d.choices?.[0]?.delta?.content || ''; if (c) res.write(c); } catch (e) {}
          }
        }
      }
    } catch (e) { res.end('Stream error: ' + e.message); }
  } catch (e) { sendJSON(res, 500, { error: 'Generate failed: ' + e.message }); }
}

async function handleIngestDetail(req, res) {
  try {
    const body = await parseBody(req);
    const { project } = body;
    if (!project) { sendJSON(res, 400, { success: false, error: 'Missing project' }); return; }
    const wp = getWikiProjectPath(project);
    if (!fs.existsSync(wp)) { sendJSON(res, 404, { success: false, error: 'Project not found' }); return; }
    const lp = path.join(wp, 'log.md');
    if (!fs.existsSync(lp)) { sendJSON(res, 404, { success: false, error: 'log.md not found' }); return; }
    const log = fs.readFileSync(lp, 'utf-8');
    const ingestLogs = log.split('\n## ').filter(s => s.includes('Ingest Operation')).slice(-1);
    sendJSON(res, 200, { success: true, project, recentIngest: ingestLogs[0] || 'No ingest records' });
  } catch (e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

// ═══════════════════════════════════════════════
// PAGE Handlers
// ═══════════════════════════════════════════════

function handleListPages(req, res, url) {
  const project = url.searchParams.get('project');
  if (!project) { sendJSON(res, 400, { success: false, error: 'Missing project' }); return; }
  const wp = getWikiProjectPath(project);
  if (!fs.existsSync(wp)) { sendJSON(res, 404, { success: false, error: 'Project not found' }); return; }
  const files = fs.readdirSync(wp).filter(f => f.endsWith('.md') && !f.startsWith('.')).map(f => ({ name: f, size: fs.statSync(path.join(wp, f)).size, modified: fs.statSync(path.join(wp, f)).mtime.toISOString() }));
  sendJSON(res, 200, { success: true, project, pages: files });
}

function handleListAllPages(req, res, url) {
  const project = url.searchParams.get('wiki') || url.searchParams.get('project');
  if (!project) { sendJSON(res, 400, { success: false, error: 'Missing wiki/project', code: 'WIKI_LIBRARY_REQUIRED' }); return; }
  try {
    sendJSON(res, 200, knowledgeStudioWiki.listAllPages(project));
  } catch (e) { sendJSON(res, e.statusCode || 500, { success: false, error: e.message, code: e.code }); }
}

function handleGetPage(req, res, url) {
  const project = url.searchParams.get('wiki') || url.searchParams.get('project');
  let page = url.searchParams.get('page');
  if (project && page) {
    // Strip project prefix if page param already includes it (fixes doubled path)
    const projPrefix = project + '/';
    while (page.startsWith(projPrefix)) page = page.slice(projPrefix.length);
    try {
      const target = resolveWikiPage(project, page);
      if (!fs.existsSync(target.file)) { sendJSON(res, 404, { success: false, error: 'Page not found' }); return; }
      usageEventLog.recordUsageEvent({ carrier: 'wiki', project: project || null, query: 'read:' + String(target.relative).slice(0, 160), hits: 1, caller: 'wiki-read' });
      sendJSON(res, 200, { success: true, project, page: target.relative, content: fs.readFileSync(target.file, 'utf-8') });
    } catch (error) { sendJSON(res, error.statusCode || 500, { success: false, error: error.message, code: error.code }); }
    return;
  }
  sendJSON(res, 400, { success: false, error: 'Missing wiki/project and page', code: 'WIKI_LIBRARY_REQUIRED' });
}

async function handleSavePage(req, res) {
  try {
    const body = await parseBody(req);
    if (body.project && body.page) {
      const { project, page, content } = body;
      if (!project || !page || !content) { sendJSON(res, 400, { success: false, error: 'Missing params' }); return; }
      assertWikiWritable(project);
      const target = resolveWikiPage(project, page);
      var store = _getWikiStore(target.root);
      store.savePage(target.relative, content);
      sendJSON(res, 200, { success: true, project, page: target.relative, message: 'Saved' });
      return;
    }
    sendJSON(res, 400, { success: false, error: 'project and page are required', code: 'WIKI_LIBRARY_REQUIRED' });
  } catch (e) { sendJSON(res, e.statusCode || 500, { success: false, error: e.message, code: e.code }); }
}

async function handleDeletePage(req, res) {
  try {
    const body = await parseBody(req);
    const { project, page } = body;
    if (!project || !page) { sendJSON(res, 400, { success: false, error: 'Missing params' }); return; }
    assertWikiWritable(project);
    const target = resolveWikiPage(project, page);
    if (!fs.existsSync(target.file)) { sendJSON(res, 404, { success: false, error: 'Page not found' }); return; }
    var store = _getWikiStore(target.root);
    store.deletePage(target.relative);
    sendJSON(res, 200, { success: true, project, page: target.relative, message: 'Deleted' });
  } catch (e) { sendJSON(res, e.statusCode || 500, { success: false, error: e.message, code: e.code }); }
}

// ═══════════════════════════════════════════════
// GRAPH Handlers
// ═══════════════════════════════════════════════

function handleGetGraph(req, res, url) {
  const project = url.searchParams.get('project');
  const wikiDir = url.searchParams.get('wikiDir');
  let wp;
  if (wikiDir && fs.existsSync(wikiDir)) wp = wikiDir;
  else if (project) { wp = getWikiProjectPath(project); if (!fs.existsSync(wp)) { sendJSON(res, 404, { success: false, error: 'Not found' }); return; } }
  else { sendJSON(res, 400, { success: false, error: 'Missing project/wikiDir' }); return; }
  const ep = path.join(wp, 'graph-data-enhanced.json');
  const cp = path.join(wp, '.graph.json');
  if (fs.existsSync(ep)) { sendJSON(res, 200, JSON.parse(fs.readFileSync(ep, 'utf-8'))); return; }
  if (fs.existsSync(cp)) { sendJSON(res, 200, JSON.parse(fs.readFileSync(cp, 'utf-8'))); return; }
  try {
    if (project) assertWikiWritable(project);
    const gd = graphBuilder.buildFromWiki(wp);
    graphBuilder.save(gd, cp);
    sendJSON(res, 200, gd);
  } catch (e) { sendJSON(res, e.statusCode || 500, { success: false, error: e.message, code: e.code }); }
}

async function handleBuildGraph(req, res) {
  try {
    const body = await parseBody(req);
    const { project } = body;
    if (!project) { sendJSON(res, 400, { success: false, error: 'Missing project' }); return; }
    assertWikiWritable(project);
    const wp = getWikiProjectPath(project);
    if (!fs.existsSync(wp)) { sendJSON(res, 404, { success: false, error: 'Project not found' }); return; }
    // Use analyze() for signal fusion + community detection + insights
    const analysis = graphBuilder.analyze(wp);
    const result = Object.assign({}, analysis.graph, { communities: analysis.communities ? analysis.communities.communities : [], modularity: analysis.communities ? analysis.communities.modularity : 0, insights: analysis.insights });
    graphBuilder.save(result, path.join(wp, '.graph.json'));
    sendJSON(res, 200, result);
  } catch (e) { sendJSON(res, e.statusCode || 500, { success: false, error: e.message, code: e.code }); }
}

function handleGraphGenerateStream(req, res, url) {
  let wikiDir = url.searchParams.get('wikiDir') || url.searchParams.get('project');
  const project = url.searchParams.get('project');
  const llmApiKey = url.searchParams.get('apiKey') || process.env.ANTHROPIC_API_KEY;
  const enableLLM = url.searchParams.get('enableLLM') === 'true';
  const enableResolution = url.searchParams.get('enableResolution') === 'true';
  if (wikiDir && !fs.existsSync(wikiDir)) wikiDir = getWikiProjectPath(wikiDir);
  if (!wikiDir || !fs.existsSync(wikiDir)) { sendJSON(res, 400, { error: 'Invalid wikiDir/project' }); return; }
  try { if (project) assertWikiWritable(project); }
  catch (error) { sendJSON(res, error.statusCode || 500, { success: false, error: error.message, code: error.code }); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  const emit = (d, e) => { try { res.write('event: ' + (e || 'phase') + '\ndata: ' + JSON.stringify(d) + '\n\n'); } catch {} };
  (async () => {
    try {
      const builder = new WikiGraphBuilder(llmApiKey);
      emit({ phase: 'preprocess', message: 'Building base graph...' });
      const bg = builder.buildFromWikiEnhanced(wikiDir);
      emit({ phase: 'preprocess', message: 'Base graph: ' + bg.stats.totalNodes + ' nodes, ' + bg.stats.totalEdges + ' edges' });
      if (enableLLM && llmApiKey) { emit({ phase: 'llm-enhance', message: 'LLM enhancing...' }); await builder.enhanceWithLLM(wikiDir, { batchSize: 5, onProgress: p => emit(p) }); emit({ phase: 'llm-enhance', message: 'LLM done' }); }
      if (enableResolution) { emit({ phase: 'resolution', message: 'Resolving entities...' }); await builder.resolveEntities(); emit({ phase: 'resolution', message: 'Resolution done' }); }
      const op = path.join(wikiDir, 'graph-data-enhanced.json');
      fs.writeFileSync(op, JSON.stringify({ nodes: builder.nodes, edges: builder.edges, stats: builder.stats }, null, 2));
      emit({ phase: 'done', message: 'Graph ready', outputPath: op, stats: builder.stats }, 'done');
    } catch (e) { emit({ phase: 'error', message: e.message }, 'graph-error'); } finally { res.end(); }
  })();
}

function handleGraphData(req, res, url) {
  let wikiDir = url.searchParams.get('wikiDir') || url.searchParams.get('project');
  if (wikiDir && !fs.existsSync(wikiDir)) wikiDir = getWikiProjectPath(wikiDir);
  if (!wikiDir) { sendJSON(res, 400, { error: 'Missing wikiDir/project' }); return; }
  const gp = path.join(wikiDir, 'graph-data-enhanced.json');
  if (!fs.existsSync(gp)) { sendJSON(res, 404, { error: 'Graph not found' }); return; }
  try { sendJSON(res, 200, JSON.parse(fs.readFileSync(gp, 'utf-8'))); } catch (e) { sendJSON(res, 500, { error: e.message }); }
}

// ═══════════════════════════════════════════════
// SEARCH & QA Handlers
// ═══════════════════════════════════════════════

// Wiki 文档搜索：manifest 匹配 → 候选集按需加载全文 → 精排
async function handleSearch(req, res) {
  try {
    const body = await parseBody(req);
    const { query, project, topK = 10 } = body;
    if (!query) { sendJSON(res, 400, { success: false, error: 'Missing query' }); return; }
    var results = [];
    if (project) {
      var wp = getWikiProjectPath(project);
      if (fs.existsSync(wp)) {
        _loadManifest(wp);
        // 1. 轻量 manifest 匹配，扩展候选集（3× topK）
        var candidates = wikiManifest.search(query, { topK: topK * 3 });
        if (candidates.length > 0) {
          // 2. 按需加载候选文档全文
          var candidateResults = [];
          candidates.forEach(function(c) {
            var content = wikiManifest.loadContent(wp, c.id, { maxChars: 8000, stripFrontmatter: true });
            if (!content) return;
            // 3. 候选集内关键词精排（简化 BM25-lite）
            var refinedScore = _scoreByKeywords(query, c.title, content, c.score);
            candidateResults.push({
              id: c.id, title: c.title, score: refinedScore,
              type: c.type, tags: c.tags,
              snippet: (content || '').slice(0, 300).replace(/\n/g, ' '),
            });
          });
          candidateResults.sort(function(a, b) { return b.score - a.score; });
          results = candidateResults.slice(0, topK);
        }
      }
    } else {
      // 多项目检索：各项目独立 manifest 匹配
      var ap = [];
      var mf = path.join(CONFIG.wikiRoot, '.mappings.json');
      if (fs.existsSync(mf)) { try { ap.push.apply(ap, Object.keys(JSON.parse(fs.readFileSync(mf, 'utf-8')))); } catch (e) {} }
      if (fs.existsSync(CONFIG.wikiRoot)) fs.readdirSync(CONFIG.wikiRoot, { withFileTypes: true }).forEach(function(d) { if (d.isDirectory() && d.name !== '.mappings.json') ap.push(d.name); });
      var ar = [];
      for (var pi = 0; pi < ap.length; pi++) {
        var wpp = getWikiProjectPath(ap[pi]);
        if (!fs.existsSync(wpp)) continue;
        _loadManifest(wpp);
        var prCands = wikiManifest.search(query, { topK: Math.ceil(topK * 2 / ap.length) + 2 });
        prCands.forEach(function(c) {
          var content = wikiManifest.loadContent(wpp, c.id, { maxChars: 3000, stripFrontmatter: true });
          var refinedScore = _scoreByKeywords(query, c.title, content || '', c.score);
          ar.push({ id: c.id, title: c.title, score: refinedScore, project: ap[pi], type: c.type, snippet: (content || '').slice(0, 200).replace(/\n/g, ' ') });
        });
      }
      results = ar.sort(function(a, b) { return b.score - a.score; }).slice(0, topK);
    }
    usageEventLog.recordUsageEvent({ carrier: 'wiki', project: project || null, query: String(query).slice(0, 200), hits: results.length, caller: 'wiki-search' });
    sendJSON(res, 200, { success: true, query, results });
  } catch (e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

// 候选集内关键词精排（简化 BM25：标题命中加权 + 内容命中计数）
function _scoreByKeywords(query, title, content, baseScore) {
  var qTokens = tokenizeLocal(query);
  var titleLow = (title || '').toLowerCase();
  var contentLow = (content || '').toLowerCase();
  var score = baseScore || 0;
  qTokens.forEach(function(t) {
    if (titleLow.indexOf(t) >= 0) score += 3;
    var cnt = (contentLow.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
    score += Math.min(cnt, 5);
  });
  return parseFloat(score.toFixed(2));
}
function tokenizeLocal(text) {
  if (!text) return [];
  var cleaned = text.toLowerCase().replace(/[`~!@#$%^&*()_|+\-=?;:'",.<>\{\}\[\]\\\/]/g, ' ').replace(/\s+/g, ' ').trim();
  var tokens = [];
  var re = /[一-龥]+|[a-z0-9]+/g;
  var match;
  while ((match = re.exec(cleaned)) !== null) {
    var w = match[0].trim();
    if (!w) continue;
    if (w.length > 1) tokens.push(w);
    if (/^[一-龥]+$/.test(w) && w.length >= 2) {
      for (var i = 0; i < w.length - 1; i++) tokens.push(w.slice(i, i + 2));
    }
  }
  return tokens;
}

// Wiki 知识问答：manifest 匹配 → 按需加载候选全文 → 拼接上下文 → LLM
async function handleQA(req, res) {
  try {
    const body = await parseBody(req);
    const { question, project, model, topK = 5 } = body;
    if (!question) { sendJSON(res, 400, { success: false, error: 'Missing question' }); return; }
    var ap = [];
    var mf = path.join(CONFIG.wikiRoot, '.mappings.json');
    if (fs.existsSync(mf)) { try { ap.push.apply(ap, Object.keys(JSON.parse(fs.readFileSync(mf, 'utf-8')))); } catch (e) {} }
    if (fs.existsSync(CONFIG.wikiRoot)) fs.readdirSync(CONFIG.wikiRoot, { withFileTypes: true }).forEach(function(d) { if (d.isDirectory() && d.name !== '.mappings.json') ap.push(d.name); });
    // 1. Manifest 轻量匹配 → 候选文档列表
    var candidates = [];
    if (project) {
      var wp = getWikiProjectPath(project);
      if (fs.existsSync(wp)) { _loadManifest(wp); candidates = wikiManifest.search(question, { topK: topK * 3 }); }
    } else {
      for (var pi = 0; pi < ap.length; pi++) {
        var wpp = getWikiProjectPath(ap[pi]);
        if (!fs.existsSync(wpp)) continue;
        _loadManifest(wpp);
        var prCands = wikiManifest.search(question, { topK: Math.ceil(topK * 2 / ap.length) + 2 });
        prCands.forEach(function(c) { c.project = ap[pi]; candidates.push(c); });
      }
      candidates.sort(function(a, b) { return b.score - a.score; });
    }
    candidates = candidates.slice(0, topK);
    usageEventLog.recordUsageEvent({ carrier: 'wiki', project: project || null, query: String(question).slice(0, 200), hits: candidates.length, caller: 'wiki-qa' });
    if (!candidates.length) { sendJSON(res, 200, { success: true, answer: 'No relevant content found.', sources: [] }); return; }

    // 2. 按需加载候选文档全文（只加载候选，不读全部文件）
    var contexts = [];
    var maxCtxSources = 3;
    for (var ci = 0; ci < Math.min(candidates.length, maxCtxSources); ci++) {
      try {
        var cand = candidates[ci];
        var wpp = getWikiProjectPath(cand.project || project);
        var content = wikiManifest.loadContent(wpp, cand.id, { maxChars: 2000, stripFrontmatter: true });
        if (content) contexts.push({ title: cand.title, content: content });
      } catch (e) {}
    }

    var answer = '';
    var sm = model || DEFAULT_CHAT_MODEL;
    var route = API_ROUTES[sm];
    if (model === 'local' || !route) {
      answer = '**Search results:**\n\n' + candidates.map(function(r, i) { return (i + 1) + '. **' + r.title + '** (' + (r.score * 100).toFixed(0) + '%)\n   ' + (r.summary || '').slice(0, 150); }).join('\n\n');
    } else {
      var apiKey = route.getKey();
      if (!apiKey) { answer = '**API key not configured.** Search results:\n\n' + candidates.map(function(r, i) { return (i + 1) + '. **' + r.title + '**\n   ' + (r.summary || ''); }).join('\n\n'); }
      else {
        try {
          var ctx = contexts.map(function(c, i) { return '[' + (i + 1) + '] ' + c.title + '\n' + c.content; }).join('\n\n---\n\n');
          var prompt = 'You are a knowledge Q&A assistant. Answer based on references. Be concise and accurate.\n\n## References\n' + ctx + '\n\n## Question\n' + question;
          var pd = JSON.stringify({ model: route.model || sm, messages: [{ role: 'user', content: prompt }], max_tokens: 2048, temperature: 0.7 });
          var opts = { hostname: route.host, port: 443, path: route.path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Content-Length': Buffer.byteLength(pd) } };
          answer = await new Promise(function(resolve) {
            var r = https.request(opts, function(resp) { var d = ''; resp.on('data', function(c) { d += c; }); resp.on('end', function() { try { var j = JSON.parse(d); resolve(j.choices?.[0]?.message?.content || 'Failed'); } catch (e) { resolve('Parse error'); } }); });
            r.on('error', function(e) { resolve('Request failed: ' + e.message); }); r.write(pd); r.end();
          });
        } catch (e) { answer = '**LLM call failed**\n\n' + candidates.map(function(r, i) { return (i + 1) + '. **' + r.title + '**\n   ' + (r.summary || ''); }).join('\n\n'); }
      }
    }
    sendJSON(res, 200, { success: true, answer, sources: candidates.slice(0, 5).map(function(c) { return { id: c.id, title: c.title, score: c.score }; }) });
  } catch (e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

// ═══════════════════════════════════════════════
// LINT & HEALTH Handlers
// ═══════════════════════════════════════════════

async function handleLint(req, res) {
  try {
    const body = await parseBody(req);
    const { project, checkOrphans = true, checkContradictions = true, checkMissingRefs = true } = body;
    if (!project) { sendJSON(res, 400, { success: false, error: 'Missing project' }); return; }
    const wp = getWikiProjectPath(project);
    if (!fs.existsSync(wp)) { sendJSON(res, 404, { success: false, error: 'Project not found' }); return; }
    const issues = wikiMaintainer.lintWiki(wp, { checkOrphans, checkContradictions, checkMissingRefs });
    sendJSON(res, 200, { success: true, issues, healthScore: issues.summary.healthScore, message: 'Health: ' + issues.summary.healthScore.toFixed(1) + '%' });
  } catch (e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

function handleArchitecture(req, res) {
  sendJSON(res, 200, { success: true, architecture: { mode: 'unified', wikiRoot: CONFIG.wikiRoot, rawRoot: CONFIG.rawRoot, schemaRoot: CONFIG.schemaRoot || path.join(__dirname, '../schema'), description: 'Unified Knowledge Studio' } });
}

function handleGetLog(req, res, url) {
  const project = url.searchParams.get('project');
  if (!project) { sendJSON(res, 400, { success: false, error: 'Missing project' }); return; }
  const wp = getWikiProjectPath(project);
  const lp = path.join(wp, 'log.md');
  if (!fs.existsSync(lp)) { sendJSON(res, 404, { success: false, error: 'log.md not found' }); return; }
  const log = fs.readFileSync(lp, 'utf-8');
  sendJSON(res, 200, { success: true, project, log, lines: log.split('\n').length });
}

async function handleQueryArchive(req, res) {
  try {
    const body = await parseBody(req);
    const { project, question } = body;
    if (!project || !question) { sendJSON(res, 400, { success: false, error: 'Missing params' }); return; }
    const wp = getWikiProjectPath(project);
    if (!fs.existsSync(wp)) { sendJSON(res, 404, { success: false, error: 'Project not found' }); return; }
    const result = await wikiMaintainer.queryAndArchive(question, wp, { llmApiKey: process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_KEY });
    sendJSON(res, 200, { success: true, result, message: result.archived ? 'Archived (score: ' + result.archiveScore.toFixed(2) + ')' : 'Not archived (score: ' + result.archiveScore.toFixed(2) + ')' });
  } catch (e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

// ── Graph Extraction Handlers ──

var graphExtractor = null;

function getGraphExtractor() {
  if (!graphExtractor) {
    var llmRoute = API_ROUTES[DEFAULT_CHAT_MODEL];
    graphExtractor = new GraphExtractor({
      wikiDir: CONFIG.wikiRoot,
      llmRoute: llmRoute ? {
        host: llmRoute.host,
        path: llmRoute.path,
        apiKey: llmRoute.getKey ? llmRoute.getKey() : null,
        model: llmRoute.model || DEFAULT_CHAT_MODEL,
      } : null,
      batchSize: 3,
      maxDocs: 100,
    });
  }
  return graphExtractor;
}

async function handleGraphExtract(req, res) {
  try {
    var body = await parseBody(req);
    var { project, forceRebuild, gleaning } = body;
    var ge = getGraphExtractor();
    var result = await ge.extractFromWiki(project, {
      forceRebuild: forceRebuild || false,
      gleaning: gleaning !== false,
    });
    sendJSON(res, 200, { success: true, stats: result.stats, nodeCount: result.nodes.length, edgeCount: result.edges.length });
  } catch(e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

async function handleGraphFuse(req, res) {
  try {
    var body = await parseBody(req);
    var { project } = body;
    var wp = getWikiProjectPath(project);
    var extractFile = path.join(wp, '.graph-extracted.json');
    if (!fs.existsSync(extractFile)) {
      sendJSON(res, 400, { error: 'No extracted graph found. Run /api/knowledge/graph/extract first' });
      return;
    }
    var extracted = JSON.parse(fs.readFileSync(extractFile, 'utf-8'));

    // Build signal graph
    var signalGraph = graphBuilder.buildFromWiki(wp);

    var ge = getGraphExtractor();
    var fused = ge.fuseWithSignals(extracted, signalGraph);

    // Save fused graph
    var fusedFile = path.join(wp, '.graph-fused.json');
    fs.writeFileSync(fusedFile, JSON.stringify(fused, null, 2), 'utf-8');

    sendJSON(res, 200, { success: true, nodeCount: fused.nodes.length, edgeCount: fused.edges.length });
  } catch(e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

async function handleCommunitySummarize(req, res) {
  try {
    var body = await parseBody(req);
    var { project } = body;
    var wp = getWikiProjectPath(project);

    // Load fused graph (or fall back to extracted)
    var graphFile = path.join(wp, '.graph-fused.json');
    if (!fs.existsSync(graphFile)) graphFile = path.join(wp, '.graph-extracted.json');
    if (!fs.existsSync(graphFile)) {
      sendJSON(res, 400, { error: 'No graph found. Run extraction first' });
      return;
    }
    var graph = JSON.parse(fs.readFileSync(graphFile, 'utf-8'));

    // Run Louvain community detection
    var graphData = { nodes: graph.nodes.map(function(n) { return { id: n.id, label: n.label }; }), edges: graph.edges };
    var communities = graphBuilder.detectCommunities ? graphBuilder.detectCommunities(graphData) : { communities: [] };
    var commList = communities.communities || communities;

    // LLM summaries
    var ge = getGraphExtractor();
    var summarized = await ge.summarizeCommunities(commList, graph.nodes);

    // Save
    var commFile = path.join(wp, '.graph-communities.json');
    fs.writeFileSync(commFile, JSON.stringify({ communities: summarized, modularity: communities.modularity }, null, 2), 'utf-8');

    sendJSON(res, 200, { success: true, communityCount: summarized.length, communities: summarized.map(function(c) { return { id: c.id, size: c.size, cohesion: c.cohesion, summary: c.summary }; }) });
  } catch(e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

async function handleGraphRAG(req, res) {
  try {
    var body = await parseBody(req);
    var { query, project, topK } = body;
    if (!query) { sendJSON(res, 400, { error: 'Missing query' }); return; }
    topK = topK || 5;

    var wp = getWikiProjectPath(project);
    var graphFile = path.join(wp, '.graph-fused.json');
    if (!fs.existsSync(graphFile)) graphFile = path.join(wp, '.graph-extracted.json');
    var commFile = path.join(wp, '.graph-communities.json');
    var ragFile = path.join(wp, '.rag-cache.json');

    // 1. Graph subgraph search
    var graph = fs.existsSync(graphFile) ? JSON.parse(fs.readFileSync(graphFile, 'utf-8')) : null;
    var subNodes = [], subEdges = [];
    if (graph) {
      var qLower = query.toLowerCase();
      var scored = graph.nodes.map(function(n) {
        var label = (n.label || '').toLowerCase();
        var desc = (n.description || '').toLowerCase();
        var score = (label.indexOf(qLower) >= 0 ? 10 : 0) + (desc.indexOf(qLower) >= 0 ? 3 : 0);
        qLower.split(/\s+/).forEach(function(t) { if (t.length > 2 && label.indexOf(t) >= 0) score += 2; });
        return { node: n, score: score };
      }).filter(function(s) { return s.score > 0; }).sort(function(a, b) { return b.score - a.score; }).slice(0, topK);

      var seedIds = scored.map(function(s) { return s.node.id; });
      var adj = {};
      graph.edges.forEach(function(e) { var s = e.source, t = e.target; if (!adj[s]) adj[s] = []; if (!adj[t]) adj[t] = []; adj[s].push(t); adj[t].push(s); });
      var visited = {};
      seedIds.forEach(function(id) { visited[id] = 0; });
      var queue = seedIds.slice();
      while (queue.length) {
        var curr = queue.shift();
        var dist = visited[curr] || 0;
        var nd = graph.nodes.find(function(n) { return n.id === curr; });
        if (nd) subNodes.push({ id: curr, label: nd.label, type: nd.entityType, desc: (nd.description||'').slice(0, 200), dist: dist });
        if (dist >= 1) continue;
        (adj[curr] || []).forEach(function(nb) {
          if (visited[nb] === undefined) { visited[nb] = dist + 1; queue.push(nb); }
          subEdges.push({ source: curr, target: nb });
        });
      }
    }

    // 2. Community summaries (Global Query)
    var globalContext = '';
    if (fs.existsSync(commFile)) {
      var comms = JSON.parse(fs.readFileSync(commFile, 'utf-8'));
      globalContext = (comms.communities || comms || []).slice(0, 5).map(function(c) {
        return '- ' + (c.summary || 'Community ' + (c.id||'')) + ' (' + (c.size||0) + ' nodes, cohesion: ' + (c.cohesion||0).toFixed(2) + ')';
      }).join('\n');
    }

    // 3. Vector search from RAG cache
    var vectorContext = '';
    if (fs.existsSync(ragFile)) {
      var rag = JSON.parse(fs.readFileSync(ragFile, 'utf-8'));
      var ragChunks = rag.chunks || [];
      var tokens = query.toLowerCase().split(/\s+/);
      var scoredChunks = ragChunks.map(function(c) {
        var txt = (c.text || '').toLowerCase();
        var s = 0;
        tokens.forEach(function(t) { if (t.length > 2 && txt.indexOf(t) >= 0) s += 3; });
        return { text: c.text.slice(0, 500), score: s };
      }).filter(function(x) { return x.score > 0; }).sort(function(a, b) { return b.score - a.score; }).slice(0, 3);
      vectorContext = scoredChunks.map(function(x) { return x.text; }).join('\n---\n');
    }

    usageEventLog.recordUsageEvent({ carrier: 'graph', graphId: project || null, query: String(query).slice(0, 200), hits: subNodes.length, caller: 'graphrag' });
    sendJSON(res, 200, {
      success: true,
      query: query,
      subgraph: { nodes: subNodes, edges: subEdges },
      globalContext: globalContext,
      vectorContext: vectorContext,
      stats: {
        subNodes: subNodes.length, subEdges: subEdges.length,
        communities: globalContext ? (globalContext.split('\n').length) : 0,
        vectorChunks: vectorContext ? (vectorContext.split('---').length) : 0,
      },
    });
  } catch(e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

// ── RAG Chunks List + Edit ──

async function handleRAGChunks(req, res) {
  try {
    var url = new URL(req.url, 'http://localhost');
    var project = url.searchParams.get('project') || '';
    var page = parseInt(url.searchParams.get('page') || '1');
    var pageSize = parseInt(url.searchParams.get('pageSize') || '20');
    var docFilter = url.searchParams.get('docId') || '';
    var rag = getOrCreateRAGEngine(project);

    if (!rag.chunks || !rag.chunks.length) {
      // RAGEngine 构造后不自动加载索引（容器重启后内存为空）；有缓存时 buildIndex 走 digest 校验后的快速载入
      try { await rag.buildIndex(project || undefined); } catch (eBuild) {}
    }
    if (!rag.chunks || !rag.chunks.length) {
      sendJSON(res, 200, { success: true, chunks: [], total: 0, page: page, pageSize: pageSize, message: 'RAG 索引尚未构建，请先对该项目执行构建' });
      return;
    }

    var filtered = docFilter ? rag.chunks.filter(function(c) { return c.docId === docFilter; }) : rag.chunks;
    var total = filtered.length;
    var start = (page - 1) * pageSize;
    var paged = filtered.slice(start, start + pageSize);

    var chunks = paged.map(function(c) {
      return {
        id: c.id,
        docId: c.docId,
        docTitle: c.docTitle,
        heading: c.heading,
        charCount: c.charCount,
        tokenEstimate: c.tokenEstimate,
        text: c.text,
        preview: c.text.slice(0, 300),
        metadata: c.metadata || {},
        edited: !!c.edited,
        editedAt: c.editedAt || null,
        vectorStale: !!c.vectorStale,
      };
    });

    sendJSON(res, 200, {
      success: true,
      chunks: chunks,
      total: total,
      page: page,
      pageSize: pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch(e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

async function handleRAGChunkUpdate(req, res) {
  try {
    var body = await parseBody(req);
    var { project, chunkId, text } = body;
    var rag = getOrCreateRAGEngine(project);

    var chunk = rag.chunks.find(function(c) { return c.id === chunkId; });
    if (!chunk) { sendJSON(res, 404, { success: false, error: 'Chunk not found: ' + chunkId }); return; }

    // Update chunk text and recalculate stats
    var oldText = chunk.text;
    chunk.text = text;
    chunk.charCount = text.length;
    chunk.tokenEstimate = Math.ceil(text.length / 3);
    chunk.edited = true;
    chunk.editedAt = new Date().toISOString();

    // Rebuild keyword index for this chunk
    if (rag.keywordEngine) {
      // Remove old tokens
      var doc = rag.keywordEngine.documents.find(function(d) { return d.id === chunkId; });
      if (doc) {
        doc.content = text;
        doc.tokens = rag.keywordEngine.tokenize(text);
      }
    }

    // Re-embed the edited chunk (best effort — flagged stale on failure)
    var vectorState = { reembedded: false, stale: true };
    try {
      var re = await rag.reembedChunk(chunkId);
      vectorState = { reembedded: !!re.ok, stale: !re.ok };
      if (re.error) vectorState.error = re.error;
    } catch (reErr) { vectorState.error = reErr.message; }

    // Save to cache
    var wp = project ? path.join(rag.wikiDir, project) : rag.wikiDir;
    var cacheFile = path.join(wp, '.rag-cache.json');
    rag._saveCache(cacheFile);

    sendJSON(res, 200, { success: true, keywordSynced: true, vector: vectorState, chunk: { id: chunk.id, charCount: chunk.charCount, tokenEstimate: chunk.tokenEstimate, vectorStale: !!chunk.vectorStale } });
  } catch(e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

async function handleRAGPreview(req, res) {
  try {
    var body = await parseBody(req);
    var { content, project, docIds, strategy, chunkSize, overlap, childSize, parentSize } = body;
    // Accept either raw content or docIds (we read files ourselves)
    if (!content && docIds && docIds.length > 0) {
      var wp = path.join(CONFIG.wikiRoot, project);
      var parts = [];
      docIds.forEach(function(docId) {
        var fp = path.join(wp, docId);
        if (fs.existsSync(fp)) {
          var raw = fs.readFileSync(fp, 'utf-8');
          // Strip YAML frontmatter so chunker gets clean content
          raw = raw.replace(/^---[\s\S]*?---\n*/, '').trim();
          if (raw) parts.push(raw);
        }
      });
      content = parts.join('\n\n');
    }
    if (!content) { sendJSON(res, 400, { error: 'No content extracted. hasContent:' + !!content + ' docIdsLen:' + (docIds?docIds.length:'null') + ' project:' + project }); return; }
    var rag; try { rag = getOrCreateRAGEngine(project); } catch(e2) { sendJSON(res, 500, { error: 'RAGEngine create: ' + e2.message }); return; }
    var opts = { strategy: strategy || 'markdown', chunkSize: (chunkSize || 1024), overlap: (overlap || 128), childSize: childSize, parentSize: parentSize };
    var preview; try { preview = rag.previewDocumentChunks(content, opts); } catch(e3) { sendJSON(res, 500, { error: 'Chunk error: ' + e3.message + ' contentLen:' + (content?content.length:0) }); return; }
    sendJSON(res, 200, { success: true, preview: preview });
  } catch(e) { sendJSON(res, 500, { error: 'Outer: ' + e.message }); }
}

async function handleRAGDocDelete(req, res) {
  try {
    var body = await parseBody(req);
    var { project, docId } = body;
    if (!docId) { sendJSON(res, 400, { error: 'Missing docId' }); return; }
    var rag = getOrCreateRAGEngine(project);
    var result = rag.removeDocument(project, docId);
    sendJSON(res, 200, { success: true, result: result });
  } catch(e) { sendJSON(res, 500, { error: e.message }); }
}

function handleRAGTasks(req, res) {
  try {
    var url = new URL(req.url, 'http://localhost');
    var project = url.searchParams.get('project') || '';
    var rag = getOrCreateRAGEngine(project);
    var tasks = rag.getTaskStatus(project);
    sendJSON(res, 200, { success: true, tasks: tasks.tasks || [] });
  } catch(e) { sendJSON(res, 500, { error: e.message }); }
}

// ── RAG Handlers ──

function getOrCreateRAGEngine(projectName) {
  return ragEnginePool.getOrCreateRAGEngine(projectName);
}

async function handleRAGBuild(req, res) {
  try {
    var body = await parseBody(req);
    var { project, chunkSize, overlap, strategy, forceRebuild, stream, filterDocs } = body;
    var rag = getOrCreateRAGEngine(project);

    // SSE streaming mode
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });
      function sseSend(data) {
        try { res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch(e) { /* closed */ }
      }
    }

    var stats = await rag.buildIndex(project, {
      chunkSize: chunkSize || 1024,
      overlap: overlap || 128,
      strategy: strategy || 'auto',
      forceRebuild: forceRebuild || false,
      filterDocs: Array.isArray(filterDocs) ? filterDocs : undefined,
      onProgress: stream ? function(p) { sseSend(p); } : undefined,
    });

    if (stream) {
      sseSend({ phase: 'complete', success: true, stats: stats });
      res.end();
    } else {
      sendJSON(res, 200, { success: true, stats: stats });
    }
  } catch(e) {
    if (stream) {
      try { res.write('data: ' + JSON.stringify({ phase: 'error', message: e.message }) + '\n\n'); res.end(); } catch(_) {}
    } else {
      sendJSON(res, 500, { success: false, error: e.message });
    }
  }
}

async function handleRAGUpdate(req, res) {
  try {
    var body = await parseBody(req);
    var { project, chunkSize, overlap } = body;
    var rag = getOrCreateRAGEngine(project);
    var result = await rag.incrementalUpdate(project, {
      chunkSize: chunkSize || undefined,
      overlap: overlap || undefined,
    });
    sendJSON(res, 200, { success: true, result: result });
  } catch(e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

async function handleRAGWatch(req, res) {
  try {
    var body = await parseBody(req);
    var project = (body && body.project) || '';
    var rag = getOrCreateRAGEngine(project);
    var watcher = rag.watch(project);
    sendJSON(res, 200, { success: true, watching: !!watcher, project: project || '(root)' });
  } catch(e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

function handleRAGStatus(req, res) {
  try {
    var url = new URL(req.url, 'http://localhost');
    var project = url.searchParams.get('project') || '';
    var rag = getOrCreateRAGEngine(project);
    var wp = getWikiProjectPath(project);
    var cacheFile = path.join(wp, '.rag-cache.json');
    if (!rag.stats && fs.existsSync(cacheFile)) {
      try {
        var cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        if (cached.stats) rag.stats = cached.stats;
      } catch(e) {}
    }
    var status = rag.getStatus();
    sendJSON(res, 200, { success: true, status: status, cacheExists: fs.existsSync(cacheFile) });
  } catch(e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

async function handleRAGSearch(req, res) {
  try {
    var body = await parseBody(req);
    var { query, project, topK, mode, rerank } = body;
    if (!query) { sendJSON(res, 400, { error: 'Missing query' }); return; }
    var rag = getOrCreateRAGEngine(project);
    if (!rag.chunks || !rag.chunks.length) {
      var wp = getWikiProjectPath(project);
      var cacheFile = path.join(wp, '.rag-cache.json');
      if (fs.existsSync(cacheFile)) {
        try {
          var cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
          if (cached.chunks) rag.chunks = cached.chunks;
          if (cached.vectors) rag.vectors = typeof rag._hydrateCachedVectors === 'function' ? rag._hydrateCachedVectors(cached.vectors) : cached.vectors;
        } catch(e) {}
      }
      if (!rag.chunks || !rag.chunks.length) {
        sendJSON(res, 200, { results: [], message: 'RAG 索引尚未构建，请先对该项目执行构建（POST /api/knowledge/rag/build）' });
        return;
      }
      if (typeof rag._buildKeywordIndex === 'function') rag._buildKeywordIndex();
      else {
        var SearchEngine = require('../tools/llm-wiki-engine').SearchEngine;
        rag.keywordEngine = new SearchEngine();
        rag.keywordEngine.index = new Map();
        rag.keywordEngine.documents = [];
        var se = rag.keywordEngine;
        rag.chunks.forEach(function(chunk) {
          var tokens = se.tokenize(chunk.text);
          tokens.forEach(function(token) {
            if (!se.index.has(token)) se.index.set(token, []);
            se.index.get(token).push(chunk.id);
          });
          se.documents.push({ id: chunk.id, path: '', title: chunk.docTitle, content: chunk.text, tokens: tokens });
        });
      }
    }
    var results = await rag.search(query, { topK: topK || 10, mode: mode || 'hybrid', rerank: rerank || false });
    usageEventLog.recordUsageEvent({ carrier: 'vector', project: project || '__root__', query: String(query).slice(0, 200), topK: topK || 10, hits: results.length, caller: 'rag-search' });
    sendJSON(res, 200, { success: true, query: query, results: results, count: results.length, mode: mode || 'hybrid', reranked: rerank || false });
  } catch(e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

// ── RAG Graph Search (2-hop expansion + context budget) ──

async function handleRAGGraphSearch(req, res) {
  try {
    var body = await parseBody(req);
    var { query, project, topK, contextBudget, graphExpand, rerank } = body;
    if (!query) { sendJSON(res, 400, { error: 'Missing query' }); return; }
    var rag = getOrCreateRAGEngine(project);
    if (!rag.chunks || !rag.chunks.length) {
      // 与 unified-search 相同的缓存懒加载，避免重启后空池静默返回 0 命中
      try { await rag.buildIndex(project || undefined); } catch (eBuild) {}
    }
    if (!rag.chunks || !rag.chunks.length) {
      sendJSON(res, 200, { results: [], message: 'RAG 索引尚未构建，请先执行构建' });
      return;
    }

    var result = await rag.graphRAGSearch(query, {
      topK: topK || 10,
      contextBudget: contextBudget || 4096,
      graphExpand: graphExpand !== false,
      rerank: rerank || false,
      project: project,
    });

    usageEventLog.recordUsageEvent({ carrier: 'vector', project: project || null, query: String(query).slice(0, 200), hits: result.results.length, caller: 'rag-graph-search' });
    sendJSON(res, 200, {
      success: true,
      query: query,
      results: result.results,
      count: result.results.length,
      totalTokens: result.totalTokens,
      budget: result.budget,
      graphNodes: result.graphNodes,
      graphExpanded: result.graphNodes.length > 0,
    });
  } catch(e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

// ── Dashboard Handler (aggregated index states) ──

function handleDashboard(req, res) {
  try {
    var url = new URL(req.url, 'http://localhost');
    var project = url.searchParams.get('project') || '';
    var wp = getWikiProjectPath(project);
    var dashboard = {
      project: project || '(root)',
      wiki: { exists: fs.existsSync(wp) },
      rag: { built: false },
      graph: { built: false, extracted: false, fused: false },
      communities: { built: false },
    };

    // Wiki stats
    if (dashboard.wiki.exists) {
      var mdCount = 0;
      function countMd(dir) {
        try {
          fs.readdirSync(dir, { withFileTypes: true }).forEach(function(e) {
            if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'syntheses') countMd(path.join(dir, e.name));
            else if (e.isFile() && e.name.endsWith('.md')) mdCount++;
          });
        } catch(ex) {}
      }
      countMd(wp);
      dashboard.wiki.documents = mdCount;
    }

    // RAG
    var ragFile = path.join(wp, '.rag-cache.json');
    if (fs.existsSync(ragFile)) {
      try {
        var rag = JSON.parse(fs.readFileSync(ragFile, 'utf-8'));
        dashboard.rag = {
          built: true,
          documents: rag.stats ? rag.stats.documents : 0,
          chunks: rag.stats ? rag.stats.chunks : (rag.chunks ? rag.chunks.length : 0),
          embedded: rag.stats ? rag.stats.embedded : (rag.vectors ? rag.vectors.length : 0),
          dim: rag.stats ? rag.stats.dim : 0,
          builtAt: rag.stats ? rag.stats.builtAt : null,
          sizeKB: Math.round(fs.statSync(ragFile).size / 1024),
        };
      } catch(e) {}
    }

    // Signal graph
    var graphFile = path.join(wp, '.graph-data.json') || path.join(wp, 'graph-data.json');
    if (!fs.existsSync(graphFile)) graphFile = path.join(wp, '.graph-cached.json');
    if (fs.existsSync(graphFile)) {
      try {
        var gd = JSON.parse(fs.readFileSync(graphFile, 'utf-8'));
        dashboard.graph.built = true;
        dashboard.graph.nodes = (gd.nodes || []).length;
        dashboard.graph.edges = (gd.edges || []).length;
        dashboard.graph.type = 'signal';
        dashboard.graph.sizeKB = Math.round(fs.statSync(graphFile).size / 1024);
      } catch(e) {}
    }

    // LLM extracted graph
    var extractFile = path.join(wp, '.graph-extracted.json');
    if (fs.existsSync(extractFile)) {
      try {
        var eg = JSON.parse(fs.readFileSync(extractFile, 'utf-8'));
        dashboard.graph.extracted = true;
        dashboard.graph.extractedNodes = (eg.nodes || []).length;
        dashboard.graph.extractedEdges = (eg.edges || []).length;
        if (eg.stats) dashboard.graph.extractionStats = eg.stats;
        dashboard.graph.extractedSizeKB = Math.round(fs.statSync(extractFile).size / 1024);
      } catch(e) {}
    }

    // Fused graph
    var fusedFile = path.join(wp, '.graph-fused.json');
    if (fs.existsSync(fusedFile)) {
      try {
        var fg = JSON.parse(fs.readFileSync(fusedFile, 'utf-8'));
        dashboard.graph.fused = true;
        dashboard.graph.fusedNodes = (fg.nodes || []).length;
        dashboard.graph.fusedEdges = (fg.edges || []).length;
        dashboard.graph.fusedSizeKB = Math.round(fs.statSync(fusedFile).size / 1024);
      } catch(e) {}
    }

    // Communities
    var commFile = path.join(wp, '.graph-communities.json');
    if (fs.existsSync(commFile)) {
      try {
        var cd = JSON.parse(fs.readFileSync(commFile, 'utf-8'));
        var comms = cd.communities || cd;
        dashboard.communities = {
          built: true,
          count: comms.length,
          modularity: cd.modularity || 0,
          summariesGenerated: comms.filter(function(c) { return !!c.summary; }).length,
          sizeKB: Math.round(fs.statSync(commFile).size / 1024),
        };
      } catch(e) {}
    }

    sendJSON(res, 200, { success: true, dashboard: dashboard });
  } catch(e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

// ═══════════════════════════════════════════════
// MCP Handler
// ═══════════════════════════════════════════════

async function handleMCP(req, res) {
  try {
    const body = await parseBody(req);
    const { method, params, id } = body;
    // MCP 标准握手（Streamable HTTP，POST-only JSON 响应）
    if (method === 'initialize') {
      const requested = (params && params.protocolVersion) || '2025-06-18';
      const supported = ['2025-06-18', '2025-03-26', '2024-11-05'];
      const protocolVersion = supported.indexOf(requested) >= 0 ? requested : '2025-06-18';
      sendJSON(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ai-harbor-knowledge', version: '1.1.0' } } });
      return;
    }
    if (method === 'ping') { sendJSON(res, 200, { jsonrpc: '2.0', id, result: {} }); return; }
    // 通知无 id：按 MCP 规范回 202 空响应，勿回 JSON-RPC error
    if (method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    if (method === 'tools/list') {
      sendJSON(res, 200, { jsonrpc: '2.0', id, result: { tools: [
        { name: 'search_knowledge', description: 'Search wiki', inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string' }, topK: { type: 'number', default: 5 } }, required: ['query'] } },
        { name: 'get_page', description: 'Get page content', inputSchema: { type: 'object', properties: { project: { type: 'string' }, page: { type: 'string' } }, required: ['page'] } },
        { name: 'list_pages', description: 'List pages', inputSchema: { type: 'object', properties: { project: { type: 'string' } } } },
        { name: 'save_page', description: 'Save or update a wiki page', inputSchema: { type: 'object', properties: { page: { type: 'string' }, content: { type: 'string' }, category: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['page', 'content'] } },
        { name: 'get_graph', description: 'Get knowledge graph', inputSchema: { type: 'object', properties: { project: { type: 'string' } } } },
        { name: 'web_search', description: 'Search external web providers for public evidence and recent facts', inputSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number', default: 5 }, providers: { type: 'array', items: { type: 'string' } } }, required: ['query'] } },
        { name: 'unified_search', description: 'Cross-carrier unified search across wiki chunks and knowledge graph entities with RRF fusion', inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string' }, assetId: { type: 'string' }, graphId: { type: 'string' }, scopes: { type: 'array', items: { type: 'string', enum: ['wiki', 'graph'] } }, topK: { type: 'number', default: 10 } }, required: ['query'] } },
        { name: 'graph_eval_dataset', description: 'Intent-graph knowledge eval dataset: deterministic scenario derivation (single/multi/ambiguous/intent-switch/boundary) bound to the published graph version+digest. Actions: scaffold (compact graph index), derive (build dataset, returns summary+samples only), validate, save', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['scaffold', 'derive', 'validate', 'save'] }, asset: { type: 'string', default: 'intent-graph' }, options: { type: 'object' }, dataset: { type: 'object' } }, required: ['action'] } },
        { name: 'intent_evalset_generate', description: 'Intent test-set synthesis against the LIVE evaluator graph: samples single/multi/ambiguous intent targets and synthesizes natural utterances via the openjiuwen builder agent; expectations are derived deterministically from the graph. Progress persists to data/testsets/ so generate RESUMES from the last completed target (idempotent re-run reuses finished batches). Actions: scaffold (sampling plan preview, 0 LLM), generate (synthesize/resume; returns summary+samples ONLY), list (recent dataset metadata)', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['scaffold', 'generate', 'list'] }, options: { type: 'object', description: 'scaffold options: singleCount/multiCount/ambiguousCount/domains/perTargetCount/styles/ambiguousMix/seed' }, planId: { type: 'string', description: 'required for generate, from a previous scaffold' } }, required: ['action'] } },
      ] } });
      return;
    }
    if (method === 'tools/call') {
      const { name, arguments: args } = params; let result;
      switch (name) {
        case 'search_knowledge': { const wpp = args.project ? getWikiProjectPath(args.project) : CONFIG.wikiRoot; _loadManifest(wpp); result = wikiManifest.search(args.query, { topK: args.topK || 5 }); usageEventLog.recordUsageEvent({ carrier: 'wiki', project: args.project || null, query: String(args.query || '').slice(0, 200), hits: (result && result.length) || 0, caller: 'mcp' }); break; }
        case 'get_page': { const wpp = args.project ? getWikiProjectPath(args.project) : CONFIG.wikiRoot; const ppp = path.join(wpp, args.page.endsWith('.md') ? args.page : args.page + '.md'); result = fs.existsSync(ppp) ? { content: fs.readFileSync(ppp, 'utf-8') } : { error: 'Not found' }; usageEventLog.recordUsageEvent({ carrier: 'wiki', project: args.project || null, query: 'read:' + String(args.page || '').slice(0, 160), hits: result.error ? 0 : 1, caller: 'mcp' }); break; }
        case 'list_pages': { const wpp = args.project ? getWikiProjectPath(args.project) : CONFIG.wikiRoot; result = _listWikiPages(wpp); break; }
        case 'save_page': {
          const catDir = args.category || 'syntheses';
          const catMap = { customers: 'customers', opportunities: 'opportunities', proposals: 'proposals', syntheses: 'syntheses', concepts: 'concepts', entities: 'entities' };
          const baseRoot = (args.project ? getWikiProjectPath(args.project) : CONFIG.wikiRoot);
          const dir = path.join(baseRoot, catMap[catDir] || 'syntheses');
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const safeName = args.page.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-');
          const fp = path.join(dir, safeName.endsWith('.md') ? safeName : safeName + '.md');
          const now = new Date().toISOString().slice(0, 10);
          let oldContent = '';
          const isUpdate = fs.existsSync(fp);
          if (isUpdate) oldContent = fs.readFileSync(fp, 'utf-8');
          const created = isUpdate ? (oldContent.match(/created:\s*(.+)/)?.[1] || now) : now;
          const tagStr = (args.tags && args.tags.length) ? '\ntags: [' + args.tags.join(', ') + ']' : '';
          const pageContent = `---
title: ${args.page}
type: ${catDir}
created: ${created}
updated: ${now}${tagStr}
---

${args.content}`;
          var store = _getWikiStore(baseRoot);
          store.savePage(path.relative(baseRoot, fp), pageContent);
          result = { saved: true, path: fp, updated: isUpdate, size: pageContent.length };
          break;
        }
        case 'get_graph': { const wpp = args.project ? getWikiProjectPath(args.project) : CONFIG.wikiRoot; const gpp = path.join(wpp, '.graph.json'); result = fs.existsSync(gpp) ? JSON.parse(fs.readFileSync(gpp, 'utf-8')) : graphBuilder.buildFromWiki(wpp); usageEventLog.recordUsageEvent({ carrier: 'wiki', project: args.project || null, query: 'graph-read', hits: 1, caller: 'mcp' }); break; }
        case 'web_search': { result = await searchWeb(args.query, { maxResults: args.maxResults || args.topK || 5, providers: args.providers }); break; }
        case 'unified_search': { result = await getUnifiedSearchCore()(Object.assign({}, args, { caller: 'mcp' })); break; }
        case 'graph_eval_dataset': {
          result = getEvalDatasetTools().runEvalDatasetAction(args.action, args);
          usageEventLog.recordUsageEvent({ carrier: 'graph', project: null, query: 'eval-dataset:' + String(args.action || '').slice(0, 40), hits: result.totalCases ? 1 : 0, caller: 'mcp' });
          break;
        }
        case 'intent_evalset_generate': {
          const mcpAction = String(args.action || '');
          const rawTestset = await getIntentTestsetTools().runIntentTestsetAction(mcpAction, args);
          // 上下文安全纪律：MCP 出口只回摘要+样例，全量 case 留在 ai-harbor 缓存，走 UI 导入
          result = mcpAction === 'generate'
            ? { datasetId: rawTestset.datasetId, planId: rawTestset.planId, graph: rawTestset.graph, summary: rawTestset.summary, failedCount: (rawTestset.failed || []).length, resumedTargets: rawTestset.resumedTargets || 0, pendingTargets: rawTestset.pendingTargets, totalTargets: rawTestset.totalTargets, note: '全量用例经 UI（/api/intent-testset）导入测试用例库；重跑 generate 自动续跑未完成目标' }
            : rawTestset;
          usageEventLog.recordUsageEvent({ carrier: 'graph', project: null, query: 'intent-testset:' + mcpAction.slice(0, 40), hits: rawTestset.summary && rawTestset.summary.total ? 1 : 0, caller: 'mcp' });
          break;
        }
        default: result = { error: 'Unknown tool: ' + name };
      }
      sendJSON(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      return;
    }
    sendJSON(res, 400, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method' } });
  } catch (e) { sendJSON(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: e.message } }); }
}

// ═══════════════════════════════════════════════
// DOC REVIEW Agent Handlers (公文审核 Agent)
// ═══════════════════════════════════════════════

/**
 * 公文审核 SSE 流式响应上下文（命名事件 + 心跳 + alive 保护）
 * 协议：phase(active/progress/done) → result|error → done → end
 */
function createDocReviewSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream;charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  var alive = true;
  var hb = setInterval(function() {
    try { res.write('event: hb\ndata: ' + JSON.stringify({ ts: Date.now() }) + '\n\n'); }
    catch (e) { alive = false; clearInterval(hb); console.error('[doc-review-sse] heartbeat write failed, stream dead:', e.message); }
  }, 5000); // 5s 心跳：LLM 两轮最长 60s+，防中间层（Docker 代理/浏览器）idle 断连
  res.on('close', function() {
    if (!alive) return;
    alive = false;
    clearInterval(hb);
    console.log('[doc-review-sse] client closed connection before finish');
  });

  function send(event, data) {
    if (!alive) return;
    try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
    catch (e) { alive = false; clearInterval(hb); console.error('[doc-review-sse] write failed, stream dead:', e.message); }
  }
  function end() {
    if (!alive) return;
    alive = false;
    clearInterval(hb);
    try { res.end(); } catch (e) {}
  }
  return { send: send, end: end };
}

function docReviewPhase(sse, phase, state, detail) {
  if (sse) sse.send('phase', { phase: phase, state: state, detail: detail || '' });
}

function mergeTaskRecall(baseRecall, taskRecall, maxChars) {
  var recall = baseRecall || {};
  var task = taskRecall || { pages: [], graphExcerpts: [] };
  recall.pages = task.pages || [];
  recall.graphExcerpts = task.graphExcerpts || [];
  var budget = Number(maxChars || 6500);
  var graphChars = recall.graphExcerpts.reduce(function(sum, item) {
    return sum + String(item.content || '').length;
  }, 0);
  var remaining = Math.max(0, budget - graphChars);
  ['docTypePage', 'formatExcerpt', 'punctuationExcerpt', 'styleExcerpt', 'lexiconHits'].forEach(function(key) {
    var value = String(recall[key] || '');
    recall[key] = value.slice(0, remaining);
    remaining -= recall[key].length;
  });
  recall.recall_meta = {
    total_candidates: Number(task.total_candidates || recall.pages.length),
    loaded_chars: budget - remaining,
    budget_chars: budget,
    degraded: !!task.degraded,
  };
  return recall;
}

function emitDocReviewRecall(sse, knowledgeSource, recall) {
  if (!sse) return;
  sse.send('recall', {
    wiki_id: knowledgeSource.wiki_id,
    pages: recall && recall.pages || [],
    degraded: !!(recall && recall.recall_meta && recall.recall_meta.degraded),
  });
}

// 流式失败收尾：SSE 发 error+done，非流保持原 JSON 响应
function docReviewFail(sse, res, msg, statusCode) {
  if (sse) {
    sse.send('error', { error: msg });
    sse.send('done', {});
    sse.end();
  } else {
    sendJSON(res, statusCode || 500, { error: msg });
  }
}

// 流式成功收尾：SSE 发 result+done，非流保持原 JSON 响应
function docReviewFinish(sse, res, payload) {
  if (sse) {
    sse.send('result', payload);
    sse.send('done', {});
    sse.end();
  } else {
    sendJSON(res, 200, payload);
  }
}

async function handleDocReviewSkills(req, res) {
  try {
    const { listSkills } = require('../tools/doc-review-agent/skills');
    sendJSON(res, 200, { skills: listSkills() });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

async function handleDocReviewChat(req, res) {
  try {
    const body = await readBody(req);
    const { message, context } = body;
    if (!message) { sendJSON(res, 400, { error: 'message is required' }); return; }

    const DocReviewAgent = require('../tools/doc-review-agent/agent');
    var knowledgeSource = docReviewKnowledge.resolveSource(body.wikiId);
    var wikiRoot = knowledgeSource.runtime_root || knowledgeSource.wiki_root;

    // SSE 流式响应
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const agent = new DocReviewAgent({
      verbose: false,
      maxExecuteRounds: 10,
      wikiRoot: wikiRoot,
      onEvent: (type, data) => {
        try { res.write(`data: ${JSON.stringify({ type: type, data: data })}\n\n`); } catch (e) {}
      },
    });

    res.write(`data: ${JSON.stringify({
      type: 'knowledge_source',
      data: {
        knowledge_source: publicDocReviewKnowledgeSource(knowledgeSource),
        review_status: knowledgeSource.mode === 'draft_preview' ? 'partial' : 'complete',
      },
    })}\n\n`);
    const ctx = Object.assign({}, context || {}, { wikiRoot: wikiRoot });
    try {
      const result = await agent.run(message, ctx);
    } catch (agentErr) {
      // onEvent already emitted the error
    }

    res.end();
  } catch (e) {
    if (!res.headersSent) {
      sendJSON(res, 500, { error: e.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', content: e.message })}\n\n`);
      res.end();
    }
  }
}

// 同步审核（非 SSE，直接返回完整报告）
async function handleDocReviewRun(req, res) {
  try {
    const body = await readBody(req);
    const { text, docType, context } = body;
    if (!text) { sendJSON(res, 400, { error: 'text is required' }); return; }

    const DocReviewAgent = require('../tools/doc-review-agent/agent');
    var knowledgeSource = docReviewKnowledge.resolveSource(body.wikiId);
    var wikiRoot = knowledgeSource.runtime_root || knowledgeSource.wiki_root;
    const agent = new DocReviewAgent({ verbose: false, wikiRoot: wikiRoot });
    const result = await agent.run(text, Object.assign({}, context || {}, { docType: docType, wikiRoot: wikiRoot }));
    sendJSON(res, 200, {
      success: true,
      report: result,
      knowledge_source: publicDocReviewKnowledgeSource(knowledgeSource),
      review_status: knowledgeSource.mode === 'draft_preview' ? 'partial' : 'complete',
      knowledge_complete: knowledgeSource.mode !== 'draft_preview',
    });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

// 审阅模式：生成 ReviewMark 数组 + 渲染 HTML（body.stream=true 时走 SSE 流式进度）
async function handleDocReviewMarks(req, res) {
  var sse = null;
  try {
    const body = await readBody(req);
    const { text, docType, enableLLM } = body;
    if (!text) { sendJSON(res, 400, { error: 'text is required' }); return; }

    var stream = body.stream === true;
    if (stream) sse = createDocReviewSSE(res);

    const { generateReviewMarks } = require('../tools/doc-review-agent/review-engine');
    const { renderReviewedDocument, renderSuggestionsPanel } = require('../tools/doc-review-agent/review-render');
    const { llmReview, _getLLMConfig } = require('../tools/doc-review-agent/llm-reviewer');
    const { enrichMarks } = require('../tools/doc-review-agent/citations');
    const { recallForReview } = require('../tools/doc-review-agent/knowledge-recaller');

    var knowledgeSource = docReviewKnowledge.resolveSource(body.wikiId);
    var knowledgeOptions = { wikiRoot: knowledgeSource.runtime_root || knowledgeSource.wiki_root };
    docReviewPhase(sse, 'knowledge', 'done', knowledgeSource.message);

    // ── 阶段 0: 文种识别（基于标题，而非全文，避免"请示事项"等干扰） ──
    docReviewPhase(sse, 'identify', 'active', '从标题识别公文文种');
    var CONFIG = require('../tools/doc-review-agent/config');
    var identifiedType = docType || '';
    if (!identifiedType) {
      var lines = text.split('\n');
      var title = '';
      // 优先匹配"关于…的…"标题行（红头版头的发文机关标志、发文字号行不干扰）
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        if (t && /^关于.+的.+$/.test(t)) { title = t; break; }
      }
      if (!title) {
        // 兜底：取首个非空行，跳过版头元素（发文机关标志、发文字号）
        for (var i2 = 0; i2 < lines.length; i2++) {
          var t2 = lines[i2].trim();
          if (!t2) continue;
          if (/文件$/.test(t2) && t2.indexOf('关于') < 0) continue;
          if (/[〔\[]\d{4}[〕\]]\s*\d*号$/.test(t2)) continue;
          title = t2;
          break;
        }
      }
      var titleMatch = title.match(/关于.+的(.+)$/);
      var titleKeyword = titleMatch ? titleMatch[1] : title;
      // 讲话稿标题模式："在全行数字化转型推进会上的讲话" / "XX讲话稿"（无"关于…的…"结构）
      if (!identifiedType && (/^在.+上.*的讲话$/.test(title) || /讲话稿$/.test(title) || /^在.+上.*的主持词$/.test(title))) {
        identifiedType = 'speech';
      }
      outer: for (var dt in CONFIG.docTypeKeywords) {
        for (var j = 0; j < CONFIG.docTypeKeywords[dt].length; j++) {
          if (titleKeyword.indexOf(CONFIG.docTypeKeywords[dt][j]) >= 0) {
            identifiedType = dt;
            break outer;
          }
        }
      }
      if (!identifiedType) {
        var endingMap = { '特此通知': 'notice', '妥否': 'request', '特此报告': 'report', '函复': 'letter', '此复': 'reply' };
        for (var kw in endingMap) {
          if (text.indexOf(kw) >= 0) { identifiedType = endingMap[kw]; break; }
        }
      }
    }
    docReviewPhase(sse, 'identify', 'done', '文种：' + (identifiedType || '未知'));

    // ── 阶段 2: 图谱推理 — 以文种页为种子沿四信号加权边展开审核规则集 ──
    var ruleSet = [];
    try {
      docReviewPhase(sse, 'graph', 'active', '以「' + (identifiedType || '未知') + '」为种子沿知识图谱推理审核规则集');
      if (knowledgeSource.mode !== 'draft_preview') {
        ruleSet = require('../tools/doc-review-agent/knowledge-recaller').inferGraphRuleSet(identifiedType, knowledgeOptions);
      }
      var top3 = ruleSet.slice(0, 3).map(function(c) {
        return c.id.split('/').pop().replace(/\.md$/, '') + ' (' + c.w + ')';
      }).join(' · ');
      docReviewPhase(sse, 'graph', 'done', '推理出 ' + ruleSet.length + ' 套规则' + (top3 ? '：' + top3 : ''));
    } catch (e) {
      ruleSet = [];
      docReviewPhase(sse, 'graph', 'done', '图谱推理降级：' + e.message);
    }

    // ── 阶段 3: 规则审阅（确定性） ──
    docReviewPhase(sse, 'rules', 'active', '标点 / 忌用词 / 序号 / 日期 / 文种规范检查');
    var reviewResult = generateReviewMarks(text, { docType: identifiedType, wikiRoot: knowledgeOptions.wikiRoot });
    var allMarks = reviewResult.marks.slice();
    docReviewPhase(sse, 'rules', 'done', '规则审阅完成：' + reviewResult.marks.length + ' 条建议');

    // ── 阶段 4: 按推理集装配知识内容（供 LLM 注入与前端图谱高亮） ──
    var recall = null;
    var recallProfile = null;
    var catalog = null; // 知识库目录（两级注入 L0 导航层，LLM 可按需请求精读）
    try {
      docReviewPhase(sse, 'recall', 'active', '按边权装配规则页内容（预算 ≤6500 字符）');
      var baseRecall = recallForReview(identifiedType, text, { ruleSet: ruleSet, wikiRoot: knowledgeOptions.wikiRoot });
      var taskRecall = docReviewKnowledge.recallForTask(knowledgeSource, identifiedType, text, { maxPages: 6, maxChars: 4000 });
      recall = mergeTaskRecall(baseRecall, taskRecall, 6500);
      recallProfile = require('../tools/doc-review-agent/profile-loader').loadProfile(identifiedType, knowledgeOptions);
      catalog = knowledgeSource.mode === 'draft_preview'
        ? []
        : require('../tools/doc-review-agent/knowledge-recaller').recallCatalog(knowledgeOptions);
      var totalChars = (recall.graphExcerpts || []).reduce(function(s, x) { return s + x.content.length; }, 0) +
        ['docTypePage', 'formatExcerpt', 'punctuationExcerpt', 'styleExcerpt', 'lexiconHits'].reduce(function(s, k) { return s + recall[k].length; }, 0);
      docReviewPhase(sse, 'recall', 'done', '装配 ' + (recall.pages || []).length + ' 页知识 · ' + totalChars + ' 字符（档案 ' + recallProfile.name + '）');
      emitDocReviewRecall(sse, knowledgeSource, recall);
    } catch (e) {
      recall = null; // 召回失败不阻断审核
      docReviewPhase(sse, 'recall', 'done', '知识装配降级：' + e.message);
    }

    // ── 阶段 3: LLM 语义审阅（可选） ──
    var llmSummary = null;
    var llmResultMeta = null; // LLM 审阅内部结构（轮次/截断/精读页），供前端节点下钻展示
    var llmEnabled = enableLLM !== false; // 默认启用
    var llmAvailable = !!_getLLMConfig();
    var llmError = null;

    if (llmEnabled && llmAvailable) {
      docReviewPhase(sse, 'llm', 'active', '大模型语义审阅启动');
      try {
        var llmResult = await llmReview(text, identifiedType, {
          recall: recall,
          catalog: catalog, // 两级注入 L0 导航层
          wikiRoot: knowledgeOptions.wikiRoot,
          knowledgeSource: publicDocReviewKnowledgeSource(knowledgeSource),
          onProgress: function(title, detail) {
            docReviewPhase(sse, 'llm', 'progress', (title || '') + (detail ? '：' + detail : ''));
          },
        });
        // 合并 LLM marks
        allMarks = allMarks.concat(llmResult.marks || []);
        llmSummary = llmResult.summary;
        llmResultMeta = llmResult.meta || null;
        if (llmResult.error) llmError = llmResult.error;
      } catch (e) {
        llmError = e.message;
      }
      if (llmError) {
        docReviewPhase(sse, 'llm', 'done', 'LLM 审阅失败：' + llmError + '（已降级为规则审阅）');
      } else {
        docReviewPhase(sse, 'llm', 'done', 'LLM 审阅完成：' + (allMarks.length - reviewResult.marks.length) + ' 条语义建议');
      }
    } else {
      docReviewPhase(sse, 'llm', 'done', 'LLM 未启用或未配置，跳过语义审阅');
    }

    // 溯源安全网：补齐缺失的 citation
    allMarks = enrichMarks(allMarks, knowledgeOptions);

    // 重新计算 stats
    var stats = {
      total: allMarks.length,
      replace: allMarks.filter(function(m) { return m.type === 'replace'; }).length,
      delete: allMarks.filter(function(m) { return m.type === 'delete'; }).length,
      insert: allMarks.filter(function(m) { return m.type === 'insert'; }).length,
      comment: allMarks.filter(function(m) { return m.type === 'comment'; }).length,
      p0: allMarks.filter(function(m) { return m.severity === 'P0'; }).length,
      p1: allMarks.filter(function(m) { return m.severity === 'P1'; }).length,
      p2: allMarks.filter(function(m) { return m.severity === 'P2'; }).length,
      rule_marks: reviewResult.marks.length,
      llm_marks: allMarks.length - reviewResult.marks.length,
      llm_enabled: llmEnabled && llmAvailable,
      llm_error: llmError,
    };

    // ── 阶段 3: 渲染 ──
    docReviewPhase(sse, 'render', 'active', '生成修订视图与建议清单');
    var rendered = renderReviewedDocument(reviewResult.paragraphs, allMarks);
    var suggestionsHtml = renderSuggestionsPanel(allMarks);
    docReviewPhase(sse, 'render', 'done', '渲染完成');

    docReviewFinish(sse, res, {
      success: true,
      docType: identifiedType,
      marks: allMarks,
      stats: stats,
      llmSummary: llmSummary,
      llm_meta: llmResultMeta,
      documentHtml: rendered.documentHtml,
      comments: rendered.comments,
      suggestionsHtml: suggestionsHtml,
      recall_pages: recall ? recall.pages : [],
      format_profile: recallProfile ? recallProfile.name : '',
      knowledge_source: Object.assign(publicDocReviewKnowledgeSource(knowledgeSource), {
        loaded_pages: recall && recall.pages ? recall.pages.length : 0,
      }),
      review_status: knowledgeSource.mode === 'draft_preview' ? 'partial' : 'complete',
      knowledge_complete: knowledgeSource.mode !== 'draft_preview',
    });
  } catch (e) {
    console.error("[doc-review-handler] 审阅异常:", e.stack || e.message);
    docReviewFail(sse, res, e.message);
  }
}

function handleDocReviewKnowledgeSources(req, res) {
  try {
    var listed = docReviewKnowledge.listSources();
    sendJSON(res, 200, {
      sources: listed.sources.map(publicDocReviewKnowledgeSource),
      default_wiki_id: listed.default_wiki_id,
    });
  } catch (e) {
    sendJSON(res, e.statusCode || 500, { error: e.message, code: e.code || 'DOC_REVIEW_KNOWLEDGE_ERROR' });
  }
}

function handleDocReviewWikiPage(req, res) {
  try {
    var url = new URL(req.url, 'http://localhost');
    var source = docReviewKnowledge.resolveSource(url.searchParams.get('wikiId'));
    var page = url.searchParams.get('page') || '';
    var content = docReviewKnowledge.readPage(source, page);
    sendJSON(res, 200, {
      wiki_id: source.wiki_id,
      page: page,
      content: content,
      knowledge_source: publicDocReviewKnowledgeSource(source),
    });
  } catch (e) {
    sendJSON(res, e.statusCode || 500, { error: e.message, code: e.code || 'DOC_REVIEW_KNOWLEDGE_ERROR' });
  }
}

// 公文审核 Agent 知识图谱：从当前选择的公文审核 Wiki 加载权威图谱。
// 权重模型复用 llm-wiki-engine GraphBuilder 的四信号设计（nashsu/llm_wiki 同款）：
//   直接链接 ×3.0（双向互链再 +3.0）、同源重叠 ×4.0、共同邻居 Adamic-Adar ×1.5、
//   类型亲和 ×1.0（仅作用于已有边）；权重归一化 0-10，边携带 signals 数组。
// 前端按权重做弱/强视觉分层，任务完成后按 recall_pages 点亮召回节点。
function handleDocReviewWikiGraph(req, res) {
  try {
    var url = new URL(req.url, 'http://localhost');
    var source = docReviewKnowledge.resolveSource(url.searchParams.get('wikiId'));
    var graph = docReviewKnowledge.loadGraph(source);
    sendJSON(res, 200, Object.assign({}, graph, {
      wiki_id: source.wiki_id,
      knowledge_source: publicDocReviewKnowledgeSource(source),
    }));
  } catch (e) {
    sendJSON(res, e.statusCode || 500, { error: e.message, code: e.code || 'DOC_REVIEW_KNOWLEDGE_ERROR' });
  }
}

// 应用接受的 marks，生成最终文稿
async function handleDocApplyMarks(req, res) {
  try {
    const body = await readBody(req);
    const { text, marks, acceptedIds } = body;
    if (!text) { sendJSON(res, 400, { error: 'text is required' }); return; }

    const { applyAcceptedMarks } = require('../tools/doc-review-agent/review-render');
    var paragraphs = text.split('\n');
    var finalText = applyAcceptedMarks(paragraphs, marks || [], acceptedIds || []);

    sendJSON(res, 200, { success: true, finalText: finalText });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

// 文件上传审阅：接收 docx/pdf 文件，解析+格式检查+文本审阅（?stream=1 走 SSE 流式进度）
async function handleDocUploadReview(req, res) {
  var sse = null;
  try {
    // 流式开关用 query 参数（multipart body 无法带 JSON 标志）
    var stream = new URL(req.url, 'http://localhost').searchParams.get('stream') === '1';
    if (stream) sse = createDocReviewSSE(res);

    const formidable = require('formidable');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    var form = new formidable.IncomingForm();
    form.uploadDir = os.tmpdir();
    form.maxFileSize = 20 * 1024 * 1024; // 20MB

    form.parse(req, async function(err, fields, files) {
      if (err) {
        docReviewFail(sse, res, '文件上传失败: ' + err.message);
        return;
      }

      // formidable v3 返回 file 对象（含 filepath, originalFilename, mimetype）
      var file = files.file || (files.upload ? (files.upload.length ? files.upload[0] : files.upload) : null);
      if (!file) {
        docReviewFail(sse, res, '未找到上传文件', 400);
        return;
      }
      if (Array.isArray(file)) file = file[0];

      var filePath = file.filepath || file.path;
      var fileName = file.originalFilename || file.name || 'unknown';
      // 如果没有扩展名，从 mimetype 推断
      var ext = path.extname(fileName).toLowerCase();
      if (!ext) {
        var mimeToExt = {
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
          'application/pdf': '.pdf',
          'text/plain': '.txt',
        };
        ext = mimeToExt[file.mimetype || ''] || '';
      }
      // 把扩展名附加到临时文件路径
      if (ext && path.extname(filePath).toLowerCase() !== ext) {
        var newPath = filePath + ext;
        try {
          fs.renameSync(filePath, newPath);
          filePath = newPath;
        } catch (e) {}
      }

      try {
        var { parseDocument } = require('../tools/doc-review-agent/docx-parser');
        var { checkFormat, generateFormatSummary } = require('../tools/doc-review-agent/format-checker');
        var { generateReviewMarks } = require('../tools/doc-review-agent/review-engine');
        var { renderReviewedDocument } = require('../tools/doc-review-agent/review-render');
        var { enrichMarks } = require('../tools/doc-review-agent/citations');
        var { recallForReview } = require('../tools/doc-review-agent/knowledge-recaller');
        var fieldWikiId = fields.wikiId;
        if (Array.isArray(fieldWikiId)) fieldWikiId = fieldWikiId[0];
        var knowledgeSource = docReviewKnowledge.resolveSource(fieldWikiId);
        var knowledgeOptions = { wikiRoot: knowledgeSource.runtime_root || knowledgeSource.wiki_root };
        docReviewPhase(sse, 'knowledge', 'done', knowledgeSource.message);

        // 1. 解析文件
        docReviewPhase(sse, 'upload', 'active', '解析文件：' + fileName);
        var doc = await parseDocument(filePath);
        docReviewPhase(sse, 'upload', 'done', '解析完成：' + (doc.metadata ? doc.metadata.paragraphCount : '?') + ' 段');

        // 2. 识别文种（基于标题，避免"请示事项"等内容干扰）
        docReviewPhase(sse, 'identify', 'active', '从标题识别公文文种');
        var identifiedType = '';
        var docTypeConfig = require('../tools/doc-review-agent/config');
        var _lines = doc.text.split('\n');
        var _title = '';
        // 优先匹配"关于…的…"标题行（红头版头的发文机关标志、发文字号行不干扰）
        for (var _i = 0; _i < _lines.length; _i++) {
          var _t = _lines[_i].trim();
          if (_t && /^关于.+的.+$/.test(_t)) { _title = _t; break; }
        }
        if (!_title) {
          // 兜底：取首个非空行，跳过版头元素（发文机关标志、发文字号）
          for (var _i2 = 0; _i2 < _lines.length; _i2++) {
            var _t2 = _lines[_i2].trim();
            if (!_t2) continue;
            if (/文件$/.test(_t2) && _t2.indexOf('关于') < 0) continue;
            if (/[〔\[]\d{4}[〕\]]\s*\d*号$/.test(_t2)) continue;
            _title = _t2;
            break;
          }
        }
        var _titleMatch = _title.match(/关于.+的(.+)$/);
        var _titleKeyword = _titleMatch ? _titleMatch[1] : _title;
        // 讲话稿标题模式："在全行数字化转型推进会上的讲话" / "XX讲话稿"（无"关于…的…"结构）
        if (!identifiedType && (/^在.+上.*的讲话$/.test(_title) || /讲话稿$/.test(_title) || /^在.+上.*的主持词$/.test(_title))) {
          identifiedType = 'speech';
        }
        outer: for (var _dt in docTypeConfig.docTypeKeywords) {
          for (var _j = 0; _j < docTypeConfig.docTypeKeywords[_dt].length; _j++) {
            if (_titleKeyword.indexOf(docTypeConfig.docTypeKeywords[_dt][_j]) >= 0) {
              identifiedType = _dt;
              break outer;
            }
          }
        }
        if (!identifiedType) {
          var _endingMap = { '特此通知': 'notice', '妥否': 'request', '特此报告': 'report', '函复': 'letter', '此复': 'reply' };
          for (var _kw in _endingMap) {
            if (doc.text.indexOf(_kw) >= 0) { identifiedType = _endingMap[_kw]; break; }
          }
        }
        docReviewPhase(sse, 'identify', 'done', '文种：' + (identifiedType || '未知'));

        // 3. 格式检查（按识别出的文种路由格式档案：党政/企业内文/制度/简报讲话稿）
        docReviewPhase(sse, 'format', 'active', '页边距 / 字体 / 字号 / 行距 / 缩进检查');
        var formatResult = checkFormat(doc, { docType: identifiedType, wikiRoot: knowledgeOptions.wikiRoot });
        docReviewPhase(sse, 'format', 'done', '格式检查完成：' + formatResult.marks.length + ' 处（档案：' + formatResult.profile + '）');

        // 3.5 图谱推理：以文种页为种子展开审核规则集
        var ruleSet = [];
        try {
          docReviewPhase(sse, 'graph', 'active', '以「' + (identifiedType || '未知') + '」为种子沿知识图谱推理审核规则集');
          if (knowledgeSource.mode !== 'draft_preview') {
            ruleSet = require('../tools/doc-review-agent/knowledge-recaller').inferGraphRuleSet(identifiedType, knowledgeOptions);
          }
          var top3 = ruleSet.slice(0, 3).map(function(c) {
            return c.id.split('/').pop().replace(/\.md$/, '') + ' (' + c.w + ')';
          }).join(' · ');
          docReviewPhase(sse, 'graph', 'done', '推理出 ' + ruleSet.length + ' 套规则' + (top3 ? '：' + top3 : ''));
        } catch (e) {
          ruleSet = [];
          docReviewPhase(sse, 'graph', 'done', '图谱推理降级：' + e.message);
        }

        // 4. 文本审阅（规则，传入识别出的 docType 以触发文种相关检查）
        docReviewPhase(sse, 'rules', 'active', '标点 / 忌用词 / 文种规范检查');
        var reviewResult = generateReviewMarks(doc.text, { docType: identifiedType, wikiRoot: knowledgeOptions.wikiRoot });
        var textMarks = reviewResult.marks || [];
        docReviewPhase(sse, 'rules', 'done', '文本审阅完成：' + textMarks.length + ' 处');

        // 4.5 按推理集装配知识内容（供 LLM 注入与前端图谱高亮）
        var recall = null;
        var catalog = null; // 知识库目录（两级注入 L0 导航层）
        try {
          docReviewPhase(sse, 'recall', 'active', '按边权装配规则页内容（预算 ≤6500 字符）');
          var baseRecall = recallForReview(identifiedType, doc.text, { ruleSet: ruleSet, wikiRoot: knowledgeOptions.wikiRoot });
          var taskRecall = docReviewKnowledge.recallForTask(knowledgeSource, identifiedType, doc.text, { maxPages: 6, maxChars: 4000 });
          recall = mergeTaskRecall(baseRecall, taskRecall, 6500);
          catalog = knowledgeSource.mode === 'draft_preview'
            ? []
            : require('../tools/doc-review-agent/knowledge-recaller').recallCatalog(knowledgeOptions);
          docReviewPhase(sse, 'recall', 'done', '装配 ' + (recall.pages || []).length + ' 页知识（档案 ' + formatResult.profile + '）');
          emitDocReviewRecall(sse, knowledgeSource, recall);
        } catch (e) {
          recall = null;
          docReviewPhase(sse, 'recall', 'done', '知识装配降级：' + e.message);
        }

        // 5. LLM 语义审阅（与文本审阅一致：注入召回知识 + 目录，两级注入 L0→L1）
        var llmSummary = null;
        var llmResultMeta = null;
        var llmError = null;
        var llmMarks = [];
        var llmEnabled = new URL(req.url, 'http://localhost').searchParams.get('llm') !== '0'; // 默认启用
        var { _getLLMConfig } = require('../tools/doc-review-agent/llm-reviewer');
        var llmAvailable = !!_getLLMConfig();
        if (llmEnabled && llmAvailable) {
          docReviewPhase(sse, 'llm', 'active', '大模型语义审阅启动');
          try {
            const { llmReview } = require('../tools/doc-review-agent/llm-reviewer');
            var llmResult = await llmReview(doc.text, identifiedType, {
              recall: recall,
              catalog: catalog,
              wikiRoot: knowledgeOptions.wikiRoot,
              knowledgeSource: publicDocReviewKnowledgeSource(knowledgeSource),
              onProgress: function(title, detail) {
                docReviewPhase(sse, 'llm', 'progress', (title || '') + (detail ? '：' + detail : ''));
              },
            });
            llmMarks = llmResult.marks || [];
            llmSummary = llmResult.summary;
            llmResultMeta = llmResult.meta || null;
            if (llmResult.error) llmError = llmResult.error;
          } catch (e) {
            llmError = e.message;
          }
          if (llmError) {
            docReviewPhase(sse, 'llm', 'done', 'LLM 审阅失败：' + llmError + '（已降级为规则审阅）');
          } else {
            docReviewPhase(sse, 'llm', 'done', 'LLM 审阅完成：' + llmMarks.length + ' 条语义建议');
          }
        } else {
          docReviewPhase(sse, 'llm', 'done', 'LLM 未启用或未配置，跳过语义审阅');
        }

        // 6. 合并 marks + 溯源安全网
        var allMarks = formatResult.marks.concat(textMarks).concat(llmMarks);
        allMarks = enrichMarks(allMarks, knowledgeOptions);

        // 6. 渲染 + 7. 生成格式摘要
        docReviewPhase(sse, 'render', 'active', '生成修订视图与建议清单');
        var paragraphs = doc.text.split('\n');
        var rendered = renderReviewedDocument(paragraphs, allMarks);
        var formatSummary = generateFormatSummary(doc, formatResult);
        docReviewPhase(sse, 'render', 'done', '渲染完成');

        docReviewFinish(sse, res, {
          success: true,
          fileName: fileName,
          docType: identifiedType,
          text: doc.text,
          marks: allMarks,
          stats: {
            total: allMarks.length,
            replace: allMarks.filter(function(m) { return m.type === 'replace'; }).length,
            delete: allMarks.filter(function(m) { return m.type === 'delete'; }).length,
            insert: allMarks.filter(function(m) { return m.type === 'insert'; }).length,
            comment: allMarks.filter(function(m) { return m.type === 'comment'; }).length,
            format_marks: formatResult.marks.length,
            text_marks: textMarks.length,
            llm_marks: llmMarks.length,
            llm_enabled: llmEnabled && llmAvailable,
            llm_error: llmError,
            p0: allMarks.filter(function(m) { return m.severity === 'P0'; }).length,
            p1: allMarks.filter(function(m) { return m.severity === 'P1'; }).length,
            p2: allMarks.filter(function(m) { return m.severity === 'P2'; }).length,
          },
          formatSummary: formatSummary,
          formatProfile: formatResult.profile,
          llmSummary: llmSummary,
          llm_meta: llmResultMeta,
          pageSettings: doc.pageSettings,
          documentHtml: rendered.documentHtml,
          comments: rendered.comments,
          recall_pages: recall ? recall.pages : [],
          knowledge_source: Object.assign(publicDocReviewKnowledgeSource(knowledgeSource), {
            loaded_pages: recall && recall.pages ? recall.pages.length : 0,
          }),
          review_status: knowledgeSource.mode === 'draft_preview' ? 'partial' : 'complete',
          knowledge_complete: knowledgeSource.mode !== 'draft_preview',
        });

      } catch (parseErr) {
        docReviewFail(sse, res, '文件解析失败: ' + parseErr.message);
      } finally {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
    });
  } catch (e) {
    console.error("[doc-review-handler] 审阅异常:", e.stack || e.message);
    docReviewFail(sse, res, e.message);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ═══════════════════════════════════════════════
// INGEST QUEUE Handlers
// ═══════════════════════════════════════════════

function getOrCreateQueue(project) {
  if (!queues[project]) {
    const wp = getWikiProjectPath(project);
    queues[project] = new IngestQueue(wp);
  }
  return queues[project];
}

function handleQueueStatus(req, res, url) {
  const project = url.searchParams.get('project');
  if (!project) { sendJSON(res, 400, { success: false, error: 'Missing project' }); return; }
  const q = getOrCreateQueue(project);
  sendJSON(res, 200, { success: true, progress: q.getProgress(), items: q.getItems() });
}

async function handleQueueStart(req, res) {
  try {
    const body = await parseBody(req);
    const { project, files, model } = body;
    if (!project) { sendJSON(res, 400, { success: false, error: 'Missing project' }); return; }
    const q = getOrCreateQueue(project);
    const rt = createWikiEngineForModel(model);
    if (files && files.length) q.enqueue(files, { projectName: project });
    q.start(rt.engine, { onProgress: function(p) { /* SSE could be added here */ } });
    sendJSON(res, 200, { success: true, progress: q.getProgress() });
  } catch (e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

function handleQueueStop(req, res) {
  const body = parseBody(req);
  body.then(function(b) {
    const q = getOrCreateQueue(b.project);
    if (!b.project) { sendJSON(res, 400, { success: false, error: 'Missing project' }); return; }
    q.stop();
    sendJSON(res, 200, { success: true });
  }).catch(function(e) { sendJSON(res, 500, { success: false, error: e.message }); });
}

function handleQueuePause(req, res) {
  parseBody(req).then(function(b) {
    if (!b.project) { sendJSON(res, 400, { success: false, error: 'Missing project' }); return; }
    getOrCreateQueue(b.project).pause();
    sendJSON(res, 200, { success: true });
  }).catch(function(e) { sendJSON(res, 500, { success: false, error: e.message }); });
}

function handleQueueResume(req, res) {
  parseBody(req).then(function(b) {
    if (!b.project) { sendJSON(res, 400, { success: false, error: 'Missing project' }); return; }
    getOrCreateQueue(b.project).resume();
    sendJSON(res, 200, { success: true });
  }).catch(function(e) { sendJSON(res, 500, { success: false, error: e.message }); });
}

function handleQueueRemove(req, res) {
  parseBody(req).then(function(b) {
    if (!b.project || !b.id) { sendJSON(res, 400, { success: false, error: 'Missing params' }); return; }
    const ok = getOrCreateQueue(b.project).remove(b.id);
    sendJSON(res, 200, { success: ok });
  }).catch(function(e) { sendJSON(res, 500, { success: false, error: e.message }); });
}

// ═══════════════════════════════════════════════
// SOURCE WATCHER Handlers
// ═══════════════════════════════════════════════

function getOrCreateWatcher(project) {
  if (!watchers[project]) {
    const wp = getWikiProjectPath(project);
    const sourcesDir = path.join(CONFIG.rawRoot || path.join(__dirname, '../wiki-raw'), project);
    watchers[project] = new SourceWatcher(sourcesDir);
    watchers[project].on('detected', function(files) {
      const q = getOrCreateQueue(project);
      const added = q.enqueue(files, { projectName: project });
      // Auto-start queue if not running
      if (added.length && !q.running) {
        const rt = createWikiEngineForModel(DEFAULT_CHAT_MODEL);
        q.start(rt.engine);
      }
    });
  }
  return watchers[project];
}

function handleWatcherStart(req, res) {
  parseBody(req).then(function(b) {
    if (!b.project) { sendJSON(res, 400, { success: false, error: 'Missing project' }); return; }
    getOrCreateWatcher(b.project).start();
    sendJSON(res, 200, { success: true, message: 'Watcher started' });
  }).catch(function(e) { sendJSON(res, 500, { success: false, error: e.message }); });
}

function handleWatcherStop(req, res) {
  parseBody(req).then(function(b) {
    if (!b.project) { sendJSON(res, 400, { success: false, error: 'Missing project' }); return; }
    const w = watchers[b.project];
    if (w) w.stop();
    sendJSON(res, 200, { success: true });
  }).catch(function(e) { sendJSON(res, 500, { success: false, error: e.message }); });
}

// ═══════════════════════════════════════════════
// REVIEW SYSTEM Handlers
// ═══════════════════════════════════════════════

function getOrCreateReview(project) {
  if (!reviews[project]) {
    const wp = getWikiProjectPath(project);
    reviews[project] = new ReviewSystem(wp);
  }
  return reviews[project];
}

function handleReviewList(req, res, url) {
  const project = url.searchParams.get('project');
  if (!project) { sendJSON(res, 400, { success: false, error: 'Missing project' }); return; }
  const rs = getOrCreateReview(project);
  sendJSON(res, 200, { success: true, items: rs.getPending(), stats: rs.getStats() });
}

function handleReviewStats(req, res, url) {
  const project = url.searchParams.get('project');
  if (!project) { sendJSON(res, 400, { success: false, error: 'Missing project' }); return; }
  const rs = getOrCreateReview(project);
  sendJSON(res, 200, { success: true, stats: rs.getStats() });
}

function handleReviewApprove(req, res) {
  parseBody(req).then(function(b) {
    if (!b.project || !b.id) { sendJSON(res, 400, { success: false, error: 'Missing params' }); return; }
    const rs = getOrCreateReview(b.project);
    rs.approve(b.id, b.metadata);
    sendJSON(res, 200, { success: true });
  }).catch(function(e) { sendJSON(res, 500, { success: false, error: e.message }); });
}

function handleReviewReject(req, res) {
  parseBody(req).then(function(b) {
    if (!b.project || !b.id) { sendJSON(res, 400, { success: false, error: 'Missing params' }); return; }
    const rs = getOrCreateReview(b.project);
    rs.reject(b.id, b.reason);
    sendJSON(res, 200, { success: true });
  }).catch(function(e) { sendJSON(res, 500, { success: false, error: e.message }); });
}

function handleReviewSkip(req, res) {
  parseBody(req).then(function(b) {
    if (!b.project || !b.id) { sendJSON(res, 400, { success: false, error: 'Missing params' }); return; }
    const rs = getOrCreateReview(b.project);
    rs.skip(b.id);
    sendJSON(res, 200, { success: true });
  }).catch(function(e) { sendJSON(res, 500, { success: false, error: e.message }); });
}

// ═══════════════════════════════════════════════
// EVALUATION FINDINGS Handlers
// ═══════════════════════════════════════════════

function handleListFindings(req, res) {
  try {
    var store = readFindings();
    sendJSON(res, 200, { success: true, data: store.findings });
  } catch (e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

async function handleCreateFinding(req, res) {
  try {
    var body = await parseBody(req);
    var now = new Date().toISOString();
    var finding = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2),
      runId: body.runId || '',
      caseResultId: body.caseResultId || '',
      title: body.title || 'Untitled finding',
      description: body.description || '',
      severity: body.severity || 'MEDIUM',
      status: body.status || 'OPEN',
      owner: body.owner || '',
      sourceType: body.sourceType || 'WIKI',
      sourceId: body.sourceId || '',
      resolutionNote: body.resolutionNote || '',
      updatedAt: now,
      rootCause: '',
      rootCauseCategory: '',
      remediation: '',
      remediationType: '',
      reviewer: body.reviewer || '',
      reviewNote: body.reviewNote || '',
      targetKbId: body.targetKbId || '',
      targetDocId: body.targetDocId || '',
    };
    var store = readFindings();
    store.findings.push(finding);
    writeFindings(store);
    sendJSON(res, 200, { success: true, data: finding });
  } catch (e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

async function handleUpdateFinding(req, res, id) {
  try {
    var body = await parseBody(req);
    var ref = findFindingById(id);
    if (!ref.finding) { sendJSON(res, 404, { success: false, error: 'Finding not found' }); return; }
    var updatable = ['title','description','severity','status','owner','sourceType','sourceId','resolutionNote','rootCause','rootCauseCategory','remediation','remediationType','reviewer','reviewNote','targetKbId','targetDocId'];
    updatable.forEach(function (k) { if (body[k] !== undefined) ref.finding[k] = body[k]; });
    ref.finding.updatedAt = new Date().toISOString();
    writeFindings(ref.store);
    sendJSON(res, 200, { success: true, data: ref.finding });
  } catch (e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

async function handleAnalyzeBadcase(req, res, id) {
  try {
    var ref = findFindingById(id);
    if (!ref.finding) { sendJSON(res, 404, { success: false, error: 'Finding not found' }); return; }
    var finding = ref.finding;

    // 收集上下文：关联 wiki 页面内容
    var contextParts = [];
    if (finding.targetKbId) {
      var wp = getWikiProjectPath(finding.targetKbId);
      if (fs.existsSync(wp)) {
        // 读取 SCHEMA.md
        var schemaFile = path.join(wp, 'SCHEMA.md');
        if (fs.existsSync(schemaFile)) {
          contextParts.push('## Wiki SCHEMA\n' + fs.readFileSync(schemaFile, 'utf8').slice(0, 3000));
        }
        // 读取关联页面
        if (finding.targetDocId) {
          var pageFile = path.join(wp, finding.targetDocId.endsWith('.md') ? finding.targetDocId : finding.targetDocId + '.md');
          if (fs.existsSync(pageFile)) {
            contextParts.push('## Target Page (' + finding.targetDocId + ')\n' + fs.readFileSync(pageFile, 'utf8').slice(0, 4000));
          }
        }
      }
    }

    // 构建 LLM prompt
    var systemPrompt = 'You are a knowledge quality analyst. Analyze the root cause of the bad case and provide remediation suggestions. Respond in JSON format with fields: rootCause, rootCauseCategory, remediation, remediationType.';
    var userPrompt = '## Finding\nTitle: ' + finding.title + '\nDescription: ' + finding.description + '\nSeverity: ' + finding.severity + '\nSource: ' + finding.sourceType + ' / ' + finding.sourceId + '\n';
    if (contextParts.length > 0) {
      userPrompt += '\n## Context\n' + contextParts.join('\n\n');
    }
    userPrompt += '\n\nAnalyze the root cause and suggest remediation. Respond as JSON: {"rootCause":"...","rootCauseCategory":"...","remediation":"...","remediationType":"..."}';

    var llmResult = await callLLM(userPrompt, systemPrompt);

    if (llmResult) {
      // 尝试解析 LLM 返回的 JSON
      var jsonMatch = llmResult.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          var parsed = JSON.parse(jsonMatch[0]);
          finding.rootCause = parsed.rootCause || llmResult;
          finding.rootCauseCategory = parsed.rootCauseCategory || '';
          finding.remediation = parsed.remediation || '';
          finding.remediationType = parsed.remediationType || '';
        } catch (e) {
          finding.rootCause = llmResult;
        }
      } else {
        finding.rootCause = llmResult;
      }
    }

    finding.updatedAt = new Date().toISOString();
    writeFindings(ref.store);

    sendJSON(res, 200, {
      success: true,
      data: {
        id: finding.id,
        rootCause: finding.rootCause,
        rootCauseCategory: finding.rootCauseCategory,
        remediation: finding.remediation,
        remediationType: finding.remediationType,
      },
    });
  } catch (e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

function handleGetBadcaseContext(req, res, url, id) {
  try {
    var ref = findFindingById(id);
    if (!ref.finding) { sendJSON(res, 404, { success: false, error: 'Finding not found' }); return; }
    var finding = ref.finding;

    var context = {
      sourceType: finding.sourceType,
      sourceId: finding.sourceId,
    };

    // 收集关联页面内容
    if (finding.targetKbId) {
      var wp = getWikiProjectPath(finding.targetKbId);
      if (fs.existsSync(wp) && finding.targetDocId) {
        var pageFile = path.join(wp, finding.targetDocId.endsWith('.md') ? finding.targetDocId : finding.targetDocId + '.md');
        if (fs.existsSync(pageFile)) {
          var content = fs.readFileSync(pageFile, 'utf8');
          context.question = finding.title;
          context.actualAnswer = '';
          context.expectedText = finding.description;
          context.resultStatus = finding.status;
          context.retrievedContexts = [{ content: content.slice(0, 4000), source: finding.targetDocId }];
        }
      }
    }

    sendJSON(res, 200, { success: true, data: context });
  } catch (e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

async function handleRetestFinding(req, res, id) {
  try {
    var ref = findFindingById(id);
    if (!ref.finding) { sendJSON(res, 404, { success: false, error: 'Finding not found' }); return; }
    var finding = ref.finding;

    var status = 'FAILED';
    var score = 0;
    var actualText = '';
    var expectedText = finding.description || '';

    // 简单验证：检查关联页面是否存在且内容已更新
    if (finding.targetKbId && finding.targetDocId) {
      var wp = getWikiProjectPath(finding.targetKbId);
      var pageFile = path.join(wp, finding.targetDocId.endsWith('.md') ? finding.targetDocId : finding.targetDocId + '.md');
      if (fs.existsSync(pageFile)) {
        var content = fs.readFileSync(pageFile, 'utf8');
        actualText = content.slice(0, 2000);
        // 检查页面是否包含 expectedText 中的关键词
        var keywords = expectedText.split(/[\s,，。、]+/).filter(function (w) { return w.length > 2; }).slice(0, 5);
        var hits = keywords.filter(function (k) { return content.includes(k); }).length;
        score = keywords.length > 0 ? hits / keywords.length : 0.5;
        status = score >= 0.6 ? 'PASSED' : 'FAILED';
      }
    }

    // 更新 finding 状态
    if (status === 'PASSED') {
      finding.status = 'CLOSED';
    } else {
      finding.status = 'IN_PROGRESS';
    }
    finding.updatedAt = new Date().toISOString();
    writeFindings(ref.store);

    sendJSON(res, 200, {
      success: true,
      data: {
        finding: finding,
        result: { status: status, score: score, actualText: actualText, expectedText: expectedText },
      },
    });
  } catch (e) { sendJSON(res, 500, { success: false, error: e.message }); }
}

module.exports = { handleKnowledgeStudioRequest, getWikiProjectPath, buildFsTree, createKnowledgeStudioWikiFacade };
