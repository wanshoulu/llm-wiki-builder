"""模型路由单测 — 公文审核 profile 自动避开 reasoning 模型（从 ontomind-agent 迁移）。"""

from app.main import _model_capabilities, select_profile_model_id
from app.profiles import DOCUMENT_REVIEW_PROFILE_ID, GENERIC_PROFILE_ID


def _model(model_id, capabilities=""):
    return {"modelId": model_id, "capabilities": capabilities}


MODELS = [
    _model("deepseek-r1", "reasoning,chat"),
    _model("qwen-flash", "extraction,chat"),
    _model("qwen-plus", "extraction,reasoning"),
]


def test_generic_profile_never_reroutes():
    # 通用库不做能力路由，用户选什么用什么
    assert select_profile_model_id(GENERIC_PROFILE_ID, "deepseek-r1", MODELS) == "deepseek-r1"


def test_document_review_reroutes_reasoning_model_to_extraction_model():
    routed = select_profile_model_id(DOCUMENT_REVIEW_PROFILE_ID, "deepseek-r1", MODELS)
    assert routed == "qwen-flash"


def test_document_review_keeps_non_reasoning_model():
    routed = select_profile_model_id(DOCUMENT_REVIEW_PROFILE_ID, "qwen-flash", MODELS)
    assert routed == "qwen-flash"


def test_document_review_falls_back_when_no_compatible_model():
    only_reasoning = [_model("deepseek-r1", "reasoning,chat")]
    assert select_profile_model_id(
        DOCUMENT_REVIEW_PROFILE_ID, "deepseek-r1", only_reasoning
    ) == "deepseek-r1"


def test_document_review_falls_back_when_model_unknown():
    # 请求的模型不在列表中：保持原值（不做猜测）
    assert select_profile_model_id(
        DOCUMENT_REVIEW_PROFILE_ID, "missing-model", MODELS
    ) == "missing-model"


def test_capabilities_accepts_list_or_comma_string():
    assert _model_capabilities({"capabilities": ["Reasoning", " Chat "]}) == {"reasoning", "chat"}
    assert _model_capabilities({"capabilities": "extraction, chat"}) == {"extraction", "chat"}
    assert _model_capabilities({}) == set()
