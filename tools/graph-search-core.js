'use strict';

/**
 * 图谱实体检索核心 — 多路召回（词法 + 向量）+ RRF 融合。
 * routes/knowledge-qa-api.js（HTTP 端点）与 tools/unified-search.js（统一检索）共用。
 *
 * 兼容两种节点结构：
 *   - 嵌套：{ id, type, properties: { name, ... } }
 *   - 扁平：{ id, type, name, ... }（bank-semantic-graph 使用）
 */

const fs = require('node:fs');
const path = require('node:path');

function loadGraph(graphId) {
  var candidates = [
    path.join(__dirname, '..', 'data', 'graphs', graphId + '.json'),
    path.join(__dirname, '..', 'wiki', graphId + '.json'),
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) {
      var raw = fs.readFileSync(candidates[i], 'utf-8');
      var graphData = JSON.parse(raw);
      var nodes = graphData.nodes || graphData.vertices || [];
      var edges = graphData.edges || graphData.links || graphData.relations || [];
      var nodeMap = {};
      nodes.forEach(function(n) { nodeMap[String(n.id)] = n; });
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
      return { nodes: nodes, edges: edges, nodeMap: nodeMap, typedAdj: typedAdj, graphData: graphData };
    }
  }
  return null;
}

function nodeLabel(n) {
  return String((n.properties && (n.properties.name || n.properties.label)) || n.label || n.name || n.title || n.id || '');
}

/** 兼容扁平/嵌套结构，返回节点的属性对象 */
function nodeProps(n) {
  return n.properties || n;
}

function nodeSummary(n) {
  var label = nodeLabel(n);
  var type = n.type || '';
  var props = nodeProps(n);
  var propParts = [];
  var skipKeys = ['VERTEX_ID', 'PERSON_ID', 'SSIC_ID', 'EDGE_ID', 'SOURCE_ID', 'TARGET_ID', 'alias', 'name', 'label', 'id', 'type', 'code'];
  Object.keys(props).forEach(function(k) {
    if (skipKeys.indexOf(k) >= 0) return;
    var v = props[k];
    if (typeof v === 'string' && v && v !== label) {
      propParts.push(k + '=' + v);
    } else if (Array.isArray(v) && v.length > 0) {
      propParts.push(k + '=' + v.join(','));
    }
  });
  var result = { id: String(n.id), label: label, type: type };
  if (propParts.length > 0) result.properties = propParts.join(', ');
  return result;
}

// ── 词法匹配字段 ──
// string 字段：滑动窗口匹配，命中 score += 2
var LEXICAL_STRING_FIELDS = [
  'name', 'category', 'riskLevel', 'duration', 'returnRate',
  'purchaseFee', 'redemptionFee', 'managementFee', 'purchaseChannel',
  'accountType', 'description', 'cardType', 'annualFee', 'annualFeeWaiver',
  'creditLimitRange', 'interestFreePeriod', 'loanType', 'minRate', 'maxRate',
  'repaymentMethod', 'serviceCategory', 'definition', 'level',
  'ruleType', 'scope', 'content'
];
// array 字段：精确匹配，命中 score += 3
var LEXICAL_ARRAY_FIELDS = ['tags', 'relatedTerms', 'capabilities'];

/**
 * 词法实体搜索（同步，向后兼容）
 * 兼容扁平/嵌套结构，通用属性匹配替代硬编码 HR 字段。
 */
function searchEntitiesCore(graphId, query, topK) {
  topK = topK || 10;
  if (!query || !graphId) return { ok: false, status: 400, error: 'Missing graphId or query' };

  var g = loadGraph(graphId);
  if (!g) return { ok: false, status: 404, error: 'Graph not found: ' + graphId };

  var qLower = query.toLowerCase();
  var stopChars = '的是谁哪什么吗呢了在有个人这那都把给被让从到对于关于以及和与或而且但';
  function stripStop(s) { return s.replace(new RegExp('[' + stopChars + ']', 'g'), ''); }
  var qStripped = stripStop(qLower);

  var scoredNodes = [];
  g.nodes.forEach(function(n, idx) {
    var label = nodeLabel(n).toLowerCase();
    var score = 0;
    // 反向匹配：节点标签出现在查询中
    if (label.length >= 2 && qLower.indexOf(label) >= 0) score += Math.max(3, label.length);
    // 滑动窗口匹配（name 字段）
    for (var len = Math.min(qStripped.length, 6); len >= 2; len--) {
      for (var i = 0; i <= qStripped.length - len; i++) {
        var token = qStripped.slice(i, i + len);
        if (label.indexOf(token) >= 0) score += 2;
      }
    }
    // 通用属性匹配
    var props = nodeProps(n);
    LEXICAL_STRING_FIELDS.forEach(function(k) {
      if (props[k] && typeof props[k] === 'string') {
        var v = props[k].toLowerCase();
        if (v.length >= 2) {
          // 反向匹配：属性值出现在 query 中
          if (qLower.indexOf(v) >= 0) score += 3;
          // 正向匹配：query 的滑动窗口 token 出现在属性值中
          for (var len2 = Math.min(qStripped.length, 6); len2 >= 2; len2--) {
            for (var i2 = 0; i2 <= qStripped.length - len2; i2++) {
              var tok = qStripped.slice(i2, i2 + len2);
              if (v.indexOf(tok) >= 0) score += 2;
            }
          }
        }
      }
    });
    LEXICAL_ARRAY_FIELDS.forEach(function(k) {
      if (Array.isArray(props[k])) {
        props[k].forEach(function(tag) {
          var t = String(tag).toLowerCase();
          if (t.length >= 2 && qLower.indexOf(t) >= 0) score += 3;
        });
      }
    });
    if (score > 0) scoredNodes.push({ node: n, index: idx, score: score });
  });
  scoredNodes.sort(function(a, b) { return b.score - a.score; });
  scoredNodes = scoredNodes.slice(0, topK);

  var results = scoredNodes.map(function(sn) {
    var s = nodeSummary(sn.node);
    s.score = sn.score;
    return s;
  });
  return { ok: true, entities: results };
}

// ── 向量匹配 ──

/**
 * 构造节点的 embedding 文本（仅描述性文本 + 标签类字段）。
 * 排除枚举型/数值型字段（riskLevel=R3, minInvest=100 等），
 * 只保留有语义价值的自然语言内容。
 */
function nodeEmbeddingText(n) {
  var props = nodeProps(n);
  var parts = [];
  if (props.name) parts.push(props.name);
  // 描述性文本字段（按节点类型差异化）
  if (props.definition) parts.push(props.definition);
  if (props.content) parts.push(props.content);
  if (props.description) parts.push(props.description);
  // 标签类字段
  if (Array.isArray(props.tags)) parts.push(props.tags.join(' '));
  if (Array.isArray(props.relatedTerms)) parts.push(props.relatedTerms.join(' '));
  if (Array.isArray(props.capabilities)) parts.push(props.capabilities.join(' '));
  return parts.join('。');
}

// embedding 缓存：graphId → { nodeTexts: {}, nodeVectors: {} }
var _embeddingCache = {};

/**
 * 向量检索（异步，需 embedding 服务可用）
 * @returns {ok:true, entities:[{id,label,type,properties?,score,lexicalRank?}]}
 */
async function vectorSearchCore(graphId, query, topK) {
  topK = topK || 10;
  var embedding = require('./embedding');

  var g = loadGraph(graphId);
  if (!g) return { ok: false, status: 404, error: 'Graph not found: ' + graphId };

  // 确保节点 embedding 已生成
  if (!_embeddingCache[graphId]) {
    var texts = g.nodes.map(function(n) { return nodeEmbeddingText(n); });
    var vectors = await embedding.embedMany(texts);
    _embeddingCache[graphId] = vectors;
  }
  var nodeVectors = _embeddingCache[graphId];

  // query 向量化
  var queryVec = await embedding.embed(query);
  if (!queryVec) return { ok: true, entities: [] }; // 无 key 时返回空

  var scored = [];
  g.nodes.forEach(function(n, idx) {
    var vec = nodeVectors[idx];
    if (!vec) return;
    var sim = embedding.cosine(queryVec, vec);
    if (sim > 0.01) scored.push({ node: n, index: idx, score: sim });
  });
  scored.sort(function(a, b) { return b.score - a.score; });
  scored = scored.slice(0, topK);

  var results = scored.map(function(sn) {
    var s = nodeSummary(sn.node);
    s.score = sn.score;
    return s;
  });
  return { ok: true, entities: results };
}

// ── RRF 融合 ──

/**
 * Reciprocal Rank Fusion — 只用排名，不关心原始分值量纲。
 * @param {Array} lexicalResults  词法结果 [{id, ...}]
 * @param {Array} vectorResults   向量结果 [{id, ...}]
 * @param {number} k              RRF 常数（默认 60）
 */
function rrfFusion(lexicalResults, vectorResults, k) {
  k = k || 60;
  var scoreMap = {};

  lexicalResults.forEach(function(r, i) {
    var id = String(r.id);
    if (!scoreMap[id]) scoreMap[id] = { entity: r, rrfScore: 0 };
    scoreMap[id].rrfScore += 1.0 / (k + i + 1);
    scoreMap[id].lexicalRank = i + 1;
  });

  vectorResults.forEach(function(r, i) {
    var id = String(r.id);
    if (!scoreMap[id]) scoreMap[id] = { entity: r, rrfScore: 0 };
    scoreMap[id].rrfScore += 1.0 / (k + i + 1);
    scoreMap[id].vectorRank = i + 1;
  });

  var merged = Object.keys(scoreMap).map(function(id) { return scoreMap[id]; });
  merged.sort(function(a, b) { return b.rrfScore - a.rrfScore; });
  return merged;
}

// ── 混合检索（词法 + 向量 + RRF 融合）──

/**
 * 多路召回融合搜索（异步）。
 * 无 embedding key 时自动降级为纯词法。
 * @returns {ok:true, entities:[{id,label,type,properties?,score,lexicalRank?,vectorRank?}]}
 */
async function searchEntitiesHybrid(graphId, query, topK) {
  topK = topK || 10;

  if (!query || !graphId) return { ok: false, status: 400, error: 'Missing graphId or query' };

  // 路径A：词法（同步）
  var lexicalRes = searchEntitiesCore(graphId, query, topK * 2);
  if (!lexicalRes.ok) return lexicalRes;

  // 路径B：向量（异步，失败时降级）
  var vectorRes;
  try {
    var embedding = require('./embedding');
    if (embedding.isAvailable()) {
      vectorRes = await vectorSearchCore(graphId, query, topK * 2);
    } else {
      vectorRes = { ok: true, entities: [] };
    }
  } catch (e) {
    vectorRes = { ok: true, entities: [] };
  }

  // RRF 融合
  var fused = rrfFusion(lexicalRes.entities, vectorRes.ok ? vectorRes.entities : [], 60);
  var results = fused.slice(0, topK).map(function(f) {
    var s = f.entity;
    s.score = f.rrfScore;
    if (f.lexicalRank) s.lexicalRank = f.lexicalRank;
    if (f.vectorRank) s.vectorRank = f.vectorRank;
    return s;
  });
  return { ok: true, entities: results };
}

module.exports = {
  loadGraph: loadGraph,
  nodeLabel: nodeLabel,
  nodeProps: nodeProps,
  nodeSummary: nodeSummary,
  nodeEmbeddingText: nodeEmbeddingText,
  searchEntitiesCore: searchEntitiesCore,
  vectorSearchCore: vectorSearchCore,
  rrfFusion: rrfFusion,
  searchEntitiesHybrid: searchEntitiesHybrid,
};
