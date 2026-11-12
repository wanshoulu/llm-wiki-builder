/**
 * Semantic Search — vector + hybrid search for Knowledge Studio
 *
 * Provides:
 *   - TF-IDF vectorization (fast fallback, no API)
 *   - Qwen text-embedding-v4 (real 1024-dim embeddings)
 *   - Cosine similarity search
 *   - Hybrid search (BM25 keyword + semantic fusion via RRF)
 *   - Index persistence + embedding cache
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

class SemanticSearch {
  constructor(options) {
    this.options = options || {};
    this.documents = [];      // [{id, title, content}]
    this.vocabulary = {};     // word → index (TF-IDF mode only)
    this.idf = {};            // word → idf value (TF-IDF mode only)
    this.tfidfVectors = [];   // document → sparse vector (TF-IDF mode only)
    this.embeddingVectors = []; // document → dense vector (embedding mode)
    this.dim = 0;             // vocabulary size (TF-IDF) or embedding dim
    this.useEmbeddings = false; // true when Qwen embeddings are available
    this.embeddingCacheFile = null;
  }

  /**
   * Build embedding-based index using Qwen text-embedding-v4
   * @param {string} wikiDir - wiki root directory
   * @param {Array} pages - optional pre-scanned pages [{id, title, content}]
   * @param {object} embedConfig - { host, path, apiKey, model }
   */
  async buildEmbeddingIndex(wikiDir, pages, embedConfig) {
    this.documents = [];
    this.embeddingVectors = [];
    this.useEmbeddings = true;
    this.embedConfig = embedConfig || null;  // 供 searchAsync 对 query 向量化

    var docs = pages || this._scanWiki(wikiDir);
    this.documents = docs;
    this.embeddingCacheFile = path.join(wikiDir, '.embedding-cache.json');

    if (!docs.length) return 0;

    // Try loading from cache first
    var cached = this._loadEmbeddingCache();
    if (cached && cached.length === docs.length && cached.every(function(c) { return c.vector && c.vector.length > 0; })) {
      this.embeddingVectors = cached;
      this.dim = cached[0].vector.length;
      return cached.length;
    }

    if (!embedConfig || !embedConfig.apiKey) {
      console.log('[SemanticSearch] No embedding API key, falling back to TF-IDF');
      this.useEmbeddings = false;
      this.buildIndex(wikiDir, pages);
      return this.tfidfVectors.length;
    }

    // Call Qwen embedding API in batches
    var batchSize = embedConfig.batchSize || 15;
    var self = this;
    var embedded = 0;

    for (var i = 0; i < docs.length; i += batchSize) {
      var batch = docs.slice(i, Math.min(i + batchSize, docs.length));
      var texts = batch.map(function(d) {
        return (d.title || '') + ' ' + (d.content || '').slice(0, 2000);
      });

      try {
        var vectors = await self._callEmbeddingAPI(texts, embedConfig);
        for (var j = 0; j < vectors.length; j++) {
          var normVal = norm(vectors[j]);
          self.embeddingVectors.push({
            id: batch[j].id || batch[j].fileName || '',
            title: batch[j].title || '',
            vector: vectors[j],
            norm: normVal || 1,
          });
          embedded++;
        }
      } catch(e) {
        console.error('[SemanticSearch] Embedding batch failed (' + batch.length + ' docs):', e.message);
        console.warn('[SemanticSearch] ' + batch.length + ' documents will use TF-IDF fallback for semantic search');
        // Don't push zero vectors — they silently disappear from search results.
        // Instead, skip them; the search function will fall back to TF-IDF.
        self._embeddingFailures = (self._embeddingFailures || 0) + batch.length;
      }
    }

    if (self._embeddingFailures > 0) {
      console.warn('[SemanticSearch] Embedding build complete: ' + embedded + ' documents embedded, ' + self._embeddingFailures + ' failed (will use TF-IDF fallback).');
      // Ensure TF-IDF index is built for fallback
      if (!self.tfidfVectors || !self.tfidfVectors.length) {
        self.buildIndex(null, docs);
      }
    }

    if (embedded > 0) {
      this.dim = this.embeddingVectors[0].vector.length || 1024;
      this._saveEmbeddingCache();
    }
    return embedded;
  }

  /**
   * Build TF-IDF index from wiki pages
   */
  buildIndex(wikiDir, pages) {
    this.documents = [];
    this.vocabulary = {};
    this.idf = {};
    this.tfidfVectors = [];

    // Collect documents from wiki directory
    const docs = pages || this._scanWiki(wikiDir);
    this.documents = docs;

    if (!docs.length) return;

    // Tokenize all documents
    const tokenizedDocs = docs.map(function(d) {
      return { id: d.id || d.fileName || '', title: d.title || '', tokens: tokenize(d.title + ' ' + (d.content || '')) };
    });

    // Build vocabulary
    const df = {}; // document frequency
    tokenizedDocs.forEach(function(doc) {
      const seen = {};
      doc.tokens.forEach(function(token) {
        if (!seen[token]) {
          df[token] = (df[token] || 0) + 1;
          seen[token] = true;
        }
      });
    });

    // Filter rare and common terms, build vocabulary
    const N = docs.length;
    const minDf = Math.max(1, Math.floor(N * 0.01)); // in at least 1% of docs
    const maxDf = Math.floor(N * 0.8);               // in at most 80% of docs
    const vocab = [];
    Object.keys(df).forEach(function(word) {
      if (df[word] >= minDf && df[word] <= maxDf) {
        this.vocabulary[word] = vocab.length;
        this.idf[word] = Math.log((N + 1) / (df[word] + 1)) + 1;
        vocab.push(word);
      }
    }, this);
    this.dim = vocab.length;

    // Build TF-IDF vectors
    this.tfidfVectors = tokenizedDocs.map(function(doc) {
      const vec = new Array(this.dim).fill(0);
      const tf = {};
      doc.tokens.forEach(function(t) { tf[t] = (tf[t] || 0) + 1; });

      Object.keys(tf).forEach(function(word) {
        const idx = this.vocabulary[word];
        if (idx !== undefined) {
          vec[idx] = (1 + Math.log(tf[word])) * this.idf[word]; // sublinear TF scaling
        }
      }, this);

      return { id: doc.id, title: doc.title, vector: vec, norm: norm(vec) };
    }, this);
  }

  /**
   * Semantic search — cosine similarity (TF-IDF or embedding)
   */
  search(query, options) {
    const opts = options || {};
    const topK = opts.topK || 10;

    // 同步 search() 始终走 TF-IDF，保证返回类型一致（数组），不破坏 hybridSearch；
    // 真实 embedding 检索请用异步 searchAsync()（需对 query 做向量化）。
    if (!this.dim || !this.tfidfVectors.length) return [];

    const queryTokens = tokenize(query);
    const queryVec = new Array(this.dim).fill(0);
    const tf = {};
    queryTokens.forEach(function(t) { tf[t] = (tf[t] || 0) + 1; });
    Object.keys(tf).forEach(function(word) {
      const idx = this.vocabulary[word];
      if (idx !== undefined) {
        queryVec[idx] = (1 + Math.log(tf[word])) * this.idf[word];
      }
    }, this);
    const qNorm = norm(queryVec) || 1;

    const scores = this.tfidfVectors.map(function(doc) {
      const dot = dotProduct(queryVec, doc.vector);
      const sim = doc.norm > 0 ? dot / (qNorm * doc.norm) : 0;
      return { id: doc.id, title: doc.title, score: sim };
    });

    scores.sort(function(a, b) { return b.score - a.score; });
    return scores.slice(0, topK).filter(function(s) { return s.score > 0; });
  }

  /**
   * 异步语义检索：有真实 embedding 时对 query 也做向量化再算余弦相似度；
   * 无 embedding（无 key / 未构建）时回退到同步 TF-IDF。返回 [{id,title,score}]。
   */
  async searchAsync(query, options) {
    const opts = options || {};
    if (this.useEmbeddings && this.embeddingVectors.length && this.embedConfig && this.embedConfig.apiKey) {
      return this._embeddingSearch(query, opts, this.embedConfig);
    }
    return this.search(query, opts);
  }

  /**
   * Embedding-based search
   */
  async _embeddingSearch(query, opts, embedConfig) {
    var self = this;
    return new Promise(function(resolve) {
      // Need to embed the query first
      if (!embedConfig || !embedConfig.apiKey) {
        // Try TF-IDF approximation
        resolve(self._tfidfFallbackSearch(query, opts.topK || 10));
        return;
      }

      self._callEmbeddingAPI([query], embedConfig).then(function(queryVecs) {
        var qVec = queryVecs[0];
        var qNorm = norm(qVec) || 1;
        var topK = opts.topK || 10;

        var scores = self.embeddingVectors.map(function(doc) {
          if (!doc.vector || !doc.vector.length) return { id: doc.id, title: doc.title, score: 0 };
          var dot = dotProduct(qVec, doc.vector);
          var sim = doc.norm > 0 ? dot / (qNorm * doc.norm) : 0;
          return { id: doc.id, title: doc.title, score: sim };
        });

        scores.sort(function(a, b) { return b.score - a.score; });
        resolve(scores.slice(0, topK).filter(function(s) { return s.score > 0; }));
      }).catch(function(err) {
        console.error('[SemanticSearch] query embedding failed, falling back to TF-IDF:', err && err.message);
        resolve(self._tfidfFallbackSearch(query, opts.topK || 10));
      });
    });
  }

  _tfidfFallbackSearch(query, topK) {
    if (!this.tfidfVectors.length) this.buildIndex(null, this.documents);
    if (!this.tfidfVectors.length) return [];
    var qt = tokenize(query);
    var qv = new Array(this.dim).fill(0);
    var tf = {};
    qt.forEach(function(t) { tf[t] = (tf[t] || 0) + 1; });
    Object.keys(tf).forEach(function(w) {
      var idx = this.vocabulary[w];
      if (idx !== undefined) qv[idx] = (1 + Math.log(tf[w])) * this.idf[w];
    }, this);
    var qn = norm(qv) || 1;
    var scores = this.tfidfVectors.map(function(d) {
      var dot = dotProduct(qv, d.vector);
      return { id: d.id, title: d.title, score: d.norm > 0 ? dot / (qn * d.norm) : 0 };
    });
    scores.sort(function(a, b) { return b.score - a.score; });
    return scores.slice(0, topK).filter(function(s) { return s.score > 0; });
  }

  /**
   * Call Qwen text-embedding-v4 API
   */
  _callEmbeddingAPI(texts, config) {
    return new Promise(function(resolve, reject) {
      // OpenAI-compatible format: input is string or array of strings
      var body = JSON.stringify({
        model: config.model || 'text-embedding-v4',
        input: texts.length === 1 ? texts[0] : texts,
      });
      var opts = {
        hostname: config.host || 'dashscope.aliyuncs.com',
        port: 443,
        path: config.path || '/compatible-mode/v1/embeddings',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + config.apiKey,
          'Content-Length': Buffer.byteLength(body),
        },
      };
      var req = https.request(opts, function(resp) {
        var data = '';
        resp.on('data', function(c) { data += c; });
        resp.on('end', function() {
          try {
            var json = JSON.parse(data);
            if (json.error) { reject(new Error(json.error.message || json.error.code || 'API error')); return; }
            // OpenAI-compatible: data[].embedding
            var embeddings = (json.data || []).map(function(d) { return d.embedding; });
            if (!embeddings.length || !embeddings[0]) { reject(new Error('No embeddings in response')); return; }
            resolve(embeddings);
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _loadEmbeddingCache() {
    if (!this.embeddingCacheFile || !fs.existsSync(this.embeddingCacheFile)) return null;
    try {
      var data = JSON.parse(fs.readFileSync(this.embeddingCacheFile, 'utf-8'));
      // 仅接受 v2+（稠密向量）。旧版稀疏缓存直接忽略，触发重建，避免把稀疏当稠密读错。
      if (data.version >= 2 && Array.isArray(data.vectors)) {
        return data.vectors
          .filter(function(v) { return Array.isArray(v.vector) && v.vector.length; })
          .map(function(v) {
            return { id: v.id || '', title: v.title || '', vector: v.vector, norm: v.norm || 1 };
          });
      }
      return null;
    } catch(e) { return null; }
  }

  _saveEmbeddingCache() {
    if (!this.embeddingCacheFile) return;
    try {
      var data = {
        version: 2,
        updated: new Date().toISOString(),
        vectors: this.embeddingVectors.map(function(v) {
          return { id: v.id, title: v.title, vector: v.vector, norm: v.norm };
        }),
      };
      fs.writeFileSync(this.embeddingCacheFile, JSON.stringify(data), 'utf-8');
    } catch(e) { /* silent */ }
  }

  /**
   * Hybrid search: fuse BM25 keyword results with TF-IDF semantic results
   * Uses Reciprocal Rank Fusion (RRF)
   */
  hybridSearch(query, keywordResults, options) {
    const opts = options || {};
    const topK = opts.topK || 10;
    const k = opts.rrfK || 60; // RRF constant

    const semanticResults = this.search(query, { topK: topK * 2 });

    // Build ranking maps
    const kwRank = {};
    const semRank = {};

    (keywordResults || []).forEach(function(r, i) { kwRank[r.id || r.title] = i + 1; });
    semanticResults.forEach(function(r, i) { semRank[r.id || r.title] = i + 1; });

    // Merge and score
    const allIds = new Set();
    Object.keys(kwRank).forEach(function(id) { allIds.add(id); });
    Object.keys(semRank).forEach(function(id) { allIds.add(id); });

    // Build lookup for metadata (title, snippet) from both result sets
    var metaLookup = {};
    (keywordResults || []).forEach(function(r) { if (!metaLookup[r.id || r.title]) metaLookup[r.id || r.title] = r; });
    semanticResults.forEach(function(r) { if (!metaLookup[r.id || r.title]) metaLookup[r.id || r.title] = r; });

    var merged = [];
    allIds.forEach(function(id) {
      var kwScore = kwRank[id] ? 1 / (k + kwRank[id]) : 0;
      var semScore = semRank[id] ? 1 / (k + semRank[id]) : 0;
      var meta = metaLookup[id] || {};
      merged.push({ id: id, title: meta.title || id, snippet: meta.snippet || '', score: kwScore * 0.6 + semScore * 0.4 }); // keyword weighted more (reliability)
    });

    merged.sort(function(a, b) { return b.score - a.score; });
    return merged.slice(0, topK);
  }

  /**
   * Save index to disk
   */
  save(outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify({
      dim: this.dim,
      vocabulary: this.vocabulary,
      idf: this.idf,
      documents: this.documents.map(function(d) { return { id: d.id, title: d.title }; }),
      vectors: this.tfidfVectors.map(function(v) {
        // Sparse encoding: only store non-zero entries
        const sparse = [];
        for (var i = 0; i < v.vector.length; i++) {
          if (v.vector[i] > 0) sparse.push([i, v.vector[i]]);
        }
        return { id: v.id, title: v.title, norm: v.norm, sparse: sparse };
      }),
    }, null, 2), 'utf-8');
  }

  /**
   * Load index from disk
   */
  load(inputPath) {
    if (!fs.existsSync(inputPath)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
      this.dim = data.dim;
      this.vocabulary = data.vocabulary;
      this.idf = data.idf;
      this.documents = data.documents;
      this.tfidfVectors = (data.vectors || []).map(function(v) {
        const vec = new Array(data.dim).fill(0);
        (v.sparse || []).forEach(function(e) { vec[e[0]] = e[1]; });
        return { id: v.id, title: v.title, vector: vec, norm: v.norm };
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  _scanWiki(wikiDir) {
    const docs = [];
    if (!fs.existsSync(wikiDir)) return docs;
    const scan = function(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      entries.forEach(function(e) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { scan(fp); }
        else if (e.name.endsWith('.md')) {
          try {
            const content = fs.readFileSync(fp, 'utf-8');
            docs.push({ id: e.name, title: e.name.replace('.md', ''), content: content });
          } catch(ex) { /* skip */ }
        }
      });
    };
    scan(wikiDir);
    return docs;
  }
}

// ── Utility functions ──

/**
 * Tokenize text for Chinese + English mixed content
 */
function tokenize(text) {
  if (!text) return [];
  var cleaned = text.toLowerCase()
    .replace(/[`~!@#$%^&*()_|+\-=?;:'",.<>\{\}\[\]\\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Split on word boundaries: spaces, CJK character boundaries
  var tokens = [];
  var re = /[一-龥]+|[a-z0-9]+/g;
  var match;
  while ((match = re.exec(cleaned)) !== null) {
    var w = match[0].trim();
    if (!w) continue;
    if (w.length > 1) tokens.push(w);
    // For CJK text, also generate bigrams + single chars
    if (/^[一-龥]+$/.test(w) && w.length >= 2) {
      for (var i = 0; i < w.length - 1; i++) {
        tokens.push(w.slice(i, i + 2));
      }
      for (var j = 0; j < w.length; j++) {
        tokens.push(w[j]);
      }
    }
  }
  return tokens;
}

function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function norm(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

module.exports = { SemanticSearch };
