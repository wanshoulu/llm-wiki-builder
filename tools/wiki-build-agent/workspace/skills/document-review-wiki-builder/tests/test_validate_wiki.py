import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts" / "validate_wiki.py"

VALID_PAGE = """---
knowledge_id: DOC-REQUEST-001
title: 请示应当一文一事
knowledge_domain: document-type-and-format
knowledge_type: mandatory-rule
document_type_ids: [DOC-TYPE-REQUEST]
review_dimensions: [文种, 内容结构]
applicable_scope:
  organization_ids: [ORG-ALL]
  direction: upward
  business_domain_ids: [DOMAIN-GENERAL]
requirement_level: mandatory
execution_mode: hybrid
status: published
effective_date: 2026-01-01
owner_role: 办公室制度Owner
source:
  source_id: SRC-001
  clause_id: CLAUSE-010
  source_text: 请示应当一文一事。
  evidence:
    content_unit_id: UNIT-001
    page: 6
source_level: enterprise
authority_level: internal-policy
overlay_behavior: supplement
conflict_strategy: more_specific
relationships: []
supersedes: []
superseded_by: []
approval:
  approval_record_id: APPROVAL-001
  reviewer_id: USER-001
  reviewer_role: 办公室制度Owner
  reviewed_at: 2026-09-02T10:00:00+08:00
---

# 请示应当一文一事

## 规则摘要
请示中不得包含相互独立的多个审批事项。

## 适用与不适用
- 适用于上行请示。

## 判断方法
1. 识别正文中的请求事项。
2. 判断事项之间是否存在直接依赖。

## 依据
- 公文处理管理办法第十条。
"""

ORG_REGISTRY = """organizations:
  - organization_id: ORG-ALL
    name: 全行
    organization_type: enterprise
    parent_id:
    aliases: []
    status: active
"""
DOC_TYPE_REGISTRY = """document_types:
  - document_type_id: DOC-TYPE-REQUEST
    canonical_name: 请示
    aliases: [申请, 请示件]
    category: 法定公文
    direction: upward
    status: active
"""
SOURCE_REGISTER = """sources:
  - source_id: SRC-001
    title: 公文处理管理办法
    source_level: enterprise
    authority_level: internal-policy
    overlay_behavior: supplement
    conflict_strategy: more_specific
    issuer_organization_id: ORG-ALL
    file_format: docx
    version: '2026'
    effective_date: 2026-01-01
    status: active
    content_unit_ids: [UNIT-001]
"""
DOMAIN_REGISTRY = """business_domains:
  - business_domain_id: DOMAIN-GENERAL
    name: 通用
    status: active
"""
RELEASE_MANIFEST = """release:
  version: 1.0.0
  pages:
    - knowledge_id: DOC-REQUEST-001
      approval_record_id: APPROVAL-001
"""
CANONICAL_DOCUMENT = """document:
  source_id: SRC-001
  file_format: docx
  checksum: sha256:test
content_units:
  - content_unit_id: UNIT-001
    type: paragraph
    text: 请示应当一文一事。
    location: {page: 6, paragraph: 3}
    extraction_method: native
    confidence: 0.99
quality:
  status: passed
  warnings: []
"""
BASE_FILES = {
    "governance/organization-registry.yaml": ORG_REGISTRY,
    "governance/document-type-registry.yaml": DOC_TYPE_REGISTRY,
    "governance/source-register.yaml": SOURCE_REGISTER,
    "governance/business-domain-registry.yaml": DOMAIN_REGISTRY,
    "governance/release-manifest.yaml": RELEASE_MANIFEST,
    "sources/canonical-documents/SRC-001.yaml": CANONICAL_DOCUMENT,
}

class ValidateWikiTests(unittest.TestCase):
    def run_validator(self, files, include_base=True):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            all_files = dict(BASE_FILES) if include_base else {}
            all_files.update(files)
            for name, content in all_files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(VALIDATOR), str(root), "--json"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            )
            payload = json.loads(result.stdout) if result.stdout else {}
            return result, payload

    def test_accepts_publishable_page_with_registered_scope_evidence_and_approval(self):
        result, payload = self.run_validator({"01-document-types/request.md": VALID_PAGE})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["errors"], [])

    def test_rejects_mandatory_rule_without_verbatim_source(self):
        page = VALID_PAGE.replace("  source_text: 请示应当一文一事。\n", "")
        result, payload = self.run_validator({"01-document-types/request.md": page})
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any("source.source_text" in e["message"] for e in payload["errors"]))

    def test_rejects_published_page_with_placeholder_values(self):
        page = VALID_PAGE.replace("owner_role: 办公室制度Owner", "owner_role: TBD")
        result, payload = self.run_validator({"01-document-types/request.md": page})
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any("占位" in e["message"] for e in payload["errors"]))

    def test_rejects_unknown_organization_and_document_type(self):
        page = VALID_PAGE.replace("ORG-ALL", "ORG-MISSING").replace("DOC-TYPE-REQUEST", "DOC-TYPE-MISSING")
        result, payload = self.run_validator({"01-document-types/request.md": page})
        self.assertNotEqual(result.returncode, 0)
        messages = [e["message"] for e in payload["errors"]]
        self.assertTrue(any("机构注册表" in m for m in messages))
        self.assertTrue(any("文种注册表" in m for m in messages))

    def test_rejects_evidence_content_unit_not_in_source_register(self):
        page = VALID_PAGE.replace("UNIT-001", "UNIT-MISSING")
        result, payload = self.run_validator({"01-document-types/request.md": page})
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any("证据单元" in e["message"] for e in payload["errors"]))

    def test_rejects_untyped_or_broken_relationship(self):
        page = VALID_PAGE.replace("relationships: []", "relationships:\n  - target_id: DOC-MISSING-999")
        result, payload = self.run_validator({"01-document-types/request.md": page})
        self.assertNotEqual(result.returncode, 0)
        messages = [e["message"] for e in payload["errors"]]
        self.assertTrue(any("关系类型" in m for m in messages))
        self.assertTrue(any("关联知识不存在" in m for m in messages))

    def test_rejects_published_page_without_external_release_manifest(self):
        files = dict(BASE_FILES)
        files.pop("governance/release-manifest.yaml")
        files["01-document-types/request.md"] = VALID_PAGE
        result, payload = self.run_validator(files, include_base=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any("发布清单" in e["message"] for e in payload["errors"]))

    def test_rejects_unsupported_source_format(self):
        bad_register = SOURCE_REGISTER.replace("file_format: docx", "file_format: proprietary-binary")
        result, payload = self.run_validator({"governance/source-register.yaml": bad_register, "01-document-types/request.md": VALID_PAGE})
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any("文件格式" in e["message"] for e in payload["errors"]))

    def test_rejects_missing_or_failed_canonical_document(self):
        files = dict(BASE_FILES)
        files.pop("sources/canonical-documents/SRC-001.yaml")
        files["01-document-types/request.md"] = VALID_PAGE
        result, payload = self.run_validator(files, include_base=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any("Canonical Document" in e["message"] for e in payload["errors"]))

    def test_rejects_organization_with_unknown_parent(self):
        bad_registry = ORG_REGISTRY.replace("parent_id:\n", "parent_id: ORG-MISSING\n")
        result, payload = self.run_validator({"governance/organization-registry.yaml": bad_registry, "01-document-types/request.md": VALID_PAGE})
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any("父机构" in e["message"] for e in payload["errors"]))

    def test_rejects_structured_rule_with_unknown_scope_or_source(self):
        rule = """rule_id: RULE-001
source: {source_id: SRC-MISSING, content_unit_id: UNIT-001}
rule_type: prohibition
normative_text: 请示应当一文一事。
effect: {requirement_level: mandatory}
scope:
  organization_ids: [ORG-MISSING]
  document_type_ids: [DOC-TYPE-MISSING]
  business_domain_ids: [DOMAIN-GENERAL]
conditions: []
decision: {result: fail, issue_type: multiple-matters}
exceptions: []
execution_mode: hybrid
status: pending_review
"""
        result, payload = self.run_validator({"rules/RULE-001.yaml": rule, "01-document-types/request.md": VALID_PAGE})
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any("结构化规则" in e["message"] for e in payload["errors"]))

    def test_ignores_raw_schema_logs_reports_and_runtime_projection(self):
        files = {
            "01-document-types/request.md": VALID_PAGE,
            "raw/source.md": "# 原始来源\n\n这里不使用知识页 frontmatter。\n",
            "SCHEMA.md": "# Wiki Schema\n",
            "log.md": "# Build log\n",
            "reports/validation.md": "# Validation report\n",
            "dist/doc-review-agent/doc-types/request.md": "# Runtime projection\n",
        }
        result, payload = self.run_validator(files)
        self.assertEqual(result.returncode, 0, payload)

    def test_rejects_unknown_source_level_and_overlay_behavior(self):
        page = VALID_PAGE.replace("source_level: enterprise", "source_level: unknown", 1)
        page = page.replace("overlay_behavior: supplement", "overlay_behavior: bypass", 1)
        result, payload = self.run_validator({"01-document-types/request.md": page})
        self.assertNotEqual(result.returncode, 0)
        messages = [entry["message"] for entry in payload["errors"]]
        self.assertTrue(any("source_level" in message for message in messages))
        self.assertTrue(any("overlay_behavior" in message for message in messages))

    def test_case_evidence_cannot_publish_a_mandatory_rule(self):
        source_register = SOURCE_REGISTER.replace("source_level: enterprise", "source_level: case")
        page = VALID_PAGE.replace("source_level: enterprise", "source_level: case", 1)
        result, payload = self.run_validator({
            "governance/source-register.yaml": source_register,
            "01-document-types/request.md": page,
        })
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any("案例来源不能创设" in entry["message"] for entry in payload["errors"]))

if __name__ == "__main__":
    unittest.main()
