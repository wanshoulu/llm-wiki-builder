"""Wiki 导出 — 单文件 HTML / 合并 Markdown（P6 路线图项）。

HTML 走 markdown 库渲染，内联样式，单文件离线可看；
Markdown 为全部知识页按 toc 顺序拼接。
"""

from __future__ import annotations

import html as html_mod
from pathlib import Path

from .storage import _list_wiki_pages, _read_wiki_page

_EXPORT_SKIP_PREFIXES = ("_meta/", "_history/", "_reports/")
_EXPORT_SKIP_PAGES = {"_wiki_graph.json"}


def _export_pages(wiki_id: str) -> list[tuple[str, str]]:
    pages = []
    for page in _list_wiki_pages(wiki_id):
        if not page.endswith(".md"):
            continue
        if page.startswith(_EXPORT_SKIP_PREFIXES) or page in _EXPORT_SKIP_PAGES:
            continue
        content = _read_wiki_page(wiki_id, page)
        if content:
            pages.append((page, content))
    return pages


def _page_title(content: str, fallback: str) -> str:
    for line in content.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return fallback


def _anchor(page: str) -> str:
    return "p-" + "".join(c if c.isalnum() else "-" for c in page)


def export_wiki_markdown(wiki_id: str, title: str = "") -> str:
    """全部知识页合并为一个 Markdown 文档。"""
    pages = _export_pages(wiki_id)
    lines = [f"# {title or wiki_id} — Wiki 导出\n"]
    for page, content in pages:
        lines.append(f"\n\n---\n\n<!-- 页面: {page} -->\n\n{content.strip()}\n")
    return "".join(lines)


def export_wiki_html(wiki_id: str, title: str = "") -> str:
    """全部知识页渲染为单文件 HTML（内联样式 + 侧边目录，可离线浏览）。"""
    import markdown

    pages = _export_pages(wiki_id)
    doc_title = html_mod.escape(title or wiki_id)
    toc_items = []
    sections = []
    for page, content in pages:
        page_title = _page_title(content, page)
        anchor = html_mod.escape(_anchor(page))
        toc_items.append(f'<li><a href="#{anchor}">{html_mod.escape(page_title)}</a>'
                         f'<span class="path">{html_mod.escape(page)}</span></li>')
        body = markdown.markdown(content, extensions=["tables", "fenced_code"])
        sections.append(
            f'<section id="{anchor}"><h1 class="crumb">{html_mod.escape(page)}</h1>\n{body}\n</section>'
        )
    return (
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n"
        f"<title>{doc_title}</title>\n<style>\n"
        "body{font-family:'Segoe UI','Microsoft YaHei',sans-serif;margin:0;display:flex;}"
        "nav{width:280px;flex-shrink:0;border-right:1px solid #ddd;padding:16px;"
        "height:100vh;overflow:auto;background:#fafafa;}"
        "nav ul{list-style:none;padding-left:0;}nav li{margin:6px 0;}"
        "nav .path{display:block;color:#999;font-size:11px;margin-left:8px;}"
        "main{padding:24px 40px;max-width:860px;}"
        "table{border-collapse:collapse;}td,th{border:1px solid #ccc;padding:4px 10px;}"
        "code{background:#f4f4f4;padding:1px 4px;border-radius:3px;}"
        "pre code{display:block;padding:10px;overflow:auto;}"
        ".crumb{color:#888;font-size:13px;font-weight:normal;border-bottom:1px dashed #eee;"
        "padding-bottom:4px;}"
        "section{border-bottom:2px solid #eee;padding-bottom:32px;margin-bottom:32px;}"
        "</style>\n</head>\n<body>\n"
        f"<nav><h3>{doc_title}</h3><ul>{''.join(toc_items)}</ul></nav>\n"
        f"<main>{''.join(sections)}</main>\n</body>\n</html>\n"
    )


def export_to_reports(wiki_id: str, fmt: str, title: str = "") -> Path:
    """导出并落盘到 _reports/exports/，返回文件路径（供 agent 工具引用）。"""
    import datetime

    from .storage import _wiki_project_dir

    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = _wiki_project_dir(wiki_id) / "_reports" / "exports"
    out_dir.mkdir(parents=True, exist_ok=True)
    if fmt == "html":
        out = out_dir / f"wiki-export.{ts}.html"
        out.write_text(export_wiki_html(wiki_id, title), encoding="utf-8")
    else:
        out = out_dir / f"wiki-export.{ts}.md"
        out.write_text(export_wiki_markdown(wiki_id, title), encoding="utf-8")
    return out
