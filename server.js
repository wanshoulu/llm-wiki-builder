'use strict';

/**
 * llm-wiki-builder — LLM Wiki 知识构建工具链（独立服务 + 独立前端）
 *
 * 从 AI Harbor 单体剥离后的独立部署入口：
 *   - 前端：tools/*.html 单文件应用（llm-wiki 工作台 / 知识库 / 图谱化 / AI 生成），零 CDN
 *   - 后端：routes/knowledge-studio.js 的 wiki+RAG 端点子集 + llm-wiki 兼容别名
 *   - 数据：wiki/ 目录即知识库（Markdown 文件），无数据库
 *
 * 路由族（只分发 wiki 相关前缀；MCP/评测数据集/意图测试集/公文审核端点不分发）：
 *   /api/knowledge/*          Wiki 主体：projects/pages/ingest/graph/qa/search/raw/rag/queue/watcher
 *   /api/llm-wiki/*          兼容别名：/api/llm-wiki/scan → /api/knowledge/projects/scan 等（llm-wiki.html 前端用）
 *   /api/wiki-graph/*        兼容别名：图谱化 SSE（wiki-graph-builder.html 前端用）
 *   /api/knowledge-builder/wiki/*   Wiki 库 CRUD + 构建运行管理
 *
 * 设计约定（沿用原单体）：入口把 req.url 解析为 req.pathname，路由处理器自检前缀。
 * SKIP_AUTH=true 时免登录（默认；生产设 false 并配 JWT_SECRET）。
 *
 * 环境变量：
 *   PORT          监听端口（默认 3014，避开 AI Harbor 3000 / graph-builder 3013）
 *   HOST          监听地址（默认 127.0.0.1）
 *   SKIP_AUTH     "true" 跳过 JWT 认证（默认 true）
 *   WIKI_ROOT     wiki 数据根（默认 ./wiki）
 *   DEEPSEEK_KEY / QWEN_KEY 等   LLM 密钥（生成/问答/RAG 需要；未配置时浏览/检索等离线能力照常）
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

process.env.SKIP_AUTH = process.env.SKIP_AUTH || 'true';

const { handleKnowledgeStudioRequest } = require('./routes/knowledge-studio');
const { handleKnowledgeStudioLiteRequest } = require('./routes/knowledge-studio-lite');
const { handleKnowledgeBuilderWikiRequest } = require('./routes/knowledge-builder-wiki-api');
const { handleKnowledgeQARequest } = require('./routes/knowledge-qa-api');

const PORT = Number(process.env.PORT || 3014);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const TOOLS_ROOT = path.join(ROOT, 'tools');

const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.js': 'application/javascript;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown;charset=utf-8',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return sendJson(res, 404, { ok: false, error: 'NOT_FOUND', path: filePath.replace(ROOT, '') });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/** 静态目录映射：URL 前缀 → 磁盘目录，禁止路径穿越 */
function serveStatic(res, pathname, urlPrefix, diskRoot) {
  const rel = decodeURIComponent(pathname.slice(urlPrefix.length));
  const abs = path.resolve(diskRoot, rel);
  if (abs !== diskRoot && !abs.startsWith(diskRoot + path.sep)) {
    return sendJson(res, 403, { ok: false, error: 'FORBIDDEN' });
  }
  return serveFile(res, abs);
}

/** 知识问答 Agent 代理：/api/knowledge-qa-agent/* → KNOWLEDGE_QA_AGENT_URL（Python 服务，默认 :8100）。
 *  未配置/不可达时返回 502 明确降级（知识问答页的 Agent 对话通道，基础问答走 /api/knowledge-qa/* 不受影响）。 */
function proxyToQaAgent(req, res) {
  const base = process.env.KNOWLEDGE_QA_AGENT_URL;
  if (!base) {
    return sendJson(res, 502, { ok: false, error: 'QA_AGENT_NOT_CONFIGURED', hint: '设置 KNOWLEDGE_QA_AGENT_URL 指向知识问答 Agent 服务（如 http://127.0.0.1:8100）' });
  }
  const target = base.replace(/\/+$/, '') + req.url.replace('/api/knowledge-qa-agent', '');
  const u2 = new URL(target);
  const proxyReq = http.request(u2, { method: req.method, headers: { ...req.headers, host: u2.host } }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => sendJson(res, 502, { ok: false, error: 'QA_AGENT_UNREACHABLE', target: u2.origin }));
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  req.pathname = decodeURIComponent(u.pathname);
  const p = req.pathname;

  // 健康检查
  if (p === '/healthz' || p === '/api/health') {
    return sendJson(res, 200, {
      ok: true, service: 'llm-wiki-builder', version: '1.0.0',
      port: PORT, time: new Date().toISOString(),
      routes: ['/api/knowledge/*', '/api/llm-wiki/*（兼容别名）', '/api/wiki-graph/*（兼容别名）', '/api/knowledge-builder/wiki/*'],
      wikiRoot: process.env.WIKI_ROOT || path.join(ROOT, 'wiki'),
    });
  }

  // 根路径落到 llm-wiki 工作台
  if (p === '/' || p === '/index.html') {
    res.writeHead(302, { Location: '/tools/llm-wiki.html' });
    return res.end();
  }
  if (p === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  // ── API 分发（顺序有意义） ──
  // 1. Wiki 库 CRUD + 构建运行管理（前端 axios 走 /ontomind/wiki/api 前缀，去掉后为 /api/knowledge-builder/wiki/*）
  if (p.startsWith('/api/knowledge-builder/wiki/')) {
    return handleKnowledgeBuilderWikiRequest(req, res, u);
  }
  // 1b. 知识问答 Agent（Python 服务代理，KNOWLEDGE_QA_AGENT_URL 未配置时返回 502 明确降级）
  if (p.startsWith('/api/knowledge-qa-agent/')) {
    return proxyToQaAgent(req, res);
  }
  // 1c. 知识问答应用端点（wiki 图谱问答 / GraphRAG 检索）
  if (p.startsWith('/api/knowledge-qa/')) {
    if (handleKnowledgeQARequest(req, res)) return;
    return sendJson(res, 404, { ok: false, error: 'NOT_FOUND', path: p }); // qa-api 未接管的路径快速 404，不挂起
  }
  // 2. Wiki 主体端点（projects/pages/ingest/graph/qa/search/raw/rag/queue/watcher + doc-review-agent 公文审核 9 端点 + llm-wiki 兼容别名在 studio 内部处理）
  //    studio-lite 只是单体「知识问答页」的两端点精简版（其 store 指向 data/wiki），这里仅作 pages/get 的兜底
  if (p.startsWith('/api/knowledge/') || p === '/api/knowledge') {
    if (req.method === 'GET' && p === '/api/knowledge/pages/get'
        && handleKnowledgeStudioLiteRequest(req, res, u)) return;
    return handleKnowledgeStudioRequest(req, res, u);
  }
  // 3. llm-wiki 兼容别名（老前端页面 llm-wiki.html / llm-wiki-light.html / wiki-builder-standalone.html 用）
  if (p.startsWith('/api/llm-wiki/')) {
    return handleKnowledgeStudioRequest(req, res, u);
  }
  // 4. wiki-graph 兼容别名（图谱化 SSE）——studio 内部已处理
  if (p.startsWith('/api/wiki-graph/')) {
    return handleKnowledgeStudioRequest(req, res, u);
  }

  // ── 静态资源 ──
  if (p.startsWith('/tools/')) return serveStatic(res, p, '/tools/', TOOLS_ROOT);

  return sendJson(res, 404, {
    ok: false,
    error: 'NOT_FOUND',
    hint: '入口 /tools/llm-wiki.html；API 前缀 /api/knowledge/*、/api/llm-wiki/*（兼容别名）、/api/wiki-graph/*、/api/knowledge-builder/wiki/*',
  });
});

// 分块抽取与图谱生成是 SSE 长连接，放宽超时（沿用原单体口径）
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 65 * 1000;

server.listen(PORT, HOST, () => {
  console.log(`[llm-wiki-builder] http://${HOST}:${PORT}  →  /tools/llm-wiki.html`);
  console.log(`[llm-wiki-builder] wiki 根目录            →  ${process.env.WIKI_ROOT || path.join(ROOT, 'wiki')}`);
  console.log(`[llm-wiki-builder] SKIP_AUTH=${process.env.SKIP_AUTH}`);
});

module.exports = server;
