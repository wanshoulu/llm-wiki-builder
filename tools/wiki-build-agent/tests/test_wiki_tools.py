"""wiki_tools 单测 — bridge 请求级隔离（P0-3 并发串扰回归）。"""

import asyncio

import pytest

from app.wiki_tools import WikiBridge, get_bridge, set_bridge


@pytest.mark.asyncio
async def test_bridge_contextvar_isolation():
    """每个请求 set_bridge 写入自己的 contextvar，并发请求互不可见。"""
    req_a, req_b = WikiBridge(), WikiBridge()

    async def other_request(bridge: WikiBridge) -> WikiBridge:
        set_bridge(bridge)
        await asyncio.sleep(0.01)
        return get_bridge()

    set_bridge(req_a)
    results = await asyncio.gather(other_request(req_b), other_request(req_b))
    assert all(r is req_b for r in results)
    # 请求 A 的上下文未被并发请求 B 污染
    assert get_bridge() is req_a


@pytest.mark.asyncio
async def test_bridge_default_without_request():
    """未 set_bridge 时返回模块默认实例，不抛错（模块导入/非请求场景）。"""
    assert isinstance(get_bridge(), WikiBridge)
