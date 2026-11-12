/**
 * 公文审核 Agent — 工具集
 *
 * Tool #1: search_knowledge  → 搜索 doc-rules 知识库
 * Tool #2: format_check      → 确定性格式检查（Code Checker 雏形）
 * Tool #3: lexicon_check     → 忌用词词典检查
 */

const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');
const { WikiManifestIndex, WikiStore } = require('../wiki-manifest-index');
const { loadTabooEntries } = require('./lexicon-loader');

// Manifest index + WikiStore（缓存复用）
var _agentManifests = Object.create(null);
var _agentStores = Object.create(null);
function _resolveWikiRoot(options) {
  var configured = typeof options === 'string' ? options : options && options.wikiRoot;
  return path.resolve(configured || CONFIG.wikiRoot);
}
function _getAgentManifest(wikiRoot) {
  if (!_agentManifests[wikiRoot]) _agentManifests[wikiRoot] = new WikiManifestIndex();
  return _agentManifests[wikiRoot];
}
function _getAgentStore(wikiRoot) {
  if (!_agentStores[wikiRoot]) _agentStores[wikiRoot] = new WikiStore(wikiRoot, _getAgentManifest(wikiRoot));
  return _agentStores[wikiRoot];
}

// ============================================================
// Tool #1: search_knowledge — 搜索公文规则知识库
// ============================================================
async function search_knowledge(query, category, topK, options) {
  topK = topK || 5;
  const wikiRoot = _resolveWikiRoot(options);
  const manifest = _getAgentManifest(wikiRoot);
  manifest.build(wikiRoot);

  // 1. manifest 匹配候选集（type 参数对分类匹配结果加权）
  var candidates = manifest.search(query, { topK: topK * 3, type: category || undefined });

  // 2. 按分类过滤（search 返回的条目带 type 字段；此前用恒空的 c.frontmatter 过滤，结果被清空）
  if (category) {
    var catLow = String(category).toLowerCase().trim();
    candidates = candidates.filter(function(c) {
      var t = (c.type || '').toLowerCase().trim();
      return t === catLow || t.indexOf(catLow) >= 0 || (t && catLow.indexOf(t) >= 0);
    });
  }

  // 3. 加载全文片段
  var results = candidates.slice(0, topK).map(function(c) {
    var content = '';
    try {
      var full = fs.readFileSync(path.join(wikiRoot, c.id), 'utf8');
      // 去除 frontmatter
      content = full.replace(/^---[\s\S]*?---\n/, '').slice(0, 2000);
    } catch (e) {}
    return {
      id: c.id,
      title: c.title || c.id,
      category: c.type || '',
      score: c.score || 0,
      snippet: content.slice(0, 500),
      content: content,
    };
  });

  return { query: query, results: results, total: results.length };
}

// ============================================================
// Tool #2: format_check — 确定性格式检查
// ============================================================
/**
 * 对公文文本执行确定性格式检查
 * @param {string} text 公文文本
 * @param {object} options { docType?: string }
 * @returns {object} { violations: [], stats: {} }
 */
function format_check(text, options) {
  options = options || {};
  var docType = options.docType || '';
  var violations = [];
  var lines = text.split('\n');

  // ── CHK-HEUR-001 多余空格 ──
  lines.forEach(function(line, i) {
    if (/\s{2,}/.test(line) && line.trim()) {
      violations.push({
        ruleId: 'CHK-HEUR-001',
        severity: 'P1',
        field: 'extra_spaces',
        line: i + 1,
        message: '段落中存在多余空格',
        sample: line.slice(0, 60),
      });
    }
  });

  // ── CHK-HEUR-002 多余空行 ──
  var blankCount = 0;
  lines.forEach(function(line, i) {
    if (!line.trim()) {
      blankCount++;
      if (blankCount >= 3) {
        violations.push({
          ruleId: 'CHK-HEUR-002',
          severity: 'P2',
          field: 'extra_blank_lines',
          line: i + 1,
          message: '连续出现多个空行（' + blankCount + '行）',
        });
      }
    } else {
      blankCount = 0;
    }
  });

  // ── 标题字数检查 ──
  var firstLine = lines.find(function(l) { return l.trim(); }) || '';
  if (firstLine && firstLine.length > 20 && docType !== 'news') {
    violations.push({
      ruleId: 'CHK-TITLE-001',
      severity: 'P2',
      field: 'title.length',
      message: '公文标题超过20字（当前 ' + firstLine.length + ' 字）',
      sample: firstLine,
      expected: '≤20字',
    });
  }

  // ── 文种结语检查 ──
  if (docType) {
    var endingMap = {
      notice:    ['特此通知'],
      request:   ['妥否，请批示', '以上请示，请予批复', '请批示', '请批复'],
      report:    ['特此报告'],
      letter:    ['特此函复', '请予函复', '专此函达', '特此函达'],
      reply:     ['此复', '特此批复'],
      bulletin:  ['特此通告'],
      announcement: ['特此公告'],
    };
    var endings = endingMap[docType];
    if (endings) {
      var hasEnding = endings.some(function(e) { return text.indexOf(e) >= 0; });
      if (!hasEnding) {
        violations.push({
          ruleId: 'CHK-END-' + docType.toUpperCase(),
          severity: docType === 'request' ? 'P0' : 'P2',
          field: 'ending.check',
          message: '缺少文种规范结语，建议：' + endings.join(' / '),
          expected: endings.join(' 或 '),
        });
      }
    }
  }

  // ── 一文一事检查（请示） ──
  if (docType === 'request') {
    if (/[；；]$/.test(text) && (text.match(/请示|申请|恳请/g) || []).length > 2) {
      violations.push({
        ruleId: 'CHK-R002',
        severity: 'P1',
        field: 'content.single_topic',
        message: '请示应遵循一文一事原则，疑似包含多个事项',
      });
    }
  }

  // ── CHK-PUNC-001 半角标点检查 ──
  // 半角句点 . / 半角逗号 , / 半角冒号 : / 半角分号 ;
  // 排除：数字小数点、英文标点（公文中应避免但可能误报）
  lines.forEach(function(line, i) {
    var trimmed = line.trim();
    if (!trimmed) return;
    // 半角句点（非小数点）：句末或词末的 . 
    var halfPeriod = trimmed.match(/[\u4e00-\u9fa5]\.\s*$/) || trimmed.match(/[\u4e00-\u9fa5]\.[\u4e00-\u9fa5]/);
    if (halfPeriod) {
      violations.push({
        ruleId: 'CHK-PUNC-001',
        severity: 'P1',
        field: 'text.punctuation',
        line: i + 1,
        message: '检测到半角句点"."，公文应使用全角句号"。"',
        sample: trimmed.slice(0, 40),
        expected: '。',
      });
    }
    // 半角冒号（中文后）
    var halfColon = trimmed.match(/[\u4e00-\u9fa5]:/) || trimmed.match(/:[\u4e00-\u9fa5]/);
    if (halfColon) {
      violations.push({
        ruleId: 'CHK-PUNC-001',
        severity: 'P1',
        field: 'text.punctuation',
        line: i + 1,
        message: '检测到半角冒号":"，公文应使用全角冒号"："',
        sample: trimmed.slice(0, 40),
        expected: '：',
      });
    }
    // 半角逗号（中文后）
    var halfComma = trimmed.match(/[\u4e00-\u9fa5],/) || trimmed.match(/,[\u4e00-\u9fa5]/);
    if (halfComma) {
      violations.push({
        ruleId: 'CHK-PUNC-001',
        severity: 'P1',
        field: 'text.punctuation',
        line: i + 1,
        message: '检测到半角逗号","，公文应使用全角逗号"，"',
        sample: trimmed.slice(0, 40),
        expected: '，',
      });
    }
  });

  // ── CHK-PUNC-002 序号标点检查 ──
  // 一级序号 "一." "二." 应为 "一、" "二、"
  // 二级序号 "（一）、" 应为 "（一）" 不加标点
  // 三级序号 "1、" "2、" 应为 "1." "2."（下脚点）
  // 四级序号 "（1）." "（1）、" 应为 "（1）" 不加标点
  lines.forEach(function(line, i) {
    var trimmed = line.trim();
    if (!trimmed) return;
    // 一级序号错误：一. 二. 三.
    if (/^[一二三四五六七八九十]+\./.test(trimmed)) {
      violations.push({
        ruleId: 'CHK-PUNC-002',
        severity: 'P1',
        field: 'text.numbering',
        line: i + 1,
        message: '一级序号"一"后应使用顿号"、"而非句点"."',
        sample: trimmed.slice(0, 20),
        expected: '一、',
      });
    }
    // 三级序号错误：1、 2、 3、
    if (/^\d+、/.test(trimmed)) {
      violations.push({
        ruleId: 'CHK-PUNC-002',
        severity: 'P1',
        field: 'text.numbering',
        line: i + 1,
        message: '三级序号阿拉伯数字后应使用下脚点"."而非顿号"、"',
        sample: trimmed.slice(0, 20),
        expected: '1.',
      });
    }
    // 二级序号错误：（一）、 （二）、
    if (/^（[一二三四五六七八九十]+）[、.，,]/.test(trimmed)) {
      violations.push({
        ruleId: 'CHK-PUNC-002',
        severity: 'P2',
        field: 'text.numbering',
        line: i + 1,
        message: '二级序号"（一）"后不应加标点',
        sample: trimmed.slice(0, 20),
        expected: '（一）',
      });
    }
    // 四级序号错误：（1）、 （1）.
    if (/^（\d+）[、.，,]/.test(trimmed)) {
      violations.push({
        ruleId: 'CHK-PUNC-002',
        severity: 'P2',
        field: 'text.numbering',
        line: i + 1,
        message: '四级序号"（1）"后不应加标点',
        sample: trimmed.slice(0, 20),
        expected: '（1）',
      });
    }
  });

  // ── CHK-PUNC-003 日期格式检查 ──
  // 落款日期应为 "YYYY年MM月DD日"（阿拉伯数字）
  // 错误：二〇二六年 / 2026/8/22 / 2026-08-22
  var dateLines = lines.filter(function(l) { return l.trim() && /\d{4}|\u5e74/.test(l); });
  dateLines.forEach(function(line, i) {
    var trimmed = line.trim();
    // 检查汉字数字日期
    if (/[〇一二三四五六七八九]+年[〇一二三四五六七八九]+月/.test(trimmed)) {
      violations.push({
        ruleId: 'CHK-PUNC-003',
        severity: 'P1',
        field: 'date.format',
        line: i + 1,
        message: '公文日期应使用阿拉伯数字，检测到汉字数字日期',
        sample: trimmed,
        expected: 'YYYY年MM月DD日',
      });
    }
    // 检查斜杠或短横线日期格式
    if (/\d{4}[/-]\d{1,2}[/-]\d{1,2}/.test(trimmed)) {
      violations.push({
        ruleId: 'CHK-PUNC-003',
        severity: 'P1',
        field: 'date.format',
        line: i + 1,
        message: '公文日期应使用"YYYY年MM月DD日"格式，检测到斜杠或短横线格式',
        sample: trimmed,
        expected: 'YYYY年MM月DD日',
      });
    }
  });

  // ── CHK-DIR-002 多头主送检查（请示） ──
  if (docType === 'request') {
    // 查找"主送"行或开头机关行
    var recipientLine = lines.find(function(l) {
      var t = l.trim();
      return t && !t.startsWith('关于') && !t.startsWith('为') && t.endsWith('：');
    });
    if (recipientLine) {
      // 检查是否有多个主送机关（顿号或逗号分隔）
      var recipients = recipientLine.replace(/[：:]$/, '').split(/[、,，]/);
      if (recipients.length > 1) {
        violations.push({
          ruleId: 'CHK-DIR-002',
          severity: 'P1',
          field: 'header.recipient',
          message: '请示应主送一个上级机关，检测到多个主送机关',
          sample: recipientLine,
          expected: '单一主送机关',
        });
      }
    }
  }

  // ── CHK-DIR-003 报告夹带请示检查 ──
  if (docType === 'report') {
    // 1. 检查请示类结语（强信号）
    var requestEndings = ['妥否，请批示', '妥否,请批示', '以上请示', '请批复', '请予批复', '请批示', '请予批准', '请予审批'];
    var hasRequestEnding = requestEndings.some(function(k) { return text.indexOf(k) >= 0; });
    if (hasRequestEnding) {
      violations.push({
        ruleId: 'CHK-DIR-003',
        severity: 'P0',
        field: 'content.no_request',
        message: '报告中不得夹带请示事项，检测到请示类结语',
        expected: '请示事项应另行发文',
      });
    }
    // 2. 检查"请示事项"小节标题（强信号）
    if (/^\s*[一二三四五六七八九十]+[、.．]\s*请示/.test(text) || /\n[一二三四五六七八九十]+[、.．]\s*请示/.test(text)) {
      violations.push({
        ruleId: 'CHK-DIR-003',
        severity: 'P0',
        field: 'content.no_request',
        message: '报告中夹带请示事项（检测到"请示"小节标题）',
        expected: '请示事项应另行发文',
      });
    }
    // 3. 检查"请总行/领导 + 批复/批准/审批"模式（中等信号）
    if (/请.*(总行|领导|上级).*(批复|批准|审批|批示)/.test(text) || /(追加|拨付|核拨).*\d+(万元|元)/.test(text)) {
      violations.push({
        ruleId: 'CHK-DIR-003',
        severity: 'P0',
        field: 'content.no_request',
        message: '报告中夹带请示事项（检测到资金请示类表述）',
        expected: '请示事项应另行发文',
      });
    }
    // 4. 检查"请示"字样（弱信号，需排除"请示事项"等否定表述）
    var cleanText = text.replace(/请示事项|不.?得.?夹带请示|另.?行.?发.?文/g, '');
    if (/请示/.test(cleanText)) {
      violations.push({
        ruleId: 'CHK-DIR-003',
        severity: 'P1',
        field: 'content.no_request',
        message: '报告中出现"请示"字样，请确认是否夹带请示事项',
        expected: '报告中不应出现请示字样',
      });
    }
  }

  // ── CHK-HEAD-001 发文字号格式检查 ──
  // 匹配 X发[2026]5号 / X发（2026）5号 / X发〔2026〕第5号 / X发〔2026〕05号
  var docNumberPatterns = [
    { pattern: /[A-Za-z\u4e00-\u9fa5]+发\[\d{4}\]/, issue: '发文字号年份应用六角括号〔〕而非方括号[]', expected: '〔〕' },
    { pattern: /[A-Za-z\u4e00-\u9fa5]+发（\d{4}）/, issue: '发文字号年份应用六角括号〔〕而非圆括号（）', expected: '〔〕' },
    { pattern: /〔\d{4}〕第\d+号/, issue: '发文字号序号不应加"第"字', expected: '不加"第"' },
    { pattern: /〔\d{4}〕0\d+号/, issue: '发文字号序号不应编虚位', expected: '不编虚位' },
  ];
  docNumberPatterns.forEach(function(p) {
    if (p.pattern.test(text)) {
      violations.push({
        ruleId: 'CHK-HEAD-001',
        severity: 'P0',
        field: 'header.doc_number',
        message: p.issue,
        expected: p.expected,
      });
    }
  });

  // ── CHK-PUNC-005 省略号格式检查 ──
  if (/\.\.\./.test(text) && text.indexOf('...') >= 0) {
    violations.push({
      ruleId: 'CHK-PUNC-005',
      severity: 'P2',
      field: 'text.ellipsis',
      message: '省略号应使用六个点"……"，检测到三个点"..."',
      expected: '……',
    });
  }

  // ── 统计 ──
  var stats = {
    totalLines: lines.length,
    nonEmptyLines: lines.filter(function(l) { return l.trim(); }).length,
    charCount: text.length,
    violationCount: violations.length,
    p0Count: violations.filter(function(v) { return v.severity === 'P0'; }).length,
    p1Count: violations.filter(function(v) { return v.severity === 'P1'; }).length,
    p2Count: violations.filter(function(v) { return v.severity === 'P2'; }).length,
  };

  return { violations: violations, stats: stats };
}

// ============================================================
// Tool #3: lexicon_check — 忌用词检查（词典来自 lexicon-loader 单一消费点）
// ============================================================
function lexicon_check(text, options) {
  var entries = loadTabooEntries(options);
  var hits = [];

  entries.forEach(function(entry) {
    var w = entry.word;
    var idx = text.indexOf(w);
    while (idx >= 0) {
      // 取上下文
      var start = Math.max(0, idx - 10);
      var end = Math.min(text.length, idx + w.length + 10);
      hits.push({
        word: w,
        position: idx,
        context: text.slice(start, end),
        severity: 'P1',
        suggestion: entry.action === 'comment' ? entry.suggest : '替换为"' + entry.suggest + '"',
      });
      idx = text.indexOf(w, idx + w.length);
    }
  });

  return {
    totalHits: hits.length,
    hits: hits.slice(0, 20), // 限制返回数量
    uniqueWords: [...new Set(hits.map(function(h) { return h.word; }))],
  };
}

module.exports = {
  search_knowledge: search_knowledge,
  format_check: format_check,
  lexicon_check: lexicon_check,
};
