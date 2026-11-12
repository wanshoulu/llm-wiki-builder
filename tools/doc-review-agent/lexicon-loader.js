/**
 * 忌用词词典加载器 — wiki/doc-rules/lexicon/taboo-words.md 的单一消费点
 *
 * review-engine.js 与 tools.js 均从此模块获取词典，消除双重解析。
 * 解析逻辑与 review-engine._loadTabooMap 一致（comment/replace 分类，
 * 说明列分段只能批注不能替换）。
 *
 * 条目按词长降序返回（长词优先匹配）：如"觉得可以"应先于"觉得"命中，
 * 否则重叠防护会让短词先占位、长词批注被丢弃（"可能吧"同理）。
 *
 * 缓存：模块级缓存 + 文件 mtime 校验，Knowledge Studio 编辑词典后
 * 下一请求即生效，无需重启服务。wiki 缺失/解析失败 → 内置兜底词表。
 */

const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');

// 内置兜底词表（与历史行为一致）
var BUILTIN_ENTRIES = [
  { word: '觉得', suggest: '认为', action: 'replace' },
  { word: '大概', suggest: '约', action: 'replace' },
  { word: '搞', suggest: '开展', action: 'replace' },
  { word: '弄', suggest: '编制', action: 'replace' },
  { word: '给力', suggest: '扎实', action: 'replace' },
  { word: '点赞', suggest: '肯定', action: 'replace' },
  { word: '巨大', suggest: '用具体数据替代', action: 'comment' },
  { word: '空前', suggest: '用具体数据替代', action: 'comment' },
  { word: '极为', suggest: '用具体程度描述', action: 'comment' },
  { word: '极其', suggest: '用具体程度描述', action: 'comment' },
  { word: '无比', suggest: '用具体程度描述', action: 'comment' },
  { word: '史无前例', suggest: '用具体数据替代', action: 'comment' },
  { word: '前所未有', suggest: '用具体数据替代', action: 'comment' },
  { word: '差不多', suggest: '基本', action: 'replace' },
  { word: '好像', suggest: '经核实', action: 'replace' },
  { word: '应该', suggest: '应当', action: 'replace' },
  { word: '可能', suggest: '或将', action: 'replace' },
];

var _caches = Object.create(null);

function _resolveWikiRoot(options) {
  var configured = typeof options === 'string' ? options : options && options.wikiRoot;
  return path.resolve(configured || CONFIG.wikiRoot);
}

/**
 * 解析词典文件（纯函数，便于单测）
 * @param {string} content taboo-words.md 全文
 * @returns {Array<{word, suggest, action}>}
 */
function parseTabooLexicon(content) {
  var entries = [];
  var sections = content.split(/\n##\s+/);
  var skipSections = ['不规范简称', '使用方式'];
  // 第二列为"说明"而非"推荐替代"的分段：只能批注提醒，不能当替换词塞进正文
  var commentSections = ['夸张修饰词', '情绪化表达'];
  sections.forEach(function(section) {
    var title = section.split('\n')[0];
    var shouldSkip = skipSections.some(function(s) { return section.indexOf(s) === 0; });
    if (shouldSkip) return;
    var isCommentSection = commentSections.indexOf(title) >= 0;
    // 解析表格行：| 忌用词 | 推荐替代/说明 |
    var lines = section.split('\n');
    lines.forEach(function(line) {
      var m = line.match(/^\|\s*([^\|]+?)\s*\|\s*([^\|]+?)\s*\|/);
      if (!m) return;
      var word = m[1].trim();
      var suggestion = m[2].trim();
      // 排除表头、分隔行
      if (['忌用词', '说明', '推荐替代', '推荐', '规范', '---'].indexOf(word) >= 0) return;
      if (word.indexOf('规范') >= 0 || word.indexOf('可用') >= 0) return;
      if (word.length > 8) return;
      // 说明列分段、或括号说明（"（删除，用确定表述）"）→ 批注，不生成替换建议
      if (isCommentSection || suggestion.indexOf('（') === 0) {
        entries.push({ word: word, suggest: suggestion, action: 'comment' });
        return;
      }
      // 推荐替代可能是多个，取第一个
      var firstSuggestion = suggestion.split(/[/／、]/)[0].trim();
      if (firstSuggestion && firstSuggestion !== word) {
        entries.push({ word: word, suggest: firstSuggestion, action: 'replace' });
      }
    });
  });
  return entries;
}

/**
 * 加载词典条目（含 mtime 缓存）
 * @returns {Array<{word, suggest, action}>} 按词长降序
 */
function loadTabooEntries(options) {
  var wikiRoot = _resolveWikiRoot(options);
  var cache = _caches[wikiRoot] || { filePath: '', mtimeMs: -1, entries: null };
  try {
    var candidates = [
      path.join(wikiRoot, '_common/lexicon.md'),
      path.join(wikiRoot, 'lexicon/taboo-words.md'),
    ];
    var p = candidates.find(function(candidate) { return fs.existsSync(candidate); });
    if (!p) throw new Error('lexicon not found');
    var stat = fs.statSync(p);
    if (cache.filePath === p && cache.mtimeMs === stat.mtimeMs && cache.entries) return cache.entries;
    var content = fs.readFileSync(p, 'utf8');
    cache.entries = parseTabooLexicon(content);
    cache.filePath = p;
    cache.mtimeMs = stat.mtimeMs;
  } catch (e) {
    cache.entries = BUILTIN_ENTRIES.slice();
    cache.filePath = '';
    cache.mtimeMs = -1;
  }
  // 长词优先（稳定排序保留同长词的原文顺序）
  cache.entries.sort(function(a, b) { return b.word.length - a.word.length; });
  _caches[wikiRoot] = cache;
  return cache.entries;
}

module.exports = {
  loadTabooEntries: loadTabooEntries,
  parseTabooLexicon: parseTabooLexicon,
  BUILTIN_ENTRIES: BUILTIN_ENTRIES,
};
