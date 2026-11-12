/**
 * 公文审核 Agent 测试文档生成器
 *
 * 生成多种测试文档用于功能测试：
 *   - 标准公文（应通过审核）
 *   - 格式错误公文（字体/字号/页边距错误）
 *   - 文本错误公文（标点/忌用词）
 *   - 综合错误公文（格式+文本）
 *   - PDF 测试（用 txt 模拟）
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const TEST_DIR = path.join(__dirname, 'test-docs');
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR);

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── 版头（红头文件）：发文机关标志（红色小标宋）+ 发文字号 + 红色反线 + 签发人 ──
function buildRedHeader(rh) {
  var xml = '';
  // 发文机关标志：红色、小标宋、醒目大字、居中（上边缘至版心上边缘 35mm 以段距体现）
  xml += '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="' + (rh.org_before || 1100) + '"/></w:pPr>' +
    '<w:r><w:rPr><w:rFonts w:ascii="' + (rh.org_font || '方正小标宋简体') + '" w:eastAsia="' + (rh.org_font || '方正小标宋简体') + '"/>' +
    '<w:sz w:val="' + (rh.org_size || 60) + '"/><w:color w:val="' + (rh.org_color || 'FF0000') + '"/></w:rPr>' +
    '<w:t>' + xmlEscape(rh.org || 'XX银行股份有限公司文件') + '</w:t></w:r></w:p>';
  // 标志下空二行
  xml += '<w:p/>';
  if (rh.doc_num) {
    xml += '<w:p><w:pPr><w:jc w:val="' + (rh.doc_num_align || 'center') + '"/><w:ind w:left="' + (rh.doc_num_align === 'left' ? '320' : '0') + '"/></w:pPr>' +
      '<w:r><w:rPr><w:rFonts w:ascii="仿宋_GB2312" w:eastAsia="仿宋_GB2312"/><w:sz w:val="32"/></w:rPr>' +
      '<w:t>' + xmlEscape(rh.doc_num) + '</w:t></w:r></w:p>';
    // 发文字号之下 4mm 处红色反线（与版心等宽）
    xml += '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="18" w:space="1" w:color="FF0000"/></w:pBdr>' +
      '<w:spacing w:before="113" w:after="113"/></w:pPr></w:p>';
  }
  // 签发人（上行文）："签发人"3号仿宋 + 姓名3号楷体，居右空一字
  if (rh.signer) {
    xml += '<w:p><w:pPr><w:jc w:val="right"/><w:ind w:right="320"/></w:pPr>' +
      '<w:r><w:rPr><w:rFonts w:ascii="仿宋_GB2312" w:eastAsia="仿宋_GB2312"/><w:sz w:val="32"/></w:rPr><w:t>签发人：</w:t></w:r>' +
      '<w:r><w:rPr><w:rFonts w:ascii="楷体_GB2312" w:eastAsia="楷体_GB2312"/><w:sz w:val="32"/></w:rPr><w:t>' + xmlEscape(rh.signer) + '</w:t></w:r></w:p>';
  }
  return xml;
}

// ── 表格（公文中附件/数据表格：表内五号宋体，表头加粗居中） ──
function buildTable(t) {
  var font = t.font || '宋体';
  var size = t.size || 21; // 五号 10.5pt
  var xml = '<w:tbl><w:tblPr><w:tblW w:w="' + (t.width || 9000) + '" w:type="dxa"/><w:jc w:val="center"/>';
  if (t.borders !== false) {
    xml += '<w:tblBorders>' +
      '<w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/>' +
      '<w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/>' +
      '<w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/>' +
      '</w:tblBorders>';
  }
  xml += '</w:tblPr>';
  function cell(text, bold) {
    var rPr = '<w:rPr><w:rFonts w:ascii="' + font + '" w:eastAsia="' + font + '"/>' +
      '<w:sz w:val="' + size + '"/>' + (bold ? '<w:b/>' : '') + '</w:rPr>';
    return '<w:tc><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r>' + rPr + '<w:t>' + xmlEscape(text) + '</w:t></w:r></w:p></w:tc>';
  }
  if (t.header) {
    xml += '<w:tr>' + t.header.map(function(h) { return cell(h, true); }).join('') + '</w:tr>';
  }
  (t.rows || []).forEach(function(row) {
    xml += '<w:tr>' + row.map(function(c) { return cell(c, false); }).join('') + '</w:tr>';
  });
  xml += '</w:tbl>';
  return xml;
}

// ── 版记：分隔线 + 抄送机关 + 印发机关和印发日期（4号仿宋） ──
function buildVersionBlock(vb) {
  var xml = '<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="8" w:space="1" w:color="000000"/>' +
    '<w:bottom w:val="single" w:sz="8" w:space="1" w:color="000000"/></w:pBdr></w:pPr></w:p>';
  if (vb.cc) {
    xml += '<w:p><w:pPr><w:ind w:left="320"/></w:pPr>' +
      '<w:r><w:rPr><w:rFonts w:ascii="仿宋_GB2312" w:eastAsia="仿宋_GB2312"/><w:sz w:val="28"/></w:rPr>' +
      '<w:t>抄送：' + xmlEscape(vb.cc) + '。</w:t></w:r></w:p>';
  }
  if (vb.print) {
    xml += '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' +
      '<w:r><w:rPr><w:rFonts w:ascii="仿宋_GB2312" w:eastAsia="仿宋_GB2312"/><w:sz w:val="28"/></w:rPr>' +
      '<w:t>' + xmlEscape(vb.print) + '</w:t></w:r></w:p>';
  }
  return xml;
}

// ── 创建 docx 文件 ──
function createDocx(outputPath, options) {
  var zip = new AdmZip();

  // [Content_Types].xml
  zip.addFile('[Content_Types].xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>'
  ));

  // _rels/.rels
  zip.addFile('_rels/.rels', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>'
  ));

  // 页边距参数（可配置错误）
  var margin = options.margin || { top: 2098, right: 1474, bottom: 1978, left: 1588 };
  var pgSz = ' w:w="11906" w:h="16838"';

  // 构建 document.xml
  var bodyContent = '';

  // 页边距段（sectPr）
  bodyContent += '<w:p><w:pPr><w:sectPr>' +
    '<w:pgMar w:top="' + margin.top + '" w:right="' + margin.right + '" w:bottom="' + margin.bottom + '" w:left="' + margin.left + '"/>' +
    '<w:pgSz' + pgSz + '/>' +
    '</w:sectPr></w:pPr></w:p>';

  // 版头（红头文件，可选）
  if (options.red_header) {
    bodyContent += buildRedHeader(options.red_header);
  }

  // 大标题
  var titleFont = options.title_font || '方正小标宋简体';
  var titleSize = options.title_size || 44; // 22pt
  var titleAlign = options.title_align || 'center';
  bodyContent += '<w:p><w:pPr><w:jc w:val="' + titleAlign + '"/></w:pPr>' +
    '<w:r><w:rPr><w:rFonts w:ascii="' + titleFont + '" w:eastAsia="' + titleFont + '"/><w:sz w:val="' + titleSize + '"/></w:rPr>' +
    '<w:t>' + (options.title || '关于召开工作会议的通知') + '</w:t></w:r></w:p>';

  // 正文段落（支持表格条目 { table: {...} }）
  var bodyParas = options.body_paras || [];
  bodyParas.forEach(function(p) {
    if (p.table) {
      bodyContent += buildTable(p.table);
      return;
    }
    var pPr = '<w:pPr>';
    if (p.line_spacing) pPr += '<w:spacing w:line="' + p.line_spacing + '" w:lineRule="exact"/>';
    if (p.indent) pPr += '<w:ind w:firstLine="' + p.indent + '"/>';
    if (p.align) pPr += '<w:jc w:val="' + p.align + '"/>';
    pPr += '</w:pPr>';

    var rPr = '<w:rPr>';
    if (p.font) rPr += '<w:rFonts w:ascii="' + p.font + '" w:eastAsia="' + p.font + '"/>';
    if (p.size) rPr += '<w:sz w:val="' + p.size + '"/>';
    rPr += '</w:rPr>';

    bodyContent += '<w:p>' + pPr + '<w:r>' + rPr + '<w:t>' + xmlEscape(p.text) + '</w:t></w:r></w:p>';
  });

  // 版记（抄送/印发机关和印发日期，可选）
  if (options.version_block) {
    bodyContent += buildVersionBlock(options.version_block);
  }

  var docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + bodyContent + '</w:body></w:document>';

  zip.addFile('word/document.xml', Buffer.from(docXml, 'utf8'));

  // styles.xml（简化）
  var stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="paragraph" w:styleId="Heading1">' +
    '<w:name w:val="heading 1"/>' +
    '<w:rPr><w:rFonts w:ascii="黑体" w:eastAsia="黑体"/><w:sz w:val="32"/></w:rPr>' +
    '</w:style></w:styles>';
  zip.addFile('word/styles.xml', Buffer.from(stylesXml, 'utf8'));

  zip.writeZip(outputPath);
  console.log('  ✓ Created:', path.basename(outputPath));
}

// ── 测试文档 1: 标准公文（应通过） ──
function createStandardNotice() {
  createDocx(path.join(TEST_DIR, '01-standard-notice.docx'), {
    title: '关于召开2026年第三季度经营分析会议的通知',
    title_font: '方正小标宋简体',
    title_size: 44, // 22pt 二号
    margin: { top: 2098, right: 1474, bottom: 1978, left: 1588 }, // 上37mm/下35mm/左28mm/右26mm
    body_paras: [
      { text: '各部门：', font: '仿宋_GB2312', size: 32, align: 'both' },
      { text: '为全面总结第三季度经营工作，研究部署第四季度重点任务，现就召开经营分析会议有关事项通知如下。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '一、会议时间', font: '黑体', size: 32, align: 'both' },
      { text: '2026年10月15日上午9时', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '二、会议地点', font: '黑体', size: 32, align: 'both' },
      { text: '总行三楼会议室', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '特此通知', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: 'XX银行办公室', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月8日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
  });
}

// ── 测试文档 2: 格式错误公文（字体/字号/页边距错误） ──
function createFormatErrorDoc() {
  createDocx(path.join(TEST_DIR, '02-format-error.docx'), {
    title: '关于召开会议的通知',
    title_font: '宋体',        // 错误：应为方正小标宋简体
    title_size: 32,           // 错误：应为 44（22pt）
    margin: { top: 1000, right: 1000, bottom: 1000, left: 1000 }, // 错误：页边距全错
    body_paras: [
      { text: '各部门：', font: '宋体', size: 21, align: 'left' }, // 错误：宋体、10.5pt、左对齐
      { text: '为召开会议，现通知如下。', font: '宋体', size: 21, line_spacing: 240, indent: 100, align: 'left' }, // 错误：行距、缩进
      { text: '一、会议时间', font: '宋体', size: 21 }, // 错误：一级标题应为黑体
      { text: '2026年10月15日', font: '宋体', size: 21, align: 'left' },
      { text: '办公室', font: '宋体', size: 21, align: 'left' },
    ],
  });
}

// ── 测试文档 3: 文本错误公文（标点+忌用词） ──
function createTextErrorDoc() {
  createDocx(path.join(TEST_DIR, '03-text-error.docx'), {
    title: '关于搞经济工作的会议通知',
    title_font: '方正小标宋简体',
    title_size: 44,
    margin: { top: 2098, right: 1474, bottom: 1978, left: 1588 },
    body_paras: [
      { text: '各位领导:', font: '仿宋_GB2312', size: 32, align: 'both' }, // 半角冒号
      { text: '为贯彻落实上头精神，我们觉得应该召开一个会议，大概讨论一下经济工作。这个会议搞的好的话，能够取得巨大成效。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' }, // 忌用词
      { text: '会议时间:大概10月份某天', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' }, // 半角冒号
      { text: '地点.待定', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' }, // 半角句点
      { text: '请各位务必参加', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      // 缺少"特此通知"结语
      { text: '办公室', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月8日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
  });
}

// ── 测试文档 4: 综合错误公文（格式+文本） ──
function createCombinedErrorDoc() {
  createDocx(path.join(TEST_DIR, '04-combined-error.docx'), {
    title: '关于搞经济工作的通知',
    title_font: '宋体',         // 格式错误
    title_size: 32,            // 格式错误
    margin: { top: 1500, right: 1200, bottom: 1500, left: 1200 }, // 格式错误
    body_paras: [
      { text: '各位领导:', font: '宋体', size: 21, align: 'left' }, // 格式+文本错误
      { text: '为贯彻落实上头精神,我们觉得应该召开一个会议,大概讨论一下经济工作.这个会议搞的好的话,能够取得巨大成效.', font: '宋体', size: 21, line_spacing: 240, indent: 100, align: 'left' }, // 全错
      { text: '1、会议时间', font: '宋体', size: 21 }, // 序号标点错误
      { text: '2、会议地点', font: '宋体', size: 21 },
      { text: '办公室', font: '宋体', size: 21, align: 'left' },
      { text: '2026/10/8', font: '宋体', size: 21, align: 'left' }, // 日期格式错误
    ],
  });
}

// ── 测试文档 5: 请示公文（标准） ──
function createStandardRequest() {
  createDocx(path.join(TEST_DIR, '05-standard-request.docx'), {
    title: '关于申请追加科技研发预算的请示',
    title_font: '方正小标宋简体',
    title_size: 44,
    margin: { top: 2098, right: 1474, bottom: 1978, left: 1588 },
    body_paras: [
      { text: '总行：', font: '仿宋_GB2312', size: 32, align: 'both' },
      { text: '根据我行2026年度科技研发项目进展情况，部分重点项目需追加预算。具体原因如下。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '一、项目背景', font: '黑体', size: 32, align: 'both' },
      { text: '核心系统升级改造项目于2026年3月启动，原预算2000万元。因技术架构调整，需追加预算500万元。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '妥否，请批示', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '科技部', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月8日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
  });
}

// ── 测试文档 6: 报告夹带请示（应检测出 P0） ──
function createReportWithRequest() {
  createDocx(path.join(TEST_DIR, '06-report-with-request.docx'), {
    title: '关于2026年第三季度工作情况的报告',
    title_font: '方正小标宋简体',
    title_size: 44,
    margin: { top: 2098, right: 1474, bottom: 1978, left: 1588 },
    body_paras: [
      { text: '总行：', font: '仿宋_GB2312', size: 32, align: 'both' },
      { text: '2026年第三季度，我部认真贯彻落实总行工作部署，扎实推进各项业务，现将有关情况报告如下。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '一、主要工作完成情况', font: '黑体', size: 32, align: 'both' },
      { text: '核心系统升级改造项目按计划推进，已完成总体架构设计。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '二、存在问题', font: '黑体', size: 32, align: 'both' },
      { text: '部分项目进度滞后。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '三、下步打算', font: '黑体', size: 32, align: 'both' },
      { text: '加快推进核心系统升级改造。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '四、请示事项', font: '黑体', size: 32, align: 'both' }, // P0：报告夹带请示
      { text: '因项目需要，请总行追加预算500万元，用于核心系统升级改造项目。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' }, // P0：资金请示
      { text: '特此报告', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '科技部', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月8日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
  });
}

// ── 测试文档 7: TXT 文件（纯文本） ──
function createTxtFiles() {
  // 标准通知
  fs.writeFileSync(path.join(TEST_DIR, '07-standard-notice.txt'),
    '关于召开2026年第三季度经营分析会议的通知\n\n各部门：\n为全面总结第三季度经营工作，研究部署第四季度重点任务，现就召开经营分析会议有关事项通知如下。\n一、会议时间\n2026年10月15日上午9时\n二、会议地点\n总行三楼会议室\n三、参会人员\n各部门主要负责人\n四、会议要求\n（一）请各部门提前准备汇报材料。\n（二）请参会人员准时出席。\n\n特此通知\n\nXX银行办公室\n2026年10月8日',
    'utf8');
  console.log('  ✓ Created: 07-standard-notice.txt');

  // 问题公文
  fs.writeFileSync(path.join(TEST_DIR, '08-faulty-notice.txt'),
    '关于搞经济工作的会议通知\n\n各位领导:\n为贯彻落实上头精神,我们觉得应该召开一个会议,大概讨论一下经济工作.这个会议搞的好的话,能够取得巨大成效.\n会议时间:大概10月份某天\n地点.待定\n1、各部门负责人\n2、分管副职\n\n办公室\n2026/10/8',
    'utf8');
  console.log('  ✓ Created: 08-faulty-notice.txt');
}

// ═══════════════════════════════════════════════
// 扩充测试语料（2026-08-22）：覆盖更多文种与错误类型
// ═══════════════════════════════════════════════

// 标准页边距（GB/T 9704：上37/右26/下35/左28mm → twips）
var STD_MARGIN = { top: 2098, right: 1474, bottom: 1978, left: 1588 };

// ── 09: 标准商洽函（平行文，含标准发文字号） ──
function createStandardLetter() {
  createDocx(path.join(TEST_DIR, '09-standard-letter.docx'), {
    title: '关于商请选派技术人员担任培训班授课讲师的函',
    title_font: '方正小标宋简体', title_size: 44, margin: STD_MARGIN,
    body_paras: [
      { text: 'XX银信函〔2026〕12号', font: '仿宋_GB2312', size: 32, align: 'center' },
      { text: '总行科技部：', font: '仿宋_GB2312', size: 32, align: 'both' },
      { text: '为提高我行系统运维人员技术水平，经研究，拟于2026年11月举办运维技术培训班。现商请贵部选派2名技术骨干担任授课讲师，相关差旅及授课费用由我行承担。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '特此函达，盼予函复。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: 'XX银行信息技术部', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月15日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
  });
}

// ── 10: 标准批复（引述来文标题与文号） ──
function createStandardReply() {
  createDocx(path.join(TEST_DIR, '10-standard-reply.docx'), {
    title: '关于同意科技部追加科技研发预算的批复',
    title_font: '方正小标宋简体', title_size: 44, margin: STD_MARGIN,
    body_paras: [
      { text: '科技部：', font: '仿宋_GB2312', size: 32, align: 'both' },
      { text: '你部《关于申请追加科技研发预算的请示》（科技部〔2026〕8号）收悉。经研究，现批复如下。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '一、同意追加科技研发预算500万元，用于核心系统升级改造项目。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '二、请加强资金管理，专款专用，确保项目按期完成。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '此复', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: 'XX银行', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月20日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
  });
}

// ── 11: 标准会议纪要 ──
function createStandardMeetingMinutes() {
  createDocx(path.join(TEST_DIR, '11-standard-meeting-minutes.docx'), {
    title: '2026年第三季度经营分析会议纪要',
    title_font: '方正小标宋简体', title_size: 44, margin: STD_MARGIN,
    body_paras: [
      { text: '2026年10月15日上午，我行召开2026年第三季度经营分析会议。会议由XX行长主持，总行各部门主要负责人参加。现将会议议定事项纪要如下。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '一、会议全面总结了第三季度经营工作情况', font: '黑体', size: 32, align: 'both' },
      { text: '三季度各项经营指标总体平稳，存贷款规模稳步增长。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '二、会议部署了第四季度重点任务', font: '黑体', size: 32, align: 'both' },
      { text: '会议要求各部门围绕年度经营目标，加快重点项目推进进度。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '三、会议议定事项', font: '黑体', size: 32, align: 'both' },
      { text: '各部门应于10月31日前完成年度目标差距分析，形成书面材料报行长办公会。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '会议记录：办公室', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月15日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
  });
}

// ── 12: 标准通告（无主送，公开性文种） ──
function createStandardAnnouncement() {
  createDocx(path.join(TEST_DIR, '12-standard-announcement.docx'), {
    title: '关于系统维护期间暂停对外服务的通告',
    title_font: '方正小标宋简体', title_size: 44, margin: STD_MARGIN,
    body_paras: [
      { text: '因核心系统升级改造需要，我行将于2026年11月1日0时至6时暂停网上银行、手机银行等渠道对外服务。由此给您带来的不便，敬请谅解。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '特此通告', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: 'XX银行', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月25日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
  });
}

// ── 13: 多头主送请示（P1：一文多事 + 多头主送） ──
function createMultiRecipientRequest() {
  createDocx(path.join(TEST_DIR, '13-faulty-request-multi.docx'), {
    title: '关于申请追加科技研发预算和购置办公设备的请示',
    title_font: '方正小标宋简体', title_size: 44, margin: STD_MARGIN,
    body_paras: [
      { text: '总行、财政部：', font: '仿宋_GB2312', size: 32, align: 'both' }, // 多头主送 P1
      { text: '根据我行2026年度科技研发项目进展情况，部分重点项目需追加预算。同时因办公设备老化，需购置新设备。现请示如下。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '一、申请追加科技研发预算500万元', font: '黑体', size: 32, align: 'both' },
      { text: '用于核心系统升级改造项目，具体为云计算基础设施采购和数据库授权。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '二、申请购置办公设备200万元', font: '黑体', size: 32, align: 'both' },
      { text: '用于更新部门办公电脑、打印机、复印机等设备。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '以上请示，请予批复', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '科技部', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月8日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
  });
}

// ── 14: 报告缺结语 + 汉字数字日期（应触发 insert + 日期规则） ──
function createReportMissingEnding() {
  createDocx(path.join(TEST_DIR, '14-faulty-report-ending.docx'), {
    title: '关于2026年第三季度工作情况的报告',
    title_font: '方正小标宋简体', title_size: 44, margin: STD_MARGIN,
    body_paras: [
      { text: '总行：', font: '仿宋_GB2312', size: 32, align: 'both' },
      { text: '2026年第三季度，我部认真贯彻落实总行工作部署，扎实推进各项业务。现将有关情况报告如下。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '一、主要工作完成情况', font: '黑体', size: 32, align: 'both' },
      { text: '核心系统升级改造项目按计划推进，已完成总体架构设计。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '二、存在问题', font: '黑体', size: 32, align: 'both' },
      { text: '部分项目进度滞后。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '三、下步打算', font: '黑体', size: 32, align: 'both' },
      { text: '加快推进核心系统升级改造。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      // 缺少"特此报告"结语
      { text: '科技部', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '二〇二六年十月八日', font: '仿宋_GB2312', size: 32, align: 'right' }, // 汉字日期 P1
    ],
  });
}

// ── 15: 序号体系混乱（一. / （一）、/ 1、 / （1）、） ──
function createNumberingErrors() {
  createDocx(path.join(TEST_DIR, '15-faulty-notice-numbering.docx'), {
    title: '关于开展2026年度信息安全检查工作的通知',
    title_font: '方正小标宋简体', title_size: 44, margin: STD_MARGIN,
    body_paras: [
      { text: '各部门：', font: '仿宋_GB2312', size: 32, align: 'both' },
      { text: '为加强信息安全管理，现就开展年度信息安全检查工作通知如下。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '一.检查范围', font: '黑体', size: 32, align: 'both' }, // 一级序号"一." P1
      { text: '（一）、各业务系统运行环境', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' }, // 二级序号"（一）、" P2
      { text: '（二）、各部门终端设备', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '二.检查时间', font: '黑体', size: 32, align: 'both' },
      { text: '1、2026年11月1日至11月30日', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' }, // 三级序号"1、" P1
      { text: '2、各部门于11月30日前报送检查报告', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '三.检查方式', font: '黑体', size: 32, align: 'both' },
      { text: '（1）、各部门自查', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' }, // 四级序号"（1）、" P2
      { text: '（2）、总行抽查', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '特此通知', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: 'XX银行办公室', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年11月1日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
  });
}

// ── 16: 格式全面混乱（字体/字号/行距/缩进/页边距/对齐全错） ──
function createFormatChaosDoc() {
  createDocx(path.join(TEST_DIR, '16-faulty-format-chaos.docx'), {
    title: '关于举办青年员工座谈会的通知',
    title_font: '宋体',        // 错误：应为方正小标宋简体
    title_size: 36,           // 错误：应为 44（22pt 二号）
    title_align: 'left',      // 错误：应为 center
    margin: { top: 1000, right: 1000, bottom: 1000, left: 1000 }, // 错误：全错
    body_paras: [
      { text: '各部门：', font: '宋体', size: 24, align: 'left' }, // 错误：宋体 12pt 左对齐
      { text: '为加强青年员工队伍建设，定于2026年11月15日召开青年员工座谈会。现将有关事项通知如下。', font: '宋体', size: 24, line_spacing: 240, indent: 100, align: 'left' }, // 错误：行距 12pt、缩进 5pt
      { text: '一、会议时间', font: '宋体', size: 24, align: 'left' }, // 错误：一级标题应黑体
      { text: '2026年11月15日下午2时30分', font: '宋体', size: 24, line_spacing: 240, indent: 100, align: 'left' },
      { text: '二、会议地点', font: '宋体', size: 24, align: 'left' },
      { text: '总行五楼多功能厅', font: '宋体', size: 24, line_spacing: 240, indent: 100, align: 'left' },
      { text: '特此通知', font: '宋体', size: 24, line_spacing: 240, indent: 100, align: 'left' },
      { text: 'XX银行办公室', font: '宋体', size: 24, align: 'left' }, // 落款应右对齐
      { text: '2026年11月8日', font: '宋体', size: 24, align: 'left' },
    ],
  });
}

// ── 17-21: TXT 扩充（决定/意见/讲话稿/方案/总结） ──
function createExtendedTxtFiles() {
  // 标准决定
  fs.writeFileSync(path.join(TEST_DIR, '17-standard-decision.txt'),
    '关于表彰2026年度先进集体的决定\n\n各部门：\n2026年以来，全行上下认真贯彻落实总行决策部署，涌现出一批先进集体。为表彰先进、树立典型，经研究，决定对科技部核心系统项目组等10个先进集体予以表彰。\n希望受表彰的集体珍惜荣誉、再接再厉，全行各单位向先进学习，推动各项工作再上新台阶。\n\nXX银行\n2026年10月30日',
    'utf8');
  console.log('  ✓ Created: 17-standard-decision.txt');

  // 标准意见
  fs.writeFileSync(path.join(TEST_DIR, '18-standard-opinion.txt'),
    '关于推进数字化转型工作的指导意见\n\n各部门：\n为深入贯彻落实数字化转型战略部署，加快推动业务模式创新，经研究，现就推进数字化转型工作提出如下意见。\n一、总体要求\n坚持顶层设计与基层创新相结合，统筹推进业务流程数字化、客户服务智能化、运营管理精细化。\n二、重点任务\n（一）加快核心系统升级改造。\n（二）推进数据中台建设。\n（三）加强科技人才培养。\n三、保障措施\n各部门要切实加强组织领导，明确责任分工，确保各项任务落到实处。\n\nXX银行\n2026年10月28日',
    'utf8');
  console.log('  ✓ Created: 18-standard-opinion.txt');

  // 讲话稿（口语化严重）
  fs.writeFileSync(path.join(TEST_DIR, '19-faulty-speech.txt'),
    '在青年员工座谈会上的主持词\n\n各位同事：\n大家上午好！今天咱们开个会，主要就是想聊聊青年员工的成长问题。\n说实话，最近我看了看大家的绩效数据，有的同事干得挺给力的，必须点赞！但也有个别人，工作差不多就行，这个态度可不行。\n年轻人要有冲劲，别老是觉得自己不行。我当年也是从基层干起来的，只要肯下功夫，肯定能搞出名堂。\n希望大家回去后好好想想，咱们下次再交流。\n\n谢谢大家！',
    'utf8');
  console.log('  ✓ Created: 19-faulty-speech.txt');

  // 方案
  fs.writeFileSync(path.join(TEST_DIR, '20-standard-workplan.txt'),
    '2026年第四季度重点工作推进方案\n\n为圆满完成年度经营目标，结合当前工作实际，制定本方案。\n一、总体目标\n第四季度末，全行各项经营指标全面完成年度计划。\n二、重点任务\n（一）加快重点项目落地。各项目组倒排工期，确保按期交付。\n（二）强化风险管控。加强信贷资产质量监测，守住风险底线。\n（三）提升服务质量。优化客户服务流程，提高客户满意度。\n三、推进机制\n（一）建立周调度机制。\n（二）实行月度通报制度。\n四、工作要求\n各部门要提高政治站位，压实工作责任，确保各项任务圆满完成。\n\nXX银行办公室\n2026年10月8日',
    'utf8');
  console.log('  ✓ Created: 20-standard-workplan.txt');

  // 总结夹带请示（标题用"报告"文种，触发 CHK-DIR-003 夹带请示检查）
  fs.writeFileSync(path.join(TEST_DIR, '21-faulty-summary.txt'),
    '关于2026年第三季度工作总结的报告\n\n三季度，我部围绕年度工作目标，扎实推进各项工作。现将有关情况总结如下。\n一、主要工作\n核心系统升级改造项目按计划推进，已完成总体架构设计。\n二、存在问题\n部分项目进度滞后，个别设备老化严重。\n三、下步打算\n加快推进核心系统升级改造，加强设备维护管理。\n四、请示事项\n因项目需要，请总行追加预算500万元，用于核心系统升级改造项目。\n\n科技部\n2026年10月8日',
    'utf8');
  console.log('  ✓ Created: 21-faulty-summary.txt');
}

// ═══════════════════════════════════════════════
// 真实企业公文语料（2026-08-22）：红头/签发人/表格/版记/附件说明/章条式
// ═══════════════════════════════════════════════

// 红头版头模板（下行文：标志+文号居中+红色反线）
function redHeaderDown(docNum, extra) {
  return Object.assign({ org: 'XX银行股份有限公司文件', doc_num: docNum, doc_num_align: 'center' }, extra || {});
}

// ── 25: 标准红头通知（全要素：版头/标题/层次/附件说明/落款/版记） ──
function createRealRedHeaderNotice() {
  createDocx(path.join(TEST_DIR, '25-real-notice-redheader.docx'), {
    red_header: redHeaderDown('XX银发〔2026〕15号'),
    title: '关于召开2026年第四季度经营工作会议的通知',
    title_font: '方正小标宋简体', title_size: 44, margin: STD_MARGIN,
    body_paras: [
      { text: '各部门、各分行：', font: '仿宋_GB2312', size: 32, align: 'both' },
      { text: '为全面总结前三季度经营工作，研究部署第四季度重点任务，经行长办公会研究，定于2026年10月20日召开经营工作会议。现将有关事项通知如下。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '一、会议时间', font: '黑体', size: 32, align: 'both' },
      { text: '2026年10月20日上午9时，会期半天。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '二、会议地点', font: '黑体', size: 32, align: 'both' },
      { text: '总行十六楼报告厅。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '三、参会人员', font: '黑体', size: 32, align: 'both' },
      { text: '（一）总行领导班子成员；', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '（二）总行各部门主要负责人；', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '（三）各分行行长。', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '四、会议要求', font: '黑体', size: 32, align: 'both' },
      { text: '（一）请参会人员提前10分钟入场，会议期间将手机调至静音。', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '（二）请各部门、各分行于10月15日前将参会回执报总行办公室。', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '附件：1.2026年第四季度经营工作会议议程\n2.参会回执', font: '仿宋_GB2312', size: 32, indent: 640, align: 'both' },
      { text: '特此通知', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: 'XX银行', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月8日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
    version_block: { cc: '各部门、各分行', print: 'XX银行办公室    2026年10月8日印发' },
  });
}

// ── 26: 会议通知带议程表格（表内五号宋体，应豁免正文格式检查） ──
function createRealNoticeWithTable() {
  createDocx(path.join(TEST_DIR, '26-real-notice-agenda-table.docx'), {
    red_header: redHeaderDown('XX银办〔2026〕23号'),
    title: '关于召开数字化转型推进会的通知',
    title_font: '方正小标宋简体', title_size: 44, margin: STD_MARGIN,
    body_paras: [
      { text: '各部门：', font: '仿宋_GB2312', size: 32, align: 'both' },
      { text: '为加快推进全行数字化转型工作，定于2026年10月25日召开数字化转型推进会。现将有关事项通知如下。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '一、会议时间及地点', font: '黑体', size: 32, align: 'both' },
      { text: '2026年10月25日下午2时，总行十楼多功能厅。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '二、参会人员', font: '黑体', size: 32, align: 'both' },
      { text: '总行各部门数字化转型工作负责人及联络员各1名。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '三、会议议程', font: '黑体', size: 32, align: 'both' },
      { text: '附件：数字化转型推进会议程', font: '黑体', size: 28, align: 'center' },
      { table: {
          header: ['时间', '议程内容', '主讲人'],
          rows: [
            ['14:00-14:20', '行领导动员讲话', '张伟'],
            ['14:20-15:00', '数字化转型总体规划解读', '李强'],
            ['15:00-15:40', '重点项目推进情况通报', '王芳'],
            ['15:40-16:30', '分组讨论', '全体参会人员'],
            ['16:30-17:00', '会议总结', '张伟'],
          ],
        } },
      { text: '四、其他事项', font: '黑体', size: 32, align: 'both' },
      { text: '请参会人员提前10分钟入场，并携带本部门数字化转型工作材料。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '特此通知', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: 'XX银行办公室', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月12日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
    version_block: { cc: '各部门', print: 'XX银行办公室    2026年10月12日印发' },
  });
}

// ── 27: 经营情况报告带数据表格（数字表述、百分比） ──
function createRealReportWithTable() {
  createDocx(path.join(TEST_DIR, '27-real-report-data-table.docx'), {
    red_header: redHeaderDown('XX银发〔2026〕18号'),
    title: '关于2026年三季度经营情况的报告',
    title_font: '方正小标宋简体', title_size: 44, margin: STD_MARGIN,
    body_paras: [
      { text: '总行：', font: '仿宋_GB2312', size: 32, align: 'both' },
      { text: '2026年三季度，全行认真贯彻落实年度经营工作会议精神，各项经营指标总体平稳。现将有关情况报告如下。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '一、主要经营指标完成情况', font: '黑体', size: 32, align: 'both' },
      { text: '三季度末，全行各项经营指标稳步增长，主要指标完成情况如下：', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { table: {
          header: ['指标', '三季度完成', '同比增幅'],
          rows: [
            ['各项存款余额', '5,820亿元', '8.6%'],
            ['各项贷款余额', '4,930亿元', '7.2%'],
            ['中间业务收入', '15.6亿元', '12.3%'],
            ['不良贷款率', '1.08%', '-0.12个百分点'],
          ],
        } },
      { text: '二、重点工作推进情况', font: '黑体', size: 32, align: 'both' },
      { text: '（一）核心系统升级改造项目按计划推进，已完成总体架构设计和试点验证。', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '（二）数字化转型重点项目有序实施，线上渠道交易占比提升至82%。', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '三、存在问题', font: '黑体', size: 32, align: 'both' },
      { text: '部分分行存款增长乏力，个别重点项目进度滞后于计划。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '四、下步工作打算', font: '黑体', size: 32, align: 'both' },
      { text: '（一）加大存款营销力度，确保完成全年存款增长目标。', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '（二）加快重点项目推进，实行周调度、月通报。', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '特此报告', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: 'XX银行经营发展部', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月10日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
    version_block: { print: 'XX银行办公室    2026年10月10日印发' },
  });
}

// ── 28: 上行文请示（签发人版头 + 附件说明，标准） ──
function createRealSignedRequest() {
  createDocx(path.join(TEST_DIR, '28-real-request-signed.docx'), {
    red_header: { org: 'XX银行股份有限公司文件', doc_num: 'XX银科〔2026〕9号', doc_num_align: 'left', signer: '张伟' },
    title: '关于追加核心系统升级改造项目预算的请示',
    title_font: '方正小标宋简体', title_size: 44, margin: STD_MARGIN,
    body_paras: [
      { text: '总行：', font: '仿宋_GB2312', size: 32, align: 'both' },
      { text: '核心系统升级改造项目于2026年3月启动，原预算2000万元。项目实施过程中，因技术架构调整和数据迁移工作量增加，需追加预算500万元。现请示如下。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '一、项目基本情况', font: '黑体', size: 32, align: 'both' },
      { text: '该项目已完成总体架构设计，进入开发实施阶段，计划于2027年6月上线。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '二、追加预算的必要性', font: '黑体', size: 32, align: 'both' },
      { text: '（一）技术架构调整增加云计算基础设施投入。', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '（二）历史数据迁移工作量超出原估算。', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '三、追加预算安排', font: '黑体', size: 32, align: 'both' },
      { text: '本次申请追加预算500万元，其中云计算基础设施采购300万元，数据库授权120万元，容灾备份建设80万元。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '附件：1.核心系统升级改造项目预算明细表', font: '仿宋_GB2312', size: 32, indent: 640, align: 'both' },
      { text: '妥否，请批示', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: 'XX银行科技部', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月9日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
  });
}

// ── 29: 红头格式错误（标志非红非小标宋/文号方括号/正文四号宋体/序号错误/斜杠日期） ──
function createRealFaultyRedHeader() {
  createDocx(path.join(TEST_DIR, '29-real-faulty-redheader.docx'), {
    red_header: { org: 'XX银行股份有限公司文件', org_font: '宋体', org_color: '000000', org_size: 48, doc_num: 'XX银发[2026]15号' },
    title: '关于召开2026年第四季度经营工作会议的通知',
    title_font: '宋体', title_size: 44, margin: STD_MARGIN,
    body_paras: [
      { text: '各部门：', font: '宋体', size: 28, align: 'left' }, // 四号宋体（应三号仿宋）
      { text: '为全面总结前三季度经营工作，现就召开经营工作会议有关事项通知如下。', font: '宋体', size: 28, line_spacing: 360, indent: 200, align: 'left' },
      { text: '一.会议时间', font: '宋体', size: 28, align: 'left' }, // 序号"一."错误 + 一级标题应黑体
      { text: '2026年10月20日上午9时', font: '宋体', size: 28, line_spacing: 360, indent: 200, align: 'left' },
      { text: '二.会议地点', font: '宋体', size: 28, align: 'left' },
      { text: '总行十六楼报告厅', font: '宋体', size: 28, line_spacing: 360, indent: 200, align: 'left' },
      { text: '附件：1.会议议程', font: '宋体', size: 28, align: 'left' },
      // 缺少"特此通知"结语
      { text: 'XX银行', font: '宋体', size: 28, align: 'left' },
      { text: '2026/10/8', font: '宋体', size: 28, align: 'left' }, // 斜杠日期
    ],
  });
}

// ── 30: 报告夹带请示（表格内含预算明细，P0 应检出） ──
function createRealFaultyReportRequest() {
  createDocx(path.join(TEST_DIR, '30-real-faulty-report-request.docx'), {
    red_header: redHeaderDown('XX银发〔2026〕19号'),
    title: '关于2026年三季度经营情况及追加预算的报告',
    title_font: '方正小标宋简体', title_size: 44, margin: STD_MARGIN,
    body_paras: [
      { text: '总行：', font: '仿宋_GB2312', size: 32, align: 'both' },
      { text: '2026年三季度，全行各项经营指标总体平稳。现将有关情况及需要解决的事项报告如下。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '一、经营指标完成情况', font: '黑体', size: 32, align: 'both' },
      { text: '三季度各项存款余额较年初增长7.5%，各项贷款余额增长6.8%。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '二、下步工作打算', font: '黑体', size: 32, align: 'both' },
      { text: '（一）加大营销力度，全力冲刺年度目标。', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '（二）加快重点项目推进。', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '三、请示事项', font: '黑体', size: 32, align: 'both' }, // P0：报告夹带请示
      { text: '因项目需要，请总行追加预算500万元，用于核心系统升级改造项目。具体明细如下：', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' }, // P0：资金请示
      { table: {
          header: ['项目', '金额'],
          rows: [
            ['云计算平台建设', '300万元'],
            ['数据库授权采购', '120万元'],
            ['容灾备份建设', '80万元'],
          ],
        } },
      // 缺少"特此报告"结语
      { text: 'XX银行科技部', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月11日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
  });
}

// ── 31: 会议纪要（出席人员表格 + 请假/列席名单，标准） ──
function createRealMeetingMinutes() {
  createDocx(path.join(TEST_DIR, '31-real-meeting-minutes.docx'), {
    red_header: redHeaderDown('XX银会〔2026〕6号'),
    title: '2026年三季度经营分析会议纪要',
    title_font: '方正小标宋简体', title_size: 44, margin: STD_MARGIN,
    body_paras: [
      { text: '2026年10月15日上午，我行召开2026年三季度经营分析会议。会议由张伟行长主持，总行领导班子成员及相关部门负责人参加。现将会议议定事项纪要如下。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '一、会议基本情况', font: '黑体', size: 32, align: 'both' },
      { text: '出席人员：', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { table: {
          header: ['部门', '姓名', '职务'],
          rows: [
            ['行长室', '张伟', '行长'],
            ['经营发展部', '李强', '总经理'],
            ['风险管理部', '王芳', '总经理'],
            ['科技部', '赵敏', '总经理'],
          ],
        } },
      { text: '请假人员：刘洋（出差）。列席人员：办公室、审计部负责人。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '二、会议主要精神', font: '黑体', size: 32, align: 'both' },
      { text: '会议全面总结了前三季度经营工作情况，分析了当前面临的形势和问题，对第四季度工作作出部署。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '三、议定事项', font: '黑体', size: 32, align: 'both' },
      { text: '（一）各部门于10月31日前完成年度目标差距分析，形成书面材料报行长办公会。', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '（二）由经营发展部牵头，制定第四季度业务冲刺方案。', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '（三）由科技部负责，加快核心系统升级改造项目进度。', font: '楷体_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '会议记录：办公室', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月15日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
    version_block: { print: 'XX银行办公室    2026年10月15日印发' },
  });
}

// ── 32: 制度文件（章条式管理办法，黑体章标题 + 条文，标准） ──
// 按 regulation 档案规格生成：标题黑体、页边距 25/25/32/32mm（twips: 25mm≈1417, 32mm≈1814）
var REGULATION_MARGIN = { top: 1417, right: 1814, bottom: 1417, left: 1814 };
function createRealRegulation() {
  createDocx(path.join(TEST_DIR, '32-real-regulation.docx'), {
    red_header: redHeaderDown('XX银发〔2026〕20号'),
    title: 'XX银行股份有限公司信息系统运维管理办法',
    title_font: '黑体', title_size: 44, margin: REGULATION_MARGIN,
    body_paras: [
      { text: '第一章 总则', font: '黑体', size: 32, align: 'center' },
      { text: '第一条 为规范全行信息系统运维管理，保障业务连续性和数据安全，依据有关法律法规及监管要求，制定本办法。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '第二条 本办法适用于总行各部门及各分行的信息系统运维活动。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '第二章 职责分工', font: '黑体', size: 32, align: 'center' },
      { text: '第三条 科技部是全行信息系统运维工作的归口管理部门，负责制定运维制度、组织运维实施。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '第四条 各业务部门负责本部门业务系统的需求管理和运行监督。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '第三章 运维管理', font: '黑体', size: 32, align: 'center' },
      { text: '第五条 运维人员应每日对核心系统运行状态进行巡检，并如实记录巡检日志。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '第六条 系统变更应严格执行申请、审批、实施、验证流程，重大变更应经科技部负责人批准。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '第四章 附则', font: '黑体', size: 32, align: 'center' },
      { text: '第七条 本办法由科技部负责解释。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: '第八条 本办法自印发之日起施行。', font: '仿宋_GB2312', size: 32, line_spacing: 560, indent: 640, align: 'both' },
      { text: 'XX银行', font: '仿宋_GB2312', size: 32, align: 'right' },
      { text: '2026年10月13日', font: '仿宋_GB2312', size: 32, align: 'right' },
    ],
    version_block: { cc: '总行各部门、各分行', print: 'XX银行办公室    2026年10月13日印发' },
  });
}

// ── 生成所有测试文档 ──
console.log('Generating test documents...');
createStandardNotice();
createFormatErrorDoc();
createTextErrorDoc();
createCombinedErrorDoc();
createStandardRequest();
createReportWithRequest();
createTxtFiles();
createStandardLetter();
createStandardReply();
createStandardMeetingMinutes();
createStandardAnnouncement();
createMultiRecipientRequest();
createReportMissingEnding();
createNumberingErrors();
createFormatChaosDoc();
createExtendedTxtFiles();
createRealRedHeaderNotice();
createRealNoticeWithTable();
createRealReportWithTable();
createRealSignedRequest();
createRealFaultyRedHeader();
createRealFaultyReportRequest();
createRealMeetingMinutes();
createRealRegulation();
console.log('\nAll test documents created in:', TEST_DIR);
console.log('Total files:', fs.readdirSync(TEST_DIR).length);
