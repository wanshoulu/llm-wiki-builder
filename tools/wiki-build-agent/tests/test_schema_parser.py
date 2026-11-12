"""schema_parser 单测 — Schema 解析 / 截断检测 / 正文提取 / 文档图谱 / TOC。"""

import pytest

from app import storage as st
from app.schema_parser import (
    _build_doc_graph,
    _extract_schema_title,
    _extract_topic_body,
    _normalize_page_name,
    _pages_to_toc,
    _parse_schema_to_toc,
    _schema_looks_truncated,
    _strip_reasoning_from_markdown,
    _title_to_page_name,
)

SCHEMA = """# 差旅管理制度知识库

## 知识地图

- 📁 entities | 实体页
  - 📄 差旅报销 | estimated: 400 | tags: 财务,报销
  - 📄 出差审批 | estimated: 300 | tags: 流程
- 📁 concepts | 概念页
  - 📄 报销标准 | estimated: 200 | tags: 标准

## 交叉引用

- [[差旅报销]] → [[出差审批]] : 审批通过后报销
"""


def test_parse_schema_to_toc():
    toc = _parse_schema_to_toc(SCHEMA)
    assert toc["topic_count"] == 3
    keys = [t["key"] for t in toc["topics"]]
    assert "entities/差旅报销.md" in keys
    assert toc["topics"][0]["tags"] == ["财务", "报销"]
    assert [c["key"] for c in toc["tree"]] == ["entities", "concepts"]
    assert toc["cross_refs"] == [{"from": "差旅报销", "to": "出差审批", "label": "审批通过后报销"}]


def test_parse_schema_dedupes_repeated_category_block():
    """重复的类别块（常见于续写拼接）跳过，不产生重复主题。"""
    doubled = SCHEMA + SCHEMA[SCHEMA.index("- 📁 entities"):]
    toc = _parse_schema_to_toc(doubled)
    assert toc["topic_count"] == 3


def test_schema_looks_truncated():
    assert not _schema_looks_truncated(SCHEMA)  # 有交叉引用区：自然结束
    # 末行是主题行但没有 tags（疑似截断）
    assert _schema_looks_truncated("- 📁 entities | 实体页\n  - 📄 半行主题")
    # 代码块包裹收尾视为正常
    assert not _schema_looks_truncated(SCHEMA + "\n```\n")


def test_strip_reasoning_removes_think_block():
    text = "<think>推理过程</think>\n# 标题\n正文"
    assert _strip_reasoning_from_markdown(text) == "# 标题\n正文"


def test_extract_topic_body_prefers_frontmatter():
    raw = "铺垫文字\n---\ntitle: 差旅报销\n---\n# 差旅报销\n正文"
    body = _extract_topic_body(raw, "差旅报销")
    assert body.startswith("---")
    assert "# 差旅报销" in body


def test_extract_topic_body_falls_back_to_heading():
    raw = "杂念\n# 差旅报销\n正文内容"
    assert _extract_topic_body(raw, "差旅报销") == "# 差旅报销\n正文内容"


def test_names():
    assert _normalize_page_name("entities/差旅报销.md") == "差旅报销"
    assert _title_to_page_name("差旅 报销（2026）") == "差旅_报销_2026.md"
    assert _extract_schema_title(SCHEMA) == "差旅管理制度知识库"


@pytest.mark.asyncio
async def test_build_doc_graph(tmp_wiki_root):
    await st._save_wiki_page("w1", "SCHEMA.md", SCHEMA)
    await st._save_wiki_page("w1", "entities/差旅报销.md", "# 差旅报销\n见 [[出差审批]]。")
    await st._save_wiki_page("w1", "entities/出差审批.md", "# 出差审批\n流程说明。")
    graph = _build_doc_graph("w1")
    stats = graph["stats"]
    assert stats["graph_type"] == "document_v3"
    assert stats["total_documents"] >= 2
    node_ids = {n["id"] for n in graph["nodes"]}
    assert "entities/差旅报销.md" in node_ids
    # 正文 wikilink 产生边
    assert any(
        e.get("source") == "entities/差旅报销.md" and e.get("target") == "entities/出差审批.md"
        for e in graph["edges"]
    )


def test_pages_to_toc_groups_by_dir():
    toc = _pages_to_toc(["entities/a.md", "concepts/b.md", "SCHEMA.md"])
    keys = [c["key"] for c in toc["tree"]]
    assert "entities" in keys and "concepts" in keys
    assert toc["topic_count"] == 3
