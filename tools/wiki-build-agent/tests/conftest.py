"""测试公共配置 — 把 python/ 加入 sys.path，并把存储根指到 tmp 目录。"""

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "python"))

from app import storage as wiki_storage  # noqa: E402


@pytest.fixture()
def tmp_wiki_root(tmp_path, monkeypatch):
    """把 storage 模块的存储根切到临时目录（含模块级 WIKI_STORAGE_DIR）。"""
    root = tmp_path / "wiki"
    root.mkdir()
    monkeypatch.setattr(wiki_storage, "WIKI_STORAGE_DIR", root)
    return root
