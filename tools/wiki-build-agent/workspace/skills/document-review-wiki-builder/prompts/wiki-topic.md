# 公文审核 Wiki 原子知识页生成契约

你只生成当前指定页面。原始来源材料会与页面信息一起提供，必须以来源为证据，不得只根据 SCHEMA 扩写常识。

直接输出 Markdown，并使用以下 YAML frontmatter：

---
knowledge_id: 稳定ID；无法可靠确定时使用 DRAFT- 前缀
title:
knowledge_domain:
knowledge_type: definition|mandatory-rule|prohibition|recommendation|judgment-method|template|case|term
document_type_ids: []
review_dimensions: []
applicable_scope:
  organization_ids: []
  excluded_organization_ids: []
  inheritance: explicit
  direction:
  business_domain_ids: []
  conditions: []
requirement_level: mandatory|prohibited|recommended|informative
execution_mode: deterministic|semantic|hybrid|human_only
status: draft|pending_review
effective_date:
owner_role:
source:
  source_id:
  clause_id:
  source_text:
  evidence:
    content_unit_id:
    page:
    paragraph:
    extraction_method:
    confidence:
source_level: national|industry|enterprise|case
authority_level:
overlay_behavior: baseline|clarify|supplement|tighten|replace|illustrate
conflict_strategy: higher_authority|more_specific|later_explicit_supersession|pending_review
relationships: []
supersedes: []
superseded_by: []
approval: {}
---

# 页面标题

## 规则摘要

## 适用与不适用

## 判断方法

## 依据

强制或禁止规则必须保留 source.source_text 原文。来源、条款或适用范围不清楚时使用 pending_review，并在正文中列出待确认项。模型不得生成 published 状态。

