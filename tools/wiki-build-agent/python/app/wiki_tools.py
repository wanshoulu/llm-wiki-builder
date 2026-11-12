"""Wiki 构建工具集 — @tool 包装确定性操作与流水线入口。

事件发射沿用 corporate-marketing-agent 的 DataBridge 模式：
create_deep_agent 内部子代理不传播回调，工具事件通过 WikiBridge
直接发射（main.py 注入 emitter → SSE），不依赖框架回调。
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Callable, Optional

from openjiuwen.core.foundation.tool import tool

from .config import llm_config, storage_config
from .export import export_to_reports
from .llm import WikiLLM
from .profiles import DOCUMENT_REVIEW_PROFILE_ID, load_stored_build_profile
from .schema_parser import (
    _build_doc_graph,
    _parse_schema_to_toc,
)
from .search import search_wiki_pages
from .storage import (
    _list_page_versions,
    _read_page_version,
    _read_wiki_page,
    _list_wiki_pages,
    _record_build_history,
    _save_wiki_page,
    _wiki_project_dir,
)

logger = logging.getLogger("wiki-build-agent.tools")


class WikiBridge:
    """工具层事件桥：tool_call / tool_result / pipeline 事件 → main.py SSE 缓冲。"""

    def __init__(self) -> None:
        self._emitter: Optional[Callable[[str, dict], None]] = None
        # 当前构建上下文（由 main.py 在每次请求前设置）
        self.wiki_id: str = ""
        self.model: Optional[str] = None
        self.llm: Optional[WikiLLM] = None

    def set_event_emitter(self, emitter: Callable[[str, dict], None]) -> None:
        self._emitter = emitter

    def emit(self, event_type: str, data: dict) -> None:
        if self._emitter:
            try:
                self._emitter(event_type, data)
            except Exception:
                pass

    def _truncate(self, s, limit: int = 300) -> str:
        if isinstance(s, (dict, list)):
            s = json.dumps(s, ensure_ascii=False)
        else:
            s = str(s)
        return s[:limit] + "..." if len(s) > limit else s


# 请求级隔离：main.py 每个请求创建独立 WikiBridge 后 set_bridge 写入 contextvar，
# 工具在同一协程上下文里 get_bridge 取回，并发请求不再互相覆盖 emitter/wiki_id/model。
_default_bridge = WikiBridge()
_bridge_var: ContextVar[WikiBridge] = ContextVar("wiki_bridge", default=_default_bridge)


def set_bridge(bridge: WikiBridge) -> None:
    _bridge_var.set(bridge)


def get_bridge() -> WikiBridge:
    return _bridge_var.get()


async def _sse_emitter(payload: dict) -> None:
    """pipeline 事件 dict → bridge 事件（main.py 转成旧 SSE 8 类事件）。"""
    get_bridge().emit("pipeline_event", payload)


# ─── 校验器（skill 包 scripts/validate_wiki.py 动态加载） ────

_validator_module = None


def _load_validator():
    global _validator_module
    if _validator_module is None:
        path = storage_config.skills_root / "document-review-wiki-builder" / "scripts" / "validate_wiki.py"
        spec = importlib.util.spec_from_file_location("wiki_skill_validate", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _validator_module = module
    return _validator_module


# ─── 页面读写工具 ───────────────────────────────────────────

@tool(
    name="list_wiki_pages",
    description="列出指定 Wiki 库中的所有知识页面（.md 文件，相对路径）。不包含 _meta 元数据。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
        },
        "required": ["wiki_id"],
    },
    auto_extract=False,
)
async def list_wiki_pages(wiki_id: str) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "list_wiki_pages", "args": {"wiki_id": wiki_id}})
    t0 = time.time()
    pages = await asyncio.to_thread(_list_wiki_pages, wiki_id)
    result = {"wiki_id": wiki_id, "count": len(pages), "pages": pages}
    bridge.emit("tool_result", {"tool": "list_wiki_pages", "ok": True, "result": bridge._truncate(result, 500),
                                "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="read_wiki_page",
    description="读取 Wiki 库中一个页面的完整内容。page 为相对路径（如 entities/差旅报销.md 或 SCHEMA.md），自动补 .md 后缀。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
            "page": {"type": "string", "description": "页面相对路径"},
        },
        "required": ["wiki_id", "page"],
    },
    auto_extract=False,
)
async def read_wiki_page(wiki_id: str, page: str) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "read_wiki_page", "args": {"wiki_id": wiki_id, "page": page}})
    t0 = time.time()
    content = await asyncio.to_thread(_read_wiki_page, wiki_id, page)
    result = {"wiki_id": wiki_id, "page": page, "found": bool(content),
              "content": content[:20000], "truncated": len(content) > 20000}
    bridge.emit("tool_result", {"tool": "read_wiki_page", "ok": True,
                                "result": {"found": bool(content), "length": len(content)},
                                "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="save_wiki_page",
    description="保存（覆盖）Wiki 库中一个页面的内容。用于写入新生成的页面、修正 SCHEMA.md / index.md 等。路径经存储层校验，禁止逃逸库目录。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
            "page": {"type": "string", "description": "页面相对路径"},
            "content": {"type": "string", "description": "完整的页面 Markdown 内容"},
        },
        "required": ["wiki_id", "page", "content"],
    },
    auto_extract=False,
)
async def save_wiki_page(wiki_id: str, page: str, content: str) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "save_wiki_page", "args": {"wiki_id": wiki_id, "page": page,
                                                                 "content_length": len(content)}})
    t0 = time.time()
    try:
        await _save_wiki_page(wiki_id, page, content)
        result = {"ok": True, "page": page}
    except Exception as e:
        result = {"ok": False, "error": str(e)}
    bridge.emit("tool_result", {"tool": "save_wiki_page", "ok": result["ok"],
                                "result": bridge._truncate(result, 300),
                                "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="search_wiki",
    description="按关键词在指定 Wiki 库内做 BM25 检索（含 raw 层源文档），返回命中的页面、得分与片段。查找知识点/条款/出处时优先用它定位，再用 read_wiki_page 读全文。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
            "query": {"type": "string", "description": "检索关键词（可多个词，空格分隔）"},
            "top_k": {"type": "integer", "description": "返回条数上限，默认 8"},
        },
        "required": ["wiki_id", "query"],
    },
    auto_extract=False,
)
async def search_wiki(wiki_id: str, query: str, top_k: int = 8) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "search_wiki", "args": {"wiki_id": wiki_id, "query": query}})
    t0 = time.time()
    try:
        hits = await asyncio.to_thread(search_wiki_pages, wiki_id, query, top_k)
        result = {"wiki_id": wiki_id, "query": query, "hit_count": len(hits), "hits": hits}
        ok = True
    except Exception as e:
        logger.error("search_wiki 失败: %s", e, exc_info=True)
        result = {"wiki_id": wiki_id, "query": query, "hit_count": 0, "hits": [], "error": str(e)[:300]}
        ok = False
    bridge.emit("tool_result", {"tool": "search_wiki", "ok": ok,
                                "result": {"hit_count": result["hit_count"]},
                                "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="parse_schema",
    description="解析 SCHEMA.md 文本为结构化目录树（类别/主题/交叉引用）。生成或修改 Schema 后必须先解析校验再落盘。",    input_params={
        "type": "object",
        "properties": {
            "schema_text": {"type": "string", "description": "SCHEMA.md 全文"},
        },
        "required": ["schema_text"],
    },
    auto_extract=False,
)
async def parse_schema(schema_text: str) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "parse_schema", "args": {"schema_length": len(schema_text)}})
    t0 = time.time()
    toc = _parse_schema_to_toc(schema_text)
    result = {"topic_count": toc.get("topic_count", 0),
              "categories": [c.get("key") for c in toc.get("tree", [])],
              "topics": [{"key": t["key"], "title": t["title"]} for t in toc.get("topics", [])][:200],
              "cross_refs": toc.get("cross_refs", [])[:200]}
    bridge.emit("tool_result", {"tool": "parse_schema", "ok": True,
                                "result": {"topic_count": result["topic_count"]},
                                "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="validate_wiki_structure",
    description="对公文审核（document-review）类 Wiki 库执行治理校验：注册表、页面 frontmatter、知识条目、发布清单。返回 errors / warnings 列表。非公文库会跳过并给出提示（通用库请改用 wiki_quality_score 做量化体检）。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
        },
        "required": ["wiki_id"],
    },
    auto_extract=False,
)
async def validate_wiki_structure(wiki_id: str) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "validate_wiki_structure", "args": {"wiki_id": wiki_id}})
    t0 = time.time()
    try:
        root = _wiki_project_dir(wiki_id)
        # 校验器来自公文审核 Skill，强依赖 knowledge_id / document_type_ids 等公文
        # 专属字段；对 generic 库执行会输出大量不适用错误，因此先按库配置守卫。
        stored_profile = load_stored_build_profile(root)
        # 无 profile 记录（多数存量库）时按契约特征采样：校验器要求页面 frontmatter
        # 含 knowledge_id，若库内页面普遍不含，说明不是按该 Skill 契约构建的库，
        # 跑校验只会输出大量不适用错误。
        contract_hits = 0
        sampled = 0
        if not stored_profile:
            for p in (await asyncio.to_thread(_list_wiki_pages, wiki_id))[:5]:
                if p.startswith("_"):
                    continue
                body = await asyncio.to_thread(_read_wiki_page, wiki_id, p) or ""
                sampled += 1
                if "knowledge_id" in body:
                    contract_hits += 1
        skip_reason = ""
        if stored_profile and stored_profile != DOCUMENT_REVIEW_PROFILE_ID:
            skip_reason = f"当前库构建配置为 {stored_profile}，该校验器仅适用于「{DOCUMENT_REVIEW_PROFILE_ID}」类知识库"
        elif not stored_profile and sampled and contract_hits == 0:
            skip_reason = ("库内页面 frontmatter 不含 knowledge_id 契约字段，"
                           "与文档审核 Skill 的页面规范不匹配")
        if skip_reason:
            result = {
                "ok": True, "skipped": True, "profile": stored_profile,
                "errors": [], "error_count": 0,
                "warnings": [{"message": f"{skip_reason}，已跳过校验；"
                                         f"通用库请用 wiki_quality_score 做量化体检。"}],
                "warning_count": 1,
            }
        else:
            validator = _load_validator()
            raw = await asyncio.to_thread(validator.validate, root)
            # Skill 脚本返回 dict 报告（v2），旧契约期望 (errors, warnings) 元组，两种都兼容
            extra: dict[str, Any] = {}
            if isinstance(raw, tuple) and len(raw) == 2:
                errors, warnings = list(raw[0] or []), list(raw[1] or [])
            elif isinstance(raw, dict):
                errors = list(raw.get("errors") or [])
                warnings = list(raw.get("warnings") or [])
                extra = {k: raw.get(k) for k in ("status", "page_count", "rule_count") if k in raw}
            else:
                errors, warnings = [], []
                extra = {"warning": f"校验器返回了未知结构: {type(raw).__name__}"}
            result = {"ok": not errors, "errors": errors[:100], "warnings": warnings[:100],
                      "error_count": len(errors), "warning_count": len(warnings)}
            result.update(extra)
    except Exception as e:
        # 异常分支必须带齐字段，否则下方 emit 读 result["error_count"] 会二次崩溃
        result = {"ok": False, "errors": [{"message": f"校验器执行失败: {e}"}], "warnings": [],
                  "error_count": 1, "warning_count": 0}
    bridge.emit("tool_result", {"tool": "validate_wiki_structure", "ok": result["ok"],
                                "result": {"ok": result["ok"], "errors": result["error_count"],
                                           "warnings": result.get("warning_count", 0)},
                                "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="build_doc_graph",
    description="重建 Wiki 库的文档关系图（节点=页面，边=交叉引用+同类互联+正文 wikilink）。纯规则扫描，秒级完成。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
        },
        "required": ["wiki_id"],
    },
    auto_extract=False,
)
async def build_doc_graph_tool(wiki_id: str) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "build_doc_graph", "args": {"wiki_id": wiki_id}})
    t0 = time.time()
    graph = await asyncio.to_thread(_build_doc_graph, wiki_id)
    try:
        await _save_wiki_page(wiki_id, "_wiki_graph.json", json.dumps(graph, ensure_ascii=False))
    except Exception as e:
        logger.warning(f"缓存文档图谱失败: {e}")
    bridge.emit("tool_result", {"tool": "build_doc_graph", "ok": True,
                                "result": graph.get("stats", {}),
                                "durationMs": int((time.time() - t0) * 1000)})
    bridge.emit("pipeline_event", {"type": "product", "product_type": "graph", "data": graph})
    return {"stats": graph.get("stats", {}), "nodes": len(graph.get("nodes", [])), "edges": len(graph.get("edges", []))}


@tool(
    name="record_build_history",
    description="写入一条构建历史到库的 _meta/build-history.json（status: running/success/failed）。同 id 视为更新；遗留 running 自动收敛为 failed。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
            "entry_id": {"type": "string", "description": "条目 ID（如 bh_169...）"},
            "status": {"type": "string", "enum": ["running", "success", "failed"], "description": "状态"},
            "type": {"type": "string", "description": "build / update / 其他操作类型"},
            "summary": {"type": "string", "description": "结果摘要（可选）"},
            "error": {"type": "string", "description": "失败原因（可选）"},
        },
        "required": ["wiki_id", "entry_id", "status"],
    },
    auto_extract=False,
)
async def record_build_history(wiki_id: str, entry_id: str, status: str,
                               type: str = "build", summary: str = "", error: str = "") -> dict[str, Any]:
    fields = {"type": type, "status": status}
    if summary:
        fields["summary"] = summary
    if error:
        fields["error"] = error[:500]
    if status in ("success", "failed"):
        import datetime
        fields["finished_at"] = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    await _record_build_history(wiki_id, entry_id, **fields)
    return {"ok": True}


# ─── 流水线入口工具（结构化生成主流程） ─────────────────────

@tool(
    name="run_wiki_build",
    description="""对指定 Wiki 库执行全量构建流水线：保存 raw 层 → 生成 SCHEMA（截断续写/重试）→ 生成 index → 逐页生成正文 → 重建图谱。
用户上传文档并要求"构建 wiki / 全量构建"时调用。构建事件（trace/product/content）会实时推送给前端。""",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID（新库由系统预生成）"},
            "message": {"type": "string", "description": "用户的原始构建请求消息"},
            "file_content": {"type": "string", "description": "源文档全文（Markdown）"},
            "filename": {"type": "string", "description": "源文档文件名"},
            "build_profile": {"type": "string", "enum": ["generic", "document-review"],
                              "description": "构建配置：generic 通用 Wiki / document-review 公文审核"},
        },
        "required": ["wiki_id", "message", "file_content", "filename"],
    },
    auto_extract=False,
)
async def run_wiki_build(wiki_id: str, message: str, file_content: str, filename: str,
                         build_profile: str = "generic") -> dict[str, Any]:
    from .pipeline import build_wiki
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "run_wiki_build",
                              "args": {"wiki_id": wiki_id, "filename": filename, "build_profile": build_profile}})
    t0 = time.time()
    try:
        await build_wiki(
            message, file_content, filename,
            bridge.llm or WikiLLM(), bridge.model or llm_config.model,
            wiki_id, _sse_emitter,
            build_profile_id=build_profile,
        )
        result = {"ok": True, "wiki_id": wiki_id}
    except Exception as e:
        logger.error("run_wiki_build 失败: %s", e, exc_info=True)
        await _record_build_history(
            wiki_id, f"bh_fail_{int(time.time() * 1000)}",
            type="build", status="failed",
            finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            error=str(e)[:500],
        )
        bridge.emit("pipeline_event", {"type": "error", "message": f"构建失败: {e}"})
        result = {"ok": False, "error": str(e)[:500]}
    bridge.emit("tool_result", {"tool": "run_wiki_build", "ok": result["ok"],
                                "result": bridge._truncate(result, 300),
                                "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="run_wiki_update",
    description="""对已有 Wiki 库执行增量更新流水线：加载已有 Schema → 合并新文档 → 更新 index → 补齐缺失正文 → 重建图谱。
用户上传新文档并要求"更新 / 增量 / 追加"时调用。
注意：不上传新文档、只要求"补全缺失页正文 / 把没写完的页面补齐"时，file_content 和 filename 均可省略（或传空字符串），
此时只补全缺失/过短页面正文，不改动 SCHEMA 与 index。""",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "已有 Wiki 库 ID"},
            "message": {"type": "string", "description": "用户的原始更新请求消息"},
            "file_content": {"type": "string", "description": "新文档全文（Markdown）；无新文档时省略或传空串"},
            "filename": {"type": "string", "description": "新文档文件名；无新文档时省略或传空串"},
            "build_profile": {"type": "string", "enum": ["generic", "document-review"],
                              "description": "构建配置（默认沿用库配置）"},
        },
        "required": ["wiki_id", "message"],
    },
    auto_extract=False,
)
async def run_wiki_update(wiki_id: str, message: str, file_content: str = "",
                          filename: str = "", build_profile: str = "generic") -> dict[str, Any]:
    from .pipeline import update_wiki
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "run_wiki_update",
                              "args": {"wiki_id": wiki_id, "filename": filename}})
    t0 = time.time()
    try:
        await update_wiki(
            message, file_content, filename,
            bridge.llm or WikiLLM(), bridge.model or llm_config.model,
            wiki_id, _sse_emitter,
            build_profile_id=build_profile,
        )
        result = {"ok": True, "wiki_id": wiki_id}
    except Exception as e:
        logger.error("run_wiki_update 失败: %s", e, exc_info=True)
        await _record_build_history(
            wiki_id, f"bh_fail_{int(time.time() * 1000)}",
            type="update", status="failed",
            finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            error=str(e)[:500],
        )
        bridge.emit("pipeline_event", {"type": "error", "message": f"增量更新失败: {e}"})
        result = {"ok": False, "error": str(e)[:500]}
    bridge.emit("tool_result", {"tool": "run_wiki_update", "ok": result["ok"],
                                "result": bridge._truncate(result, 300),
                                "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="export_wiki",
    description="把指定 Wiki 库导出为单文件 HTML（可离线浏览）或合并 Markdown，落盘到库的 _reports/exports/ 下并返回文件路径。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
            "format": {"type": "string", "enum": ["html", "md"], "description": "导出格式，默认 html"},
        },
        "required": ["wiki_id"],
    },
    auto_extract=False,
)
async def export_wiki(wiki_id: str, format: str = "html") -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "export_wiki", "args": {"wiki_id": wiki_id, "format": format}})
    t0 = time.time()
    fmt = format if format in ("html", "md") else "html"
    try:
        out = await asyncio.to_thread(export_to_reports, wiki_id, fmt)
        result = {"ok": True, "wiki_id": wiki_id, "format": fmt, "path": f"_reports/exports/{out.name}"}
    except Exception as e:
        logger.error("export_wiki 失败: %s", e, exc_info=True)
        result = {"ok": False, "error": str(e)[:300]}
    bridge.emit("tool_result", {"tool": "export_wiki", "ok": bool(result.get("ok")),
                                "result": bridge._truncate(result, 300),
                                "durationMs": int((time.time() - t0) * 1000)})
    if result.get("ok"):
        bridge.emit("pipeline_event", {"type": "product", "product_type": "export",
                                       "data": {"format": fmt, "path": result["path"]}})
    return result


# ─── 质量分析工具（LLM 驱动） ──────────────────────────────

from .prompts import (
    WIKI_SUGGEST_SYSTEM_PROMPT,
    WIKI_DEPTH_CHECK_SYSTEM_PROMPT,
    WIKI_DEDUP_SYSTEM_PROMPT,
    WIKI_ORPHAN_SYSTEM_PROMPT,
    WIKI_LINK_CHECK_SYSTEM_PROMPT,
    WIKI_CROSS_REF_FIX_SYSTEM_PROMPT,
    WIKI_TAG_OPTIMIZE_SYSTEM_PROMPT,
    WIKI_SUMMARIZE_SYSTEM_PROMPT,
    WIKI_QA_SYSTEM_PROMPT,
    WIKI_COMPARE_SYSTEM_PROMPT,
    WIKI_TOPIC_MERGE_SYSTEM_PROMPT,
    WIKI_TOPIC_SPLIT_SYSTEM_PROMPT,
)
import re as _re


async def _read_pages_snapshot(wiki_id: str, limit: int = 40) -> str:
    """读取页面概况（路径/行数/正文摘要），供 LLM 类工具作为上下文。"""
    pages = await asyncio.to_thread(_list_wiki_pages, wiki_id)
    snapshot = []
    for p in pages[:limit]:
        content = await asyncio.to_thread(_read_wiki_page, wiki_id, p)
        if content:
            snapshot.append({"page": p, "lines": len(content.split("\n")),
                             "preview": content[:300]})
    return json.dumps(snapshot, ensure_ascii=False)


def _schema_write_guard(old_schema: str, new_schema: str, min_topics: int) -> tuple[bool, str, int]:
    """SCHEMA 落盘守卫：SCHEMA 是全库契约文件，LLM 输出被 max_tokens 截断后
    直接覆盖会永久丢失页面声明。校验通过才允许写入。

    返回 (允许写入, 原因, 新主题数)。
    """
    if not new_schema or "知识地图" not in new_schema:
        return False, "输出不含「知识地图」章节，判定为不完整，已放弃写入", 0
    new_count = _parse_schema_to_toc(new_schema).get("topic_count", 0)
    if new_count < min_topics:
        return False, (f"输出主题数 {new_count} 少于预期下限 {min_topics}，"
                       f"判定为截断/漏页，已放弃写入以保护 SCHEMA"), new_count
    return True, "", new_count


async def _llm_analyze(bridge, system_prompt: str, user_content: str, *, max_tokens: int = 4096) -> str:
    """通用 LLM 分析：用 bridge 中的 LLM 实例执行一次同步调用。"""
    llm = bridge.llm or WikiLLM()
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]
    text = await llm.chat(model=bridge.model, messages=messages, temperature=0.2, max_tokens=max_tokens)
    return text or ""


def _parse_json_response(text: str) -> dict:
    """从 LLM 输出中提取 JSON（兼容 ```json 围栏）。"""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`").strip()
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].strip()
    try:
        return json.loads(cleaned)
    except Exception:
        return {"raw": text[:500]}


@tool(
    name="wiki_suggest",
    description="分析 Wiki 的 SCHEMA，提出覆盖盲区、分类优化、深度不足、关联缺失、命名规范等改进建议，按 P0/P1/P2 优先级输出。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
        },
        "required": ["wiki_id"],
    },
    auto_extract=False,
)
async def wiki_suggest(wiki_id: str) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "wiki_suggest", "args": {"wiki_id": wiki_id}})
    t0 = time.time()
    try:
        schema = await asyncio.to_thread(_read_wiki_page, wiki_id, "SCHEMA.md")
        if not schema:
            result = {"ok": False, "error": "未找到 SCHEMA.md"}
        else:
            text = await _llm_analyze(bridge, WIKI_SUGGEST_SYSTEM_PROMPT, schema)
            result = {"ok": True, "suggestions": text[:8000]}
    except Exception as e:
        result = {"ok": False, "error": str(e)[:300]}
    bridge.emit("tool_result", {"tool": "wiki_suggest", "ok": result["ok"],
                                "result": bridge._truncate(result, 500), "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="wiki_depth_check",
    description="检查每个页面的正文是否达到 SCHEMA 中 estimated 行数要求，评估内容充实度、结构完整性、交叉引用和标签覆盖。返回 JSON 报告。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
        },
        "required": ["wiki_id"],
    },
    auto_extract=False,
)
async def wiki_depth_check(wiki_id: str) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "wiki_depth_check", "args": {"wiki_id": wiki_id}})
    t0 = time.time()
    try:
        schema = await asyncio.to_thread(_read_wiki_page, wiki_id, "SCHEMA.md")
        if not schema:
            result = {"ok": False, "error": "未找到 SCHEMA.md"}
        else:
            pages = await asyncio.to_thread(_list_wiki_pages, wiki_id)
            page_contents = []
            for p in pages[:30]:
                content = await asyncio.to_thread(_read_wiki_page, wiki_id, p)
                if content:
                    lines = len(content.split("\n"))
                    page_contents.append({"page": p, "lines": lines, "preview": content[:200]})
            user_content = f"SCHEMA:\n{schema}\n\n页面概况:\n{json.dumps(page_contents, ensure_ascii=False)}"
            text = await _llm_analyze(bridge, WIKI_DEPTH_CHECK_SYSTEM_PROMPT, user_content)
            result = {"ok": True, "report": _parse_json_response(text)}
    except Exception as e:
        result = {"ok": False, "error": str(e)[:300]}
    bridge.emit("tool_result", {"tool": "wiki_depth_check", "ok": result["ok"],
                                "result": bridge._truncate(result, 500), "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="wiki_dedup",
    description="检查 SCHEMA 中是否存在重复或高度相似的页面，输出重复对、相似度和合并建议。返回 JSON 报告。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
        },
        "required": ["wiki_id"],
    },
    auto_extract=False,
)
async def wiki_dedup(wiki_id: str) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "wiki_dedup", "args": {"wiki_id": wiki_id}})
    t0 = time.time()
    try:
        schema = await asyncio.to_thread(_read_wiki_page, wiki_id, "SCHEMA.md")
        if not schema:
            result = {"ok": False, "error": "未找到 SCHEMA.md"}
        else:
            text = await _llm_analyze(bridge, WIKI_DEDUP_SYSTEM_PROMPT, schema)
            result = {"ok": True, "report": _parse_json_response(text)}
    except Exception as e:
        result = {"ok": False, "error": str(e)[:300]}
    bridge.emit("tool_result", {"tool": "wiki_dedup", "ok": result["ok"],
                                "result": bridge._truncate(result, 500), "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="wiki_orphan_check",
    description="检测交叉引用网络中的孤立页面（无入引也无出引），输出孤立页面列表和连接建议。返回 JSON 报告。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
        },
        "required": ["wiki_id"],
    },
    auto_extract=False,
)
async def wiki_orphan_check(wiki_id: str) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "wiki_orphan_check", "args": {"wiki_id": wiki_id}})
    t0 = time.time()
    try:
        schema = await asyncio.to_thread(_read_wiki_page, wiki_id, "SCHEMA.md")
        if not schema:
            result = {"ok": False, "error": "未找到 SCHEMA.md"}
        else:
            text = await _llm_analyze(bridge, WIKI_ORPHAN_SYSTEM_PROMPT, schema)
            result = {"ok": True, "report": _parse_json_response(text)}
    except Exception as e:
        result = {"ok": False, "error": str(e)[:300]}
    bridge.emit("tool_result", {"tool": "wiki_orphan_check", "ok": result["ok"],
                                "result": bridge._truncate(result, 500), "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="wiki_link_check",
    description="检查所有 [[页面名]] 链接是否指向 SCHEMA 中存在的页面，输出断链列表和修复建议。返回 JSON 报告。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
        },
        "required": ["wiki_id"],
    },
    auto_extract=False,
)
async def wiki_link_check(wiki_id: str) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "wiki_link_check", "args": {"wiki_id": wiki_id}})
    t0 = time.time()
    try:
        schema = await asyncio.to_thread(_read_wiki_page, wiki_id, "SCHEMA.md")
        pages = await asyncio.to_thread(_list_wiki_pages, wiki_id)
        # 收集所有页面中的 wikilink
        all_links: list[dict] = []
        for p in pages[:30]:
            content = await asyncio.to_thread(_read_wiki_page, wiki_id, p)
            if content:
                for m in _re.finditer(r"\[\[([^\]]+)\]\]", content):
                    all_links.append({"source_page": p, "link": m.group(1)})
        user_content = f"SCHEMA:\n{schema}\n\n发现的链接:\n{json.dumps(all_links[:200], ensure_ascii=False)}"
        text = await _llm_analyze(bridge, WIKI_LINK_CHECK_SYSTEM_PROMPT, user_content)
        result = {"ok": True, "report": _parse_json_response(text)}
    except Exception as e:
        result = {"ok": False, "error": str(e)[:300]}
    bridge.emit("tool_result", {"tool": "wiki_link_check", "ok": result["ok"],
                                "result": bridge._truncate(result, 500), "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="wiki_cross_ref_fix",
    description="分析 SCHEMA 中的页面关联，补充缺失的交叉引用并输出修复后的完整 SCHEMA。修复后自动保存到 Wiki 库。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
        },
        "required": ["wiki_id"],
    },
    auto_extract=False,
)
async def wiki_cross_ref_fix(wiki_id: str) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "wiki_cross_ref_fix", "args": {"wiki_id": wiki_id}})
    t0 = time.time()
    try:
        schema = await asyncio.to_thread(_read_wiki_page, wiki_id, "SCHEMA.md")
        if not schema:
            result = {"ok": False, "error": "未找到 SCHEMA.md"}
        else:
            declared_topics = _parse_schema_to_toc(schema).get("topic_count", 0)
            text = await _llm_analyze(bridge, WIKI_CROSS_REF_FIX_SYSTEM_PROMPT, schema, max_tokens=8192)
            # 落盘守卫：SCHEMA 是全库契约文件，LLM 输出一旦被 max_tokens 截断就会丢
            # 页面声明，直接覆盖等于破坏知识库。要求输出含知识地图且主题数不减少。
            if text and "## 知识地图" in text:
                new_count = _parse_schema_to_toc(text).get("topic_count", 0)
                if new_count < declared_topics:
                    result = {"ok": True, "fixed": False, "topics_before": declared_topics,
                              "topics_after": new_count,
                              "reason": f"输出不完整（主题数 {new_count} < 原 {declared_topics}），已放弃写入以保护 SCHEMA",
                              "raw": text[:300]}
                else:
                    await _save_wiki_page(wiki_id, "SCHEMA.md", text)
                    result = {"ok": True, "fixed": True, "schema_length": len(text),
                              "topics": new_count}
            else:
                result = {"ok": True, "fixed": False,
                          "reason": "输出不含「## 知识地图」，未写入", "raw": text[:300]}
    except Exception as e:
        result = {"ok": False, "error": str(e)[:300]}
    bridge.emit("tool_result", {"tool": "wiki_cross_ref_fix", "ok": result["ok"],
                                "result": bridge._truncate(result, 500), "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="wiki_tag_optimize",
    description="分析 SCHEMA 中所有 tags，统一命名、识别层级关系、检查分布均衡并补充缺失标签。返回 JSON 优化报告。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
        },
        "required": ["wiki_id"],
    },
    auto_extract=False,
)
async def wiki_tag_optimize(wiki_id: str) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "wiki_tag_optimize", "args": {"wiki_id": wiki_id}})
    t0 = time.time()
    try:
        schema = await asyncio.to_thread(_read_wiki_page, wiki_id, "SCHEMA.md")
        if not schema:
            result = {"ok": False, "error": "未找到 SCHEMA.md"}
        else:
            text = await _llm_analyze(bridge, WIKI_TAG_OPTIMIZE_SYSTEM_PROMPT, schema)
            result = {"ok": True, "report": _parse_json_response(text)}
    except Exception as e:
        result = {"ok": False, "error": str(e)[:300]}
    bridge.emit("tool_result", {"tool": "wiki_tag_optimize", "ok": result["ok"],
                                "result": bridge._truncate(result, 500), "durationMs": int((time.time() - t0) * 1000)})
    return result


# ─── 量化质量评分（确定性，零 LLM） ─────────────────────────

@tool(
    name="wiki_quality_score",
    description="对指定 Wiki 库执行确定性量化质量评分：结构完整性、交叉引用密度、内容深度、孤立率、链接有效性、标签覆盖。零 LLM 调用，秒级完成。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
        },
        "required": ["wiki_id"],
    },
    auto_extract=False,
)
async def wiki_quality_score(wiki_id: str) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "wiki_quality_score", "args": {"wiki_id": wiki_id}})
    t0 = time.time()
    try:
        schema = await asyncio.to_thread(_read_wiki_page, wiki_id, "SCHEMA.md")
        if not schema:
            result = {"ok": False, "error": "未找到 SCHEMA.md"}
            bridge.emit("tool_result", {"tool": "wiki_quality_score", "ok": False,
                                        "result": result, "durationMs": int((time.time() - t0) * 1000)})
            return result

        # 解析 SCHEMA 中的页面声明
        toc = _parse_schema_to_toc(schema)
        declared_topics = toc.get("topic_count", 0)
        cross_refs = toc.get("cross_refs", [])
        topics = toc.get("topics", [])

        # 列出实际页面
        pages = await asyncio.to_thread(_list_wiki_pages, wiki_id)
        # 排除元数据文件
        content_pages = [p for p in pages if not p.startswith("_") and p != "SCHEMA.md" and p != "index.md"]

        # 1. 结构完整性（actual vs declared）
        structure_score = min(100, int(len(content_pages) / max(1, declared_topics) * 100)) if declared_topics else 0

        # 2. 交叉引用密度
        avg_refs = len(cross_refs) / max(1, declared_topics)
        cross_ref_score = min(100, int(avg_refs * 50))  # 2 refs/page = 100

        # 3. 内容深度（actual lines vs estimated）
        depth_scores = []
        tag_coverage_count = 0
        orphan_pages = set(content_pages)
        broken_links: list[str] = []
        all_topic_keys = {t.get("key", "") for t in topics}
        all_topic_titles = {t.get("title", "") for t in topics}

        checked_pages = content_pages[:30]
        # 一次性读取并缓存页面正文：原实现在生成器表达式里 await，会抛
        # TypeError: 'async_generator' object is not iterable，导致本工具 100% 失败。
        page_cache: dict[str, str] = {}
        for p in checked_pages:
            page_cache[p] = await asyncio.to_thread(_read_wiki_page, wiki_id, p) or ""

        for p in checked_pages:
            content = page_cache[p]
            if not content:
                depth_scores.append(0)
                continue
            lines = len(content.split("\n"))
            # 查找 estimated
            estimated_match = _re.search(r'estimated:\s*(\d+)', content)
            estimated = int(estimated_match.group(1)) if estimated_match else 50
            ratio = min(1.0, lines / max(1, estimated))
            depth_scores.append(int(ratio * 100))

            # 标签覆盖
            if "tags:" in content:
                tag_coverage_count += 1

            # 交叉引用
            links = _re.findall(r"\[\[([^\]]+)\]\]", content)
            if links:
                orphan_pages.discard(p)
            for link in links:
                if link not in all_topic_keys and link not in all_topic_titles:
                    broken_links.append(f"{p} → [[{link}]]")
            # 出引用减少孤立
            for t in topics:
                if t.get("title") in links:
                    orphan_pages.discard(p)
                    break

        # 4. 内容深度平均分
        content_depth_score = int(sum(depth_scores) / max(1, len(depth_scores))) if depth_scores else 0

        # 5. 孤立率
        orphan_ratio = len(orphan_pages) / max(1, len(content_pages))
        orphan_score = int((1 - orphan_ratio) * 100)

        # 6. 链接有效性（分子分母必须同一口径：都取 checked_pages，否则断链数可能
        #    超过总链数而算出负分）
        total_links = sum(len(_re.findall(r"\[\[([^\]]+)\]\]", page_cache[p])) for p in checked_pages)
        link_score = max(0, int((1 - len(broken_links) / max(1, total_links)) * 100)) if total_links else 100

        # 7. 标签覆盖
        tag_score = int(tag_coverage_count / max(1, len(checked_pages)) * 100)

        # 综合评分（加权平均）
        overall = int(
            structure_score * 0.15 +
            cross_ref_score * 0.20 +
            content_depth_score * 0.25 +
            orphan_score * 0.15 +
            link_score * 0.15 +
            tag_score * 0.10
        )

        result = {
            "ok": True,
            "overall_score": overall,
            "dimensions": {
                "structure": {"score": structure_score, "actual_pages": len(content_pages), "declared_topics": declared_topics},
                "cross_refs": {"score": cross_ref_score, "avg_refs_per_page": round(avg_refs, 2), "total_refs": len(cross_refs)},
                "content_depth": {"score": content_depth_score, "checked_pages": len(depth_scores)},
                "orphan": {"score": orphan_score, "orphan_count": len(orphan_pages), "total_pages": len(content_pages)},
                "links": {"score": link_score, "broken_count": len(broken_links), "total_links": total_links, "broken_links": broken_links[:10]},
                "tags": {"score": tag_score, "tagged_pages": tag_coverage_count, "checked": len(content_pages[:30])},
            },
        }
        bridge.emit("pipeline_event", {"type": "product", "product_type": "quality_score", "data": result})
    except Exception as e:
        logger.error("wiki_quality_score 失败: %s", e, exc_info=True)
        result = {"ok": False, "error": str(e)[:300]}
    bridge.emit("tool_result", {"tool": "wiki_quality_score", "ok": result.get("ok", False),
                                "result": bridge._truncate(result, 500), "durationMs": int((time.time() - t0) * 1000)})
    return result


# ─── 内容生产工具（LLM 驱动，对应前端「输出 / 修复」快捷操作） ────────


@tool(
    name="wiki_summarize",
    description="生成 Wiki 知识库摘要报告：覆盖范围、知识结构统计、核心页面、关键关联、建议阅读路径。产物同时落盘到 _reports/summary.md。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
        },
        "required": ["wiki_id"],
    },
    auto_extract=False,
)
async def wiki_summarize(wiki_id: str) -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "wiki_summarize", "args": {"wiki_id": wiki_id}})
    t0 = time.time()
    try:
        schema = await asyncio.to_thread(_read_wiki_page, wiki_id, "SCHEMA.md")
        if not schema:
            result = {"ok": False, "error": "未找到 SCHEMA.md"}
        else:
            snapshot = await _read_pages_snapshot(wiki_id)
            user_content = f"SCHEMA:\n{schema}\n\n页面概况:\n{snapshot}"
            text = await _llm_analyze(bridge, WIKI_SUMMARIZE_SYSTEM_PROMPT, user_content, max_tokens=4096)
            if not text:
                result = {"ok": False, "error": "LLM 返回空内容"}
            else:
                await _save_wiki_page(wiki_id, "_reports/summary.md", text)
                result = {"ok": True, "summary": text[:8000], "path": "_reports/summary.md",
                          "length": len(text)}
                bridge.emit("pipeline_event", {"type": "product", "product_type": "summary",
                                               "data": {"content": text}})
    except Exception as e:
        logger.error("wiki_summarize 失败: %s", e, exc_info=True)
        result = {"ok": False, "error": str(e)[:300]}
    bridge.emit("tool_result", {"tool": "wiki_summarize", "ok": result.get("ok", False),
                                "result": bridge._truncate(result, 500), "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="wiki_generate_qa",
    description="基于 Wiki 页面内容生成问答对（JSON），用于知识测试与检索增强。每个页面 2-3 组，含难度与引用页面。产物落盘 _reports/qa-pairs.json。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
            "max_pages": {"type": "integer", "description": "最多处理多少页（默认 15）"},
        },
        "required": ["wiki_id"],
    },
    auto_extract=False,
)
async def wiki_generate_qa(wiki_id: str, max_pages: int = 15) -> dict[str, Any]:
    max_pages = max(1, int(max_pages or 15))
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "wiki_generate_qa", "args": {"wiki_id": wiki_id}})
    t0 = time.time()
    try:
        schema = await asyncio.to_thread(_read_wiki_page, wiki_id, "SCHEMA.md")
        pages = await asyncio.to_thread(_list_wiki_pages, wiki_id)
        content_pages = [p for p in pages
                         if not p.startswith(("raw/", "_")) and p.endswith(".md")][:max_pages]
        if not content_pages:
            result = {"ok": False, "error": "库内没有可生成问答对的正文页"}
        else:
            snapshot = []
            for p in content_pages:
                content = await asyncio.to_thread(_read_wiki_page, wiki_id, p)
                if content:
                    snapshot.append({"page": p, "content": content[:1200]})
            user_content = (f"SCHEMA:\n{schema or '(无)'}\n\n页面正文:\n"
                            f"{json.dumps(snapshot, ensure_ascii=False)}")
            text = await _llm_analyze(bridge, WIKI_QA_SYSTEM_PROMPT, user_content, max_tokens=8192)
            parsed = _parse_json_response(text)
            qa_list = parsed if isinstance(parsed, list) else parsed.get("qa_pairs") or []
            await _save_wiki_page(wiki_id, "_reports/qa-pairs.json",
                                  json.dumps(parsed, ensure_ascii=False, indent=2))
            result = {"ok": True, "qa_pairs": qa_list if isinstance(qa_list, list) else [],
                      "count": len(qa_list) if isinstance(qa_list, list) else 0,
                      "path": "_reports/qa-pairs.json",
                      "raw": text[:300] if not isinstance(qa_list, list) else ""}
            bridge.emit("pipeline_event", {"type": "product", "product_type": "qa_pairs",
                                           "data": {"items": result["qa_pairs"]}})
    except Exception as e:
        logger.error("wiki_generate_qa 失败: %s", e, exc_info=True)
        result = {"ok": False, "error": str(e)[:300]}
    bridge.emit("tool_result", {"tool": "wiki_generate_qa", "ok": result.get("ok", False),
                                "result": bridge._truncate(result, 500), "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="wiki_compare_versions",
    description="对比 SCHEMA 的两个版本并输出差异报告（新增/移除/修改页面）。默认对比「当前版本 vs 上一个历史版本」；也可用 version_ts 指定历史版本。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
            "page": {"type": "string", "description": "对比的页面（默认 SCHEMA.md）"},
            "version_ts": {"type": "string", "description": "指定历史版本时间戳；省略则用上一个版本"},
        },
        "required": ["wiki_id"],
    },
    auto_extract=False,
)
async def wiki_compare_versions(wiki_id: str, page: str = "SCHEMA.md",
                                version_ts: str = "") -> dict[str, Any]:
    # 工具框架会对未提供的可选参数传 None（而非采用签名默认值），此处兜底
    page = page or "SCHEMA.md"
    version_ts = version_ts or ""
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "wiki_compare_versions",
                              "args": {"wiki_id": wiki_id, "page": page}})
    t0 = time.time()
    try:
        current = await asyncio.to_thread(_read_wiki_page, wiki_id, page)
        if not current:
            result = {"ok": False, "error": f"未找到页面 {page}"}
        else:
            versions = await asyncio.to_thread(_list_page_versions, wiki_id, page)
            if not versions:
                result = {"ok": False, "error": f"{page} 没有历史版本，无法对比"}
            else:
                ts = version_ts or versions[-1].get("ts") or ""
                old = await asyncio.to_thread(_read_page_version, wiki_id, page, ts)
                if not old:
                    result = {"ok": False, "error": f"读取历史版本 {ts} 失败"}
                else:
                    user_content = (f"【旧版本（{ts}）】\n{old}\n\n"
                                    f"【当前版本】\n{current}")
                    text = await _llm_analyze(bridge, WIKI_COMPARE_SYSTEM_PROMPT,
                                              user_content, max_tokens=4096)
                    report = _parse_json_response(text)
                    result = {"ok": True, "report": report, "base_version": ts,
                              "versions_available": len(versions)}
                    bridge.emit("pipeline_event", {"type": "product",
                                                   "product_type": "compare_report",
                                                   "data": report})
    except Exception as e:
        logger.error("wiki_compare_versions 失败: %s", e, exc_info=True)
        result = {"ok": False, "error": str(e)[:300]}
    bridge.emit("tool_result", {"tool": "wiki_compare_versions", "ok": result.get("ok", False),
                                "result": bridge._truncate(result, 500), "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="wiki_topic_merge",
    description="将多个主题页合并为一个（用户指定页面名，逗号分隔），重写 SCHEMA 中对应声明；旧页面文件保留不删，避免数据丢失。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
            "topics": {"type": "string", "description": "要合并的页面名，逗号分隔（如 'A,B'）"},
            "new_title": {"type": "string", "description": "合并后的页面标题（可选，由模型决定）"},
        },
        "required": ["wiki_id", "topics"],
    },
    auto_extract=False,
)
async def wiki_topic_merge(wiki_id: str, topics: str, new_title: str = "") -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "wiki_topic_merge", "args": {"wiki_id": wiki_id}})
    t0 = time.time()
    try:
        schema = await asyncio.to_thread(_read_wiki_page, wiki_id, "SCHEMA.md")
        if not schema:
            result = {"ok": False, "error": "未找到 SCHEMA.md"}
        else:
            topic_list = [t.strip() for t in (topics or "").split(",") if t.strip()]
            if len(topic_list) < 2:
                result = {"ok": False, "error": "至少需要 2 个页面才能合并"}
            else:
                declared = _parse_schema_to_toc(schema).get("topic_count", 0)
                # 合并 N→1，预期主题数减少 N-1；下限即预期值，低于它说明输出被截断
                min_topics = max(1, declared - (len(topic_list) - 1))
                user_content = (f"当前 SCHEMA:\n{schema}\n\n"
                                f"要合并的页面: {', '.join(topic_list)}\n"
                                f"合并后标题: {new_title or '（由你决定最具概括性的标题）'}")
                text = await _llm_analyze(bridge, WIKI_TOPIC_MERGE_SYSTEM_PROMPT,
                                          user_content, max_tokens=8192)
                allowed, reason, new_count = _schema_write_guard(schema, text, min_topics)
                if allowed:
                    await _save_wiki_page(wiki_id, "SCHEMA.md", text)
                    result = {"ok": True, "merged": topic_list, "topics_before": declared,
                              "topics_after": new_count, "note": "旧页面文件保留未删"}
                    result["content"] = (
                        f"### 主题合并完成\n\n"
                        f"- 合并页面：{'、'.join(topic_list)}\n"
                        f"- 合并后标题：{new_title or '（由模型决定）'}\n"
                        f"- SCHEMA 主题数：**{declared} → {new_count}**\n\n"
                        f"> 旧页面文件保留未删（避免数据丢失），确认无误后可手动删除。\n"
                    )
                    bridge.emit("pipeline_event", {"type": "product",
                                                   "product_type": "merge_result", "data": result})
                else:
                    result = {"ok": True, "merged": [], "topics_before": declared,
                              "topics_after": new_count, "reason": reason, "raw": text[:300]}
    except Exception as e:
        logger.error("wiki_topic_merge 失败: %s", e, exc_info=True)
        result = {"ok": False, "error": str(e)[:300]}
    bridge.emit("tool_result", {"tool": "wiki_topic_merge", "ok": result.get("ok", False),
                                "result": bridge._truncate(result, 500), "durationMs": int((time.time() - t0) * 1000)})
    return result


@tool(
    name="wiki_topic_split",
    description="将一个主题页拆分为多个子页面（可给出建议子主题），重写 SCHEMA 中对应声明；原页面文件保留不删。",
    input_params={
        "type": "object",
        "properties": {
            "wiki_id": {"type": "string", "description": "Wiki 库 ID"},
            "topic": {"type": "string", "description": "要拆分的页面名"},
            "sub_topics": {"type": "string", "description": "建议的子主题名，逗号分隔（可选）"},
        },
        "required": ["wiki_id", "topic"],
    },
    auto_extract=False,
)
async def wiki_topic_split(wiki_id: str, topic: str, sub_topics: str = "") -> dict[str, Any]:
    bridge = get_bridge()
    bridge.emit("tool_call", {"tool": "wiki_topic_split", "args": {"wiki_id": wiki_id}})
    t0 = time.time()
    try:
        schema = await asyncio.to_thread(_read_wiki_page, wiki_id, "SCHEMA.md")
        if not schema:
            result = {"ok": False, "error": "未找到 SCHEMA.md"}
        else:
            declared = _parse_schema_to_toc(schema).get("topic_count", 0)
            page_content = await asyncio.to_thread(_read_wiki_page, wiki_id, topic) or ""
            # 拆分 1→N（N≥2），主题数应净增至少 1；用 declared+1 做下限防截断
            min_topics = declared + 1
            user_content = (f"当前 SCHEMA:\n{schema}\n\n"
                            f"要拆分的页面: {topic}\n"
                            f"页面正文（前 2000 字）:\n{page_content[:2000]}\n\n"
                            f"建议子主题: {sub_topics or '（由你根据内容边界决定）'}")
            text = await _llm_analyze(bridge, WIKI_TOPIC_SPLIT_SYSTEM_PROMPT,
                                      user_content, max_tokens=8192)
            allowed, reason, new_count = _schema_write_guard(schema, text, min_topics)
            if allowed:
                await _save_wiki_page(wiki_id, "SCHEMA.md", text)
                result = {"ok": True, "split": topic, "topics_before": declared,
                          "topics_after": new_count, "note": "原页面文件保留未删"}
                result["content"] = (
                    f"### 主题拆分完成\n\n"
                    f"- 拆分页面：**{topic}**\n"
                    f"- 建议子主题：{sub_topics or '（由模型按内容边界决定）'}\n"
                    f"- SCHEMA 主题数：**{declared} → {new_count}**\n\n"
                    f"> 原页面文件保留未删；新子页面正文尚未生成，可用增量更新补齐。\n"
                )
                bridge.emit("pipeline_event", {"type": "product",
                                               "product_type": "split_result", "data": result})
            else:
                result = {"ok": True, "split": None, "topics_before": declared,
                          "topics_after": new_count, "reason": reason, "raw": text[:300]}
    except Exception as e:
        logger.error("wiki_topic_split 失败: %s", e, exc_info=True)
        result = {"ok": False, "error": str(e)[:300]}
    bridge.emit("tool_result", {"tool": "wiki_topic_split", "ok": result.get("ok", False),
                                "result": bridge._truncate(result, 500), "durationMs": int((time.time() - t0) * 1000)})
    return result


WIKI_TOOLS = [
    list_wiki_pages,
    read_wiki_page,
    save_wiki_page,
    search_wiki,
    parse_schema,
    validate_wiki_structure,
    build_doc_graph_tool,
    record_build_history,
    export_wiki,
    run_wiki_build,
    run_wiki_update,
    wiki_suggest,
    wiki_depth_check,
    wiki_dedup,
    wiki_orphan_check,
    wiki_link_check,
    wiki_cross_ref_fix,
    wiki_tag_optimize,
    wiki_quality_score,
    wiki_summarize,
    wiki_generate_qa,
    wiki_compare_versions,
    wiki_topic_merge,
    wiki_topic_split,
]
