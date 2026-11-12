/**
 * 公文审核 Agent — 主入口
 *
 * PERR 循环: Plan → Execute → Reflect → (Replan) → ...
 *
 * 用法:
 *   const agent = new DocReviewAgent({ onEvent });
 *   const result = await agent.run("请审核这段公文...", { docType?: 'notice' });
 */

const https = require('https');
const http = require('http');
const CONFIG = require('./config');
const { SKILLS, getSkill } = require('./skills');
const { search_knowledge, format_check, lexicon_check } = require('./tools');
const { API_ROUTES } = require('../../config/api-keys');

// Tool 执行器映射
const TOOL_EXECUTORS = {
  search_knowledge: function(p) { return search_knowledge(p.query, p.category, p.topK); },
  format_check: function(p) { return format_check(p.text, { docType: p.docType }); },
  lexicon_check: function(p) { return lexicon_check(p.text); },
};

// 文种识别
function identifyDocType(text) {
  for (var _i = 0, _keys = Object.keys(CONFIG.docTypeKeywords); _i < _keys.length; _i++) {
    var docType = _keys[_i];
    var keywords = CONFIG.docTypeKeywords[docType];
    for (var _j = 0; _j < keywords.length; _j++) {
      if (text.indexOf(keywords[_j]) >= 0) return docType;
    }
  }
  return 'unknown';
}

// 行文方向映射
var DIRECTION_MAP = {
  notice: '下行', request: '上行', report: '上行', letter: '平行',
  reply: '下行', meeting: '下行', decision: '下行', opinion: '下行/上行',
  bulletin: '下行/公开', announcement: '公开', command: '下行',
};

class DocReviewAgent {
  constructor(options) {
    options = options || {};
    this.llmConfig = {
      route: options.llmRoute || API_ROUTES['qwen-plus'],
      model: options.llmModel || 'qwen-plus',
      temperature: options.temperature || 0.3,
      maxTokens: options.maxTokens || 4096,
    };
    this.maxExecuteRounds = options.maxExecuteRounds || 10;
    this.wikiRoot = options.wikiRoot || null;
    this.verbose = options.verbose !== false;
    this._emit = options.onEvent || options.onLog || null;
    this._stepIndex = 0;
  }

  /**
   * 主入口
   * @param {string} userMessage 用户消息（含公文文本或审核请求）
   * @param {object} context { docType?, text? }
   */
  async run(userMessage, context) {
    context = context || {};
    var emit = this._emit || function() {};
    var self = this;

    // 提取待审核文本（用户消息本身或 context.text）
    var reviewText = context.text || userMessage;
    var knowledgeOptions = { wikiRoot: context.wikiRoot || this.wikiRoot || CONFIG.wikiRoot };
    var docType = context.docType || identifyDocType(reviewText);
    var direction = DIRECTION_MAP[docType] || '未知';

    emit('start', {
      message: '公文审核启动',
      docType: docType,
      direction: direction,
      textLength: reviewText.length,
    });

    // ═══════════════ 阶段 1: 文种识别 ═══════════════
    this._stepIndex++;
    emit('phase', { phase: '文种识别', status: 'running', stepIndex: this._stepIndex });
    var docTypeInfo = {
      doc_type: docType,
      doc_type_name: (CONFIG.docTypeKeywords[docType] || ['未知'])[0],
      direction: direction,
      confidence: docType === 'unknown' ? 'low' : 'high',
      reasons: docType === 'unknown'
        ? ['未匹配到已知文种关键词']
        : ['匹配到文种关键词：' + (CONFIG.docTypeKeywords[docType] || []).join(',')],
    };
    emit('phase', { phase: '文种识别', status: 'done', result: docTypeInfo });
    emit('step', {
      step: '文种识别完成',
      detail: docTypeInfo.doc_type_name + '（' + docTypeInfo.direction + '）',
      status: 'done',
    });

    // ═══════════════ 阶段 2: 格式审查（确定性检查） ═══════════════
    this._stepIndex++;
    emit('phase', { phase: '格式审查', status: 'running', stepIndex: this._stepIndex });

    var formatResult;
    try {
      formatResult = format_check(reviewText, { docType: docType, wikiRoot: knowledgeOptions.wikiRoot });
      emit('step', {
        step: '确定性格式检查',
        detail: '发现 ' + formatResult.violations.length + ' 个问题（P0:' + formatResult.stats.p0Count + ' P1:' + formatResult.stats.p1Count + ' P2:' + formatResult.stats.p2Count + '）',
        status: 'done',
      });
    } catch (e) {
      formatResult = { violations: [], stats: {}, error: e.message };
      emit('step', { step: '确定性格式检查', detail: '执行失败：' + e.message, status: 'error' });
    }

    // 知识库查询格式规则
    var formatRules;
    try {
      formatRules = await search_knowledge('格式字体字号版式', '格式规范', 3, knowledgeOptions);
      emit('step', {
        step: '检索格式规则',
        detail: '命中 ' + (formatRules.results || []).length + ' 条规则',
        status: 'done',
      });
    } catch (e) {
      formatRules = { results: [] };
      emit('step', { step: '检索格式规则', detail: '检索失败', status: 'error' });
    }
    emit('phase', { phase: '格式审查', status: 'done', result: { violations: formatResult.violations, stats: formatResult.stats } });

    // ═══════════════ 阶段 3: 文种规范审查 ═══════════════
    this._stepIndex++;
    emit('phase', { phase: '文种规范审查', status: 'running', stepIndex: this._stepIndex });

    var docTypeRules;
    try {
      docTypeRules = await search_knowledge(docType, '文种规范', 3, knowledgeOptions);
      emit('step', {
        step: '检索文种规则',
        detail: '命中 ' + (docTypeRules.results || []).length + ' 条 ' + docTypeInfo.doc_type_name + ' 规则',
        status: 'done',
      });
    } catch (e) {
      docTypeRules = { results: [] };
      emit('step', { step: '检索文种规则', detail: '检索失败', status: 'error' });
    }

    // LLM 判断文种规范
    var docTypeViolations = [];
    try {
      var docTypeRuleContent = (docTypeRules.results || []).map(function(r) { return r.content || r.snippet; }).join('\n\n');
      var llmResult = await self._llmJudge({
        skill: 'doc_type_rule_review',
        docType: docType,
        rules: docTypeRuleContent,
        text: reviewText.slice(0, 3000),
      });
      docTypeViolations = (llmResult && llmResult.violations) || [];
      emit('step', {
        step: 'LLM 文种规范审查',
        detail: '发现 ' + docTypeViolations.length + ' 个文种规范问题',
        status: 'done',
      });
    } catch (e) {
      emit('step', { step: 'LLM 文种规范审查', detail: 'LLM 调用失败：' + e.message, status: 'error' });
    }
    emit('phase', { phase: '文种规范审查', status: 'done', result: { violations: docTypeViolations } });

    // ═══════════════ 阶段 4: 语言风格审查 ═══════════════
    this._stepIndex++;
    emit('phase', { phase: '语言风格审查', status: 'running', stepIndex: this._stepIndex });

    var lexiconResult;
    try {
      lexiconResult = lexicon_check(reviewText, knowledgeOptions);
      emit('step', {
        step: '忌用词检查',
        detail: '命中 ' + lexiconResult.totalHits + ' 个忌用词（' + lexiconResult.uniqueWords.length + ' 种）',
        status: 'done',
      });
    } catch (e) {
      lexiconResult = { totalHits: 0, hits: [], uniqueWords: [] };
      emit('step', { step: '忌用词检查', detail: '执行失败', status: 'error' });
    }

    // 检索风格提示词
    var styleRules;
    try {
      styleRules = await search_knowledge('语言风格提示词', '语言风格', 1, knowledgeOptions);
      emit('step', { step: '检索风格规范', detail: '已加载风格提示词', status: 'done' });
    } catch (e) {
      styleRules = { results: [] };
    }
    emit('phase', { phase: '语言风格审查', status: 'done', result: { taboo: lexiconResult } });

    // ═══════════════ 阶段 5: 审核报告生成 ═══════════════
    this._stepIndex++;
    emit('phase', { phase: '审核报告生成', status: 'running', stepIndex: this._stepIndex });

    // 计算评分
    var allViolations = []
      .concat(formatResult.violations || [])
      .concat(docTypeViolations || [])
      .concat((lexiconResult.hits || []).map(function(h) {
        return { rule_id: 'LEXICON', severity: h.severity, message: '忌用词：' + h.word, evidence: h.context };
      }));

    var score = 100;
    var p0Count = 0, p1Count = 0, p2Count = 0;
    allViolations.forEach(function(v) {
      if (v.severity === 'P0') { score -= 25; p0Count++; }
      else if (v.severity === 'P1') { score -= 8; p1Count++; }
      else if (v.severity === 'P2') { score -= 3; p2Count++; }
    });
    score = Math.max(0, score);
    // P0 问题一票否决：任何 P0 直接不通过
    var passed = score >= 60 && p0Count === 0;

    var report = {
      doc_type: docType,
      doc_type_name: docTypeInfo.doc_type_name,
      direction: direction,
      char_count: reviewText.length,
      timestamp: new Date().toISOString(),
      summary: {
        total: allViolations.length,
        p0: allViolations.filter(function(v) { return v.severity === 'P0'; }).length,
        p1: allViolations.filter(function(v) { return v.severity === 'P1'; }).length,
        p2: allViolations.filter(function(v) { return v.severity === 'P2'; }).length,
      },
      violations: allViolations,
      score: score,
      passed: passed,
    };

    emit('step', {
      step: '生成审核报告',
      detail: '评分 ' + score + '/100，' + (report.passed ? '通过' : '不通过'),
      status: 'done',
    });
    emit('phase', { phase: '审核报告生成', status: 'done', result: report });
    emit('report', report);
    emit('complete', { score: score, passed: report.passed });

    return report;
  }

  /**
   * LLM 调用（文种规范判断）
   */
  async _llmJudge(params) {
    var skill = SKILLS[params.skill];
    if (!skill) throw new Error('Unknown skill: ' + params.skill);

    var prompt = '文种：' + params.docType + '\n\n规则：\n' + params.rules + '\n\n待审查公文：\n' + params.text + '\n\n请按 JSON 格式输出违规项：{"violations":[{"rule_id":"","severity":"P0|P1|P2","message":"","evidence":"","expected":""}]}';

    var route = this.llmConfig.route;
    if (!route) throw new Error('LLM route not configured');

    var body = JSON.stringify({
      model: this.llmConfig.model,
      messages: [
        { role: 'system', content: skill.system },
        { role: 'user', content: prompt },
      ],
      temperature: this.llmConfig.temperature,
      max_tokens: this.llmConfig.maxTokens,
    });

    return new Promise(function(resolve, reject) {
      // api-keys.js 的 host 均为裸主机名（无协议前缀），默认 https + 443；
      // 旧逻辑用 host.startsWith('https') 判断会误选 http，导致明文请求必失败
      var lib = route.host.startsWith('http://') ? http : https;
      var req = lib.request({
        hostname: route.host.replace(/^https?:\/\//, ''),
        port: route.port || 443,
        path: route.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (route.getKey ? route.getKey() : route.apiKey),
        },
        timeout: 30000,
      }, function(res) {
        var data = '';
        res.on('data', function(c) { data += c; });
        res.on('end', function() {
          try {
            var json = JSON.parse(data);
            var content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
            // 尝试提取 JSON
            var match = content && content.match(/\{[\s\S]*\}/);
            if (match) {
              resolve(JSON.parse(match[0]));
            } else {
              resolve({ violations: [], raw: content });
            }
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', function() { req.destroy(); reject(new Error('LLM 请求超时（30s）')); });
      req.write(body);
      req.end();
    });
  }
}

module.exports = DocReviewAgent;
