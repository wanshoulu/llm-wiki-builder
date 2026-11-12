/**
 * DOCX 结构化解析器 — 直接解析 OOXML 获取格式信息
 *
 * 与 mammoth 不同，本解析器直接读取 docx 内部的 XML，
 * 提取字体、字号、行距、对齐、页边距等格式信息。
 *
 * docx 文件结构：
 *   [Content_Types].xml
 *   _rels/.rels
 *   word/document.xml        ← 主文档（段落、run、文本）
 *   word/styles.xml          ← 样式定义
 *   word/settings.xml        ← 文档设置（页边距）
 *   word/fontTable.xml       ← 字体表
 *
 * 关键 XML 元素：
 *   <w:body><w:p>             段落
 *   <w:pPr>                   段落属性（对齐、缩进、行距）
 *   <w:r><w:rPr>              run 属性（字体、字号、加粗）
 *   <w:rFonts w:ascii/eastAsia/>   字体
 *   <w:sz w:val="44"/>        字号（半磅，44 = 22pt）
 *   <w:spacing w:line="360"/> 行距（1/240，360 = 1.5 倍）
 *   <w:jc w:val="center"/>   对齐
 *   <w:ind w:firstLine="200"/> 首行缩进（1/20 磅）
 *   <w:pgMar w:top/right/bottom/left/> 页边距（1/20 磅）
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// ── XML 辅助函数 ──

function extractTagAttr(xml, tag, attr) {
  var re = new RegExp('<' + tag + '[^>]*\\b' + attr + '="([^"]*)"', 'i');
  var m = xml.match(re);
  return m ? m[1] : null;
}

// 提取所有匹配的元素内容
function extractElements(xml, tag) {
  var results = [];
  var re = new RegExp('<' + tag + '\\s[^>]*>([\\s\\S]*?)</' + tag + '>', 'g');
  var m;
  while ((m = re.exec(xml)) !== null) {
    results.push({ attrs: m[0].match(/[^<]*/)[0], content: m[1] });
  }
  return results;
}

// 解析段落属性 <w:pPr>
function parseParagraphProperties(pPrXml) {
  if (!pPrXml) return {};
  var props = {};

  // 对齐方式
  var jc = pPrXml.match(/<w:jc\s+w:val="([^"]*)"/);
  if (jc) props.alignment = jc[1]; // left/center/right/both

  // 行距 <w:spacing w:line="360" w:lineRule="auto"/>
  var spacing = pPrXml.match(/<w:spacing\s+([^/>]*)\/>/);
  if (spacing) {
    var lineMatch = spacing[1].match(/w:line="(\d+)"/);
    var ruleMatch = spacing[1].match(/w:lineRule="([^"]*)"/);
    if (lineMatch) {
      var lineVal = parseInt(lineMatch[1]);
      if (ruleMatch && ruleMatch[1] === 'exact') {
        props.line_spacing_pt = lineVal / 20; // 磅
      } else {
        props.line_spacing = lineVal / 240; // 倍数
      }
    }
    var beforeMatch = spacing[1].match(/w:before="(\d+)"/);
    var afterMatch = spacing[1].match(/w:after="(\d+)"/);
    if (beforeMatch) props.space_before_pt = parseInt(beforeMatch[1]) / 20;
    if (afterMatch) props.space_after_pt = parseInt(afterMatch[1]) / 20;
  }

  // 首行缩进 <w:ind w:firstLine="200"/>
  var ind = pPrXml.match(/<w:ind\s+([^/>]*)\/>/);
  if (ind) {
    var firstLine = ind[1].match(/w:firstLine="(\d+)"/);
    var leftInd = ind[1].match(/w:left="(\d+)"/);
    if (firstLine) props.first_line_indent_pt = parseInt(firstLine[1]) / 20;
    if (leftInd) props.left_indent_pt = parseInt(leftInd[1]) / 20;
  }

  // 标题级别（通过 pStyle 引用 Heading1-9）
  var pStyle = pPrXml.match(/<w:pStyle\s+w:val="([^"]*)"/);
  if (pStyle) props.style_name = pStyle[1];

  return props;
}

// 解析 run 属性 <w:rPr>
function parseRunProperties(rPrXml) {
  if (!rPrXml) return {};
  var props = {};

  // 字体 <w:rFonts w:ascii="..." w:eastAsia="..."/>
  var rFonts = rPrXml.match(/<w:rFonts\s+([^/>]*)\/>/);
  if (rFonts) {
    var ascii = rFonts[1].match(/w:ascii="([^"]*)"/);
    var eastAsia = rFonts[1].match(/w:eastAsia="([^"]*)"/);
    if (ascii) props.font_ascii = ascii[1];
    if (eastAsia) props.font_eastAsia = eastAsia[1];
  }

  // 字号 <w:sz w:val="44"/>（半磅）
  var sz = rPrXml.match(/<w:sz\s+w:val="(\d+)"/);
  if (sz) props.font_size_pt = parseInt(sz[1]) / 2;

  // 加粗
  if (/<w:b\s/.test(rPrXml) || /<w:b>/.test(rPrXml)) props.bold = true;

  // 斜体
  if (/<w:i\s/.test(rPrXml) || /<w:i>/.test(rPrXml)) props.italic = true;

  // 颜色 <w:color w:val="RRGGBB"/>
  var color = rPrXml.match(/<w:color\s+w:val="([^"]*)"/);
  if (color) props.color = color[1];

  return props;
}

// 从段落 XML 提取文本和 runs
function parseParagraph(pXml) {
  var text = '';
  var runs = [];

  // 提取段落属性
  var pPrMatch = pXml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/);
  var pProps = parseParagraphProperties(pPrMatch ? pPrMatch[1] : '');

  // 提取所有 run
  var runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  var rm;
  var runIdx = 0;
  while ((rm = runRe.exec(pXml)) !== null) {
    var runXml = rm[1];
    var runText = '';

    // 提取文本 <w:t>...</w:t>
    var tRe = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    var tm;
    while ((tm = tRe.exec(runXml)) !== null) {
      runText += tm[1];
    }

    if (runText) {
      // 提取 run 属性
      var rPrMatch = runXml.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
      var rProps = parseRunProperties(rPrMatch ? rPrMatch[1] : '');

      var start = text.length;
      text += runText;
      runs.push({
        index: runIdx++,
        start: start,
        end: text.length,
        text: runText,
        format: rProps,
      });
    }
  }

  return {
    text: text,
    runs: runs,
    format: pProps,
  };
}

// 解析页边距 <w:pgMar>
function parsePageSettings(documentXml) {
  var settings = {};

  var pgMar = documentXml.match(/<w:pgMar\s+([^/>]*)\/>/);
  if (pgMar) {
    var top = pgMar[1].match(/w:top="(\d+)"/);
    var right = pgMar[1].match(/w:right="(\d+)"/);
    var bottom = pgMar[1].match(/w:bottom="(\d+)"/);
    var left = pgMar[1].match(/w:left="(\d+)"/);
    if (top) settings.margin_top_mm = Math.round(parseInt(top[1]) / 56.7); // 1/20 磅 → mm
    if (right) settings.margin_right_mm = Math.round(parseInt(right[1]) / 56.7);
    if (bottom) settings.margin_bottom_mm = Math.round(parseInt(bottom[1]) / 56.7);
    if (left) settings.margin_left_mm = Math.round(parseInt(left[1]) / 56.7);
  }

  // 纸张大小
  var pgSz = documentXml.match(/<w:pgSz\s+([^/>]*)\/>/);
  if (pgSz) {
    var w = pgSz[1].match(/w:w="(\d+)"/);
    var h = pgSz[1].match(/w:h="(\d+)"/);
    if (w) settings.page_width_mm = Math.round(parseInt(w[1]) / 56.7);
    if (h) settings.page_height_mm = Math.round(parseInt(h[1]) / 56.7);
  }

  return settings;
}

// 解析样式表
function parseStyles(stylesXml) {
  if (!stylesXml) return {};
  var styles = {};

  // 提取 Heading1-9 的字体字号
  var styleRe = /<w:style\s+w:type="paragraph"[^>]*>\s*<w:name\s+w:val="([^"]*)"[^>]*>([\s\S]*?)<\/w:style>/g;
  var m;
  while ((m = styleRe.exec(stylesXml)) !== null) {
    var name = m[1];
    var content = m[2];

    var pPrMatch = content.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/);
    var rPrMatch = content.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);

    styles[name] = {
      paragraph: parseParagraphProperties(pPrMatch ? pPrMatch[1] : ''),
      run: parseRunProperties(rPrMatch ? rPrMatch[1] : ''),
    };
  }

  return styles;
}

// ── 主解析函数 ──

function parseDocx(filePath) {
  var zip = new AdmZip(filePath);
  var zipEntries = zip.getEntries();

  var documentXml = '';
  var stylesXml = '';

  zipEntries.forEach(function(entry) {
    if (entry.entryName === 'word/document.xml') {
      documentXml = entry.getData().toString('utf8');
    } else if (entry.entryName === 'word/styles.xml') {
      stylesXml = entry.getData().toString('utf8');
    }
  });

  if (!documentXml) {
    throw new Error('Invalid docx: word/document.xml not found');
  }

  // 解析页边距
  var pageSettings = parsePageSettings(documentXml);

  // 解析样式表
  var styles = parseStyles(stylesXml);

  // 提取表格区间（用于标记段落是否属于表格单元格）
  var tableSpans = [];
  var tblRe = /<w:tbl\b[\s\S]*?<\/w:tbl>/g;
  var tbm;
  var tblCount = 0;
  while ((tbm = tblRe.exec(documentXml)) !== null) {
    tableSpans.push({ start: tbm.index, end: tbm.index + tbm[0].length, index: tblCount++ });
  }
  function findTable(pos) {
    for (var t = 0; t < tableSpans.length; t++) {
      if (pos >= tableSpans[t].start && pos < tableSpans[t].end) return tableSpans[t].index;
    }
    return -1;
  }

  // 提取所有段落 <w:p>...</w:p>
  var paragraphs = [];
  var pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  var pm;
  while ((pm = pRe.exec(documentXml)) !== null) {
    var pXml = '<w:p>' + pm[1] + '</w:p>';
    var para = parseParagraph(pXml);

    // 标记表格单元格段落（表格内文字字号字体与正文不同，格式检查需豁免）
    var tblIdx = findTable(pm.index);
    if (tblIdx >= 0) {
      para.is_table = true;
      para.table_index = tblIdx;
    }

    // 应用样式表（如果引用了 Heading）
    if (para.format.style_name && styles[para.format.style_name]) {
      var style = styles[para.format.style_name];
      // 合并样式（run 属性优先于样式定义）
      if (!para.format.alignment && style.paragraph.alignment) {
        para.format.alignment = style.paragraph.alignment;
      }
      para.runs.forEach(function(run) {
        if (!run.format.font_size_pt && style.run.font_size_pt) {
          run.format.font_size_pt = style.run.font_size_pt;
        }
        if (!run.format.font_eastAsia && style.run.font_eastAsia) {
          run.format.font_eastAsia = style.run.font_eastAsia;
        }
        if (!run.format.bold && style.run.bold) {
          run.format.bold = style.run.bold;
        }
      });
    }

    // 识别标题级别
    var styleName = para.format.style_name || '';
    var headingMatch = styleName.match(/[Hh]eading(\d)/);
    if (headingMatch) {
      para.format.heading_level = parseInt(headingMatch[1]);
    }

    paragraphs.push(para);
  }

  // 提取纯文本
  var fullText = paragraphs.map(function(p) { return p.text; }).join('\n');

  return {
    text: fullText,
    paragraphs: paragraphs,
    pageSettings: pageSettings,
    styles: Object.keys(styles),
    metadata: {
      fileName: path.basename(filePath),
      paragraphCount: paragraphs.length,
      charCount: fullText.length,
      tableCount: tableSpans.length,
      stylesUsed: paragraphs.filter(function(p) { return p.format.style_name; })
        .map(function(p) { return p.format.style_name; })
        .filter(function(v, i, a) { return a.indexOf(v) === i; }),
    },
  };
}

// PDF 解析（pdf-parse v2 是 PDFParse 类 + getText()，v1 是函数式 API，做兼容）
async function parsePdf(filePath) {
  var pdfParseMod = require('pdf-parse');
  var PDFParseCls = pdfParseMod.PDFParse || pdfParseMod;
  var dataBuffer = fs.readFileSync(filePath);

  var data;
  if (PDFParseCls === pdfParseMod) {
    // v1：pdfParse(buffer) 直接返回 { text, numpages, ... }
    data = await pdfParseMod(dataBuffer);
  } else {
    // v2：new PDFParse({ data }).getText() → { text, pages, total }
    var parser = new PDFParseCls({ data: dataBuffer });
    var result = await parser.getText();
    data = {
      text: result.text || '',
      pages: Array.isArray(result.pages) ? result.pages : [],
    };
  }

  var pageCount = data.numpages || (data.pages ? data.pages.length : 0) || 0;

  return {
    text: data.text || '',
    paragraphs: (data.text || '').split('\n').filter(function(l) { return l.trim(); }).map(function(text) {
      return { text: text, runs: [{ text: text, format: {} }], format: {} };
    }),
    pageSettings: {}, // PDF 无法提取页边距
    styles: [],
    metadata: {
      fileName: path.basename(filePath),
      paragraphCount: (data.text || '').split('\n').length,
      charCount: (data.text || '').length,
      pageCount: pageCount,
      note: 'PDF 格式信息有限，仅做文本审核',
    },
  };
}

// 统一入口
async function parseDocument(filePath) {
  var ext = path.extname(filePath).toLowerCase();
  if (ext === '.docx') {
    return parseDocx(filePath);
  } else if (ext === '.pdf') {
    return parsePdf(filePath);
  } else if (ext === '.txt' || ext === '.md') {
    var text = fs.readFileSync(filePath, 'utf8');
    return {
      text: text,
      paragraphs: text.split('\n').map(function(t) { return { text: t, runs: [{ text: t, format: {} }], format: {} }; }),
      pageSettings: {},
      styles: [],
      metadata: { fileName: path.basename(filePath), paragraphCount: text.split('\n').length, charCount: text.length },
    };
  } else {
    throw new Error('不支持的文件格式: ' + ext + '（支持 .docx / .pdf / .txt）');
  }
}

module.exports = {
  parseDocx: parseDocx,
  parsePdf: parsePdf,
  parseDocument: parseDocument,
};
