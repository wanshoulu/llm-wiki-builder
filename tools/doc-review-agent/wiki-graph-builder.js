/**
 * Wiki 图谱构建器 — doc-rules 知识库的加权关系图谱（页面级，四信号模型）
 *
 * 复用 llm-wiki-engine GraphBuilder 的四信号边权重设计：
 *   direct         直接引用 ×3.0（[[wikilinks]] + superseded_by；双向互链 +3.0）
 *   source_overlap 同源重叠 ×4.0（frontmatter sources 交集，权重最高）
 *   adamic_adar    共同邻居 ×1.5（仅贡献 ≥1.5 时建隐式边，防全连接噪音）
 *   type_affinity  类型亲和 ×1.0（仅已有边 bonus）
 * 权重归一化 0-10。
 *
 * 消费方：
 *   - GET /api/knowledge/doc-review-agent/wiki-graph  前端图谱可视化
 *   - knowledge-recaller 图谱邻域召回：文种页作种子节点，沿边推理展开审核规则集
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 解析 frontmatter：type / sources 数组 / source 字符串 / superseded_by
function parseFrontmatterInfo(content) {
  var info = { type: 'concept', sources: [], supersededBy: '' };
  var fmM = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmM) return info;
  var fm = fmM[1];
  var tm = fm.match(/^type:\s*"?([^"\n]+)"?/m);
  if (tm) info.type = tm[1].trim().toLowerCase();
  var sm = fm.match(/^sources:\s*\[([^\]]*)\]/m);
  if (sm) {
    info.sources = sm[1].split(',').map(function(s) { return s.trim().replace(/[\[\]'"]/g, ''); }).filter(Boolean);
  } else {
    var ss = fm.match(/^source:\s*"?([^"\n]+)"?/m);
    if (ss) info.sources = [ss[1].trim()];
  }
  var sb = fm.match(/^superseded_by:\s*"?([^"\n]+)"?/m);
  if (sb) info.supersededBy = sb[1].trim().replace(/^\[\[|\]\]$/g, '');
  return info;
}

/**
 * 构建 doc-rules 加权图谱
 * @param {string} wikiRoot wiki 根目录
 * @returns {{ nodes: Array, edges: Array, stats: Object }}
 */
function buildGraph(wikiRoot) {
  var pages = [];
  var nodeIds = {};

  (function scanDir(dir, relRoot) {
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    entries.forEach(function(entry) {
      if (entry.name.startsWith('.')) return;
      var full = path.join(dir, entry.name);
      var rel = relRoot ? relRoot + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { scanDir(full, rel); return; }
      if (!entry.name.endsWith('.md')) return;
      var id = rel.replace(/\\/g, '/');
      var content = '';
      try { content = fs.readFileSync(full, 'utf8'); } catch (e) {}
      var info = parseFrontmatterInfo(content);
      var title = id;
      var tm = content.match(/^title:\s*"?([^"\n]+)"?/m);
      if (tm) title = tm[1].trim();
      var group = id.indexOf('/') >= 0 ? id.split('/')[0] : 'root';
      nodeIds[id] = true;
      nodeIds[id.replace(/\.md$/, '')] = true; // [[wikilink]] 通常不带扩展名
      pages.push({ id: id, title: title, group: group, type: info.type, sources: info.sources, supersededBy: info.supersededBy });
    });
  })(wikiRoot, '');

  function resolveLink(target) {
    var t = target.split('|')[0].trim().replace(/\\/g, '/');
    if (nodeIds[t + '.md']) return t + '.md';
    if (nodeIds[t]) return t;
    return null;
  }

  // ── 加权边构建（无向：A↔B 聚合为一条边，信号累加） ──
  var edgeMap = {}; // 'sortedPair' → { source, target, weight, signals:{}, dirCount:{} }
  function edgeKey(a, b) { return a < b ? a + '||' + b : b + '||' + a; }
  function addSignal(s, t, w, sig) {
    if (s === t) return;
    var key = edgeKey(s, t);
    if (!edgeMap[key]) edgeMap[key] = { source: s < t ? s : t, target: s < t ? t : s, weight: 0, signals: {}, dirCount: {} };
    edgeMap[key].weight += w;
    edgeMap[key].signals[sig] = true;
  }

  // 信号 1：直接链接 ×3.0（正文/related/See Also 中的 [[wikilinks]] + superseded_by 强语义）
  pages.forEach(function(p) {
    var full;
    try { full = fs.readFileSync(path.join(wikiRoot, p.id), 'utf8'); } catch (e) { return; }
    var dirCount = {};
    var re = /\[\[([^\]]+)\]\]/g;
    var m;
    while ((m = re.exec(full)) !== null) {
      var t = resolveLink(m[1]);
      if (!t || t === p.id) continue;
      dirCount[t] = (dirCount[t] || 0) + 1;
    }
    Object.keys(dirCount).forEach(function(t) {
      var key = edgeKey(p.id, t);
      if (!edgeMap[key]) edgeMap[key] = { source: p.id < t ? p.id : t, target: p.id < t ? t : p.id, weight: 0, signals: {}, dirCount: {} };
      edgeMap[key].dirCount[p.id] = dirCount[t];
      addSignal(p.id, t, 3.0, 'direct');
    });
    if (p.supersededBy) {
      var sup = resolveLink(p.supersededBy);
      if (sup) addSignal(p.id, sup, 3.0, 'direct');
    }
  });
  // 双向互链奖励 +3.0（nashsu：单向 3.0 / 双向 6.0）
  Object.keys(edgeMap).forEach(function(k) {
    var e = edgeMap[k];
    if (e.dirCount && e.dirCount[e.source] && e.dirCount[e.target]) {
      e.weight += 3.0;
      e.signals.mutual = true;
    }
  });

  // 信号 2：同源重叠 ×4.0（sources frontmatter 交集，nashsu 权重最高的信号）
  for (var i = 0; i < pages.length; i++) {
    if (!pages[i].sources.length) continue;
    for (var j = i + 1; j < pages.length; j++) {
      var overlap = pages[i].sources.filter(function(s) { return pages[j].sources.indexOf(s) >= 0; });
      if (overlap.length) {
        addSignal(pages[i].id, pages[j].id, 4.0 * Math.min(overlap.length, 2), 'source_overlap');
      }
    }
  }

  // 信号 3：共同邻居 Adamic-Adar ×1.5（仅当贡献 ≥1.5 时建隐式边，避免全连接噪音）
  var neighborMap = {};
  Object.keys(edgeMap).forEach(function(k) {
    var e = edgeMap[k];
    (neighborMap[e.source] = neighborMap[e.source] || []).push(e.target);
    (neighborMap[e.target] = neighborMap[e.target] || []).push(e.source);
  });
  for (var a = 0; a < pages.length; a++) {
    for (var b = a + 1; b < pages.length; b++) {
      var na = neighborMap[pages[a].id] || [];
      var nb = neighborMap[pages[b].id] || [];
      var common = na.filter(function(n) { return nb.indexOf(n) >= 0; });
      if (!common.length) continue;
      var aa = 0;
      common.forEach(function(n) {
        var deg = (neighborMap[n] || []).length || 1;
        aa += 1 / Math.log(deg + 1);
      });
      aa *= 1.5;
      if (aa >= 1.5) addSignal(pages[a].id, pages[b].id, aa, 'adamic_adar');
    }
  }

  // 信号 4：类型亲和 ×1.0（仅作用于已有边，作为 bonus 信号）
  Object.keys(edgeMap).forEach(function(k) {
    var e = edgeMap[k];
    var pa = pages.filter(function(p) { return p.id === e.source; })[0];
    var pb = pages.filter(function(p) { return p.id === e.target; })[0];
    if (pa && pb && pa.type && pa.type === pb.type) {
      e.weight += 1.0;
      e.signals.type_affinity = true;
    }
  });

  // ── 归一化 0-10（复用 GraphBuilder 公式） ──
  var rawEdges = Object.keys(edgeMap).map(function(k) { return edgeMap[k]; });
  var maxW = rawEdges.reduce(function(m, e) { return Math.max(m, e.weight); }, 1);
  var edges = rawEdges.map(function(e) {
    return {
      source: e.source,
      target: e.target,
      weight: Math.round(e.weight / maxW * 1000) / 100,
      signals: Object.keys(e.signals),
    };
  }).sort(function(a, b) { return b.weight - a.weight; });

  // 节点加权度（边权重和，用于节点大小/枢纽识别）
  var wdeg = {};
  edges.forEach(function(e) {
    wdeg[e.source] = (wdeg[e.source] || 0) + e.weight;
    wdeg[e.target] = (wdeg[e.target] || 0) + e.weight;
  });
  var nodes = pages.map(function(p) {
    return { id: p.id, title: p.title, group: p.group, type: p.type, weightedDegree: Math.round((wdeg[p.id] || 0) * 100) / 100 };
  });

  var weakCount = edges.filter(function(e) { return e.weight <= 2; }).length;
  var strongCount = edges.filter(function(e) { return e.weight >= 6; }).length;
  return {
    nodes: nodes,
    edges: edges,
    stats: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      strongEdges: strongCount,
      weakEdges: weakCount,
      isolatedNodes: nodes.filter(function(n) { return !wdeg[n.id]; }).length,
    },
  };
}

module.exports = {
  buildGraph: buildGraph,
  parseFrontmatterInfo: parseFrontmatterInfo,
};
