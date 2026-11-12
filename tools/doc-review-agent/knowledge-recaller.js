/**
 * 知识召回器 — 文种识别 → 图谱邻域推理 → 内容装配，供 LLM 审核阶段消费
 *
 * 召回分层（只召回与本文相关的知识，绝不全量塞给大模型）：
 *   核心段（确定性装配）：
 *     docTypePage       文种专属规则页（doc-types/<doc_type>.md，无精确页 → others.md 按文种抽小节）
 *     formatExcerpt     命中档案的参数渲染（format-profiles.md，与 format-checker 同源，
 *                       避免 LLM 拿到的参数与确定性检查器矛盾）
 *     punctuationExcerpt 标点与序号规范（章节抽取：检查规则/序号/日期/常见错误）
 *     styleExcerpt      语言风格提示（按文种映射抽取命中风格节）
 *     lexiconHits       本文命中的忌用词条目（≤10 条，带上下文）
 *   图谱推理段（图驱动装配）：
 *     graphExcerpts     文种页作种子，沿四信号加权边 1-hop + 2-hop（×0.5 衰减）展开邻域，
 *                       过滤无关页后按边权 top-K 装配（w≥4 → 700 字符；w≥2 → 500；其余 300）
 *
 * 字符预算：合计 ≤6500；图谱推理段优先保留，其余按 punctuation→style→docType 顺序减半。
 *
 * 所有读盘操作逐段 try/catch：wiki 任何页面缺失/损坏均返回空段，不抛异常。
 */

const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');
const { loadProfile } = require('./profile-loader');
const { loadTabooEntries } = require('./lexicon-loader');

function _resolveWikiRoot(options) {
  var configured = typeof options === 'string' ? options : options && options.wikiRoot;
  return path.resolve(configured || CONFIG.wikiRoot);
}

// 文种页 frontmatter 提取（只读文件头 4KB）
function _readDocTypeFM(filePath) {
  try {
    var buf = Buffer.alloc(Math.min(4096, fs.statSync(filePath).size));
    var fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    var head = buf.toString('utf8');
    var m = head.match(/^doc_type:\s*"?([^"\n]+)"?/m);
    var t = head.match(/^title:\s*"?([^"\n]+)"?/m);
    return {
      docType: m ? m[1].trim().toLowerCase() : '',
      title: t ? t[1].trim() : '',
    };
  } catch (e) {
    return { docType: '', title: '' };
  }
}

// 建立 doc_type → {relPath, title} 索引（每次调用实时扫描，目录小、开销可忽略）
function _buildDocTypeIndex(wikiRoot) {
  var index = {};
  var dir = path.join(wikiRoot, 'doc-types');
  var entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return index; }
  entries.forEach(function(name) {
    if (!name.endsWith('.md')) return;
    var fm = _readDocTypeFM(path.join(dir, name));
    if (fm.docType) index[fm.docType] = { rel: 'doc-types/' + name, title: fm.title };
  });
  return index;
}

// 读页面正文（剥 frontmatter 与 ## See Also 链接列表，截断 maxChars）
// See Also 是 wikilink 列表、无规则信息价值，剥掉避免挤占预算（行业对照：预算只放规则条款）
function _readPage(relPath, maxChars, wikiRoot) {
  try {
    var full = fs.readFileSync(path.join(wikiRoot, relPath), 'utf8');
    full = full.replace(/^---[\s\S]*?---\n*/, '').trim();
    var seeAlsoIdx = full.search(/\n## See Also\b/);
    if (seeAlsoIdx >= 0) full = full.slice(0, seeAlsoIdx).trim();
    return maxChars > 0 ? full.slice(0, maxChars) : full;
  } catch (e) {
    return '';
  }
}

// 按 ## 小节切分正文（返回 [{heading, body}]，用于按需抽取具体小节）
function _splitSections(mdText) {
  var out = [];
  var re = /^## (.+)$/gm;
  var match;
  var lastTitle = null;
  var lastIdx = null;
  while ((match = re.exec(mdText)) !== null) {
    if (lastTitle !== null) {
      out.push({ heading: lastTitle, body: mdText.slice(lastIdx, match.index).trim() });
    }
    lastTitle = match[1].trim();
    lastIdx = match.index + match[0].length; // 从标题行之后切
  }
  if (lastTitle !== null && !/^See Also/i.test(lastTitle)) {
    out.push({ heading: lastTitle, body: mdText.slice(lastIdx).trim() });
  }
  return out;
}

// 抽取第一个标题匹配的小节
function _selectSection(sections, fn) {
  for (var i = 0; i < sections.length; i++) {
    if (fn(sections[i].heading)) return sections[i];
  }
  return null;
}

// 命中档案参数渲染（与 profile-loader 同源，≤900 字符）
function renderProfileExcerpt(profile, docType) {
  var p = profile.params;
  var lines = [];
  lines.push('格式档案：' + profile.name + (docType ? '（文种 ' + docType + '）' : '（默认）'));
  if (typeof p.page_margin_top_mm === 'number') {
    lines.push('页边距 上' + p.page_margin_top_mm + ' 下' + p.page_margin_bottom_mm +
      ' 左' + p.page_margin_left_mm + ' 右' + p.page_margin_right_mm +
      'mm（容差±' + p.margin_tolerance_mm + 'mm）');
  }
  if (p.title_font) {
    lines.push('大标题：' + p.title_font + ' ' + p.title_size_pt + 'pt 居中');
  }
  if (p.heading1_font) {
    lines.push('一级标题（一、）：' + p.heading1_font + ' ' + p.heading1_size_pt + 'pt');
  }
  if (p.heading2_font) {
    lines.push('二级标题（（一））：' + p.heading2_font + ' ' + p.heading2_size_pt + 'pt');
  }
  if (p.chapter_font) {
    lines.push('章标题（第X章）：' + p.chapter_font + ' ' + p.chapter_size_pt + 'pt 居中');
  }
  if (p.body_font) {
    lines.push('正文：' + p.body_font + ' ' + p.body_size_pt + 'pt 两端对齐，行距 ' +
      p.body_line_spacing_min_pt + '-' + p.body_line_spacing_max_pt + 'pt，首行缩进 ' +
      p.body_first_line_indent_pt + 'pt（±' + p.body_first_line_indent_tolerance_pt + 'pt），字号容差 ±' +
      p.body_size_tolerance_pt + 'pt');
  }
  var flags = [];
  ['check_margins', 'check_fonts', 'check_sizes', 'check_alignment', 'check_line_spacing', 'check_first_line_indent'].forEach(function(f) {
    if (p[f] !== false) flags.push(f.replace('check_', ''));
  });
  lines.push('格式检查范围：' + (flags.length ? flags.join('、') : '仅字号'));
  return lines.join('\n');
}

// 文本命中的忌用词（≤10 条，带上下文）
function findLexiconHits(text, options) {
  var hits = [];
  var seen = {};
  try {
    loadTabooEntries(options).forEach(function(entry) {
      var idx = text.indexOf(entry.word);
      while (idx >= 0 && hits.length < 10) {
        if (!seen[entry.word]) {
          seen[entry.word] = true;
          var start = Math.max(0, idx - 8);
          var end = Math.min(text.length, idx + entry.word.length + 8);
          hits.push('"' + entry.word + '"（…' + text.slice(start, end).replace(/\n/g, ' ') + '…）：' + entry.suggest +
            (entry.action === 'comment' ? '（批注提醒）' : '（建议替换）'));
        }
        idx = text.indexOf(entry.word, idx + entry.word.length);
      }
    });
  } catch (e) { /* 词典失败 → 无命中 */ }
  return hits.slice(0, 10).join('\n');
}

// 递归收集 wiki 下全部 .md 相对路径
function _walkMd(dir, base) {
  var out = [];
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  entries.forEach(function(ent) {
    if (ent.isDirectory()) {
      out = out.concat(_walkMd(path.join(dir, ent.name), base));
    } else if (ent.name.endsWith('.md')) {
      out.push(path.relative(base, path.join(dir, ent.name)).replace(/\\/g, '/'));
    }
  });
  return out;
}

// 读取页面 frontmatter 的 title/category/type/status（只读文件头 4KB）
function _readPageMeta(relPath, wikiRoot) {
  try {
    var filePath = path.join(wikiRoot, relPath);
    var buf = Buffer.alloc(Math.min(4096, fs.statSync(filePath).size));
    var fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    var head = buf.toString('utf8');
    var t = head.match(/^title:\s*"?([^"\n]+)"?/m);
    var c = head.match(/^category:\s*"?([^"\n]+)"?/m);
    var ty = head.match(/^type:\s*"?([^"\n]+)"?/m);
    var st = head.match(/^status:\s*"?([^"\n]+)"?/m);
    return {
      title: t ? t[1].trim() : relPath,
      category: c ? c[1].trim() : '',
      type: ty ? ty[1].trim().toLowerCase() : '',
      status: st ? st[1].trim().toLowerCase() : '',
    };
  } catch (e) {
    return { title: relPath, category: '', type: '', status: '' };
  }
}

/**
 * 图谱邻域推理：文种页作种子，沿四信号加权边 1-hop + 2-hop（×0.5 衰减）展开，
 * 过滤无关页后按边权排序，推理出"该文种核心审核项对应的规则集"。
 * 独立导出：服务端据此发「图谱推理」阶段进度；recallForReview 据其结果做内容装配。
 * @param {string} docType 文种
 * @returns {Array<{id, w, hop}>} 过滤+排序后的规则页候选（含边权与跳数）
 */
function inferGraphRuleSet(docType, options) {
  var wikiRoot = _resolveWikiRoot(options);
  // 解析种子页（与 recallForReview 的文种路由同源）
  var seed = null;
  if (docType) {
    var index = _buildDocTypeIndex(wikiRoot);
    var hit = index[String(docType).toLowerCase()];
    seed = hit ? hit.rel : 'doc-types/others.md';
  }
  if (!seed) return [];

  var graph = require('./wiki-graph-builder').buildGraph(wikiRoot);
  var edges = graph.edges || [];

  // 邻域权值表：pageId → {w, hop}（同页取更短 hop 的原权）
  var neigh = {};
  function bump(id, w, hop) {
    if (id === seed) return;
    if (!neigh[id] || neigh[id].hop > hop) neigh[id] = { w: w, hop: hop };
  }
  edges.forEach(function(e) { // 1-hop
    if (e.source === seed) bump(e.target, e.weight, 1);
    else if (e.target === seed) bump(e.source, e.weight, 1);
  });
  var hop1 = Object.keys(neigh);
  edges.forEach(function(e) { // 2-hop（邻域页的邻域，边权 ×0.5 衰减）
    var a = hop1.indexOf(e.source) >= 0;
    var b = hop1.indexOf(e.target) >= 0;
    if (a && !b) bump(e.target, e.weight * 0.5, 2);
    if (b && !a) bump(e.source, e.weight * 0.5, 2);
  });

  // 过滤：其他文种页、样例、元层页、被取代页、核心段已覆盖页
  var CORE_COVERED = {
    '_common/format-profiles.md': true,
    '_common/punctuation-spec.md': true,
    '_common/citations.md': true, // 溯源表由 citations.js 引擎消费，LLM 注入条款原文即可
    'style/style-prompts.md': true,
    'lexicon/taboo-words.md': true,
  };
  return Object.keys(neigh).map(function(id) {
    return { id: id, w: neigh[id].w, hop: neigh[id].hop };
  }).filter(function(c) {
    if (CORE_COVERED[c.id]) return false;
    if (c.id.indexOf('samples/') === 0) return false;
    if (c.id.indexOf('doc-types/') === 0) return false; // 其他文种页与本篇无关
    if (['index.md', 'overview.md', 'purpose.md', 'SCHEMA.md', 'log.md'].indexOf(c.id) >= 0) return false;
    if (_readPageMeta(c.id, wikiRoot).status === 'superseded') return false; // 被取代页不注入（防与唯一事实源冲突）
    return true;
  }).sort(function(a, b) { return b.w - a.w; });
}

/**
 * 知识库目录（页面 id + 标题）——两级注入 L0 的"导航层"
 * 供 LLM 在 needs_pages 中按 id 请求精读全文（Karpathy index.md 模式）。
 * 只列规则页（concept）：排除元层页（schema/log/summary）、不可变样例（source）与已被取代页（superseded）。
 * @returns {Array<{id, title}>}
 */
function recallCatalog(options) {
  var wikiRoot = _resolveWikiRoot(options);
  var out = [];
  try {
    var all = _walkMd(wikiRoot, wikiRoot);
    var META_CATS = { '元规则': true, '测试样本': true }; // 元层页与样例目录页不进导航目录
    all.forEach(function(rel) {
      if (rel.indexOf('samples/') === 0) return; // 样例原文（raw 层）不进导航目录
      var meta = _readPageMeta(rel, wikiRoot);
      if (!meta.category) return; // 无 category 的页（index/overview/purpose 等）保守排除
      if (META_CATS[meta.category]) return;
      if (meta.status === 'superseded') return;
      out.push({ id: rel, title: meta.title });
    });
  } catch (e) { /* 目录失败 → 空，两级注入退化为单轮 */ }
  return out;
}

/**
 * 按需加载页面全文（两级注入 L1 的"精读层"）
 * @param {string} relPath 页面 id（相对路径）
 * @param {number} maxChars 截断上限（0 = 不截断）
 * @returns {string} 剥 frontmatter 与 See Also 的正文
 */
function loadPageContent(relPath, maxChars, options) {
  return _readPage(relPath, maxChars, _resolveWikiRoot(options));
}

/**
 * 按文种召回审核知识
 * @param {string} docType 文种（空 = 无文种页，仅格式/标点/风格/词典）
 * @param {string} text 公文全文
 * @param {object} options { ruleSet?: 预计算的图谱推理集（服务端 graph 阶段已算过时传入，避免重复构建） }
 * @returns {{ docTypePage, formatExcerpt, punctuationExcerpt, styleExcerpt, lexiconHits }}
 */
function recallForReview(docType, text, options) {
  options = options || {};
  var wikiRoot = _resolveWikiRoot(options);
  text = text || '';
  var out = {
    docTypePage: '',
    formatExcerpt: '',
    punctuationExcerpt: '',
    styleExcerpt: '',
    lexiconHits: '',
    pages: [], // 实际召回的页面 {id, title}（供前端图谱高亮）
  };

  // 1. 文种专属规则页：精确命中（整页剥 See Also）→ others.md 按文种抽取小节 → 空
  var docTypeRel = null;
  try {
    if (docType) {
      var index = _buildDocTypeIndex(wikiRoot);
      var hit = index[String(docType).toLowerCase()];
      if (hit) {
        docTypeRel = hit.rel;
        out.docTypePage = _readPage(hit.rel, 1500, wikiRoot);
        if (out.docTypePage) out.pages.push({ id: hit.rel, title: hit.title || hit.rel });
      } else {
        docTypeRel = 'doc-types/others.md';
        // others.md 含 15 个文种小节：整页截断只到第 4-5 个文种，
        // 命中文种的小节往往被切掉 → 按文种抽取对应小节（找不到小节时回退整页头部）
        var othersBody = _readPage(docTypeRel, 0, wikiRoot);
        var sec = _selectSection(_splitSections(othersBody), function(h) {
          var hl = h.toLowerCase();
          return hl.indexOf('（' + docType + '）') >= 0 || hl.indexOf('(' + docType + ')') >= 0;
        });
        if (sec) {
          out.docTypePage = '（其他文种规则汇总 — ' + sec.heading + ' 小节）\n## ' + sec.heading + '\n' + sec.body.slice(0, 1400);
        } else {
          out.docTypePage = _readPage(docTypeRel, 1500, wikiRoot);
        }
        if (out.docTypePage) out.pages.push({ id: docTypeRel, title: '其他文种规则汇总' });
      }
    }
  } catch (e) { out.docTypePage = ''; }

  // 2. 命中档案参数渲染（与 format-checker 同源）
  try {
    out.formatExcerpt = renderProfileExcerpt(loadProfile(docType, options), docType).slice(0, 900);
    if (fs.existsSync(path.join(wikiRoot, '_common/format-profiles.md'))) {
      out.pages.push({ id: '_common/format-profiles.md', title: '公文格式档案（Format Profiles）' });
    }
  } catch (e) { out.formatExcerpt = ''; }

  // 3. 标点与序号规范：按需抽取章节——「公文常用标点」是 LLM 已知的基础定义，
  //    注入价值高的是错误模式与检查规则（与确定性检查器同源的 CHK-*）
  try {
    var punctBody = _readPage('_common/punctuation-spec.md', 0, wikiRoot);
    var punctSecs = _splitSections(punctBody);
    var punctParts = [];
    ['检查规则', '序号标点用法', '日期与数字用法', '公文常见标点错误'].forEach(function(t) {
      var s = _selectSection(punctSecs, function(h) { return h.indexOf(t) === 0; });
      if (s) punctParts.push('## ' + s.heading + '\n' + s.body);
    });
    out.punctuationExcerpt = punctParts.join('\n\n').slice(0, 1000);
  } catch (e) { out.punctuationExcerpt = ''; }
  if (out.punctuationExcerpt) out.pages.push({ id: '_common/punctuation-spec.md', title: '标点与序号规范' });

  // 4. 语言风格提示：按文种映射抽取对应风格节（与页内「文种与风格映射」表同步），
  //    整页截断只到「通用底座」，六种风格全被切掉 → 按需只取命中的一节
  try {
    var styleBody = _readPage('style/style-prompts.md', 0, wikiRoot);
    var styleSecs = _splitSections(styleBody);
    var STYLE_BY_DOCTYPE = {
      notice: '庄重严谨', request: '请示商洽', report: '宏观概括', meeting: '平实简洁',
      letter: '平实简洁', reply: '庄重严谨', decision: '庄重严谨', opinion: '庄重严谨',
      regulation: '法规条文', speech: '会议主持词', summary: '平实简洁', news: '平实简洁',
      bulletin: '庄重严谨', announcement: '庄重严谨', instruction: '庄重严谨', work_plan: '平实简洁',
    };
    var styleName = STYLE_BY_DOCTYPE[docType] || '庄重严谨';
    var styleSec = _selectSection(styleSecs, function(h) { return h.indexOf(styleName) >= 0; });
    var mapSec = _selectSection(styleSecs, function(h) { return h.indexOf('文种与风格映射') >= 0; });
    var styleParts = [];
    if (styleSec) styleParts.push('## ' + styleSec.heading + '\n' + styleSec.body);
    if (mapSec) styleParts.push('## ' + mapSec.heading + '\n' + mapSec.body);
    out.styleExcerpt = styleParts.join('\n\n').slice(0, 900);
  } catch (e) { out.styleExcerpt = ''; }
  if (out.styleExcerpt) out.pages.push({ id: 'style/style-prompts.md', title: '语言风格提示' });

  // 5. 本文命中忌用词
  out.lexiconHits = findLexiconHits(text, options).slice(0, 800);
  if (out.lexiconHits) {
    var lexiconRel = fs.existsSync(path.join(wikiRoot, '_common/lexicon.md'))
      ? '_common/lexicon.md'
      : 'lexicon/taboo-words.md';
    if (fs.existsSync(path.join(wikiRoot, lexiconRel))) {
      out.pages.push({ id: lexiconRel, title: '公文忌用词词典' });
    }
  }

  // 6. 图谱邻域推理召回（inferGraphRuleSet 推理规则集 → 按边权装配内容）
  out.graphExcerpts = [];
  try {
    // top-K 装配：边权分级给字符配额（w≥4 → 700；w≥1.5 → 500；其余 → 350）
    var K = 6;
    var ruleSet = options.ruleSet || inferGraphRuleSet(docType, options);
    ruleSet.slice(0, K).forEach(function(c) {
      var quota = c.w >= 4 ? 700 : (c.w >= 1.5 ? 500 : 350);
      var content = _readPage(c.id, quota, wikiRoot);
      if (!content) return;
      out.graphExcerpts.push({ id: c.id, title: c.id, hop: c.hop, weight: c.w, content: content });
      out.pages.push({ id: c.id, title: c.id });
    });
  } catch (e) { out.graphExcerpts = []; }

  // 字符预算：合计 ≤6500；图谱推理段（按边权装配，相关性最强）优先保留不参与截断，
  // 其余五段在剩余预算内按 punctuation→style→docType 顺序减半
  var keys = ['docTypePage', 'formatExcerpt', 'punctuationExcerpt', 'styleExcerpt', 'lexiconHits'];
  var total = function() { return keys.reduce(function(s, k) { return s + out[k].length; }, 0); };
  var graphTotal = (out.graphExcerpts || []).reduce(function(s, x) { return s + x.content.length; }, 0);
  var budget = Math.max(4500, 6500 - graphTotal);
  var trimOrder = ['punctuationExcerpt', 'styleExcerpt', 'docTypePage'];
  var ti = 0;
  while (total() > budget && ti < trimOrder.length * 3) {
    var key = trimOrder[ti % trimOrder.length];
    out[key] = out[key].slice(0, Math.max(200, Math.floor(out[key].length / 2)));
    ti++;
  }

  return out;
}

module.exports = {
  recallForReview: recallForReview,
  inferGraphRuleSet: inferGraphRuleSet,
  recallCatalog: recallCatalog,
  loadPageContent: loadPageContent,
  renderProfileExcerpt: renderProfileExcerpt,
  findLexiconHits: findLexiconHits,
};
