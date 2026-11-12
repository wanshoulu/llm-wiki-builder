/**
 * 公文审核 Agent 完整功能测试
 *
 * 测试所有 API 端点 + 多种文档类型
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DIR = path.join(__dirname, 'test-docs');
const BASE = 'localhost';
const PORT = 3000;
const API = '/api/knowledge/doc-review-agent';

var testResults = [];
var passCount = 0;
var failCount = 0;

function log(test, status, detail) {
  var icon = status === 'PASS' ? '✓' : (status === 'FAIL' ? '✗' : '⚠');
  console.log('  ' + icon + ' [' + status + '] ' + test + (detail ? ': ' + detail : ''));
  testResults.push({ test: test, status: status, detail: detail });
  if (status === 'PASS') passCount++;
  else if (status === 'FAIL') failCount++;
}

// HTTP 请求辅助
function postJSON(pathStr, body) {
  return new Promise(function(resolve, reject) {
    var data = JSON.stringify(body);
    var req = http.request({
      hostname: BASE, port: PORT, path: pathStr, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, function(res) {
      var buf = '';
      res.on('data', function(c) { buf += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, data: { error: 'JSON parse error', raw: buf.substring(0, 200) } }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJSON(pathStr) {
  return new Promise(function(resolve, reject) {
    var req = http.request({ hostname: BASE, port: PORT, path: pathStr, method: 'GET' }, function(res) {
      var buf = '';
      res.on('data', function(c) { buf += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, data: { error: 'JSON parse error', raw: buf.substring(0, 200) } }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function postFile(pathStr, filePath, fileName) {
  return new Promise(function(resolve, reject) {
    var file = fs.readFileSync(filePath);
    var boundary = '----FormBoundary' + Date.now();
    var header = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + fileName + '"\r\nContent-Type: application/octet-stream\r\n\r\n');
    var footer = Buffer.from('\r\n--' + boundary + '--\r\n');
    var body = Buffer.concat([header, file, footer]);

    var req = http.request({
      hostname: BASE, port: PORT, path: pathStr, method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length },
    }, function(res) {
      var buf = '';
      res.on('data', function(c) { buf += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, data: { error: 'JSON parse error', raw: buf.substring(0, 200) } }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 主测试函数 ──
async function runTests() {
  console.log('========================================');
  console.log(' 公文审核 Agent 完整功能测试');
  console.log('========================================\n');

  // ── 测试 1: Skills API ──
  console.log('【1】Skills API');
  try {
    var r = await getJSON(API + '/skills');
    if (r.status === 200 && r.data.skills) {
      log('GET /skills', 'PASS', '返回 ' + r.data.skills.length + ' 个 skills');
    } else {
      log('GET /skills', 'FAIL', 'status=' + r.status);
    }
  } catch (e) { log('GET /skills', 'FAIL', e.message); }

  // ── 测试 2: 文本审阅 - 标准公文（应通过） ──
  console.log('\n【2】文本审阅 - 标准公文');
  try {
    var r = await postJSON(API + '/review-marks', {
      text: '关于召开2026年第三季度经营分析会议的通知\n\n各部门：\n为全面总结第三季度经营工作，研究部署第四季度重点任务，现就召开经营分析会议有关事项通知如下。\n一、会议时间\n2026年10月15日上午9时\n二、会议地点\n总行三楼会议室\n三、参会人员\n各部门主要负责人\n\n特此通知\n\nXX银行办公室\n2026年10月8日',
    });
    if (r.status === 200 && r.data.success) {
      var markCount = r.data.marks.length;
      log('标准公文审阅', markCount === 0 ? 'PASS' : 'WARN', '发现 ' + markCount + ' 处问题（应为 0）');
    } else {
      log('标准公文审阅', 'FAIL', 'status=' + r.status);
    }
  } catch (e) { log('标准公文审阅', 'FAIL', e.message); }

  // ── 测试 3: 文本审阅 - 口语化公文（应发现忌用词） ──
  console.log('\n【3】文本审阅 - 口语化公文');
  try {
    var r = await postJSON(API + '/review-marks', {
      text: '关于搞经济工作的会议通知\n\n各位领导：\n为贯彻落实上头精神，我们觉得应该召开一个会议，大概讨论一下经济工作。这个会议搞的好的话，能够取得巨大成效。\n请各位务必参加\n\n办公室\n2026年',
    });
    if (r.status === 200 && r.data.success) {
      var tabooMarks = r.data.marks.filter(function(m) { return m.rule_id === 'LEXICON'; });
      log('忌用词检测', tabooMarks.length >= 4 ? 'PASS' : 'FAIL', '检测到 ' + tabooMarks.length + ' 个忌用词（应≥4）');
      var insertMarks = r.data.marks.filter(function(m) { return m.type === 'insert'; });
      log('缺结语检测', insertMarks.length >= 1 ? 'PASS' : 'FAIL', '检测到插入建议 ' + insertMarks.length + ' 个（应≥1）');
    } else {
      log('口语化公文审阅', 'FAIL', 'status=' + r.status);
    }
  } catch (e) { log('口语化公文审阅', 'FAIL', e.message); }

  // ── 测试 4: 文本审阅 - 标点错误公文 ──
  console.log('\n【4】文本审阅 - 标点错误公文');
  try {
    var r = await postJSON(API + '/review-marks', {
      text: '关于召开会议的通知\n\n各部门:\n为召开会议,研究部署任务.现通知如下.\n一.会议时间\n2026年11月15日\n1、各部门负责人\n2、分管副职\n特此通知.\n办公室\n2026-11-8',
    });
    if (r.status === 200 && r.data.success) {
      var puncMarks = r.data.marks.filter(function(m) { return m.rule_id === 'CHK-PUNC-001'; });
      log('半角标点检测', puncMarks.length >= 3 ? 'PASS' : 'FAIL', '检测到 ' + puncMarks.length + ' 处（应≥3）');
      var numMarks = r.data.marks.filter(function(m) { return m.rule_id === 'CHK-PUNC-002'; });
      log('序号标点检测', numMarks.length >= 2 ? 'PASS' : 'FAIL', '检测到 ' + numMarks.length + ' 处（应≥2）');
      var dateMarks = r.data.marks.filter(function(m) { return m.rule_id === 'CHK-PUNC-003'; });
      log('日期格式检测', dateMarks.length >= 1 ? 'PASS' : 'FAIL', '检测到 ' + dateMarks.length + ' 处（应≥1）');
    } else {
      log('标点错误审阅', 'FAIL', 'status=' + r.status);
    }
  } catch (e) { log('标点错误审阅', 'FAIL', e.message); }

  // ── 测试 5: 报告夹带请示检测 ──
  console.log('\n【5】报告夹带请示检测');
  try {
    var r = await postJSON(API + '/review-marks', {
      text: '关于2026年第三季度工作情况的报告\n\n总行：\n三季度工作扎实推进。现将情况报告如下。\n一、主要工作\n项目按计划推进\n二、存在问题\n进度滞后\n三、下步打算\n加快推进\n四、请示事项\n请总行追加预算500万元\n特此报告\n科技部',
    });
    if (r.status === 200 && r.data.success) {
      var dirMarks = r.data.marks.filter(function(m) { return m.rule_id === 'CHK-DIR-003'; });
      log('夹带请示检测', dirMarks.length >= 1 ? 'PASS' : 'FAIL', '检测到 ' + dirMarks.length + ' 处 P0（应≥1）');
    } else {
      log('夹带请示检测', 'FAIL', 'status=' + r.status);
    }
  } catch (e) { log('夹带请示检测', 'FAIL', e.message); }

  // ── 测试 6: 多头请示检测 ──
  console.log('\n【6】多头请示检测');
  try {
    var r = await postJSON(API + '/review-marks', {
      text: '关于申请追加预算的请示\n\n总行、财政部：\n根据项目进展，需追加预算。\n以上请示，请予批复\n科技部',
    });
    if (r.status === 200 && r.data.success) {
      var multiMarks = r.data.marks.filter(function(m) { return m.rule_id === 'CHK-DIR-002'; });
      log('多头主送检测', multiMarks.length >= 1 ? 'PASS' : 'FAIL', '检测到 ' + multiMarks.length + ' 处（应≥1）');
    } else {
      log('多头请示检测', 'FAIL', 'status=' + r.status);
    }
  } catch (e) { log('多头请示检测', 'FAIL', e.message); }

  // ── 测试 7: apply-marks API ──
  console.log('\n【7】应用修改 API');
  try {
    // 文本：'各部门:\n为召开会议,现通知如下.'
    // paragraph 0 = '各部门:' (4 chars), colon at index 3
    // paragraph 1 = '为召开会议,现通知如下.' (12 chars), comma at index 5, period at index 11
    var r = await postJSON(API + '/apply-marks', {
      text: '各部门:\n为召开会议,现通知如下.',
      marks: [
        { id: 'm1', type: 'replace', paragraph: 0, start: 3, end: 4, original: ':', suggested: '：' },
        { id: 'm2', type: 'replace', paragraph: 1, start: 5, end: 6, original: ',', suggested: '，' },
        { id: 'm3', type: 'replace', paragraph: 1, start: 11, end: 12, original: '.', suggested: '。' },
      ],
      acceptedIds: ['m1', 'm2', 'm3'],
    });
    if (r.status === 200 && r.data.success) {
      var expected = '各部门：\n为召开会议，现通知如下。';
      log('应用修改', r.data.finalText === expected ? 'PASS' : 'FAIL',
        '期望="' + expected.replace(/\n/g, '\\n') + '" 实际="' + (r.data.finalText || '').replace(/\n/g, '\\n') + '"');
    } else {
      log('应用修改', 'FAIL', 'status=' + r.status);
    }
  } catch (e) { log('应用修改', 'FAIL', e.message); }

  // ── 测试 8: 文件上传 - docx 格式错误文档 ──
  console.log('\n【8】文件上传 - docx 格式错误');
  var docxFile = path.join(TEST_DIR, '02-format-error.docx');
  if (fs.existsSync(docxFile)) {
    try {
      var r = await postFile(API + '/upload-review', docxFile, 'format-error.docx');
      if (r.status === 200 && r.data.success) {
        var fmtMarks = r.data.marks.filter(function(m) { return m.source === 'format-checker'; });
        log('docx 格式检查', fmtMarks.length >= 3 ? 'PASS' : 'FAIL', '检测到 ' + fmtMarks.length + ' 处格式问题（应≥3）');
        log('页边距提取', r.data.pageSettings && r.data.pageSettings.margin_top_mm ? 'PASS' : 'FAIL', JSON.stringify(r.data.pageSettings));
        log('格式摘要', r.data.formatSummary ? 'PASS' : 'FAIL', '已生成');
      } else {
        log('docx 格式检查', 'FAIL', 'status=' + r.status + ' ' + (r.data.error || ''));
      }
    } catch (e) { log('docx 格式检查', 'FAIL', e.message); }
  } else {
    log('docx 格式检查', 'SKIP', '测试文件不存在');
  }

  // ── 测试 9: 文件上传 - 标准公文（应少问题） ──
  console.log('\n【9】文件上传 - 标准公文');
  var stdFile = path.join(TEST_DIR, '01-standard-notice.docx');
  if (fs.existsSync(stdFile)) {
    try {
      var r = await postFile(API + '/upload-review', stdFile, 'standard.docx');
      if (r.status === 200 && r.data.success) {
        log('标准公文上传', 'PASS', 'marks=' + r.data.marks.length);
        var fmtIssues = r.data.stats ? r.data.stats.format_marks : 0;
        log('标准公文格式', fmtIssues <= 2 ? 'PASS' : 'WARN', '格式问题 ' + fmtIssues + ' 处（应≤2）');
      } else {
        log('标准公文上传', 'FAIL', 'status=' + r.status);
      }
    } catch (e) { log('标准公文上传', 'FAIL', e.message); }
  } else {
    log('标准公文上传', 'SKIP', '测试文件不存在');
  }

  // ── 测试 10: 文件上传 - 综合错误公文 ──
  console.log('\n【10】文件上传 - 综合错误公文');
  var cmbFile = path.join(TEST_DIR, '04-combined-error.docx');
  if (fs.existsSync(cmbFile)) {
    try {
      var r = await postFile(API + '/upload-review', cmbFile, 'combined.docx');
      if (r.status === 200 && r.data.success) {
        var total = r.data.marks.length;
        log('综合错误检测', total >= 5 ? 'PASS' : 'FAIL', '总问题 ' + total + ' 处（应≥5）');
        if (r.data.stats) {
          log('格式+文本', r.data.stats.format_marks >= 2 && r.data.stats.text_marks >= 2 ? 'PASS' : 'FAIL',
            '格式 ' + r.data.stats.format_marks + ' + 文本 ' + r.data.stats.text_marks);
        }
      } else {
        log('综合错误检测', 'FAIL', 'status=' + r.status);
      }
    } catch (e) { log('综合错误检测', 'FAIL', e.message); }
  } else {
    log('综合错误检测', 'SKIP', '测试文件不存在');
  }

  // ── 测试 11: 文件上传 - 报告夹带请示 ──
  console.log('\n【11】文件上传 - 报告夹带请示');
  var repFile = path.join(TEST_DIR, '06-report-with-request.docx');
  if (fs.existsSync(repFile)) {
    try {
      var r = await postFile(API + '/upload-review', repFile, 'report.docx');
      if (r.status === 200 && r.data.success) {
        var p0Marks = r.data.marks.filter(function(m) { return m.severity === 'P0'; });
        log('P0 检测', p0Marks.length >= 1 ? 'PASS' : 'FAIL', 'P0 问题 ' + p0Marks.length + ' 处（应≥1）');
      } else {
        log('报告夹带请示', 'FAIL', 'status=' + r.status);
      }
    } catch (e) { log('报告夹带请示', 'FAIL', e.message); }
  } else {
    log('报告夹带请示', 'SKIP', '测试文件不存在');
  }

  // ── 测试 12: 文件上传 - TXT 文件 ──
  console.log('\n【12】文件上传 - TXT 文件');
  var txtFile = path.join(TEST_DIR, '08-faulty-notice.txt');
  if (fs.existsSync(txtFile)) {
    try {
      var r = await postFile(API + '/upload-review', txtFile, 'faulty.txt');
      if (r.status === 200 && r.data.success) {
        log('TXT 文件解析', 'PASS', 'marks=' + r.data.marks.length);
      } else {
        log('TXT 文件解析', 'FAIL', 'status=' + r.status);
      }
    } catch (e) { log('TXT 文件解析', 'FAIL', e.message); }
  } else {
    log('TXT 文件解析', 'SKIP', '测试文件不存在');
  }

  // ── 测试 13: LLM 语义审阅 ──
  console.log('\n【13】LLM 语义审阅');
  try {
    var r = await postJSON(API + '/review-marks', {
      text: '关于推进数字经济发展工作的指导意见\n\n各部门：\n为深入贯彻落实数字经济发展战略，加快推动产业转型升级，经研究，现就推进数字经济发展工作提出如下意见。\n一、总体要求\n数字经济发展事关全局，各部门要高度重视。要围绕网络化、数字化、智能化发展方向，统筹推进各项工作。\n二、重点任务\n（一）加强基础设施建设。要加大投入力度，完善数字基础设施。\n（二）推动产业数字化转型。要支持企业上云用云，提升数字化水平。\n三、保障措施\n各部门要切实履行职责，加强组织领导，确保各项任务落到实处。\n办公室\n2026年',
    });
    if (r.status === 200 && r.data.success) {
      if (r.data.stats && r.data.stats.llm_enabled) {
        if (r.data.stats.llm_error) {
          log('LLM 调用', 'WARN', '错误: ' + r.data.stats.llm_error);
        } else {
          log('LLM 调用', 'PASS', 'LLM marks=' + r.data.stats.llm_marks);
          log('LLM 总评', r.data.llmSummary ? 'PASS' : 'WARN', r.data.llmSummary ? '已生成' : '未生成');
        }
      } else {
        log('LLM 调用', 'SKIP', 'LLM 未配置');
      }
    } else {
      log('LLM 审阅', 'FAIL', 'status=' + r.status);
    }
  } catch (e) { log('LLM 审阅', 'FAIL', e.message); }

  // ── 测试 14: 错误处理 ──
  console.log('\n【14】错误处理');
  try {
    var r = await postJSON(API + '/review-marks', {});
    log('空文本处理', r.status === 400 ? 'PASS' : 'FAIL', 'status=' + r.status);
  } catch (e) { log('空文本处理', 'FAIL', e.message); }

  try {
    var r = await postFile(API + '/upload-review', path.join(TEST_DIR, 'nonexistent.docx'), 'nonexist.docx');
    log('不存在文件', r.status >= 400 ? 'PASS' : 'WARN', 'status=' + r.status);
  } catch (e) { log('不存在文件', 'PASS', '已正确报错'); }

  // ── 汇总报告 ──
  console.log('\n========================================');
  console.log(' 测试汇总');
  console.log('========================================');
  console.log('  通过: ' + passCount);
  console.log('  失败: ' + failCount);
  console.log('  警告: ' + (testResults.length - passCount - failCount));
  console.log('  总计: ' + testResults.length);
  console.log('========================================');

  // 失败项详情
  var failures = testResults.filter(function(r) { return r.status === 'FAIL'; });
  if (failures.length > 0) {
    console.log('\n失败项详情:');
    failures.forEach(function(f) { console.log('  ✗ ' + f.test + ': ' + f.detail); });
  }

  process.exit(failCount > 0 ? 1 : 0);
}

// 先生成测试文档，再运行测试
var generator = require('./generate-test-docs.js');
runTests().catch(function(e) {
  console.error('Test runner error:', e);
  process.exit(1);
});
