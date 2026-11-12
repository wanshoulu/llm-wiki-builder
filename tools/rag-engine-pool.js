'use strict';

/**
 * RAGEngine 实例池 — 从 routes/knowledge-studio.js 抽出的共享单例层。
 * knowledge-studio（HTTP 路由）与 tools/unified-search.js 必须共享同一实例，
 * 否则会出现双份内存索引和 .rag-cache.json 并发写冲突。
 */

const path = require('node:path');
const { API_ROUTES } = require('../config/api-keys');
const { RAGEngine } = require('./rag-engine');

const WIKI_ROOT = path.join(__dirname, '..', 'wiki');

const engines = new Map(); // projectName → RAGEngine
let embeddingConfigCache = null;

function getEmbeddingConfig() {
  if (embeddingConfigCache !== null) return embeddingConfigCache;
  var route = API_ROUTES['text-embedding-v4'];
  if (route) {
    var key = route.getKey ? route.getKey() : null;
    if (key) {
      embeddingConfigCache = {
        host: route.host,
        path: route.path,
        apiKey: key,
        model: route.model || 'text-embedding-v4',
        batchSize: route.batchSize || 10,
      };
    }
  }
  return embeddingConfigCache;
}

function getOrCreateRAGEngine(projectName) {
  var key = projectName || '__root__';
  if (!engines.has(key)) {
    engines.set(key, new RAGEngine({
      wikiDir: WIKI_ROOT,
      embeddingConfig: getEmbeddingConfig(),
    }));
  }
  return engines.get(key);
}

module.exports = { getOrCreateRAGEngine: getOrCreateRAGEngine, getEmbeddingConfig: getEmbeddingConfig, WIKI_ROOT: WIKI_ROOT };
