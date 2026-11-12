"""知识问答 Agent — FastAPI 入口，SSE 流式输出"""

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse

from .config import server_config, llm_config, engine_config
from .agent_factory import create_agent
from .sse_adapter import sse_encode, sse_heartbeat
from .engine_bridge import EngineBridge

logger = logging.getLogger("knowledge-qa-agent")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时检查引擎可达性"""
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(f"{engine_config.base_url}/api/knowledge-qa/health")
            logger.info("Engine health: %s", r.status_code)
    except Exception as e:
        logger.warning("Engine not reachable: %s", e)
    yield


app = FastAPI(lifespan=lifespan, title="Knowledge QA Agent", version="1.0.0")

# CORS
_origins = server_config.cors_origins.split(",") if server_config.cors_origins != "*" else ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?" if "*" in _origins else None,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "model": llm_config.model, "engine": engine_config.base_url}


_FALLBACK_GRAPH_ID = "org/icbc-hr/org-graph-v3"


async def resolve_default_graph_id() -> str:
    """请求未指定 graphId 时，从 ai-harbor 解析默认资产的最新已发布版本。

    资产 ID 由 QA_DEFAULT_GRAPH_ASSET 配置（默认 icbc-hr）。
    解析失败（网络/未发布）时回退到硬编码 ID，保证服务可用性。
    """
    asset = os.getenv("QA_DEFAULT_GRAPH_ASSET", "icbc-hr")
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{engine_config.base_url}/api/org-graph/assets/{asset}/latest")
            r.raise_for_status()
            graph_id = r.json().get("data", {}).get("graphId")
            if graph_id:
                return graph_id
    except Exception as e:
        logger.warning("解析最新发布图谱失败，回退默认 %s: %s", _FALLBACK_GRAPH_ID, e)
    return _FALLBACK_GRAPH_ID


@app.post("/api/knowledge-qa-agent/chat")
async def handle_chat(request: Request) -> StreamingResponse:
    """对话主端点 — SSE 流式输出

    请求体:
        { "message": string, "graphId"?: string, "history"?: [{role, content}] }

    SSE 事件:
        phase   — { name, status, detail }
        step    — { name, status, detail }
        result  — { answer }
        done    — {}
        error   — { error }
        hb      — { ts }
    """
    try:
        body = await request.json()
    except Exception:
        body = {}

    message = (body.get("message") or "").strip()
    if not message:
        async def err():
            yield sse_encode("error", {"error": "message is required"})
            yield sse_encode("done", {})
        return StreamingResponse(err(), media_type="text/event-stream")

    graph_id = body.get("graphId") or await resolve_default_graph_id()
    history = body.get("history") or []

    async def event_stream():
        try:
            # 1. 创建 Agent
            yield sse_encode("phase", {"name": "初始化", "status": "running", "detail": "创建 Agent 实例"})
            agent, bridge = create_agent()
            yield sse_encode("phase", {"name": "初始化", "status": "done", "detail": "Agent 就绪"})

            # 2. 构建 query（含历史上下文和图谱ID）
            query_parts = [f"[system] 当前图谱ID: {graph_id}"]
            for h in history[-8:]:
                role = h.get("role", "")
                content = str(h.get("content", ""))[:2000]
                if role in ("user", "assistant"):
                    query_parts.append(f"[{role}] {content}")
            query_parts.append(f"[user] {message}")
            query = "\n".join(query_parts)

            # 3. 运行 Agent
            yield sse_encode("phase", {"name": "推理中", "status": "running", "detail": "LLM 分析意图并调用工具"})

            _deadline = time.time() + 120
            invoke_task = asyncio.create_task(agent.invoke({"query": query}))
            _last_hb = time.time()

            while True:
                if invoke_task.done():
                    break
                if time.time() > _deadline and not invoke_task.done():
                    invoke_task.cancel()
                    yield sse_encode("error", {"error": "Agent 执行超时（120秒）"})
                    yield sse_encode("done", {})
                    await bridge.close()
                    return
                # 心跳
                if time.time() - _last_hb > 15:
                    yield sse_heartbeat()
                    _last_hb = time.time()
                await asyncio.sleep(0.1)

            invoke_result = await invoke_task
            answer = invoke_result.get("output", "抱歉，我无法组织出有效的回答。")

            yield sse_encode("phase", {"name": "回答生成", "status": "done", "detail": "完成"})
            yield sse_encode("result", {"answer": answer})
            yield sse_encode("done", {})

            await bridge.close()

        except Exception as e:
            logger.error("Agent failed: %s", e, exc_info=True)
            yield sse_encode("error", {"error": f"Agent 运行失败：{e}"})
            yield sse_encode("done", {})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.post("/api/knowledge-qa-agent/query")
async def handle_simple_query(request: Request) -> JSONResponse:
    """简单查询端点 — 非流式，直接返回结果

    请求体: { "message": string, "graphId"?: string, "history"?: [{role, content}] }
    响应: { "answer": string }
    """
    try:
        body = await request.json()
    except Exception:
        body = {}

    message = (body.get("message") or "").strip()
    if not message:
        return JSONResponse({"error": "message is required"}, status_code=400)

    graph_id = body.get("graphId") or await resolve_default_graph_id()
    history = body.get("history") or []

    query_parts = [f"[system] 当前图谱ID: {graph_id}"]
    for h in history[-8:]:
        role = h.get("role", "")
        content = str(h.get("content", ""))[:2000]
        if role in ("user", "assistant"):
            query_parts.append(f"[{role}] {content}")
    query_parts.append(f"[user] {message}")
    query = "\n".join(query_parts)

    try:
        agent, bridge = create_agent()
        result = await asyncio.wait_for(agent.invoke({"query": query}), timeout=120)
        answer = result.get("output", "抱歉，我无法组织出有效的回答。")
        await bridge.close()
        return JSONResponse({"answer": answer, "success": True})
    except asyncio.TimeoutError:
        return JSONResponse({"error": "Agent 执行超时", "success": False}, status_code=504)
    except Exception as e:
        logger.error("Query failed: %s", e, exc_info=True)
        return JSONResponse({"error": str(e), "success": False}, status_code=500)


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
