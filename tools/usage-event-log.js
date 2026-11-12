'use strict';

/**
 * 知识检索出口埋点 — 每次真实检索调用追加一条 JSONL 事件（data/usage-events/YYYY-MM.jsonl）。
 * 记录必须 fire-and-forget：任何写盘失败只吞掉，绝不影响检索主链路。
 */

const fs = require('node:fs');
const path = require('node:path');

const EVENTS_DIR = path.join(__dirname, '..', 'data', 'usage-events');

function recordUsageEvent(event) {
  try {
    const d = new Date();
    const month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const file = path.join(EVENTS_DIR, month + '.jsonl');
    const row = Object.assign({ ts: d.toISOString() }, event);
    // 客户端编码错误（如 GBK 按 UTF-8 解码）会产生 U+FFFD 替换符，这种 query 是坏文本不入库
    if (typeof row.query === 'string' && row.query.indexOf('�') >= 0) row.query = '';
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
  } catch (e) { /* 埋点失败不影响业务 */ }
}

// 分天固定按北京时间（UTC+8）：代码跑在 UTC 时区的 ai-harbor 容器里，"运行环境本地时区"
// 实际是 UTC——北京 0 点后产生的事件会被分进"昨天"，而前端浏览器（UTC+8）按本地天生成日期轴，
// 导致"今天"的桶恒为 0。固定 +8 与前端浏览器时区对齐，不再依赖任何运行环境时区。
const DAY_BUCKET_OFFSET_MS = 8 * 3600 * 1000;

function _dayKey(iso) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return String(iso).slice(0, 10);
  return new Date(t + DAY_BUCKET_OFFSET_MS).toISOString().slice(0, 10);
}

function readUsageEvents(days) {
  const cutoff = Date.now() - days * 86400000;
  const rows = [];
  let files = [];
  try { files = fs.readdirSync(EVENTS_DIR).filter(function(f) { return f.endsWith('.jsonl'); }).sort(); } catch (e) { return rows; }
  files.forEach(function(f) {
    let text = '';
    try { text = fs.readFileSync(path.join(EVENTS_DIR, f), 'utf-8'); } catch (e) { return; }
    text.split('\n').forEach(function(line) {
      if (!line.trim()) return;
      try {
        const row = JSON.parse(line);
        if (new Date(row.ts).getTime() >= cutoff) rows.push(row);
      } catch (e) { /* 跳过坏行 */ }
    });
  });
  return rows;
}

// 操作型 query（read:/detail:/context:/tool: 等内部标记）不算真实检索问句，不进入热点统计
const OP_QUERY_PREFIXES = ['read:', 'detail:', 'context:', 'candidate:', 'relations:', 'node:', 'subgraph:', 'graph-read', 'overview', 'list', 'tool:'];

// 热点/零结果只统计"面向问句的检索出口"。技能加载/图谱意图召回/构建任务的 query
// 天然是技术标识（intent-recall、技能 ID、文档名），混进热点业务人员看不懂
const SEARCH_CALLERS = new Set([
  'wiki-search', 'wiki-qa',
  'rag-search', 'rag-graph-search',
  'knowledge-qa', 'knowledge-qa-api', 'knowledge-qa-invoke', 'knowledge-qa-research',
  'unified-search',
  'mcp',
  'graph-query', 'graphrag', 'graph-rag',
  'vector-kb-search', 'bank-semantic-recall',
]);

// 技术出口 → 消费方应用聚合（业界惯例：按应用看采用度，而非按技术出口）
const CALLER_APP = {
  'knowledge-qa': 'knowledge-qa-agent',
  'knowledge-qa-api': 'knowledge-qa-agent',
  'knowledge-qa-research': 'knowledge-qa-agent',
  'knowledge-qa-invoke': 'knowledge-qa-agent',
  'ai-native-bank': 'ai-native-bank',
  'memory-workbench': 'ai-native-bank',
  'variable-recall': 'ai-native-bank',
  'intent-eval-bank': 'eval-tools',
  'intent-eval-bank-multiturn': 'eval-tools',
  'intent-recall-probe': 'eval-tools',
  'mcp': 'mcp-external',
  'mcp-ontology': 'mcp-external',
  'unified-search': 'unified-search-api',
  'hermes-pool': 'ontomind-agent',
  'hermes-cli': 'ontomind-agent',
  'corporate-marketing': 'corporate-marketing',
  'wiki-build': 'wiki-build-agent',
  'schedule-agent': 'schedule-agent',
  'rag-search': 'knowledge-workbench',
  'rag-graph-search': 'knowledge-workbench',
  'wiki-search': 'knowledge-workbench',
  'wiki-read': 'knowledge-workbench',
  'wiki-qa': 'knowledge-workbench',
  'graph-query': 'knowledge-workbench',
  'graphrag': 'knowledge-workbench',
  'skill-build': 'knowledge-workbench',
  'vector-kb-search': 'knowledge-workbench',
  'vector-kb-image-search': 'knowledge-workbench',
  'bank-semantic-recall': 'ai-native-bank',
};

function _resolveApp(row) {
  const caller = String(row.caller || 'unknown');
  if (caller === 'memory-context' || caller === 'memory-write') {
    const kb = String(row.kbId || '');
    if (kb.indexOf('ai-native-bank') === 0) return 'ai-native-bank';
    if (kb) return kb;
    return 'knowledge-qa-agent';
  }
  return CALLER_APP[caller] || 'knowledge-workbench';
}

// 寒暄/无信息量词不算真实问句
const CHITCHAT_QUERIES = new Set(['你好', '您好', 'hi', 'hello', '在吗', '谢谢', 'ok', 'okay', 'test']);

// 死库调用：历史埋点指向的 kbId 已从向量治理面下线（exists:false，旧迭代残留）。
// 这类调用的"零结果"反映的是库已删，不是内容缺口；单独归类但总量/趋势保持原值。
// 名单由向量治理面核实（GET /api/v1/vector-kb/{id}/stats → exists:false）后维护于此。
const DEAD_KB_PREFIXES = [
  '79b32a13-3599-42ed-b678-65aff467b724',  // 1,085 次调用（2026-09 下线）
  '81a88ec0-00b2-44c9-b059-a00a2761e4b0',  // 651 次调用（2026-09 下线）
];

// 系统元操作（MCP 工具枚举/心跳探活等）：hits 恒为 0 但语义上不是检索，零结果无意义
const SYSTEM_OP_CALLERS = new Set(['mcp-ontology', 'mcp-tool-op']);

function _classifyRow(r) {
  const kb = String(r.kbId || '');
  if (kb && DEAD_KB_PREFIXES.some(function(p) { return kb.indexOf(p) === 0; })) return 'deadKb';
  if (SYSTEM_OP_CALLERS.has(String(r.caller || ''))) return 'systemOp';
  if (String(r.query || '').startsWith('tool:')) return 'systemOp';
  return 'business';
}

function _isSearchQuery(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length < 2) return false;
  if (s.indexOf('�') >= 0) return false;  // 编码错误产生的替换符：坏文本不是问句
  const low = s.toLowerCase();
  if (CHITCHAT_QUERIES.has(low)) return false;
  return !OP_QUERY_PREFIXES.some(function(p) { return low === p || low.startsWith(p); });
}

// Elastic/Glean 模式：高频问句 = 热点，零结果问句 = 内容缺口
// rows=检索埋点事件（有召回信息，可判零结果）；extraQueries=业务对话轨迹问句（无召回信息，
// 只计热度不判缺口），两路问句按归一化文本合并 calls，行内 sources 标注来源
function aggregateQueries(rows, extraQueries) {
  const map = new Map();
  rows.forEach(function(r) {
    const raw = String(r.query || '').trim();
    if (!_isSearchQuery(raw)) return;
    const key = raw.toLowerCase();
    const row = map.get(key) || { query: raw, calls: 0, hits: 0, zeroResults: 0, sources: ['search'] };
    row.calls += 1;
    if ((Number(r.hits) || 0) > 0) row.hits += 1; else row.zeroResults += 1;
    map.set(key, row);
  });
  (extraQueries || []).forEach(function(r) {
    const raw = String(r.query || '').trim();
    if (!_isSearchQuery(raw)) return;
    const key = raw.toLowerCase();
    const row = map.get(key) || { query: raw, calls: 0, hits: 0, zeroResults: 0, sources: ['conversation'] };
    row.calls += 1;
    if (row.sources.indexOf('conversation') < 0) row.sources.push('conversation');
    map.set(key, row);
  });
  const all = Array.from(map.values());
  const byCalls = function(a, b) { return b.calls - a.calls; };
  return {
    top: all.slice().sort(byCalls).slice(0, 8),
    zero: all.filter(function(row) { return row.zeroResults > 0; }).sort(byCalls).slice(0, 8),
    // 样本基数：前端据此标注可信度，避免小样本热点被误读为大规模用户行为
    sampleSize: all.length,
    utterances: all.reduce(function(sum, row) { return sum + row.calls; }, 0),
  };
}

// @returns { total, search, daily:[{date,calls,hits,zeroResults}], series:[{date,carrier,calls,hits}], carriers:[{carrier,calls,hits,zeroResults}], callers:[{caller,calls}], apps:[{app,calls}], queries:{top:[...],zero:[...]} }
function aggregateUsageEvents(rows, extraQueries) {
  const total = { calls: 0, hits: 0, zeroResults: 0 };
  // search = 仅检索出口（SEARCH_CALLERS 白名单）的口径：命中率/零结果只对真实检索有意义，
  // 记忆/技能/图谱召回出口结构性几乎不零命中，混进分母会把命中率虚高到失真
  const search = { calls: 0, hits: 0, zeroResults: 0 };
  // searchQuality = 零结果归因旁路（叠加口径，不改 total/search 原值）：
  //   business    → 真实业务检索的零结果（内容缺口的真实信号）
  //   deadKb      → 调用已下线知识库产生的零结果（历史残留，非内容缺口）
  //   systemOp    → 系统元操作（MCP 工具枚举等）的零结果（语义上不是检索）
  const searchQuality = {
    business: { calls: 0, hits: 0, zeroResults: 0 },
    deadKb: { calls: 0, hits: 0, zeroResults: 0 },
    systemOp: { calls: 0, hits: 0, zeroResults: 0 },
  };
  const daily = new Map();
  const series = new Map();
  const carriers = new Map();
  const callers = new Map();
  const apps = new Map();

  rows.forEach(function(r) {
    total.calls += 1;
    const hits = Number(r.hits) || 0;
    const zero = hits === 0 ? 1 : 0;
    if (hits > 0) total.hits += 1;
    total.zeroResults += zero;

    const isSearchCaller = SEARCH_CALLERS.has(String(r.caller || ''));
    if (isSearchCaller) {
      search.calls += 1;
      if (hits > 0) search.hits += 1; else search.zeroResults += 1;
      // 零结果归因：对全部事件做分类（不限于 search caller），保证死库调用/元操作全量可见
      const kind = _classifyRow(r);
      const q = searchQuality[kind];
      q.calls += 1;
      if (hits > 0) q.hits += 1; else q.zeroResults += 1;
    }

    const dk = _dayKey(r.ts);
    const drow = daily.get(dk) || { date: dk, calls: 0, hits: 0, zeroResults: 0 };
    drow.calls += 1; drow.hits += hits > 0 ? 1 : 0; drow.zeroResults += zero;
    daily.set(dk, drow);

    // 评测/探针历史上报过体系外 carrier 'intent-graph'；意图图谱属于图谱载体，归一进 graph
    const ck = r.carrier === 'intent-graph' ? 'graph' : String(r.carrier || 'unknown');
    const sk = dk + '|' + ck;
    const srow = series.get(sk) || { date: dk, carrier: ck, calls: 0, hits: 0 };
    srow.calls += 1; srow.hits += hits > 0 ? 1 : 0;
    series.set(sk, srow);

    const crow = carriers.get(ck) || { carrier: ck, calls: 0, hits: 0, zeroResults: 0 };
    crow.calls += 1; crow.hits += hits > 0 ? 1 : 0; crow.zeroResults += zero;
    carriers.set(ck, crow);

    const uk = String(r.caller || 'unknown');
    callers.set(uk, (callers.get(uk) || 0) + 1);

    const apk = _resolveApp(r);
    apps.set(apk, (apps.get(apk) || 0) + 1);
  });

  const byDate = function(a, b) { return a.date < b.date ? -1 : 1; };
  const byDateCarrier = function(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.carrier < b.carrier ? -1 : a.carrier > b.carrier ? 1 : 0;
  };
  return {
    total: total,
    search: search,
    // 真实业务零结果率（business 分桶口径）：前端用它替代 total 口径的失真零结果率
    businessZeroRate: (function() {
      const b = searchQuality.business;
      return b.calls > 0 ? Number((b.zeroResults / b.calls).toFixed(4)) : null;
    })(),
    searchQuality: searchQuality,
    daily: Array.from(daily.values()).sort(byDate),
    series: Array.from(series.values()).sort(byDateCarrier),
    carriers: Array.from(carriers.values()).sort(function(a, b) { return b.calls - a.calls; }),
    callers: Array.from(callers.entries())
      .map(function(kv) { return { caller: kv[0], calls: kv[1] }; })
      .sort(function(a, b) { return b.calls - a.calls; }),
    apps: Array.from(apps.entries())
      .map(function(kv) { return { app: kv[0], calls: kv[1] }; })
      .sort(function(a, b) { return b.calls - a.calls; }),
    queries: aggregateQueries(rows.filter(function(r) {
      // 热点/零结果问句只看业务检索：死库调用与系统元操作会伪造"部分零结果"/"内容缺口"假象
      return SEARCH_CALLERS.has(String(r.caller || '')) && _classifyRow(r) === 'business';
    }), extraQueries),
  };
}

function usageAnalytics(days, extraQueries) {
  const d = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
  const cutoff = Date.now() - d * 86400000;
  const rows = readUsageEvents(d * 2);
  const currentRows = rows.filter(function(r) { return new Date(r.ts).getTime() >= cutoff; });
  const prevRows = rows.filter(function(r) { return new Date(r.ts).getTime() < cutoff; });
  const inWindowExtras = (extraQueries || []).filter(function(r) { return new Date(r.ts).getTime() >= cutoff; });
  const agg = aggregateUsageEvents(currentRows, inWindowExtras);
  const prevCarriers = new Map(aggregateUsageEvents(prevRows).carriers.map(function(c) { return [c.carrier, c.calls]; }));
  agg.carriers.forEach(function(c) { c.prevCalls = prevCarriers.get(c.carrier) || 0; });
  return Object.assign({ days: d, generatedAt: new Date().toISOString(), windowStart: currentRows.length ? currentRows[0].ts : null }, agg);
}

module.exports = { recordUsageEvent: recordUsageEvent, usageAnalytics: usageAnalytics, aggregateUsageEvents: aggregateUsageEvents };
