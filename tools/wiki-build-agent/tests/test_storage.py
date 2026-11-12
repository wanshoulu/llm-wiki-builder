"""storage 层单测 — 路径校验 / 读写 / 构建历史自愈 / raw 层续建 / 库元数据。"""

import json

import pytest

from app import storage as st


# ─── wiki_id 校验 ────────────────────────────────────────────

@pytest.mark.parametrize("bad", ["../escape", "a/b", "a\\b", "..", "."])
def test_validate_wiki_id_rejects_traversal(bad):
    with pytest.raises(ValueError):
        st._validate_wiki_id(bad)


def test_validate_wiki_id_accepts_normal(tmp_wiki_root):
    assert st._validate_wiki_id("wiki_123_abc") == "wiki_123_abc"


# ─── 页面读写 ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_save_read_list_delete_roundtrip(tmp_wiki_root):
    await st._save_wiki_page("w1", "entities/差旅报销.md", "# 差旅报销\n正文")
    assert st._read_wiki_page("w1", "entities/差旅报销.md") == "# 差旅报销\n正文"
    # 自动补 .md 后缀
    assert st._read_wiki_page("w1", "entities/差旅报销") == "# 差旅报销\n正文"
    assert st._read_wiki_page("w1", "entities/缺失") == ""
    pages = st._list_wiki_pages("w1")
    assert pages == ["entities/差旅报销.md"]
    assert await st._delete_wiki_page("w1", "entities/差旅报销.md") is True
    assert st._list_wiki_pages("w1") == []


@pytest.mark.asyncio
async def test_save_wiki_page_raises_on_failure(tmp_wiki_root, monkeypatch):
    """写失败必须抛异常（Phase 1 修复的移植：不允许静默丢页）。"""
    def _boom(path, content, *args, **kwargs):
        raise OSError("disk full")
    import pathlib
    monkeypatch.setattr(pathlib.Path, "write_text", _boom)
    with pytest.raises(OSError):
        await st._save_wiki_page("w1", "p.md", "x")


@pytest.mark.asyncio
async def test_page_path_blocks_traversal(tmp_wiki_root):
    """路径穿越直接报错（不再静默清洗），绝对路径/盘符/空路径一并拒绝。"""
    with pytest.raises(ValueError):
        st._wiki_page_path("w1", "../../etc/passwd")
    with pytest.raises(ValueError):
        st._wiki_page_path("w1", "entities/../../escape.md")
    with pytest.raises(ValueError):
        st._wiki_page_path("w1", "/etc/passwd")
    with pytest.raises(ValueError):
        st._wiki_page_path("w1", "")
    # 非法路径读取返回空而非抛错（读接口容错语义）
    assert st._read_wiki_page("w1", "../escape.md") == ""
    # 正常子目录路径仍在库内
    path = st._wiki_page_path("w1", "entities/差旅报销.md")
    assert path.is_relative_to(tmp_wiki_root / "w1")


# ─── 构建历史 ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_build_history_merge_and_self_heal(tmp_wiki_root):
    await st._record_build_history("w1", "bh_1", type="build", status="running")
    await st._record_build_history("w1", "bh_2", type="update", status="running")
    # 同 id 更新 running → success，同时把遗留 running（bh_2）收敛为 failed
    await st._record_build_history("w1", "bh_1", status="success", summary="3 个主题")
    history = json.loads(
        (tmp_wiki_root / "w1" / "_meta" / "build-history.json").read_text(encoding="utf-8")
    )
    by_id = {h["id"]: h for h in history}
    assert by_id["bh_1"]["status"] == "success"
    assert "error" not in by_id["bh_1"]
    assert by_id["bh_2"]["status"] == "failed"


# ─── 构建要求 / 库元数据 ─────────────────────────────────────

@pytest.mark.asyncio
async def test_build_requirements_roundtrip(tmp_wiki_root):
    assert st._load_wiki_build_requirements("w1") == ""
    st._save_wiki_build_requirements("w1", "所有页面必须包含「适用范围」小节")
    assert st._load_wiki_build_requirements("w1") == "所有页面必须包含「适用范围」小节"


def test_apply_build_requirements(tmp_wiki_root):
    assert st._apply_build_requirements("PROMPT", "") == "PROMPT"
    out = st._apply_build_requirements("PROMPT", "规则A")
    assert out.startswith("PROMPT")
    assert "规则A" in out


@pytest.mark.asyncio
async def test_library_meta_save_once_and_upgrade(tmp_wiki_root):
    st._save_wiki_library_meta("w1", "自动名", description="来源")
    # 二次保存不覆盖
    st._save_wiki_library_meta("w1", "另一个名")
    assert st._load_wiki_library_meta("w1")["name"] == "自动名"
    # auto_named 升级生效
    st._upgrade_wiki_library_meta("w1", "差旅制度知识库")
    meta = st._load_wiki_library_meta("w1")
    assert meta["name"] == "差旅制度知识库"
    # 用户改名（去掉 auto_named）后不再升级
    meta["auto_named"] = False
    (tmp_wiki_root / "w1" / "_meta" / "library.json").write_text(
        json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    st._upgrade_wiki_library_meta("w1", "不应生效")
    assert st._load_wiki_library_meta("w1")["name"] == "差旅制度知识库"


# ─── raw 层续建 ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_load_raw_documents_excludes_synthetic(tmp_wiki_root):
    await st._save_wiki_page("w1", "raw/制度A.md", "内容A")
    await st._save_wiki_page("w1", "raw/raw层已有源文档.md", "合成内容")
    docs = await st._load_raw_documents("w1")
    assert docs == [("制度A.md", "内容A")]
    # raw 层复用时写回的合成名不会被再次计入（防递归膨胀）
    assert st.is_reusable_raw_document(tmp_wiki_root / "w1" / "raw" / "制度A.md")
    assert not st.is_reusable_raw_document(tmp_wiki_root / "w1" / "raw" / "raw层已有源文档.md")


@pytest.mark.asyncio
async def test_schema_versioned_backup_keeps_10(tmp_wiki_root):
    """时间戳为秒级：同秒多次备份坍缩为同名文件（原实现行为）。
    保留上限用预置的不同时间戳文件验证：新备份后仅留最近 10 份。"""
    backup_dir = tmp_wiki_root / "w1" / "_reports" / "backups"
    backup_dir.mkdir(parents=True)
    for i in range(12):
        (backup_dir / f"SCHEMA.20260101_0000{i:02d}.md").write_text(f"# old{i}", encoding="utf-8")
    await st._backup_schema_versioned("w1", "# new")
    backups = sorted(backup_dir.glob("SCHEMA.*.md"))
    assert len(backups) == 10
    # 最早两份被清理，新写入的（今天的时间戳，排序最后）保留
    assert backups[-1].read_text(encoding="utf-8") == "# new"
    assert not (backup_dir / "SCHEMA.20260101_000000.md").exists()
    assert not (backup_dir / "SCHEMA.20260101_000001.md").exists()
    # 最新备份镜像
    assert (tmp_wiki_root / "w1" / "_reports" / "SCHEMA.backup.md").read_text(encoding="utf-8") == "# new"


# ─── 页面版本历史（路线图 P4） ───────────────────────────────

@pytest.mark.asyncio
async def test_page_version_history_and_diff(tmp_wiki_root):
    await st._save_wiki_page("w1", "concepts/a.md", "# v1\n旧内容")
    await st._save_wiki_page("w1", "concepts/a.md", "# v2\n新内容")

    versions = st._list_page_versions("w1", "concepts/a.md")
    assert len(versions) == 1
    assert versions[0]["bytes"] > 0
    old = st._read_page_version("w1", "concepts/a.md", versions[0]["ts"])
    assert "旧内容" in old

    diff = st._diff_page_version("w1", "concepts/a.md", versions[0]["ts"])
    assert "-# v1" in diff and "+# v2" in diff
    assert st._read_page_version("w1", "concepts/a.md", "bad-ts") == ""
    assert st._read_page_version("w1", "concepts/a.md", "99999999_999999_999999") == ""


@pytest.mark.asyncio
async def test_history_excludes_raw_and_reports(tmp_wiki_root):
    """raw 层不可变无需历史；_reports 备份不进历史；_history 不进页面列表。"""
    await st._save_wiki_page("w1", "raw/x.md", "第一版")
    await st._save_wiki_page("w1", "raw/x.md", "第二版")
    assert st._list_page_versions("w1", "raw/x.md") == []

    await st._backup_schema_versioned("w1", "# 备份")
    await st._backup_schema_versioned("w1", "# 备份2")

    pages = st._list_wiki_pages("w1")
    assert not any(p.startswith(("_history/", "_reports/")) for p in pages)


@pytest.mark.asyncio
async def test_export_markdown_and_html(tmp_wiki_root):
    from app.export import export_to_reports, export_wiki_html, export_wiki_markdown

    await st._save_wiki_page("w1", "entities/a.md", "# 标题A\n内容")
    await st._save_wiki_page("w1", "_history/a.md", "不应出现在导出里")

    md = export_wiki_markdown("w1", "测试库")
    assert "标题A" in md and "测试库" in md and "不应出现" not in md
    html = export_wiki_html("w1", "测试库")
    assert "<html" in html and "标题A" in html

    out = export_to_reports("w1", "html", "测试库")
    assert out.is_file() and out.parent.name == "exports"
