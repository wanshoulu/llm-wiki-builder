"""Schema 解析 / 思维链裁剪 / 目录树 / 文档图谱 — 纯函数层（自 wiki_chat.py 移植）。"""

from __future__ import annotations

import json
import re
from typing import Optional

from .storage import _list_wiki_pages, _read_wiki_page


# ─── 思维链裁剪 ─────────────────────────────────────────────

def _strip_reasoning_from_markdown(text: str, system_prompt: str = "") -> str:
    """裁剪 LLM 输出中的思维链前缀，仅保留结构化内容。"""
    if not text:
        return text
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()
    # 0) 整体被 ```markdown 围栏包裹时先剥掉（锚定全文，避免误伤内嵌代码块）
    fence = re.match(r'^\s*```(?:markdown|md)?[ \t]*\r?\n(.*?)\r?\n?[ \t]*```\s*$', text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    # 1) 定位 YAML frontmatter 起点
    m = re.search(r'^---[ \t]*\r?\n(?:title|name|description)\s*:', text, re.MULTILINE)
    if m and m.start() > 0:
        return text[m.start():].strip()
    # 2) 定位第一个 Markdown 标题，前面较长前缀视为推理
    m = re.search(r'^#{1,4}\s+\S', text, re.MULTILINE)
    if m and m.start() > 0:
        prefix = text[:m.start()].strip()
        if len(prefix) > 20:
            return text[m.start():].strip()
    return text


# ─── Schema 解析为目录树 ─────────────────────────────────────

def _parse_schema_to_toc(schema_text: str) -> dict:
    """解析 Schema 文本为目录树结构，兼容多种 LLM 输出格式。"""
    tree = []
    cross_refs = []
    topics = []  # 扁平主题列表，供 fill_topics 等使用
    current_category = None
    topic_count = 0
    seen_categories: set[str] = set()
    seen_keys: set[str] = set()
    seen_refs: set[tuple] = set()
    skip_mode = False

    for line in schema_text.split('\n'):
        line = line.rstrip()
        cat_match = re.match(r'^[\s-]*📁\s+(.+?)\s*\|', line)
        if cat_match:
            cat_name = cat_match.group(1).strip()
            if cat_name in seen_categories:
                skip_mode = True
                current_category = None
                continue
            seen_categories.add(cat_name)
            skip_mode = False
            cat_label = {"entities": "实体页", "concepts": "概念页"}.get(cat_name, cat_name)
            current_category = {"key": cat_name, "title": cat_label, "type": "category", "children": []}
            tree.append(current_category)
            continue
        topic_match = re.match(r'^[\s-]*📄\s+(.+?)\s*\|', line)
        if topic_match and current_category and not skip_mode:
            topic_name = topic_match.group(1).strip()
            key = f"{current_category['key']}/{topic_name}.md"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            estimated = 0
            tags = []
            est_m = re.search(r'estimated:\s*(\d+)', line)
            if est_m:
                estimated = int(est_m.group(1))
            tags_m = re.search(r'tags:\s*([^\|]+)', line)
            if tags_m:
                tags = [t.strip() for t in tags_m.group(1).split(',') if t.strip()]
            topic_info = {
                "key": key,
                "title": topic_name,
                "type": "document",
                "category": current_category["key"],
                "estimated": estimated,
                "tags": tags,
            }
            current_category["children"].append(topic_info)
            topics.append(topic_info)
            topic_count += 1
            continue
        ref_match = re.match(r'^[\s-]*\[\[(.+?)\]\]\s*[→\->]+\s*\[\[(.+?)\]\]\s*[:：]\s*(.+)', line)
        if ref_match:
            from_name = ref_match.group(1).strip()
            to_name = ref_match.group(2).strip()
            ref_key = (from_name, to_name)
            if ref_key in seen_refs:
                continue
            seen_refs.add(ref_key)
            cross_refs.append({
                "from": from_name,
                "to": to_name,
                "label": ref_match.group(3).strip(),
            })

    return {"tree": tree, "cross_refs": cross_refs, "topic_count": topic_count, "topics": topics}


def _extract_topic_body(raw: str, title: str) -> str:
    """从单主题 LLM 输出中提取正文，丢弃 reasoning 前缀。"""
    if not raw:
        return ""
    text = re.sub(r'<think>.*?</think>', '', raw, flags=re.DOTALL).strip()
    m = re.search(
        r'^---\s*\n(?:knowledge_id|title|name|description)\s*:',
        text,
        re.MULTILINE,
    )
    if m:
        candidate = text[m.start():].strip()
        heading = re.search(r'^#\s+\S', candidate, re.MULTILINE)
        if heading:
            frontmatter_region = candidate[4:heading.start()]
            if not re.search(r'\n---\s*\n', frontmatter_region):
                candidate = (
                    candidate[:heading.start()].rstrip()
                    + "\n---\n"
                    + candidate[heading.start():]
                )
        return candidate
    esc = re.escape(title)
    m = re.search(rf'^#\s*{esc}\s*$', text, re.MULTILINE)
    if m:
        return text[m.start():].strip()
    m = re.search(r'^#\s+\S', text, re.MULTILINE)
    if m and m.start() > 20:
        return text[m.start():].strip()
    return text


# ─── 文本工具 ───────────────────────────────────────────────

def _count_lines(text: str) -> int:
    """统计有效行数（非空行）"""
    return len([l for l in text.split('\n') if l.strip()])


def _normalize_page_name(page_name: str) -> str:
    """从页面路径中提取页面名（去掉路径前缀和 .md 后缀）"""
    name = page_name.rsplit('/', 1)[-1]
    if name.endswith('.md'):
        name = name[:-3]
    return name.strip()


def _title_to_page_name(title: str) -> str:
    """主题标题转为文件名"""
    return re.sub(r'[^\w一-鿿]+', '_', title).strip('_') + ".md"


def _schema_looks_truncated(text: str) -> bool:
    """Schema 截断检测：输出是否在自然边界结束（无交叉引用/统计区且末行不完整即疑似截断）。"""
    stripped = text.rstrip()
    if '## 交叉引用' in stripped or '## 交叉引用图' in stripped:
        return False
    if '## 知识库统计' in stripped or '## 知识库系统' in stripped:
        return False
    last_lines = [l for l in stripped.split('\n') if l.strip()]
    if last_lines:
        last = last_lines[-1].strip()
        if '📄' in last and 'tags:' in last:
            return False
        if last == '```' or last.startswith('```'):
            return False
        if '📄' in last and 'tags:' not in last:
            return True
    return True


def _safe_json_parse(text: str, is_array: bool = False) -> Optional[dict | list]:
    """解析 LLM 输出中的 JSON（容忍 markdown 代码块包裹）。解析失败返回 None。"""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`").strip()
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].strip()
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, list) and is_array:
            return parsed
        if isinstance(parsed, dict) and not is_array:
            return parsed
    except Exception:
        return None
    return None


def _extract_schema_title(schema_text: str) -> str:
    """从 Schema 提取知识库名称：优先 YAML frontmatter 标题，兜底第一个 Markdown H1。"""
    text = schema_text or ""
    m = re.search(r'^---[ \t]*\r?\n(?:title|name)\s*:\s*(.+?)\s*$', text, re.MULTILINE)
    if m:
        title = m.group(1).strip().strip('"\'')
        if title:
            return title[:120]
    m = re.search(r'^#\s+(.+?)\s*$', text, re.MULTILINE)
    if m:
        title = re.sub(r'^SCHEMA\s*[—\-–:：]\s*', '', m.group(1).strip(), flags=re.IGNORECASE).strip()
        if title:
            return title[:120]
    return ""


# ─── index.md 程序化生成 ────────────────────────────────────

def _generate_index_from_schema(schema_text: str) -> str:
    """从 SCHEMA 文本程序化生成 index.md（无需 LLM 调用）。"""
    toc = _parse_schema_to_toc(schema_text)
    lines = ["# 索引目录", ""]
    for cat in toc.get("tree", []):
        if cat.get("type") != "category":
            continue
        lines.append(f"## {cat.get('title') or cat.get('key')}")
        lines.append("")
        for child in cat.get("children", []):
            title = child.get("title", "")
            key = child.get("key", "")
            if title and key:
                lines.append(f"- [[{key}|{title}]]")
        lines.append("")
    if len(lines) <= 2:
        return ""
    return "\n".join(lines).rstrip() + "\n"


# ─── 文档关系图（纯规则扫描） ────────────────────────────────

def _resolve_wikilink_target(target: str, page_set: set[str]) -> str:
    """把 [[target|alias]] 的 target 解析为实际页面路径，匹配不到返回空串。"""
    t = target.strip()
    if not t:
        return ""
    if t in page_set:
        return t
    if not t.endswith(".md") and f"{t}.md" in page_set:
        return f"{t}.md"
    return ""


def _build_doc_graph(wiki_id: str) -> dict:
    """构建文档关系图：节点 = Schema 主题，边 = 交叉引用 + 同类主题互联 + 正文 [[wikilink]]。

    优先基于 Schema 主题（与目录树一致）；无 Schema 时回退到磁盘文件扫描。
    纯规则扫描，秒级完成，不依赖 LLM。
    """
    schema_files = {"_schema.md", "SCHEMA.md", "schema.md", "_Schema.md", "index.md", "log.md"}

    schema_content = ""
    for name in ("SCHEMA.md", "_schema.md", "schema.md", "_Schema.md"):
        c = _read_wiki_page(wiki_id, name)
        if c:
            schema_content = c
            break

    if schema_content:
        toc = _parse_schema_to_toc(schema_content)
        topics = toc.get("topics", [])
        if topics:
            nodes = []
            title_to_key: dict[str, str] = {}
            for t in topics:
                key = t.get("key") or f"{t.get('category', '')}/{t.get('title')}.md"
                title = t.get("title") or key
                nodes.append({
                    "id": key,
                    "label": title,
                    "type": "document",
                    "entity_type": "Document",
                    "category": t.get("category", ""),
                })
                title_to_key[title] = key

            edges = []
            edge_keys: set[tuple] = set()

            def _add_edge(src, tgt, label):
                if not src or not tgt or src == tgt:
                    return
                k = (src, tgt)
                if k in edge_keys:
                    return
                edge_keys.add(k)
                edges.append({
                    "id": f"e{len(edges)}",
                    "source": src,
                    "target": tgt,
                    "label": label,
                    "type": "ref",
                })

            for ref in toc.get("cross_refs", []):
                _add_edge(
                    title_to_key.get(ref.get("from")),
                    title_to_key.get(ref.get("to")),
                    (ref.get("label") or "引用")[:20],
                )

            by_cat: dict[str, list[str]] = {}
            for t in topics:
                key = t.get("key") or f"{t.get('category', '')}/{t.get('title')}.md"
                by_cat.setdefault(t.get("category", ""), []).append(key)
            for cat_keys in by_cat.values():
                for i in range(len(cat_keys) - 1):
                    _add_edge(cat_keys[i], cat_keys[i + 1], "同类")

            for t in topics:
                src_key = t.get("key") or f"{t.get('category', '')}/{t.get('title')}.md"
                content = _read_wiki_page(wiki_id, src_key)
                if not content:
                    continue
                for m in re.finditer(r"\[\[([^\]]+)\]\]", content):
                    raw_target = m.group(1).strip()
                    target_name = raw_target.split("|")[0].split("#")[0].strip()
                    if not target_name:
                        continue
                    resolved = title_to_key.get(target_name)
                    if not resolved:
                        for title, key in title_to_key.items():
                            if target_name in title or title in target_name:
                                resolved = key
                                break
                    if resolved and resolved != src_key:
                        _add_edge(src_key, resolved, "引用")

            return {
                "nodes": nodes,
                "edges": edges,
                "stats": {
                    "graph_type": "document_v3",
                    "total_documents": len(nodes),
                    "total_entities": len(nodes),
                    "total_relations": len(edges),
                },
            }

    def _is_internal(p: str) -> bool:
        base = p.split("/")[-1]
        return base.startswith("_") or base in schema_files or p.startswith("raw/") or p.startswith("_reports/")

    pages = [p for p in _list_wiki_pages(wiki_id)
             if p.endswith(".md") and not _is_internal(p)]
    page_set = set(pages)

    nodes = []
    for p in sorted(pages):
        label = p.split("/")[-1][:-3] if p.endswith(".md") else p
        nodes.append({
            "id": p,
            "label": label,
            "type": "document",
            "entity_type": "Document",
        })

    edges = []
    edge_keys: set[tuple] = set()
    for src in pages:
        content = _read_wiki_page(wiki_id, src)
        if not content:
            continue
        for m in re.finditer(r"\[\[([^\]]+)\]\]", content):
            raw = m.group(1).strip()
            target = raw.split("|")[0].split("#")[0].strip()
            resolved = _resolve_wikilink_target(target, page_set)
            if not resolved or resolved == src:
                continue
            key = (src, resolved)
            if key in edge_keys:
                continue
            edge_keys.add(key)
            edges.append({
                "id": f"e{len(edges)}",
                "source": src,
                "target": resolved,
                "label": "引用",
                "type": "link",
            })

    return {
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "graph_type": "document_v3",
            "total_documents": len(nodes),
            "total_entities": len(nodes),
            "total_relations": len(edges),
        },
    }


# ─── 目录树辅助（无 Schema 兜底 + 三层结构补全） ────────────

def _pages_to_toc(pages: list[str]) -> dict:
    """无 Schema 时，将实际页面路径列表构造为目录树（按目录分组）"""
    root_children: list[dict] = []
    dir_map: dict[str, dict] = {}
    topics: list[dict] = []
    for rel in sorted(pages):
        parts = rel.split("/")
        fname = parts[-1]
        title = fname[:-3] if fname.endswith(".md") else fname
        if len(parts) == 1:
            root_children.append({"key": rel, "title": title, "type": "document"})
        else:
            dirname = "/".join(parts[:-1])
            if dirname not in dir_map:
                dir_map[dirname] = {"key": dirname, "title": dirname, "type": "category", "children": []}
                root_children.append(dir_map[dirname])
            dir_map[dirname]["children"].append({"key": rel, "title": title, "type": "document"})
        topics.append({"key": rel, "title": title, "category": "/".join(parts[:-1])})
    return {"tree": root_children, "cross_refs": [], "topic_count": len(pages), "topics": topics}


def _supplement_toc_with_full_structure(toc_data: dict, wiki_id: str) -> dict:
    """在 Schema 解析的 TOC 基础上，补充 raw 层和契约层，形成完整三层结构目录树。"""
    all_pages = _list_wiki_pages(wiki_id)
    tree = list(toc_data.get("tree", []))

    raw_pages = [p for p in all_pages if p.startswith("raw/") and p.endswith(".md")]
    if raw_pages:
        raw_children = []
        for rel in sorted(raw_pages):
            fname = rel.split("/")[-1]
            title = fname[:-3] if fname.endswith(".md") else fname
            raw_children.append({"key": rel, "title": title, "type": "document"})
        # Schema 已声明 raw 类别时合并子节点，避免目录树出现两个 raw 节点
        existing_raw = next(
            (n for n in tree if isinstance(n, dict) and n.get("key") == "raw"), None,
        )
        if existing_raw is not None:
            seen_keys = {c.get("key") for c in existing_raw.get("children", [])}
            existing_raw.setdefault("children", []).extend(
                c for c in raw_children if c["key"] not in seen_keys
            )
        else:
            raw_node = {"key": "raw", "title": "原始文档", "type": "category", "children": raw_children}
            tree.insert(0, raw_node)

    schema_layer_files = {"SCHEMA.md", "index.md", "log.md"}
    schema_children = []
    for fname in ["SCHEMA.md", "index.md", "log.md"]:
        if any(p == fname for p in all_pages):
            title_map = {"SCHEMA.md": "Schema 契约", "index.md": "索引目录", "log.md": "操作日志"}
            schema_children.append({"key": fname, "title": title_map[fname], "type": "document"})
    if schema_children:
        schema_node = {"key": "_schema_layer", "title": "契约层", "type": "category", "children": schema_children}
        tree.append(schema_node)

    toc_data["tree"] = tree
    return toc_data
