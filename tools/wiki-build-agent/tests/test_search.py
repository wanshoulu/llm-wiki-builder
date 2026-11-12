"""search 单测 — BM25 检索（路线图 P1）。"""

import pytest

from app import storage as st
from app.search import _passages, _tokenize, search_wiki_pages


@pytest.fixture
async def seeded_wiki(tmp_wiki_root):
    await st._save_wiki_page(
        "w1", "concepts/差旅报销.md",
        "# 差旅报销\n\n员工出差交通费凭发票报销。\n\n住宿费按城市限额标准执行。\n",
    )
    await st._save_wiki_page(
        "w1", "entities/发票.md",
        "# 发票\n\n增值税发票需要在开票后 90 天内认证。\n",
    )
    await st._save_wiki_page(
        "w1", "raw/制度原文.md",
        "# 制度原文\n\n第五章 住宿费标准：处级人员每晚 400 元。\n",
    )
    return "w1"


def test_tokenize_cjk_bigram_and_ascii():
    tokens = _tokenize("住宿费 API")
    assert "住宿" in tokens and "宿费" in tokens
    assert "api" in tokens


def test_passages_split_long_text():
    text = "\n\n".join(f"段落{i}{content}" for i, content in enumerate(["字" * 300] * 6))
    chunks = _passages(text)
    assert len(chunks) >= 2
    assert all(len(c) <= 420 for c in chunks)


@pytest.mark.asyncio
async def test_search_ranks_relevant_page_first(seeded_wiki):
    hits = search_wiki_pages(seeded_wiki, "住宿费 限额", top_k=5)
    assert hits
    assert hits[0]["page"] == "concepts/差旅报销.md"
    assert "住宿" in hits[0]["snippet"]


@pytest.mark.asyncio
async def test_search_includes_raw_layer(seeded_wiki):
    hits = search_wiki_pages(seeded_wiki, "住宿费标准 处级", top_k=5)
    assert "raw/制度原文.md" in {h["page"] for h in hits}


@pytest.mark.asyncio
async def test_search_ascii_query(seeded_wiki):
    hits = search_wiki_pages(seeded_wiki, "增值税 认证")
    assert hits and hits[0]["page"] == "entities/发票.md"


@pytest.mark.asyncio
async def test_search_empty_query_or_no_hit(seeded_wiki):
    assert search_wiki_pages(seeded_wiki, "") == []
    assert search_wiki_pages(seeded_wiki, "量子波动速读") == []


@pytest.mark.asyncio
async def test_search_excludes_navigation_and_history(seeded_wiki):
    await st._save_wiki_page("w1", "index.md", "# 索引\n住宿费 住宿费 住宿费")
    await st._save_wiki_page("w1", "concepts/差旅报销.md", "# 差旅报销 v2\n新的住宿费描述。")
    hits = search_wiki_pages(seeded_wiki, "住宿费", top_k=20)
    pages = {h["page"] for h in hits}
    assert "index.md" not in pages
    assert not any(p.startswith("_history/") for p in pages)
