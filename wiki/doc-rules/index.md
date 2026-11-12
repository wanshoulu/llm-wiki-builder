---
title: doc-rules 知识库说明
type: summary
---

# doc-rules 公文审核知识库

公文审核 Agent（doc-review-agent）的专用知识库，`knowledge-source.js` 中 `isLegacy = (id === 'doc-rules')` 直通，mode = legacy。

## 结构

- `_common/`：通用规范（格式档案、检查规则、标点、版头、版记、附件、修改规则、溯源引用、行文方向）
- `doc-types/`：分文种规则页（notice/request/report/letter/reply/meeting + others 速查）
- `lexicon/`：忌用词词典
- `style/`：语言风格提示词

## 消费点

| 模块 | 消费页面 |
| --- | --- |
| profile-loader.js | _common/format-profiles.md（档案参数 + 文种映射 + fallback_profile） |
| lexicon-loader.js | lexicon/taboo-words.md |
| knowledge-recaller.js | doc-types/<type>.md（文种页）、_common/format-profiles.md、标点/风格小节 |
| tools.js search_knowledge | 全库按分类检索（格式规范/文种规范/语言风格） |
| citations.js | _common/citations.md（三表对齐） |

## 重建说明

本库于 2026-10-17 重建：原库内容在仓库重定位（commit 2197dc89）前未提交 git、随后丢失；本次按各消费模块源码中的规则定义与表结构约定逆向重建，并通过模块单测语义（loader 解析格式）验证。
