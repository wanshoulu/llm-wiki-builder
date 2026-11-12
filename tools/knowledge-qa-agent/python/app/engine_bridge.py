"""EngineBridge — HTTP 客户端，调用 ai-harbor 的工具 API"""

import httpx
from typing import Any


class EngineBridge:
    def __init__(self, base_url: str, timeout: float = 30.0):
        self._base = base_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=timeout)

    async def call(self, endpoint: str, params: dict[str, Any] | None = None, *, method: str = "POST") -> dict:
        url = self._base + endpoint
        if method == "GET":
            resp = await self._client.get(url)
        else:
            resp = await self._client.post(url, json=params or {})
        resp.raise_for_status()
        return resp.json()

    async def close(self):
        await self._client.aclose()
