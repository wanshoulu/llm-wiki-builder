---
title: 修改规则
type: 格式规范
doc_type: fix-rules
related:
  - "[[_common/check-rules]]"
  - "[[_common/format-profiles]]"
---

# 修改规则

审阅标记（ReviewMark）落地修改时遵循的规则，前端"接受建议"与 apply-marks 依此执行。

## 修改类型

| type | 行为 | 说明 |
| --- | --- | --- |
| replace | 原文替换为 suggested | 标点、日期、忌用词、字号 |
| delete | 删除原文片段 | 多余空格、多余标点、空行 |
| insert | 在指定位置插入 suggested | 缺失结语、缺失要素 |
| comment | 只批注不改动 | 夸张修饰词、行文方向问题、需人工判断项 |

## 执行顺序

1. 先 delete/replace（有明确位置与原文）
2. 再 insert（结语插到落款前，避免位置漂移）
3. comment 最后汇总展示

同一段落多个标记按位置从后往前应用，防止偏移。

## See Also

- [[_common/check-rules]]
- [[_common/format-profiles]]
