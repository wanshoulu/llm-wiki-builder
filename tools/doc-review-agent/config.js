/**
 * 公文审核 Agent — 配置
 *
 * 知识库：wiki/doc-rules 项目
 * 模型：qwen-plus（通过 API_ROUTES）
 */

const path = require('path');

const CONFIG = {
  // Wiki 路径（doc-rules 知识库项目，真源在 data/wiki —— 与管理页/wiki-build-agent 共用同一根）
  wikiRoot: path.join(__dirname, '../../data/wiki/doc-rules'),
  rawRoot: path.join(__dirname, '../../wiki-raw'),

  // 文种识别关键词映射
  docTypeKeywords: {
    notice:    ['通知'],
    request:   ['请示'],
    report:    ['报告'],
    letter:    ['函', '复函'],
    reply:     ['批复'],
    meeting:   ['会议纪要', '纪要'],
    decision:  ['决定'],
    opinion:   ['意见'],
    bulletin:  ['通告'],
    announcement: ['公告'],
    command:   ['命令', '令'],
    communique:['通报'],
    bill:      ['议案'],
    instruction: ['指示'],
    regulation: ['制度', '办法', '规定', '章程'],
    summary:   ['总结'],
    work_plan: ['方案', '计划'],
    news:      ['新闻稿', '简报'],
    speech:    ['讲话稿', '主持词'],
  },

  // Skill 定义（5 个审核能力）
  skills: {
    doc_type_identify: {
      name: '文种识别',
      description: '识别公文文种、行文方向，路由到对应规则集',
      tools: ['search_knowledge'],
    },
    format_review: {
      name: '格式审查',
      description: '检查字体字号、版式、页边距、行距、标题层级等格式规范',
      tools: ['search_knowledge', 'format_check'],
    },
    doc_type_rule_review: {
      name: '文种规范审查',
      description: '检查文种专属规则：标题格式、行文方向、规范结语、核心要素',
      tools: ['search_knowledge'],
    },
    language_review: {
      name: '语言风格审查',
      description: '检查用词规范、忌用词、语言风格一致性',
      tools: ['search_knowledge', 'lexicon_check'],
    },
    review_report: {
      name: '审核报告生成',
      description: '汇总所有审查结果，生成结构化审核报告',
      tools: ['search_knowledge'],
    },
  },
};

module.exports = CONFIG;
