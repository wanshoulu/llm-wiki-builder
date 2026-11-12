'use strict';

/**
 * Wiki图谱化构建器
 * 复用现有GraphBuilder基础,扩展语义增强+Entity Resolution
 * 避免引入新组件,保持平台简洁
 */

const fs = require('fs');
const path = require('path');
const { GraphBuilder } = require('./llm-wiki-engine');
const { callLLM } = require('../scripts/graph-generator');

/**
 * Wiki图谱化构建器 - 继承现有GraphBuilder
 */
class WikiGraphBuilder extends GraphBuilder {
  constructor(llmApiKey = null) {
    super();
    this.llmApiKey = llmApiKey;

    // 实体类型Schema(借鉴Wikontic)
    this.entityTypes = ['Concept', 'Method', 'Tool', 'Person', 'Organization'];

    // 关系类型Schema(语义增强)
    this.relationTypes = ['INCLUDES', 'PRECEDES', 'RELATES_TO', 'COMPETES_WITH', 'IMPROVES'];
  }

  /**
   * Phase 1: Wiki预处理图谱(复用现有基础)
   */
  buildFromWikiEnhanced(wikiDir) {
    // 调用父类方法构建基础图谱
    const baseGraph = super.buildFromWiki(wikiDir);

    // 增强节点属性提取
    this.nodes = this.nodes.map(node => {
      const filePath = path.join(wikiDir, `${node.id}.md`);
      if (!fs.existsSync(filePath)) return node;

      const content = fs.readFileSync(filePath, 'utf-8');
      const properties = this.extractNodeProperties(content);

      return {
        ...node,
        label: this.inferEntityType(node),
        properties: {
          ...properties,
          created: node.created,
          updated: node.updated,
        },
      };
    });

    // 增强统计信息
    this.calculateEnhancedStats();

    return {
      nodes: this.nodes,
      edges: this.edges,
      stats: this.stats,
    };
  }

  /**
   * Phase 2: LLM语义增强(可选,需API key)
   */
  async enhanceWithLLM(wikiDir, options = {}) {
    if (!this.llmApiKey) {
      console.log('⚠️  未提供LLM API key,跳过语义增强');
      return { nodes: this.nodes, edges: this.edges, stats: this.stats };
    }

    const { batchSize = 5, onProgress } = options;
    const enhancedNodes = [];
    const enhancedEdges = [];

    // 批量处理节点
    for (let i = 0; i < this.nodes.length; i += batchSize) {
      const batch = this.nodes.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(node => this.enhanceNodeWithLLM(node, wikiDir))
      );

      results.forEach(result => {
        enhancedNodes.push(result.node);
        result.edges.forEach(e => enhancedEdges.push(e));
      });

      if (onProgress) {
        onProgress({
          phase: 'LLM增强',
          progress: Math.min(100, ((i + batchSize) / this.nodes.length) * 100),
          processed: i + batchSize,
          total: this.nodes.length,
        });
      }

      // 避免API限流
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    this.nodes = enhancedNodes;
    this.edges = [...this.edges, ...enhancedEdges];
    this.deduplicateEdges();
    this.calculateEnhancedStats();

    return {
      nodes: this.nodes,
      edges: this.edges,
      stats: this.stats,
    };
  }

  /**
   * Phase 3: Entity Resolution去重(可选)
   */
  async resolveEntities(options = {}) {
    if (!this.llmApiKey) {
      console.log('⚠️  未提供LLM API key,使用字符串相似度去重');
      return this.resolveBySimilarity();
    }

    // 构建候选实体列表
    const candidates = this.nodes.map(n => ({
      id: n.id,
      title: n.title,
      label: n.label,
    }));

    // Claude Sonnet判断是否相同实体
    const prompt = this.buildResolutionPrompt(candidates);
    const response = await this.callLLM(prompt, 'claude-sonnet-4-6', 512);

    try {
      const resolution = JSON.parse(response);
      this.applyResolution(resolution);
      return resolution;
    } catch (e) {
      console.error('解析Resolution失败:', e);
      return this.resolveBySimilarity();
    }
  }

  /**
   * 提取节点属性(复用Wiki内容)
   */
  extractNodeProperties(content) {
    return {
      definition: this.extractSection(content, '## 概述') || this.extractSection(content, '## Overview'),
      keyPoints: this.extractList(content, '## 核心要点') || this.extractList(content, '## Core Concepts'),
      formulas: this.extractCodeBlock(content, 'math'),
      examples: this.extractExamples(content),
      applications: this.extractList(content, '## 应用场景'),
      limitations: this.extractList(content, '## 局限性'),
    };
  }

  /**
   * 推断实体类型(简单规则,无LLM时使用)
   */
  inferEntityType(node) {
    const title = node.title.toLowerCase();
    const type = node.type?.toLowerCase();

    // 简化规则(借鉴意图图谱经验)
    if (/优化器|算法|方法|模型|策略|技术/.test(title)) return 'Method';
    if (/工具|平台|系统|库|框架/.test(title)) return 'Tool';
    if (/作者|研究员|教授|博士/.test(title) || /karpathy|lecun|hinton/.test(title)) return 'Person';
    if (/组织|机构|公司|实验室/.test(title)) return 'Organization';
    return 'Concept';
  }

  /**
   * LLM增强单个节点
   */
  async enhanceNodeWithLLM(node, wikiDir) {
    const filePath = path.join(wikiDir, `${node.id}.md`);
    const content = fs.readFileSync(filePath, 'utf-8');

    const prompt = this.buildExtractionPrompt(node, content.slice(0, 3000));
    const response = await this.callLLM(prompt, 'claude-haiku-4-5', 1024);

    try {
      const extracted = JSON.parse(response);
      return {
        node: {
          ...node,
          label: extracted.label || node.label,
          properties: {
            ...node.properties,
            ...extracted.properties,
          },
        },
        edges: extracted.edges || [],
      };
    } catch (e) {
      console.error(`节点${node.id}增强失败:`, e);
      return { node, edges: [] };
    }
  }

  /**
   * 构建提取提示词
   */
  buildExtractionPrompt(node, contentPreview) {
    return `Extract knowledge graph entities and relations from this Wiki page.

## Wiki Page
Title: ${node.title}
Type: ${node.type}
Content Preview:
${contentPreview}

## Your Task
1. Classify entity type:
   - Concept: abstract ideas (e.g., "Optimization")
   - Method: algorithms/techniques (e.g., "Adam Optimizer")
   - Tool: software/libraries (e.g., "TensorFlow")
   - Person: researchers (e.g., "Karpathy")
   - Organization: institutions (e.g., "Anthropic")

2. Extract semantic relations:
   - INCLUDES: part-of relation (e.g., "Adam INCLUDES Momentum")
   - PRECEDES: temporal/dependency (e.g., "SGD PRECEDES Adam")
   - RELATES_TO: semantic connection (e.g., "Adam RELATES_TO RMSProp")
   - COMPETES_WITH: alternatives (e.g., "Adam COMPETES_WITH SGD")
   - IMPROVES: enhancement (e.g., "Adam IMPROVES SGD")

3. Extract properties:
   - keyContributors: list of Person names
   - applications: list of domains
   - limitations: list of constraints

## Output Format (JSON)
{
  "label": "Method",
  "properties": {
    "keyContributors": ["Karpathy"],
    "applications": ["Deep Learning", "NLP"],
    "limitations": ["Memory intensive"]
  },
  "edges": [
    {"source": "${node.id}", "relation": "INCLUDES", "target": "momentum"},
    {"source": "${node.id}", "relation": "COMPETES_WITH", "target": "sgd"}
  ]
}`;
  }

  /**
   * 构建Resolution提示词
   */
  buildResolutionPrompt(entities) {
    const entityList = entities.map(e => `- "${e.id}" (${e.label}): ${e.title}`).join('\n');

    return `Resolve entity duplicates in a knowledge graph.

## Current Entities
${entityList}

## Potential Matches
Look for entities that might refer to the same concept:
- Same concept in different languages (e.g., "Adam优化器" vs "Adam")
- Abbreviations vs full names (e.g., "SGD" vs "Stochastic Gradient Descent")
- Name variants (e.g., "Karpathy" vs "Andrej Karpathy")

## Your Task
For each pair of similar entities, judge if they refer to the same entity.

Output JSON:
{
  "resolutions": [
    {
      "canonicalId": "adam",
      "variants": ["Adam优化器", "Adam optimizer"],
      "confidence": 0.95,
      "reason": "Same concept in different languages"
    }
  ]
}`;
  }

  /**
   * LLM调用(复用graph-generator的callLLM)
   */
  async callLLM(prompt, model, maxTokens) {
    // 复用现有的API路由配置
    const route = {
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiKey: this.llmApiKey,
    };

    try {
      const response = await fetch(route.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': route.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const data = await response.json();
      return data.content?.[0]?.text || '';
    } catch (e) {
      console.error('LLM调用失败:', e);
      throw e;
    }
  }

  /**
   * 字符串相似度去重(Fallback,无需LLM)
   */
  resolveBySimilarity(threshold = 0.8) {
    const resolutions = [];

    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const sim = this.calculateSimilarity(this.nodes[i].id, this.nodes[j].id);
        if (sim > threshold) {
          resolutions.push({
            canonicalId: this.nodes[i].id,
            variants: [this.nodes[j].id],
            confidence: sim,
            reason: 'String similarity fallback',
          });
        }
      }
    }

    this.applyResolution(resolutions);
    return resolutions;
  }

  /**
   * 计算相似度(Jaccard简化版)
   */
  calculateSimilarity(str1, str2) {
    const s1 = new Set(str1.toLowerCase().split(''));
    const s2 = new Set(str2.toLowerCase().split(''));
    const intersection = [...s1].filter(c => s2.has(c)).length;
    const union = s1.size + s2.size - intersection;
    return intersection / union;
  }

  /**
   * 应用Resolution结果
   */
  applyResolution(resolutions) {
    const variantMap = new Map();

    resolutions.forEach(r => {
      r.variants.forEach(v => variantMap.set(v, r.canonicalId));
    });

    // 合并节点
    const resolvedNodes = [];
    const processedIds = new Set();

    this.nodes.forEach(node => {
      const canonicalId = variantMap.get(node.id) || node.id;

      if (processedIds.has(canonicalId)) {
        // 已处理,添加variants信息
        const existingNode = resolvedNodes.find(n => n.id === canonicalId);
        if (existingNode && !existingNode.variants.includes(node.id)) {
          existingNode.variants.push(node.id);
        }
      } else {
        // 新节点
        resolvedNodes.push({
          ...node,
          id: canonicalId,
          variants: resolutions.find(r => r.canonicalId === canonicalId)?.variants || [],
        });
        processedIds.add(canonicalId);
      }
    });

    // 更新边的引用
    this.edges = this.edges.map(edge => ({
      ...edge,
      source: variantMap.get(edge.source) || edge.source,
      target: variantMap.get(edge.target) || edge.target,
    }));

    this.nodes = resolvedNodes;
    this.deduplicateEdges();
  }

  /**
   * 边去重
   */
  deduplicateEdges() {
    const edgeSet = new Set();
    this.edges = this.edges.filter(edge => {
      const key = `${edge.source}|${edge.relation || 'link'}|${edge.target}`;
      if (edgeSet.has(key)) return false;
      edgeSet.add(key);
      return true;
    });
  }

  /**
   * 计算增强统计信息
   */
  calculateEnhancedStats() {
    const nodeTypes = {};
    const relationTypes = {};

    this.nodes.forEach(n => {
      const label = n.label || 'Concept';
      nodeTypes[label] = (nodeTypes[label] || 0) + 1;
    });

    this.edges.forEach(e => {
      const rel = e.relation || 'link';
      relationTypes[rel] = (relationTypes[rel] || 0) + 1;
    });

    this.stats = {
      totalNodes: this.nodes.length,
      totalEdges: this.edges.length,
      orphanNodes: this.nodes.filter(n => n.orphan).length,
      avgDegree: this.nodes.reduce((sum, n) => sum + n.degree, 0) / this.nodes.length || 0,
      nodeTypes,
      relationTypes,
    };

    return this.stats;
  }

  /**
   * 辅助方法:提取章节内容
   */
  extractSection(content, heading) {
    const match = content.match(new RegExp(`${heading}\\s*\\n([^#]+)`, 'i'));
    return match ? match[1].trim() : '';
  }

  /**
   * 辅助方法:提取列表
   */
  extractList(content, heading) {
    const section = this.extractSection(content, heading);
    if (!section) return [];

    const items = section.split('\n')
      .filter(line => line.trim().match(/^[-*]\s+/))
      .map(line => line.replace(/^[-*]\s+/, '').trim());

    return items;
  }

  /**
   * 辅助方法:提取代码块
   */
  extractCodeBlock(content, language) {
    const regex = new RegExp('```' + language + '\\s*\\n([^`]+)```', 'i');
    const match = content.match(regex);
    return match ? match[1].trim() : '';
  }

  /**
   * 辅助方法:提取示例
   */
  extractExamples(content) {
    const section = this.extractSection(content, '## 示例') || this.extractSection(content, '## Examples');
    if (!section) return [];

    return section.split('\n\n')
      .filter(para => para.trim())
      .slice(0, 3);
  }
}

// 导出
module.exports = {
  WikiGraphBuilder,
};