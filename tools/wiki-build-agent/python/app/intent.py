"""意图判断 — 仅保留重流水线快路径（Phase 3 精简）。

旧实现的 22 意图 if/elif + LLM 分类已退役：
- build_wiki / update_wiki 是确定性重流水线（Schema→Index→正文→图谱），
  由关键词 + 文档/库状态快速识别，直连 pipeline；
- 其余所有消息交给 DeepAgent 的 task_loop 自主选工具（system prompt 写路由规则），
  不再做前置意图分类——模型看到消息与工具描述即可路由。
"""

from __future__ import annotations

from typing import Optional

_BUILD_KEYWORDS = ["构建wiki", "全量构建", "新建wiki", "创建wiki", "build wiki", "建知识库", "构建知识库"]
_UPDATE_KEYWORDS = ["更新", "增量", "追加文档", "补充文档", "添加文档", "update"]
# 含这些词的查询是在"问更新相关内容"（如查看更新日志），不是要执行增量更新
_UPDATE_EXCLUDE_KEYWORDS = ["更新日志", "更新记录", "变更记录", "变更日志", "更新说明"]


def detect_pipeline_intent(message: str, has_docs: bool, has_wiki_id: bool) -> Optional[str]:
    """识别是否直连重流水线。返回 None 表示交给 Agent 自主处理。

    - update 关键词 + 已有库 → update_wiki（排除"更新日志"等查询型表述）
    - build 关键词 → build_wiki
    - 默认行为（与旧实现一致）：带新文档 + 已有库 → update_wiki；带新文档无库 → build_wiki
    """
    msg = message.lower()
    if (
        has_wiki_id
        and any(kw in msg for kw in _UPDATE_KEYWORDS)
        and not any(kw in msg for kw in _UPDATE_EXCLUDE_KEYWORDS)
    ):
        return "update_wiki"
    if any(kw in msg for kw in _BUILD_KEYWORDS):
        return "build_wiki"
    if has_docs and has_wiki_id:
        return "update_wiki"
    if has_docs:
        return "build_wiki"
    return None
