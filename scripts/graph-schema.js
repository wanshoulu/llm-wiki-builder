'use strict';

/**
 * graph-schema.js — Canonical node/edge schema for knowledge graphs.
 * Single source of truth shared by generator, viewer, and API.
 */

const EDGE_TYPE = {
  // 原有类型
  PARENT: 'parent',
  CROSS: 'cross',
  WIKI: 'wiki',

  // LLM Wiki V2 扩展关系类型（对标 agentmemory/AKBP）
  DEPENDS_ON: 'depends_on',    // 依赖关系（A依赖B）
  USES: 'uses',                // 使用关系（A使用B）
  INCLUDES: 'includes',        // 包含关系（A包含B）
  CAUSED: 'caused',            // 因果关系（A导致B）
  FIXED: 'fixed',              // 修复关系（A修复了B）
  SUPERSEDES: 'supersedes',    // 替代关系（A替代B）
  CONTRADICTS: 'contradicts',  // 矛盾关系（A与B矛盾）
};

// 关系类型权重（用于图遍历过滤）
const EDGE_WEIGHTS = {
  parent: 0.9,
  cross: 0.5,
  wiki: 0.7,
  depends_on: 0.95,
  uses: 0.85,
  includes: 0.8,
  caused: 0.9,
  fixed: 0.88,
  supersedes: 1.0,
  contradicts: -1.0,  // 矛盾关系为负权重
};

// 关系类型语义描述
const EDGE_SEMANTICS = {
  parent: '层级关系',
  cross: '跨域引用',
  wiki: 'Wiki链接',
  depends_on: '依赖关系',
  uses: '使用关系',
  includes: '包含关系',
  caused: '因果关系',
  fixed: '修复关系',
  supersedes: '替代关系',
  contradicts: '矛盾关系',
};

const LEVEL_TYPE_NAMES = ['核心基础', '主要范式', '具体算法', '技术细节'];

function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  var n = Object.assign({}, raw);
  // Canonical display name
  n.title = n.title || n.label || n.id;
  // Node type by level if not set
  if (!n.type) n.type = LEVEL_TYPE_NAMES[n.level] || '概念';
  // Defaults
  n.topic = n.topic || '';
  n.tags = n.tags || [];
  n.sources = n.sources || [];
  n.concepts = n.concepts || [];
  n.keyPoints = n.keyPoints || [];
  n.formulas = n.formulas || [];
  n.questions = n.questions || [];
  n.problems = n.problems || [];
  n.degree = typeof n.degree === 'number' ? n.degree : (n.inDegree || 0) + (n.outDegree || 0);
  n.inDegree = n.inDegree || 0;
  n.outDegree = n.outDegree || 0;
  n.orphan = typeof n.orphan === 'boolean' ? n.orphan : n.degree === 0;
  n.broken = typeof n.broken === 'boolean' ? n.broken : false;
  return n;
}

function normalizeEdge(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  return {
    source: raw.source || raw.s,
    target: raw.target || raw.t,
    type: raw.type || EDGE_TYPE.CROSS,
  };
}

module.exports = {
  EDGE_TYPE,
  LEVEL_TYPE_NAMES,
  normalizeNode,
  normalizeEdge,
};
