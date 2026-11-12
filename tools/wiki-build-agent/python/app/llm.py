"""openjiuwen Model 封装 — 提供旧流水线 LLMGateway 等价的 chat / chat_stream。

所有结构化生成（Schema/正文/Index）都经由 openjiuwen Model 执行，
获得 ModelClientConfig 级别的真实超时、首包超时、空闲超时与重试。
"""

from __future__ import annotations

import logging
from typing import Optional

from openjiuwen.core.foundation.llm import Model, ModelClientConfig, ModelRequestConfig

from .config import llm_config

logger = logging.getLogger("wiki-build-agent.llm")


class WikiModelPool:
    """按 (model_id, temperature) 缓存 Model 实例（线程安全由 GIL + 只读使用保证）。"""

    def __init__(self) -> None:
        self._models: dict[tuple[str, float], Model] = {}

    def get(self, model_id: Optional[str] = None, temperature: Optional[float] = None) -> Model:
        key = (model_id or llm_config.model, temperature if temperature is not None else llm_config.temperature)
        model = self._models.get(key)
        if model is None:
            model = Model(
                ModelClientConfig(
                    client_provider="openai",
                    api_key=llm_config.api_key,
                    api_base=llm_config.api_base,
                    timeout=llm_config.request_timeout,
                    stream_first_chunk_timeout=llm_config.stream_first_chunk_timeout,
                    stream_idle_timeout=llm_config.stream_idle_timeout,
                    max_retries=llm_config.max_retries,
                ),
                ModelRequestConfig(
                    model=key[0],
                    temperature=key[1],
                    max_tokens=llm_config.max_tokens,
                ),
            )
            self._models[key] = model
        return model


_pool = WikiModelPool()


class WikiLLM:
    """LLMGateway 的 openjiuwen 等价物。

    兼容旧调用形态：chat(model=..., messages=..., temperature=..., max_tokens=...) /
    chat_stream(...)（async generator，yield str 增量）。
    """

    def _model(self, model_id: Optional[str], temperature: Optional[float], max_tokens: Optional[int]) -> Model:
        base = _pool.get(model_id, temperature if temperature is not None else llm_config.temperature)
        if max_tokens is not None and max_tokens != llm_config.max_tokens:
            # 个别调用需要不同 token 预算：构造独立实例（不进缓存，避免请求级污染）
            return Model(
                ModelClientConfig(
                    client_provider="openai",
                    api_key=llm_config.api_key,
                    api_base=llm_config.api_base,
                    timeout=llm_config.request_timeout,
                    stream_first_chunk_timeout=llm_config.stream_first_chunk_timeout,
                    stream_idle_timeout=llm_config.stream_idle_timeout,
                    max_retries=llm_config.max_retries,
                ),
                ModelRequestConfig(
                    model=model_id or llm_config.model,
                    temperature=temperature if temperature is not None else llm_config.temperature,
                    max_tokens=max_tokens,
                ),
            )
        return base

    async def chat(
        self,
        *,
        model: Optional[str] = None,
        messages: list[dict],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        api_key: Optional[str] = None,   # 兼容旧签名，实际凭证来自 llm_config
        api_base: Optional[str] = None,
    ) -> str:
        m = self._model(model, temperature, max_tokens)
        result = await m.invoke(messages, temperature=temperature, max_tokens=max_tokens)
        content = getattr(result, "content", "") or ""
        if isinstance(content, list):  # 多段 content 的兼容模型
            content = "".join(str(c) for c in content)
        return content

    async def chat_stream(
        self,
        *,
        model: Optional[str] = None,
        messages: list[dict],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        api_key: Optional[str] = None,
        api_base: Optional[str] = None,
        meta: Optional[dict] = None,
    ):
        """流式生成。传入 meta dict 时，流结束后写入 truncated: bool（finish_reason=length）。"""
        m = self._model(model, temperature, max_tokens)
        truncated = False
        async for chunk in m.stream(messages, temperature=temperature, max_tokens=max_tokens):
            if getattr(chunk, "finish_reason", None) == "length":
                truncated = True
            content = getattr(chunk, "content", None)
            if content:
                yield content
        if meta is not None:
            meta["truncated"] = truncated
