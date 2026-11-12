'use strict';

/**
 * embedding.js — 统一语义向量模块（复用平台已有的 Qwen text-embedding-v4）
 *
 * 目的：让"知识建设 / LLM wiki 化"的混合检索用上平台现成的真实 embedding，
 *       而不是各自造 TF-IDF/Jaccard 假向量。
 *
 * 设计原则（不重复造轮子）：
 *   - 路由与密钥直接复用 config/api-keys.js 的 'text-embedding-v4'，不新增模型、不硬编码 key。
 *   - 自带独立磁盘缓存（data/embeddings-cache-knowledge.json），与 intent-evaluator 的缓存互不干扰。
 *   - 无 key / 调用失败时优雅降级（返回 null），调用方据此回退到 BM25/图谱单路。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { API_ROUTES } = require('../config/api-keys');

const MODEL = 'text-embedding-v4';
const CACHE_PATH = path.join(__dirname, '..', 'data', 'embeddings-cache-knowledge.json');

// ── 缓存（进程内单例 + 磁盘持久化）──
let _cache = null;
let _dirty = false;

function loadCache() {
  if (_cache) return _cache;
  _cache = { model: MODEL, embeddings: {} };
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      if (parsed && parsed.embeddings) _cache.embeddings = parsed.embeddings;
    }
  } catch (e) {
    console.error('[embedding] 缓存读取失败，重建：', e.message);
  }
  return _cache;
}

function saveCache() {
  if (!_cache || !_dirty) return;
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(_cache), 'utf8');
    _dirty = false;
  } catch (e) {
    console.error('[embedding] 缓存写入失败：', e.message);
  }
}

// ── 小工具 ──
function sha(text, n) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, n || 24);
}

function keyOf(text) {
  return sha(MODEL + '\n' + text, 24);
}

/** 标准余弦相似度 */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** 是否具备真实向量能力（有可用 key）。无 key 时调用方应回退单路检索。 */
function isAvailable() {
  const route = API_ROUTES[MODEL];
  return !!(route && typeof route.getKey === 'function' && route.getKey());
}

// ── DashScope compatible-mode embeddings 调用 ──
async function _callApi(inputs) {
  const route = API_ROUTES[MODEL];
  if (!route) throw new Error('embedding route not configured');
  const apiKey = route.getKey();
  if (!apiKey) throw new Error('QWEN_KEY not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch('https://' + route.host + route.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model: MODEL, input: inputs }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 300));
    const parsed = JSON.parse(text);
    // OpenAI 兼容格式：{ data: [{ embedding: [...], index }] }，按 index 还原顺序
    return (parsed.data || [])
      .slice()
      .sort((x, y) => (x.index || 0) - (y.index || 0))
      .map(d => d.embedding);
  } finally {
    clearTimeout(timer);
  }
}

/** 只读缓存命中，绝不发起 API（用于检索请求路径，避免一次请求打爆整个语料）。 */
function getCached(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const cache = loadCache();
  return cache.embeddings[keyOf(t)] || null;
}

/** 向量化单条文本（命中缓存直接返回；未命中且有 key 时调用 API 并落缓存）。 */
async function embed(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const cache = loadCache();
  const k = keyOf(t);
  if (cache.embeddings[k]) return cache.embeddings[k];
  if (!isAvailable()) return null;
  const vecs = await _callApi([t]);
  const vec = vecs && vecs[0];
  if (vec) {
    cache.embeddings[k] = vec;
    _dirty = true;
    saveCache();
  }
  return vec || null;
}

/**
 * 批量向量化（分批 + 缓存）。返回与输入等长的数组，未能向量化的位置为 null。
 * @param {Array<string>} texts
 * @param {{batchSize?:number, onProgress?:function}} opts
 */
async function embedMany(texts, opts = {}) {
  const cache = loadCache();
  const route = API_ROUTES[MODEL];
  const bs = opts.batchSize || (route && route.batchSize) || 10;
  const out = new Array(texts.length).fill(null);
  const pending = [];

  texts.forEach((raw, i) => {
    const t = String(raw || '').trim();
    if (!t) return;
    const k = keyOf(t);
    if (cache.embeddings[k]) out[i] = cache.embeddings[k];
    else pending.push({ i, text: t, k });
  });

  if (pending.length && isAvailable()) {
    for (let s = 0; s < pending.length; s += bs) {
      const chunk = pending.slice(s, s + bs);
      const vecs = await _callApi(chunk.map(p => p.text));
      chunk.forEach((p, j) => {
        if (vecs[j]) {
          out[p.i] = vecs[j];
          cache.embeddings[p.k] = vecs[j];
          _dirty = true;
        }
      });
      if (typeof opts.onProgress === 'function') {
        opts.onProgress(Math.min(s + bs, pending.length), pending.length);
      }
    }
    saveCache();
  }
  return out;
}

module.exports = {
  MODEL,
  isAvailable,
  cosine,
  keyOf,
  getCached,
  embed,
  embedMany,
  _cachePath: CACHE_PATH,
};
