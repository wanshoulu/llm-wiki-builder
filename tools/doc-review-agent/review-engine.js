/**
 * 公文审阅引擎 — 生成 ReviewMark 数组
 *
 * ReviewMark 是对文稿的具体修改建议，不同于 violation（只报告问题）。
 * 每条 mark 指明：在哪一段、哪个位置、做什么修改（替换/删除/插入/批注）。
 *
 * Mark 类型：
 *   replace  替换：原文 → 建议
 *   delete   删除：原文删除
 *   insert   插入：在位置插入建议内容
 *   comment  批注：高亮+侧边说明，不直接改
 */

const { getCitation } = require('./citations');
const { loadTabooEntries } = require('./lexicon-loader');

// ============================================================
// 半角→全角 标点映射
// ============================================================
var PUNCT_MAP = {
  '.': '。', ',': '，', ':': '：', ';': '；', '!': '！', '?': '？',
  '(': '（', ')': '）',
};

// ============================================================
// 主函数：生成 ReviewMark 数组
// ============================================================
function generateReviewMarks(text, options) {
  options = options || {};
  var docType = options.docType || '';
  var paragraphs = text.split('\n');
  var marks = [];
  var markId = 0;

  var coveredByPara = {}; // 段落级已覆盖区间：防止重叠 mark 互相截断、损坏渲染 HTML

  function addMark(paragraph, start, end, type, original, suggested, ruleId, severity, reason, category) {
    // 批注可叠加；手术类 mark（replace/delete/insert）区间重叠会让渲染时互相截断，跳过后者
    if (type !== 'comment') {
      var covered = coveredByPara[paragraph] || (coveredByPara[paragraph] = []);
      for (var c = 0; c < covered.length; c++) {
        if (start < covered[c][1] && end > covered[c][0]) return;
      }
      covered.push([start, end]);
    }
    marks.push({
      id: 'mark-' + (++markId),
      type: type,
      paragraph: paragraph,
      start: start,
      end: end,
      original: original,
      suggested: suggested,
      rule_id: ruleId,
      severity: severity,
      reason: reason,
      category: category || '格式规范',
      citation: getCitation(ruleId, category || '格式规范'),
    });
  }

  paragraphs.forEach(function(para, paraIdx) {
    if (!para.trim()) return;

    // ── 1. 忌用词 → replace / comment（词典条目按词长降序，长词优先占位） ──
    loadTabooEntries(options).forEach(function(entry) {
      var word = entry.word;
      var idx = para.indexOf(word);
      while (idx >= 0) {
        if (entry.action === 'comment') {
          addMark(paraIdx, idx, idx + word.length, 'comment', word, '',
            'LEXICON', 'P1', '忌用词"' + word + '"：' + entry.suggest, '语言规范');
        } else {
          addMark(paraIdx, idx, idx + word.length, 'replace', word, entry.suggest,
            'LEXICON', 'P1', '忌用词"' + word + '"建议替换为"' + entry.suggest + '"', '语言规范');
        }
        idx = para.indexOf(word, idx + word.length);
      }
    });

    // ── 2. 序号标点 → replace/delete（先于半角标点：序号规则更具体，优先占位） ──
    // 一级序号 "一." → "一、"
    var m1 = para.match(/^([一二三四五六七八九十]+)\./);
    if (m1) {
      addMark(paraIdx, m1[1].length, m1[1].length + 1, 'replace', '.', '、', 'CHK-PUNC-002', 'P1', '一级序号"一"后应使用顿号"、"而非句点"."', '语言规范');
    }
    // 三级序号 "1、" → "1."
    var m2 = para.match(/^(\d+)、/);
    if (m2) {
      addMark(paraIdx, m2[1].length, m2[1].length + 1, 'replace', '、', '.', 'CHK-PUNC-002', 'P1', '三级序号阿拉伯数字后应使用下脚点"."而非顿号"、"', '语言规范');
    }
    // 二级序号 "（一）、" → "（一）"
    var m3 = para.match(/^（[一二三四五六七八九十]+）([、.，,])/);
    if (m3) {
      var pos = para.indexOf(m3[1]);
      addMark(paraIdx, pos, pos + 1, 'delete', m3[1], '', 'CHK-PUNC-002', 'P2', '二级序号"（一）"后不应加标点', '语言规范');
    }
    // 四级序号 "（1）、" → "（1）"
    var m4 = para.match(/^（\d+）([、.，,])/);
    if (m4) {
      var pos2 = para.indexOf(m4[1]);
      addMark(paraIdx, pos2, pos2 + 1, 'delete', m4[1], '', 'CHK-PUNC-002', 'P2', '四级序号"（1）"后不应加标点', '语言规范');
    }

    // ── 3. 半角标点 → replace（中文后的半角标点；序号位置已被规则 2 占位） ──
    for (var i = 0; i < para.length; i++) {
      var ch = para[i];
      // 中文后接半角句点
      if (ch === '.' && i > 0 && /[\u4e00-\u9fa5]/.test(para[i - 1])) {
        // 排除小数（数字.数字）
        if (i < para.length - 1 && /\d/.test(para[i + 1])) continue;
        addMark(paraIdx, i, i + 1, 'replace', '.', '。', 'CHK-PUNC-001', 'P1', '半角句点应改为全角句号', '语言规范');
      }
      // 中文后接半角逗号
      if (ch === ',' && i > 0 && /[\u4e00-\u9fa5]/.test(para[i - 1])) {
        addMark(paraIdx, i, i + 1, 'replace', ',', '，', 'CHK-PUNC-001', 'P1', '半角逗号应改为全角逗号', '语言规范');
      }
      // 中文后或中文前接半角冒号
      if (ch === ':' && (i > 0 && /[\u4e00-\u9fa5]/.test(para[i - 1]) || i < para.length - 1 && /[\u4e00-\u9fa5]/.test(para[i + 1]))) {
        addMark(paraIdx, i, i + 1, 'replace', ':', '：', 'CHK-PUNC-001', 'P1', '半角冒号应改为全角冒号', '语言规范');
      }
    }

    // ── 4. 多余空格 → delete（版记印发行"XX银行办公室    2026年10月8日印发"的空格是版式对齐，豁免） ──
    var spaceMatch = para.match(/\s{2,}/);
    if (spaceMatch && !/印发$/.test(para.trim())) {
      var spaceIdx = para.indexOf(spaceMatch[0]);
      addMark(paraIdx, spaceIdx, spaceIdx + spaceMatch[0].length, 'delete', spaceMatch[0], '', 'CHK-HEUR-001', 'P1', '存在多余空格，建议删除', '格式规范');
    }

    // ── 5. 日期格式 → replace ──
    // 斜杠/短横线日期 → YYYY年MM月DD日
    var dateMatch = para.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (dateMatch) {
      var dateStart = para.indexOf(dateMatch[0]);
      var newDate = dateMatch[1] + '年' + parseInt(dateMatch[2]) + '月' + parseInt(dateMatch[3]) + '日';
      addMark(paraIdx, dateStart, dateStart + dateMatch[0].length, 'replace', dateMatch[0], newDate, 'CHK-PUNC-003', 'P1', '公文日期应使用"YYYY年MM月DD日"格式', '语言规范');
    }
    // 汉字数字日期 → 阿拉伯数字
    var cnDateMatch = para.match(/([〇一二三四五六七八九]+)年([〇一二三四五六七八九]+)月([〇一二三四五六七八九]+)日/);
    if (cnDateMatch) {
      var cnStart = para.indexOf(cnDateMatch[0]);
      var cn2num = function(s) { return s.split('').map(function(c) { return '〇一二三四五六七八九'.indexOf(c); }).join('').replace(/^0+/, ''); };
      var newDate2 = cn2num(cnDateMatch[1]) + '年' + cn2num(cnDateMatch[2]) + '月' + cn2num(cnDateMatch[3]) + '日';
      addMark(paraIdx, cnStart, cnStart + cnDateMatch[0].length, 'replace', cnDateMatch[0], newDate2, 'CHK-PUNC-003', 'P1', '公文日期应使用阿拉伯数字', '语言规范');
    }

    // ── 6. 发文字号格式 → replace ──
    // [2026] → 〔2026〕
    var bracketMatch = para.match(/\[(\d{4})\]/);
    if (bracketMatch) {
      var bStart = para.indexOf(bracketMatch[0]);
      addMark(paraIdx, bStart, bStart + bracketMatch[0].length, 'replace', bracketMatch[0], '〔' + bracketMatch[1] + '〕', 'CHK-HEAD-001', 'P0', '发文字号年份应使用六角括号〔〕', '格式规范');
    }
    // （2026） → 〔2026〕
    var parenMatch = para.match(/（(\d{4})）/);
    if (parenMatch && para.indexOf('发') >= 0) {
      var pStart = para.indexOf(parenMatch[0]);
      addMark(paraIdx, pStart, pStart + parenMatch[0].length, 'replace', parenMatch[0], '〔' + parenMatch[1] + '〕', 'CHK-HEAD-001', 'P0', '发文字号年份应使用六角括号〔〕', '格式规范');
    }
  });

  // ── 7. 缺少结语 → insert（在最后一个非空段落末尾） ──
  // 每种文种有多种规范结语变体，任一命中即视为合规
  if (docType) {
    var endingMap = {
      notice: ['特此通知'],
      request: ['妥否，请批示', '以上请示，请予批复', '请予批复', '请批示', '请批复'],
      report: ['特此报告'],
      letter: ['特此函达', '特此函复', '请予函复', '专此函达'],
      reply: ['此复', '特此批复'],
      bulletin: ['特此通告'],
      announcement: ['特此公告'],
    };
    var endings = endingMap[docType];
    var hasEnding = endings && endings.some(function(e) { return text.indexOf(e) >= 0; });
    var ending = endings ? endings[0] : '';
    if (endings && !hasEnding) {
      // 找最后一个非空段落
      var lastNonEmpty = -1;
      for (var i = paragraphs.length - 1; i >= 0; i--) {
        if (paragraphs[i].trim()) { lastNonEmpty = i; break; }
      }
      if (lastNonEmpty >= 0) {
        // 结语应位于落款（发文机关+日期）之前：若末段是日期且其上有落款机关行，插到机关行之前
        var anchor = lastNonEmpty;
        var lastText = paragraphs[lastNonEmpty].trim();
        if (/^\d{4}年\d{1,2}月\d{1,2}日/.test(lastText)) {
          var sigIdx = -1;
          for (var j = lastNonEmpty - 1; j >= 0; j--) {
            if (paragraphs[j].trim()) { sigIdx = j; break; }
          }
          if (sigIdx >= 0 && paragraphs[sigIdx].trim().length <= 20 && !/[。；：，、]$/.test(paragraphs[sigIdx].trim())) {
            anchor = -1;
            for (var k = sigIdx - 1; k >= 0; k--) {
              if (paragraphs[k].trim()) { anchor = k; break; }
            }
            if (anchor < 0) anchor = sigIdx;
          }
        }
        addMark(anchor, paragraphs[anchor].length, paragraphs[anchor].length, 'insert', '', '\n' + ending, 'CHK-END-' + docType.toUpperCase(),
          docType === 'request' ? 'P0' : 'P2', '缺少文种规范结语，建议在落款前插入"' + ending + '"', '文种规范');
      }
    }
  }

  // ── 8. 报告夹带请示 → comment ──
  if (docType === 'report') {
    paragraphs.forEach(function(para, paraIdx) {
      // 检测"请示事项"小节标题
      if (/^[一二三四五六七八九十]+[、.．]\s*请示/.test(para.trim())) {
        addMark(paraIdx, 0, para.length, 'comment', para, '', 'CHK-DIR-003', 'P0', '报告中夹带请示事项：请示事项应另行发文', '行文规范');
      }
      // 检测资金请示
      if (/(追加|拨付|核拨).*\d+(万元|元)/.test(para)) {
        var match = para.match(/(追加|拨付|核拨).*\d+(万元|元)[^。]*?/);
        if (match) {
          var s = para.indexOf(match[0]);
          addMark(paraIdx, s, s + match[0].length, 'comment', match[0], '', 'CHK-DIR-003', 'P0', '报告中夹带资金请示：应另发请示公文', '行文规范');
        }
      }
    });
  }

  // ── 9. 多头主送 → comment ──
  if (docType === 'request') {
    for (var i = 0; i < paragraphs.length; i++) {
      var p = paragraphs[i].trim();
      if (p && !p.startsWith('关于') && !p.startsWith('为') && p.endsWith('：')) {
        var recipients = p.replace(/[：:]$/, '').split(/[、,，]/);
        if (recipients.length > 1) {
          addMark(i, 0, p.length, 'comment', p, '', 'CHK-DIR-002', 'P1', '请示应主送一个上级机关，检测到多个主送机关', '行文规范');
        }
        break;
      }
    }
  }

  // ── 10. 标题字数 → comment ──
  var firstLine = paragraphs.find(function(l) { return l.trim(); }) || '';
  if (firstLine && firstLine.length > 20 && docType !== 'news') {
    var firstLineIdx = paragraphs.indexOf(firstLine);
    addMark(firstLineIdx, 0, firstLine.length, 'comment', firstLine, '', 'CHK-TITLE-001', 'P2', '公文标题超过20字（当前' + firstLine.length + '字）', '格式规范');
  }

  // 按 paragraph + start 排序
  marks.sort(function(a, b) {
    if (a.paragraph !== b.paragraph) return a.paragraph - b.paragraph;
    return a.start - b.start;
  });

  return {
    marks: marks,
    paragraphs: paragraphs,
    stats: {
      total: marks.length,
      replace: marks.filter(function(m) { return m.type === 'replace'; }).length,
      delete: marks.filter(function(m) { return m.type === 'delete'; }).length,
      insert: marks.filter(function(m) { return m.type === 'insert'; }).length,
      comment: marks.filter(function(m) { return m.type === 'comment'; }).length,
      p0: marks.filter(function(m) { return m.severity === 'P0'; }).length,
      p1: marks.filter(function(m) { return m.severity === 'P1'; }).length,
      p2: marks.filter(function(m) { return m.severity === 'P2'; }).length,
    },
  };
}

module.exports = { generateReviewMarks: generateReviewMarks };
