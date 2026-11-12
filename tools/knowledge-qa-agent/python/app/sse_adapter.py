"""SSE 编码工具"""

import json
import time
from typing import Any


def sse_encode(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def sse_heartbeat() -> str:
    return sse_encode("hb", {"ts": int(time.time() * 1000)})
