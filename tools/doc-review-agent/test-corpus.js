/**
 * 测试语料批量验证 — 遍历 test-docs/ 全部文件，逐个上传审阅
 *
 * 输出：文件名 / 解析状态 / 文种 / marks 数 / 格式+文本分布
 * 用法: node tools/doc-review-agent/test-corpus.js [filter]
 *   node tools/doc-review-agent/test-corpus.js pdf   # 只测 pdf
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DIR = path.join(__dirname, 'test-docs');
const PORT = 3000;
// llm=0：语料回归锁定确定性检查路径（LLM 输出不稳定，不适合做精确断言基线；
// LLM 语义审阅由 run-full-test 与 CDP 端到端实验覆盖）
const API = '/api/knowledge/doc-review-agent/upload-review?llm=0';
var filter = process.argv[2] || '';

function postFile(filePath, fileName) {
  return new Promise(function(resolve, reject) {
    var file = fs.readFileSync(filePath);
    var boundary = '----FormBoundary' + Date.now();
    var header = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + fileName + '"\r\nContent-Type: application/octet-stream\r\n\r\n');
    var footer = Buffer.from('\r\n--' + boundary + '--\r\n');
    var body = Buffer.concat([header, file, footer]);

    var req = http.request({
      hostname: 'localhost', port: PORT, path: API, method: 'POST',
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

async function main() {
  var files = fs.readdirSync(TEST_DIR).filter(function(f) {
    return !filter || f.indexOf(filter) >= 0;
  }).sort();

  console.log('========================================');
  console.log(' 测试语料批量验证（' + files.length + ' 个文件）');
  console.log('========================================\n');

  var okCount = 0, failCount = 0;

  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var filePath = path.join(TEST_DIR, f);
    if (!fs.statSync(filePath).isFile()) continue;

    try {
      var r = await postFile(filePath, f);
      if (r.status === 200 && r.data.success) {
        okCount++;
        var s = r.data.stats || {};
        var p0 = s.p0 || 0;
        console.log('  [OK] ' + f + '  文种=' + (r.data.docType || '?') +
          '  marks=' + (s.total != null ? s.total : r.data.marks.length) +
          ' (格式' + (s.format_marks || 0) + '+文本' + (s.text_marks || 0) +
          ', 替换' + (s.replace || 0) + ' 删除' + (s.delete || 0) + ' 插入' + (s.insert || 0) + ' 批注' + (s.comment || 0) +
          ', P0:' + p0 + ')');
      } else {
        failCount++;
        console.log('  [FAIL] ' + f + '  status=' + r.status + ' ' + (r.data.error || r.data.raw || ''));
      }
    } catch (e) {
      failCount++;
      console.log('  [FAIL] ' + f + '  ' + e.message);
    }
  }

  console.log('\n========================================');
  console.log(' 成功: ' + okCount + ' / 失败: ' + failCount);
  console.log('========================================');
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(function(e) { console.error('Runner error:', e); process.exit(1); });
