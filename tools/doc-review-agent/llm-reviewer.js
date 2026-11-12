/**
 * LLM 审阅器 — 调用 DeepSeek 做语义级公文审查
 *
 * 与规则审阅互补：
 *   规则审阅：确定性检查（标点、忌用词、格式）—— 快、准、零成本
 *   LLM 审阅：语义判断（风格、逻辑、表述、数据支撑）—— 深度、上下文理解
 *
 * LLM 审阅维度：
 *   1. 文种风格一致性
 *   2. 表述清晰度与具体性
 *   3. 逻辑连贯性
 *   4. 用词得体性
 *   5. 数据/事实支撑
 *
 * 输出格式：与规则 ReviewMark 相同结构，可合并到同一渲染管线
 */

const https = require('https');
const { API_ROUTES } = require('../../config/api-keys');

// LLM 配置：优先 deepseek-chat，次选 qwen-plus
function _getLLMConfig() {
  if (API_ROUTES['deepseek-chat'] && API_ROUTES['deepseek-chat'].getKey()) {
    return {
      route: API_ROUTES['deepseek-chat'],
      model: 'deepseek-chat',
    };
  }
  if (API_ROUTES['qwen-plus'] && API_ROUTES['qwen-plus'].getKey()) {
    return {
      route: API_ROUTES['qwen-plus'],
      model: 'qwen-plus',
    };
  }
  return null;
}

// 调用 LLM
function _callLLM(systemPrompt, userPrompt, options) {
  options = options || {};
  var cfg = _getLLMConfig();
  if (!cfg) return Promise.reject(new Error('未配置 LLM API Key'));

  var body = JSON.stringify({
    model: options.model || cfg.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: options.temperature || 0.3,
    max_tokens: options.maxTokens || 3000,
    response_format: { type: 'json_object' },
  });

  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: cfg.route.host.replace(/^https?:\/\//, ''),
      port: 443,
      path: cfg.route.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.route.getKey(),
      },
      timeout: options.timeout || 30000,
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        if (res.statusCode !== 200) {
          reject(new Error('LLM 返回 ' + res.statusCode + ': ' + data.slice(0, 200)));
          return;
        }
        try {
          var json = JSON.parse(data);
          var content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
          resolve(content);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('LLM 超时')); });
    req.write(body);
    req.end();
  });
}

// ============================================================
// 主函数：LLM 语义审阅，返回 ReviewMark 数组
// ============================================================

var SYSTEM_PROMPT = `你是公文审核专家，精通《党政机关公文处理工作条例》和 GB/T 9704-2012。

任务：对公文进行语义级审查，发现规则检查无法覆盖的深层问题。

审查维度：
1. **文种风格一致性**：用词风格是否符合文种特征（通知庄重、请示商洽、报告平实等）
2. **表述清晰度**：是否存在模糊表述、空话套话、缺乏具体数据支撑
3. **逻辑连贯性**：前后表述是否一致、因果关系是否成立、时间线是否合理
4. **用词得体性**：是否存在不得体、不规范、歧义的表述
5. **数据/事实支撑**：关键论断是否有数据或事实支撑

输出格式（严格 JSON）：
{
  "marks": [
    {
      "type": "replace|comment",
      "original": "原文中的问题片段（必须精确匹配原文，用于定位）",
      "suggested": "建议替换的内容（comment 类型为空）",
      "severity": "P0|P1|P2",
      "category": "语义审查",
      "reason": "问题说明（含审查理由）",
      "basis": "法规依据：优先引用用户消息中『知识库规则』段落里的条款原文；其次引用《党政机关公文处理工作条例》条款（如第十五条第（四）项）、GB/T 9704-2012 条款（如 §7.3.3 正文）；无明确条款时写一般性规范依据，如'公文语言应庄重准确'"
    }
  ],
  "summary": {
    "style_score": 0-100,
    "overall_comment": "总体评价"
  }
}

要求：
- 每条 mark 的 original 必须是原文中的精确子串（能定位到原文位置）
- 每条 mark 的 basis 必须给出可溯源依据（优先引用知识库规则条款原文，法规条款次之，惯例兜底），不得为空
- 只报告真正的问题，不报告正确的部分
- P0：严重错误（如文种完全错误、严重逻辑错误）
- P1：需要改进（如表述模糊、风格不符）
- P2：建议优化（如用词可更精准）
- 若公文质量较好，marks 可为空数组`;

// 两级注入 L0（知识导航轮）：独立完整契约——needs_pages 放入 JSON 格式定义且必须输出，
// 避免与 SYSTEM_PROMPT 的 JSON 格式块冲突导致字段被忽略（DeepSeek json_object 只认一个格式块）
var SYSTEM_PROMPT_L0 = `你是公文审核专家，精通《党政机关公文处理工作条例》和 GB/T 9704-2012。

任务：对公文进行语义级审查，发现规则检查无法覆盖的深层问题。

审查维度：
1. **文种风格一致性**：用词风格是否符合文种特征（通知庄重、请示商洽、报告平实等）
2. **表述清晰度**：是否存在模糊表述、空话套话、缺乏具体数据支撑
3. **逻辑连贯性**：前后表述是否一致、因果关系是否成立、时间线是否合理
4. **用词得体性**：是否存在不得体、不规范、歧义的表述
5. **数据/事实支撑**：关键论断是否有数据或事实支撑

输出格式（严格 JSON）：
{
  "needs_pages": ["doc-types/notice.md"],
  "marks": [
    {
      "type": "replace|comment",
      "original": "原文中的问题片段（必须精确匹配原文，用于定位）",
      "suggested": "建议替换的内容（comment 类型为空）",
      "severity": "P0|P1|P2",
      "category": "语义审查",
      "reason": "问题说明（含审查理由）",
      "basis": "法规依据：优先引用用户消息中『知识库规则』段落里的条款原文；其次引用《党政机关公文处理工作条例》条款（如第十五条第（四）项）、GB/T 9704-2012 条款（如 §7.3.3 正文）；无明确条款时写一般性规范依据，如'公文语言应庄重准确'"
    }
  ],
  "summary": {
    "style_score": 0-100,
    "overall_comment": "总体评价"
  }
}

needs_pages 字段要求（必须输出，可为空数组）：
- 从用户消息『知识库目录』中选择需要精读全文的页面 id（左列路径），最多 4 个；id 必须逐字复制自目录左列，不得自造
- 若召回规则与目录信息已足够做出准确判断，needs_pages 给空数组 []，此时 marks 即为最终结果
- 若 needs_pages 非空，系统会补充这些页的全文并请你重新审阅，本轮 marks 为暂定结果

要求：
- 每条 mark 的 original 必须是原文中的精确子串（能定位到原文位置）
- 每条 mark 的 basis 必须给出可溯源依据（优先引用知识库规则条款原文，法规条款次之，惯例兜底），不得为空
- 只报告真正的问题，不报告正确的部分
- P0：严重错误（如文种完全错误、严重逻辑错误）
- P1：需要改进（如表述模糊、风格不符）
- P2：建议优化（如用词可更精准）
- 若公文质量较好，marks 可为空数组`;

// 解析 LLM 返回的 JSON（兼容纯 JSON 与夹带文本）
function _parseResult(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    var match = raw && raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { return { marks: [] }; }
    }
    return { marks: [] };
  }
}

/**
 * LLM 审阅 — 两级注入（L0 知识导航 → L1 精读）
 * L0：注入按文种召回段 + 知识库目录；LLM 声明 needs_pages 需精读页面
 * L1：补充所声明页面全文，重新审阅出最终结果（行业对照：Karpathy index→钻取 2-4 页）
 * 目录缺失 / needs_pages 为空 / L1 失败 → 均退化为单轮（行为与旧版一致）
 * @param {string} text 公文全文
 * @param {string} docType 文种
 * @param {object} options { onProgress?: fn, recall?: 知识召回段, catalog?: 知识库目录 [{id,title}] }
 */
async function llmReview(text, docType, options) {
  options = options || {};
  var onProgress = options.onProgress || function() {};

  onProgress('LLM 审阅启动', '正在调用大模型分析公文语义...');

  // 文种名称
  var docTypeNames = {
    notice: '通知', request: '请示', report: '报告', letter: '函',
    reply: '批复', meeting: '会议纪要', decision: '决定', opinion: '意见',
  };
  var docTypeName = docTypeNames[docType] || '未知';

  // 截断超长文本：保首尾（公文标题/主送在头部，结语/落款日期在尾部——两者都不可丢），
  // 中段省略并加显式标记（行业截断策略 MIDDLE 档）
  var reviewText = text;
  var truncated = null;
  if (text.length > 4000) {
    var head = text.slice(0, 2400);
    var tail = text.slice(-1600);
    var omitted = text.length - 4000;
    reviewText = head + '\n…[中段 ' + omitted + ' 字符已省略]…\n' + tail;
    truncated = { originalLen: text.length, keptHead: 2400, keptTail: 1600, omitted: omitted };
  }
  onProgress('输入预检', truncated
    ? ('文本 ' + text.length + ' 字符超限 → 保留首 ' + truncated.keptHead + ' + 尾 ' + truncated.keptTail + '（中段省略 ' + truncated.omitted + '）')
    : ('文本 ' + text.length + ' 字符，未超限'));

  var userPrompt = '文种：' + docTypeName + '（' + docType + '）\n\n公文全文：\n' + reviewText;

  // 注入按文种召回的知识库规则（供判断与溯源引用；召回为空时行为与旧版一致）
  var recall = options.recall || null;
  var parts = [];
  if (recall) {
    if (recall.docTypePage) parts.push('【文种专属规则】\n' + recall.docTypePage);
    if (recall.formatExcerpt) parts.push('【格式档案参数】\n' + recall.formatExcerpt);
    if (recall.punctuationExcerpt) parts.push('【标点与序号规范】\n' + recall.punctuationExcerpt);
    if (recall.styleExcerpt) parts.push('【语言风格提示】\n' + recall.styleExcerpt);
    if (recall.lexiconHits) parts.push('【本文命中忌用词】\n' + recall.lexiconHits);
    (recall.graphExcerpts || []).forEach(function(ge) {
      parts.push('【' + ge.id + '（图谱推理 · 边权 ' + ge.weight + '）】\n' + ge.content);
    });
    if (parts.length) {
      var knowledgeHeading = options.knowledgeSource && options.knowledgeSource.mode === 'draft_preview'
        ? '——知识库草稿预览（仅供辅助发现问题，未经发布，不得据此声称正式合规）——'
        : '——知识库规则（文种 → 图谱推理召回，basis 溯源请优先引用本段条款）——';
      userPrompt += '\n\n' + knowledgeHeading + '\n' + parts.join('\n\n');
    }
  }

  // 知识库目录（L0 导航层）：LLM 可用 needs_pages 按 id 请求精读
  var catalog = options.catalog || null;
  var catalogIds = {};
  var catalogTitles = {};
  (catalog || []).forEach(function(c) {
    catalogIds[c.id] = true;
    catalogTitles[c.id] = c.title || c.id;
  });
  if (catalog && catalog.length) {
    userPrompt += '\n\n——知识库目录（需精读某页全文时，在 needs_pages 中给左列 id）——\n' +
      catalog.map(function(c) { return c.id + '｜' + c.title; }).join('\n');
  }

  onProgress('LLM 审阅第一轮 · 知识导航', '注入 ' + parts.length + ' 段召回规则 + 知识目录 ' + (catalog ? catalog.length : 0) + ' 页；一次调用并行审 5 维度（风格/表述/逻辑/用词/数据）');

  var raw;
  try {
    raw = await _callLLM(SYSTEM_PROMPT_L0, userPrompt, { timeout: 30000 });
    console.log('[llm-reviewer] LLM round-1 response length:', raw ? raw.length : 0);
  } catch (e) {
    console.error('[llm-reviewer] LLM call failed:', e.message);
    onProgress('LLM 调用失败', e.message);
    return { marks: [], summary: null, needsPages: [], meta: { rounds: 0, truncated: null, needs: [] }, error: e.message };
  }

  var result = _parseResult(raw);

  // L0 → L1：校验 needs_pages（只认目录中真实存在的 id，最多 4 页）
  var needs = [];
  if (Array.isArray(result.needs_pages) && catalog && catalog.length) {
    result.needs_pages.slice(0, 4).forEach(function(id) {
      if (catalogIds[id] && needs.indexOf(id) < 0) needs.push(id);
    });
  }

  if (needs.length) {
    onProgress('LLM 审阅第二轮 · 精读', '精读 ' + needs.length + ' 页：' + needs.join('、') + '，补充全文后重新审阅');
    var extraParts = needs.map(function(id) {
      var content;
      try {
        content = require('./knowledge-recaller').loadPageContent(id, 2000, { wikiRoot: options.wikiRoot });
      } catch (e) { content = ''; }
      return '【' + id + '｜' + (catalogTitles[id] || '') + '】\n' + (content || '（页面不可用）');
    });
    var l1Prompt = userPrompt + '\n\n——补充知识页全文（你请求的精读内容，basis 引用以本段与上文为准）——\n' + extraParts.join('\n\n');
    var raw2;
    try {
      raw2 = await _callLLM(SYSTEM_PROMPT, l1Prompt, { timeout: 30000 });
      console.log('[llm-reviewer] LLM round-2 response length:', raw2 ? raw2.length : 0);
      result = _parseResult(raw2);
    } catch (e) {
      // L1 失败 → 用 L0 结果兜底（行为与单轮一致）
      console.error('[llm-reviewer] LLM round-2 failed, fallback to round-1:', e.message);
      onProgress('精读轮失败', '已用第一轮结果兜底');
    }
  }

  onProgress('解析 LLM 结果', '正在解析大模型返回的审查建议...');

  var marks = (result.marks || []).map(function(m, idx) {
    // 定位 original 在原文中的位置
    var paraIdx = 0;
    var start = -1;
    var end = -1;
    var paragraphs = text.split('\n');

    if (m.original) {
      for (var i = 0; i < paragraphs.length; i++) {
        var pos = paragraphs[i].indexOf(m.original);
        if (pos >= 0) {
          paraIdx = i;
          start = pos;
          end = pos + m.original.length;
          break;
        }
      }
    }

    return {
      id: 'llm-' + (idx + 1),
      type: m.type || 'comment',
      paragraph: paraIdx,
      start: start >= 0 ? start : 0,
      end: end >= 0 ? end : 0,
      original: m.original || '',
      suggested: m.suggested || '',
      rule_id: 'LLM-SEMANTIC',
      severity: m.severity || 'P2',
      reason: m.reason || 'LLM 审查建议',
      category: m.category || '语义审查',
      source: 'llm',
      located: start >= 0, // 是否成功定位到原文
      citation: m.basis
        ? { source: 'LLM 判断', clause: String(m.basis), title: '大模型语义分析依据' }
        : { source: 'LLM 判断', clause: '无明确法规依据', title: '大模型语义分析结论' },
    };
  });

  onProgress('LLM 审阅完成', '发现 ' + marks.length + ' 条语义级建议');

  return {
    marks: marks,
    summary: result.summary || null,
    needsPages: needs, // 两级注入实际精读的页面 id（供统计/调试）
    meta: {
      rounds: needs.length ? 2 : 1, // 调用轮次：L0 单轮 / L0+L1 两轮
      truncated: truncated, // 输入截断信息（null = 未超限）
      needs: needs, // L1 精读页
    },
  };
}

module.exports = {
  llmReview: llmReview,
  _getLLMConfig: _getLLMConfig,
};
