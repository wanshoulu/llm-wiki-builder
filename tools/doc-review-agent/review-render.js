/**
 * 审阅渲染器 — 把原文 + ReviewMark 数组渲染成带修订标记的 HTML
 *
 * 渲染样式（仿 Word 修订模式）：
 *   replace: <del class="rw-del">原文</del><ins class="rw-ins">建议</ins>
 *   delete:  <del class="rw-del">原文</del>
 *   insert:  <ins class="rw-ins">建议</ins>
 *   comment: <mark class="rw-comment" data-mid="...">原文</mark>
 *
 * 批注框在右侧侧边栏渲染。
 */

var CATEGORY_COLOR = {
  '语言规范': '#f59e0b',
  '格式规范': '#1677ff',
  '文种规范': '#8b5cf6',
  '行文规范': '#ef4444',
};

var SEVERITY_LABEL = {
  'P0': '必须修改',
  'P1': '建议修改',
  'P2': '提示',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/**
 * 渲染带修订标记的文稿 HTML
 */
function renderReviewedDocument(paragraphs, marks) {
  // 按段落分组 marks
  var marksByPara = {};
  marks.forEach(function(m) {
    if (!marksByPara[m.paragraph]) marksByPara[m.paragraph] = [];
    marksByPara[m.paragraph].push(m);
  });

  var commentList = []; // 侧边批注列表
  var commentIdx = 0;

  var html = '';
  paragraphs.forEach(function(para, paraIdx) {
    if (!para.trim()) {
      html += '<div class="rw-para rw-empty"></div>';
      return;
    }

    var paraMarks = marksByPara[paraIdx] || [];
    // 按 start 降序排列（从后往前插入）
    paraMarks.sort(function(a, b) { return b.start - a.start; });

    var paraHtml = escapeHtml(para);

    // 从后往前插入 marks
    var lastSurgicalStart = -1;
    paraMarks.forEach(function(m) {
      // LLM mark 未定位到原文：不渲染进文档（位置无效，侧边栏仍可查看）
      if (m.located === false) return;
      // 手术类 mark 与已渲染区间重叠时跳过（防 HTML 截断损坏）
      if (m.type !== 'comment') {
        if (lastSurgicalStart >= 0 && m.end > lastSurgicalStart) return;
        lastSurgicalStart = m.start;
      }
      var before = paraHtml.slice(0, m.start);
      var target = paraHtml.slice(m.start, m.end);
      var after = paraHtml.slice(m.end);
      var color = CATEGORY_COLOR[m.category] || '#6b7280';
      var sevLabel = SEVERITY_LABEL[m.severity] || m.severity;

      var markHtml = '';
      if (m.type === 'replace') {
        markHtml = '<del class="rw-del" style="--mc:' + color + '" title="' + escapeHtml(m.reason) + '">' + target + '</del>' +
                   '<ins class="rw-ins" style="--mc:' + color + '" title="' + escapeHtml(m.reason) + '">' + escapeHtml(m.suggested) + '</ins>';
      } else if (m.type === 'delete') {
        markHtml = '<del class="rw-del" style="--mc:' + color + '" title="' + escapeHtml(m.reason) + '">' + target + '</del>';
      } else if (m.type === 'insert') {
        markHtml = '<ins class="rw-ins" style="--mc:' + color + '" title="' + escapeHtml(m.reason) + '">' + escapeHtml(m.suggested) + '</ins>';
      } else if (m.type === 'comment') {
        commentIdx++;
        var cid = 'c' + commentIdx;
        if (lastSurgicalStart >= 0 && m.end > lastSurgicalStart) {
          // 批注区间与已渲染修订重叠：此时 target 已切进注入的 HTML（如 <del 的 <），
          // 文档内不渲染标记（该位置已有修订标记），仅进侧边栏批注列表
          commentList.push({
            cid: null,
            mid: m.id,
            num: commentIdx,
            severity: m.severity,
            sevLabel: sevLabel,
            category: m.category,
            color: color,
            reason: m.reason,
            original: m.original,
            paragraph: m.paragraph,
          });
          return;
        }
        markHtml = '<mark class="rw-comment" style="--mc:' + color + '" data-mid="' + m.id + '" data-cid="' + cid + '" title="' + escapeHtml(m.reason) + '">' + target + '</mark>' +
                   '<sup class="rw-cite" style="color:' + color + '">[' + commentIdx + ']</sup>';
        commentList.push({
          cid: cid,
          mid: m.id,
          num: commentIdx,
          severity: m.severity,
          sevLabel: sevLabel,
          category: m.category,
          color: color,
          reason: m.reason,
          original: m.original,
          paragraph: m.paragraph,
        });
      }
      paraHtml = before + markHtml + after;
    });

    html += '<div class="rw-para" data-para="' + paraIdx + '">' + paraHtml + '</div>';
  });

  return {
    documentHtml: html,
    comments: commentList,
  };
}

/**
 * 渲染修改建议清单（用于右侧面板）
 */
function renderSuggestionsPanel(marks) {
  var groups = {};
  marks.forEach(function(m) {
    var key = m.category || '其他';
    if (!groups[key]) groups[key] = [];
    groups[key].push(m);
  });

  var html = '';
  Object.keys(groups).forEach(function(cat) {
    var color = CATEGORY_COLOR[cat] || '#6b7280';
    var items = groups[cat];
    html += '<div class="rw-group">';
    html += '<div class="rw-group-header" style="border-left-color:' + color + '">';
    html += '<span class="rw-group-title">' + escapeHtml(cat) + '</span>';
    html += '<span class="rw-group-count">' + items.length + '</span>';
    html += '</div>';
    items.forEach(function(m) {
      var typeLabel = { replace: '替换', delete: '删除', insert: '插入', comment: '批注' }[m.type] || m.type;
      var sevColor = m.severity === 'P0' ? '#ef4444' : (m.severity === 'P1' ? '#f59e0b' : '#1677ff');
      html += '<div class="rw-suggestion" data-mid="' + m.id + '" data-para="' + m.paragraph + '" data-start="' + m.start + '">';
      html += '<div class="rw-sug-header">';
      html += '<span class="rw-sug-sev" style="background:' + sevColor + '">' + m.severity + '</span>';
      html += '<span class="rw-sug-type">' + typeLabel + '</span>';
      html += '<span class="rw-sug-rule">' + escapeHtml(m.rule_id) + '</span>';
      html += '</div>';
      html += '<div class="rw-sug-body">';
      if (m.original) {
        html += '<span class="rw-sug-orig">' + escapeHtml(m.original) + '</span>';
      }
      if (m.type === 'replace') {
        html += '<span class="rw-sug-arrow">→</span>';
        html += '<span class="rw-sug-new">' + escapeHtml(m.suggested) + '</span>';
      } else if (m.type === 'insert') {
        html += '<span class="rw-sug-arrow">+</span>';
        html += '<span class="rw-sug-new">' + escapeHtml(m.suggested) + '</span>';
      } else if (m.type === 'delete') {
        html += '<span class="rw-sug-arrow">−</span>';
      }
      html += '</div>';
      html += '<div class="rw-sug-reason">' + escapeHtml(m.reason) + '</div>';
      if (m.citation && m.citation.source) {
        html += '<div class="rw-sug-cite">📖 ' + escapeHtml(m.citation.source) +
          (m.citation.clause && m.citation.clause !== '—' ? ' ' + escapeHtml(m.citation.clause) : '') + '</div>';
      }
      html += '<div class="rw-sug-actions">';
      html += '<button class="rw-accept" onclick="acceptMark(\'' + m.id + '\')">接受</button>';
      html += '<button class="rw-reject" onclick="rejectMark(\'' + m.id + '\')">拒绝</button>';
      html += '</div>';
      html += '</div>';
    });
    html += '</div>';
  });

  return html;
}

/**
 * 应用接受的 marks，生成最终文稿
 */
function applyAcceptedMarks(paragraphs, marks, acceptedIds) {
  var acceptedSet = {};
  acceptedIds.forEach(function(id) { acceptedSet[id] = true; });

  // 按 paragraph 分组
  var marksByPara = {};
  marks.forEach(function(m) {
    if (acceptedSet[m.id]) {
      if (!marksByPara[m.paragraph]) marksByPara[m.paragraph] = [];
      marksByPara[m.paragraph].push(m);
    }
  });

  var result = paragraphs.map(function(para, paraIdx) {
    var paraMarks = marksByPara[paraIdx] || [];
    // 按 start 降序
    paraMarks.sort(function(a, b) { return b.start - a.start; });

    var text = para;
    var lastSurgicalStart = -1;
    paraMarks.forEach(function(m) {
      // LLM mark 未定位到原文：不能应用（位置无效，会污染文本）
      if (m.located === false) return;
      // 批注不改文本
      if (m.type === 'comment') return;
      // 与已应用区间重叠时跳过
      if (lastSurgicalStart >= 0 && m.end > lastSurgicalStart) return;
      lastSurgicalStart = m.start;
      var before = text.slice(0, m.start);
      var after = text.slice(m.end);
      if (m.type === 'replace') {
        text = before + m.suggested + after;
      } else if (m.type === 'delete') {
        text = before + after;
      } else if (m.type === 'insert') {
        text = before + m.suggested + after;
      }
      // comment 类型不改文本
    });
    return text;
  });

  return result.join('\n');
}

module.exports = {
  renderReviewedDocument: renderReviewedDocument,
  renderSuggestionsPanel: renderSuggestionsPanel,
  applyAcceptedMarks: applyAcceptedMarks,
};
