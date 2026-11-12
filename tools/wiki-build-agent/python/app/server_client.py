"""ontomind-server 最小客户端 — 模型路由（公文审核治理）与 file_ids 回退取文档。"""

from __future__ import annotations

import logging
import os
from typing import Optional

import httpx

logger = logging.getLogger("wiki-build-agent.server_client")

SERVER_API_URL = os.getenv("SERVER_API_URL", "http://ontomind-server:8080/api/v1")
SERVICE_TOKEN = os.getenv("KNOWLEDGE_RUNTIME_SERVICE_TOKEN", "")


class ServerClient:
    def __init__(self) -> None:
        self.base_url = SERVER_API_URL.rstrip("/")
        self._client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(base_url=self.base_url, timeout=30)
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def request(self, method: str, path: str, **kwargs) -> object:
        client = await self._get_client()
        headers = kwargs.pop("headers", {}) or {}
        if SERVICE_TOKEN:
            headers.setdefault("X-Knowledge-Service-Token", SERVICE_TOKEN)
        resp = await client.request(method, path, headers=headers, **kwargs)
        resp.raise_for_status()
        if resp.status_code == 204 or not resp.content:
            return {}
        return resp.json()

    async def get_model_provider(self, provider_id: str) -> dict:
        """读取 provider 运行时配置（含 apiUrl/apiKey/models）。"""
        server_root = self.base_url.removesuffix("/api/v1")
        result = await self.request(
            "GET",
            f"{server_root}/api/internal/v1/model-providers/{provider_id}/runtime-config",
        )
        return result if isinstance(result, dict) else {}

    async def list_model_configs(self, provider_id: str) -> list[dict]:
        result = await self.request("GET", f"/model-providers/{provider_id}/models")
        if isinstance(result, dict):
            result = result.get("models") or result.get("data") or []
        return result if isinstance(result, list) else []

    async def get_file_markdown(self, file_id: str) -> tuple[str, str]:
        """获取已上传文档的 Markdown 内容，返回 (content, filename)。"""
        result = await self.request("GET", f"/files/{file_id}/markdown")
        if isinstance(result, dict):
            return str(result.get("content", "")), str(result.get("filename", ""))
        return str(result), ""


_server_client: Optional[ServerClient] = None


def get_server_client() -> ServerClient:
    global _server_client
    if _server_client is None:
        _server_client = ServerClient()
    return _server_client
