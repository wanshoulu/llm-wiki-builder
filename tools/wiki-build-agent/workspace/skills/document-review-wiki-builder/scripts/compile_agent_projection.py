#!/usr/bin/env python3
"""Compile a governed document-review Wiki into the current review Agent contract."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import yaml


SKILL_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ASSETS = SKILL_ROOT / "assets" / "runtime"
DOMAIN_DIRS = (
    "01-document-type-and-format",
    "02-language-expression",
    "03-content-structure",
    "04-policy-and-regulation",
    "05-business-domain",
    "06-history-and-cases",
)


def load_yaml(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a YAML object")
    return data


def parse_page(path: Path) -> tuple[dict[str, Any], str]:
    raw = path.read_text(encoding="utf-8")
    match = re.match(r"^---\s*\r?\n(.*?)\r?\n---\s*\r?\n?", raw, re.DOTALL)
    if not match:
        return {}, raw
    metadata = yaml.safe_load(match.group(1)) or {}
    if not isinstance(metadata, dict):
        metadata = {}
    return metadata, raw[match.end():].strip()


def safe_cell(value: Any) -> str:
    return str(value or "").replace("|", "\\|").replace("\r", " ").replace("\n", " ").strip()


def released_pages(wiki_root: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    release = load_yaml(wiki_root / "governance" / "release-manifest.yaml").get("release") or {}
    release_ids = {
        row.get("knowledge_id")
        for row in release.get("pages") or []
        if isinstance(row, dict) and row.get("knowledge_id")
    }
    pages: list[dict[str, Any]] = []
    for domain in DOMAIN_DIRS:
        domain_root = wiki_root / domain
        if not domain_root.is_dir():
            continue
        for path in sorted(domain_root.rglob("*.md")):
            metadata, body = parse_page(path)
            knowledge_id = metadata.get("knowledge_id")
            if knowledge_id not in release_ids or metadata.get("status") != "published":
                continue
            pages.append(
                {
                    "path": path,
                    "relative_path": path.relative_to(wiki_root).as_posix(),
                    "metadata": metadata,
                    "body": body,
                }
            )
    return pages, release


def render_format_profiles(document_types: list[dict[str, Any]]) -> str:
    template = (RUNTIME_ASSETS / "format-profiles.md").read_text(encoding="utf-8")
    rows = []
    for row in document_types:
        runtime_type = safe_cell(row.get("runtime_doc_type"))
        if not runtime_type:
            continue
        profile = safe_cell(row.get("format_profile") or "enterprise")
        note = safe_cell(row.get("canonical_name"))
        rows.append(f"| {runtime_type} | {profile} | {note} |")
    if not rows:
        rows.append("| others | enterprise | 未映射文种兜底 |")
    return template.replace("<!-- DOCUMENT_TYPE_MAPPING -->", "\n".join(rows)).rstrip() + "\n"


def render_citations(
    pages: list[dict[str, Any]],
    source_rows: dict[str, dict[str, Any]],
) -> str:
    rule_rows = []
    category_rows: dict[str, tuple[str, str, str]] = {}
    first_fallback: tuple[str, str, str] | None = None

    for page in pages:
        metadata = page["metadata"]
        source = metadata.get("source") or {}
        source_id = source.get("source_id")
        source_row = source_rows.get(source_id) or {}
        source_title = safe_cell(source_row.get("title") or source_id)
        clause = safe_cell(source.get("clause_id") or "文件级")
        title = safe_cell(metadata.get("title") or metadata.get("knowledge_id"))
        rule_id = safe_cell(metadata.get("rule_id") or metadata.get("knowledge_id"))
        if rule_id:
            rule_rows.append(f"| {rule_id} | {source_title} | {clause} | {title} |")
        if first_fallback is None and source_title:
            first_fallback = (source_title, clause, title)
        for dimension in metadata.get("review_dimensions") or []:
            key = safe_cell(dimension)
            if key and key not in category_rows:
                category_rows[key] = (source_title, clause, title)

    if not rule_rows:
        rule_rows.append("| UNCONFIGURED | 未配置 | 文件级 | 当前发布无可投影规则 |")
    rendered_categories = [
        f"| {category} | {source} | {clause} | {title} |"
        for category, (source, clause, title) in sorted(category_rows.items())
    ]
    if not rendered_categories:
        rendered_categories.append("| default | 未配置 | 文件级 | 当前发布无分类兜底 |")
    fallback = first_fallback or ("未配置", "文件级", "当前发布无总则兜底")

    return (
        "# 公文审核规则溯源\n\n"
        "## 规则溯源表\n\n"
        "| rule_id | source | clause | title |\n"
        "|---|---|---|---|\n"
        + "\n".join(rule_rows)
        + "\n\n## 分类兜底表\n\n"
        "| category | source | clause | title |\n"
        "|---|---|---|---|\n"
        + "\n".join(rendered_categories)
        + "\n\n## 总则兜底表\n\n"
        "| source | clause | title |\n"
        "|---|---|---|\n"
        f"| {fallback[0]} | {fallback[1]} | {fallback[2]} |\n"
    )


def render_doc_type_page(
    runtime_type: str,
    canonical_name: str,
    pages: list[dict[str, Any]],
) -> str:
    sections = []
    for page in pages:
        metadata = page["metadata"]
        sections.append(
            f"## {metadata.get('title') or metadata.get('knowledge_id')}\n\n"
            f"> 知识ID：{metadata.get('knowledge_id')}；"
            f"来源：{(metadata.get('source') or {}).get('source_id') or '未登记'}\n\n"
            f"{page['body']}"
        )
    if not sections:
        sections.append("## 待发布规则\n\n当前文种尚无进入发布清单的审核规则。")
    return (
        "---\n"
        f'title: "{canonical_name}审核规则"\n'
        f'doc_type: "{runtime_type}"\n'
        'source_profile: "document-review"\n'
        "---\n\n"
        f"# {canonical_name}审核规则\n\n"
        + "\n\n".join(sections)
        + "\n"
    )


def write_text(output_root: Path, relative: str, content: str) -> str:
    target = output_root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.rstrip() + "\n", encoding="utf-8")
    return target.relative_to(output_root).as_posix()


def compile_projection(wiki_root: Path, output_root: Path) -> dict[str, Any]:
    wiki_root = wiki_root.resolve()
    output_root = output_root.resolve()
    if not wiki_root.is_dir():
        raise ValueError(f"Wiki root does not exist: {wiki_root}")

    doc_data = load_yaml(wiki_root / "governance" / "document-type-registry.yaml")
    source_data = load_yaml(wiki_root / "governance" / "source-register.yaml")
    document_types = [
        row for row in doc_data.get("document_types") or [] if isinstance(row, dict)
    ]
    source_rows = {
        row.get("source_id"): row
        for row in source_data.get("sources") or []
        if isinstance(row, dict) and row.get("source_id")
    }
    pages, release = released_pages(wiki_root)

    by_document_type: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for page in pages:
        for document_type_id in page["metadata"].get("document_type_ids") or []:
            by_document_type[str(document_type_id)].append(page)

    generated = []
    generated.append(
        write_text(
            output_root,
            "_common/format-profiles.md",
            render_format_profiles(document_types),
        )
    )
    generated.append(
        write_text(
            output_root,
            "_common/punctuation-spec.md",
            (RUNTIME_ASSETS / "punctuation-spec.md").read_text(encoding="utf-8"),
        )
    )
    generated.append(
        write_text(
            output_root,
            "_common/citations.md",
            render_citations(pages, source_rows),
        )
    )
    generated.append(
        write_text(
            output_root,
            "style/style-prompts.md",
            (RUNTIME_ASSETS / "style-prompts.md").read_text(encoding="utf-8"),
        )
    )
    generated.append(
        write_text(
            output_root,
            "lexicon/taboo-words.md",
            (RUNTIME_ASSETS / "taboo-words.md").read_text(encoding="utf-8"),
        )
    )

    mapped_ids = set()
    for row in document_types:
        document_type_id = str(row.get("document_type_id") or "")
        runtime_type = str(row.get("runtime_doc_type") or "").strip().lower()
        if not document_type_id or not runtime_type:
            continue
        if not re.fullmatch(r"[a-z0-9_-]+", runtime_type):
            raise ValueError(f"Invalid runtime_doc_type: {runtime_type}")
        mapped_ids.add(document_type_id)
        generated.append(
            write_text(
                output_root,
                f"doc-types/{runtime_type}.md",
                render_doc_type_page(
                    runtime_type,
                    str(row.get("canonical_name") or runtime_type),
                    by_document_type.get(document_type_id, []),
                ),
            )
        )

    other_pages = [
        page
        for page in pages
        if not set(page["metadata"].get("document_type_ids") or []) & mapped_ids
    ]
    generated.append(
        write_text(
            output_root,
            "doc-types/others.md",
            render_doc_type_page("others", "其他文种", other_pages),
        )
    )

    manifest = {
        "profile": "document-review",
        "release_version": release.get("version"),
        "included_knowledge_ids": sorted(
            str(page["metadata"].get("knowledge_id")) for page in pages
        ),
        "generated_files": sorted(generated),
        "source_wiki": str(wiki_root),
    }
    generated.append(
        write_text(
            output_root,
            "projection-manifest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2),
        )
    )
    manifest["generated_files"] = sorted(generated)
    (output_root / "projection-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wiki_root", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = args.output or args.wiki_root / "dist" / "doc-review-agent"
    try:
        manifest = compile_projection(args.wiki_root, output)
    except Exception as exc:
        print(f"Projection failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

