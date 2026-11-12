/**
 * GraphExtractor — LLM-driven entity & relation extraction for Knowledge Graph
 *
 * Pipeline:
 *   1. Schema-constrained entity extraction (Concept|Method|Tool|Person|Organization)
 *   2. Relation extraction (INCLUDES|PRECEDES|RELATES_TO|USES|DERIVES_FROM|PREREQUISITE_FOR)
 *   3. 2-pass Gleaning: second pass catches entities missed in first (+20-30% recall)
 *   4. Provenance tracking: every entity/relation → source document + chunk
 *   5. Fusion with signal graph (existing 4-signal GraphBuilder output)
 *
 * Usage:
 *   const { GraphExtractor } = require('./tools/graph-extractor');
 *   const ge = new GraphExtractor({ llmRoute, wikiDir });
 *   const graph = await ge.extractFromWiki(projectName);
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// ── Entity & Relation Schema ──

const ENTITY_TYPES = {
  Concept: { desc: '抽象概念、理论、思想', examples: 'transformer, attention mechanism, gradient descent' },
  Method: { desc: '具体方法、算法、技术', examples: 'SGD, Adam optimizer, backpropagation' },
  Tool: { desc: '工具、框架、库', examples: 'PyTorch, TensorFlow, Jupyter' },
  Person: { desc: '人物、研究者', examples: 'Geoffrey Hinton, Yann LeCun' },
  Organization: { desc: '组织、机构', examples: 'OpenAI, Google Brain' },
};

const RELATION_TYPES = {
  INCLUDES: { desc: '包含关系，整体包含部分', example: 'transformer INCLUDES self-attention' },
  PRECEDES: { desc: '前驱关系，A 是 B 的前置或历史基础', example: 'RNN PRECEDES transformer' },
  RELATES_TO: { desc: '相关关系，两个概念紧密关联', example: 'self-attention RELATES_TO multi-head attention' },
  USES: { desc: '使用关系，方法使用工具或另一个方法', example: 'GPT USES transformer' },
  DERIVES_FROM: { desc: '派生关系，B 从 A 派生或改进', example: 'Adam DERIVES_FROM SGD' },
  PREREQUISITE_FOR: { desc: '前置知识关系，理解 A 是理解 B 的前提', example: 'attention PREQUISITE_FOR transformer' },
};

// ── GraphExtractor Class ──

class GraphExtractor {
  constructor(options) {
    this.options = options || {};
    this.wikiDir = this.options.wikiDir || path.join(__dirname, '../wiki');
    this.llmRoute = this.options.llmRoute || null; // { host, path, apiKey, model }
    this.batchSize = this.options.batchSize || 5;   // docs per LLM call
    this.maxDocs = this.options.maxDocs || 200;      // max docs to process
    // 自定义 schema（组织图谱等垂直场景注入；缺省用知识图谱默认 schema，Knowledge Studio 行为不变）
    this.entityTypes = this.options.entityTypes || ENTITY_TYPES;
    this.relationTypes = this.options.relationTypes || RELATION_TYPES;
  }

  /**
   * Full extraction pipeline for a wiki project
   * @returns { nodes: [...], edges: [...], stats: {...} }
   */
  async extractFromWiki(projectName, options) {
    var opts = options || {};
    var startTime = Date.now();
    var wp = projectName ? path.join(this.wikiDir, projectName) : this.wikiDir;
    if (!fs.existsSync(wp)) throw new Error('Wiki project not found: ' + projectName);

    // Cache check
    var cacheFile = path.join(wp, '.graph-extracted.json');
    if (!opts.forceRebuild && fs.existsSync(cacheFile)) {
      try {
        var cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        if (cached.nodes && cached.nodes.length && cached.version) return cached;
      } catch(e) {}
    }

    // Step 1: Scan documents
    var docs = this._scanWiki(wp);
    if (!docs.length) throw new Error('No documents found');
    if (docs.length > this.maxDocs) docs = docs.slice(0, this.maxDocs);

    // Step 2-4: 两遍抽取（first + gleaning）+ 实体去重合并（公共管线，见 _runExtraction）
    var extraction = await this._runExtraction(docs, opts);
    var allEntities = extraction.rawEntities;
    var resolvedEntities = extraction.entities;
    var allRelations = extraction.relations;

    // Step 5: Build graph
    var nodes = resolvedEntities.map(function(e, i) {
      return {
        id: 'ent_' + i,
        label: e.name,
        entityType: e.type,
        description: e.description || '',
        sourceDoc: e.sourceDoc || '',
        sourceChunk: e.sourceChunk || '',
        confidence: e.confidence || 0.7,
      };
    });

    var nodeNameMap = {};
    nodes.forEach(function(n) { nodeNameMap[n.label] = n.id; });

    var edges = [];
    allRelations.forEach(function(r) {
      var srcId = nodeNameMap[r.source];
      var tgtId = nodeNameMap[r.target];
      if (srcId && tgtId && srcId !== tgtId) {
        var dup = edges.find(function(ex) { return ex.source === srcId && ex.target === tgtId && ex.relationType === r.type; });
        if (!dup) {
          edges.push({
            source: srcId, target: tgtId,
            relationType: r.type,
            weight: r.confidence || 0.7,
            sourceDoc: r.sourceDoc || '',
          });
        }
      }
    });

    var stats = {
      project: projectName || '(root)',
      documentsScanned: docs.length,
      entitiesExtracted: allEntities.length,
      entitiesResolved: nodes.length,
      relationsExtracted: edges.length,
      discardedTypeItems: extraction.discardedTypeItems || 0,
      gleaningPass: opts.gleaning !== false,
      timeMs: Date.now() - startTime,
      builtAt: new Date().toISOString(),
    };

    var result = { nodes: nodes, edges: edges, stats: stats, version: 1 };
    this._saveCache(cacheFile, result);
    return result;
  }

  /**
   * 公共抽取管线：first pass → gleaning（文档 <3 实体的二次扫描）→ 实体去重合并
   * @returns {{ rawEntities, entities, relations }} entities 为去重后的实体
   */
  async _runExtraction(docs, options) {
    var opts = options || {};
    var pass1 = await this._extractBatch(docs, 'first');
    var allEntities = pass1.entities || [];
    var allRelations = pass1.relations || [];
    var discardedTypeItems = pass1.discardedTypeItems || 0;

    if (opts.gleaning !== false) {
      var gleanDocs = docs.filter(function(d) {
        var count = allEntities.filter(function(e) { return e.sourceDoc === d.id; }).length;
        return count < 3;
      });
      if (gleanDocs.length > 0) {
        var pass2 = await this._extractBatch(gleanDocs, 'glean');
        discardedTypeItems += pass2.discardedTypeItems || 0;
        // Merge, avoiding duplicates by name+type
        var existingKeys = {};
        allEntities.forEach(function(e) { existingKeys[(e.name||'')+'::'+(e.type||'')] = true; });
        (pass2.entities || []).forEach(function(e) {
          var key = (e.name||'')+'::'+(e.type||'');
          if (!existingKeys[key]) {
            allEntities.push(e);
            existingKeys[key] = true;
          }
        });
        (pass2.relations || []).forEach(function(r) {
          var key = (r.source||'')+'::'+(r.type||'')+'::'+(r.target||'');
          if (!allRelations.find(function(x) { return (x.source+'::'+x.type+'::'+x.target) === key; })) {
            allRelations.push(r);
          }
        });
      }
    }

    var resolvedEntities = this._resolveEntities(allEntities);
    // 跨块冲突检测与解决：同名不同类型实体、重复/矛盾关系
    var conflictResult = this._detectAndResolveConflicts(resolvedEntities, allRelations);
    resolvedEntities = conflictResult.entities;
    allRelations = conflictResult.relations;
    // 跨块关系发现：分块抽取后，补抽跨块实体间遗漏的关系
    var crossChunkRels = await this._discoverCrossChunkRelations(resolvedEntities, allRelations, docs);
    if (crossChunkRels.length) allRelations = allRelations.concat(crossChunkRels);
    return {
      rawEntities: allEntities,
      entities: resolvedEntities,
      relations: allRelations,
      discardedTypeItems: discardedTypeItems,
    };
  }

  /**
   * 上传内容直抽（不落盘，不建缓存）——组织图谱等垂直场景消费
   * @param {Array} docs [{ id, title, content }]
   * @param {object} options { gleaning? }
   * @returns {{ entities, relations, stats }} 实体: {name,type,description,sourceDoc,confidence}
   */
  async extractFromContent(docs, options) {
    var opts = options || {};
    var startTime = Date.now();
    if (!docs || !docs.length) throw new Error('No documents provided');
    var extraction = await this._runExtraction(docs, opts);
    return {
      entities: extraction.entities,
      relations: extraction.relations,
      stats: {
        documentsScanned: docs.length,
        entitiesExtracted: extraction.rawEntities.length,
        entitiesResolved: extraction.entities.length,
        relationsExtracted: extraction.relations.length,
        discardedTypeItems: extraction.discardedTypeItems || 0,
        gleaningPass: opts.gleaning !== false,
        timeMs: Date.now() - startTime,
        builtAt: new Date().toISOString(),
      },
    };
  }

  /**
   * 可断点续跑的逐块抽取：completed 里已完成的 doc 直接复用（不烧 LLM），其余逐块抽取，
   * 每块成功即回调 onDocDone（调用方落盘 checkpoint，失败重试/进程重启后从断点继续）。
   * 与 _extractBatch 的关键差异：单块失败不再静默吞掉——记入 failedDocs，由调用方明示与续跑。
   * gleaning 规则与 _runExtraction 一致（first pass 实体 <3 的文档再扫一遍），但走受限并发且逐块
   * 回调 onGleanDone（调用方落盘 checkpoint，续跑不再整段重烧）；单块 gleaning 失败只计
   * stats.gleanFailed 不进 failedDocs（首抽已成功，gleaning 是增益扫描）。
   * @param {Array} docs [{ id, title, content }]
   * @param {object} options { gleaning?, completed?, gleaned?, onDocDone?, onGleanStart?, onGleanDone? }
   * @returns extractFromContent 同构结果 + { resumed, failedDocs }
   */
  async extractFromDocsResumable(docs, options) {
    var self = this;
    var opts = options || {};
    var startTime = Date.now();
    if (!docs || !docs.length) throw new Error('No documents provided');
    var completed = opts.completed || {};
    var rawEntities = [];
    var rawRelations = [];
    var failedDocs = [];
    var resumed = 0;
    var discardedTypeItems = 0;
    var gleanFailedCount = 0;

    // 受限并发抽取：qwen-plus 实测 ~128s/块，全串行长文档过慢（22 块 ≈ 47 分钟），3 并发 ≈ 16 分钟。
    // 失败隔离与逐块 checkpoint 落盘语义不变；JS 单线程下 push/计数无需加锁。
    var concurrency = Math.max(1, Math.min(Number(opts.concurrency) || 3, 8));
    var nextIndex = 0;
    var worker = async function () {
      while (nextIndex < docs.length) {
        var doc = docs[nextIndex++];
        if (completed[doc.id]) {
          rawEntities = rawEntities.concat(completed[doc.id].entities || []);
          rawRelations = rawRelations.concat(completed[doc.id].relations || []);
          resumed += 1;
          continue;
        }
        try {
          var llmOut = await self._callLLM(self._buildExtractionPrompt([doc], false, rawEntities), self._extractionSystemPrompt());
          var parsed = self._parseExtractionResult(llmOut, [doc]);
          if (parsed.parseError) {
            // 解析失败 ≠ 空结果：不落 checkpoint（下次续跑重试本块），调用方按失败块明示
            failedDocs.push({ id: doc.id, error: '解析失败: ' + parsed.parseError });
            continue;
          }
          rawEntities = rawEntities.concat(parsed.entities || []);
          rawRelations = rawRelations.concat(parsed.relations || []);
          discardedTypeItems += parsed.discardedTypeItems || 0;
          if (typeof opts.onDocDone === 'function') opts.onDocDone(doc.id, parsed.entities || [], parsed.relations || []);
        } catch (e) {
          failedDocs.push({ id: doc.id, error: String((e && e.message) || e).slice(0, 200) });
        }
      }
    };
    var workers = [];
    for (var w = 0; w < concurrency; w++) workers.push(worker());
    await Promise.all(workers);

    if (opts.gleaning !== false) {
      var entityCountByDoc = {};
      rawEntities.forEach(function (e) { entityCountByDoc[e.sourceDoc] = (entityCountByDoc[e.sourceDoc] || 0) + 1; });
      var gleanDocs = docs.filter(function (d) { return (entityCountByDoc[d.id] || 0) < 3; });
      if (gleanDocs.length > 0) {
        var gleaned = opts.gleaned || {};
        var toGlean = gleanDocs.filter(function (d) { return !gleaned[d.id]; });
        if (typeof opts.onGleanStart === 'function') opts.onGleanStart(gleanDocs.length);
        var existingKeys = {};
        rawEntities.forEach(function (e) { existingKeys[(e.name || '') + '::' + (e.type || '')] = true; });
        var existingRelKeys = {};
        rawRelations.forEach(function (r) { existingRelKeys[(r.source || '') + '::' + (r.type || '') + '::' + (r.target || '')] = true; });
        var mergeGleanResults = function (entities, relations) {
          (entities || []).forEach(function (e) {
            var key = (e.name || '') + '::' + (e.type || '');
            if (!existingKeys[key]) { rawEntities.push(e); existingKeys[key] = true; }
          });
          (relations || []).forEach(function (r) {
            var key = (r.source || '') + '::' + (r.type || '') + '::' + (r.target || '');
            if (!existingRelKeys[key]) { rawRelations.push(r); existingRelKeys[key] = true; }
          });
        };
        // checkpoint 命中的 glean 块直接复用（续跑不重烧）
        gleanDocs.forEach(function (d) {
          if (!gleaned[d.id]) return;
          mergeGleanResults(gleaned[d.id].entities || [], gleaned[d.id].relations || []);
          if (typeof opts.onGleanDone === 'function') opts.onGleanDone(d.id, gleaned[d.id].entities || [], gleaned[d.id].relations || []);
        });
        // 受限并发 gleaning（旧实现走串行 _extractBatch，大文档最坏撞 nginx 3600s 超时）
        var gleanFailed = 0;
        var gleanNext = 0;
        var gleanWorker = async function () {
          while (gleanNext < toGlean.length) {
            var gdoc = toGlean[gleanNext++];
            try {
              var llmOut = await self._callLLM(self._buildExtractionPrompt([gdoc], true, rawEntities), self._extractionSystemPrompt());
              var parsed = self._parseExtractionResult(llmOut, [gdoc]);
              if (parsed.parseError) { gleanFailed += 1; continue; }
              discardedTypeItems += parsed.discardedTypeItems || 0;
              mergeGleanResults(parsed.entities || [], parsed.relations || []);
              if (typeof opts.onGleanDone === 'function') opts.onGleanDone(gdoc.id, parsed.entities || [], parsed.relations || []);
            } catch (e) {
              gleanFailed += 1;
            }
          }
        };
        var gleanWorkers = [];
        for (var gw = 0; gw < concurrency; gw++) gleanWorkers.push(gleanWorker());
        await Promise.all(gleanWorkers);
        gleanFailedCount = gleanFailed;
      }
    }

    var resolved = this._resolveEntities(rawEntities);
    // 跨块冲突检测与解决：同名不同类型实体、重复/矛盾关系
    var conflictResult = this._detectAndResolveConflicts(resolved, rawRelations);
    resolved = conflictResult.entities;
    rawRelations = conflictResult.relations;
    // 跨块关系发现：分块抽取后，补抽跨块实体间遗漏的关系
    var crossChunkRels = await this._discoverCrossChunkRelations(resolved, rawRelations, docs);
    if (crossChunkRels.length) rawRelations = rawRelations.concat(crossChunkRels);
    return {
      entities: resolved,
      relations: rawRelations,
      resumed: resumed,
      failedDocs: failedDocs,
      stats: {
        documentsScanned: docs.length,
        entitiesExtracted: rawEntities.length,
        entitiesResolved: resolved.length,
        relationsExtracted: rawRelations.length,
        crossChunkRelations: crossChunkRels.length,
        discardedTypeItems: discardedTypeItems,
        gleaningPass: opts.gleaning !== false,
        gleanFailed: gleanFailedCount,
        timeMs: Date.now() - startTime,
        builtAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Fuse extracted graph with signal graph (from GraphBuilder)
   * Semantic edges ×3 weight, signal edges ×1 weight
   */
  fuseWithSignals(extractedGraph, signalGraph) {
    if (!signalGraph || !signalGraph.nodes) return extractedGraph;

    var fusionNodes = JSON.parse(JSON.stringify(extractedGraph.nodes));
    var fusionEdges = JSON.parse(JSON.stringify(extractedGraph.edges));

    // Map signal node names to extracted node labels
    var extLabelMap = {};
    fusionNodes.forEach(function(n) { extLabelMap[n.label.toLowerCase()] = n.id; });

    // Add signal edges with lower weight
    (signalGraph.edges || []).forEach(function(se) {
      var srcLabel = se.sourceLabel || se.source || '';
      var tgtLabel = se.targetLabel || se.target || '';
      var srcId = extLabelMap[srcLabel.toLowerCase()];
      var tgtId = extLabelMap[tgtLabel.toLowerCase()];
      if (srcId && tgtId && srcId !== tgtId) {
        var exists = fusionEdges.find(function(e) { return e.source === srcId && e.target === tgtId; });
        if (exists) {
          exists.signalWeight = (exists.signalWeight || 0) + (se.weight || 1);
          exists.weight = exists.weight * 3 + (se.weight || 1) * 1; // semantic ×3, signal ×1
        } else {
          fusionEdges.push({
            source: srcId, target: tgtId,
            relationType: se.type || 'RELATES_TO',
            weight: (se.weight || 1) * 1,
            signalWeight: se.weight || 1,
            sourceDoc: '',
          });
        }
      }
    });

    return { nodes: fusionNodes, edges: fusionEdges, stats: extractedGraph.stats, version: 2 };
  }

  /**
   * Generate LLM summaries for Louvain communities
   * @param communities — [{id, nodes: [...], cohesion}]
   * @param nodes — graph nodes
   * @returns communities with summary field added
   */
  async summarizeCommunities(communities, nodes) {
    if (!this.llmRoute || !this.llmRoute.apiKey) return communities;

    var summarized = [];
    for (var i = 0; i < communities.length; i++) {
      var comm = communities[i];
      var nodeLabels = (comm.nodes || []).map(function(nId) {
        var node = nodes.find(function(n) { return (n.id || '') === (nId || n.id || ''); });
        return node ? node.label : nId;
      }).slice(0, 30);

      if (nodeLabels.length < 2) { summarized.push(comm); continue; }

      try {
        var summary = await this._callLLM(
          '你是一个知识图谱分析专家。以下是一个知识社区中的节点列表（节点是通过LLM从技术文档中抽取的实体）。请用1-2句话描述这个社区的主题。\n\n社区节点: ' + nodeLabels.join(', ') + '\n\n社区主题描述:'
        );
        summarized.push({
          id: comm.id,
          nodes: comm.nodes,
          cohesion: comm.cohesion,
          size: comm.size,
          summary: (summary || '').trim(),
        });
      } catch(e) {
        summarized.push(comm);
      }
    }
    return summarized;
  }

  // ── Internal ──

  _scanWiki(wp) {
    var docs = [];
    function scan(dir, relRoot) {
      relRoot = relRoot || '';
      var entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e) { return; }
      entries.forEach(function(entry) {
        var fp = path.join(dir, entry.name);
        var rp = relRoot ? relRoot + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'syntheses') return;
          scan(fp, rp);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          try {
            var content = fs.readFileSync(fp, 'utf-8');
            var text = content.replace(/^---[\s\S]*?---\n*/, '').trim();
            if (text.length > 100) {
              var title = (content.match(/^#\s+(.+)$/m) || [])[1] || entry.name.replace('.md', '');
              docs.push({ id: rp, title: title, content: text.slice(0, 3000) });
            }
          } catch(e) {}
        }
      });
    }
    scan(wp);
    return docs;
  }

  async _extractBatch(docs, passType) {
    var self = this;
    var allEntities = [];
    var allRelations = [];
    var discardedTypeItems = 0;
    var batchSize = this.batchSize;

    for (var i = 0; i < docs.length; i += batchSize) {
      var batch = docs.slice(i, i + batchSize);
      var isGlean = passType === 'glean';
      var prompt = self._buildExtractionPrompt(batch, isGlean, allEntities);

      try {
        var result = await self._callLLM(prompt, self._extractionSystemPrompt());
        var parsed = self._parseExtractionResult(result, batch);
        allEntities = allEntities.concat(parsed.entities || []);
        allRelations = allRelations.concat(parsed.relations || []);
        discardedTypeItems += parsed.discardedTypeItems || 0;
      } catch(e) {
        console.error('[GraphExtractor] Batch ' + i + ' failed:', e.message);
      }
    }

    return { entities: allEntities, relations: allRelations, discardedTypeItems: discardedTypeItems };
  }

  _extractionSystemPrompt() {
    return '你是知识图谱抽取引擎。只输出严格合法的 JSON，不要输出任何解释或额外文字；'
      + '实体与关系的 type 必须逐字取自用户消息给出的类型清单，无法确定类型的条目宁可不抽，不得猜测近似类型；'
      + '原文中没有依据的实体和关系一律不输出。';
  }

  // 类型容错匹配：精确 → 忽略大小写 → 去分隔符后忽略大小写；都不中返回 null（由调用方丢弃并计数，不静默塞默认类型）
  _matchType(raw, typeMap) {
    if (raw == null) return null;
    var t = String(raw).trim();
    if (Object.prototype.hasOwnProperty.call(typeMap, t)) return t;
    var lower = t.toLowerCase();
    var keys = Object.keys(typeMap);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === lower) return keys[i];
    }
    var compact = lower.replace(/[\s\-_]+/g, '');
    for (var j = 0; j < keys.length; j++) {
      if (keys[j].toLowerCase().replace(/[\s\-_]+/g, '') === compact) return keys[j];
    }
    return null;
  }

  _buildExtractionPrompt(batch, isGlean, contextEntities) {
    var self = this;
    // 单块读取上限必须 ≥ 路由分块长度（org-graph /extract 传 4000）：截断小于块长会静默丢块尾内容
    var docsText = batch.map(function(d, i) {
      return '--- Document ' + (i+1) + ' (' + d.id + '): ' + d.title + ' ---\n' + d.content.slice(0, 4000);
    }).join('\n\n');

    var entityTypesDesc = Object.keys(self.entityTypes).map(function(t) {
      return '- ' + t + ': ' + self.entityTypes[t].desc + ' (例: ' + self.entityTypes[t].examples + ')';
    }).join('\n');

    var relationTypesDesc = Object.keys(self.relationTypes).map(function(t) {
      return '- ' + t + ': ' + self.relationTypes[t].desc + ' (例: ' + self.relationTypes[t].example + ')';
    }).join('\n');

    var gleanHint = isGlean
      ? '\n这是第二次扫描，请重点关注第一次可能遗漏的次要实体和隐含关系。提高召回率，宁可多抽不要漏。'
      : '';

    // 全局上下文：注入已抽取实体列表，促使 LLM 在不同块间使用一致命名
    var contextHint = '';
    if (contextEntities && contextEntities.length > 0) {
      // 最多 50 个，按名称去重后展示，避免 prompt 过长
      var seen = {};
      var lines = [];
      for (var i = 0; i < contextEntities.length && lines.length < 50; i++) {
        var e = contextEntities[i];
        var key = (e.name || '') + '::' + (e.type || '');
        if (seen[key]) continue;
        seen[key] = true;
        lines.push('  - ' + e.name + ' (' + e.type + ')');
      }
      contextHint = '\n\n注意：以下实体已从前序段落中抽取。如果当前段落中出现相同实体，请使用相同的名称和类型，避免重复抽取不同写法的同一实体：\n'
        + lines.join('\n') + '\n';
    }

    return '从以下文档内容中抽取实体和关系。实体类型、关系类型以下方清单为准，type 必须逐字取自清单；'
      + '无法从原文确定类型的条目宁可不抽，不得猜测。' + gleanHint + contextHint + '\n\n' +
      '实体类型:\n' + entityTypesDesc + '\n\n' +
      '关系类型:\n' + relationTypesDesc + '\n\n' +
      '文档内容:\n' + docsText + '\n\n' +
      '请严格按以下 JSON 格式输出（不要输出其他内容）:\n' +
      '{\n' +
      '  "entities": [\n' +
      '    {"name": "实体名称", "type": "' + Object.keys(self.entityTypes).join('|') + '", "description": "一句话描述", "sourceDoc": "文档ID", "confidence": 0.9}\n' +
      '  ],\n' +
      '  "relations": [\n' +
      '    {"source": "源实体名称", "type": "' + Object.keys(self.relationTypes).join('|') + '", "target": "目标实体名称", "sourceDoc": "文档ID", "confidence": 0.8}\n' +
      '  ]\n' +
      '}';
  }

  _parseExtractionResult(llmOutput, batch) {
    var self = this;
    // 先剥壳取 JSON 串（纯字符串操作不会抛错）；解析失败时 catch 用同一串做截断抢救
    var jsonStr = llmOutput;
    var codeMatch = llmOutput.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeMatch) jsonStr = codeMatch[1].trim();
    var startIdx = jsonStr.indexOf('{');
    var endIdx = jsonStr.lastIndexOf('}');
    if (startIdx >= 0 && endIdx > startIdx) {
      jsonStr = jsonStr.slice(startIdx, endIdx + 1);
    }
    try {
      var parsed = JSON.parse(jsonStr);

      // 非法 type 不再静默塞默认类型（会编造语义）——容错匹配命中则归一，否则丢弃并计数
      // （discardedTypeItems 只计类型不匹配；名称长度过滤不计入，与 9-28 口径一致）
      var coercedEntities = (parsed.entities || []).map(function(e) { return self._coerceEntity(e, batch); });
      var coercedRelations = (parsed.relations || []).map(function(r) { return self._coerceRelation(r, batch); });
      var discardedTypeItems = coercedEntities.filter(function(e) { return !e; }).length
        + coercedRelations.filter(function(r) { return !r; }).length;

      var entities = coercedEntities.filter(function(e) { return e && e.name.length > 1 && e.name.length < 100; });
      var relations = coercedRelations.filter(function(r) { return r && r.source.length > 1 && r.target.length > 1 && r.source !== r.target; });

      return { entities: entities, relations: relations, discardedTypeItems: discardedTypeItems };
    } catch(e) {
      // 截断抢救（9-28 0 实体事故防线）：max_tokens 掐断输出时，已完整闭合的实体/关系对象仍可回收
      var salvagedEntities = self._salvageObjects(jsonStr, 'entities').map(function(x) { return self._coerceEntity(x, batch); })
        .filter(function(e) { return e && e.name.length > 1 && e.name.length < 100; });
      var salvagedRelations = self._salvageObjects(jsonStr, 'relations').map(function(x) { return self._coerceRelation(x, batch); })
        .filter(function(r) { return r && r.source.length > 1 && r.target.length > 1 && r.source !== r.target; });
      if (salvagedEntities.length > 0 || salvagedRelations.length > 0) {
        console.error('[GraphExtractor] JSON 截断，抢救出 ' + salvagedEntities.length + ' 实体 / ' + salvagedRelations.length + ' 关系');
        return { entities: salvagedEntities, relations: salvagedRelations, discardedTypeItems: 0, salvaged: true };
      }
      console.error('[GraphExtractor] Parse error:', e.message, 'output preview:', llmOutput.slice(0, 200));
      // parseError 标记：可续跑通道据此记入 failedDocs（不写 checkpoint、续跑重试），不再当成功空结果缓存 7 天
      return { entities: [], relations: [], discardedTypeItems: 0, parseError: 'LLM 输出无法解析为实体 JSON: ' + String(e.message).slice(0, 180) };
    }
  }

  // 抽取条目归一（正常解析与截断抢救共用）：type 容错匹配命中则归一，不中返回 null（由调用方丢弃）
  _coerceEntity(e, batch) {
    var entityType = this._matchType(e && e.type, this.entityTypes);
    if (!entityType) return null;
    return {
      name: (e.name || '').trim(),
      type: entityType,
      description: (e.description || '').slice(0, 200),
      sourceDoc: e.sourceDoc || batch[0]?.id || '',
      sourceChunk: '',
      confidence: Math.min(1, Math.max(0, e.confidence || 0.7)),
    };
  }

  _coerceRelation(r, batch) {
    var relationType = this._matchType(r && r.type, this.relationTypes);
    if (!relationType) return null;
    return {
      source: (r.source || '').trim(),
      type: relationType,
      target: (r.target || '').trim(),
      sourceDoc: r.sourceDoc || batch[0]?.id || '',
      confidence: Math.min(1, Math.max(0, r.confidence || 0.7)),
    };
  }

  // 字符串感知扫描（inStr/esc 状态机）：从截断 JSON 里收集已完整闭合的直接子对象。
  // 深度语义：根对象 1 层不计，子对象在 2→1 闭合时回收；typeKey 决定形状过滤（entities→含 name / relations→含 source+target）
  _salvageObjects(jsonStr, typeKey) {
    var results = [];
    var inStr = false, esc = false, depth = 0, start = -1;
    for (var i = 0; i < jsonStr.length; i++) {
      var ch = jsonStr[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') { if (depth === 1) start = i; depth += 1; }
      else if (ch === '}') {
        if (depth < 2) { depth = Math.max(0, depth - 1); continue; }
        depth -= 1;
        if (depth === 1 && start >= 0) {
          try {
            var obj = JSON.parse(jsonStr.slice(start, i + 1));
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) results.push(obj);
          } catch (e) { /* 半截对象丢弃 */ }
          start = -1;
        }
      }
    }
    var shapeOk = typeKey === 'relations'
      ? function (o) { return typeof o.source === 'string' && typeof o.target === 'string'; }
      : function (o) { return typeof o.name === 'string'; };
    return results.filter(shapeOk);
  }

  // 实体名称归一化：全角→半角 + 去括号后缀 + 去尾标点 + 小写
  _normalizeEntityName(raw) {
    var s = String(raw == null ? '' : raw);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      if (code === 0x3000) { out += ' '; continue; }
      if (code >= 0xff01 && code <= 0xff5e) { out += String.fromCharCode(code - 0xfee0); continue; }
      out += s[i];
    }
    // 去括号后缀：手机银行（App版）→ 手机银行
    out = out.replace(/[\(（][^\)）]*[\)）]/g, '').trim();
    out = out.replace(/\s+/g, ' ').trim().replace(/[、，。：:；;·\-_]+$/, '').trim().toLowerCase();
    return out;
  }

  // 去常见后缀后比较：手机银行 vs 手机银行App → 基名 "手机银行" 一致 → 合并
  _stripCommonSuffix(name) {
    return name.replace(/(app|application|系统|平台|服务|功能|模块|service|system|module)$/i, '').trim();
  }

  _resolveEntities(entities) {
    var self = this;
    var resolved = [];
    // 主索引：normalized name + type → resolved 索引
    var seen = {};
    // 副索引：去后缀基名 + type → resolved 索引（用于模糊匹配）
    var baseSeen = {};

    entities.forEach(function(e) {
      var normKey = (self._normalizeEntityName(e.name) || '') + '::' + (e.type || '');
      var baseKey = (self._stripCommonSuffix(self._normalizeEntityName(e.name)) || '') + '::' + (e.type || '');

      // 1. 精确归一化匹配
      if (Object.prototype.hasOwnProperty.call(seen, normKey)) {
        var existing = resolved[seen[normKey]];
        self._mergeEntity(existing, e);
        return;
      }
      // 2. 去后缀模糊匹配（基名 ≥4 字符时才启用，避免短名误合并）
      var baseName = self._stripCommonSuffix(self._normalizeEntityName(e.name));
      if (baseName && baseName.length >= 4 && Object.prototype.hasOwnProperty.call(baseSeen, baseKey)) {
        var existIdx = baseSeen[baseKey];
        var existE = resolved[existIdx];
        // 保留更长的名称作为规范名（更具体）
        if (e.name.length > existE.name) {
          existE.name = e.name;
        }
        self._mergeEntity(existE, e);
        // 也建立精确索引，后续同名直接命中
        seen[normKey] = existIdx;
        return;
      }
      // 3. 新实体
      seen[normKey] = resolved.length;
      if (baseName && baseName.length >= 4) baseSeen[baseKey] = resolved.length;
      resolved.push(e);
    });

    return resolved;
  }

  // 合并重复实体：保留更高置信度，追加描述和来源
  _mergeEntity(existing, incoming) {
    if (incoming.confidence > existing.confidence) {
      existing.confidence = incoming.confidence;
      if (incoming.description && incoming.description.length > (existing.description || '').length) {
        existing.description = incoming.description;
      }
    }
    if (incoming.sourceDoc && existing.sourceDoc.indexOf(incoming.sourceDoc) < 0) {
      existing.sourceDoc += ', ' + incoming.sourceDoc;
    }
  }

  // 跨块冲突检测与解决：分块抽取后合并，可能产生同实体不同类型、重复/矛盾关系
  // 此方法在 _resolveEntities 之后、跨块关系发现之前执行，确保基础数据干净
  _detectAndResolveConflicts(entities, relations) {
    var self = this;

    // 1. 同名不同类型实体冲突：归一化名称相同但 type 不同 → 保留更高置信度的一方
    var byNormName = {};
    entities.forEach(function(e) {
      var norm = self._normalizeEntityName(e.name);
      if (!byNormName[norm]) byNormName[norm] = [];
      byNormName[norm].push(e);
    });
    var entityKeep = {};
    Object.keys(byNormName).forEach(function(norm) {
      var group = byNormName[norm];
      if (group.length <= 1) { group.forEach(function(e) { entityKeep[e] = true; }); return; }
      // 同名同类型的已由 _resolveEntities 合并；此处仅处理同名不同类型
      var typeMap = {};
      group.forEach(function(e) {
        var tk = e.type || 'unknown';
        if (!typeMap[tk]) typeMap[tk] = e;
        else typeMap[tk] = (e.confidence || 0) > (typeMap[tk].confidence || 0) ? e : typeMap[tk];
      });
      // 每种类型保留最高置信度的实体
      Object.keys(typeMap).forEach(function(tk) { entityKeep[typeMap[tk]] = true; });
    });
    var cleanEntities = entities.filter(function(e) { return entityKeep[e]; });

    // 2. 关系去重与冲突解决
    var seenRel = {};
    var cleanRelations = [];
    relations.forEach(function(r) {
      var src = (r.source || '').toLowerCase();
      var tgt = (r.target || '').toLowerCase();
      var rtype = (r.type || '').toLowerCase();
      var key = src + '::' + tgt + '::' + rtype;
      if (seenRel[key]) {
        // 已有同 source+target+type 关系，保留更高置信度
        var existing = seenRel[key];
        if ((r.confidence || 0) > (existing.confidence || 0)) {
          existing.confidence = r.confidence;
        }
        return;
      }
      seenRel[key] = r;
      cleanRelations.push(r);
    });

    return { entities: cleanEntities, relations: cleanRelations };
  }

  // 跨块关系发现：分块抽取后，实体间跨块关系可能遗漏。此方法对已消解的实体做一次全局关系补抽。
  // 仅当 >1 个 sourceDoc（即 >1 块）时执行；单块文档无需跨块发现。
  async _discoverCrossChunkRelations(resolvedEntities, existingRelations, docs) {
    var self = this;
    if (!resolvedEntities || resolvedEntities.length < 2) return [];
    if (!this.llmRoute || !this.llmRoute.apiKey) return [];

    // 按 sourceDoc 分组
    var byDoc = {};
    resolvedEntities.forEach(function(e) {
      var docIds = String(e.sourceDoc || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
      docIds.forEach(function(did) {
        if (!byDoc[did]) byDoc[did] = [];
        byDoc[did].push(e);
      });
    });
    var docIds = Object.keys(byDoc);
    if (docIds.length < 2) return []; // 单块无需跨块发现

    // 构建已有关系索引（避免重复）
    var existingKeys = {};
    existingRelations.forEach(function(r) {
      existingKeys[(r.source || '').toLowerCase() + '::' + (r.type || '') + '::' + (r.target || '').toLowerCase()] = true;
    });

    // 构建实体列表（按块分组，每块最多 30 个实体避免 prompt 过长）
    var entityLines = [];
    docIds.forEach(function(did) {
      var ents = byDoc[did].slice(0, 30);
      var docTitle = (docs.find(function(d) { return d.id === did; }) || {}).title || did;
      entityLines.push('段落 (' + docTitle + '):');
      ents.forEach(function(e) {
        entityLines.push('  - ' + e.name + ' (' + e.type + ')');
      });
    });

    // 已有关系摘要（最多 40 条，避免 prompt 过长）
    var relLines = existingRelations.slice(0, 40).map(function(r) {
      return '  ' + r.source + ' -> ' + r.target + ' (' + r.type + ')';
    });

    var relationTypesDesc = Object.keys(self.relationTypes).map(function(t) {
      return '- ' + t + ': ' + self.relationTypes[t].desc;
    }).join('\n');

    var prompt = '以下实体从同一文档的不同段落中分别抽取。由于分块处理，跨段落实体间的关系可能遗漏。'
      + '请基于实体语义和文档上下文，识别跨段落之间可能存在但未被抽取的关系。\n\n'
      + '实体列表（按来源段落分组）：\n' + entityLines.join('\n') + '\n\n'
      + '已有关系（不要重复输出这些）：\n' + (relLines.length ? relLines.join('\n') : '  (无)') + '\n\n'
      + '可用关系类型:\n' + relationTypesDesc + '\n\n'
      + '请只输出跨段落的新关系（source 和 target 来自不同段落），严格按以下 JSON 格式输出（不要输出其他内容）:\n'
      + '{\n'
      + '  "relations": [\n'
      + '    {"source": "源实体名称", "type": "' + Object.keys(self.relationTypes).join('|') + '", "target": "目标实体名称", "confidence": 0.8}\n'
      + '  ]\n'
      + '}';

    try {
      var llmOut = await self._callLLM(prompt, self._extractionSystemPrompt());
      var parsed = self._parseExtractionResult('{"entities":[],"relations":' + (function(){
        // 从 LLM 输出中提取 relations
        var codeMatch = llmOut.match(/```(?:json)?\s*([\s\S]*?)```/);
        var jsonStr = codeMatch ? codeMatch[1].trim() : llmOut;
        var s = jsonStr.indexOf('{');
        var e = jsonStr.lastIndexOf('}');
        if (s >= 0 && e > s) jsonStr = jsonStr.slice(s, e + 1);
        try {
          var obj = JSON.parse(jsonStr);
          return JSON.stringify(obj.relations || obj.relation || []);
        } catch(err) { return '[]'; }
      })() + '}', []);
      var newRelations = (parsed.relations || []).filter(function(r) {
        // 去重：与已有关系不重复
        var key = (r.source || '').toLowerCase() + '::' + (r.type || '') + '::' + (r.target || '').toLowerCase();
        if (existingKeys[key]) return false;
        existingKeys[key] = true;
        // 确保跨块：source 和 target 的实体需存在
        var srcExists = resolvedEntities.some(function(e) { return e.name === r.source; });
        var tgtExists = resolvedEntities.some(function(e) { return e.name === r.target; });
        return srcExists && tgtExists && r.source !== r.target;
      });
      if (newRelations.length > 0) {
        console.error('[GraphExtractor] 跨块关系发现：新增 ' + newRelations.length + ' 条跨块关系');
      }
      return newRelations;
    } catch(err) {
      console.error('[GraphExtractor] 跨块关系发现失败（非致命，跳过）:', err.message);
      return [];
    }
  }

  _callLLM(prompt, systemPrompt) {
    var self = this;
    var route = this.llmRoute;
    // 缺路由必须 reject：静默空串会被当成功写进断点缓存（与 9-28 0 实体事故同根因）
    if (!route || !route.apiKey) return Promise.reject(new Error('LLM 路由未配置（llmRoute.apiKey 缺失），拒绝返回空结果'));

    return new Promise(function(resolve, reject) {
      var messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      messages.push({ role: 'user', content: prompt });
      var body = JSON.stringify({
        model: route.model || 'deepseek-chat',
        messages: messages,
        max_tokens: 8192,
        temperature: 0.2, // low temp for structured extraction
      });
      var req = https.request({
        hostname: route.host,
        port: 443,
        path: route.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + route.apiKey,
          'Content-Length': Buffer.byteLength(body),
        },
      }, function(resp) {
        var data = '';
        resp.on('data', function(c) { data += c; });
        resp.on('end', function() {
          try {
            var json = JSON.parse(data);
            var content = json.choices[0].message.content;
            resolve(content);
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      // 单块调用必须带超时：qwen-plus 实测 ~128s/块，120s 会误杀慢块，取 300s；
      // 无超时的挂起 socket 会把整条分块抽取链卡死（checkpoint 停滞）
      req.setTimeout(300000, function () {
        req.destroy(new Error('LLM 请求超时（300s）'));
      });
      req.write(body);
      req.end();
    });
  }

  _saveCache(cacheFile, data) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch(e) {}
  }
}

module.exports = { GraphExtractor, ENTITY_TYPES, RELATION_TYPES };
