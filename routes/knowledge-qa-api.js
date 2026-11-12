/**
 * Knowledge QA API — Dedicated HTTP API for knowledge Q&A
 *
 * Features:
 *   - Token-authenticated API
 *   - Deep Research (topic generation → search → synthesize → ingest)
 *   - Hybrid search (keyword + vector via RRF)
 *   - Graph-expanded retrieval (2-hop traversal)
 *   - Context budget control
 *
 * Endpoints:
 *   POST /api/knowledge-qa/search       — Hybrid search with budget
 *   POST /api/knowledge-qa/ask           — RAG Q&A with context control
 *   POST /api/knowledge-qa/research      — Deep Research pipeline
 *   POST /api/knowledge-qa/research/topics — Generate research topics only
 *   GET  /api/knowledge-qa/health         — Health check (no auth)
 *   POST /api/knowledge-qa/graph/search   — Graph-expanded search (2-hop)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const { GraphBuilder, CONFIG } = require('../tools/llm-wiki-engine');
const { WikiManifestIndex } = require('../tools/wiki-manifest-index');
const { DeepResearch } = require('../tools/deep-research');
const { API_ROUTES, DEFAULT_CHAT_MODEL } = require('../config/api-keys');

CONFIG.wikiRoot = path.join(__dirname, '../data/wiki');

// Manifest index：Wiki 写入时生成，查询时加载。build() 内置 mtime 缓存，命中时 O(1)。
var wikiManifestQA = new WikiManifestIndex();

function _loadManifest(project) {
  var wp = getWikiProjectPath(project);
  if (fs.existsSync(wp)) wikiManifestQA.build(wp);
}

// 图谱构建器（图谱扩展仍需）
var _graphByProject = {};
function _getGraphBuilder(project) {
  var wp = getWikiProjectPath(project);
  var mtime = 0;
  try { mtime = fs.statSync(wp).mtimeMs; } catch(e) {}
  if (!_graphByProject[project] || _graphByProject[project]._mtime !== mtime) {
    var gb = new GraphBuilder();
    gb._mtime = mtime;
    _graphByProject[project] = gb;
  }
  return _graphByProject[project];
}

// 辅助：候选集内关键词精排
function _scoreByKeywordsQA(query, title, content, baseScore) {
  var qTokens = tokenizeLocalQA(query);
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
function tokenizeLocalQA(text) {
  if (!text) return [];
  var cleaned = text.toLowerCase().replace(/[`~!@#$%^&*()_|+\-=?;:'",.<>\{\}\[\]\\\/]/g, ' ').replace(/\s+/g, ' ').trim();
  var tokens = [];
  var re = /[一-龥]+|[a-z0-9]+/g;
  var match;
  while ((match = re.exec(cleaned)) !== null) { var w = match[0].trim(); if (w && w.length > 1) tokens.push(w); }
  return tokens;
}

// ── Token Auth ──

function generateToken() {
  return 'ks_' + crypto.randomBytes(24).toString('hex');
}

let apiTokens = {};
const TOKENS_FILE = path.join(__dirname, '../data/wiki/.api-tokens.json');

function loadTokens() {
  try { if (fs.existsSync(TOKENS_FILE)) apiTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')); } catch(e) {}
}

function saveTokens() {
  try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(apiTokens, null, 2), 'utf-8'); } catch(e) {}
}

function checkAuth(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '');
  // SKIP_AUTH / DEV_MODE: auto-accept any token, create one on the fly
  if (process.env.SKIP_AUTH === 'true' || process.env.DEV_MODE === 'true') {
    if (!token || !apiTokens[token]) {
      var devToken = 'dev_' + crypto.randomBytes(8).toString('hex');
      apiTokens[devToken] = { created: new Date().toISOString(), label: 'dev-auto' };
      return apiTokens[devToken];
    }
    return apiTokens[token];
  }
  if (!token || !apiTokens[token]) return false;
  return apiTokens[token]; // returns token info
}

loadTokens();

// ── Helpers ──

function sendJSON(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json;charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise(function(resolve, reject) {
    var body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', function() { try { resolve(body ? JSON.parse(body) : {}); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

function getWikiProjectPath(pn) {
  var mf = path.join(CONFIG.wikiRoot, '.mappings.json');
  if (fs.existsSync(mf)) {
    try { var m = JSON.parse(fs.readFileSync(mf, 'utf-8')); if (m[pn]) return m[pn]; } catch(e) {}
  }
  return path.join(CONFIG.wikiRoot, pn);
}

// ── Main handler ──

function handleKnowledgeQARequest(req, res) {
  var url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); } catch(e) { return false; }
  var pathname = url.pathname;
  var method = req.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return true;
  }

  // Only handle /api/knowledge-qa/* paths
  if (!pathname.startsWith('/api/knowledge-qa/')) return false;

  // Health check (no auth)
  if (method === 'GET' && pathname === '/api/knowledge-qa/health') {
    sendJSON(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
    return true;
  }

  // Token management (no auth for create)
  if (method === 'POST' && pathname === '/api/knowledge-qa/token') {
    var token = generateToken();
    apiTokens[token] = { created: new Date().toISOString(), label: 'api-token' };
    saveTokens();
    sendJSON(res, 200, { token: token, message: 'Use this token in Authorization: Bearer header' });
    return true;
  }

  // Graph list (no auth needed — just listing available files)
  if (method === 'GET' && pathname === '/api/knowledge-qa/graphs') {
    return handleQAGraphList(req, res);
  }

  // Models list (no auth needed)
  if (method === 'GET' && pathname === '/api/knowledge-qa/models') {
    var available = [];
    Object.keys(API_ROUTES).forEach(function(key) {
      var r = API_ROUTES[key];
      // Only include chat/completion models (not embedding)
      if (r.path && r.path.indexOf('embeddings') < 0 && r.getKey && r.getKey()) {
        available.push({ id: key, provider: r.provider || key, model: r.model || key });
      }
    });
    sendJSON(res, 200, { success: true, models: available });
    return true;
  }

  // All other endpoints require auth
  var tokenInfo = checkAuth(req);

  // ── Agent Tool APIs (no auth, for internal Python Agent) ──
  if (method === 'POST' && pathname === '/api/knowledge-qa/tools/search_entities') {
    return handleToolSearchEntities(req, res);
  }
  if (method === 'POST' && pathname === '/api/knowledge-qa/tools/query_relations') {
    return handleToolQueryRelations(req, res);
  }
  if (method === 'POST' && pathname === '/api/knowledge-qa/tools/get_node') {
    return handleToolGetNode(req, res);
  }
  if (method === 'POST' && pathname === '/api/knowledge-qa/tools/expand_subgraph') {
    return handleToolExpandSubgraph(req, res);
  }
  if (method === 'GET' && pathname === '/api/knowledge-qa/tools/list_graphs') {
    return handleToolListGraphs(req, res);
  }

  if (!tokenInfo) {
    sendJSON(res, 401, { error: 'Unauthorized. Get a token from POST /api/knowledge-qa/token' });
    return true;
  }

  // ── Search ──
  if (method === 'POST' && pathname === '/api/knowledge-qa/search') {
    return handleQASearch(req, res);
  }

  // ── Ask (RAG) ──
  if (method === 'POST' && pathname === '/api/knowledge-qa/ask') {
    return handleQAAsk(req, res);
  }

  // ── Deep Research ──
  if (method === 'POST' && pathname === '/api/knowledge-qa/research') {
    return handleQAResearch(req, res);
  }

  if (method === 'POST' && pathname === '/api/knowledge-qa/research/topics') {
    return handleQAResearchTopics(req, res);
  }

  // ── Graph query (dedicated) ──
  if (method === 'POST' && pathname === '/api/knowledge-qa/graph/query') {
    return handleQAGraphQuery(req, res);
  }

  // ── GraphRAG (community + subgraph + vector → LLM) ──
  if (method === 'POST' && pathname === '/api/knowledge-qa/graphrag') {
    return handleGraphRAGQuery(req, res);
  }

  return false;
}

// ── Search Handler (Wiki manifest → 按需加载) ──

async function handleQASearch(req, res) {
  try {
    var body = await parseBody(req);
    var { query, project, topK, budget } = body;
    topK = topK || 10;
    var budgetConfig = budget || { totalTokens: 8192, reserveForAnswer: 2048, perSourceTokens: 1200, maxSources: 8 };

    // 1. Manifest 轻量匹配 → 候选文档
    var candidates = [];
    if (project) {
      _loadManifest(project);
      candidates = wikiManifestQA.search(query, { topK: topK * 3 });
    } else {
      var allP = [];
      if (fs.existsSync(CONFIG.wikiRoot)) fs.readdirSync(CONFIG.wikiRoot, { withFileTypes: true }).forEach(function(d) { if (d.isDirectory() && d.name !== '.mappings.json') allP.push(d.name); });
      for (var i = 0; i < allP.length; i++) {
        _loadManifest(allP[i]);
        var prr = wikiManifestQA.search(query, { topK: Math.ceil(topK * 2 / allP.length) + 2 });
        prr.forEach(function(r) { r.project = allP[i]; candidates.push(r); });
      }
      candidates.sort(function(a, b) { return b.score - a.score; });
    }

    // 2. 按需加载候选文档全文 → 精排
    var finalResults = [];
    for (var ci = 0; ci < candidates.length && finalResults.length < budgetConfig.maxSources; ci++) {
      var cand = candidates[ci];
      var wpp = cand.project ? getWikiProjectPath(cand.project) : (project ? getWikiProjectPath(project) : CONFIG.wikiRoot);
      var content = wikiManifestQA.loadContent(wpp, cand.id, { maxChars: budgetConfig.perSourceTokens * 6, stripFrontmatter: true });
      if (!content) continue;
      var refinedScore = _scoreByKeywordsQA(query, cand.title, content, cand.score);
      finalResults.push({
        id: cand.id, title: cand.title, score: refinedScore,
        type: cand.type, tags: cand.tags,
        snippet: content.slice(0, Math.min(300, budgetConfig.perSourceTokens * 3)).replace(/\n/g, ' '),
      });
    }
    finalResults.sort(function(a, b) { return b.score - a.score; });

    // 3. Budget control
    var budgeted = [];
    var usedTokens = 0;
    var maxTokens = budgetConfig.totalTokens - budgetConfig.reserveForAnswer;
    for (var bi = 0; bi < finalResults.length; bi++) {
      var estimatedTokens = Math.ceil((finalResults[bi].snippet || '').length / 3);
      if (usedTokens + estimatedTokens > maxTokens) break;
      budgeted.push(finalResults[bi]);
      usedTokens += Math.min(estimatedTokens, budgetConfig.perSourceTokens);
    }

    usageEventLog.recordUsageEvent({ carrier: 'wiki', project: project || null, query: String(query).slice(0, 200), hits: budgeted.length, caller: 'knowledge-qa-api' });
    sendJSON(res, 200, {
      success: true, query: query,
      results: budgeted,
      budget: { usedTokens: usedTokens, totalBudget: budgetConfig.totalTokens, sourceCount: budgeted.length },
    });
  } catch(e) { sendJSON(res, 500, { error: e.message }); }
}

// ── Ask (RAG) Handler ──

async function handleQAAsk(req, res) {
  try {
    var body = await parseBody(req);
    var question = body.question, project = body.project, model = body.model, topK = body.topK, budget = body.budget, includeGraph = body.includeGraph, direct = body.direct;
    topK = topK || 5;
    model = model || DEFAULT_CHAT_MODEL;
    var budgetConfig = budget || { totalTokens: 8192, reserveForAnswer: 2048, perSourceTokens: 1200, maxSources: 5 };

    var route = API_ROUTES[model] || API_ROUTES[DEFAULT_CHAT_MODEL];
    var apiKey = route && route.getKey ? route.getKey() : null;

    // ── Direct mode: pass prompt straight to LLM (used by graph/fusion modes) ──
    if (direct) {
      if (!apiKey) { sendJSON(res, 200, { answer: 'LLM not configured.', sources: [] }); return; }
      var pd = JSON.stringify({ model: route.model || model, messages: [{ role: 'user', content: question }], max_tokens: budgetConfig.reserveForAnswer || 2048, temperature: 0.5 });
      var opts = { hostname: route.host, port: 443, path: route.path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Content-Length': Buffer.byteLength(pd) } };
      var answer = await new Promise(function(resolve) {
        var r = https.request(opts, function(resp) { var d = ''; resp.on('data', function(c) { d += c; }); resp.on('end', function() { try { var j = JSON.parse(d); resolve(j.choices[0].message.content); } catch(e) { resolve(d); } }); });
        r.on('error', function() { resolve('LLM request failed.'); }); r.write(pd); r.end();
      });
      sendJSON(res, 200, { answer: answer, sources: [], budget: { used: Math.ceil(question.length / 3), total: budgetConfig.totalTokens, sourcesCount: 0 } });
      return;
    }

    var wp = project ? getWikiProjectPath(project) : CONFIG.wikiRoot;
    if (!fs.existsSync(wp)) { sendJSON(res, 200, { answer: 'No wiki project found.', sources: [] }); return; }

    // ═══════════════════════════════════════════════
    // Wiki 知识问答流程（已修复）:
    //   1. Manifest 轻量匹配（仅 title/tags/type/summary）；project 为空时遍历全部项目
    //   2. 按需加载候选文档全文（fs.readFileSync，不做 embedding）
    //   3. 候选集内精排
    //   4. Graph expansion 可选（2-hop，基于 [[wikilinks]]；仅指定项目时）
    //   5. Budget-controlled context assembly
    //   6. LLM generation
    // ═══════════════════════════════════════════════

    // Step 1: Manifest 轻量匹配 → 候选文档（与 search 端点同款的全项目遍历）
    var candidates = [];
    if (project) {
      _loadManifest(project);
      candidates = wikiManifestQA.search(question, { topK: topK * 3 });
    } else {
      var allP = [];
      if (fs.existsSync(CONFIG.wikiRoot)) fs.readdirSync(CONFIG.wikiRoot, { withFileTypes: true }).forEach(function(d) { if (d.isDirectory() && d.name !== '.mappings.json') allP.push(d.name); });
      for (var pi = 0; pi < allP.length; pi++) {
        _loadManifest(allP[pi]);
        var prr = wikiManifestQA.search(question, { topK: Math.ceil(topK * 2 / allP.length) + 2 });
        prr.forEach(function(r) { r.project = allP[pi]; candidates.push(r); });
      }
      candidates.sort(function(a, b) { return b.score - a.score; });
    }

    // Step 2: 按需加载候选全文 → 精排
    var finalResults = [];
    for (var ci = 0; ci < candidates.length && finalResults.length < budgetConfig.maxSources * 2; ci++) {
      var cand = candidates[ci];
      var wpp = cand.project ? getWikiProjectPath(cand.project) : wp;
      var content = wikiManifestQA.loadContent(wpp, cand.id, { maxChars: budgetConfig.perSourceTokens * 6, stripFrontmatter: true });
      if (!content) continue;
      var refinedScore = _scoreByKeywordsQA(question, cand.title, content, cand.score);
      finalResults.push({
        id: cand.id, title: cand.title, score: refinedScore,
        type: cand.type, project: cand.project || project || null,
        snippet: content.slice(0, 300).replace(/\n/g, ' '),
      });
    }
    finalResults.sort(function(a, b) { return b.score - a.score; });
    finalResults = finalResults.slice(0, budgetConfig.maxSources);

    // Step 4: Graph expansion (2-hop) — 可选，基于 [[wikilinks]] 按需构建图谱（仅指定项目时）
    if (includeGraph && project) {
      try {
        var gd = _getGraphBuilder(project).buildFromWiki(wp);
        if (gd && gd.nodes && gd.edges) {
          var seedIds = finalResults.slice(0, 3).map(function(r) { return r.id || r.title; });
          var expanded = expandGraph2Hop(seedIds, gd);
          expanded.forEach(function(id) {
            if (!finalResults.find(function(r) { return (r.id || r.title) === id; })) {
              finalResults.push({ id: id, title: id.replace(/\.md$/, '').replace(/.*\//, ''), snippet: '', score: 0.3, project: project });
            }
          });
        }
      } catch(e) { /* graph expansion failed, continue without it */ }
    }

    // Step 5: On-demand content load + budget control（按需加载，不读无关文件）
    var sources = [];
    var usedBudget = 0;
    var maxCtx = budgetConfig.totalTokens - budgetConfig.reserveForAnswer;
    for (var i = 0; i < finalResults.length; i++) {
      if (i >= budgetConfig.maxSources * 2) break;
      var content = '';
      try {
        var docId = finalResults[i].id || finalResults[i].title || '';
        var rwp = finalResults[i].project ? getWikiProjectPath(finalResults[i].project) : wp;
        var pp = path.join(rwp, docId);
        if (!fs.existsSync(pp)) pp = path.join(rwp, docId + '.md');
        if (fs.existsSync(pp)) {
          content = fs.readFileSync(pp, 'utf-8');
          // Strip frontmatter
          content = content.replace(/^---[\s\S]*?---\n*/, '');
          content = content.slice(0, budgetConfig.perSourceTokens * 3);
        }
      } catch(e) { content = ''; }
      if (!content) continue;
      var estTokens = Math.ceil(content.length / 3);
      if (usedBudget + estTokens > maxCtx) break;
      sources.push({
        title: finalResults[i].title || finalResults[i].id || '',
        content: content.slice(0, budgetConfig.perSourceTokens * 4),
      });
      usedBudget += Math.min(estTokens, budgetConfig.perSourceTokens);
    }

    usageEventLog.recordUsageEvent({ carrier: 'wiki', project: project || null, query: String(question).slice(0, 200), hits: sources.length, caller: 'knowledge-qa-api' });
    if (!sources.length) { sendJSON(res, 200, { answer: 'No relevant content found.', sources: [] }); return; }

    // Step 6: Context assembly + LLM generation
    var ctx = sources.map(function(s, i) { return '[' + (i+1) + '] ' + s.title + '\n' + s.content.slice(0, 1200); }).join('\n\n---\n\n');

    if (!apiKey) { sendJSON(res, 200, { answer: 'LLM not configured.', sources: sources.map(function(s) { return { title: s.title }; }) }); return; }

    var prompt = 'You are a knowledgeable assistant. Answer based on references.\n\nReferences:\n' + ctx + '\n\nQuestion: ' + question + '\n\nBe concise. Cite sources like [1], [2]. If not in references, say so.';
    var pd2 = JSON.stringify({ model: route.model || model, messages: [{ role: 'user', content: prompt }], max_tokens: budgetConfig.reserveForAnswer, temperature: 0.5 });
    var opts2 = { hostname: route.host, port: 443, path: route.path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Content-Length': Buffer.byteLength(pd2) } };

    var answer = await new Promise(function(resolve) {
      var r = https.request(opts2, function(resp) { var d = ''; resp.on('data', function(c) { d += c; }); resp.on('end', function() { try { var j = JSON.parse(d); resolve(j.choices[0].message.content); } catch(e) { resolve(d); } }); });
      r.on('error', function() { resolve('LLM request failed.'); }); r.write(pd2); r.end();
    });

    sendJSON(res, 200, {
      answer: answer,
      sources: sources.map(function(s) { return { title: s.title }; }),
      budget: { used: usedBudget, total: budgetConfig.totalTokens, sourcesCount: sources.length, graphExpanded: includeGraph, embeddingsUsed: false },
    });
  } catch(e) { sendJSON(res, 500, { error: e.message }); }
}

// ── Deep Research Handler ──

async function handleQAResearch(req, res) {
  try {
    var body = await parseBody(req);
    var { question, project, model } = body;
    if (!question) { sendJSON(res, 400, { error: 'Missing question' }); return; }

    var wp = project ? getWikiProjectPath(project) : CONFIG.wikiRoot;
    var wikiContext = '';
    // Gather wiki context for the question (manifest → on-demand)
    if (fs.existsSync(wp)) {
      _loadManifest(project || '_global_');
      var ctxResults = wikiManifestQA.search(question, { topK: 3 });
      ctxResults.forEach(function(r) {
        try {
          var content = wikiManifestQA.loadContent(wp, r.id, { maxChars: 2000, stripFrontmatter: true });
          if (content) wikiContext += content.slice(0, 2000) + '\n\n';
        } catch(e) {}
      });
    }

    var route = API_ROUTES[model || DEFAULT_CHAT_MODEL];
    var llmRoute = route ? { host: route.host, path: route.path, apiKey: route.getKey ? route.getKey() : '', model: route.model || model } : null;

    var dr = new DeepResearch({
      searchProvider: body.searchProvider || 'tavily',
      searchApiKey: body.searchApiKey || '',
      llmRoute: llmRoute,
      maxConcurrent: 3,
    });

    var result = await dr.research(question, wikiContext);
    usageEventLog.recordUsageEvent({ carrier: 'wiki', project: project || null, query: String(question).slice(0, 200), hits: wikiContext ? ((ctxResults || []).length || 1) : 0, caller: 'knowledge-qa-research' });

    // Auto-ingest into wiki
    if (project && result.wikiPage) {
      var savePath = path.join(wp, 'syntheses', 'research-' + Date.now() + '.md');
      try {
        if (!fs.existsSync(path.join(wp, 'syntheses'))) fs.mkdirSync(path.join(wp, 'syntheses'), { recursive: true });
        fs.writeFileSync(savePath, result.wikiPage, 'utf-8');
        result.savedTo = savePath;
      } catch(e) { result.saveError = e.message; }
    }

    sendJSON(res, 200, { success: true, result: result });
  } catch(e) { sendJSON(res, 500, { error: e.message }); }
}

// ── Research Topics Only ──

async function handleQAResearchTopics(req, res) {
  try {
    var body = await parseBody(req);
    var { question, project } = body;
    var wp = project ? getWikiProjectPath(project) : CONFIG.wikiRoot;
    var wikiContext = '';
    if (fs.existsSync(wp)) {
      _loadManifest(project || '_global_');
      var ctxResults = wikiManifestQA.search(question, { topK: 2 });
      ctxResults.forEach(function(r) {
        try {
          var content = wikiManifestQA.loadContent(wp, r.id, { maxChars: 1500, stripFrontmatter: true });
          if (content) wikiContext += content.slice(0, 1500);
        } catch(e) {}
      });
    }
    var route = API_ROUTES[DEFAULT_CHAT_MODEL];
    var llmRoute = route ? { host: route.host, path: route.path, apiKey: route.getKey ? route.getKey() : '', model: route.model || DEFAULT_CHAT_MODEL } : null;
    var dr = new DeepResearch({ llmRoute: llmRoute });
    var topics = await dr.generateTopics(question, wikiContext);
    sendJSON(res, 200, { success: true, topics: topics });
  } catch(e) { sendJSON(res, 500, { error: e.message }); }
}

// ── Graph-expanded Search ──

async function handleQAGraphSearch(req, res) {
  try {
    var body = await parseBody(req);
    var { query, project, topK, hops } = body;
    topK = topK || 5;
    hops = hops || 2;

    var wp = project ? getWikiProjectPath(project) : CONFIG.wikiRoot;
    if (!fs.existsSync(wp)) { sendJSON(res, 200, { results: [] }); return; }

    // Manifest 轻量匹配 → 候选种子节点
    _loadManifest(project || '_global_');
    var keywordResults = wikiManifestQA.search(query, { topK: topK });

    // Build graph and expand (按需构建图谱)
    var gd = _getGraphBuilder(project).buildFromWiki(wp);
    if (!gd || !gd.edges || !gd.nodes) { sendJSON(res, 200, { results: keywordResults }); return; }

    var seedIds = keywordResults.slice(0, 3).map(function(r) { return r.id || r.title; });
    var expanded = expandGraph2Hop(seedIds, gd, hops);

    sendJSON(res, 200, {
      success: true,
      seeds: seedIds,
      expanded: expanded,
      results: keywordResults,
      graphStats: { nodes: gd.nodes.length, edges: gd.edges.length },
    });
  } catch(e) { sendJSON(res, 500, { error: e.message }); }
}

// ── Graph list (published graphs from manifests + wiki graphs) ──

var _graphListCache = null;
var _graphListCacheTime = 0;

function handleQAGraphList(req, res) {
  // 缓存30秒（缩短缓存时间以便版本更新后快速生效）
  var now = Date.now();
  if (_graphListCache && (now - _graphListCacheTime) < 30000) {
    return sendJSON(res, 200, { success: true, graphs: _graphListCache });
  }
  var graphsDir = path.join(__dirname, '../data/graphs');
  var wikiDir = path.join(__dirname, '../data/wiki');
  var graphs = [];

  // 1. 扫描已发布的组织图谱（通过 org-graph-manifest.json 定位）
  function scanManifests(dir, depth) {
    if (!fs.existsSync(dir)) return;
    depth = depth || 0;
    if (depth > 4) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
      var fpath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanManifests(fpath, depth + 1);
        return;
      }
      if (entry.name !== 'org-graph-manifest.json') return;
      try {
        var manifest = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
        var assetId = manifest.asset_id || path.basename(path.dirname(fpath));
        var activeVersion = manifest.active_version;
        var versions = manifest.versions || [];
        var manifestDir = path.dirname(fpath);
        // 列出所有版本，每个版本作为一个独立条目
        versions.forEach(function(ver) {
          var graphFilePath = path.join(manifestDir, ver.file);
          if (!fs.existsSync(graphFilePath)) return;
          var relPath = path.relative(graphsDir, graphFilePath).replace(/\\/g, '/');
          var graphId = relPath.replace(/\.json$/, '');
          var stats = ver.stats || {};
          var stat = fs.statSync(graphFilePath);
          var isActive = (ver.version === activeVersion);
          graphs.push({
            id: graphId,
            name: assetId,
            path: graphFilePath,
            nodes: stats.nodes || 0,
            edges: stats.edges || 0,
            sizeKB: Math.round(stat.size / 1024),
            source: 'org',
            version: ver.version,
            publishedAt: ver.published_at || '',
            note: ver.note || '',
            active: isActive ? 1 : 0,
          });
        });
      } catch(e) { /* skip unreadable manifest */ }
    });
  }
  scanManifests(graphsDir);

  // 2. 扫描 wiki 图谱（通过 _wiki_graph.json + _meta/library.json 获取名称）
  if (fs.existsSync(wikiDir)) {
    fs.readdirSync(wikiDir, { withFileTypes: true }).forEach(function(entry) {
      if (!entry.isDirectory()) return;
      var graphFile = path.join(wikiDir, entry.name, '_wiki_graph.json');
      if (!fs.existsSync(graphFile)) return;
      // 读取 wiki 名称
      var wikiName = entry.name;
      var libFile = path.join(wikiDir, entry.name, '_meta', 'library.json');
      if (fs.existsSync(libFile)) {
        try {
          var lib = JSON.parse(fs.readFileSync(libFile, 'utf-8'));
          if (lib.name) wikiName = lib.name;
        } catch(e) { /* use dir name */ }
      }
      // 读取图谱统计信息
      var nodeCount = 0, edgeCount = 0, sizeKB = 0;
      try {
        var stat = fs.statSync(graphFile);
        sizeKB = Math.round(stat.size / 1024);
        var data = JSON.parse(fs.readFileSync(graphFile, 'utf-8'));
        if (Array.isArray(data.nodes)) nodeCount = data.nodes.length;
        if (Array.isArray(data.edges) || Array.isArray(data.links)) edgeCount = (data.edges || data.links || []).length;
      } catch(e) { /* skip */ }
      // graphId 相对于 wiki/，供 handleQAGraphQuery 定位
      graphs.push({
        id: entry.name + '/_wiki_graph',
        name: wikiName,
        path: graphFile,
        nodes: nodeCount,
        edges: edgeCount,
        sizeKB: sizeKB,
        source: 'wiki',
      });
    });
  }

  _graphListCache = graphs;
  _graphListCacheTime = now;
  sendJSON(res, 200, { success: true, graphs: graphs });
}

// ── Graph query (intent-aware search + edge-property traversal + subgraph) ──

async function handleQAGraphQuery(req, res) {
  try {
    var body = await parseBody(req);
    var { query, graphId, topK, hops, prevContext } = body;
    topK = topK || 5;
    hops = hops || 2;

    if (!query) { sendJSON(res, 400, { error: 'Missing query' }); return; }
    if (!graphId) { sendJSON(res, 400, { error: 'Missing graphId' }); return; }

    // Locate graph file
    var graphPath = null;
    var candidates = [
      path.join(__dirname, '../data/graphs', graphId + '.json'),
      path.join(__dirname, '../data/wiki', graphId + '.json'),
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (fs.existsSync(candidates[i])) { graphPath = candidates[i]; break; }
    }
    if (!graphPath) { sendJSON(res, 404, { error: 'Graph not found: ' + graphId }); return; }

    var raw = fs.readFileSync(graphPath, 'utf-8');
    var graphData = JSON.parse(raw);
    var nodes = graphData.nodes || graphData.vertices || [];
    var edges = graphData.edges || graphData.links || graphData.relations || [];

    // ── Helper functions ──
    function nodeLabel(n) {
      return String((n.properties && (n.properties.name || n.properties.label)) || n.label || n.name || n.title || n.id || '');
    }
    function nodeSearchText(n) {
      var parts = [nodeLabel(n)];
      var alias = (n.properties && n.properties.alias) || n.alias;
      if (Array.isArray(alias)) alias.forEach(function(a) { if (a) parts.push(String(a)); });
      if (n.type) parts.push(String(n.type));
      var props = n.properties || n;
      if (props && typeof props === 'object') {
        Object.keys(props).forEach(function(k) {
          if (k === 'alias' || k === 'name' || k === 'label') return;
          var v = props[k];
          if (typeof v === 'string' && v) parts.push(v);
        });
      }
      return parts.join(' ').toLowerCase();
    }
    function nodeDesc(n) {
      var descFields = ['description', 'summary', 'desc', 'content', 'DUTY_LEVEL_INFO', 'DUTY_TITLE', 'LABEL_INFO', 'LABEL_INFO_RETIRE'];
      var parts = [];
      descFields.forEach(function(f) {
        var v = (n.properties && n.properties[f]) || n[f];
        if (v) parts.push(String(v));
      });
      return parts.join(', ');
    }

    // ── 构建节点索引和类型邻接表 ──
    var nodeMap = {};
    nodes.forEach(function(n) { nodeMap[String(n.id)] = n; });

    // typedAdj[nodeId][edgeType] = [{ target, edge, reverse }]
    var typedAdj = {};
    edges.forEach(function(e) {
      var s = String(e.source || e.from || e.start || '');
      var t = String(e.target || e.to || e.end || '');
      var etype = e.type || 'UNKNOWN';
      if (!typedAdj[s]) typedAdj[s] = {};
      if (!typedAdj[s][etype]) typedAdj[s][etype] = [];
      typedAdj[s][etype].push({ target: t, edge: e, reverse: false });
      if (!typedAdj[t]) typedAdj[t] = {};
      if (!typedAdj[t][etype]) typedAdj[t][etype] = [];
      typedAdj[t][etype].push({ target: s, edge: e, reverse: true });
    });

    // ── 查询意图识别 ──
    var qLower = query.toLowerCase();
    var intent = { type: 'GENERAL', targets: [] };

    // 代词解析：如果查询包含"他/她/其"等代词，从图谱中匹配上一轮回答出现的人名
    var resolvedQuery = query;
    if (prevContext && /(他|她|其|这个人|这个人|该人)/.test(query)) {
      // 从图谱 PERSON_INFO_V 节点中查找出现在上一轮回答里的人名
      var personNames = [];
      nodes.forEach(function(n) {
        if (n.type === 'PERSON_INFO_V') {
          var name = nodeLabel(n);
          if (name.length >= 2 && prevContext.indexOf(name) >= 0) {
            personNames.push(name);
          }
        }
      });
      // 用提取到的人名替换代词（取第一个匹配的）
      if (personNames.length > 0) {
        resolvedQuery = query.replace(/(他|她|其|这个人|该人)/g, personNames[0]);
      }
    }

    // 汇报关系：向他汇报/他的下属/谁向他汇报/直接汇报
    if (/(汇报|向.*汇报|他的下属|他的上级|跟他.*汇报|向他.*汇报|谁向他|直接.*汇报|汇报线)/.test(query)) {
      intent.type = 'REPORT_QUERY';
    }
    // 班子成员/领导班子/班子成员/管理层 → 找组织的管理团队
    else if (/(班子成员|领导班子|管理层|管理团队|高管团队)/.test(query)) {
      intent.type = 'TEAM_MEMBER_QUERY';
    }
    // 下属/子部门/下辖/有哪些部门/有几个部门/小组 → 找下级组织
    else if (/(下属|子部门|下辖|有哪些部门|有几个部门|有几个小组|小组|分支|下级)/.test(query)) {
      intent.type = 'SUBORDINATE_QUERY';
    }
    // 上级/上级部门/归属/属于/归谁管 → 找上级组织
    else if (/(上级|上级部门|归属|属于|归谁管|谁管辖)/.test(query)) {
      intent.type = 'SUPERIOR_QUERY';
    }
    // 一把手/负责人/领导/主管/主任 → 找组织的负责人
    else if (/(一把手|负责人|领导|主管|主任|是谁|谁管|谁负责)/.test(query)) {
      intent.type = 'HEAD_QUERY';
    }
    // 职务/职位/什么级别/职级/做什么的 → 找人员职务
    else if (/(职务|职位|什么级别|职级|做什么的|什么岗位|担任)/.test(query)) {
      intent.type = 'DUTY_QUERY';
    }
    // 有哪些人/团队/人员/员工/多少人 → 找组织下的人员
    else if (/(有哪些人|团队|人员|员工|多少人|人名|都有谁|有哪些)/.test(query)) {
      intent.type = 'TEAM_QUERY';
    }
    // 退休/年龄/职级/干部 → 属性过滤
    else if (/(退休|离退休|几岁|年龄|岁|总行总经理级|正处级|副处级|正科级|副科级|处级|科级|干部|标签)/.test(query)) {
      intent.type = 'ATTRIBUTE_QUERY';
    }
    // 组织架构/结构/层级/架构 → 找组织树
    else if (/(组织架构|组织结构|层级|架构|架构图)/.test(query)) {
      intent.type = 'ORG_STRUCTURE_QUERY';
    }

    // ── 关键词搜索：找到种子节点（使用解析后的查询）──
    var qLower = resolvedQuery.toLowerCase();
    var stopChars = '的是谁哪什么吗呢了在有个人这那都把给被让从到对于关于以及和与或而且但';
    function stripStop(s) { return s.replace(new RegExp('[' + stopChars + ']', 'g'), ''); }
    // 去除意图关键词，保留实体关键词
    var intentKeywords = '一把手负责人领导主管主任下属子部门下辖分支下级上级归属属于谁管辖职务职位级别职级做岗位有哪些人团队人员员工多少名都谁组织架构结构层级架构图汇报线班子成员领导班子管理层管理团队高管退休离退休几岁年龄向他跟直接班子总行总经理正副处科级干部标签小组组长展开层';
    var qStripped = qLower.replace(new RegExp('[' + intentKeywords + ']', 'g'), '');
    qStripped = stripStop(qStripped);
    // 滑动窗口关键词
    var qTokens = [];
    for (var len = Math.min(qStripped.length, 6); len >= 2; len--) {
      for (var i = 0; i <= qStripped.length - len; i++) {
        qTokens.push(qStripped.slice(i, i + len));
      }
    }
    qTokens = Array.from(new Set(qTokens));

    var scoredNodes = [];
    nodes.forEach(function(n, idx) {
      var label = nodeLabel(n).toLowerCase();
      var searchText = nodeSearchText(n);
      var score = 0;
      // 反向匹配：节点的标签/别名出现在查询中
      var nodeTerms = [label];
      var alias = (n.properties && n.properties.alias) || n.alias;
      if (Array.isArray(alias)) alias.forEach(function(a) { if (a) nodeTerms.push(String(a).toLowerCase()); });
      var props = n.properties || n;
      if (props && typeof props === 'object') {
        ['name', 'DUTY_TITLE', 'DUTY_LEVEL_INFO', 'LABEL_INFO'].forEach(function(k) {
          if (props[k] && typeof props[k] === 'string') nodeTerms.push(props[k].toLowerCase());
        });
      }
      nodeTerms.forEach(function(term) {
        if (term.length >= 2 && qLower.indexOf(term) >= 0) score += Math.max(3, term.length);
      });
      // 滑动窗口匹配
      qTokens.forEach(function(t) {
        if (label.indexOf(t) >= 0) score += 2;
        if (searchText.indexOf(t) >= 0) score += 1;
      });
      if (score > 0) scoredNodes.push({ node: n, index: idx, score: score });
    });
    scoredNodes.sort(function(a, b) { return b.score - a.score; });
    scoredNodes = scoredNodes.slice(0, topK);

    // 如果没有找到种子节点，但有上一轮上下文，从上下文中提取实体作为种子
    if (scoredNodes.length === 0 && prevContext) {
      nodes.forEach(function(n, idx) {
        var label = nodeLabel(n);
        if (label.length >= 2 && prevContext.indexOf(label) >= 0) {
          scoredNodes.push({ node: n, index: idx, score: label.length });
        }
      });
      scoredNodes.sort(function(a, b) { return b.score - a.score; });
      scoredNodes = scoredNodes.slice(0, topK);
      // 当从上下文提取种子时，使用GENERAL意图做BFS展开
      if (intent.type === 'GENERAL' && /(展开|扩展|更多|详细)/.test(query)) {
        hops = Math.max(hops, 3); // 展开时增加跳数
      }
    }

    var seedIds = scoredNodes.map(function(sn) {
      return String(sn.node.id || sn.node.label || sn.node.name || sn.index);
    });

    // ── 意图驱动的边遍历：精准提取答案节点和关系 ──
    var answerNodes = {};  // id → node
    var answerEdges = [];  // edges
    var relationParts = []; // 关系描述文本

    function addAnswerNode(nodeId) {
      var n = nodeMap[nodeId];
      if (n) { answerNodes[nodeId] = n; return true; }
      return false;
    }

    if (seedIds.length > 0) {
      var primarySeed = seedIds[0];
      var seedNode = nodeMap[primarySeed];
      var seedType = seedNode ? (seedNode.type || '') : '';

      if (intent.type === 'HEAD_QUERY' && seedType === 'CDPCHE_STRU_V') {
        // 找组织的负责人：SERVE_STRU_E(IF_PRESIDE_WORK=1) + TEAMWORK_E(WORK_CONTENT含"主持")
        addAnswerNode(primarySeed);
        var serveEdges = (typedAdj[primarySeed] && typedAdj[primarySeed]['SERVE_STRU_E']) || [];
        serveEdges.forEach(function(nb) {
          if (!nb.reverse) return; // SERVE_STRU_E是person→org，org端是reverse
          var prop = nb.edge.properties || {};
          if (prop.IF_PRESIDE_WORK === '1') {
            if (addAnswerNode(nb.target)) {
              var person = nodeMap[nb.target];
              relationParts.push(nodeLabel(person) + ' → 任职于 ' + nodeLabel(seedNode) +
                '（主持工作，任职时间：' + (prop.POST_TIME || '未知') + '，任职' + (prop.POST_YEARS || '?') + '年）');
              answerEdges.push(nb.edge);
            }
          }
        });
        var teamworkEdges = (typedAdj[primarySeed] && typedAdj[primarySeed]['TEAMWORK_E']) || [];
        teamworkEdges.forEach(function(nb) {
          if (nb.reverse) return; // TEAMWORK_E是org→person，org端是forward
          var wc = (nb.edge.properties && nb.edge.properties.WORK_CONTENT) || '';
          if (wc.indexOf('主持') >= 0 || wc.indexOf('负责') >= 0) {
            if (addAnswerNode(nb.target)) {
              var person = nodeMap[nb.target];
              relationParts.push(nodeLabel(person) + ' → 在 ' + nodeLabel(seedNode) + ' 负责「' + wc + '」');
              answerEdges.push(nb.edge);
            }
          }
        });
        // 也查找该组织下人员的职务信息
        var dutyEdges = (typedAdj[primarySeed] && typedAdj[primarySeed]['WORKING_STRU_E']) || [];
        dutyEdges.forEach(function(nb) {
          if (!nb.reverse) return; // WORKING_STRU_E是person→org，org端是reverse
          var personId = nb.target;
          // 查找该人员的职务
          var personDutyEdges = (typedAdj[personId] && typedAdj[personId]['PERSON_DUTY_E']) || [];
          personDutyEdges.forEach(function(dnb) {
            if (dnb.reverse) return;
            var dutyNode = nodeMap[dnb.target];
            if (dutyNode && dutyNode.type === 'DUTY_V') {
              var dprop = dnb.edge.properties || {};
              // 只关联到当前组织的职务
              if (dprop.STRU_ID && seedNode.properties && seedNode.properties.STRU_ID === dprop.STRU_ID) {
                if (addAnswerNode(dnb.target)) {
                  relationParts.push(nodeLabel(nodeMap[personId]) + ' → 担任 ' + nodeLabel(dutyNode) +
                    '（关联组织：' + nodeLabel(seedNode) + '）');
                  answerEdges.push(dnb.edge);
                }
              }
            }
          });
        });
      }
      else if (intent.type === 'SUBORDINATE_QUERY' && seedType === 'CDPCHE_STRU_V') {
        // 找下级组织：SUP_STRU_E(source=上级 → target=下级)
        var needLeaders = /组长/.test(query);
        addAnswerNode(primarySeed);
        var subEdges = (typedAdj[primarySeed] && typedAdj[primarySeed]['SUP_STRU_E']) || [];
        subEdges.forEach(function(nb) {
          if (nb.reverse) return; // 只要 source=seed 方向（seed是上级）
          if (addAnswerNode(nb.target)) {
            var child = nodeMap[nb.target];
            relationParts.push(nodeLabel(child) + ' → 隶属于 ' + nodeLabel(seedNode) +
              '（人员：' + ((child.properties && child.properties.PERSON_NUM) || '?') + '人）');
            answerEdges.push(nb.edge);

            // 如果查询包含"组长"，对每个下属组织查找其负责人
            if (needLeaders) {
              var subOrgId = nb.target;
              // TEAMWORK_E(org→person)：org端是forward
              var tEdges2 = (typedAdj[subOrgId] && typedAdj[subOrgId]['TEAMWORK_E']) || [];
              tEdges2.forEach(function(tnb) {
                if (tnb.reverse) return;
                if (addAnswerNode(tnb.target)) {
                  var leader = nodeMap[tnb.target];
                  var wc = (tnb.edge.properties && tnb.edge.properties.WORK_CONTENT) || '分工';
                  relationParts.push(nodeLabel(leader) + ' → 在 ' + nodeLabel(child) + ' 担任组长（' + wc + '）');
                  answerEdges.push(tnb.edge);
                }
              });
              // SERVE_STRU_E(person→org)：org端是reverse，只找主持工作的
              var sEdges3 = (typedAdj[subOrgId] && typedAdj[subOrgId]['SERVE_STRU_E']) || [];
              sEdges3.forEach(function(snb) {
                if (!snb.reverse) return;
                var sprop2 = snb.edge.properties || {};
                if (sprop2.IF_PRESIDE_WORK !== '1') return; // 只找主持工作的
                if (addAnswerNode(snb.target)) {
                  var leader2 = nodeMap[snb.target];
                  relationParts.push(nodeLabel(leader2) + ' → 任职于 ' + nodeLabel(child) +
                    '（' + (sprop2.WORK_CONTENT || '组长') + '）');
                  answerEdges.push(snb.edge);
                }
              });
            }
          }
        });
      }
      else if (intent.type === 'SUPERIOR_QUERY' && seedType === 'CDPCHE_STRU_V') {
        // 找上级组织
        addAnswerNode(primarySeed);
        var supStruId = seedNode.properties && seedNode.properties.SUP_STRU;
        if (supStruId) {
          nodes.forEach(function(n) {
            if (n.type === 'CDPCHE_STRU_V' && n.properties && n.properties.STRU_ID === supStruId) {
              if (addAnswerNode(String(n.id))) {
                relationParts.push(nodeLabel(seedNode) + ' → 上级组织为 ' + nodeLabel(n) +
                  '（上级STRU_ID：' + supStruId + '）');
              }
            }
          });
        }
      }
      else if (intent.type === 'DUTY_QUERY' && seedType === 'PERSON_INFO_V') {
        // 找人员的职务：PERSON_DUTY_E(person→duty)
        addAnswerNode(primarySeed);
        var pdEdges = (typedAdj[primarySeed] && typedAdj[primarySeed]['PERSON_DUTY_E']) || [];
        pdEdges.forEach(function(nb) {
          if (nb.reverse) return;
          if (addAnswerNode(nb.target)) {
            var duty = nodeMap[nb.target];
            var dprop = nb.edge.properties || {};
            // 查找关联组织
            var orgName = '';
            if (dprop.STRU_ID) {
              nodes.forEach(function(n) {
                if (n.type === 'CDPCHE_STRU_V' && n.properties && n.properties.STRU_ID === dprop.STRU_ID) {
                  orgName = nodeLabel(n);
                }
              });
            }
            relationParts.push(nodeLabel(seedNode) + ' → 担任 ' + nodeLabel(duty) +
              (orgName ? '（所属组织：' + orgName + '）' : ''));
            answerEdges.push(nb.edge);
          }
        });
      }
      else if (intent.type === 'TEAM_QUERY' && seedType === 'CDPCHE_STRU_V') {
        // 找组织下的人员：WORKING_STRU_E(person→org) + TEAMWORK_E(org→person) + SERVE_STRU_E(person→org)
        addAnswerNode(primarySeed);
        var wEdges = (typedAdj[primarySeed] && typedAdj[primarySeed]['WORKING_STRU_E']) || [];
        wEdges.forEach(function(nb) {
          if (!nb.reverse) return; // WORKING_STRU_E是person→org，org端是reverse
          if (addAnswerNode(nb.target)) {
            var person = nodeMap[nb.target];
            var pprop = person.properties || {};
            relationParts.push(nodeLabel(person) + ' → 在职于 ' + nodeLabel(seedNode) +
              '（职级：' + (pprop.DUTY_LEVEL_INFO || '未知') + '）');
            answerEdges.push(nb.edge);
          }
        });
        var sEdges2 = (typedAdj[primarySeed] && typedAdj[primarySeed]['SERVE_STRU_E']) || [];
        sEdges2.forEach(function(nb) {
          if (!nb.reverse) return; // SERVE_STRU_E是person→org，org端是reverse
          if (addAnswerNode(nb.target)) {
            var person = nodeMap[nb.target];
            var sprop = nb.edge.properties || {};
            relationParts.push(nodeLabel(person) + ' → 任职于 ' + nodeLabel(seedNode) +
              (sprop.IF_PRESIDE_WORK === '1' ? '（主持工作）' : ''));
            answerEdges.push(nb.edge);
          }
        });
        var tEdges = (typedAdj[primarySeed] && typedAdj[primarySeed]['TEAMWORK_E']) || [];
        tEdges.forEach(function(nb) {
          if (nb.reverse) return; // TEAMWORK_E是org→person，org端是forward
          if (addAnswerNode(nb.target)) {
            var person = nodeMap[nb.target];
            var wc = (nb.edge.properties && nb.edge.properties.WORK_CONTENT) || '';
            relationParts.push(nodeLabel(person) + ' → 在 ' + nodeLabel(seedNode) + ' 负责「' + wc + '」');
            answerEdges.push(nb.edge);
          }
        });
      }
      else if (intent.type === 'ORG_STRUCTURE_QUERY' && seedType === 'CDPCHE_STRU_V') {
        // 找组织层级：上级 + 下级
        addAnswerNode(primarySeed);
        var sSupStruId = seedNode.properties && seedNode.properties.SUP_STRU;
        // 上级
        if (sSupStruId) {
          nodes.forEach(function(n) {
            if (n.type === 'CDPCHE_STRU_V' && n.properties && n.properties.STRU_ID === sSupStruId) {
              if (addAnswerNode(String(n.id))) {
                relationParts.push('↑ 上级：' + nodeLabel(n));
              }
            }
          });
        }
        // 下级：SUP_STRU_E(source=上级 → target=下级)
        var subEdges2 = (typedAdj[primarySeed] && typedAdj[primarySeed]['SUP_STRU_E']) || [];
        subEdges2.forEach(function(nb) {
          if (nb.reverse) return;
          if (addAnswerNode(nb.target)) {
            var child = nodeMap[nb.target];
            relationParts.push('↓ 下级：' + nodeLabel(child) +
              '（' + ((child.properties && child.properties.PERSON_NUM) || '?') + '人）');
            answerEdges.push(nb.edge);
          }
        });
      }
      // ── 汇报关系查询：PERSON_REL_E 边 ──
      else if (intent.type === 'REPORT_QUERY') {
        // 种子节点可能是人员（向他汇报的人）或组织
        if (seedType === 'PERSON_INFO_V') {
          addAnswerNode(primarySeed);
          // 找向此人汇报的人（PERSON_REL_E: source=下属 → target=上级）
          var relEdges = (typedAdj[primarySeed] && typedAdj[primarySeed]['PERSON_REL_E']) || [];
          relEdges.forEach(function(nb) {
            var prop = nb.edge.properties || {};
            // 如果 seed 是 target（上级），则 source 是向他汇报的人
            if (nb.reverse) {
              // nb.target 是 source（下属），seed 是 target（上级）
              if (addAnswerNode(nb.target)) {
                var person = nodeMap[nb.target];
                relationParts.push(nodeLabel(person) + ' → 向 ' + nodeLabel(seedNode) + ' 汇报' +
                  (prop.RELATION_TYPE ? '（' + prop.RELATION_TYPE + '）' : ''));
                answerEdges.push(nb.edge);
              }
            } else {
              // nb.target 是 target（上级），seed 是 source（下属）
              // 即 seed 向 target 汇报 → 找 seed 的上级
              if (addAnswerNode(nb.target)) {
                var boss = nodeMap[nb.target];
                relationParts.push(nodeLabel(seedNode) + ' → 向 ' + nodeLabel(boss) + ' 汇报' +
                  (prop.RELATION_TYPE ? '（' + prop.RELATION_TYPE + '）' : ''));
                answerEdges.push(nb.edge);
              }
            }
          });
          // 也查找此人所在组织的负责人
          var serveEdges2 = (typedAdj[primarySeed] && typedAdj[primarySeed]['SERVE_STRU_E']) || [];
          serveEdges2.forEach(function(nb) {
            if (!nb.reverse) {
              var sprop = nb.edge.properties || {};
              if (sprop.IF_PRESIDE_WORK === '1') {
                if (addAnswerNode(nb.target)) {
                  var org = nodeMap[nb.target];
                  relationParts.push(nodeLabel(seedNode) + ' → 在 ' + nodeLabel(org) + ' 主持工作');
                  answerEdges.push(nb.edge);
                }
              }
            }
          });
        }
        else if (seedType === 'CDPCHE_STRU_V') {
          // 找组织内所有人的汇报关系
          addAnswerNode(primarySeed);
          var wEdges2 = (typedAdj[primarySeed] && typedAdj[primarySeed]['WORKING_STRU_E']) || [];
          var orgPersons = [];
          wEdges2.forEach(function(nb) {
            if (!nb.reverse) orgPersons.push(nb.target);
          });
          orgPersons.forEach(function(pid) {
            addAnswerNode(pid);
            var relEdges2 = (typedAdj[pid] && typedAdj[pid]['PERSON_REL_E']) || [];
            relEdges2.forEach(function(nb) {
              if (!nb.reverse && orgPersons.indexOf(nb.target) >= 0) {
                if (addAnswerNode(nb.target)) {
                  var prop = nb.edge.properties || {};
                  relationParts.push(nodeLabel(nodeMap[pid]) + ' → 向 ' + nodeLabel(nodeMap[nb.target]) + ' 汇报' +
                    (prop.RELATION_TYPE ? '（' + prop.RELATION_TYPE + '）' : ''));
                  answerEdges.push(nb.edge);
                }
              }
            });
          });
        }
      }
      // ── 班子成员查询：TEAMWORK_E 边 ──
      else if (intent.type === 'TEAM_MEMBER_QUERY' && seedType === 'CDPCHE_STRU_V') {
        addAnswerNode(primarySeed);
        var twEdges = (typedAdj[primarySeed] && typedAdj[primarySeed]['TEAMWORK_E']) || [];
        twEdges.forEach(function(nb) {
          if (nb.reverse) return;
          if (addAnswerNode(nb.target)) {
            var person = nodeMap[nb.target];
            var wc = (nb.edge.properties && nb.edge.properties.WORK_CONTENT) || '';
            var pprop = person.properties || {};
            relationParts.push(nodeLabel(person) + ' → 班子成员（负责「' + wc + '」，职级：' +
              (pprop.DUTY_LEVEL_INFO || '未知') + '）');
            answerEdges.push(nb.edge);
          }
        });
      }
      // ── 属性查询：退休/年龄/职级过滤 ──
      else if (intent.type === 'ATTRIBUTE_QUERY') {
        // 解析过滤条件
        var levelMatch = query.match(/(总行总经理级|正处级|副处级|正科级|副科级|处级|科级)/);
        var targetLevel = levelMatch ? levelMatch[1] : '';
        var isRetireQuery = /(退休|离退休)/.test(query);
        var retireYearMatch = query.match(/(\d+)\s*年/);
        var retireYears = retireYearMatch ? parseInt(retireYearMatch[1]) : 0;

        // 如果种子是组织，找组织下的人员并按属性过滤
        if (seedType === 'CDPCHE_STRU_V') {
          addAnswerNode(primarySeed);
          // 收集组织关联的所有人员（WORKING_STRU_E + TEAMWORK_E + SERVE_STRU_E）
          var orgPersonIds = {};
          ['WORKING_STRU_E', 'TEAMWORK_E', 'SERVE_STRU_E'].forEach(function(edgeType) {
            var eList = (typedAdj[primarySeed] && typedAdj[primarySeed][edgeType]) || [];
            eList.forEach(function(nb) {
              // WORKING_STRU_E/SERVE_STRU_E是person→org（reverse=true），TEAMWORK_E是org→person（reverse=false）
              if (edgeType === 'TEAMWORK_E' && nb.reverse) return;
              if (edgeType !== 'TEAMWORK_E' && !nb.reverse) return;
              orgPersonIds[nb.target] = true;
            });
          });
          Object.keys(orgPersonIds).forEach(function(pid) {
            var person = nodeMap[pid];
            if (!person) return;
            var pprop = person.properties || {};
            var labelInfo = pprop.LABEL_INFO || '';
            var labelRetire = pprop.LABEL_INFO_RETIRE || '';
            var dutyLevel = pprop.DUTY_LEVEL_INFO || '';
            var matched = false;
            var matchDesc = '';

            // 按职级过滤
            if (targetLevel && dutyLevel.indexOf(targetLevel) >= 0) {
              matched = true;
              matchDesc = '职级：' + dutyLevel;
            }
            // 按退休过滤
            else if (isRetireQuery && labelRetire) {
              if (retireYears > 0) {
                // 检查退休年数是否符合条件（如"不足3年"→ <=3）
                var labelYearMatch = labelRetire.match(/(\d+)\s*年/);
                if (labelYearMatch && parseInt(labelYearMatch[1]) <= retireYears) {
                  matched = true;
                  matchDesc = labelRetire;
                }
              } else if (labelRetire.indexOf('退休') >= 0) {
                matched = true;
                matchDesc = labelRetire;
              }
            }
            // 无特定过滤，展示所有人员的属性
            else if (!targetLevel && !isRetireQuery) {
              matched = true;
              matchDesc = '标签：' + (labelInfo || '无') + '，退休：' + (labelRetire || '未知');
            }

            if (matched) {
              if (addAnswerNode(pid)) {
                relationParts.push(nodeLabel(person) + ' → ' + matchDesc +
                  '（职级：' + dutyLevel + '）');
              }
            }
          });
        }
        // 如果种子是人员，直接展示属性
        else if (seedType === 'PERSON_INFO_V') {
          addAnswerNode(primarySeed);
          var sProp = seedNode.properties || {};
          relationParts.push(nodeLabel(seedNode) + ' → 职级：' + (sProp.DUTY_LEVEL_INFO || '未知') +
            '，标签：' + (sProp.LABEL_INFO || '无') +
            '，退休：' + (sProp.LABEL_INFO_RETIRE || '未知'));
        }
      }
    }

    // ── 构建 BFS 子图（作为补充上下文）──
    var adj = {};
    edges.forEach(function(e) {
      var s = String(e.source || e.from || e.start || '').toLowerCase();
      var t = String(e.target || e.to || e.end || '').toLowerCase();
      if (!adj[s]) adj[s] = []; if (!adj[t]) adj[t] = [];
      adj[s].push({ target: t, edge: e }); adj[t].push({ target: s, edge: e });
    });

    var visited = {};
    var subNodes = {};
    var subEdges = [];
    seedIds.forEach(function(id) { visited[id.toLowerCase()] = 0; });
    var queue = seedIds.map(function(id) { return id.toLowerCase(); });

    while (queue.length) {
      var curr = queue.shift();
      var dist = visited[curr] || 0;
      var nodeData = nodes.find(function(n) { return String(n.id || '').toLowerCase() === curr; });
      if (nodeData && !subNodes[curr]) {
        subNodes[curr] = { id: curr, label: nodeLabel(nodeData), type: nodeData.type || '', dist: dist };
      }
      if (dist >= hops) continue;
      var neighbors = adj[curr] || [];
      for (var j = 0; j < neighbors.length; j++) {
        var nb = neighbors[j];
        if (visited[nb.target] === undefined) {
          visited[nb.target] = dist + 1;
          queue.push(nb.target);
          subEdges.push(nb.edge);
        }
      }
    }

    // ── 生成上下文：优先关系推理结果，补充BFS节点详情 ──
    var contextParts = [];

    // 1. 关系推理结果（核心答案）
    if (relationParts.length > 0) {
      contextParts.push('【关系推理结果】');
      contextParts.push(relationParts.join('\n'));
    }

    // 2. 意图答案节点详情
    var answerNodeList = Object.values(answerNodes);
    if (answerNodeList.length > 0) {
      contextParts.push('\n【关键节点详情】');
      answerNodeList.forEach(function(n) {
        var label = nodeLabel(n);
        var nodeType = n.type || '';
        var propParts = [];
        if (n.properties) {
          var skipKeys = ['VERTEX_ID', 'PERSON_ID', 'SSIC_ID', 'EDGE_ID', 'SOURCE_ID', 'TARGET_ID', 'alias'];
          Object.keys(n.properties).forEach(function(k) {
            if (skipKeys.indexOf(k) >= 0) return;
            var v = n.properties[k];
            if (typeof v === 'string' && v && v !== label) propParts.push(k + '=' + v);
          });
        }
        var ctx = label;
        if (nodeType) ctx += ' [' + nodeType + ']';
        if (propParts.length > 0) ctx += ' (' + propParts.join(', ') + ')';
        contextParts.push(ctx);
      });
    }

    // 3. BFS补充上下文（限制数量，避免过多噪音）
    var subNodeList = Object.values(subNodes);
    var bfsAdded = 0;
    var maxBfsNodes = 20;
    subNodeList.forEach(function(sn) {
      if (answerNodes[sn.id]) return; // 已在答案节点中
      if (bfsAdded >= maxBfsNodes) return;
      var fullNode = nodes.find(function(n) { return String(n.id || '').toLowerCase() === sn.id; });
      if (!fullNode) return;
      var label = nodeLabel(fullNode);
      var nodeType = fullNode.type || '';
      var desc = nodeDesc(fullNode);
      var ctx = label;
      if (nodeType) ctx += ' [' + nodeType + ']';
      if (desc) ctx += ': ' + desc;
      contextParts.push(ctx);
      bfsAdded++;
    });

    // 合并答案边和BFS边（去重）
    var allEdges = answerEdges.slice();
    subEdges.forEach(function(e) {
      var exists = allEdges.some(function(ae) {
        return (ae.source === e.source && ae.target === e.target && ae.type === e.type);
      });
      if (!exists) allEdges.push(e);
    });

    // 合并答案节点和BFS节点
    var allSubNodes = {};
    answerNodeList.forEach(function(n) {
      var id = String(n.id).toLowerCase();
      allSubNodes[id] = { id: id, label: nodeLabel(n), type: n.type || '', dist: 0 };
    });
    subNodeList.forEach(function(sn) {
      if (!allSubNodes[sn.id]) allSubNodes[sn.id] = sn;
    });
    var finalNodeList = Object.values(allSubNodes);

    usageEventLog.recordUsageEvent({ carrier: 'graph', graphId: graphId || null, query: String(query).slice(0, 200), hits: finalNodeList.length, caller: 'graph-query' });
    sendJSON(res, 200, {
      success: true,
      query: query,
      intent: intent.type,
      seeds: scoredNodes.map(function(sn) {
        return { id: String(sn.node.id || ''), label: nodeLabel(sn.node), score: sn.score };
      }),
      relations: relationParts,
      subgraph: { nodes: finalNodeList, edges: allEdges },
      context: contextParts.join('\n'),
      stats: {
        totalNodes: nodes.length, totalEdges: edges.length,
        subNodes: finalNodeList.length, subEdges: allEdges.length,
        answerNodes: answerNodeList.length, answerEdges: answerEdges.length,
      },
    });
  } catch(e) { sendJSON(res, 500, { error: e.message }); }
}

// ── Graph 2-hop expansion ──

function expandGraph2Hop(seedIds, graphData, maxHops) {
  maxHops = maxHops || 2;
  var adj = {};
  (graphData.edges || []).forEach(function(e) {
    var s = String(e.source || e.from || ''), t = String(e.target || e.to || '');
    if (!adj[s]) adj[s] = []; if (!adj[t]) adj[t] = [];
    adj[s].push(t); adj[t].push(s);
  });

  var visited = {};
  seedIds.forEach(function(id) { visited[id] = 0; });
  var queue = seedIds.slice();
  var expanded = [];

  while (queue.length) {
    var current = queue.shift();
    var dist = visited[current] || 0;
    if (dist > 0 && expanded.indexOf(current) === -1) expanded.push(current);
    if (dist >= maxHops) continue;
    var neighbors = adj[current] || [];
    for (var i = 0; i < neighbors.length; i++) {
      var nb = neighbors[i];
      if (visited[nb] === undefined) { visited[nb] = dist + 1; queue.push(nb); }
    }
  }

  return expanded;
}

// ── GraphRAG Handler (community summaries + subgraph + vector → LLM) ──

async function handleGraphRAGQuery(req, res) {
  try {
    var body = await parseBody(req);
    var { question, project, model, topK } = body;
    topK = topK || 5;
    model = model || DEFAULT_CHAT_MODEL;

    var route = API_ROUTES[model] || API_ROUTES[DEFAULT_CHAT_MODEL];
    var apiKey = route && route.getKey ? route.getKey() : null;
    if (!apiKey) { sendJSON(res, 500, { error: 'LLM not configured' }); return; }

    var wp = project ? getWikiProjectPath(project) : CONFIG.wikiRoot;

    // 1. Load graph data
    var fusedFile = path.join(wp, '.graph-fused.json');
    if (!fs.existsSync(fusedFile)) fusedFile = path.join(wp, '.graph-extracted.json');
    var commFile = path.join(wp, '.graph-communities.json');
    var ragFile = path.join(wp, '.rag-cache.json');

    // 2. Community context (Global Query)
    var communityContext = '';
    if (fs.existsSync(commFile)) {
      var commData = JSON.parse(fs.readFileSync(commFile, 'utf-8'));
      var comms = commData.communities || commData || [];
      communityContext = comms.slice(0, 5).map(function(c) {
        return '## ' + (c.summary || 'Community') + '\n节点数: ' + (c.size||0) + ' | 内聚度: ' + (c.cohesion||0).toFixed(2);
      }).join('\n\n');
    }

    // 3. Subgraph context (Local Query)
    var subgraphContext = '';
    if (fs.existsSync(fusedFile)) {
      var graph = JSON.parse(fs.readFileSync(fusedFile, 'utf-8'));
      var qLower = question.toLowerCase();
      var tokens = qLower.split(/\s+/).filter(function(t) { return t.length > 2; });
      var scored = graph.nodes.map(function(n) {
        var label = (n.label || '').toLowerCase();
        var desc = (n.description || '').toLowerCase();
        var score = 0;
        tokens.forEach(function(t) { if (label.indexOf(t) >= 0) score += 5; if (desc.indexOf(t) >= 0) score += 2; });
        return { node: n, score: score };
      }).filter(function(s) { return s.score > 0; }).sort(function(a, b) { return b.score - a.score; }).slice(0, topK);

      var nodeMap = {};
      scored.forEach(function(s) {
        var n = s.node;
        nodeMap[n.id] = n;
        subgraphContext += '- ' + n.label + ' [' + (n.entityType||'Concept') + ']' + (n.description ? ': ' + n.description.slice(0, 200) : '') + '\n';
      });

      // 1-hop neighbors
      var seenEdges = {};
      graph.edges.forEach(function(e) {
        if (nodeMap[e.source] || nodeMap[e.target]) {
          var key = e.source + '::' + e.type + '::' + e.target;
          if (!seenEdges[key]) {
            seenEdges[key] = true;
            var srcNode = graph.nodes.find(function(n) { return n.id === e.source; });
            var tgtNode = graph.nodes.find(function(n) { return n.id === e.target; });
            subgraphContext += '  ' + (srcNode ? srcNode.label : e.source) + ' -[' + (e.relationType||e.type||'RELATES_TO') + ']-> ' + (tgtNode ? tgtNode.label : e.target) + '\n';
          }
        }
      });
    }

    // 4. Vector chunk context
    var vectorContext = '';
    if (fs.existsSync(ragFile)) {
      var rag = JSON.parse(fs.readFileSync(ragFile, 'utf-8'));
      var ragChunks = rag.chunks || [];
      var qtokens = question.toLowerCase().split(/\s+/);
      var scoredChunks = ragChunks.map(function(c) {
        var txt = (c.text || '').toLowerCase();
        var s = 0;
        qtokens.forEach(function(t) { if (t.length > 2 && txt.indexOf(t) >= 0) s += 3; });
        return { text: c.text.slice(0, 600), score: s };
      }).filter(function(x) { return x.score > 0; }).sort(function(a, b) { return b.score - a.score; }).slice(0, 3);
      vectorContext = scoredChunks.map(function(x) { return x.text; }).join('\n---\n');
    }

    if (!communityContext && !subgraphContext && !vectorContext) {
      sendJSON(res, 200, { answer: 'No graph or RAG index found. Run extraction and RAG build first.', sources: [] });
      return;
    }

    // 5. Assemble prompt with all three contexts
    var prompt = '你是一个知识图谱增强的问答助手。综合以下三个来源回答问题。\n\n';
    if (communityContext) prompt += '【全局社区摘要 (Global Context)】\n' + communityContext.slice(0, 1500) + '\n\n';
    if (subgraphContext) prompt += '【相关子图 (Local Context)】\n' + subgraphContext.slice(0, 2000) + '\n\n';
    if (vectorContext) prompt += '【相关文档片段 (Vector Context)】\n' + vectorContext.slice(0, 1500) + '\n\n';
    prompt += '问题: ' + question + '\n\n请综合这三个层级（全局→局部→细节）回答。标注信息来源（[Global]/[Graph]/[Doc]）。';

    var pd = JSON.stringify({
      model: route.model || model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2048,
      temperature: 0.5,
    });

    var answer = await new Promise(function(resolve) {
      var r = https.request({
        hostname: route.host, port: 443, path: route.path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Content-Length': Buffer.byteLength(pd) },
      }, function(resp) { var d = ''; resp.on('data', function(c) { d += c; }); resp.on('end', function() { try { var j = JSON.parse(d); resolve(j.choices[0].message.content); } catch(e) { resolve(d); } }); });
      r.on('error', function() { resolve('Request failed.'); }); r.write(pd); r.end();
    });

    usageEventLog.recordUsageEvent({ carrier: 'graph', graphId: project || null, query: String(question).slice(0, 200), hits: (subgraphContext.match(/\n/g) || []).length, caller: 'graphrag' });
    sendJSON(res, 200, {
      answer: answer,
      contexts: {
        communityContext: !!communityContext,
        subgraphContext: !!subgraphContext,
        vectorContext: !!vectorContext,
        nodeCount: (subgraphContext.match(/\n/g) || []).length,
      },
      sources: [],
    });
  } catch(e) { sendJSON(res, 500, { error: e.message }); }
}

// ── Agent Tool API Handlers ──
// 这些端点为Python Agent提供图谱查询原语，不需要认证

// 图谱检索核心已抽至 tools/graph-search-core.js（统一检索共用，评分行为保持不变）
const { loadGraph: _loadGraph, nodeLabel: _nodeLabel, nodeSummary: _nodeSummary, searchEntitiesCore: _searchEntitiesCore, searchEntitiesHybrid: _searchEntitiesHybrid } = require('../tools/graph-search-core');
const usageEventLog = require('../tools/usage-event-log');

// 1. search_entities — 实体搜索（复用种子匹配逻辑）
async function handleToolSearchEntities(req, res) {
  try {
    var body = await parseBody(req);
    var r = await _searchEntitiesHybrid(body.graphId, body.query, body.topK);
    if (!r.ok) { sendJSON(res, r.status || 500, { error: r.error }); return; }
    usageEventLog.recordUsageEvent({ carrier: 'graph', graphId: body.graphId || null, query: String(body.query || '').slice(0, 200), hits: r.entities.length, caller: 'knowledge-qa' });
    sendJSON(res, 200, { success: true, query: body.query, entities: r.entities, total: r.entities.length });
  } catch(e) { sendJSON(res, 500, { error: e.message }); }
}

// 2. query_relations — 查询节点的关系（按边类型和方向）
async function handleToolQueryRelations(req, res) {
  try {
    var body = await parseBody(req);
    var { graphId, nodeId, edgeType, direction } = body;
    if (!graphId || !nodeId) { sendJSON(res, 400, { error: 'Missing graphId or nodeId' }); return; }

    var g = _loadGraph(graphId);
    if (!g) { sendJSON(res, 404, { error: 'Graph not found: ' + graphId }); return; }

    var id = String(nodeId);
    var seedNode = g.nodeMap[id];
    if (!seedNode) { sendJSON(res, 404, { error: 'Node not found: ' + nodeId }); return; }

    var adj = g.typedAdj[id] || {};
    var results = [];

    var edgeTypes = edgeType ? [edgeType] : Object.keys(adj);
    edgeTypes.forEach(function(et) {
      var neighbors = adj[et] || [];
      neighbors.forEach(function(nb) {
        // direction: 'outgoing' = reverse=false, 'incoming' = reverse=true, 'both' = all
        if (direction === 'outgoing' && nb.reverse) return;
        if (direction === 'incoming' && !nb.reverse) return;

        var targetNode = g.nodeMap[nb.target];
        if (!targetNode) return;

        var edgeProps = nb.edge.properties || {};
        var result = {
          targetNode: _nodeSummary(targetNode),
          edgeType: et,
          direction: nb.reverse ? 'incoming' : 'outgoing',
          edgeProperties: edgeProps,
        };
        results.push(result);
      });
    });

    usageEventLog.recordUsageEvent({ carrier: 'graph', graphId: graphId || null, query: 'relations:' + String(nodeId).slice(0, 120), hits: results.length, caller: 'knowledge-qa' });
    sendJSON(res, 200, {
      success: true,
      node: _nodeSummary(seedNode),
      relations: results,
      total: results.length,
    });
  } catch(e) { sendJSON(res, 500, { error: e.message }); }
}

// 3. get_node — 获取节点详情
async function handleToolGetNode(req, res) {
  try {
    var body = await parseBody(req);
    var { graphId, nodeId } = body;
    if (!graphId || !nodeId) { sendJSON(res, 400, { error: 'Missing graphId or nodeId' }); return; }

    var g = _loadGraph(graphId);
    if (!g) { sendJSON(res, 404, { error: 'Graph not found: ' + graphId }); return; }

    var node = g.nodeMap[String(nodeId)];
    if (!node) { sendJSON(res, 404, { error: 'Node not found: ' + nodeId }); return; }

    // 获取节点的所有邻接边类型概览
    var adj = g.typedAdj[String(nodeId)] || {};
    var edgeTypeSummary = {};
    Object.keys(adj).forEach(function(et) {
      var forward = adj[et].filter(function(nb) { return !nb.reverse; }).length;
      var reverse = adj[et].filter(function(nb) { return nb.reverse; }).length;
      edgeTypeSummary[et] = { outgoing: forward, incoming: reverse };
    });

    usageEventLog.recordUsageEvent({ carrier: 'graph', graphId: graphId || null, query: 'node:' + String(nodeId).slice(0, 120), hits: 1, caller: 'knowledge-qa' });
    sendJSON(res, 200, {
      success: true,
      node: _nodeSummary(node),
      rawProperties: node.properties || {},
      edgeTypes: edgeTypeSummary,
    });
  } catch(e) { sendJSON(res, 500, { error: e.message }); }
}

// 4. expand_subgraph — BFS展开子图
async function handleToolExpandSubgraph(req, res) {
  try {
    var body = await parseBody(req);
    var { graphId, nodeIds, hops } = body;
    hops = hops || 2;
    if (!graphId || !nodeIds || !Array.isArray(nodeIds) || nodeIds.length === 0) {
      sendJSON(res, 400, { error: 'Missing graphId or nodeIds' }); return;
    }

    var g = _loadGraph(graphId);
    if (!g) { sendJSON(res, 404, { error: 'Graph not found: ' + graphId }); return; }

    // BFS
    var adj = {};
    g.edges.forEach(function(e) {
      var s = String(e.source || e.from || '');
      var t = String(e.target || e.to || '');
      if (!adj[s]) adj[s] = []; if (!adj[t]) adj[t] = [];
      adj[s].push({ target: t, edge: e }); adj[t].push({ target: s, edge: e });
    });

    var visited = {};
    var seedIds = nodeIds.map(String);
    seedIds.forEach(function(id) { visited[id] = 0; });
    var queue = seedIds.slice();
    var subNodes = {};
    var subEdges = [];

    while (queue.length) {
      var curr = queue.shift();
      var dist = visited[curr] || 0;
      var nodeData = g.nodeMap[curr];
      if (nodeData && !subNodes[curr]) {
        subNodes[curr] = _nodeSummary(nodeData);
        subNodes[curr].dist = dist;
      }
      if (dist >= hops) continue;
      var neighbors = adj[curr] || [];
      for (var j = 0; j < neighbors.length; j++) {
        var nb = neighbors[j];
        if (visited[nb.target] === undefined) {
          visited[nb.target] = dist + 1;
          queue.push(nb.target);
          subEdges.push({
            source: nb.edge.source || nb.edge.from,
            target: nb.edge.target || nb.edge.to,
            type: nb.edge.type,
            properties: nb.edge.properties || {},
          });
        }
      }
    }

    usageEventLog.recordUsageEvent({ carrier: 'graph', graphId: graphId || null, query: 'subgraph:' + String(nodeIds.join(',')).slice(0, 120), hits: Object.keys(subNodes).length, caller: 'knowledge-qa' });
    sendJSON(res, 200, {
      success: true,
      nodes: Object.values(subNodes),
      edges: subEdges,
      stats: { nodeCount: Object.keys(subNodes).length, edgeCount: subEdges.length },
    });
  } catch(e) { sendJSON(res, 500, { error: e.message }); }
}

// 5. list_graphs — 列出可用图谱
async function handleToolListGraphs(req, res) {
  try {
    var graphsDir = path.join(__dirname, '../data/graphs');
    var results = [];

    function scanDir(dir, prefix) {
      if (!fs.existsSync(dir)) return;
      var entries = fs.readdirSync(dir, { withFileTypes: true });
      entries.forEach(function(entry) {
        if (entry.isDirectory()) {
          // 检查是否有manifest
          var manifestPath = path.join(dir, entry.name, 'org-graph-manifest.json');
          if (fs.existsSync(manifestPath)) {
            try {
              var manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
              var versions = manifest.versions || [];
              versions.forEach(function(v) {
                var ver = v.version || v.file.replace('.json', '');
                var graphId = prefix + entry.name + '/' + ver;
                results.push({
                  graphId: graphId,
                  name: v.name || ver,
                  version: ver,
                  active: manifest.active_version === ver,
                  description: v.description || v.note || '',
                });
              });
            } catch(e) {}
          } else {
            scanDir(path.join(dir, entry.name), prefix + entry.name + '/');
          }
        } else if (entry.name.endsWith('.json') && entry.name !== 'org-graph-manifest.json') {
          var graphId = prefix + entry.name.replace('.json', '');
          results.push({ graphId: graphId, name: entry.name.replace('.json', ''), version: '', active: true, description: '' });
        }
      });
    }

    scanDir(graphsDir, '');
    sendJSON(res, 200, { success: true, graphs: results, total: results.length });
  } catch(e) { sendJSON(res, 500, { error: e.message }); }
}

module.exports = { handleKnowledgeQARequest };
