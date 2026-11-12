'use strict';

/**
 * Graph Generator Engine
 *
 * Auto-generates a hierarchical knowledge graph for any topic using AI.
 * Pipeline: planStructure → enrichNodes → buildWikiFiles
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { generateWikiFiles } = require('./generate-wiki.js');
const { EDGE_TYPE, LEVEL_TYPE_NAMES, normalizeNode } = require('./graph-schema');

// ── AI Model Routes (from shared config) ──
const { API_ROUTES, getAvailableModels: sharedGetAvailableModels } = require('../config/api-keys');

// ── Single-turn LLM call ──
function callLLM(modelId, prompt, maxTokens) {
  const route = API_ROUTES[modelId];
  const apiKey = route.getKey();
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens || 4096,
      temperature: 0.7,
    });
    const options = {
      hostname: route.host,
      port: 443,
      path: route.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = https.request(options, proxyRes => {
      let data = '';
      proxyRes.on('data', chunk => (data += chunk));
      proxyRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          else resolve(parsed.choices?.[0]?.message?.content || data);
        } catch { resolve(data); }
      });
    });
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('LLM call timed out after 90s')); });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── Robust JSON extraction from LLM output ──
function extractJSON(text) {
  // Try parsing as-is first
  try { return JSON.parse(text); } catch { /* fall through */ }
  // Try extracting from markdown code fences
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) try { return JSON.parse(m[1].trim()); } catch { /* fall through */ }
  // Try finding the first { and last }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  throw new Error('无法从 AI 输出中解析 JSON');
}

// ── Generic HTTPS GET / JSON fetch ──
function httpsGetJSON(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : require('http');
    client.get(urlObj, { timeout: 8000 }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('parse failed')); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

// ── Phase 0: Web Research ──
async function researchTopic(topic) {
  const sources = [];

  // Try Chinese Wikipedia
  try {
    const zhData = await httpsGetJSON(
      `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}?redirect=true`
    );
    if (zhData && zhData.extract) {
      sources.push({ source: '维基百科(中文)', title: zhData.title, content: zhData.extract.slice(0, 5000), url: zhData.content_urls?.desktop?.page });
    }
  } catch {}

  // Fallback: English Wikipedia
  if (sources.length === 0) {
    try {
      const enData = await httpsGetJSON(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}?redirect=true`
      );
      if (enData && enData.extract) {
        sources.push({ source: 'Wikipedia(EN)', title: enData.title, content: enData.extract.slice(0, 5000), url: enData.content_urls?.desktop?.page });
      }
    } catch {}
  }

  // If we got a Wikipedia article, also fetch its section outline
  if (sources.length > 0) {
    const title = sources[0].title;
    const lang = sources[0].source.includes('中文') ? 'zh' : 'en';
    try {
      const sectionsData = await httpsGetJSON(
        `https://${lang}.wikipedia.org/api/rest_v1/page/sections/${encodeURIComponent(title)}`
      );
      if (Array.isArray(sectionsData)) {
        const outline = sectionsData
          .filter(s => s.level <= 2) // only top-level headings
          .map(s => '  '.repeat(Math.max(0, s.level - 1)) + '- ' + s.line.replace(/<[^>]+>/g, ''))
          .join('\n');
        if (outline) sources.push({ source: '章节大纲', content: outline });
      }
    } catch {}
  }

  // Try DuckDuckGo Instant Answer as supplement
  try {
    const ddgData = await httpsGetJSON(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(topic)}&format=json&no_html=1&skip_disambig=1`
    );
    if (ddgData && ddgData.AbstractText) {
      sources.push({ source: 'DuckDuckGo', content: ddgData.AbstractText.slice(0, 3000) });
    }
  } catch {}

  return sources;
}

// Format research results as context string for LLM prompts
function formatResearchContext(sources) {
  if (!sources || sources.length === 0) return '';
  let ctx = '\n\n--- 以下是从网络搜集的参考资料 ---\n';
  for (const s of sources) {
    ctx += `\n【${s.source}${s.title ? ': ' + s.title : ''}】\n${s.content}\n`;
  }
  ctx += '\n--- 参考资料结束 ---\n请基于以上资料和你自身的知识来设计知识图谱。';
  return ctx;
}
function sanitizeTopic(topic) {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ── Build edges from parent hierarchy + cross references ──
function buildEdges(nodes, crossEdges) {
  const edges = [];
  // Parent → child edges
  for (const node of nodes) {
    if (node.parent) edges.push({ source: node.parent, target: node.id, type: EDGE_TYPE.PARENT });
  }
  // Cross edges
  if (crossEdges) {
    for (const e of crossEdges) edges.push({ source: e.source || e.s, target: e.target || e.t, type: EDGE_TYPE.CROSS });
  }
  // Deduplicate
  const seen = new Set();
  return edges.filter(e => {
    const key = `${e.source}|${e.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Compute graph metrics (degree, orphan status) from edges ──
function computeGraphMetrics(nodes, edges) {
  const inDeg = {};
  const outDeg = {};
  for (const n of nodes) { inDeg[n.id] = 0; outDeg[n.id] = 0; }
  for (const e of edges) {
    const src = e.source || e.s;
    const tgt = e.target || e.t;
    if (inDeg.hasOwnProperty(tgt)) inDeg[tgt]++;
    if (outDeg.hasOwnProperty(src)) outDeg[src]++;
  }
  for (const n of nodes) {
    n.inDegree = inDeg[n.id] || 0;
    n.outDegree = outDeg[n.id] || 0;
    n.degree = n.inDegree + n.outDegree;
    n.orphan = n.degree === 0;
    n.broken = false;
  }
  return nodes;
}

// ── Validate outline structure ──
function validateOutline(data) {
  if (!data || !Array.isArray(data.nodes)) throw new Error('AI 输出缺少 nodes 数组');
  if (data.nodes.length < 5) throw new Error(`节点数太少 (${data.nodes.length})，请尝试更宽泛的主题`);

  const ids = new Set(data.nodes.map(n => n.id));
  for (const node of data.nodes) {
    if (!node.id || !node.label) throw new Error(`节点缺少 id 或 label: ${JSON.stringify(node)}`);
    if (node.level < 0 || node.level > 3) throw new Error(`节点 ${node.id} level 不在 0-3 范围内`);
    if (node.parent && !ids.has(node.parent)) throw new Error(`节点 ${node.id} 的父节点 ${node.parent} 不存在`);
    if (node.level > 0 && !node.parent) throw new Error(`节点 ${node.id} (level ${node.level}) 缺少 parent`);
  }
  return true;
}

// ── Phase 1: Plan knowledge structure ──
async function planStructure(topic, modelId, researchContext, scale) {
  scale = scale || 'medium';
  var limits = {
    small:  { l0: '3-8', l1: '8-12', l2: '15-30', l3: '0-15', total: '30-60' },
    medium: { l0: '5-12', l1: '12-25', l2: '30-60', l3: '15-40', total: '70-120' },
    large:  { l0: '10-18', l1: '25-40', l2: '60-100', l3: '30-60', total: '120-180' },
  };
  var L = limits[scale] || limits.medium;

  const refSection = researchContext
    ? `\n\n## 参考资料（请基于以下网络搜集的真实资料来设计，确保准确性）：\n${researchContext}`
    : '';
  const prompt = `你是一位知识图谱架构师。请为"${topic}"设计一个层次化知识图谱。${refSection}

只输出纯 JSON（不要 markdown 代码块，不要其他文字）：
{
  "title": "${topic}知识图谱",
  "nodes": [
    { "id": "concept-id", "label": "中文名称", "level": 0, "parent": null }
  ],
  "crossEdges": [
    { "source": "node-a", "target": "node-b" }
  ]
}

规则：
- id 使用英文小写 kebab-case（如 gradient-descent），id 中不要包含中文或特殊字符，尽量短
- label 使用中文名称，简洁明了，控制在10个字以内
- 层级分布：L0(顶层分类, ${L.l0}个), L1(次级分类, ${L.l1}个), L2(具体条目, ${L.l2}个), L3(细节/变体, ${L.l3}个)
- L1-L3 必须有 parent 指向上一层的真实节点 id
- 每个节点只需 id、label、level、parent 四个字段，不要 definition（后续会补充）
- crossEdges 连接不同分支的相关节点，每条边用简短的英文 id
- 总节点数严格控制在 ${L.total} 个，不要超出上限
- 确保输出是合法的完整 JSON，能在 JavaScript 中 JSON.parse 成功
- 只输出 JSON，不要任何其他文字`;

  var text, data;
  var lastError = null;

  try {
    text = await callLLM(modelId, prompt, 8192);
    data = extractJSON(text);
    validateOutline(data);
    return data;
  } catch (e) {
    lastError = e;
    var preview = text ? (text.length > 500 ? text.substring(0, 300) + '\n...[truncated]...\n' + text.substring(text.length - 200) : text) : '(no output)';
    throw new Error('Plan phase failed (' + text.length + ' chars). The model output may have been truncated — try a slightly narrower topic. Preview:\n' + preview);
  }
}

// ── Phase 1b: Expand a single category with sub-nodes ──
async function expandCategory(categoryName, categoryId, modelId, researchContext) {
  const refSection = researchContext
    ? `\n\n参考资料：\n${researchContext.slice(0, 3000)}`
    : '';
  const prompt = `你是一位知识图谱架构师。请为"${categoryName}"这个分类扩展详细的子节点树。

只输出纯 JSON（不要 markdown 代码块）：
{
  "nodes": [
    { "id": "concept-id", "label": "中文名称", "level": 1, "parent": "${categoryId}" }
  ],
  "crossEdges": []
}

规则：
- L1(level=1): 该分类下的主要子类别或核心条目（6-12个），id用英文kebab-case
- L2(level=2): 每个L1条目的具体内容、子项、细节点（15-30个）
- L3(level=3): 更细致的补充条目（5-15个，可选）
- 总节点数控制在30-50个，每个节点只含id/label/level/parent四个字段
- parent必须指向已存在的节点id（L1→${categoryId}，L2→对应L1的id，L3→对应L2的id）
- label简洁，控制在15字以内
- 根据主题特点灵活决定节点内容（可以是人物、概念、技术、事件、算法、理论等，由主题决定）
- 确保输出在JavaScript中JSON.parse成功
- 只输出JSON`;

  const text = await callLLM(modelId, prompt, 8192);
  const data = extractJSON(text);
  if (!data || !Array.isArray(data.nodes)) throw new Error('expandCategory: 输出缺少 nodes 数组');
  return data;
}

// ── Phase 2: Enrich nodes with detailed content ──
async function enrichNodes(nodes, modelId, onEvent, researchContext, topic) {
  const BATCH_SIZE = 8;
  const enrichedMap = {};
  const refSection = researchContext
    ? `\n\n参考资料（用于参考验证，确保内容准确）：\n${researchContext.slice(0, 5000)}`
    : '';

  for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
    const batch = nodes.slice(i, i + BATCH_SIZE);
    const end = Math.min(i + BATCH_SIZE, nodes.length);
    onEvent({
      phase: 'enrich',
      progress: i,
      total: nodes.length,
      batchLabel: `处理中 ${i + 1}-${end}/${nodes.length}`,
      currentNode: batch[0]?.label,
    });

    const batchInfo = batch.map(function(n) { return '- ' + n.id + ': ' + n.label + ' (level ' + n.level + ', 定义: ' + (n.definition || '').substring(0, 100) + ')'; }).join('\n');
    const prompt = '你正在为知识图谱"' + topic + '"丰富节点内容。请为以下每个节点提供详尽、具体、信息量大的内容。每个节点都要认真对待，杜绝空话套话。' + refSection + '\n\n输出一个纯 JSON 数组（不要 markdown 代码块）：[\n  {\n    "id": "node-id",\n    "definition": "该节点的详细定义/介绍（2-4句话，中文）",\n    "concepts": ["相关概念1", "相关概念2", ...],\n    "keyPoints": ["详细要点1", "详细要点2", ...],\n    "formulas": [{"title": "公式名", "latex": "LaTeX代码", "explanation": "公式说明"}],\n    "questions": [{"q": "思考问题", "a": "参考答案"}],\n    "problems": [{"q": "深入问题", "a": "答案", "type": "choice或judgment或discussion"}]\n  }\n]\n\n要求（内容详实，严禁空话）：\n- definition: 2-3句核心介绍，包含关键信息\n- concepts: 3-6个核心概念或贡献\n- keyPoints: 3-6个详细要点，含具体事实/时间/数据\n- formulas: 有则给出LaTeX+说明，无则空数组\n- questions: 1-2个思考问答\n- problems: 1个练习题（choice/judgment/discussion，含答案）\n- 只输出JSON，确保每条完整不截断\n\n节点列表：\n' + batchInfo;

    var enrichedData = null;
    var lastErr = null;
    for (var attempt = 0; attempt <= 2; attempt++) {
      try {
        const text = await callLLM(modelId, prompt, 8192);
        enrichedData = extractJSON(text);
        if (Array.isArray(enrichedData)) break;
        lastErr = new Error('enrich output is not array');
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 500 * Math.pow(3, attempt)));
          onEvent({ phase: 'enrich_warn', message: `批次 ${i + 1}-${end} 重试 ${attempt + 1}/2: ${err.message}` });
        }
      }
    }
    if (Array.isArray(enrichedData)) {
      for (const item of enrichedData) {
        if (item && item.id) enrichedMap[item.id] = item;
      }
    } else if (lastErr) {
      onEvent({ phase: 'enrich_warn', message: `批次 ${i + 1}-${end} 处理失败(已重试2次): ${lastErr.message}` });
    }

    // Delay between batches to avoid rate limits
    if (i + BATCH_SIZE < nodes.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Merge enrichment back into nodes
  for (const node of nodes) {
    const e = enrichedMap[node.id];
    if (e) {
      if (e.definition) node.definition = e.definition;
      node.concepts = e.concepts || [];
      node.keyPoints = e.keyPoints || [];
      node.formulas = e.formulas || [];
      node.questions = e.questions || [];
      node.problems = e.problems || [];
    } else {
      node.concepts = [];
      node.keyPoints = [];
      node.formulas = [];
      node.questions = [];
      node.problems = [];
    }
  }

  onEvent({ phase: 'enrich', progress: nodes.length, total: nodes.length, batchLabel: '内容丰富完成' });
  return nodes;
}

// ── Check available models ──
function getAvailableModels() {
  return sharedGetAvailableModels();
}

function validateModel(modelId) {
  const route = API_ROUTES[modelId];
  if (!route) throw new Error(`不支持的模型: ${modelId}，可选: ${Object.keys(API_ROUTES).join(', ')}`);
  if (!route.getKey()) throw new Error(`模型 ${modelId} 未配置 API Key`);
  return route;
}

// ── Main generation pipeline ──
async function generateGraph(topic, modelId, onEvent) {
  // Validate model
  validateModel(modelId);

  const safeName = sanitizeTopic(topic);
  const wikiDir = path.join(__dirname, 'generated', safeName, 'wiki');

  // Phase 0: Web Research
  onEvent({ phase: 'research', message: '正在搜集网络资料...', topic });
  let researchContext = '';
  try {
    const sources = await researchTopic(topic);
    if (sources.length > 0) {
      researchContext = formatResearchContext(sources);
      const sourceNames = sources.map(s => s.source).join(', ');
      onEvent({ phase: 'research', message: `已获取 ${sources.length} 个来源的资料：${sourceNames}` });
    } else {
      onEvent({ phase: 'research_warn', message: '未找到该主题的网络资料，将仅依赖模型知识' });
    }
  } catch (err) {
    onEvent({ phase: 'research_warn', message: '网络资料搜集失败，将仅依赖模型知识' });
  }

  // Phase 1: Plan
  onEvent({ phase: 'plan', message: '正在规划知识结构...', topic });
  const outline = await planStructure(topic, modelId, researchContext, 'large');
  onEvent({
    phase: 'plan',
    message: `结构规划完成：${outline.nodes.length} 个节点`,
    nodeCount: outline.nodes.length,
  });

  // Phase 2: Enrich
  onEvent({
    phase: 'enrich',
    message: '正在丰富节点内容...',
    progress: 0,
    total: outline.nodes.length,
  });
  const enrichedNodes = await enrichNodes(outline.nodes, modelId, onEvent, researchContext, topic);

  // Assign node types by level
  for (const n of enrichedNodes) {
    if (!n.type) n.type = LEVEL_TYPE_NAMES[n.level] || '概念';
  }

  // Phase 3: Build
  onEvent({ phase: 'build', message: '正在生成图谱文件...' });
  const edges = buildEdges(enrichedNodes, outline.crossEdges);
  computeGraphMetrics(enrichedNodes, edges);
  const fileCount = generateWikiFiles(enrichedNodes, edges, wikiDir);
  onEvent({ phase: 'build', message: `已生成 ${fileCount} 个节点文件` });

  onEvent({ phase: 'build', message: `已生成 ${fileCount} 个节点文件，正在保存图谱数据...` });
  // Save raw graph data alongside wiki files for direct access
  try {
    var graphDataPath = path.join(wikiDir, 'graph-data.json');
    var nodesForExport = enrichedNodes.map(function(n) { return normalizeNode(n); });
    fs.writeFileSync(graphDataPath, JSON.stringify({ title: outline.title, nodes: nodesForExport, edges: edges }, null, 2), 'utf8');
    onEvent({ phase: 'build', message: `图谱数据已保存至 ${graphDataPath}` });
  } catch (saveErr) {
    onEvent({ phase: 'build_warn', message: '图谱数据保存失败: ' + saveErr.message });
  }

  return {
    title: outline.title,
    nodes: enrichedNodes,
    edges,
    nodeCount: enrichedNodes.length,
    edgeCount: edges.length,
    wikiDir,
    safeName,
  };
}

// ── Expanded generation: multi-call for truly large graphs ──
// L0 nodes from planStructure are auto-used as expansion categories
async function generateGraphExpanded(topic, modelId, onEvent) {
  validateModel(modelId);

  const safeName = sanitizeTopic(topic);
  const wikiDir = path.join(__dirname, 'generated', safeName, 'wiki');

  // Phase 0: Web Research
  onEvent({ phase: 'research', message: '正在搜集网络资料...', topic });
  let researchContext = '';
  try {
    const sources = await researchTopic(topic);
    if (sources.length > 0) {
      researchContext = formatResearchContext(sources);
      onEvent({ phase: 'research', message: `已获取 ${sources.length} 个来源的资料` });
    }
  } catch (err) {
    onEvent({ phase: 'research_warn', message: '网络资料搜集失败' });
  }

  // Phase 1a: Plan top-level structure (L0 categories + L1 items)
  onEvent({ phase: 'plan', message: '正在规划顶层分类...' });
  const outline = await planStructure(topic, modelId, researchContext, 'large');

  // Extract L0 categories from the outline itself (no hardcoded IDs)
  var l0Categories = outline.nodes.filter(function(n) { return n.level === 0; });
  if (l0Categories.length === 0) {
    l0Categories = outline.nodes.filter(function(n) { return n.level <= 1; }).slice(0, 8);
  }
  onEvent({ phase: 'plan', message: `提取到 ${l0Categories.length} 个顶层分类，将逐个扩展` });

  // Phase 1b: Expand each L0 category with sub-items + details
  var allNodes = [];
  var allCrossEdges = outline.crossEdges || [];

  for (var i = 0; i < l0Categories.length; i++) {
    var cat = l0Categories[i];

    onEvent({
      phase: 'enrich',
      progress: i,
      total: l0Categories.length,
      batchLabel: `扩展分类 ${i + 1}/${l0Categories.length}: ${cat.label}`,
      currentNode: cat.label,
    });

    try {
      var expanded = await expandCategory(cat.label, cat.id, modelId, researchContext);
      if (expanded && expanded.nodes) {
        var catLevel = cat.level || 0;
        expanded.nodes.forEach(function(n) {
          n.level = (n.level || 1) + catLevel;
          if (!n.parent && n.level > 0) n.parent = cat.id;
        });
        allNodes = allNodes.concat(expanded.nodes);
        if (expanded.crossEdges) allCrossEdges = allCrossEdges.concat(expanded.crossEdges);
        onEvent({ phase: 'enrich', progress: i + 1, total: l0Categories.length, batchLabel: `${cat.label}: +${expanded.nodes.length} 个节点` });
      }
    } catch (err) {
      onEvent({ phase: 'enrich_warn', message: `分类 ${cat.label} 扩展失败: ${err.message}` });
    }

    // Delay between categories
    if (i < l0Categories.length - 1) {
      await new Promise(function(r) { return setTimeout(r, 2000); });
    }
  }

  // Merge: keep L0 nodes + all expanded nodes (deduplicate by id)
  var seenIds = new Set();
  var mergedNodes = [];
  outline.nodes.forEach(function(n) { if (!seenIds.has(n.id)) { seenIds.add(n.id); mergedNodes.push(n); } });
  allNodes.forEach(function(n) { if (!seenIds.has(n.id)) { seenIds.add(n.id); mergedNodes.push(n); } });
  // Remove L1+ nodes from original outline that now have duplicates from expansion
  // Actually: expansion only produces new nodes under each L0. Original L1-L3 from planStructure
  // are extra nodes the AI added top-level. Keep all unique nodes.
  onEvent({
    phase: 'plan',
    message: `分类扩展完成：${mergedNodes.length} 个节点 (${l0Categories.length} 个分类)`,
    nodeCount: mergedNodes.length,
  });

  // Phase 2: Enrich all nodes
  onEvent({ phase: 'enrich', message: '正在丰富节点内容...', progress: 0, total: mergedNodes.length });
  var enrichedNodes = await enrichNodes(mergedNodes, modelId, onEvent, researchContext, topic);

  // Assign node types by level
  for (const n of enrichedNodes) {
    if (!n.type) n.type = LEVEL_TYPE_NAMES[n.level] || '概念';
  }

  // Phase 3: Build
  onEvent({ phase: 'build', message: '正在生成图谱文件...' });
  var edges = buildEdges(enrichedNodes, allCrossEdges);
  computeGraphMetrics(enrichedNodes, edges);
  var fileCount = generateWikiFiles(enrichedNodes, edges, wikiDir);
  onEvent({ phase: 'build', message: `已生成 ${fileCount} 个节点文件` });

  // Save graph-data.json
  try {
    var graphDataPath = path.join(wikiDir, 'graph-data.json');
    var nodesForExport = enrichedNodes.map(function(n) { return normalizeNode(n); });
    fs.writeFileSync(graphDataPath, JSON.stringify({ title: outline.title, nodes: nodesForExport, edges: edges }, null, 2), 'utf8');
    onEvent({ phase: 'build', message: `图谱数据已保存至 ${graphDataPath}` });
  } catch (saveErr) {
    onEvent({ phase: 'build_warn', message: '图谱数据保存失败: ' + saveErr.message });
  }

  return {
    title: outline.title,
    nodes: enrichedNodes,
    edges: edges,
    nodeCount: enrichedNodes.length,
    edgeCount: edges.length,
    wikiDir: wikiDir,
    safeName: safeName,
  };
}

module.exports = {
  generateGraph,
  generateGraphExpanded,
  expandCategory,
  getAvailableModels,
  validateModel,
  API_ROUTES,
  callLLM,
  extractJSON,
  httpsGetJSON,
  formatResearchContext,
  researchTopic,
};
