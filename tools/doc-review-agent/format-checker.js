/**
 * 公文格式检查器 — 基于 GB/T 9704-2012 检查 docx 格式
 *
 * 检查维度：
 *   1. 页边距（上 37mm / 下 35mm / 左 28mm / 右 26mm）
 *   2. 正文字体（仿宋_GB2312 三号 = 16pt）
 *   3. 标题字体（大标题：方正小标宋简体二号；一级标题：黑体三号）
 *   4. 行距（28-30 磅）
 *   5. 首行缩进（2 字符）
 *   6. 对齐方式（正文两端对齐，标题居中）
 *
 * 输入：docx-parser 解析的结构化文档
 * 输出：ReviewMark 数组（与文本审阅相同结构）
 */

const { getCitation } = require('./citations');
const { loadProfile } = require('./profile-loader');

// 历史硬编码基线（deprecated，仅供兼容引用）：
// 格式参数唯一事实源 = wiki/doc-rules/_common/format-profiles.md（四类档案），
// checkFormat 通过 profile-loader 按文种加载对应档案参数。
var FORMAT_SPEC = {
  page_margin: {
    top_mm: 37,
    bottom_mm: 35,
    left_mm: 28,
    right_mm: 26,
    tolerance_mm: 2, // 容差 ±2mm
  },
  doc_title: { // 公文大标题
    font: '方正小标宋简体',
    size_pt: 22, // 二号
    alignment: 'center',
  },
  heading_1: { // 一级标题（一、二、三）
    font: '黑体',
    size_pt: 16, // 三号
  },
  heading_2: { // 二级标题（（一）（二））
    font: '楷体_GB2312',
    size_pt: 16, // 三号
  },
  body: { // 正文
    font: '仿宋_GB2312',
    size_pt: 16, // 三号
    alignment: 'both', // 两端对齐
    line_spacing_pt: 28, // 28-30 磅
    first_line_indent_pt: 32, // 2 字符 ≈ 32pt（三号字 16pt × 2）
  },
};

// 识别段落角色
// 顺序要点：豁免角色（附件/版记/文号/签发人/章标题）先于大标题判断，
// 避免被"居中+位置"启发式误判；大标题不再按字体识别——各档案标题字体不同
// （gov=小标宋，regulation/enterprise/briefing=黑体），字体是否合规由档案参数检查。
function identifyParagraphRole(para, idx, paragraphs, firstNonEmptyIdx) {
  var text = para.text.trim();
  if (!text) return 'empty';

  var styleName = (para.format.style_name || '').toLowerCase();

  // 表格单元格：表内文字常用五号宋体，与正文规范不同，格式检查豁免
  if (para.is_table) return 'table';

  // 红头发文机关标志：红色大字（如"XX银行股份有限公司文件"），非标题，豁免
  if (idx === firstNonEmptyIdx && /文件$/.test(text) && hasRedRun(para)) {
    return 'org_flag';
  }

  // 附件说明（"附件：..."）：位置与字体与正文不同，豁免
  if (/^附件[:：]/.test(text)) return 'attachment';

  // 版记（"抄送：..." 或 "XXX印发"）：4号仿宋，与正文规格不同，豁免
  if (/^抄送[:：]/.test(text) || /印发$/.test(text)) return 'version';

  // 发文字号（"XX银发〔2026〕15号"）：3号仿宋居中（下行文），豁免
  if (/[〔\[]\d{4}[〕\]]\s*\d*号$/.test(text)) return 'doc_num';

  // 签发人（上行文版头）："签发人"3号仿宋 + 姓名3号楷体、右对齐，豁免
  if (/^签发人[:：]/.test(text)) return 'signer';

  // 章标题（制度文件："第一章 总则"等，黑体居中），先于大标题判断
  if (/^第[一二三四五六七八九十]+章/.test(text)) return 'chapter';

  // 大标题：第一个非空段落，或 style=Title，或版头之后居中排布的首个标题行
  if (idx === firstNonEmptyIdx || styleName.indexOf('title') >= 0) {
    return 'doc_title';
  }
  if (para.format.alignment === 'center' && idx > firstNonEmptyIdx && idx <= firstNonEmptyIdx + 6) {
    return 'doc_title';
  }

  // 标题级别（通过 style 或文本特征）
  if (para.format.heading_level === 1 || /^[一二三四五六七八九十]+[、．]/.test(text)) {
    return 'heading_1';
  }
  if (para.format.heading_level === 2 || /^（[一二三四五六七八九十]+）/.test(text)) {
    return 'heading_2';
  }

  // 落款（右对齐特征识别，不依赖"最后3段"启发式——版记在落款之后；
  //   "会议记录：办公室"等纪要落款要素也在此豁免）
  if (/\d{4}年\d{1,2}月\d{1,2}日/.test(text)) {
    if (para.format.alignment === 'right') return 'date';
  } else if (para.format.alignment === 'right' && text.length < 20) {
    return 'signature';
  }

  return 'body';
}

// 段落是否含红色 run（发文机关标志特征）
function hasRedRun(para) {
  return (para.runs || []).some(function(r) {
    var c = (r.format && r.format.color || '').toUpperCase();
    return c === 'FF0000' || c === 'C00000' || c === 'FF000';
  });
}

// 角色 → 档案参数映射（fontRule/sizeRule 为对应规则号后缀，与历史基线一致）
var ROLE_PARAMS = {
  doc_title: { font: 'title_font', size: 'title_size_pt', align: 'title_align', fontRule: '010', sizeRule: '020' },
  heading_1: { font: 'heading1_font', size: 'heading1_size_pt', fontRule: '011', sizeRule: '021' },
  heading_2: { font: 'heading2_font', size: 'heading2_size_pt', fontRule: '012', sizeRule: '022' },
  chapter: { font: 'chapter_font', size: 'chapter_size_pt', align: 'chapter_align', fontRule: '011', sizeRule: '021' },
  body: { font: 'body_font', size: 'body_size_pt', align: 'body_align', fontRule: '013', sizeRule: '023' },
};

// 主检查函数
// @param {object} options { docType?: string } — 按文种路由格式档案
//   空 docType → default_profile（gov，兼容历史基线）
function checkFormat(doc, options) {
  options = options || {};
  var profile = loadProfile(options.docType, options);
  var params = profile.params;
  var marks = [];
  var markId = 0;
  var paragraphs = doc.paragraphs || [];
  var pageSettings = doc.pageSettings || {};

  // 计算第一个非空段落的索引（用于识别大标题）
  var firstNonEmptyIdx = -1;
  for (var fi = 0; fi < paragraphs.length; fi++) {
    if (paragraphs[fi].text.trim()) { firstNonEmptyIdx = fi; break; }
  }

  function addMark(paraIdx, type, original, suggested, ruleId, severity, reason, category) {
    marks.push({
      id: 'fmt-' + (++markId),
      type: type,
      paragraph: paraIdx,
      start: 0,
      end: original ? original.length : 0,
      original: original || '',
      suggested: suggested || '',
      rule_id: ruleId,
      severity: severity,
      reason: reason,
      category: category || '格式规范',
      source: 'format-checker',
      citation: getCitation(ruleId, category || '格式规范', options),
    });
  }

  // ── 1. 页边距检查（参数来自档案；flag 关闭则跳过） ──
  if (params.check_margins !== false) {
    var marginCheck = function(key, ruleId) {
      if (typeof params[key] !== 'number') return;
      if (!pageSettings[key.replace('page_margin_', 'margin_')]) return;
      var actual = pageSettings[key.replace('page_margin_', 'margin_')];
      var tol = typeof params.margin_tolerance_mm === 'number' ? params.margin_tolerance_mm : 2;
      if (Math.abs(actual - params[key]) > tol) {
        addMark(-1, 'comment', '', '', ruleId, 'P1',
          '页边距（' + key.replace('page_margin_', '').replace('_mm', '').replace('top', '上').replace('bottom', '下').replace('left', '左').replace('right', '右') + '）应为 ' + params[key] + 'mm，实际 ' + actual + 'mm', '格式规范');
      }
    };
    marginCheck('page_margin_top_mm', 'CHK-FMT-001');
    marginCheck('page_margin_bottom_mm', 'CHK-FMT-002');
    marginCheck('page_margin_left_mm', 'CHK-FMT-003');
    marginCheck('page_margin_right_mm', 'CHK-FMT-004');
  }

  // ── 2. 段落格式检查 ──
  var sizeTolerance = typeof params.body_size_tolerance_pt === 'number' ? params.body_size_tolerance_pt : 1;
  paragraphs.forEach(function(para, idx) {
    var role = identifyParagraphRole(para, idx, paragraphs, firstNonEmptyIdx);
    if (role === 'empty') return;

    var rp = ROLE_PARAMS[role];
    if (!rp) return; // 豁免角色（org_flag/version/doc_num/signer/attachment/date/signature/table 等）

    // ── 2.1 字体检查（参数为空 = 该档案不检查此角色字体，如 gov 无章标题规范） ──
    if (params.check_fonts !== false && params[rp.font]) {
      var expectedFont = params[rp.font];
      var wrongFonts = [];
      para.runs.forEach(function(run) {
        var runFont = run.format.font_eastAsia || run.format.font_ascii;
        if (runFont && runFont.indexOf(expectedFont) < 0 && expectedFont.indexOf(runFont) < 0) {
          // 字体不匹配
          if (wrongFonts.indexOf(runFont) < 0) wrongFonts.push(runFont);
        }
      });
      if (wrongFonts.length > 0) {
        addMark(idx, 'comment', para.text.slice(0, 30),
          '应使用 ' + expectedFont,
          'CHK-FMT-' + rp.fontRule,
          'P1',
          role + ' 段落字体应为「' + expectedFont + '」，检测到「' + wrongFonts.join('、') + '」',
          '格式规范');
      }
    }

    // ── 2.2 字号检查（容差来自档案 body_size_tolerance_pt，gov=1pt） ──
    if (params.check_sizes !== false && params[rp.size]) {
      var expectedSize = params[rp.size];
      var wrongSizes = [];
      para.runs.forEach(function(run) {
        if (run.format.font_size_pt) {
          var diff = Math.abs(run.format.font_size_pt - expectedSize);
          if (diff > sizeTolerance) {
            wrongSizes.push(run.format.font_size_pt + 'pt');
          }
        }
      });
      if (wrongSizes.length > 0) {
        addMark(idx, 'comment', para.text.slice(0, 30),
          '应使用 ' + expectedSize + 'pt',
          'CHK-FMT-' + rp.sizeRule,
          'P1',
          role + ' 段落字号应为 ' + expectedSize + 'pt（' + ptToName(expectedSize) + '），检测到 ' + wrongSizes.join('、'),
          '格式规范');
      }
    }

    // ── 2.3 对齐检查 ──
    if (params.check_alignment !== false && params[rp.align] && para.format.alignment) {
      if (para.format.alignment !== params[rp.align]) {
        var alignMap = { left: '左对齐', center: '居中', right: '右对齐', both: '两端对齐' };
        addMark(idx, 'comment', para.text.slice(0, 30),
          '应' + (alignMap[params[rp.align]] || params[rp.align]),
          'CHK-FMT-030',
          'P2',
          role + ' 段落对齐应为「' + (alignMap[params[rp.align]] || params[rp.align]) + '」，实际「' + (alignMap[para.format.alignment] || para.format.alignment) + '」',
          '格式规范');
      }
    }

    // ── 2.4 行距检查（正文，区间参数化） ──
    if (params.check_line_spacing !== false && role === 'body' && para.format.line_spacing_pt) {
      var minSp = params.body_line_spacing_min_pt;
      var maxSp = params.body_line_spacing_max_pt;
      if (typeof minSp === 'number' && typeof maxSp === 'number' &&
          (para.format.line_spacing_pt < minSp || para.format.line_spacing_pt > maxSp)) {
        addMark(idx, 'comment', para.text.slice(0, 30),
          '行距应 ' + minSp + '-' + maxSp + 'pt',
          'CHK-FMT-040',
          'P2',
          '正文行距应为 ' + minSp + '-' + maxSp + 'pt，实际 ' + para.format.line_spacing_pt.toFixed(1) + 'pt',
          '格式规范');
      }
    }

    // ── 2.5 首行缩进检查（正文，容差参数化） ──
    if (params.check_first_line_indent !== false && role === 'body' && para.format.first_line_indent_pt !== undefined) {
      var indentSpec = params.body_first_line_indent_pt;
      var indentTol = typeof params.body_first_line_indent_tolerance_pt === 'number' ? params.body_first_line_indent_tolerance_pt : 8;
      if (typeof indentSpec === 'number' && Math.abs(para.format.first_line_indent_pt - indentSpec) > indentTol) {
        addMark(idx, 'comment', para.text.slice(0, 30),
          '首行缩进应 2 字符',
          'CHK-FMT-050',
          'P2',
          '正文首行缩进应为 2 字符（约 ' + indentSpec + 'pt），实际 ' + para.format.first_line_indent_pt.toFixed(1) + 'pt',
          '格式规范');
      }
    }
  });

  // 统计
  var stats = {
    total: marks.length,
    margin_issues: marks.filter(function(m) { return m.rule_id.indexOf('CHK-FMT-00') >= 0; }).length,
    font_issues: marks.filter(function(m) { return m.rule_id.indexOf('CHK-FMT-01') >= 0; }).length,
    size_issues: marks.filter(function(m) { return m.rule_id.indexOf('CHK-FMT-02') >= 0; }).length,
    alignment_issues: marks.filter(function(m) { return m.rule_id.indexOf('CHK-FMT-030') >= 0; }).length,
    line_spacing_issues: marks.filter(function(m) { return m.rule_id.indexOf('CHK-FMT-040') >= 0; }).length,
    indent_issues: marks.filter(function(m) { return m.rule_id.indexOf('CHK-FMT-050') >= 0; }).length,
    p0: marks.filter(function(m) { return m.severity === 'P0'; }).length,
    p1: marks.filter(function(m) { return m.severity === 'P1'; }).length,
    p2: marks.filter(function(m) { return m.severity === 'P2'; }).length,
  };

  return { marks: marks, stats: stats, profile: profile.name };
}

// 字号 pt → 中文字号名
function ptToName(pt) {
  var map = {
    42: '初号', 36: '小初', 26: '一号', 24: '小一',
    22: '二号', 18: '小二', 16: '三号', 15: '小三',
    14: '四号', 12: '小四', 10.5: '五号', 9: '小五',
    7.5: '六号', 6.5: '小六', 5.5: '七号', 5: '八号',
  };
  return map[pt] || (pt + 'pt');
}

// 生成格式报告摘要
function generateFormatSummary(doc, formatResult) {
  var lines = [];
  var ps = doc.pageSettings || {};

  lines.push('=== 文档格式信息 ===');
  if (ps.margin_top_mm) {
    lines.push('页边距：上 ' + ps.margin_top_mm + 'mm / 下 ' + ps.margin_bottom_mm + 'mm / 左 ' + ps.margin_left_mm + 'mm / 右 ' + ps.margin_right_mm + 'mm');
  }
  if (ps.page_width_mm) {
    lines.push('纸张：' + ps.page_width_mm + '×' + ps.page_height_mm + 'mm');
  }
  lines.push('段落总数：' + (doc.metadata ? doc.metadata.paragraphCount : '?'));

  // 检测到的字体清单
  var fonts = {};
  (doc.paragraphs || []).forEach(function(p) {
    p.runs.forEach(function(r) {
      var f = r.format.font_eastAsia || r.format.font_ascii;
      if (f) fonts[f] = (fonts[f] || 0) + 1;
    });
  });
  var fontList = Object.keys(fonts).sort(function(a, b) { return fonts[b] - fonts[a]; });
  if (fontList.length > 0) {
    lines.push('使用字体：' + fontList.map(function(f) { return f + '(' + fonts[f] + ')'; }).join('、'));
  }

  // 检测到的字号清单
  var sizes = {};
  (doc.paragraphs || []).forEach(function(p) {
    p.runs.forEach(function(r) {
      if (r.format.font_size_pt) {
        var s = r.format.font_size_pt;
        sizes[s] = (sizes[s] || 0) + 1;
      }
    });
  });
  var sizeList = Object.keys(sizes).sort(function(a, b) { return sizes[b] - sizes[a]; });
  if (sizeList.length > 0) {
    lines.push('使用字号：' + sizeList.map(function(s) { return s + 'pt(' + ptToName(parseFloat(s)) + ')'; }).join('、'));
  }

  if (formatResult.stats.total > 0) {
    lines.push('');
    lines.push('格式问题：' + formatResult.stats.total + ' 处');
    lines.push('  - 页边距：' + formatResult.stats.margin_issues);
    lines.push('  - 字体：' + formatResult.stats.font_issues);
    lines.push('  - 字号：' + formatResult.stats.size_issues);
    lines.push('  - 对齐：' + formatResult.stats.alignment_issues);
    lines.push('  - 行距：' + formatResult.stats.line_spacing_issues);
    lines.push('  - 首行缩进：' + formatResult.stats.indent_issues);
  } else {
    lines.push('');
    lines.push('格式检查通过，符合 GB/T 9704-2012 规范');
  }

  return lines.join('\n');
}

module.exports = {
  checkFormat: checkFormat,
  generateFormatSummary: generateFormatSummary,
  FORMAT_SPEC: FORMAT_SPEC,
  ptToName: ptToName,
};
