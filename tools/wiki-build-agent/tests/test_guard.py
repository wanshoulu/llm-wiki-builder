"""guard 单测 — 公文审核正文校验（P0-1 参数顺序回归）。"""

import pytest

from app.guard import validate_document_review_topic_body

_VALID_BODY = (
    "---\n"
    "knowledge_id: kb_001\n"
    "title: 差旅报销标准\n"
    "---\n"
    "## 政策要点\n\n"
    "员工出差发生的交通、住宿费用按公司标准报销，须在返程后 15 个工作日内提交申请，"
    "并附行程单、发票等凭证。未经审批的超出部分不予报销。\n\n"
    "## 适用范围\n\n"
    "本标准适用于全体正式员工及经批准的实习、劳务派遣人员因公出差产生的费用管理，"
    "涵盖城市间交通费、住宿费、市内交通费与出差伙食补助。各部门负责人对出差申请的"
    "必要性与预算合理性负责，财务部门依据本标准审核报销凭证的真实性与合规性。\n"
)


def test_topic_guard_accepts_valid_body():
    assert validate_document_review_topic_body("差旅报销标准", _VALID_BODY) == _VALID_BODY.strip()


def test_topic_guard_rejects_missing_frontmatter():
    with pytest.raises(Exception):
        validate_document_review_topic_body("差旅报销标准", "## 只有正文\n" + "内容" * 120)


def test_topic_guard_old_call_form_is_type_error():
    """P0-1 回归：旧调用形态 validate(body, title=...) 让每页校验抛 TypeError，被
    逐页容错吞掉后整批公文审核页面静默跳过。锁定正确的 (title, body) 参数顺序。"""
    with pytest.raises(TypeError):
        validate_document_review_topic_body(_VALID_BODY, title="差旅报销标准")
