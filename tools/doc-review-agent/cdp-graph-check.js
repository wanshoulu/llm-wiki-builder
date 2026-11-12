/**
 * CDP 图谱渲染验证 — 无头 Edge 实测 G6 渲染后的节点坐标，量化重叠率
 * 验证点：① 初始图谱渲染无重叠 ② 审阅触发后召回节点点亮 ③ 放大模态框渲染
 * 用法: node tools/doc-review-agent/cdp-graph-check.js [debugPort]
 */
const http = require('http');
var debugPort = parseInt(process.argv[2] || '9223', 10);

function getJSON(url) {
  return new Promise(function(resolve, reject) {
    http.get(url, function(res) {
      var b = ''; res.on('data', function(c) { b += c; });
      res.on('end', function() { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// 页面内取图实例节点坐标 → 统计重叠（圆心距 < 半径和×0.9 视为重叠）
var OVERLAP_FN = '(function(){var g=window.wikiGraphInstance;if(!g)return JSON.stringify({error:"NO_INSTANCE"});' +
  'var el=document.getElementById("wikiGraph");' +
  'var d=g.getNodeData()||[];var pts=d.map(function(n){return{id:n.id,x:(n.style&&n.style.x)||0,y:(n.style&&n.style.y)||0,size:(n.style&&n.style.size)||16}});' +
  'var ov=0,minD=Infinity,pairs=[];' +
  'for(var i=0;i<pts.length;i++)for(var j=i+1;j<pts.length;j++){var dx=pts[i].x-pts[j].x,dy=pts[i].y-pts[j].y;var dist=Math.sqrt(dx*dx+dy*dy);' +
  'if(dist<minD)minD=dist;if(dist<(pts[i].size+pts[j].size)/2*0.9){ov++;if(pairs.length<5)pairs.push(pts[i].id+"~"+pts[j].id+" d="+Math.round(dist));}}' +
  'return JSON.stringify({n:pts.length,canvas:(el?el.clientWidth+"x"+el.clientHeight:""),overlaps:ov,minDist:Math.round(minD),worst:pairs});})()';

var MODAL_OVERLAP_FN = '(function(){var g=window.modalGraphInstance;if(!g)return JSON.stringify({error:"NO_MODAL_GRAPH"});' +
  'var d=g.getNodeData()||[];var pts=d.map(function(n){return{x:(n.style&&n.style.x)||0,y:(n.style&&n.style.y)||0,size:(n.style&&n.style.size)||16}});' +
  'var ov=0,minD=Infinity;for(var i=0;i<pts.length;i++)for(var j=i+1;j<pts.length;j++){var dx=pts[i].x-pts[j].x,dy=pts[i].y-pts[j].y;var dist=Math.sqrt(dx*dx+dy*dy);' +
  'if(dist<minD)minD=dist;if(dist<(pts[i].size+pts[j].size)/2*0.9)ov++;}' +
  'return JSON.stringify({n:pts.length,overlaps:ov,minDist:Math.round(minD)});})()';

async function main() {
  var target = null;
  for (var i = 0; i < 30 && !target; i++) {
    try {
      var list = await getJSON('http://127.0.0.1:' + debugPort + '/json/list');
      target = list.filter(function(t) { return t.type === 'page' && t.url.indexOf('doc-review-agent') >= 0; })[0];
    } catch (e) {}
    if (!target) await new Promise(function(r) { setTimeout(r, 1000); });
  }
  if (!target) { console.error('FAIL: 未找到页面目标（Edge 是否以 --remote-debugging-port=' + debugPort + ' 启动？）'); process.exit(1); }

  var ws = new WebSocket(target.webSocketDebuggerUrl);
  var msgId = 0;
  var pending = {};
  function send(method, params) {
    return new Promise(function(resolve, reject) {
      var mid = ++msgId;
      pending[mid] = { resolve: resolve, reject: reject };
      ws.send(JSON.stringify({ id: mid, method: method, params: params }));
    });
  }
  ws.onmessage = function(ev) {
    var msg = JSON.parse(ev.data);
    if (msg.id && pending[msg.id]) { pending[msg.id].resolve(msg.result); delete pending[msg.id]; }
  };
  await new Promise(function(r) { ws.onopen = r; });
  await send('Runtime.enable');

  await new Promise(function(r) { setTimeout(r, 8000); }); // 等 wiki-graph fetch + G6 渲染
  var r1 = await send('Runtime.evaluate', { expression: OVERLAP_FN, returnByValue: true });
  console.log('[1] 初始图谱（d3-force+collide）:', r1.result.value);

  // 页面内发起真实审阅（复用 renderReviewResult → 召回节点点亮）
  var reviewExpr = '(async function(){var r=await fetch("/api/knowledge/doc-review-agent/review-marks",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:"关于召开会议的通知\\n\\n各部门：\\n会议取得了巨大成效。\\n特此通知\\n办公室\\n2026年10月8日",enableLLM:false})});var d=await r.json();renderReviewResult(d);return JSON.stringify({ok:d.success,docType:d.docType,recall:(d.recall_pages||[]).length});})()';
  var r2 = await send('Runtime.evaluate', { expression: reviewExpr, awaitPromise: true, returnByValue: true });
  console.log('[2] 审阅触发（页面内 fetch+渲染）:', r2.result.value);
  await new Promise(function(r) { setTimeout(r, 2500); });
  var r3 = await send('Runtime.evaluate', { expression: OVERLAP_FN, returnByValue: true });
  console.log('[3] 召回节点点亮后图谱:', r3.result.value);
  var styleExpr = '(function(){var g=window.wikiGraphInstance;var d=g.getNodeData()||[];var red=0,gray=0,other=0;d.forEach(function(n){var f=(n.style&&n.style.fill)||"";if(f==="#ff4d4f")red++;else if(f==="#ececec")gray++;else other++;});var redLabels=d.filter(function(n){return (n.style&&n.style.fill)==="#ff4d4f";}).map(function(n){return (n.data&&n.data.label)||"";});var graySample=d.filter(function(n){return (n.style&&n.style.fill)==="#ececec";}).slice(0,3).map(function(n){return {label:(n.data&&n.data.label)||"",labelFill:n.style&&n.style.labelFill,opacity:n.style&&n.style.opacity};});return JSON.stringify({total:d.length,redHit:red,grayed:gray,other:other,hitLabels:redLabels,graySample:graySample});})()';
  var r31 = await send('Runtime.evaluate', { expression: styleExpr, returnByValue: true });
  console.log('[3b] 置灰+标签效果（红=召回/灰=其他）:', r31.result.value);
  var panelExpr = '(function(){var nodes=document.querySelectorAll("#pipeNodes .pipe-node[data-pipe]");var steps=[];nodes.forEach(function(n){steps.push(n.getAttribute("data-pipe")+":"+(n.className.indexOf("done")>=0?"done":"pending"));});var p=document.getElementById("statProfile"),r=document.getElementById("statRecall");return JSON.stringify({pipeCount:nodes.length,steps:steps,profile:p?p.textContent:"",recall:r?r.textContent:""});})()';
  var r32 = await send('Runtime.evaluate', { expression: panelExpr, returnByValue: true });
  console.log('[3c] 左栏进度面板（阶段+档案+召回页）:', r32.result.value);

  // 展开左栏（toggleGraphExpand）→ 图随面板变大
  var expandExpr = '(function(){toggleGraphExpand();return JSON.stringify({expanded:graphExpanded,panelW:document.getElementById("sidePanel").clientWidth});})()';
  var r6 = await send('Runtime.evaluate', { expression: expandExpr, returnByValue: true });
  console.log('[4] 展开左栏:', r6.result.value);
  await new Promise(function(r) { setTimeout(r, 1500); });
  var r7 = await send('Runtime.evaluate', { expression: OVERLAP_FN, returnByValue: true });
  console.log('[5] 展开后图谱:', r7.result.value);

  var modalExpr = '(function(){try{openGraphModal();}catch(e){return JSON.stringify({error:e.message});}var m=document.getElementById("graphModal");var c=document.getElementById("gmCanvas");return JSON.stringify({modalOpened:!!m,canvasSize:c?(c.clientWidth+"x"+c.clientHeight):"",docPanel:!!document.getElementById("gmDoc")});})()';
  var r4 = await send('Runtime.evaluate', { expression: modalExpr, returnByValue: true });
  console.log('[6] 放大模态框:', r4.result.value);
  await new Promise(function(r) { setTimeout(r, 2500); });
  var r5 = await send('Runtime.evaluate', { expression: MODAL_OVERLAP_FN, returnByValue: true });
  console.log('[7] 模态大图重叠统计:', r5.result.value);

  // [8] 真实鼠标点击 notice 节点 → 右侧文档面板应渲染该 markdown 文档
  // 节点布局坐标需经 getCanvasByPoint 换算为画布屏幕坐标
  var posExpr = '(function(){var g=window.modalGraphInstance;var c=document.getElementById("gmCanvas");var n=(g.getNodeData()||[]).filter(function(x){return x.id==="doc-types/notice.md"})[0];if(!n)return JSON.stringify({error:"node not found"});var p=[(n.style&&n.style.x)||0,(n.style&&n.style.y)||0];var cp=p;try{if(g.getCanvasByPoint)cp=g.getCanvasByPoint(p);}catch(e){}var r=c.getBoundingClientRect();return JSON.stringify({x:r.left+cp[0],y:r.top+cp[1],raw:p,cp:cp});})()';
  var rp = await send('Runtime.evaluate', { expression: posExpr, returnByValue: true });
  var pos = JSON.parse(rp.result.value);
  console.log('[8] notice 节点屏幕坐标:', rp.result.value);
  if (pos.x) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await new Promise(function(r) { setTimeout(r, 1500); });
    var docExpr = '(function(){var d=document.getElementById("gmDoc");var html=d?d.innerHTML:"";return JSON.stringify({hasMarkdown:html.indexOf("特此通知")>=0||html.indexOf("通知规则")>=0,hasHeading:html.indexOf("<h1")>=0||html.indexOf("<h2")>=0,len:html.length});})()';
    var r8 = await send('Runtime.evaluate', { expression: docExpr, returnByValue: true });
    console.log('[9] 点击节点后文档面板:', r8.result.value);
  }
  // [10] 兜底验证：直接调用 showNodeDoc 验证 API + 渲染链路 + 元数据卡片
  var r9 = await send('Runtime.evaluate', { expression: '(function(){showNodeDoc("doc-types/notice.md");return "called";})()', returnByValue: true });
  await new Promise(function(r) { setTimeout(r, 1200); });
  var docExpr2 = '(function(){var d=document.getElementById("gmDoc");var html=d?d.innerHTML:"";return JSON.stringify({hasMarkdown:html.indexOf("特此通知")>=0,hasHeading:html.indexOf("<h")>=0,hasMetaCard:html.indexOf("gm-meta")>=0,metaDocType:html.indexOf("notice")>=0,metaReviewed:html.indexOf("最后审查")>=0,metaStatus:html.indexOf("ready")>=0,relLinks:(html.match(/gm-rel/g)||[]).length,len:html.length});})()';
  var r10 = await send('Runtime.evaluate', { expression: docExpr2, returnByValue: true });
  console.log('[10] showNodeDoc 验证（正文+元数据卡片）:', r10.result.value);

  process.exit(0);
}

main().catch(function(e) { console.error('ERR', e.message); process.exit(1); });
