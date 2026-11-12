"""wiki-build-agent — FastAPI 入口。

Phase 2 分发策略（前端仍用旧端点，本服务先并行跑通再切换）：
- build_wiki / update_wiki（重流水线）：直接走 pipeline（确定性、已验证），LLM 经 openjiuwen Model；
- 其余意图 + chat：DeepAgent（task_loop 自主编排，工具经 WikiBridge 上抛事件）；
- SSE 契约与 ontomind-agent wiki_chat 完全一致（8 类事件），前端切换仅需改 base URL。

流式要点：pipeline / guidance 是普通协程，事件经 EventBuffer 缓冲；
SSE 生成器用后台任务 + 轮询排空泵（_run_with_drain）实现边生成边推送，
这是 async 生成器内无法直接 await 任意回调时的标准做法（corporate-marketing 同思路）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Awaitable, Coroutine, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict

from openjiuwen.harness.deep_agent import Session

from .agent_factory import create_agent
from .config import llm_config, server_config
from .export import export_wiki_html, export_wiki_markdown
from .intent import detect_pipeline_intent
from .llm import WikiLLM
from .pipeline import build_wiki, extract_requirements_from_message, guidance_reply, update_wiki
from .profiles import (
    DOCUMENT_REVIEW_PROFILE_ID,
    GENERIC_PROFILE_ID,
    list_build_profiles,
    load_stored_build_profile,
    resolve_build_profile,
    save_stored_build_profile,
    strip_build_profile_mentions,
)
from .schema_parser import (
    _build_doc_graph,
    _normalize_page_name,
    _pages_to_toc,
    _parse_schema_to_toc,
    _supplement_toc_with_full_structure,
)
from .server_client import get_server_client
from .sse_bridge import EventBuffer, ToolEventTranslator, bridge_event_to_sse_payload, sse_encode, sse_heartbeat
from .storage import (
    _delete_wiki_page,
    _diff_page_version,
    _get_wiki_lock,
    _list_page_versions,
    _list_wiki_pages,
    _load_raw_documents,
    _load_wiki_build_requirements,
    _load_wiki_library_meta,
    _read_page_version,
    _read_wiki_page,
    _record_build_history,
    _save_wiki_build_requirements,
    _save_wiki_page,
    _validate_wiki_id,
    _wiki_project_dir,
)
from .wiki_tools import WikiBridge, set_bridge

logger = logging.getLogger("wiki-build-agent")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

# 全局单例（agent 无会话状态，Session 每请求绑定）
_agent = None
_card = None

llm = WikiLLM()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _agent, _card
    logger.info("wiki-build-agent 启动 | model=%s api_base=%s", llm_config.model, llm_config.api_base)
    _agent, _bridge = create_agent()
    _card = getattr(_agent, "card", None)
    yield
    await get_server_client().close()


app = FastAPI(lifespan=lifespan, title="Wiki Build Agent", version="1.0.0")

_origins = server_config.cors_origins.split(",") if server_config.cors_origins != "*" else ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?" if "*" in _origins else None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "model": llm_config.model, "service": "wiki-build-agent"}


# ─── 请求模型（与旧 WikiChatRequest 字段一致） ──────────────

class WikiChatRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    message: str
    wiki_id: Optional[str] = None
    file_ids: Optional[list[str]] = None
    documents: Optional[list[dict]] = None
    session_id: Optional[str] = None
    model_id: Optional[str] = None
    trace_level: str = "normal"
    build_requirements: Optional[str] = None
    build_profile: Optional[str] = None
    skip_requirements_extract: bool = False


def _validate_wiki_id_or_400(wiki_id: str) -> None:
    try:
        _validate_wiki_id(wiki_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _trace_event_simple(event_type: str, name: str, status: str = "success", **extra) -> dict:
    event = {
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "name": name,
        "status": status,
        "timestamp": time.time() * 1000,
    }
    event.update(extra)
    return event


# ─── 模型路由（公文审核治理：避开 reasoning 模型） ──────────

def _model_capabilities(model_config: dict) -> set[str]:
    raw = model_config.get("capabilities") or ""
    values = raw if isinstance(raw, list) else str(raw).split(",")
    return {str(value).strip().casefold() for value in values if str(value).strip()}


def select_profile_model_id(profile_id: str, requested_model_id: str, models: list[dict]) -> str:
    if profile_id != DOCUMENT_REVIEW_PROFILE_ID:
        return requested_model_id
    requested = next(
        (item for item in models
         if (item.get("modelId") or item.get("model_id")) == requested_model_id),
        None,
    )
    if not requested or "reasoning" not in _model_capabilities(requested):
        return requested_model_id
    compatible = [
        item for item in models
        if "extraction" in _model_capabilities(item)
        and "reasoning" not in _model_capabilities(item)
        and (item.get("modelId") or item.get("model_id"))
    ]
    if not compatible:
        return requested_model_id
    compatible.sort(
        key=lambda item: (
            "flash" not in str(item.get("modelId") or item.get("model_id")).casefold(),
            "chat" not in _model_capabilities(item),
        )
    )
    return str(compatible[0].get("modelId") or compatible[0].get("model_id"))


async def _resolve_model(model_id: Optional[str], profile_id: str) -> tuple[Optional[str], Optional[dict]]:
    """model_id 形如 provider::model 时向 ontomind-server 解析；否则用服务默认模型。"""
    if not (model_id and "::" in model_id):
        return None, None
    provider_id, mid = model_id.split("::", 1)
    try:
        client = get_server_client()
        provider = await client.get_model_provider(provider_id)
        models = provider.get("models") or await client.list_model_configs(provider_id)
        routed_mid = select_profile_model_id(profile_id, mid, models)
        route = None
        if routed_mid != mid:
            route = {
                "requested_model": mid,
                "effective_model": routed_mid,
                "reason": "公文审核结构化生成自动避开 reasoning 模型",
            }
        return routed_mid, route
    except Exception as e:
        logger.warning("模型解析失败，回退服务默认模型: %s", e)
        return None, None


def _extract_chunk_text(payload: Any) -> str:
    if payload is None:
        return ""
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        for key in ("content", "text", "output", "answer"):
            value = payload.get(key)
            if isinstance(value, str) and value:
                return value
        return ""
    return str(getattr(payload, "content", "") or "")


# ─── 主端点：SSE 对话流 ─────────────────────────────────────

@app.post("/chat/stream")
async def chat_stream(request: Request) -> StreamingResponse:
    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"请求体必须是合法 JSON: {e}") from e
    req = WikiChatRequest(**body)
    if req.wiki_id:
        _validate_wiki_id_or_400(req.wiki_id)

    stored_profile_id = (
        load_stored_build_profile(_wiki_project_dir(req.wiki_id)) if req.wiki_id else None
    )
    try:
        active_profile_id = resolve_build_profile(
            req.build_profile, req.message, stored_profile=stored_profile_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    effective_message = strip_build_profile_mentions(req.message) or req.message

    model, model_route = await _resolve_model(req.model_id, active_profile_id)
    session_id = req.session_id or str(uuid.uuid4())
    current_wiki_id = req.wiki_id

    async def generate():
        nonlocal current_wiki_id
        wiki_lock = _get_wiki_lock(req.wiki_id) if req.wiki_id else None
        locked = False
        # 每请求独立 bridge + contextvar 注入：并发请求的工具事件不再互相串流
        bridge = WikiBridge()
        bridge.wiki_id = req.wiki_id or ""
        bridge.model = model or llm_config.model
        bridge.llm = llm
        buffer = EventBuffer()
        translator = ToolEventTranslator()
        bridge.set_event_emitter(buffer.emitter)
        set_bridge(bridge)
        intent = "chat"
        pump_task: Optional[asyncio.Task] = None
        # 收尾记账：done 正常发出=terminal_sent；异常路径已写失败历史=history_recorded；
        # 都不是（断连/取消）时 finally 兜底把构建历史记为失败，避免遗留 running
        terminal_sent = False
        history_recorded = False

        async def drain_bridge():
            for evt_type, evt_data in buffer.drain():
                payload = bridge_event_to_sse_payload(evt_type, evt_data, translator)
                if payload is not None:
                    yield sse_encode(payload)

        async def _run_with_drain(coro: Coroutine) -> None:
            """后台运行 pipeline/guidance 协程，边跑边排空事件缓冲（SSE 流式泵）。

            客户端断开（GeneratorExit）时取消后台任务；协程异常在排空后重抛。
            """
            nonlocal pump_task
            task = asyncio.create_task(coro)
            pump_task = task
            last_hb = time.time()
            try:
                while True:
                    async for sse in drain_bridge():
                        yield sse
                        last_hb = time.time()
                    if task.done():
                        break
                    if time.time() - last_hb > 15:
                        yield sse_heartbeat()
                        last_hb = time.time()
                    await asyncio.sleep(0.1)
                await task  # 重抛协程异常，交外层统一兜底
                # task 结束前最后一个事件循环片里可能又入了缓冲（yield 让出期间），补排一次
                async for sse in drain_bridge():
                    yield sse
            finally:
                if not task.done():
                    task.cancel()
                pump_task = None

        async def pipe_emit(payload: dict) -> None:
            """pipeline 事件 → bridge 缓冲（pipeline_event 原样透传）。"""
            buffer.emitter("pipeline_event", payload)

        try:
            if wiki_lock:
                warned_queued = False
                while True:
                    try:
                        await asyncio.wait_for(wiki_lock.acquire(), timeout=15)
                        locked = True
                        break
                    except asyncio.TimeoutError:
                        # 等锁期间定期发心跳/提示，避免代理层判定连接空闲掐断
                        if not warned_queued:
                            yield sse_encode({"type": "warning", "message": "该 Wiki 库正在执行其他任务，已排队等待..."})
                            warned_queued = True
                        else:
                            yield sse_heartbeat()

            yield sse_encode({"type": "trace", "event": _trace_event_simple(
                "trace_orchestrate_step", f"构建配置: {active_profile_id}",
                data={"build_profile": active_profile_id},
            )})
            if model_route:
                yield sse_encode({"type": "trace", "event": _trace_event_simple(
                    "trace_orchestrate_step",
                    f"模型路由: {model_route['requested_model']} → {model_route['effective_model']}",
                    data=model_route,
                )})

            # 获取文档内容
            file_content = ""
            filename = "对话输入"
            if req.documents:
                for d in req.documents:
                    content = (d.get("content") or "").strip()
                    if content:
                        file_content += content + "\n\n"
                        filename = d.get("filename") or filename
            elif req.file_ids:
                server_client = get_server_client()
                for fid in req.file_ids:
                    try:
                        content, fname = await server_client.get_file_markdown(fid)
                        if content:
                            file_content += content + "\n\n"
                            filename = fname or filename
                    except Exception as e:
                        logger.warning(f"获取文档 {fid} 失败: {e}")

            # has_docs 只反映本次上传的新文档（旧实现语义）：
            # 意图判断与 requirements 拦截不因 raw 层续建内容而改变
            has_docs = bool(file_content and file_content.strip())
            has_wiki_id = bool(req.wiki_id)

            # 失败续建：无新文档但 raw 层已有源文档时复用
            resume_from_raw = False
            if not has_docs and req.wiki_id:
                resumed_docs = await _load_raw_documents(req.wiki_id)
                if resumed_docs:
                    file_content = "\n\n".join(
                        f"<!-- raw: {name} -->\n{content}" for name, content in resumed_docs
                    )
                    filename = "raw层已有源文档.md"
                    resume_from_raw = True
                    yield sse_encode({"type": "thinking", "content": f"未检测到新文档，已从库内 raw 层读取 {len(resumed_docs)} 份已有源文档，将继续构建。"})

            # 意图：仅识别重流水线（build/update）；其余交给 Agent 的 task_loop 自主路由
            intent = detect_pipeline_intent(effective_message, has_docs, has_wiki_id)
            yield sse_encode({"type": "trace", "event": _trace_event_simple(
                "trace_orchestrate_step", f"意图: {intent or 'agent'}",
                data={"intent": intent or "agent", "has_docs": has_docs, "has_wiki_id": has_wiki_id},
            )})

            # 构建要求拦截：仅本次上传了新文档时抽取（raw 续建不重复弹窗，要求已持久化在库内）
            if (
                intent in ("build_wiki", "update_wiki")
                and has_docs
                and not req.skip_requirements_extract
            ):
                extracted_reqs = await extract_requirements_from_message(effective_message, llm, model)
                existing_reqs = _load_wiki_build_requirements(req.wiki_id or current_wiki_id)
                if extracted_reqs and extracted_reqs != existing_reqs:
                    yield sse_encode({"type": "requirements_confirm", "requirements": extracted_reqs, "is_new": not req.wiki_id})
                    terminal_sent = True
                    yield sse_encode({"type": "done", "wiki_id": current_wiki_id or "", "session_id": session_id, "reason": "requirements_confirm"})
                    return

            # 分发：重流水线直接执行；其余交给 DeepAgent
            if intent in ("build_wiki", "update_wiki"):
                scenario = "build" if intent == "build_wiki" else "update"
                if intent == "update_wiki" and not req.wiki_id:
                    yield sse_encode({"type": "error", "message": "增量更新需要指定已有 Wiki 库。"})
                elif not file_content:
                    yield sse_encode({"type": "trace", "event": _trace_event_simple(
                        "trace_orchestrate_step", "未检测到文档内容，进入对话引导",
                    )})
                    async for sse in _run_with_drain(
                        guidance_reply(req.message, scenario, has_wiki_id, llm, model, pipe_emit)
                    ):
                        yield sse
                else:
                    if not current_wiki_id:
                        current_wiki_id = f"wiki_{int(time.time())}_{str(uuid.uuid4())[:8]}"
                        yield sse_encode({"type": "trace", "event": _trace_event_simple(
                            "trace_progress", f"创建新 Wiki 库: {current_wiki_id[:16]}",
                            data={"wiki_id": current_wiki_id},
                        )})
                        if (req.build_requirements or "").strip():
                            _save_wiki_build_requirements(current_wiki_id, req.build_requirements)
                            yield sse_encode({"type": "trace", "event": _trace_event_simple(
                                "trace_progress", "保存库级构建要求",
                                data={"length": len(req.build_requirements.strip())},
                            )})
                    save_stored_build_profile(_wiki_project_dir(current_wiki_id), active_profile_id)

                    if intent == "build_wiki":
                        coro: Coroutine = build_wiki(
                            effective_message, file_content, filename,
                            llm, model, current_wiki_id, pipe_emit,
                            resume_from_raw=resume_from_raw,
                            build_profile_id=active_profile_id,
                        )
                    else:
                        coro = update_wiki(
                            effective_message, file_content, filename,
                            llm, model, current_wiki_id, pipe_emit,
                            resume_from_raw=resume_from_raw,
                            build_profile_id=active_profile_id,
                        )
                    async for sse in _run_with_drain(coro):
                        yield sse
            else:
                # DeepAgent 处理其余意图（含 chat）：task_loop 自主编排 + 工具事件桥
                session = Session(session_id=session_id, card=_card)
                query = (
                    f"[上下文] wiki_id={req.wiki_id or '未指定'}；"
                    f"构建配置={active_profile_id}；用户消息如下。\n"
                    f"[user] {effective_message}"
                )
                deadline = time.time() + server_config.stream_deadline
                last_hb = time.time()
                answer_parts: list[str] = []
                final_answer: Optional[str] = None

                from .agent_factory import _report_skill_usage, _workspace_skill_names
                _report_skill_usage(_workspace_skill_names(), "wiki-build")
                agent_stream = _agent.stream({"query": query}, session=session)
                try:
                    async for chunk in agent_stream:
                        if time.time() > deadline:
                            yield sse_encode({"type": "error", "message": f"Agent 执行超时（{int(server_config.stream_deadline)}秒）"})
                            break
                        if time.time() - last_hb > 15:
                            yield sse_heartbeat()
                            last_hb = time.time()
                        async for sse in drain_bridge():
                            yield sse

                        chunk_type = getattr(chunk, "type", None)
                        payload = getattr(chunk, "payload", None)
                        if chunk_type == "llm_output":
                            text = _extract_chunk_text(payload)
                            if text:
                                answer_parts.append(text)
                                yield sse_encode({"type": "content", "content": text})
                        elif chunk_type == "answer":
                            final_answer = _extract_chunk_text(payload) or final_answer
                finally:
                    # 超时 break / 客户端断开时显式关闭 SDK 流，避免后台生成器悬挂
                    await agent_stream.aclose()

                async for sse in drain_bridge():
                    yield sse
                if not answer_parts and final_answer:
                    yield sse_encode({"type": "content", "content": final_answer})

            terminal_sent = True
            yield sse_encode({"type": "done", "wiki_id": current_wiki_id or "", "session_id": session_id})

        except Exception as e:
            logger.error("Wiki chat stream 异常: %s", e, exc_info=True)
            if pump_task and not pump_task.done():
                pump_task.cancel()
            if intent in ("build_wiki", "update_wiki") and current_wiki_id:
                await _record_build_history(
                    current_wiki_id, f"bh_fail_{int(time.time() * 1000)}",
                    type="build" if intent == "build_wiki" else "update",
                    status="failed",
                    finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
                    error=str(e)[:500], model=model or "",
                )
                history_recorded = True
            yield sse_encode({"type": "error", "message": str(e)})
            yield sse_encode({"type": "done", "wiki_id": current_wiki_id or "", "session_id": session_id})
        finally:
            if (intent in ("build_wiki", "update_wiki") and current_wiki_id
                    and not terminal_sent and not history_recorded):
                # 断连/取消等未走到 error 兜底的路径：把构建历史记为失败并收敛遗留 running
                try:
                    await _record_build_history(
                        current_wiki_id, f"bh_fail_{int(time.time() * 1000)}",
                        type="build" if intent == "build_wiki" else "update",
                        status="failed",
                        finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
                        error="连接中断或生成被取消",
                        model=model or "",
                    )
                except Exception:
                    pass
            buffer.drain()  # 清空，不再上抛（连接已结束）
            if locked and wiki_lock:
                wiki_lock.release()

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


# ─── 只读辅助端点（与旧 /wiki/toc /wiki/doc /wiki/graph /wiki/build-profiles 一致） ──

@app.get("/build-profiles")
async def get_build_profiles(wiki_id: Optional[str] = None):
    try:
        active_profile = GENERIC_PROFILE_ID
        if wiki_id:
            _validate_wiki_id_or_400(wiki_id)
            active_profile = (
                load_stored_build_profile(_wiki_project_dir(wiki_id))
                or GENERIC_PROFILE_ID
            )
        return {"profiles": list_build_profiles(), "active_profile": active_profile}
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


async def _load_wiki_schema(wiki_id: str) -> tuple[str, Optional[dict]]:
    for name in ("SCHEMA.md", "_schema.md", "schema.md", "_Schema.md"):
        content = await asyncio.to_thread(_read_wiki_page, wiki_id, name)
        if content:
            return content, _parse_schema_to_toc(content)
    return "", None


@app.get("/toc")
async def get_wiki_toc(wiki_id: str):
    _validate_wiki_id_or_400(wiki_id)
    try:
        schema_content, toc_data = await _load_wiki_schema(wiki_id)
        if schema_content and toc_data and toc_data.get("tree"):
            return await asyncio.to_thread(_supplement_toc_with_full_structure, toc_data, wiki_id)

        schema_files = {"_schema.md", "SCHEMA.md", "schema.md", "_Schema.md", "index.md", "log.md"}
        pages = [p for p in await asyncio.to_thread(_list_wiki_pages, wiki_id)
                 if p.endswith(".md")
                 and not p.startswith("_reports/")
                 and not p.split("/")[-1].startswith("_")
                 and p.split("/")[-1] not in schema_files]
        if not pages:
            raise HTTPException(status_code=404, detail="Wiki 库中没有页面")
        toc = _pages_to_toc(pages)
        return await asyncio.to_thread(_supplement_toc_with_full_structure, toc, wiki_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/doc/{page:path}")
async def get_wiki_doc(page: str, wiki_id: str):
    _validate_wiki_id_or_400(wiki_id)
    try:
        content = await asyncio.to_thread(_read_wiki_page, wiki_id, page)
        if not content:
            title = _normalize_page_name(page)
            placeholder = (
                f"# {title}\n\n"
                f"> 该页面的正文尚未生成。\n\n"
                f"在对话中输入「批量补全」或「补全页面正文」，即可自动为缺失页面生成正文。"
            )
            return {"page": page, "title": title, "content": placeholder, "headings": []}
        title = page
        title_match = re.search(r'^#\s+(.+)$', content, re.MULTILINE)
        if title_match:
            title = title_match.group(1).strip()
        headings = []
        for m in re.finditer(r'^(#{1,6})\s+(.+)$', content, re.MULTILINE):
            level = len(m.group(1))
            text = m.group(2).strip()
            slug = re.sub(r'[^\w一-鿿]+', '-', text.lower()).strip('-')
            headings.append({"level": level, "text": text, "slug": slug})
        return {"page": page, "title": title, "content": content, "headings": headings}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/graph")
async def get_wiki_graph(wiki_id: str, cached: bool = False, refresh: bool = False):
    """cached=True 时只读缓存：无有效缓存返回 404（不触发重建），供前端轮询/首屏轻量加载。"""
    _validate_wiki_id_or_400(wiki_id)
    try:
        if not refresh:
            cache_text = await asyncio.to_thread(_read_wiki_page, wiki_id, "_wiki_graph.json")
            if cache_text:
                try:
                    data = json.loads(cache_text)
                    if isinstance(data, dict) and data.get("nodes") and \
                            (data.get("stats") or {}).get("graph_type") == "document_v3":
                        return data
                except Exception:
                    pass
            if cached:
                raise HTTPException(status_code=404, detail="图谱尚未构建")
        result = await asyncio.to_thread(_build_doc_graph, wiki_id)
        try:
            await _save_wiki_page(wiki_id, "_wiki_graph.json", json.dumps(result, ensure_ascii=False))
        except Exception as e:
            logger.warning(f"缓存 Wiki 文档图谱失败: {e}")
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── 页面级写操作（人工微调：AI 构建后的编辑/删除/新建） ───────

class PageWriteBody(BaseModel):
    content: str = ""
    title: Optional[str] = None


async def _refresh_graph_silently(wiki_id: str) -> None:
    """页面写操作后异步刷新文档关系图（失败仅记日志，不影响写操作结果）。"""
    try:
        graph_result = await asyncio.to_thread(_build_doc_graph, wiki_id)
        await _save_wiki_page(wiki_id, "_wiki_graph.json", json.dumps(graph_result, ensure_ascii=False))
    except Exception as e:
        logger.warning(f"页面写操作后刷新图谱失败: {e}")


async def _with_wiki_lock(wiki_id: str, coro_factory):
    """页面写操作串行化：同库写互斥，避免并发编辑互相覆盖。"""
    lock = _get_wiki_lock(wiki_id)
    async with lock:
        return await coro_factory()


@app.put("/doc/{page:path}")
async def put_wiki_doc(page: str, wiki_id: str, body: PageWriteBody):
    """更新/新建页面正文。写入自动快照历史版本（_history/），并刷新文档关系图。"""
    _validate_wiki_id_or_400(wiki_id)
    content = body.content or ""
    if not content.strip():
        raise HTTPException(status_code=400, detail="页面内容不能为空")
    if not page.lower().endswith(".md"):
        page = page + ".md"

    async def _write():
        existed = bool(await asyncio.to_thread(_read_wiki_page, wiki_id, page))
        try:
            await _save_wiki_page(wiki_id, page, content)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        await _refresh_graph_silently(wiki_id)
        return {
            "page": page, "wiki_id": wiki_id, "created": not existed,
            "chars": len(content), "history_snapshotted": existed,
        }

    try:
        return await _with_wiki_lock(wiki_id, _write)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"更新页面失败 {wiki_id}/{page}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/doc/{page:path}")
async def delete_wiki_doc(page: str, wiki_id: str):
    """删除页面（删除前自动快照到 _history/ 作软保险），并刷新文档关系图。"""
    _validate_wiki_id_or_400(wiki_id)
    if page in ("SCHEMA.md", "index.md", "log.md", "_wiki_graph.json"):
        raise HTTPException(status_code=400, detail=f"{page} 是库结构文件，不能通过页面接口删除")

    async def _delete():
        if not page.lower().endswith(".md"):
            page_md = page + ".md"
        else:
            page_md = page
        existing = await asyncio.to_thread(_read_wiki_page, wiki_id, page_md)
        if not existing:
            raise HTTPException(status_code=404, detail=f"页面不存在: {page}")
        # 删除前快照（软保险：误删可从 _history/ 找回）
        try:
            project_dir = _wiki_project_dir(wiki_id)
            from .storage import _wiki_page_path, _snapshot_page_history
            _snapshot_page_history(project_dir, _wiki_page_path(wiki_id, page_md))
        except Exception as e:
            logger.warning(f"删除前快照失败（继续删除）: {e}")
        ok = await _delete_wiki_page(wiki_id, page_md)
        if not ok:
            raise HTTPException(status_code=500, detail="页面删除失败")
        await _refresh_graph_silently(wiki_id)
        return {"page": page_md, "wiki_id": wiki_id, "deleted": True}

    try:
        return await _with_wiki_lock(wiki_id, _delete)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"删除页面失败 {wiki_id}/{page}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/doc/rename")
async def rename_wiki_doc(wiki_id: str, from_page: str, to_page: str):
    """重命名/移动页面（复制内容到新路径 + 删除旧路径；历史随内容迁移到新页面名下）。"""
    _validate_wiki_id_or_400(wiki_id)
    if not from_page.lower().endswith(".md"):
        from_page += ".md"
    if not to_page.lower().endswith(".md"):
        to_page += ".md"
    if from_page == to_page:
        raise HTTPException(status_code=400, detail="新旧页面名相同")

    async def _rename():
        content = await asyncio.to_thread(_read_wiki_page, wiki_id, from_page)
        if not content:
            raise HTTPException(status_code=404, detail=f"页面不存在: {from_page}")
        if await asyncio.to_thread(_read_wiki_page, wiki_id, to_page):
            raise HTTPException(status_code=409, detail=f"目标页面已存在: {to_page}")
        try:
            await _save_wiki_page(wiki_id, to_page, content)
            await _delete_wiki_page(wiki_id, from_page)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        await _refresh_graph_silently(wiki_id)
        return {"from": from_page, "to": to_page, "wiki_id": wiki_id, "renamed": True}

    try:
        return await _with_wiki_lock(wiki_id, _rename)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"重命名页面失败 {wiki_id}/{from_page}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/doc/{page:path}/rollback")
async def rollback_wiki_doc(page: str, wiki_id: str, ts: str):
    """回滚页面到指定历史版本（当前版本会先快照，回滚本身可再撤销）。"""
    _validate_wiki_id_or_400(wiki_id)
    old_content = await asyncio.to_thread(_read_page_version, wiki_id, page, ts)
    if not old_content:
        raise HTTPException(status_code=404, detail=f"历史版本不存在: {page}@{ts}")

    async def _rollback():
        try:
            await _save_wiki_page(wiki_id, page, old_content)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        await _refresh_graph_silently(wiki_id)
        return {"page": page, "wiki_id": wiki_id, "rolled_back_to": ts, "chars": len(old_content)}

    try:
        return await _with_wiki_lock(wiki_id, _rollback)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"回滚页面失败 {wiki_id}/{page}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ─── 页面版本历史 / 导出（路线图 P4 / P6） ─────────────────

@app.get("/history")
async def get_page_history(wiki_id: str, page: str):
    _validate_wiki_id_or_400(wiki_id)
    versions = await asyncio.to_thread(_list_page_versions, wiki_id, page)
    return {"wiki_id": wiki_id, "page": page, "versions": versions}


@app.get("/history/content")
async def get_page_history_content(wiki_id: str, page: str, ts: str):
    _validate_wiki_id_or_400(wiki_id)
    content = await asyncio.to_thread(_read_page_version, wiki_id, page, ts)
    if not content:
        raise HTTPException(status_code=404, detail="历史版本不存在")
    return {"wiki_id": wiki_id, "page": page, "ts": ts, "content": content}


@app.get("/history/diff")
async def get_page_history_diff(wiki_id: str, page: str, ts: str):
    _validate_wiki_id_or_400(wiki_id)
    if not await asyncio.to_thread(_read_page_version, wiki_id, page, ts):
        raise HTTPException(status_code=404, detail="历史版本不存在")
    diff = await asyncio.to_thread(_diff_page_version, wiki_id, page, ts)
    return {"wiki_id": wiki_id, "page": page, "ts": ts, "diff": diff}


@app.get("/export")
async def export_wiki_file(wiki_id: str, format: str = "html", download: bool = True):
    """整库导出：format=html|md。download=true 时作为附件下载。"""
    _validate_wiki_id_or_400(wiki_id)
    fmt = format if format in ("html", "md") else "html"
    title = _load_wiki_library_meta(wiki_id).get("name") or wiki_id
    if fmt == "html":
        content = await asyncio.to_thread(export_wiki_html, wiki_id, title)
        media, ext = "text/html; charset=utf-8", "html"
    else:
        content = await asyncio.to_thread(export_wiki_markdown, wiki_id, title)
        media, ext = "text/markdown; charset=utf-8", "md"
    headers = {}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="wiki-export.{ext}"'
    return Response(content=content, media_type=media, headers=headers)


def main():
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=server_config.host,
        port=server_config.port,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
