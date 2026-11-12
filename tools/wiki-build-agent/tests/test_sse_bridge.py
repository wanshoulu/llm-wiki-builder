"""sse_bridge 单测 — 8 事件契约编码 / 缓冲排空 / 工具事件翻译。"""

import json

from app.sse_bridge import (
    EventBuffer,
    ToolEventTranslator,
    bridge_event_to_sse_payload,
    sse_encode,
    sse_heartbeat,
)


def test_sse_encode_bare_data_line():
    out = sse_encode({"type": "done", "wiki_id": "w1"})
    assert out.startswith("data: ")
    assert out.endswith("\n\n")
    assert "event:" not in out
    assert json.loads(out[6:-2]) == {"type": "done", "wiki_id": "w1"}


def test_sse_encode_keeps_chinese_unescaped():
    out = sse_encode({"type": "content", "content": "中文"})
    assert "中文" in out


def test_heartbeat_is_comment():
    assert sse_heartbeat() == ": hb\n\n"


def test_event_buffer_drain_fifo():
    buf = EventBuffer()
    buf.emitter("tool_call", {"tool": "a"})
    buf.emitter("pipeline_event", {"type": "thinking", "content": "x"})
    assert buf.drain() == [("tool_call", {"tool": "a"}), ("pipeline_event", {"type": "thinking", "content": "x"})]
    assert buf.drain() == []


def test_translator_reuses_event_id_per_tool():
    t = ToolEventTranslator()
    running = t.translate("tool_call", {"tool": "read_wiki_page"})
    done = t.translate("tool_result", {"tool": "read_wiki_page", "result": {"found": True}, "durationMs": 12})
    assert running["event"]["status"] == "running"
    assert done["event"]["status"] == "success"
    assert done["event"]["event_id"] == running["event"]["event_id"]
    assert done["event"]["duration_ms"] == 12
    assert t._running_ids == {}  # 已弹出


def test_translator_marks_failed_result():
    t = ToolEventTranslator()
    t.translate("tool_call", {"tool": "save_wiki_page"})
    done = t.translate("tool_result", {"tool": "save_wiki_page", "result": {"ok": False, "error": "disk"}})
    assert done["event"]["status"] == "failed"


def test_translator_prefers_structured_ok_field():
    """工具显式 ok 字段优先于字符串启发（errors:[] 合法结果不再被误判为失败）。"""
    t = ToolEventTranslator()
    t.translate("tool_call", {"tool": "validate_wiki_structure"})
    done = t.translate("tool_result", {
        "tool": "validate_wiki_structure", "ok": True,
        "result": {"ok": True, "errors": [], "error_count": 0},
    })
    assert done["event"]["status"] == "success"

    t2 = ToolEventTranslator()
    t2.translate("tool_call", {"tool": "run_wiki_build"})
    failed = t2.translate("tool_result", {"tool": "run_wiki_build", "ok": False, "result": {"ok": False}})
    assert failed["event"]["status"] == "failed"


def test_bridge_passthrough_pipeline_events():
    t = ToolEventTranslator()
    payload = {"type": "trace", "event": {"name": "Schema 生成", "status": "success"}}
    assert bridge_event_to_sse_payload("pipeline_event", payload, t) is payload
    assert bridge_event_to_sse_payload("unknown_event", {}, t) is None
