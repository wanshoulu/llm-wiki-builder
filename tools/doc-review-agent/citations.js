/**
 * 公文审核规则溯源表 — rule_id → 法规依据
 *
 * 溯源知识在 wiki 中统一管理：wiki/doc-rules/_common/citations.md 三表
 * （规则溯源/分类兜底/总则兜底）为事实源，Knowledge Studio 编辑后下一请求生效。
 * 本文件内嵌表为历史基线 + wiki 缺失/解析失败时的兜底。
 * 条款号经权威文本核实（2026-08-22 网络检索）：
 *   GB/T 9704-2012：§7.2.5 发文字号 / §7.3.1 标题 / §7.3.3 正文 / §7.3.5 成文日期
 *   《党政机关公文处理工作条例》第十五条第（四）项：一文一事、不得夹带请示
 */

const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');

// ── wiki 溯源页加载（mtime 缓存；失败 → 内嵌表兜底） ──

var _wikiCaches = Object.create(null);

function _resolveWikiRoot(options) {
  var configured = typeof options === 'string' ? options : options && options.wikiRoot;
  return path.resolve(configured || CONFIG.wikiRoot);
}

/**
 * 解析 citations.md 三表（纯函数，便于单测）
 * @returns {{ rules: object, categories: object, final: object|null }}
 */
function parseCitationsMd(mdText) {
  var data = { rules: {}, categories: {}, final: null };
  var section = '';
  var lines = mdText.split('\n');
  lines.forEach(function(line) {
    var sec = line.match(/^##\s+(.+)/);
    if (sec) { section = sec[1].trim(); return; }
    if (!/^\|/.test(line)) return;
    var m = line.match(/^\|([\s\S]*)\|$/);
    if (!m) return;
    var cells = m[1].split('|').map(function(c) { return c.trim(); });
    // 分隔行 |---|---|
    if (cells.every(function(c) { return /^-{2,}:?$/.test(c) || c === ''; })) return;
    if (section === '规则溯源表') {
      if (cells[0] === 'rule_id' || !cells[0]) return;
      if (cells.length >= 4) data.rules[cells[0]] = { source: cells[1], clause: cells[2], title: cells[3] };
    } else if (section === '分类兜底表') {
      if (cells[0] === 'category' || !cells[0]) return;
      if (cells.length >= 4) data.categories[cells[0]] = { source: cells[1], clause: cells[2], title: cells[3] };
    } else if (section === '总则兜底表') {
      if (cells[0] === 'source' || !cells[0]) return;
      if (cells.length >= 3) data.final = { source: cells[0], clause: cells[1], title: cells[2] };
    }
  });
  return data;
}

function loadWikiCitations(options) {
  var wikiRoot = _resolveWikiRoot(options);
  var cache = _wikiCaches[wikiRoot] || { mtimeMs: -1, data: null };
  try {
    var p = path.join(wikiRoot, '_common/citations.md');
    var stat = fs.statSync(p);
    if (cache.mtimeMs === stat.mtimeMs && cache.data) return cache.data;
    var content = fs.readFileSync(p, 'utf8');
    var data = parseCitationsMd(content);
    if (!Object.keys(data.rules).length) throw new Error('parsed rules empty');
    cache.data = data;
    cache.mtimeMs = stat.mtimeMs;
  } catch (e) {
    cache.data = null;
    cache.mtimeMs = -1;
  }
  _wikiCaches[wikiRoot] = cache;
  return cache.data;
}

// 合并表：wiki 行优先，内嵌行兜底（wiki 部分缺失不影响可用性）
function loadCitationTables(options) {
  var rules = Object.assign({}, CITATIONS);
  var cats = Object.assign({}, CATEGORY_FALLBACK);
  var finalFallback = FINAL_FALLBACK;
  var w = loadWikiCitations(options);
  if (w) {
    Object.assign(rules, w.rules);
    Object.assign(cats, w.categories);
    if (w.final && w.final.source) finalFallback = w.final;
  }
  return { rules: rules, cats: cats, finalFallback: finalFallback };
}

const CITATIONS = {
  // ── 语言规范 ──
  'LEXICON': {
    source: '《党政机关公文处理工作条例》',
    clause: '公文起草要求（文件级）',
    title: '公文用词规范（结合知识库忌用词词典）',
  },
  'CHK-PUNC-001': {
    source: 'GB/T 15834-2011《标点符号用法》',
    clause: '全文（文件级）',
    title: '公文中标点应使用全角形式',
  },
  'CHK-PUNC-002': {
    source: 'GB/T 9704-2012《党政机关公文格式》',
    clause: '§7.3.3 正文',
    title: '结构层次序数依次用"一、""（一）""1.""（1）"',
  },
  'CHK-PUNC-003': {
    source: 'GB/T 9704-2012《党政机关公文格式》',
    clause: '§7.3.5 成文日期',
    title: '用阿拉伯数字将年、月、日标全（结合 GB/T 15835 数字用法）',
  },
  'CHK-PUNC-005': {
    source: 'GB/T 15834-2011《标点符号用法》',
    clause: '全文（文件级）',
    title: '省略号用六个点"……"',
  },
  'CHK-HEUR-001': {
    source: 'GB/T 9704-2012《党政机关公文格式》',
    clause: '版式要求（文件级）',
    title: '版面规范、无多余空格',
  },

  // ── 格式规范 ──
  'CHK-HEAD-001': {
    source: 'GB/T 9704-2012《党政机关公文格式》',
    clause: '§7.2.5 发文字号',
    title: '年份用六角括号〔〕、顺序号不加"第"、不编虚位',
  },
  'CHK-FMT-001': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '§5.2 版面', title: '页边距（上）应为 37mm' },
  'CHK-FMT-002': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '§5.2 版面', title: '页边距（下）应为 35mm' },
  'CHK-FMT-003': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '§5.2 版面', title: '页边距（左）应为 28mm' },
  'CHK-FMT-004': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '§5.2 版面', title: '页边距（右）应为 26mm' },
  'CHK-FMT-010': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '§7.3.1 标题', title: '标题用 2 号小标宋体字' },
  'CHK-FMT-011': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '§7.3.3 正文', title: '结构层次第一层用黑体字' },
  'CHK-FMT-012': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '§7.3.3 正文', title: '结构层次第二层用楷体字' },
  'CHK-FMT-013': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '§7.3.3 正文', title: '正文用 3 号仿宋体字' },
  'CHK-FMT-020': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '§7.3.1 标题', title: '标题用 2 号字（22pt）' },
  'CHK-FMT-021': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '§7.3.3 正文', title: '结构层次第一层用 3 号字（16pt）' },
  'CHK-FMT-022': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '§7.3.3 正文', title: '结构层次第二层用 3 号字（16pt）' },
  'CHK-FMT-023': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '§7.3.3 正文', title: '正文用 3 号字（16pt）' },
  'CHK-FMT-030': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '§7.3.1 标题', title: '标题居中排布' },
  'CHK-FMT-040': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '§5.2 版面', title: '一般每面排 22 行、每行排 28 个字（行距 28-30pt）' },
  'CHK-FMT-050': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '§7.3.3 正文', title: '每个自然段左空二字' },

  // ── 行文规范 ──
  'CHK-DIR-001': {
    source: '《党政机关公文处理工作条例》',
    clause: '第十五条第（四）项',
    title: '请示应当一文一事',
  },
  'CHK-DIR-002': {
    source: '《党政机关公文处理工作条例》',
    clause: '第十五条（向上级机关行文规则）',
    title: '原则上主送一个上级机关，不得多头请示',
  },
  'CHK-DIR-003': {
    source: '《党政机关公文处理工作条例》',
    clause: '第十五条第（四）项',
    title: '不得在报告等非请示性公文中夹带请示事项',
  },

  // ── 文种规范 ──
  'CHK-END-*': {
    source: '公文写作惯例',
    clause: '参照《条例》第二章公文种类',
    title: '各文种规范结语（详见知识库 doc-types/*.md）',
  },
  'CHK-TITLE-001': {
    source: '公文标题写作惯例',
    clause: '标题简明扼要',
    title: '公文标题一般不超过 20 字',
  },
};

// category 兜底（rule_id 未命中时的通用依据）
const CATEGORY_FALLBACK = {
  '语言规范': { source: 'GB/T 15834-2011《标点符号用法》', clause: '全文（文件级）', title: '公文语言与标点规范（结合 GB/T 15835）' },
  '格式规范': { source: 'GB/T 9704-2012《党政机关公文格式》', clause: '文件级', title: '党政机关公文格式' },
  '文种规范': { source: '《党政机关公文处理工作条例》', clause: '第二章 公文种类', title: '文种规范' },
  '行文规范': { source: '《党政机关公文处理工作条例》', clause: '第十五条 行文规则', title: '行文规范' },
  '语义审查': { source: 'LLM 判断', clause: '—', title: '大模型语义分析结论' },
};

const FINAL_FALLBACK = {
  source: '《党政机关公文处理工作条例》/ GB/T 9704-2012',
  clause: '文件级',
  title: '公文规范总则',
};

/**
 * 取规则依据：精确匹配 → CHK-END-* 通配 → category 兜底 → 总则兜底
 * （表来自 wiki 溯源页 + 内嵌表兜底，见 loadCitationTables）
 */
function getCitation(ruleId, category, options) {
  var tables = loadCitationTables(options);
  if (ruleId && tables.rules[ruleId]) return tables.rules[ruleId];
  if (ruleId && ruleId.indexOf('CHK-END-') === 0 && tables.rules['CHK-END-*']) return tables.rules['CHK-END-*'];
  if (category && tables.cats[category]) return tables.cats[category];
  return tables.finalFallback;
}

/**
 * 路由层安全网：为缺 citation 的 mark 补齐（已有则不覆盖）
 */
function enrichMarks(marks, options) {
  return (marks || []).map(function(m) {
    if (m.citation && m.citation.source) return m;
    var copy = Object.assign({}, m);
    copy.citation = getCitation(m.rule_id, m.category, options);
    return copy;
  });
}

module.exports = {
  CITATIONS: CITATIONS,
  CATEGORY_FALLBACK: CATEGORY_FALLBACK,
  getCitation: getCitation,
  enrichMarks: enrichMarks,
  parseCitationsMd: parseCitationsMd,
  loadCitationTables: loadCitationTables,
};
