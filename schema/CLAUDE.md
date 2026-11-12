# LLM Wiki Schema — 对齐 obsidian-wiki 标准

## 三层架构

### Layer 1: sources/ (原始资料 · LLM 只读)
按照来源类型分目录，复制后不可修改:
- sources/articles/     — 网页剪藏、文章、博客
- sources/papers/       — 学术论文、技术文档、白皮书
- sources/transcripts/  — 播客转录、视频字幕、会议记录
- sources/assets/       — 图片、附件、非文本资料
- sources/general/      — 无法归类的文档

### Layer 2: wiki/ (结构化知识 · LLM 维护)
按内容类型分目录，`[[wikilinks]]` 跨目录互链:
- wiki/sources/       — 来源摘要页 (每篇原始文档的核心提炼)
- wiki/entities/      — 实体页 (人/组织/工具/产品)
- wiki/concepts/      — 概念页 (理论/模式/方法论)
- wiki/syntheses/     — 综合分析页 (多源整合、跨领域分析)
- wiki/comparisons/   — 对比分析页 (方案对比、技术选型)
- wiki/index.md       — 知识库索引 (汇总所有页面及摘要)
- wiki/log.md         — 操作日志 (append-only,记录所有操作)
- wiki/hot.md         — 最近活动快照 (活跃页面、最新更新)
- wiki/.manifest.json — Delta 追踪清单 (SHA-256 + 更新时间)

### Layer 3: schema/ (规则层 · 定义结构)
- schema/CLAUDE.md — 本文件 (核心规则)

## 页面格式标准 (YAML Frontmatter)
```yaml
---
title: Page Title
type: source | entity | concept | synthesis | comparison
sources: [list of source files]
related: [[wikilinks]]
tags: [category tags]
created: YYYY-MM-DD
updated: YYYY-MM-DD
provenance:
  extracted: 60%
  inferred: 30%
  ambiguous: 10%
base_confidence: 0.0-1.0
lifecycle: draft | stable | archived
---
```

## Provenance 溯源标记 (声明级)
- 直接提取的事实: 末尾加 ^[extracted]
- LLM推理/合成的结论: 末尾加 ^[inferred]
- 来源矛盾/不明确的信息: 末尾加 ^[ambiguous]

## 核心操作
- Ingest: sources/ → wiki/sources/ (编译新文档, Delta 增量)
- CrossLink: 自动发现未链接提及,织网[[wikilinks]]
- Synthesize: 多源整合 → wiki/syntheses/
- Query: wiki/ → answer → archive (知识复利)
- Lint: wiki/ health check (孤儿页/矛盾/溯源漂移/过期)

## 质量指标
- 实体完整度: >90% · 链接有效性: 100%
- 交叉引用密度: ≥3-5个 · Provenance 最低提取率: ≥40%
