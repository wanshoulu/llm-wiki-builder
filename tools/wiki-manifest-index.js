/**
 * Wiki Manifest Index — 轻量级 Wiki 文档元数据索引
 *
 * 设计原则：
 *   - 只解析 YAML frontmatter (title/type/tags)，不读全文
 *   - 每个文件只读前 4096 字节（足够 frontmatter + 首段 summary）
 *   - 建三个倒排索引：title（分词）、tags（精确+模糊）、type（精确）
 *   - mtime 缓存 + 磁盘持久化（.wiki-manifest-cache.json）
 *
 * 与 RAG 方案的区别：
 *   RAG：  全量读全文 → chunk → embedding 向量化 → 预建索引（事前做）
 *   Wiki：  manifest（仅 frontmatter）→ 关键词匹配 → 按需 fs.readFileSync（检索时做）
 *
 * 用法：
 *   const mi = new WikiManifestIndex();
 *   mi.build('/path/to/wiki');
 *   const results = mi.search('比亚迪 风险', { topK: 10 });
 *   // results: [{ id, title, score, type, tags, summary }]
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── 中文+英文混合分词（对齐 semantic-search.js 的 tokenize 逻辑）──

function tokenize(text) {
  if (!text) return [];
  var cleaned = text.toLowerCase()
    .replace(/[`~!@#$%^&*()_|+\-=?;:'",.<>\{\}\[\]\\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  var tokens = [];
  var re = /[一-龥]+|[a-z0-9]+/g;
  var match;
  while ((match = re.exec(cleaned)) !== null) {
    var w = match[0].trim();
    if (!w) continue;
    if (w.length > 1) tokens.push(w);
    // CJK: bigrams + single chars
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

// ── WikiManifestIndex ──

function WikiManifestIndex() {
  this.manifests = {};       // { relPath: { title, type, tags, summary, category, size, mtime, docType } }
  this.titleIndex = {};      // token → [relPath, ...]
  this.tagIndex = {};        // tag → [relPath, ...]
  this.typeIndex = {};       // type → [relPath, ...]
  this.docTypeIndex = {};    // doc_type → [relPath, ...]（公文审核按文种召回用）
  this.paths = [];           // all indexed relPaths
  this._wikiDir = null;
  this._mtime = 0;
}

// 磁盘缓存版本：v2 起包含 docTypeIndex（旧缓存无 doc_type 索引必须失效重建）
var CACHE_VERSION = 2;

// 跳过的导航页（非知识页面）
var SKIP_FILES = ['index.md', 'log.md', 'overview.md', 'purpose.md', 'hot.md'];

/**
 * 解析 YAML frontmatter（仅读取文件头部，不读全文）
 * @param {string} filePath
 * @returns {{ title: string, type: string, tags: string[], summary: string, docType: string }}
 */
function parseFrontmatter(filePath) {
  var result = { title: '', type: '', tags: [], summary: '', docType: '' };
  try {
    var stat = fs.statSync(filePath);
    // 只读前 4096 字节 — frontmatter + 首段 summary 足够
    var buf = Buffer.alloc(Math.min(4096, stat.size));
    var fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    var head = buf.toString('utf-8');

    // 解析 YAML frontmatter (---...---)
    var fmMatch = head.match(/^---\n([\s\S]*?)\n---/);
    var bodyAfterFM = '';

    if (fmMatch) {
      var fm = fmMatch[1];
      bodyAfterFM = head.slice(fmMatch[0].length);

      // title
      var tm = fm.match(/^title:\s*"?([^"\n]+)"?/m);
      if (tm) result.title = tm[1].trim();

      // type
      var tp = fm.match(/^type:\s*"?([^"\n]+)"?/m);
      if (tp) result.type = tp[1].trim();

      // tags: [tag1, tag2] 或 tags: tag1, tag2
      var tg = fm.match(/^tags:\s*\[?([^\]\n]+)\]?/m);
      if (tg) {
        result.tags = tg[1].split(',').map(function(t) {
          return t.trim().replace(/['"]/g, '');
        }).filter(Boolean);
      }

      // category (from directory or frontmatter)
      var cat = fm.match(/^category:\s*"?([^"\n]+)"?/m);
      if (cat) result.type = cat[1].trim();  // category 可覆盖 type

      // doc_type（公文审核按文种召回用，单值）
      var dt = fm.match(/^doc_type:\s*"?([^"\n]+)"?/m);
      if (dt) result.docType = dt[1].trim();
    } else {
      // 无 frontmatter：整个 head 作为 body
      bodyAfterFM = head;
    }

    // 提取 summary：第一个非空非标题段落
    if (bodyAfterFM) {
      var paragraphs = bodyAfterFM.split('\n\n').filter(function(p) {
        var trimmed = p.trim();
        return trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('```') && trimmed.length > 10;
      });
      if (paragraphs.length > 0) {
        result.summary = paragraphs[0].replace(/\n/g, ' ').trim().slice(0, 200);
      }
    }

    // 回退：从文件名推断 title
    if (!result.title) {
      var baseName = path.basename(filePath, '.md');
      result.title = baseName;
    }

    // 从目录名推断 category/type
    if (!result.type) {
      var dirParts = filePath.replace(/\\/g, '/').split('/');
      // 找 wiki 目录下第一层子目录（如 concepts, entities, sources, customers, ...）
      for (var i = dirParts.length - 2; i >= 0; i--) {
        if (dirParts[i] === 'wiki' || dirParts[i] === 'concepts' ||
            dirParts[i] === 'entities' || dirParts[i] === 'sources' ||
            dirParts[i] === 'syntheses') {
          if (i + 1 < dirParts.length - 1) {
            result.type = dirParts[i + 1];
          }
          break;
        }
      }
    }
  } catch (e) {
    // 读取失败 → 仅用文件名
    result.title = path.basename(filePath, '.md');
  }
  return result;
}

/**
 * 构建/刷新 manifest 索引
 * @param {string} wikiDir — Wiki 根目录
 * @param {object} options — { forceRebuild }
 */
WikiManifestIndex.prototype.build = function(wikiDir, options) {
  var self = this;
  options = options || {};
  if (!fs.existsSync(wikiDir)) return;

  // mtime 缓存 — 目录未变则跳过
  var stat;
  try { stat = fs.statSync(wikiDir); } catch(e) { return; }
  var dirMtime = stat.mtimeMs;
  if (!options.forceRebuild && self._wikiDir === wikiDir && self._mtime === dirMtime) {
    return; // 未变化，跳过
  }

  // 尝试从磁盘缓存加载
  var cacheFile = path.join(wikiDir, '.wiki-manifest-cache.json');
  if (!options.forceRebuild && fs.existsSync(cacheFile)) {
    try {
      var cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      // _version 不匹配（旧缓存无 docTypeIndex）→ 强制重建
      if (cached._version === CACHE_VERSION && cached._mtime === dirMtime && cached.manifests && cached.titleIndex) {
        self.manifests = cached.manifests;
        self.titleIndex = cached.titleIndex;
        self.tagIndex = cached.tagIndex || {};
        self.typeIndex = cached.typeIndex || {};
        self.docTypeIndex = cached.docTypeIndex || {};
        self.paths = cached.paths || Object.keys(cached.manifests).sort();
        self._wikiDir = wikiDir;
        self._mtime = dirMtime;
        return; // 缓存命中
      }
    } catch(e) { /* 缓存损坏，重建 */ }
  }

  // ── 重建索引 ──
  self.manifests = {};
  self.titleIndex = {};
  self.tagIndex = {};
  self.typeIndex = {};
  self.docTypeIndex = {};
  self.paths = [];
  self._wikiDir = wikiDir;
  self._mtime = dirMtime;

  // 递归扫描
  function scan(dir, relRoot) {
    relRoot = relRoot || '';
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e) { return; }
    entries.forEach(function(entry) {
      var fullPath = path.join(dir, entry.name);
      var relPath = relRoot ? relRoot + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') return;
        scan(fullPath, relPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // 跳过根级导航页
        if (!relRoot && SKIP_FILES.indexOf(entry.name) >= 0) return;

        var fm = parseFrontmatter(fullPath);
        fm.relPath = relPath;
        try {
          var st = fs.statSync(fullPath);
          fm.size = st.size;
          fm.mtime = st.mtimeMs;
        } catch(e) {
          fm.size = 0;
          fm.mtime = 0;
        }

        self.manifests[relPath] = {
          title: fm.title,
          type: fm.type,
          tags: fm.tags,
          summary: fm.summary,
          size: fm.size,
          mtime: fm.mtime,
          docType: fm.docType || '',
        };
        self.paths.push(relPath);

        // — 建 title 索引（分词）—
        var titleTokens = tokenize(fm.title);
        var seenTitle = {};
        titleTokens.forEach(function(t) {
          if (seenTitle[t]) return;
          seenTitle[t] = true;
          if (!self.titleIndex[t]) self.titleIndex[t] = [];
          self.titleIndex[t].push(relPath);
        });

        // — 建 tag 索引 —
        fm.tags.forEach(function(tag) {
          var tagLow = tag.toLowerCase().trim();
          if (!tagLow) return;
          if (!self.tagIndex[tagLow]) self.tagIndex[tagLow] = [];
          if (self.tagIndex[tagLow].indexOf(relPath) < 0) {
            self.tagIndex[tagLow].push(relPath);
          }
        });

        // — 建 type 索引 —
        if (fm.type) {
          var typeLow = fm.type.toLowerCase().trim();
          if (!self.typeIndex[typeLow]) self.typeIndex[typeLow] = [];
          if (self.typeIndex[typeLow].indexOf(relPath) < 0) {
            self.typeIndex[typeLow].push(relPath);
          }
        }

        // — 建 doc_type 索引（公文审核按文种召回） —
        if (fm.docType) {
          var dtLow = fm.docType.toLowerCase().trim();
          if (!self.docTypeIndex[dtLow]) self.docTypeIndex[dtLow] = [];
          if (self.docTypeIndex[dtLow].indexOf(relPath) < 0) {
            self.docTypeIndex[dtLow].push(relPath);
          }
        }
      }
    });
  }

  scan(wikiDir);
  self.paths.sort();

  // 持久化到磁盘
  try {
    var toSave = {
      _version: CACHE_VERSION,
      _mtime: dirMtime,
      _builtAt: new Date().toISOString(),
      manifests: self.manifests,
      titleIndex: self.titleIndex,
      tagIndex: self.tagIndex,
      typeIndex: self.typeIndex,
      docTypeIndex: self.docTypeIndex,
      paths: self.paths,
    };
    fs.writeFileSync(cacheFile, JSON.stringify(toSave), 'utf-8');
  } catch(e) { /* 写入失败不影响内存索引 */ }
};

/**
 * 搜索 Wiki 文档（基于 manifest 元数据匹配）
 * @param {string} query — 搜索查询
 * @param {object} options — { topK, category, type, docType, minScore }
 *   docType：精确过滤 doc_type（公文审核按文种召回；不传不过滤）
 * @returns {Array<{id, title, score, type, tags, summary, docType}>}
 */
WikiManifestIndex.prototype.search = function(query, options) {
  var self = this;
  options = options || {};
  var topK = options.topK || 10;
  var category = options.category || null;
  var typeFilter = options.type || category || null; // category alias
  var docTypeFilter = options.docType ? String(options.docType).toLowerCase().trim() : null;
  var minScore = options.minScore || 0.5;

  if (!self.paths.length) return [];

  var scores = {};  // relPath → accumulated score
  var queryTokens = tokenize(query);

  // — 1. Title 匹配（权重 3.0）—
  queryTokens.forEach(function(token) {
    var hits = self.titleIndex[token] || [];
    hits.forEach(function(relPath) {
      scores[relPath] = (scores[relPath] || 0) + 3.0;
    });
  });

  // — 2. Tag 匹配（权重 2.0）—
  queryTokens.forEach(function(token) {
    // 精确 tag 匹配
    Object.keys(self.tagIndex).forEach(function(tag) {
      if (tag.indexOf(token) >= 0 || token.indexOf(tag) >= 0) {
        (self.tagIndex[tag] || []).forEach(function(relPath) {
          scores[relPath] = (scores[relPath] || 0) + 2.0;
        });
      }
    });
  });

  // — 3. Type 匹配（权重 1.5）—
  if (typeFilter) {
    var typeLow = typeFilter.toLowerCase();
    Object.keys(self.typeIndex).forEach(function(t) {
      if (t === typeLow || t.indexOf(typeLow) >= 0) {
        (self.typeIndex[t] || []).forEach(function(relPath) {
          scores[relPath] = (scores[relPath] || 0) + 1.5;
        });
      }
    });
  }

  // — 4. Summary 关键词匹配（权重 1.0）—
  queryTokens.forEach(function(token) {
    Object.keys(self.manifests).forEach(function(relPath) {
      var m = self.manifests[relPath];
      if (m.summary && m.summary.toLowerCase().indexOf(token) >= 0) {
        scores[relPath] = (scores[relPath] || 0) + 1.0;
      }
    });
  });

  // — 5. query 整体子串匹配 title（权重 4.0，最高优先级）—
  var qLower = query.toLowerCase().replace(/\s+/g, '');
  Object.keys(self.manifests).forEach(function(relPath) {
    var titleLow = self.manifests[relPath].title.toLowerCase().replace(/\s+/g, '');
    if (titleLow.indexOf(qLower) >= 0 || qLower.indexOf(titleLow) >= 0) {
      scores[relPath] = (scores[relPath] || 0) + 4.0;
    }
  });

  // — 排序 + 过滤 —
  var results = Object.keys(scores)
    .filter(function(relPath) { return scores[relPath] >= minScore; })
    .filter(function(relPath) {
      // docType 精确过滤：文档 doc_type 命中，或无 doc_type 的页面不受影响
      if (!docTypeFilter) return true;
      var m = self.manifests[relPath] || {};
      return !m.docType || String(m.docType).toLowerCase().trim() === docTypeFilter;
    })
    .sort(function(a, b) { return scores[b] - scores[a]; })
    .slice(0, topK)
    .map(function(relPath) {
      var m = self.manifests[relPath] || {};
      return {
        id: relPath,
        title: m.title || '',
        score: parseFloat(scores[relPath].toFixed(2)),
        type: m.type || '',
        tags: m.tags || [],
        summary: m.summary || '',
        docType: m.docType || '',
      };
    });

  return results;
};

/**
 * 获取候选文档的相对路径列表（供 scope 约束用）
 * @param {string} query
 * @param {object} options
 * @returns {string[]} relPath 数组
 */
WikiManifestIndex.prototype.getCandidates = function(query, options) {
  var results = this.search(query, options);
  return results.map(function(r) { return r.id; });
};

/**
 * 获取单个文件的 manifest 信息
 * @param {string} relPath
 * @returns {object|null}
 */
WikiManifestIndex.prototype.getManifest = function(relPath) {
  return this.manifests[relPath] || null;
};

/**
 * 按需加载文档全文（仅用于候选文档）
 * @param {string} wikiDir — Wiki 根目录
 * @param {string} relPath — 文档相对路径
 * @param {object} options — { maxChars: 截断字符数, stripFrontmatter: 是否去除 frontmatter }
 * @returns {string|null}
 */
WikiManifestIndex.prototype.loadContent = function(wikiDir, relPath, options) {
  options = options || {};
  var maxChars = options.maxChars || 0;
  var stripFM = options.stripFrontmatter !== false;

  var fullPath = path.join(wikiDir, relPath);
  if (!fs.existsSync(fullPath)) {
    // 尝试补 .md 后缀
    fullPath = path.join(wikiDir, relPath + '.md');
    if (!fs.existsSync(fullPath)) return null;
  }

  try {
    var content = fs.readFileSync(fullPath, 'utf-8');
    if (stripFM) {
      content = content.replace(/^---[\s\S]*?---\n*/, '');
    }
    if (maxChars > 0 && content.length > maxChars) {
      content = content.slice(0, maxChars);
    }
    return content;
  } catch(e) {
    return null;
  }
};

/**
 * 清除索引（强制下次 rebuild）
 */
WikiManifestIndex.prototype.invalidate = function() {
  this.manifests = {};
  this.titleIndex = {};
  this.tagIndex = {};
  this.typeIndex = {};
  this.docTypeIndex = {};
  this.paths = [];
  this._wikiDir = null;
  this._mtime = 0;
};

// ── WikiStore：Wiki 文件读写 + manifest 索引维护 ──
// 写入操作内部自动重建 manifest，外部调用方无需感知索引。

function WikiStore(wikiDir, manifest) {
  this.wikiDir = wikiDir;
  this.manifest = manifest || new WikiManifestIndex();
}

// 写入页面 → 自动重建 manifest
WikiStore.prototype.savePage = function(relPath, content) {
  var fullPath = path.join(this.wikiDir, relPath);
  if (!relPath.endsWith('.md')) {
    fullPath = fullPath + '.md';
    relPath = relPath + '.md';
  }
  var dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  this.manifest.build(this.wikiDir, { forceRebuild: true });
};

// 删除页面 → 自动重建 manifest
WikiStore.prototype.deletePage = function(relPath) {
  var fullPath = path.join(this.wikiDir, relPath);
  if (!fs.existsSync(fullPath)) {
    fullPath = path.join(this.wikiDir, relPath + '.md');
  }
  if (!fs.existsSync(fullPath)) return false;
  fs.unlinkSync(fullPath);
  this.manifest.build(this.wikiDir, { forceRebuild: true });
  return true;
};

// 初始化项目目录结构
WikiStore.prototype.initProject = function(projectName) {
  var wp = this.wikiDir;
  if (!fs.existsSync(wp)) fs.mkdirSync(wp, { recursive: true });
  var dirs = ['concepts', 'entities', 'sources', 'syntheses'];
  dirs.forEach(function(d) {
    var dp = path.join(wp, d);
    if (!fs.existsSync(dp)) fs.mkdirSync(dp, { recursive: true });
  });
  fs.writeFileSync(path.join(wp, 'index.md'),
    '# Wiki Index\n\n## ' + projectName + '\n\n_Generated by Knowledge Studio_', 'utf-8');
  fs.writeFileSync(path.join(wp, 'log.md'),
    '# Log\n\n## ' + new Date().toISOString() + ' - Init\n- Project: ' + projectName + '\n- Status: OK\n', 'utf-8');
  fs.writeFileSync(path.join(wp, 'purpose.md'),
    '# Purpose\n\n_Define goals, key questions, and scope._\n', 'utf-8');
  this.manifest.build(this.wikiDir, { forceRebuild: true });
};

// 按需加载全文
WikiStore.prototype.loadContent = function(relPath, opts) {
  return this.manifest.loadContent(this.wikiDir, relPath, opts);
};

module.exports = { WikiManifestIndex, WikiStore, tokenize };
