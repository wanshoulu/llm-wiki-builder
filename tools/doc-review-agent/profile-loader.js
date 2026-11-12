/**
 * 格式档案加载器 — wiki/doc-rules/_common/format-profiles.md 的单一消费点
 *
 * 四类档案：gov（党政 GB/T 9704 严格版）/ enterprise（企业内文简化版）/
 * regulation（制度章条式）/ briefing_speech（简报讲话稿灵活版）。
 *
 * 解析约定（与 format-profiles.md 表结构约定一致）：
 *   - 参数表行 = 参数名、列 = 四个档案（表头名映射列位置）；
 *   - 空单元格继承 gov 同参数值（gov 也空则保持空）；
 *   - 数值归一化 parseFloat、布尔归一化 true/false、其余保留字符串；
 *   - 「档案映射」表 doc_type 列支持逗号分隔多文种，括号说明行忽略。
 *
 * 兜底语义：
 *   - 空 docType → default_profile（gov，兼容历史基线）；
 *   - 非空未映射 → fallback_profile（enterprise，用户决策）；
 *   - wiki 缺失/解析失败 → 内置 gov 参数表（引擎可用性不依赖 wiki）。
 *
 * 缓存：模块级缓存 + 文件 mtime 校验，Knowledge Studio 编辑后下一请求生效。
 */

const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');

// 内置 gov 档案兜底（与改造前 FORMAT_SPEC 逐字段等价）
var BUILTIN_GOV = {
  page_margin_top_mm: 37,
  page_margin_bottom_mm: 35,
  page_margin_left_mm: 28,
  page_margin_right_mm: 26,
  margin_tolerance_mm: 2,
  title_font: '方正小标宋简体',
  title_size_pt: 22,
  title_align: 'center',
  heading1_font: '黑体',
  heading1_size_pt: 16,
  heading2_font: '楷体_GB2312',
  heading2_size_pt: 16,
  chapter_font: '',
  chapter_size_pt: null,
  chapter_align: '',
  body_font: '仿宋_GB2312',
  body_size_pt: 16,
  body_align: 'both',
  body_line_spacing_min_pt: 26,
  body_line_spacing_max_pt: 32,
  body_first_line_indent_pt: 32,
  body_first_line_indent_tolerance_pt: 8,
  body_size_tolerance_pt: 1,
  check_margins: true,
  check_fonts: true,
  check_sizes: true,
  check_alignment: true,
  check_line_spacing: true,
  check_first_line_indent: true,
  requires_red_header: true,
  requires_version_block: true,
  body_bold_allowed: false,
  skip_punctuation: false,
};

var PROFILE_NAMES = ['gov', 'enterprise', 'regulation', 'briefing_speech'];

var BUILTIN_PROFILES = {
  gov: BUILTIN_GOV,
  enterprise: Object.assign({}, BUILTIN_GOV, {
    page_margin_top_mm: 30, page_margin_bottom_mm: 30,
    page_margin_left_mm: 27, page_margin_right_mm: 27,
    margin_tolerance_mm: 3,
    body_line_spacing_min_pt: 24,
    requires_red_header: false, requires_version_block: false,
  }),
  regulation: Object.assign({}, BUILTIN_GOV, {
    page_margin_top_mm: 25, page_margin_bottom_mm: 25,
    page_margin_left_mm: 32, page_margin_right_mm: 32,
    margin_tolerance_mm: 3,
    chapter_font: '黑体', chapter_size_pt: 16, chapter_align: 'center',
    body_line_spacing_min_pt: 24,
    requires_red_header: false, requires_version_block: false,
    body_bold_allowed: true,
  }),
  briefing_speech: Object.assign({}, BUILTIN_GOV, {
    page_margin_top_mm: 25, page_margin_bottom_mm: 25,
    page_margin_left_mm: 25, page_margin_right_mm: 25,
    margin_tolerance_mm: 4,
    title_font: '黑体', title_size_pt: 18,
    body_size_pt: 18, body_align: 'left',
    body_line_spacing_min_pt: 22, body_line_spacing_max_pt: 34,
    body_first_line_indent_tolerance_pt: 10,
    body_size_tolerance_pt: 2,
    check_margins: false, check_fonts: false, check_sizes: false,
    check_alignment: false, check_line_spacing: false, check_first_line_indent: false,
    requires_red_header: false, requires_version_block: false,
    body_bold_allowed: true,
  }),
};

var BUILTIN_DOC_TYPE_MAP = {
  notice: 'gov', request: 'gov', report: 'gov', letter: 'gov', reply: 'gov',
  meeting: 'gov', decision: 'gov', opinion: 'gov', bulletin: 'gov',
  announcement: 'gov', command: 'gov', communique: 'gov', bill: 'gov', instruction: 'gov',
  regulation: 'regulation', resolution: 'regulation',
  speech: 'briefing_speech', news: 'briefing_speech', summary: 'briefing_speech', briefing: 'briefing_speech',
  work_plan: 'enterprise', technical_proposal: 'enterprise', table_sign: 'enterprise',
};

var _caches = Object.create(null);

function _resolveWikiRoot(options) {
  var configured = typeof options === 'string' ? options : options && options.wikiRoot;
  return path.resolve(configured || CONFIG.wikiRoot);
}

// 归一化单元格值：数字 → number；true/false → boolean；空 → null
function _normalizeCell(cell) {
  var v = cell.trim();
  if (!v) return null;
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  return v;
}

// 解析表格行（| a | b | c |）
function _parseRow(line) {
  var m = line.match(/^\|([\s\S]*)\|$/);
  if (!m) return null;
  return m[1].split('|').map(function(c) { return c.trim(); });
}

// 是否为表格分隔行（|---|---|）
function _isSeparatorRow(cells) {
  return cells.length > 0 && cells.every(function(c) {
    return /^:?-{2,}:?$/.test(c) || c === '';
  });
}

/**
 * 解析 format-profiles.md 全文（纯函数，便于单测）
 * @param {string} mdText
 * @returns {{ profiles: object, defaultProfile: string, fallbackProfile: string, docTypeMap: object }}
 */
function _parseProfiles(mdText) {
  var profiles = {};
  PROFILE_NAMES.forEach(function(n) { profiles[n] = {}; });
  var defaultProfile = 'gov';
  var fallbackProfile = 'enterprise';
  var docTypeMap = {};

  // frontmatter
  var fmMatch = mdText.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    var dm = fmMatch[1].match(/^default_profile:\s*([^\n]+)/m);
    if (dm) defaultProfile = dm[1].trim();
    var fm = fmMatch[1].match(/^fallback_profile:\s*([^\n]+)/m);
    if (fm) fallbackProfile = fm[1].trim();
  }

  var inMapping = false; // 当前是否在「档案映射」表
  var lines = mdText.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var sec = line.match(/^##\s+(.+)$/);
    if (sec) {
      inMapping = /映射/.test(sec[1]);
      continue;
    }
    if (!/^\|/.test(line)) continue;
    var cells = _parseRow(line);
    if (!cells || _isSeparatorRow(cells)) continue;
    if (cells[0] === '' || cells[0] === '参数' || cells[0] === '档案' ||
        cells[0] === 'doc_type') continue; // 表头行

    if (inMapping) {
      // 档案映射表：doc_type（可逗号分隔）| profile | 备注
      var types = cells[0].split(/[,，]/).map(function(t) { return t.trim().toLowerCase(); }).filter(Boolean);
      var prof = (cells[1] || '').trim().toLowerCase();
      if (!prof || PROFILE_NAMES.indexOf(prof) < 0) continue;
      types.forEach(function(t) {
        if (!/^（/.test(t)) docTypeMap[t] = prof;
      });
      continue;
    }

    // 参数表：第一列为参数名，其余列按表头顺序对应档案
    var paramName = cells[0].trim();
    if (!paramName) continue;
    // 找最近分隔行，其上一行即表头（列 → 档案映射）
    var headerCells = null;
    for (var j = i - 1; j >= 0; j--) {
      if (!/^\|/.test(lines[j])) break;
      var hc = _parseRow(lines[j]);
      if (hc && _isSeparatorRow(hc)) {
        headerCells = _parseRow(lines[j - 1] || '');
        break;
      }
    }
    if (!headerCells) continue;
    var colMap = {};
    headerCells.forEach(function(h, hi) {
      var hn = h.trim().toLowerCase();
      if (PROFILE_NAMES.indexOf(hn) >= 0) colMap[hn] = hi;
    });
    PROFILE_NAMES.forEach(function(n) {
      var colIdx = colMap[n];
      if (colIdx === undefined) return;
      var val = _normalizeCell(cells[colIdx] || '');
      if (val === null) val = profiles.gov[paramName] !== undefined ? profiles.gov[paramName] : null;
      profiles[n][paramName] = val;
    });
  }

  return {
    profiles: profiles,
    defaultProfile: defaultProfile,
    fallbackProfile: fallbackProfile,
    docTypeMap: docTypeMap,
  };
}

/**
 * 加载全部档案数据（含 mtime 缓存）
 */
function loadProfiles(options) {
  var wikiRoot = _resolveWikiRoot(options);
  var cache = _caches[wikiRoot] || { mtimeMs: -1, data: null };
  try {
    var p = path.join(wikiRoot, '_common/format-profiles.md');
    var stat = fs.statSync(p);
    if (cache.mtimeMs === stat.mtimeMs && cache.data) return cache.data;
    var content = fs.readFileSync(p, 'utf8');
    var data = _parseProfiles(content);
    if (!data.profiles.gov || !Object.keys(data.profiles.gov).length) {
      throw new Error('parsed profiles empty');
    }
    cache.data = data;
    cache.mtimeMs = stat.mtimeMs;
  } catch (e) {
    cache.data = {
      profiles: BUILTIN_PROFILES,
      defaultProfile: 'gov',
      fallbackProfile: 'enterprise',
      docTypeMap: BUILTIN_DOC_TYPE_MAP,
    };
    cache.mtimeMs = -1;
  }
  _caches[wikiRoot] = cache;
  return cache.data;
}

/**
 * 按文种解析档案
 * @param {string} docType 文种（空 = 兼容基线走 default_profile）
 * @returns {{ name: string, params: object }}
 */
function loadProfile(docType, options) {
  var data = loadProfiles(options);
  var name;
  if (docType) {
    name = data.docTypeMap[String(docType).toLowerCase()] || data.fallbackProfile;
  } else {
    name = data.defaultProfile;
  }
  var params = (data.profiles[name] && Object.keys(data.profiles[name]).length)
    ? data.profiles[name]
    : (data.profiles.gov || BUILTIN_GOV);
  return { name: name, params: params };
}

module.exports = {
  loadProfiles: loadProfiles,
  loadProfile: loadProfile,
  _parseProfiles: _parseProfiles,
  BUILTIN_GOV: BUILTIN_GOV,
  PROFILE_NAMES: PROFILE_NAMES,
  BUILTIN_PROFILES: BUILTIN_PROFILES,
  BUILTIN_DOC_TYPE_MAP: BUILTIN_DOC_TYPE_MAP,
};
