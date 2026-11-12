"""Failure guards for structured Wiki generation."""

from __future__ import annotations

import re

import yaml


DOCUMENT_REVIEW_PROFILE_ID = "document-review"
DOCUMENT_REVIEW_TOPIC_TIMEOUT_SECONDS = 90
MIN_DOCUMENT_REVIEW_TOPIC_CHARS = 200


class WikiStructuredGenerationError(RuntimeError):
    """Raised when a model cannot produce a usable structured Wiki artifact."""


_SCHEMA_TOPIC_RE = re.compile(r"(?m)^\s*📄\s*([^|\r\n]+?)\s*\|")
_INDEX_REFUSAL_MARKERS = (
    "未收到",
    "请将完整 schema",
    "请提供完整 schema",
    "无法生成 index",
    "无法生成索引",
)


def _structured_failure(stage: str, reason: str) -> WikiStructuredGenerationError:
    return WikiStructuredGenerationError(
        f"公文审核 Wiki 的{stage}失败：{reason}。"
        "本次构建已停止，旧产物和原始材料未被覆盖。"
        "请切换非推理模型或缩小单次材料范围后重试。"
    )


def _schema_topic_titles(body: str) -> list[str]:
    return [match.strip() for match in _SCHEMA_TOPIC_RE.findall(body or "") if match.strip()]


def validate_document_review_schema(
    body: str,
    *,
    stage: str,
    existing_schema: str = "",
    truncated: bool = False,
) -> str:
    """Validate a complete document-review Schema before it can replace an old one."""
    cleaned = (body or "").strip()
    if truncated:
        raise _structured_failure(stage, "模型输出达到上限，SCHEMA 不完整")
    if not cleaned:
        raise _structured_failure(stage, "模型只输出了推理内容或空结果")
    if "## 知识地图" not in cleaned:
        raise _structured_failure(stage, "缺少可解析的“## 知识地图”")

    current_topics = _schema_topic_titles(cleaned)
    if not current_topics:
        raise _structured_failure(stage, "没有生成任何可解析的 📄 页面")

    if existing_schema:
        previous_topics = _schema_topic_titles(existing_schema)
        missing = [title for title in previous_topics if title not in current_topics]
        if missing:
            preview = "、".join(missing[:5])
            if len(missing) > 5:
                preview += f"等 {len(missing)} 个页面"
            raise _structured_failure(stage, f"增量结果遗漏现有页面：{preview}")
    return body


def check_generic_schema_completeness(body: str, *, existing_schema: str = "") -> list[str]:
    """Soft-check that an incremental generic-profile Schema doesn't silently drop pages.

    Unlike validate_document_review_schema this never raises — it returns
    a list of missing page titles so the caller can emit a non-fatal warning.
    """
    if not existing_schema:
        return []
    cleaned = (body or "").strip()
    if not cleaned or "## 知识地图" not in cleaned:
        return []
    current_topics = _schema_topic_titles(cleaned)
    previous_topics = _schema_topic_titles(existing_schema)
    if not previous_topics:
        return []
    return [title for title in previous_topics if title not in current_topics]


def validate_document_review_index(body: str, *, truncated: bool = False) -> str:
    """Reject empty, truncated or refusal-style index output before persistence."""
    cleaned = (body or "").strip()
    if truncated:
        raise _structured_failure("Index 生成", "模型输出达到上限，索引不完整")
    if not cleaned:
        raise _structured_failure("Index 生成", "模型只输出了推理内容或空结果")
    folded = cleaned.casefold()
    if any(marker in folded for marker in _INDEX_REFUSAL_MARKERS):
        raise _structured_failure("Index 生成", "模型返回了拒答或索要上下文的话术")
    if "](" not in cleaned and "[[" not in cleaned:
        raise _structured_failure("Index 生成", "索引中没有任何可导航页面链接")
    return body


def document_review_structured_timeout_error(stage: str) -> WikiStructuredGenerationError:
    """Build a consistent actionable timeout error for Schema/Update/Index stages."""
    return _structured_failure(
        stage,
        f"模型在 {DOCUMENT_REVIEW_TOPIC_TIMEOUT_SECONDS} 秒内没有返回完整结构化正文",
    )


def validate_document_review_topic_body(title: str, body: str) -> str:
    """Reject reasoning-only/empty document-review output before the batch can drift."""
    cleaned = (body or "").strip()
    if len(cleaned) < MIN_DOCUMENT_REVIEW_TOPIC_CHARS:
        raise WikiStructuredGenerationError(
            f"公文审核 Wiki 在页面「{title}」未获得有效正文。"
            "当前模型可能只输出了推理内容；本次构建已停止，原始材料已保留。"
            "请切换非推理模型后从 raw 层继续构建。"
        )
    frontmatter = re.match(r"^---\s*\n(.*?)\n---\s*(?:\n|$)", cleaned, re.DOTALL)
    if not frontmatter:
        raise WikiStructuredGenerationError(
            f"公文审核 Wiki 页面「{title}」缺少完整 YAML frontmatter，已停止整批构建。"
            "原始材料已保留，请从 raw 层继续构建。"
        )
    metadata_text = frontmatter.group(1)
    try:
        metadata = yaml.safe_load(metadata_text)
    except yaml.YAMLError as exc:
        raise WikiStructuredGenerationError(
            f"公文审核 Wiki 页面「{title}」的 YAML frontmatter 无法解析，已停止整批构建。"
            "原始材料已保留，请从 raw 层继续构建。"
        ) from exc
    if not isinstance(metadata, dict):
        raise WikiStructuredGenerationError(
            f"公文审核 Wiki 页面「{title}」的 YAML frontmatter 不是键值对象，已停止整批构建。"
            "原始材料已保留，请从 raw 层继续构建。"
        )
    for required_key in ("knowledge_id", "title"):
        if not str(metadata.get(required_key) or "").strip():
            raise WikiStructuredGenerationError(
                f"公文审核 Wiki 页面「{title}」的 YAML frontmatter 缺少有效字段 "
                f"{required_key}，已停止整批构建。原始材料已保留，请从 raw 层继续构建。"
            )
    return cleaned
