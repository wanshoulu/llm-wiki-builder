"""结构化生成流水线 — build / update / 逐页正文生成（自 wiki_chat.py 移植并 openjiuwen 化）。

与旧实现的差异：
- LLM 调用全部经由 openjiuwen Model（app.llm.WikiLLM），获得真实超时/重试；
- 事件不再 yield SSE 字符串，而是通过 emit(payload) 回调上抛（主端点与 Agent 工具共用）；
- 截断检测使用 chat_stream(meta=...) 的显式 truncated 标记，替代旧网关的可变 _truncated 侦探读取。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from typing import Awaitable, Callable, Optional

from .guard import (
    DOCUMENT_REVIEW_TOPIC_TIMEOUT_SECONDS,
    WikiStructuredGenerationError,
    check_generic_schema_completeness,
    document_review_structured_timeout_error,
    validate_document_review_index,
    validate_document_review_schema,
    validate_document_review_topic_body,
)
from .llm import WikiLLM
from .profiles import (
    DOCUMENT_REVIEW_PROFILE_ID,
    GENERIC_PROFILE_ID,
    WikiBuildProfile,
    build_topic_user_message,
    get_build_profile,
)
from .schema_parser import (
    _build_doc_graph,
    _extract_topic_body,
    _parse_schema_to_toc,
    _schema_looks_truncated,
    _strip_reasoning_from_markdown,
    _title_to_page_name,
    _extract_schema_title,
)
from .storage import (
    _apply_build_requirements,
    _append_wiki_log,
    _backup_schema_versioned,
    _load_wiki_build_requirements,
    _load_raw_documents,
    _read_wiki_page,
    _record_build_history,
    _save_wiki_library_meta,
    _save_wiki_page,
    _upgrade_wiki_library_meta,
    _default_library_name,
)

logger = logging.getLogger("wiki-build-agent.pipeline")

# 事件回调：payload 即旧 SSE data dict（{"type": "trace", "event": {...}} 等）
Emitter = Callable[[dict], Awaitable[None]]


def _raw_page_name(filename: str) -> str:
    """raw 层文件名：统一 .md 后缀，不叠加（filename 已带 .md 时不再追加）。"""
    stem = (filename or "source").strip().removesuffix(".md").removesuffix(".markdown").strip()
    return f"raw/{stem or 'source'}.md"


async def _no_emit(payload: dict) -> None:
    pass


class TraceIds:
    """同一步骤 running→success/failed 复用同一 event_id，前端据此原位更新。"""

    def __init__(self) -> None:
        self.running: dict[str, str] = {}

    def event(self, event_type: str, name: str, status: str = "running", **extra) -> dict:
        if status == "running":
            event_id = str(uuid.uuid4())
            self.running[name] = event_id
        elif status in ("success", "failed", "error"):
            event_id = self.running.pop(name, str(uuid.uuid4()))
        else:
            event_id = str(uuid.uuid4())
        event = {
            "event_id": event_id,
            "event_type": event_type,
            "name": name,
            "status": status,
            "timestamp": time.time() * 1000,
        }
        event.update(extra)
        return event


async def trace(emit: Emitter, ids: TraceIds, event_type: str, name: str, status: str = "running", **extra) -> None:
    await emit({"type": "trace", "event": ids.event(event_type, name, status, **extra)})


async def _profile_llm_full(
    llm: WikiLLM, emit: Emitter, *, profile_id: str, stage: str, model: Optional[str],
    messages: list[dict], temperature: float, max_tokens: int, content_step: Optional[int] = None,
) -> tuple[str, bool]:
    """收集 _stream_profile_llm 的完整文本，返回 (text, truncated)。"""
    meta: dict = {}
    text = ""

    async def _tap(payload: dict) -> None:
        if payload.get("type") == "content":
            nonlocal text
            text += payload.get("content") or ""
        await emit(payload)

    if profile_id == DOCUMENT_REVIEW_PROFILE_ID:
        try:
            async with asyncio.timeout(DOCUMENT_REVIEW_TOPIC_TIMEOUT_SECONDS):
                async for content in llm.chat_stream(
                    model=model, messages=messages,
                    temperature=temperature, max_tokens=max_tokens, meta=meta,
                ):
                    await _tap({"type": "content", "content": content, **({"step": content_step} if content_step is not None else {})})
        except TimeoutError as exc:
            raise document_review_structured_timeout_error(stage) from exc
    else:
        async for content in llm.chat_stream(
            model=model, messages=messages,
            temperature=temperature, max_tokens=max_tokens, meta=meta,
        ):
            await _tap({"type": "content", "content": content, **({"step": content_step} if content_step is not None else {})})

    return text, bool(meta.get("truncated"))


# ─── 构建要求抽取（requirements_confirm 拦截流） ────────────

WIKI_REQUIREMENT_EXTRACT_SYSTEM_PROMPT = (
    "你是需求分析器。从用户消息中识别「对 Wiki 生成/更新方式的持续性硬性要求」——"
    "即用户希望这个知识库在所有页面生成时都遵循的规则，例如标题格式、必含小节、页面结构、写作风格等。\n"
    "判定规则：\n"
    "- 一次性的任务指令不算要求（如「根据文档构建wiki」「更新这个库」「生成摘要」）\n"
    "- 对文档内容的描述不算要求\n"
    "- 只提取用户明确提出的要求，逐条保留原文表述，用分号分隔多条，不要扩写、不要编造\n\n"
    "只输出 JSON，不要输出其他内容：\n"
    '{"has_requirements": true/false, "requirements": "要求文本（无要求时为空字符串）"}'
)


async def extract_requirements_from_message(message: str, llm: WikiLLM, model: Optional[str]) -> str:
    """从用户消息中抽取持续性构建要求。抽取失败按无要求处理。"""
    messages = [
        {"role": "system", "content": WIKI_REQUIREMENT_EXTRACT_SYSTEM_PROMPT},
        {"role": "user", "content": message},
    ]
    try:
        text = await llm.chat(model=model, messages=messages, temperature=0, max_tokens=512)
        text = (text or "").strip()
        if text.startswith("```"):
            text = text.strip("`").strip()
            if text.startswith("json"):
                text = text[4:].strip()
        obj = json.loads(text)
        if isinstance(obj, dict) and obj.get("has_requirements"):
            return str(obj.get("requirements") or "").strip()
    except Exception as e:
        logger.warning(f"从消息中提取构建要求失败: {e}")
    return ""


# ─── 对话式引导（缺文档时不机械报错） ────────────────────────

async def guidance_reply(
    message: str, scenario: str, has_wiki_id: bool,
    llm: WikiLLM, model: Optional[str], emit: Emitter,
) -> None:
    if scenario == "build":
        state = (
            "用户已选中一个 Wiki 库，但本次消息没有附带文档内容。"
            if has_wiki_id else
            "用户尚未上传任何文档，也尚未选择 Wiki 库。"
        )
    else:
        state = "用户已选中 Wiki 库，但本次消息没有附带用于增量更新的新文档。"
    system_prompt = (
        "你是「Wiki 构建对话」页面中的知识库构建助手，具备以下能力：根据文档全量构建 Wiki、"
        "基于新文档增量更新已有库、构建图谱、健康检查、生成摘要/问答对/改进建议等。\n"
        f"当前状态：{state}\n"
        "请用中文自然地回应用户这条消息：\n"
        "- 如果用户在询问功能、流程或确认（如「会构建wiki吗」「怎么用」），直接回答，并说明需要先提供文档内容（上传文件或在消息中粘贴）才能开始构建/更新；\n"
        "- 如果用户表达了构建/更新意愿但缺少文档，礼貌告知缺少文档，并说明文档到位后再次发送即可自动开始；\n"
        "- 回答保持简洁（不超过 5 句），不要编造当前状态之外的能力，不要执行任何构建动作。"
    )
    async for content in llm.chat_stream(
        model=model,
        messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": message}],
        temperature=0.7,
    ):
        await emit({"type": "content", "content": content})


# ─── 逐页正文生成 ───────────────────────────────────────────

async def generate_topic_bodies(
    wiki_id: str,
    schema_content: str,
    topics: list[dict],
    llm: WikiLLM,
    model: Optional[str],
    emit: Emitter,
    *,
    build_profile_id: str = GENERIC_PROFILE_ID,
    source_content: str = "",
) -> int:
    """为每个页面单独调用 LLM 生成正文并保存，返回成功保存的页面数。

    公文审核是治理型知识库：结构不合规时先做一次定向纠错，仍失败或超时才停止整批构建；
    generic 保留原容错行为（每页最多两次，仍失败则跳过）。
    """
    if not topics:
        return

    profile = get_build_profile(build_profile_id)
    fill_system_prompt = _apply_build_requirements(
        profile.topic_prompt, _load_wiki_build_requirements(wiki_id),
    )

    ids = TraceIds()
    total = len(topics)
    saved = 0
    failed = 0
    _page_seconds_hist: list[float] = []  # 每页耗时滑动窗口，用于前端 ETA 估算
    for idx, topic in enumerate(topics):
        title = (topic.get("title") or "").strip()
        key = (topic.get("key") or "").strip()
        category = (topic.get("category") or "").strip()
        tags = topic.get("tags") or []
        if not title:
            continue

        # 页开始心跳：明确告知用户当前在生成第几页、预计耗时（qwen-plus 实测 16~22s/页），
        # 消除"静默十几秒像挂了"的观感
        _eta_txt = ""
        if _page_seconds_hist:
            _avg = sum(_page_seconds_hist[-3:]) / len(_page_seconds_hist[-3:])
            _eta_txt = f"，预计约 {max(5, int(_avg))} 秒"
        await emit({"type": "thinking", "content": f"正在生成第 {idx + 1}/{total} 页《{title}》正文{_eta_txt}..."})
        await trace(emit, ids, "trace_progress", "生成页面正文", "running",
                    data={"topics": total, "current": idx + 1, "title": title,
                          "phase": "page_body", "total_pages": total, "page_index": idx + 1})

        messages = [
            {"role": "system", "content": fill_system_prompt},
            {"role": "user", "content": build_topic_user_message(
                profile, title, category, tags, schema_content, source_content,
            )},
        ]

        cleaned = ""
        _page_start = time.time()
        try:
            if profile.id == DOCUMENT_REVIEW_PROFILE_ID:
                for attempt in (0, 1):
                    body, truncated = await _profile_llm_full(
                        llm, emit,
                        profile_id=profile.id, stage=f"公文审核页面正文: {title}",
                        model=model, messages=messages,
                        temperature=0.3, max_tokens=8192,
                    )
                    cleaned = _extract_topic_body(body, title)
                    try:
                        validate_document_review_topic_body(title, cleaned)
                        break
                    except WikiStructuredGenerationError:
                        if attempt:
                            raise
                        logger.warning(f"公文审核页面 {title} 结构不合规，自动重试一次")
                        await emit({"type": "trace", "event": ids.event(
                            "trace_warning", "生成页面正文", "warning",
                            message=f"页面「{title}」结构不合规，自动重试一次",
                            data={"title": title, "attempt": 2},
                        )})
            else:
                for attempt in range(2):
                    await trace(emit, ids, "trace_llm_start", "LLM 调用: 生成页面正文", "running", category="llm")
                    body, _truncated = await _profile_llm_full(
                        llm, emit,
                        profile_id=profile.id, stage="生成页面正文",
                        model=model, messages=messages,
                        temperature=0.3, max_tokens=8192,
                    )
                    await trace(emit, ids, "trace_llm_start", "LLM 调用: 生成页面正文", "success", category="llm")
                    cleaned = _extract_topic_body(body, title)
                    if cleaned and len(cleaned) >= 200:
                        break
                    if attempt == 0:
                        logger.warning(f"主题 {title} 首次生成正文为空/过短，重试一次")
                        await emit({"type": "trace", "event": ids.event(
                            "trace_warning", "生成页面正文", "running",
                            message=f"主题 {title} 首次生成为空，重试", data={"title": title},
                        )})
        except WikiStructuredGenerationError as exc:
            logger.error(f"公文审核 Wiki 结构化生成已停止: {exc}")
            await emit({"type": "trace", "event": ids.event(
                "trace_progress", "生成页面正文", "failed",
                message=str(exc), data={"title": title},
            )})
            raise
        except Exception as e:
            logger.warning(f"主题 {title} 正文生成异常，跳过: {e}")
            await emit({"type": "warning", "message": f"页面「{title}」生成失败已跳过：{e}"})
            await emit({"type": "trace", "event": ids.event(
                "trace_progress", "生成页面正文", "failed",
                message=str(e), data={"title": title},
            )})
            continue

        if not cleaned or len(cleaned) < 200:
            logger.warning(f"主题 {title} 生成正文为空/过短，跳过")
            continue

        page_name = key or _title_to_page_name(title)
        try:
            await _save_wiki_page(wiki_id, page_name, cleaned)
        except Exception as e:
            failed += 1
            await emit({"type": "warning", "message": f"页面「{title}」保存失败已跳过：{e}"})
            await emit({"type": "trace", "event": ids.event(
                "trace_warning", "保存页面正文", "failed",
                message=str(e), data={"title": title, "page": page_name},
            )})
            continue
        saved += 1
        _page_secs = round(time.time() - _page_start, 1)
        _page_seconds_hist.append(_page_secs)
        await emit({"type": "product", "product_type": "doc", "data": {"page": page_name, "content": cleaned}})
        # 页完成事件：带耗时供前端计算 ETA；状态仍为 running（整批结束时才发最终 success/failed）
        await emit({"type": "trace", "event": ids.event(
            "trace_progress", "生成页面正文", "running",
            message=f"第 {idx + 1}/{total} 页《{title}》完成（{_page_secs}s）",
            data={"topics": total, "current": idx + 1, "title": title, "done": True,
                  "page_seconds": _page_secs, "saved": saved, "failed": failed,
                  "phase": "page_body", "total_pages": total, "page_index": idx + 1},
        )})

    final_status = "success" if failed == 0 else "failed"
    _bodies_secs = round(sum(_page_seconds_hist), 1)
    await emit({"type": "trace", "event": ids.event(
        "trace_progress", "生成页面正文", final_status,
        message=f"页面正文生成完毕：成功 {saved}/{total} 页，共耗时 {_bodies_secs}s",
        data={"saved": saved, "failed": failed, "total": total, "body_seconds": _bodies_secs},
    )})
    if failed:
        await emit({"type": "warning", "message": f"{failed}/{total} 个页面保存失败，可重试增量更新补齐。"})
    return saved


# ─── 全量构建 ───────────────────────────────────────────────

async def build_wiki(
    message: str, file_content: str, filename: str,
    llm: WikiLLM, model: Optional[str],
    wiki_id: str,
    emit: Emitter,
    *,
    resume_from_raw: bool = False,
    build_profile_id: str = GENERIC_PROFILE_ID,
) -> None:
    """全量构建：raw 层落盘 → Schema 生成（截断续写/重试）→ Index → 逐页正文 → 图谱。"""
    profile = get_build_profile(build_profile_id)
    ids = TraceIds()

    # Step 0: 保存原始文档到 raw 层（只读、不可变，作为事实来源）
    build_started = time.time()
    build_entry_id = f"bh_{int(build_started * 1000)}_{str(uuid.uuid4())[:6]}"
    await _record_build_history(
        wiki_id, build_entry_id,
        type="build", status="running",
        started_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
        model=model or "", source=filename or "输入内容",
    )
    # 库名称兜底落盘（构建开始即写入，失败库也能在库管理中显示可读名称）
    _save_wiki_library_meta(
        wiki_id,
        _default_library_name(message),
        description=f"对话式构建创建，来源：{filename or '输入内容'}",
    )
    if wiki_id and not resume_from_raw:
        raw_name = _raw_page_name(filename)
        await _save_wiki_page(wiki_id, raw_name, file_content)
        await trace(emit, ids, "trace_progress", "保存原始文档(raw层)", "success", data={"page": raw_name})

    # 库级构建要求：统一从库目录读取
    build_req = _load_wiki_build_requirements(wiki_id)
    if build_req:
        await emit({"type": "thinking", "content": "已加载本库的自定义构建要求，将严格遵循。"})
        await trace(emit, ids, "trace_progress", "加载构建要求", "success", data={"length": len(build_req)})

    # Step 1: Schema 生成
    step1_start = time.time()
    await emit({"type": "thinking", "content": "正在分析文档并生成 Wiki Schema...（预计 1~2 分钟，请耐心等待）"})
    await trace(emit, ids, "trace_progress", "Schema 生成", "running",
                data={"step": 1, "filename": filename,
                      "phase": "schema", "total_steps": 5, "step_index": 1,
                      "step_label": "分析文档，生成知识地图（Schema）"})

    schema_messages = [
        {"role": "system", "content": _apply_build_requirements(profile.schema_prompt, build_req)},
        {"role": "user", "content": f"文件名: {filename}\n\n---\n{file_content}\n---"},
    ]

    await trace(emit, ids, "trace_llm_start", "LLM 调用: Schema 生成", "running", category="llm")
    schema_text, schema_truncated_flag = await _profile_llm_full(
        llm, emit,
        profile_id=profile.id, stage="Schema 生成",
        model=model, messages=schema_messages,
        temperature=0.3, max_tokens=8192, content_step=1,
    )

    # 截断续写（截断检测使用 _schema_looks_truncated；续写后复检，最多两轮）
    if profile.id != DOCUMENT_REVIEW_PROFILE_ID:
        for continuation_round in (1, 2):
            if not _schema_looks_truncated(schema_text):
                break
            await emit({"type": "warning", "message": f"Schema 输出较长，正在自动续写（第 {continuation_round} 轮）..."})
            await trace(emit, ids, "trace_warning", "Schema 续写", "running", message=f"检测到输出截断（第 {continuation_round} 轮）")
            continue_messages = schema_messages + [
                {"role": "assistant", "content": schema_text},
                {"role": "user", "content": "你的输出在上文截断了。请从中断处继续输出剩余的 Schema 内容，不要重复已输出的部分。"},
            ]
            continue_text, _ = await _profile_llm_full(
                llm, emit,
                profile_id=profile.id, stage="Schema 续写",
                model=model, messages=continue_messages,
                temperature=0.3, max_tokens=4096, content_step=1,
            )
            if not continue_text.strip():
                break
            schema_text = schema_text + continue_text
        else:
            if _schema_looks_truncated(schema_text):
                await emit({"type": "warning", "message": "Schema 续写后仍未补全，将继续构建（部分页面可能缺失）。"})
                await trace(emit, ids, "trace_warning", "Schema 续写", "failed", message="续写后仍疑似截断")

    await trace(emit, ids, "trace_llm_start", "LLM 调用: Schema 生成", "success",
                duration_ms=int((time.time() - step1_start) * 1000), category="llm")

    schema_cleaned = _strip_reasoning_from_markdown(schema_text, profile.schema_prompt)

    if profile.id == DOCUMENT_REVIEW_PROFILE_ID:
        validate_document_review_schema(
            schema_cleaned,
            stage="Schema 生成",
            truncated=schema_truncated_flag,
        )

    # 验证 Schema 完整性
    has_topics = '📄' in schema_cleaned or '## 知识地图' in schema_cleaned
    if profile.id != DOCUMENT_REVIEW_PROFILE_ID and not has_topics:
        await emit({"type": "warning", "message": "Schema 首次生成未包含页面，正在自动重试..."})
        await trace(emit, ids, "trace_warning", "Schema 重试", "running", message="未检测到知识地图")
        retry_messages = [
            {"role": "system", "content": _apply_build_requirements(profile.schema_prompt, build_req) + f"\n\n重要提醒：输出必须包含 ## 知识地图 标题和至少 {profile.minimum_topics} 个 📄 页面条目。不要输出任何推理过程，直接输出 SCHEMA。"},
            {"role": "user", "content": f"上一次输出未包含知识地图。请重新分析以下文档，直接输出包含 📄 页面条目的完整 SCHEMA。\n\n文件名: {filename}\n\n---\n{file_content}\n---"},
        ]
        schema_text = ""
        async for content in llm.chat_stream(
            model=model, messages=retry_messages,
            temperature=0.3, max_tokens=8192,
        ):
            schema_text += content
            await emit({"type": "content", "content": content, "step": 1})
        schema_cleaned = _strip_reasoning_from_markdown(schema_text, profile.schema_prompt)

    await trace(emit, ids, "trace_progress", "Schema 生成", "success",
                duration_ms=int((time.time() - step1_start) * 1000),
                data={"step": 1, "phase": "schema", "total_steps": 5, "step_index": 1})

    # 发送 product(toc)
    toc_data = _parse_schema_to_toc(schema_cleaned)

    # Schema 完整性校验：声明的页面数 vs 实际解析数
    declared_topics = 0
    topics_match = re.search(r'topics:\s*(\d+)', schema_cleaned)
    if topics_match:
        declared_topics = int(topics_match.group(1))
    actual_topics = toc_data.get("topic_count", 0)
    if declared_topics > 0 and actual_topics < declared_topics:
        await emit({"type": "warning", "message": f"Schema 声明 {declared_topics} 个主题，但实际解析到 {actual_topics} 个。部分内容可能被截断。"})
        await trace(emit, ids, "trace_warning", "Schema 完整性", "warning",
                    message=f"声明{declared_topics}个主题，解析到{actual_topics}个",
                    data={"declared": declared_topics, "actual": actual_topics})

    await emit({"type": "product", "product_type": "toc", "data": toc_data})
    await emit({"type": "product", "product_type": "doc", "data": {"page": "SCHEMA.md", "content": schema_cleaned}})

    # Step 2: 生成 Index
    step2_start = time.time()
    await trace(emit, ids, "trace_progress", "Index 导航页生成", "running",
                data={"step": 2, "topics": actual_topics,
                      "phase": "index", "total_steps": 5, "step_index": 2,
                      "step_label": "生成导航页（Index）"})
    await emit({"type": "thinking", "content": f"正在根据 {actual_topics} 个主题生成导航页..."})

    index_messages = [
        {"role": "system", "content": _apply_build_requirements(profile.index_prompt, build_req)},
        {"role": "user", "content": f"请根据以下 Schema 生成 Index 导航页。确保所有类别和主题都出现在 Index 中。\n\n---\n{schema_cleaned}\n---"},
    ]
    await trace(emit, ids, "trace_llm_start", "LLM 调用: Index 生成", "running", category="llm")
    index_text, index_truncated = await _profile_llm_full(
        llm, emit,
        profile_id=profile.id, stage="Index 生成",
        model=model, messages=index_messages,
        temperature=0.3, max_tokens=8192, content_step=2,
    )
    await trace(emit, ids, "trace_llm_start", "LLM 调用: Index 生成", "success",
                duration_ms=int((time.time() - step2_start) * 1000), category="llm")

    index_cleaned = _strip_reasoning_from_markdown(index_text, profile.index_prompt)

    if profile.id == DOCUMENT_REVIEW_PROFILE_ID:
        validate_document_review_index(index_cleaned, truncated=index_truncated)

    await emit({"type": "product", "product_type": "doc", "data": {"page": "index.md", "content": index_cleaned}})
    await trace(emit, ids, "trace_progress", "Index 导航页生成", "success",
                duration_ms=int((time.time() - step2_start) * 1000),
                data={"step": 2, "phase": "index", "total_steps": 5, "step_index": 2})

    # 保存到 Wiki 库
    await trace(emit, ids, "trace_progress", "保存到 Wiki 库", "running",
                data={"wiki_id": wiki_id, "phase": "save", "total_steps": 5, "step_index": 3})
    try:
        for page_name, content in [("SCHEMA.md", schema_cleaned), ("index.md", index_cleaned)]:
            await _save_wiki_page(wiki_id, page_name, content)
        await _append_wiki_log(wiki_id, "build", filename, actual_topics)
        logger.info(f"Wiki 页面已保存到 {wiki_id}")
        await trace(emit, ids, "trace_progress", "保存到 Wiki 库", "success", data={"wiki_id": wiki_id})
    except asyncio.CancelledError:
        logger.warning(f"Wiki chat stream 已由用户取消: wiki_id={wiki_id}")
        await _record_build_history(
            wiki_id, build_entry_id,
            status="failed",
            finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            error="用户取消生成",
            model=model or "",
        )
        raise
    except Exception as e:
        logger.error(f"保存 Wiki 页面失败: {e}")
        await trace(emit, ids, "trace_progress", "保存到 Wiki 库", "failed", message=str(e))
        await emit({"type": "warning", "message": f"保存到 Wiki 库失败: {e}"})
        raise WikiStructuredGenerationError(f"保存 Wiki 产物失败，构建未完成：{e}") from e

    # 逐页生成正文
    topics = toc_data.get("topics", [])
    if topics:
        await emit({"type": "thinking",
                    "content": f"Schema 与导航页已就绪。开始逐页生成 {len(topics)} 个页面正文（每页约 16~22 秒，总计约 {max(1, len(topics) * 20 // 60)}~{max(2, (len(topics) * 22 + 59) // 60)} 分钟），请耐心等待。"})
    try:
        if topics:
            saved_pages = await generate_topic_bodies(
                wiki_id, schema_cleaned, topics,
                llm, model, emit,
                build_profile_id=build_profile_id,
                source_content=file_content,
            )
            if saved_pages == 0:
                raise WikiStructuredGenerationError(
                    f"全部 {len(topics)} 个页面正文生成失败或为空，构建未产出任何知识页面。"
                    "原始材料已保留在 raw 层，可重试构建。"
                )
    except asyncio.CancelledError:
        logger.warning(f"Wiki 构建已取消（正文阶段）: {wiki_id}")
        await _record_build_history(
            wiki_id, build_entry_id,
            status="failed",
            finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            error="用户取消生成",
            model=model or "",
        )
        raise

    # 自动重建文档关系图（纯扫描秒级完成）
    try:
        graph_result = await asyncio.to_thread(_build_doc_graph, wiki_id)
        await _save_wiki_page(wiki_id, "_wiki_graph.json", json.dumps(graph_result, ensure_ascii=False))
        await emit({"type": "product", "product_type": "graph", "data": graph_result})
        await trace(emit, ids, "trace_progress", "更新文档关系图", "success",
                    data={"documents": graph_result["stats"]["total_documents"],
                          "relations": graph_result["stats"]["total_relations"],
                          "phase": "graph", "total_steps": 5, "step_index": 5})
    except Exception as e:
        logger.warning(f"重建文档关系图失败: {e}")
        await trace(emit, ids, "trace_progress", "更新文档关系图", "failed", message=str(e))

    # 构建成功：用 Schema 标题升级自动命名的库名称
    _upgrade_wiki_library_meta(wiki_id, _extract_schema_title(schema_cleaned))
    await _record_build_history(
        wiki_id, build_entry_id,
        status="success",
        finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
        summary=f"全量构建完成：{actual_topics} 个主题",
        model=model or "",
    )


# ─── 增量更新 ───────────────────────────────────────────────

async def update_wiki(
    message: str, file_content: str, filename: str,
    llm: WikiLLM, model: Optional[str],
    wiki_id: str,
    emit: Emitter,
    *,
    resume_from_raw: bool = False,
    build_profile_id: str = GENERIC_PROFILE_ID,
) -> None:
    """增量更新：加载已有 Schema → 合并新文档 → 更新 Index → 补齐正文 → 图谱。"""
    profile = get_build_profile(build_profile_id)
    ids = TraceIds()

    update_started = time.time()
    update_entry_id = f"bh_{int(update_started * 1000)}_{str(uuid.uuid4())[:6]}"
    await _record_build_history(
        wiki_id, update_entry_id,
        type="update", status="running",
        started_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
        model=model or "", source=filename or "输入内容",
    )

    # Step 0: 加载已有 Schema
    await trace(emit, ids, "trace_progress", "加载已有 Schema", "running", data={"wiki_id": wiki_id})
    existing_schema = ""
    for name in ("SCHEMA.md", "_schema.md", "schema.md", "_Schema.md"):
        existing_schema = await asyncio.to_thread(_read_wiki_page, wiki_id, name)
        if existing_schema:
            break

    if not existing_schema:
        await emit({"type": "warning", "message": "未找到已有 Schema，将执行全量构建。"})
        await build_wiki(
            message, file_content, filename,
            llm, model, wiki_id, emit,
            resume_from_raw=resume_from_raw,
            build_profile_id=build_profile_id,
        )
        return

    # ─── 无新文档分支：只补全缺失/过短页面正文，不合并 Schema、不动 SCHEMA.md/index.md ───
    # （场景："补全 XX 页正文" / "把没写完的页面补齐"。此前 file_content 必填导致这类请求工具校验必炸）
    if not (file_content or "").strip():
        await trace(emit, ids, "trace_progress", "加载已有 Schema", "success",
                    data={"wiki_id": wiki_id, "schema_length": len(existing_schema),
                          "mode": "backfill_only"})
        await emit({"type": "thinking", "content": "未检测到新文档，将只补全缺失或过短的页面正文（不改动 SCHEMA 与 index）。"})

        existing_toc_backfill = _parse_schema_to_toc(existing_schema)
        missing: list[dict] = []
        for t in existing_toc_backfill.get("topics") or []:
            title = (t.get("title") or "").strip()
            if not title:
                continue
            key = t.get("key") or f"{t.get('category', '')}/{title}.md"
            content = await asyncio.to_thread(_read_wiki_page, wiki_id, key)
            if not content or len(content) < 200:
                missing.append(t)

        if not missing:
            await emit({"type": "done", "data": {"summary": "所有页面均已有实质正文，无需补全。"}})
            await _record_build_history(
                wiki_id, update_entry_id,
                status="success",
                finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
                summary="正文补全检查：所有页面均完整，无需补全",
                model=model or "",
            )
            return

        names_preview = "、".join(t["title"] for t in missing[:6])
        more = f" 等 {len(missing)} 页" if len(missing) > 6 else ""
        await emit({"type": "thinking", "content": f"发现缺失/过短页面：{names_preview}{more}，开始逐页生成..."})

        try:
            await generate_topic_bodies(
                wiki_id, existing_schema, missing,
                llm, model, emit,
                build_profile_id=build_profile_id,
                source_content="",
            )
        except asyncio.CancelledError:
            logger.warning(f"Wiki 正文补全已取消: {wiki_id}")
            await _record_build_history(
                wiki_id, update_entry_id,
                status="failed",
                finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
                error="用户取消生成",
                model=model or "",
            )
            raise
        except WikiStructuredGenerationError:
            raise
        except Exception as e:
            logger.warning(f"正文补全阶段失败: {e}")

        try:
            graph_result = await asyncio.to_thread(_build_doc_graph, wiki_id)
            await _save_wiki_page(wiki_id, "_wiki_graph.json", json.dumps(graph_result, ensure_ascii=False))
            await emit({"type": "product", "product_type": "graph", "data": graph_result})
        except Exception as e:
            logger.warning(f"重建文档关系图失败: {e}")

        await _append_wiki_log(wiki_id, "update", "backfill_missing_pages", len(missing))
        await _record_build_history(
            wiki_id, update_entry_id,
            status="success",
            finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            summary=f"正文补全完成：补写 {len(missing)} 页（无新文档）",
            model=model or "",
        )
        return

    await trace(emit, ids, "trace_progress", "加载已有 Schema", "success",
                data={"wiki_id": wiki_id, "schema_length": len(existing_schema)})

    existing_toc = _parse_schema_to_toc(existing_schema)
    existing_topic_count = existing_toc.get("topic_count", 0)
    await emit({"type": "thinking", "content": f"已有 Wiki 包含 {existing_topic_count} 个主题，正在合并新文档..."})

    # Step 1: Schema 增量合并
    step1_start = time.time()
    await trace(emit, ids, "trace_progress", "Schema 增量合并", "running",
                data={"step": 1, "existing_topics": existing_topic_count, "filename": filename})

    build_req = _load_wiki_build_requirements(wiki_id)
    update_messages = [
        {"role": "system", "content": _apply_build_requirements(profile.update_prompt, build_req)},
        {"role": "user", "content": f"已有 Schema:\n\n---\n{existing_schema}\n---\n\n新文档内容:\n\n文件名: {filename}\n\n---\n{file_content}\n---"},
    ]

    await trace(emit, ids, "trace_llm_start", "LLM 调用: Schema 合并", "running", category="llm")
    merged_schema, merged_truncated = await _profile_llm_full(
        llm, emit,
        profile_id=profile.id, stage="Schema 增量合并",
        model=model, messages=update_messages,
        temperature=0.3, max_tokens=8192, content_step=1,
    )
    await trace(emit, ids, "trace_llm_start", "LLM 调用: Schema 合并", "success",
                duration_ms=int((time.time() - step1_start) * 1000), category="llm")

    merged_cleaned = _strip_reasoning_from_markdown(merged_schema, profile.update_prompt)

    if profile.id == DOCUMENT_REVIEW_PROFILE_ID:
        validate_document_review_schema(
            merged_cleaned,
            stage="Schema 增量合并",
            existing_schema=existing_schema,
            truncated=merged_truncated,
        )
    else:
        missing = check_generic_schema_completeness(
            merged_cleaned, existing_schema=existing_schema
        )
        if missing:
            preview = "、".join(missing[:5])
            if len(missing) > 5:
                preview += f"等 {len(missing)} 个页面"
            await emit({
                "type": "warning",
                "message": f"增量合并可能遗漏了已有页面：{preview}。请人工确认。",
            })

    await trace(emit, ids, "trace_progress", "Schema 增量合并", "success",
                duration_ms=int((time.time() - step1_start) * 1000), data={"step": 1})

    new_toc = _parse_schema_to_toc(merged_cleaned)
    new_topic_count = new_toc.get("topic_count", 0)

    await emit({"type": "product", "product_type": "toc", "data": new_toc})
    await emit({"type": "product", "product_type": "doc", "data": {"page": "SCHEMA.md", "content": merged_cleaned}})

    # Step 2: 重新生成 Index
    step2_start = time.time()
    await trace(emit, ids, "trace_progress", "Index 更新", "running",
                data={"step": 2, "topics": new_topic_count})
    await emit({"type": "thinking", "content": f"正在根据 {new_topic_count} 个主题更新导航页..."})

    index_messages = [
        {"role": "system", "content": _apply_build_requirements(profile.index_prompt, build_req)},
        {"role": "user", "content": f"请根据以下合并后的 Schema 生成 Index 导航页。确保所有类别和主题都出现在 Index 中。\n\n---\n{merged_cleaned}\n---"},
    ]
    await trace(emit, ids, "trace_llm_start", "LLM 调用: Index 更新", "running", category="llm")
    index_text, index_truncated = await _profile_llm_full(
        llm, emit,
        profile_id=profile.id, stage="Index 更新",
        model=model, messages=index_messages,
        temperature=0.3, max_tokens=8192, content_step=2,
    )
    await trace(emit, ids, "trace_llm_start", "LLM 调用: Index 更新", "success",
                duration_ms=int((time.time() - step2_start) * 1000), category="llm")

    index_cleaned = _strip_reasoning_from_markdown(index_text, profile.index_prompt)

    if profile.id == DOCUMENT_REVIEW_PROFILE_ID:
        validate_document_review_index(index_cleaned, truncated=index_truncated)

    await emit({"type": "product", "product_type": "doc", "data": {"page": "index.md", "content": index_cleaned}})
    await trace(emit, ids, "trace_progress", "Index 更新", "success",
                duration_ms=int((time.time() - step2_start) * 1000), data={"step": 2})

    # 保存到 Wiki 库（先备份旧 Schema，写失败时把新 SCHEMA.md 回滚为旧版，保持 SCHEMA↔index 一致）
    await trace(emit, ids, "trace_progress", "保存到 Wiki 库", "running", data={"wiki_id": wiki_id})
    try:
        if existing_schema:
            await _backup_schema_versioned(wiki_id, existing_schema)
        if not resume_from_raw:
            raw_name = _raw_page_name(filename)
            await _save_wiki_page(wiki_id, raw_name, file_content)
        for page_name, content in [("SCHEMA.md", merged_cleaned), ("index.md", index_cleaned)]:
            await _save_wiki_page(wiki_id, page_name, content)
        await _append_wiki_log(wiki_id, "update", filename, new_topic_count)
        logger.info(f"Wiki 增量更新已保存到 {wiki_id}")
        await trace(emit, ids, "trace_progress", "保存到 Wiki 库", "success", data={"wiki_id": wiki_id})
    except Exception as e:
        logger.error(f"保存 Wiki 页面失败: {e}")
        rollback_note = ""
        if existing_schema:
            try:
                await _save_wiki_page(wiki_id, "SCHEMA.md", existing_schema)
                rollback_note = "（SCHEMA.md 已回滚到更新前版本）"
            except Exception as rb_err:
                logger.error(f"SCHEMA.md 回滚失败: {rb_err}")
        await trace(emit, ids, "trace_progress", "保存到 Wiki 库", "failed", message=str(e))
        await emit({"type": "warning", "message": f"保存到 Wiki 库失败: {e}"})
        raise WikiStructuredGenerationError(
            f"保存 Wiki 产物失败，增量更新未完成{rollback_note}：{e}"
        ) from e

    # 自动补齐页面正文：按目标 key 检查文件是否存在/有实质内容
    try:
        new_topics = new_toc.get("topics") or []
        missing = []
        for t in new_topics:
            title = (t.get("title") or "").strip()
            if not title:
                continue
            key = t.get("key") or f"{t.get('category', '')}/{title}.md"
            content = await asyncio.to_thread(_read_wiki_page, wiki_id, key)
            if not content or len(content) < 200:
                missing.append(t)

        if missing:
            await generate_topic_bodies(
                wiki_id, merged_cleaned, missing,
                llm, model, emit,
                build_profile_id=build_profile_id,
                source_content=file_content,
            )
    except asyncio.CancelledError:
        logger.warning(f"Wiki 增量更新已取消（正文补齐阶段）: {wiki_id}")
        await _record_build_history(
            wiki_id, update_entry_id,
            status="failed",
            finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            error="用户取消生成",
            model=model or "",
        )
        raise
    except WikiStructuredGenerationError:
        raise
    except Exception as e:
        logger.warning(f"生成页面正文失败: {e}")

    # 自动重建文档关系图
    try:
        graph_result = await asyncio.to_thread(_build_doc_graph, wiki_id)
        await _save_wiki_page(wiki_id, "_wiki_graph.json", json.dumps(graph_result, ensure_ascii=False))
        await emit({"type": "product", "product_type": "graph", "data": graph_result})
    except Exception as e:
        logger.warning(f"重建文档关系图失败: {e}")

    _upgrade_wiki_library_meta(wiki_id, _extract_schema_title(merged_cleaned))
    await _record_build_history(
        wiki_id, update_entry_id,
        status="success",
        finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
        summary=f"增量更新完成：{new_topic_count} 个主题（原 {existing_topic_count}）",
        model=model or "",
    )
