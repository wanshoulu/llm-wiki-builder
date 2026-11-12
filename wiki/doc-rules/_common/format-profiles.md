---
title: 格式档案（四类）
type: 格式规范
doc_type: format-profiles
default_profile: gov
fallback_profile: enterprise
related:
  - "[[_common/format-spec]]"
  - "[[_common/check-rules]]"
  - "[[_common/header-spec]]"
  - "[[_common/tail-spec]]"
  - "[[doc-types/others]]"
---

# 格式档案

格式参数唯一事实源。`profile-loader.js` 按文种加载对应档案参数，`format-checker.js` 与知识召回共用同一数据，避免 LLM 拿到的参数与确定性检查器矛盾。

## 档案参数表

| 参数 | gov | enterprise | regulation | briefing_speech |
| --- | --- | --- | --- | --- |
| page_margin_top_mm | 37 | 30 | 25 | 25 |
| page_margin_bottom_mm | 35 | 30 | 25 | 25 |
| page_margin_left_mm | 28 | 27 | 32 | 25 |
| page_margin_right_mm | 26 | 27 | 32 | 25 |
| margin_tolerance_mm | 2 | 3 | 3 | 4 |
| title_font | 方正小标宋简体 | 方正小标宋简体 | 方正小标宋简体 | 黑体 |
| title_size_pt | 22 | 22 | 22 | 18 |
| title_align | center | center | center | center |
| heading1_font | 黑体 | 黑体 | 黑体 | 黑体 |
| heading1_size_pt | 16 | 16 | 16 | 16 |
| heading2_font | 楷体_GB2312 | 楷体_GB2312 | 楷体_GB2312 | 楷体_GB2312 |
| heading2_size_pt | 16 | 16 | 16 | 16 |
| chapter_font | | | 黑体 | |
| chapter_size_pt | | | 16 | |
| chapter_align | | | center | |
| body_font | 仿宋_GB2312 | 仿宋_GB2312 | 仿宋_GB2312 | 仿宋_GB2312 |
| body_size_pt | 16 | 16 | 16 | 18 |
| body_align | both | both | both | left |
| body_line_spacing_min_pt | 26 | 24 | 24 | 22 |
| body_line_spacing_max_pt | 32 | 32 | 32 | 34 |
| body_first_line_indent_pt | 32 | 32 | 32 | 32 |
| body_first_line_indent_tolerance_pt | 8 | 8 | 8 | 10 |
| body_size_tolerance_pt | 1 | 1 | 1 | 2 |
| check_margins | true | true | true | false |
| check_fonts | true | true | true | false |
| check_sizes | true | true | true | false |
| check_alignment | true | true | true | false |
| check_line_spacing | true | true | true | false |
| check_first_line_indent | true | true | true | false |
| requires_red_header | true | false | false | false |
| requires_version_block | true | false | false | false |
| body_bold_allowed | false | false | true | true |
| skip_punctuation | false | false | false | false |

## 文种 → 档案映射

| doc_type | profile | 备注 |
| --- | --- | --- |
| notice, request, report, letter, reply, meeting, decision, opinion, bulletin, announcement, command, communique, bill, instruction | gov | 党政机关法定文种 |
| regulation, resolution | regulation | 制度类，章节居中 |
| speech, news, summary, briefing | briefing_speech | 讲话/简报类，免版式检查 |
| work_plan, technical_proposal, table_sign | enterprise | 方案/技术文档类 |

未识别文种按 `fallback_profile: enterprise` 宽松检查。

## See Also

- [[_common/format-spec]]
- [[_common/check-rules]]
- [[doc-types/others]]
