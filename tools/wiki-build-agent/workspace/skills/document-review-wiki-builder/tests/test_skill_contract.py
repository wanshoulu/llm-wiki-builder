import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class SkillContractTests(unittest.TestCase):
    def test_skill_declares_build_update_validate_and_publish_modes(self):
        content = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        for token in ["Build", "Update", "Validate", "Publish"]:
            self.assertIn(token, content)
        self.assertIn("国家及行业规范", content)
        self.assertIn("企业制度与模板", content)
        self.assertIn("不能覆盖强制性", content)

    def test_wiki_build_profile_manifest_owns_triggers_and_prompts(self):
        manifest = json.loads(
            (ROOT / "integration" / "wiki-build-profile.json").read_text(encoding="utf-8")
        )
        self.assertEqual(manifest["id"], "document-review")
        self.assertEqual(manifest["skill_name"], "document-review-wiki-builder")
        self.assertIn("@document-review-wiki-builder", manifest["mentions"])
        self.assertEqual(manifest["minimum_topics"], 1)
        self.assertEqual(len(manifest["coverage_targets"]), 8)
        self.assertTrue(manifest["include_source_in_topic_generation"])
        for key in ["schema", "update", "index", "topic"]:
            self.assertTrue(ROOT.joinpath(manifest["prompts"][key]).is_file())

    def test_build_and_update_prompts_are_evidence_bounded_and_separate(self):
        schema = (ROOT / "prompts" / "wiki-schema.md").read_text(encoding="utf-8")
        update = (ROOT / "prompts" / "wiki-update.md").read_text(encoding="utf-8")
        self.assertIn("覆盖目标", schema)
        self.assertIn("不得为了凑够", schema)
        self.assertNotIn("至少覆盖通知、请示、报告、批复、函、纪要、决定、通报八类", schema)
        for token in ["保留已有页面", "完整 SCHEMA", "知识缺口", "不要输出推理过程"]:
            self.assertIn(token, update)

    def test_default_registry_contains_the_first_eight_high_frequency_types(self):
        registry = (ROOT / "assets" / "document-type-registry-template.yaml").read_text(encoding="utf-8")
        for name in ["通知", "请示", "报告", "批复", "函", "纪要", "决定", "通报"]:
            self.assertIn(name, registry)

    def test_rule_and_source_templates_model_authority_and_overlay_behavior(self):
        rule = (ROOT / "assets" / "rule-template.yaml").read_text(encoding="utf-8")
        source = (ROOT / "assets" / "source-register-template.yaml").read_text(encoding="utf-8")
        for token in ["source_level", "authority_level", "overlay_behavior", "conflict_strategy"]:
            self.assertIn(token, rule + source)

    def test_agent_projection_contract_and_templates_are_bundled(self):
        contract = (ROOT / "references" / "agent-runtime-projection.md").read_text(encoding="utf-8")
        required = [
            "_common/format-profiles.md",
            "_common/punctuation-spec.md",
            "_common/citations.md",
            "style/style-prompts.md",
            "lexicon/taboo-words.md",
        ]
        for path in required:
            self.assertIn(path, contract)
        self.assertTrue(ROOT.joinpath("scripts", "compile_agent_projection.py").is_file())

    def test_skill_contains_realistic_evaluation_prompts(self):
        payload = json.loads((ROOT / "evals" / "evals.json").read_text(encoding="utf-8"))
        self.assertEqual(payload["skill_name"], "document-review-wiki-builder")
        self.assertGreaterEqual(len(payload["evals"]), 5)
        self.assertTrue(all(item.get("expectations") for item in payload["evals"]))
        prompts = "\n".join(item["prompt"] for item in payload["evals"])
        self.assertIn("只有请示", prompts)
        self.assertIn("保留现有", prompts)

    def test_projection_compiler_emits_the_current_agent_contract(self):
        with tempfile.TemporaryDirectory() as td:
            wiki = Path(td) / "wiki"
            output = Path(td) / "dist"
            (wiki / "governance").mkdir(parents=True)
            (wiki / "01-document-type-and-format").mkdir(parents=True)
            (wiki / "governance" / "document-type-registry.yaml").write_text(
                "document_types:\n"
                "  - document_type_id: DOC-TYPE-NOTICE\n"
                "    canonical_name: 通知\n"
                "    runtime_doc_type: notice\n",
                encoding="utf-8",
            )
            (wiki / "governance" / "source-register.yaml").write_text(
                "sources:\n"
                "  - source_id: SRC-001\n"
                "    title: 企业公文管理办法\n"
                "    source_level: enterprise\n",
                encoding="utf-8",
            )
            (wiki / "governance" / "release-manifest.yaml").write_text(
                "release:\n"
                "  version: 1.0.0\n"
                "  pages:\n"
                "    - knowledge_id: DOC-NOTICE-001\n"
                "      approval_record_id: APPROVAL-001\n",
                encoding="utf-8",
            )
            (wiki / "01-document-type-and-format" / "notice-title.md").write_text(
                "---\n"
                "knowledge_id: DOC-NOTICE-001\n"
                "title: 通知标题应准确概括事项\n"
                "document_type_ids: [DOC-TYPE-NOTICE]\n"
                "review_dimensions: [标题]\n"
                "status: published\n"
                "knowledge_type: mandatory-rule\n"
                "source:\n"
                "  source_id: SRC-001\n"
                "  clause_id: 第十条\n"
                "  source_text: 通知标题应当准确概括事项。\n"
                "---\n\n"
                "# 通知标题应准确概括事项\n\n"
                "## 规则摘要\n通知标题应当准确概括事项。\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                [
                    "python",
                    str(ROOT / "scripts" / "compile_agent_projection.py"),
                    str(wiki),
                    "--output",
                    str(output),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((output / "doc-types" / "notice.md").is_file())
            self.assertTrue((output / "_common" / "format-profiles.md").is_file())
            citations = (output / "_common" / "citations.md").read_text(encoding="utf-8")
            self.assertIn("DOC-NOTICE-001", citations)
            self.assertIn("企业公文管理办法", citations)


if __name__ == "__main__":
    unittest.main()
