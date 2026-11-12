"""BM25 页面检索 — 容器内实现，零外部依赖。

分词策略：CJK 按字符二元（bigram）切分，ASCII 按词元；检索语料以段落块
（约 400 字）为单位，返回 页面 + 得分 + 命中片段，让 agent 按关键词直接
定位知识点，而不是 list+read 整页翻找。对齐 DeepWiki/STORM 类项目
"检索优先"的标准形态的第一步（P1；语义向量检索见路线图 P3 之后）。
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

from .storage import _list_wiki_pages, _read_wiki_page

# 导航性契约文件不进检索语料（结构信息走 toc 端点）
_NAVIGATION_PAGES = {"SCHEMA.md", "index.md", "log.md"}
_SKIP_PREFIXES = ("_reports/", "_meta/", "_history/")

_ASCII_TOKEN_RE = re.compile(r"[a-zA-Z0-9_]+")
_CJK_RUN_RE = re.compile(r"[一-鿿]+")

_K1 = 1.5
_B = 0.75
_PASSAGE_CHARS = 400


def _tokenize(text: str) -> list[str]:
    tokens = [w.casefold() for w in _ASCII_TOKEN_RE.findall(text)]
    for run in _CJK_RUN_RE.findall(text):
        if len(run) == 1:
            tokens.append(run)
        else:
            tokens.extend(run[i:i + 2] for i in range(len(run) - 1))
    return tokens


def _passages(text: str) -> list[str]:
    """按段落聚合为 ~400 字块；整页无换行时按长度硬切。"""
    pages: list[str] = []
    buf = ""
    for para in text.split("\n"):
        para = para.strip()
        if not para:
            continue
        if len(para) > _PASSAGE_CHARS:
            if buf:
                pages.append(buf)
                buf = ""
            for i in range(0, len(para), _PASSAGE_CHARS):
                pages.append(para[i:i + _PASSAGE_CHARS])
            continue
        if len(buf) + len(para) + 1 > _PASSAGE_CHARS:
            pages.append(buf)
            buf = para
        else:
            buf = f"{buf}\n{para}" if buf else para
    if buf:
        pages.append(buf)
    return pages


@dataclass
class Passage:
    page: str
    text: str
    tokens: list[str]


def _load_corpus(wiki_id: str, include_raw: bool) -> list[Passage]:
    corpus: list[Passage] = []
    for page in _list_wiki_pages(wiki_id):
        if not page.endswith(".md"):
            continue
        if page in _NAVIGATION_PAGES:
            continue
        if any(page.startswith(prefix) for prefix in _SKIP_PREFIXES):
            continue
        if page.startswith("raw/") and not include_raw:
            continue
        content = _read_wiki_page(wiki_id, page)
        if not content:
            continue
        for chunk in _passages(content):
            corpus.append(Passage(page=page, text=chunk, tokens=_tokenize(chunk)))
    return corpus


def _bm25_scores(corpus: list[Passage], query_tokens: list[str]) -> list[float]:
    n = len(corpus)
    if n == 0 or not query_tokens:
        return []
    df: dict[str, int] = {}
    for passage in corpus:
        for token in set(passage.tokens):
            df[token] = df.get(token, 0) + 1
    avgdl = sum(len(p.tokens) for p in corpus) / n
    scores = []
    for passage in corpus:
        tf: dict[str, int] = {}
        for token in passage.tokens:
            tf[token] = tf.get(token, 0) + 1
        score = 0.0
        for qt in query_tokens:
            freq = tf.get(qt)
            if not freq:
                continue
            idf = math.log((n - df[qt] + 0.5) / (df[qt] + 0.5) + 1)
            denom = freq + _K1 * (1 - _B + _B * len(passage.tokens) / avgdl)
            score += idf * freq * (_K1 + 1) / denom
        scores.append(score)
    return scores


def search_wiki_pages(
    wiki_id: str, query: str, top_k: int = 8, include_raw: bool = True,
) -> list[dict]:
    """BM25 段落级检索。返回 [{page, score, snippet}]，按得分降序；无命中返回空。"""
    query = (query or "").strip()
    if not query:
        return []
    top_k = max(1, min(int(top_k or 8), 20))
    corpus = _load_corpus(wiki_id, include_raw)
    scores = _bm25_scores(corpus, _tokenize(query))
    ranked = sorted(
        (item for item in zip(scores, corpus) if item[0] > 0),
        key=lambda item: item[0],
        reverse=True,
    )[:top_k]
    return [
        {
            "page": passage.page,
            "score": round(score, 4),
            "snippet": passage.text[:220],
        }
        for score, passage in ranked
    ]
