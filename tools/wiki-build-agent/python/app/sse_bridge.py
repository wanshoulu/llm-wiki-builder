"""SSE 桥接 — 统一事件词汇 → 旧前端 8 类 SSE 事件契约。

Phase 2 契约（与 ontomind-agent wiki_chat 完全一致，前端零改动即可切换）：
  data: {"type": "trace", "event": {event_id, event_type, name, status, ...}}
  data: {"type": "thinking", "content": ...}
  data: {"type": "content", "content": ..., "step"?: ...}
  data: {"type": "product", "product_type": "toc|doc|graph", "data": ...}
  data: {"type": "warning", "message": ...}
  data: {"type": "requirements_confirm", "requirements": ..., "is_new": ...}
  data: {"type": "error", "message": ...}
  data: {"type": "done", "wiki_id": ..., "session_id": ..., "reason"?: ...}
"""

from __future__ import annotations

import json
import time
from typing import Any


def sse_encode(payload: dict[str, Any]) -> str:
    """旧契约是裸 data: JSON（无 event: 字段），与 ontomind-agent _sse 一致。"""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def sse_heartbeat() -> str:
    return ": hb\n\n"


class EventBuffer:
    """桥接事件缓冲（corporate-marketing-agent 模式）。

    main.py 在每个 agent stream chunk 后 drain()，把缓冲事件转为 SSE。
    """

    def __init__(self) -> None:
        self._buffer: list[tuple[str, dict]] = []

    def emitter(self, event_type: str, data: dict) -> None:
        self._buffer.append((event_type, data))

    def drain(self) -> list[tuple[str, dict]]:
        out, self._buffer = self._buffer, []
        return out


class ToolEventTranslator:
    """tool_call / tool_result 桥接事件 → trace 事件（event_id 按工具名复用）。"""

    def __init__(self) -> None:
        self._running_ids: dict[str, str] = {}

    def translate(self, event_type: str, data: dict) -> dict | None:
        tool = str(data.get("tool") or "")
        if not tool:
            return None
        name = f"工具: {tool}"
        if event_type == "tool_call":
            import uuid
            event_id = str(uuid.uuid4())
            self._running_ids[tool] = event_id
            status = "running"
        elif event_type == "tool_result":
            event_id = self._running_ids.pop(tool, "")
            ok_field = data.get("ok")
            if isinstance(ok_field, bool):
                # 工具层显式给出成败（优先）；字符串启发会把合法 errors:[] 误判为失败
                ok = ok_field
            else:
                result_str = str(data.get("result", ""))
                ok = not result_str.startswith(("Error",)) and "error" not in result_str.lower()[:60]
            status = "success" if ok else "failed"
        else:
            return None
        event = {
            "event_id": event_id,
            "event_type": "trace_tool_call",
            "name": name,
            "status": status,
            "timestamp": time.time() * 1000,
            "category": "tool",
        }
        if event_type == "tool_result":
            result = data.get("result")
            if isinstance(result, (dict, list)):
                result = json.dumps(result, ensure_ascii=False)
            event["message"] = str(result)[:200]
            if data.get("durationMs") is not None:
                event["duration_ms"] = data["durationMs"]
        return {"type": "trace", "event": event}


def bridge_event_to_sse_payload(event_type: str, data: dict, translator: ToolEventTranslator) -> dict | None:
    """把 WikiBridge 事件转成旧契约 SSE payload dict；无需上抛的返回 None。"""
    if event_type == "pipeline_event":
        return data  # pipeline 产出的就是契约内 payload
    if event_type in ("tool_call", "tool_result"):
        return translator.translate(event_type, data)
    return None
