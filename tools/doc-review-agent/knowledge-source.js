'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WIKI_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
const DOC_TYPE_TERMS = {
  notice: ['通知'],
  request: ['请示'],
  report: ['报告'],
  reply: ['批复'],
  letter: ['函'],
  meeting: ['纪要'],
  decision: ['决定'],
  bulletin: ['通报'],
  opinion: ['意见'],
  announcement: ['通告'],
  notice_public: ['公告'],
  regulation: ['制度', '规定', '办法'],
  speech: ['讲话', '主持词'],
};

const TASK_TERM_STOPWORDS = new Set([
  '关于', '有关', '进行', '工作', '事项', '公文', '文件', '一份', '这是',
  '正确', '应当', '以及', '根据', '要求', '需要', '本次', '相关', '问题',
]);

function fail(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode || 400;
  throw error;
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return null; }
}

function safeWikiId(value) {
  const id = String(value || '').trim();
  if (!WIKI_ID_PATTERN.test(id) || id === '.' || id === '..') {
    fail('DOC_REVIEW_WIKI_ID_INVALID', 'Wiki 标识不合法', 400);
  }
  return id;
}

function resolveInside(root, relative, code) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, String(relative || ''));
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    fail(code || 'DOC_REVIEW_PATH_INVALID', '路径超出允许的 Wiki 目录', 400);
  }
  return resolved;
}

function stripFrontmatter(content) {
  return String(content || '').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '').trim();
}

function createKnowledgeSourceService(options) {
  const opts = options || {};
  const workspaceRoot = path.resolve(opts.workspaceRoot || path.join(__dirname, '..', '..'));
  const wikiRoot = path.resolve(opts.wikiRoot || path.join(workspaceRoot, 'wiki'));
  const taskIndexCache = new Map();

  function wikiDirectory(wikiId) {
    return resolveInside(wikiRoot, safeWikiId(wikiId), 'DOC_REVIEW_WIKI_ID_INVALID');
  }

  function latestBuild(directory) {
    const history = readJson(path.join(directory, '_meta', 'build-history.json'));
    if (!Array.isArray(history) || !history.length) return null;
    return history.slice().sort((left, right) => String(right.finished_at || right.started_at || '').localeCompare(String(left.finished_at || left.started_at || '')))[0];
  }

  function projectionState(directory) {
    const runtimeRoot = path.join(directory, 'dist', 'doc-review-agent');
    const manifestPath = path.join(runtimeRoot, 'projection-manifest.json');
    const manifest = readJson(manifestPath);
    if (!manifest || manifest.profile !== 'document-review' || !Array.isArray(manifest.generated_files)) {
      return { ready: false, runtimeRoot: null, manifest: null };
    }
    const missing = manifest.generated_files.filter((relative) => {
      if (typeof relative !== 'string' || !relative) return true;
      try { return !fs.existsSync(resolveInside(runtimeRoot, relative, 'DOC_REVIEW_PROJECTION_INVALID')); }
      catch (_) { return true; }
    });
    return { ready: missing.length === 0, runtimeRoot, manifest, missing };
  }

  function describe(wikiId) {
    const id = safeWikiId(wikiId);
    const directory = wikiDirectory(id);
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      fail('DOC_REVIEW_WIKI_NOT_FOUND', '公文审核 Wiki 不存在', 404);
    }
    const profile = readJson(path.join(directory, '_meta', 'build-profile.json')) || {};
    const library = readJson(path.join(directory, '_meta', 'library.json')) || {};
    const build = latestBuild(directory);
    const projection = projectionState(directory);
    const isLegacy = id === 'doc-rules';
    const isDocumentReview = isLegacy || profile.build_profile === 'document-review' || profile.skill_name === 'document-review-wiki-builder';
    if (!isDocumentReview) fail('DOC_REVIEW_WIKI_NOT_APPLICABLE', '该 Wiki 不是公文审核知识库', 422);
    // 空壳判定：既无发布产物，也无真实内容页（仅剩 _meta/_wiki_graph 残留）——
    // 这类库只有构建元数据，选了也无法召回任何规则，直接排除出知识源列表
    const realPages = isLegacy ? countRealPages(directory) : 0;
    if (!isLegacy && !projection.ready && countRealPages(directory) === 0) {
      fail('DOC_REVIEW_WIKI_NOT_APPLICABLE', '该 Wiki 无内容页（空壳）', 422);
    }
    const graphAvailable = fs.existsSync(path.join(directory, '_wiki_graph.json')) || projection.ready;
    const mode = projection.ready ? 'published' : (isLegacy ? 'legacy' : 'draft_preview');
    const message = mode === 'published'
      ? '已加载发布版公文审核知识'
      : mode === 'legacy'
        ? '已加载兼容版公文审核知识'
        : '当前 Wiki 尚未发布，仅加载草稿预览知识；审核结论不得视为正式合规结论';
    return {
      wiki_id: id,
      name: String(library.name || id),
      description: String(library.description || ''),
      build_profile: isLegacy ? 'legacy' : 'document-review',
      mode,
      ready: projection.ready,
      release_version: projection.manifest && projection.manifest.release_version || null,
      included_knowledge_ids: projection.manifest && projection.manifest.included_knowledge_ids || [],
      graph_available: graphAvailable,
      updated_at: String(build && (build.finished_at || build.started_at) || fs.statSync(directory).mtime.toISOString()),
      page_count: countRealPages(directory) || Number(build && build.topics || 0),
      message,
      wiki_root: directory,
      runtime_root: projection.ready ? projection.runtimeRoot : (isLegacy ? directory : null),
      projection_manifest: projection.manifest,
    };
  }

  // 真实内容页计数：遍历目录数 .md（排除 _ 元数据目录、dist、隐藏文件）
  // 构建历史（build.topics）只是记录，可能为 0 或过期——以磁盘实况为准
  function countRealPages(directory) {
    let count = 0;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.startsWith('_') || entry.name === 'dist') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.md')) count++;
      }
    };
    walk(directory);
    return count;
  }

  function listSources() {
    if (!fs.existsSync(wikiRoot)) return { sources: [], default_wiki_id: null };
    const sources = fs.readdirSync(wikiRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && WIKI_ID_PATTERN.test(entry.name))
      .map((entry) => {
        try { return describe(entry.name); }
        catch (error) {
          if (error.code === 'DOC_REVIEW_WIKI_NOT_APPLICABLE') return null;
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
    const published = sources.find((source) => source.mode === 'published');
    return { sources, default_wiki_id: (published || sources[0] || {}).wiki_id || null };
  }

  function resolveSource(wikiId) {
    if (wikiId) return describe(wikiId);
    const listed = listSources();
    if (!listed.default_wiki_id) fail('DOC_REVIEW_WIKI_NOT_FOUND', '未找到公文审核 Wiki', 404);
    return describe(listed.default_wiki_id);
  }

  function normalizeGraph(raw) {
    const nodes = Array.isArray(raw && raw.nodes) ? raw.nodes.map((node) => ({
      id: String(node.id || ''),
      title: String(node.title || node.label || node.id || ''),
      group: String(node.group || node.category || String(node.id || '').split('/')[0] || 'root'),
      type: String(node.type || node.entity_type || 'document'),
      weightedDegree: Number(node.weightedDegree || 0),
    })).filter((node) => node.id) : [];
    const ids = new Set(nodes.map((node) => node.id));
    const edges = Array.isArray(raw && raw.edges) ? raw.edges.map((edge, index) => ({
      id: String(edge.id || 'e' + index),
      source: String(edge.source || ''),
      target: String(edge.target || ''),
      label: String(edge.label || ''),
      type: String(edge.type || 'ref'),
      weight: Number(edge.weight || 1),
      signals: Array.isArray(edge.signals) && edge.signals.length ? edge.signals : ['direct'],
    })).filter((edge) => ids.has(edge.source) && ids.has(edge.target)) : [];
    const degree = {};
    edges.forEach((edge) => {
      degree[edge.source] = (degree[edge.source] || 0) + edge.weight;
      degree[edge.target] = (degree[edge.target] || 0) + edge.weight;
    });
    nodes.forEach((node) => { if (!node.weightedDegree) node.weightedDegree = degree[node.id] || 0; });
    return {
      nodes,
      edges,
      stats: Object.assign({}, raw && raw.stats || {}, {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        isolatedNodes: nodes.filter((node) => !degree[node.id]).length,
      }),
    };
  }

  function loadGraph(sourceOrId) {
    const source = typeof sourceOrId === 'string' || !sourceOrId ? resolveSource(sourceOrId) : sourceOrId;
    const graphPath = path.join(source.wiki_root, '_wiki_graph.json');
    if (fs.existsSync(graphPath)) return normalizeGraph(readJson(graphPath) || {});
    if (source.runtime_root) {
      const graph = require('./wiki-graph-builder').buildGraph(source.runtime_root);
      return normalizeGraph(graph);
    }
    return normalizeGraph({ nodes: [], edges: [] });
  }

  function readPage(sourceOrId, relativePath) {
    const source = typeof sourceOrId === 'string' || !sourceOrId ? resolveSource(sourceOrId) : sourceOrId;
    const relative = String(relativePath || '').replace(/\\/g, '/');
    if (!relative || !relative.toLowerCase().endsWith('.md')) {
      fail('DOC_REVIEW_PAGE_INVALID', '只允许读取 Wiki Markdown 页面', 400);
    }
    const target = resolveInside(source.wiki_root, relative, 'DOC_REVIEW_PAGE_INVALID');
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      fail('DOC_REVIEW_PAGE_NOT_FOUND', 'Wiki 页面不存在', 404);
    }
    return fs.readFileSync(target, 'utf8');
  }

  function recallDraft(sourceOrId, docType, text, options) {
    const source = typeof sourceOrId === 'string' || !sourceOrId ? resolveSource(sourceOrId) : sourceOrId;
    if (source.mode === 'published' || source.mode === 'legacy') return { preview: false, pages: [], graphExcerpts: [] };
    const recall = recallForTask(source, docType, text, options);
    return Object.assign({}, recall, {
      preview: true,
      query_text: String(text || '').slice(0, 120),
    });
  }

  function pageSignature(source, graph) {
    const parts = [source.wiki_id];
    const graphPath = path.join(source.wiki_root, '_wiki_graph.json');
    try {
      const stat = fs.statSync(graphPath);
      parts.push(String(stat.mtimeMs), String(stat.size));
    } catch (_) { parts.push('no-graph'); }
    graph.nodes.forEach((node) => {
      try {
        const stat = fs.statSync(resolveInside(source.wiki_root, node.id, 'DOC_REVIEW_PAGE_INVALID'));
        parts.push(node.id, String(stat.mtimeMs), String(stat.size));
      } catch (_) { parts.push(node.id, 'missing'); }
    });
    return parts.join('|');
  }

  function searchableText(markdown) {
    return stripFrontmatter(markdown)
      .replace(/`[^`]*`/g, ' ')
      .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/[#>*_|~-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);
  }

  function buildTaskIndex(source) {
    const graph = loadGraph(source);
    const signature = pageSignature(source, graph);
    const cached = taskIndexCache.get(source.wiki_id);
    if (cached && cached.signature === signature) return cached;
    const nodes = graph.nodes.map((node) => {
      let summary = '';
      try { summary = searchableText(readPage(source, node.id)); }
      catch (_) { /* A broken page remains visible in the graph but cannot be recalled. */ }
      return Object.assign({}, node, {
        titleText: String(node.title || node.id).toLowerCase(),
        pathText: String(node.id).toLowerCase(),
        summaryText: summary.toLowerCase(),
        readable: !!summary,
      });
    });
    const indexed = {
      signature,
      graph,
      nodes,
      nodeMap: Object.fromEntries(nodes.map((node) => [node.id, node])),
    };
    taskIndexCache.set(source.wiki_id, indexed);
    return indexed;
  }

  function extractTaskTerms(value) {
    const input = String(value || '').toLowerCase();
    const terms = new Set();
    (input.match(/[a-z0-9][a-z0-9._-]{1,}/g) || []).forEach((term) => terms.add(term));
    (input.match(/[\u3400-\u9fff]{2,}/g) || []).forEach((segment) => {
      const maxN = Math.min(6, segment.length);
      for (let size = maxN; size >= 2; size -= 1) {
        for (let start = 0; start + size <= segment.length; start += 1) {
          const term = segment.slice(start, start + size);
          if (!TASK_TERM_STOPWORDS.has(term)) terms.add(term);
          if (terms.size >= 240) return;
        }
      }
    });
    return Array.from(terms).sort((left, right) => right.length - left.length);
  }

  function isDocumentTypeNode(node) {
    return !!node && /(?:doc-types|document-type-and-format)/i.test(node.group + '/' + node.id) && /文种适用/.test(node.titleText);
  }

  function scoreDirectCandidate(node, docType, terms) {
    let score = 0;
    const reasons = [];
    const docTerms = DOC_TYPE_TERMS[String(docType || '').toLowerCase()] || [];
    const docTypePage = isDocumentTypeNode(node);
    const docHit = docTypePage && docTerms.find((term) => {
      const normalized = term.toLowerCase();
      return node.titleText.includes(normalized + '文种') || node.titleText.startsWith(normalized + '适用');
    });
    if (docHit) {
      score += 14;
      reasons.push('文种匹配：' + docHit);
    }

    function selectHits(haystack, candidates, maxHits, minLength) {
      const selected = [];
      candidates.forEach((term) => {
        if (selected.length >= maxHits || term.length < minLength || !haystack.includes(term)) return;
        if (selected.some((existing) => existing.includes(term))) return;
        selected.push(term);
      });
      return selected;
    }

    const titleHits = selectHits(node.titleText, terms, 3, 2);
    if (titleHits.length) {
      score += Math.min(12, titleHits.reduce((sum, term) => sum + Math.min(5, term.length * 1.2), 0));
      reasons.push('标题命中：' + titleHits.join('、'));
    }
    const bodyHits = selectHits(node.summaryText, terms.filter((term) => !titleHits.some((hit) => hit.includes(term))), 2, 4);
    if (bodyHits.length) {
      score += Math.min(4, bodyHits.reduce((sum, term) => sum + Math.min(2, term.length * 0.45), 0));
      reasons.push('正文命中：' + bodyHits.join('、'));
    }
    return { score, reasons, docMatch: !!docHit, matched: !!docHit || titleHits.length > 0 || bodyHits.length > 0 };
  }

  function evidenceRole(node) {
    return /(?:policy|regulation|history|case|source)|(?:政策|制度|法规|依据|案例|来源)/i.test(node.group + '/' + node.id)
      ? 'evidence'
      : 'expanded';
  }

  function recallForTask(sourceOrId, docType, text, options) {
    const source = typeof sourceOrId === 'string' || !sourceOrId ? resolveSource(sourceOrId) : sourceOrId;
    const settings = options || {};
    const maxPages = Math.max(1, Math.min(12, Number(settings.maxPages || 6)));
    const maxChars = Math.max(400, Number(settings.maxChars || 6500));
    const index = buildTaskIndex(source);
    const terms = extractTaskTerms(text);
    let direct = index.nodes.filter((node) => node.readable).map((node) => {
      const scored = scoreDirectCandidate(node, docType, terms);
      return { id: node.id, title: node.title, score: scored.score, reasons: scored.reasons, docMatch: scored.docMatch, matched: scored.matched };
    }).filter((candidate) => candidate.matched)
      .sort((left, right) => Number(right.docMatch) - Number(left.docMatch) || right.score - left.score || left.id.localeCompare(right.id));

    if (!direct.length) {
      direct = index.nodes.filter((node) => node.readable)
        .sort((left, right) => right.weightedDegree - left.weightedDegree)
        .slice(0, Math.min(2, maxPages))
        .map((node) => ({ id: node.id, title: node.title, score: 1, reasons: ['知识库核心节点兜底'], docMatch: false, matched: false }));
    }

    const ranked = [];
    const rankedById = {};
    direct.slice(0, Math.min(4, maxPages)).forEach((candidate) => {
      const candidateNode = index.nodeMap[candidate.id];
      const role = candidate.docMatch ? 'seed' : evidenceRole(candidateNode);
      const page = Object.assign({}, candidate, { role: role === 'expanded' ? 'seed' : role, hop: 0, path: [candidate.id] });
      delete page.docMatch;
      delete page.matched;
      ranked.push(page);
      rankedById[page.id] = page;
    });

    const expansions = [];
    const requestedDocTerms = DOC_TYPE_TERMS[String(docType || '').toLowerCase()] || [];
    index.graph.edges.forEach((edge) => {
      ranked.filter((page) => page.role === 'seed').forEach((seed) => {
        const targetId = edge.source === seed.id ? edge.target : (edge.target === seed.id ? edge.source : null);
        const target = targetId && index.nodeMap[targetId];
        if (!target || !target.readable || rankedById[targetId]) return;
        if (isDocumentTypeNode(target)) {
          const edgeText = String(edge.label || '').toLowerCase();
          const edgeSupportsTask = requestedDocTerms.some((term) => edgeText.includes(term.toLowerCase()));
          if (!edgeSupportsTask) return;
        }
        const edgeScore = Math.max(1, Number(edge.weight || 1));
        expansions.push({
          id: targetId,
          title: target.title,
          role: evidenceRole(target),
          score: Number((seed.score * 0.42 + edgeScore).toFixed(2)),
          hop: 1,
          reasons: ['图谱关联：' + (edge.label || seed.title)],
          path: [seed.id, targetId],
        });
      });
    });
    expansions.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    expansions.forEach((candidate) => {
      if (ranked.length >= maxPages || rankedById[candidate.id]) return;
      ranked.push(candidate);
      rankedById[candidate.id] = candidate;
    });

    const auditCoreTitles = ['公文审核要点', '公文拟制与起草要求', '公文格式要素构成', '公文语言表达规范'];
    auditCoreTitles.forEach((title) => {
      if (ranked.length >= maxPages) return;
      const node = index.nodes.find((candidate) => candidate.readable && candidate.titleText.includes(title));
      if (!node || rankedById[node.id]) return;
      const page = {
        id: node.id,
        title: node.title,
        role: 'evidence',
        score: 2,
        hop: 0,
        reasons: ['审核基础规则'],
        path: [node.id],
      };
      ranked.push(page);
      rankedById[page.id] = page;
    });

    const pages = [];
    const graphExcerpts = [];
    let remaining = maxChars;
    ranked.slice(0, maxPages).forEach((candidate, indexInList) => {
      if (remaining <= 0) return;
      try {
        const pagesLeft = Math.max(1, Math.min(maxPages, ranked.length) - indexInList);
        const quota = Math.max(200, Math.min(1400, Math.floor(remaining / pagesLeft)));
        const content = stripFrontmatter(readPage(source, candidate.id)).slice(0, Math.min(quota, remaining));
        if (!content) return;
        const page = Object.assign({}, candidate, {
          score: Number(candidate.score.toFixed(2)),
          status: source.mode === 'draft_preview' ? 'draft_preview' : 'published',
        });
        pages.push(page);
        graphExcerpts.push(Object.assign({}, page, { weight: page.score, content }));
        remaining -= content.length;
      } catch (_) { /* Never report a page that could not be materialized. */ }
    });
    return {
      preview: source.mode === 'draft_preview',
      pages,
      graphExcerpts,
      total_candidates: direct.length + expansions.length,
      budget_chars: maxChars,
      loaded_chars: maxChars - remaining,
      degraded: false,
    };
  }

  return { listSources, resolveSource, loadGraph, readPage, recallDraft, recallForTask, normalizeGraph };
}

module.exports = { createKnowledgeSourceService, safeWikiId, resolveInside };
