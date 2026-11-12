"""Wiki 三层存储 — 文件系统读写（自 ontomind-agent routes/wiki_chat.py 移植）。

三层架构：
- raw/   原始源材料（只读、不可变）
- entities/ concepts/ 等  编译知识页
- SCHEMA.md / index.md / log.md + _meta/ + _reports/  契约层
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Optional
from uuid import uuid4

from .config import storage_config

logger = logging.getLogger("wiki-build-agent.storage")

WIKI_STORAGE_DIR = storage_config.wiki_root


def _validate_wiki_id(wiki_id: str) -> str:
    """校验 wiki_id 合法性，防止路径穿越（如 ../../etc 或绝对路径逃逸存储目录）。"""
    if not wiki_id or "/" in wiki_id or "\\" in wiki_id or wiki_id in (".", ".."):
        raise ValueError(f"非法的 wiki_id: {wiki_id!r}")
    storage_root = WIKI_STORAGE_DIR.resolve()
    resolved = (storage_root / wiki_id).resolve()
    if not resolved.is_relative_to(storage_root):
        raise ValueError(f"非法的 wiki_id: {wiki_id!r}")
    return wiki_id


# 同一 Wiki 库的并发锁：防止双击/双页签同时构建/更新导致 SCHEMA、index、页面互相覆盖
_wiki_locks: dict[str, asyncio.Lock] = {}


def _get_wiki_lock(wiki_id: str) -> asyncio.Lock:
    lock = _wiki_locks.get(wiki_id)
    if lock is None:
        lock = asyncio.Lock()
        _wiki_locks[wiki_id] = lock
    return lock


def _wiki_project_dir(wiki_id: str) -> Path:
    """获取 Wiki 项目的存储目录（校验 wiki_id，防路径穿越）"""
    _validate_wiki_id(wiki_id)
    return WIKI_STORAGE_DIR / wiki_id


def _wiki_page_path(wiki_id: str, page_name: str) -> Path:
    """获取 Wiki 页面文件的完整路径。

    拒绝绝对路径、盘符/UNC 与解析后越出库目录的相对路径（路径穿越），
    而不是静默清洗——非法输入直接报错，避免歧义路径读写错文件。
    """
    if not isinstance(page_name, str) or not page_name.strip():
        raise ValueError(f"非法的页面路径: {page_name!r}")
    project_dir = _wiki_project_dir(wiki_id).resolve()
    candidate = Path(page_name.strip().replace("\\", "/"))
    if candidate.is_absolute() or candidate.drive or candidate.root:
        raise ValueError(f"非法的页面路径: {page_name!r}")
    resolved = (project_dir / candidate).resolve()
    if not resolved.is_relative_to(project_dir):
        raise ValueError(f"页面路径越出库目录: {page_name!r}")
    return resolved


def _read_wiki_page(wiki_id: str, page_name: str) -> str:
    """从文件系统读取 Wiki 页面内容。返回空字符串表示不存在。自动尝试补 .md 后缀。"""
    try:
        path = _wiki_page_path(wiki_id, page_name)
    except ValueError as e:
        logger.warning(f"读取 Wiki 页面路径非法 {wiki_id}/{page_name}: {e}")
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        if not page_name.endswith(".md"):
            path_md = _wiki_page_path(wiki_id, page_name + ".md")
            try:
                return path_md.read_text(encoding="utf-8")
            except FileNotFoundError:
                return ""
            except Exception as e:
                logger.warning(f"读取 Wiki 页面 {wiki_id}/{page_name}.md 失败: {e}")
                return ""
        return ""
    except Exception as e:
        logger.warning(f"读取 Wiki 页面 {wiki_id}/{page_name} 失败: {e}")
        return ""


def _list_wiki_pages(wiki_id: str) -> list[str]:
    """列出 Wiki 项目的所有 .md 页面文件名"""
    project_dir = _wiki_project_dir(wiki_id)
    if not project_dir.exists():
        return []
    pages = []
    for f in sorted(project_dir.rglob("*.md")):
        rel = f.relative_to(project_dir).as_posix()
        if rel.startswith(("_meta/", "_history/", "_reports/")):
            continue  # 元数据、历史版本、报告备份不是知识页面
        pages.append(rel)
    return pages


# 每个页面保留的历史版本数上限（_history/ 目录）
PAGE_HISTORY_MAX = 20


def _history_path_for(project_dir: Path, page_path: Path, ts: str) -> Path:
    """页面 entities/a.md 的历史版本路径：_history/entities/a.{ts}.md"""
    rel = page_path.relative_to(project_dir)
    return project_dir / "_history" / rel.parent / f"{rel.stem}.{ts}{rel.suffix}"


def _snapshot_page_history(project_dir: Path, page_path: Path) -> None:
    """覆盖写之前把旧内容复制进 _history/（raw/元数据/报告/非 md 不参与）。

    用复制而非移动：原文件保留到原子替换那一刻，快照失败不影响写入。
    """
    if not page_path.is_file() or page_path.suffix != ".md":
        return
    rel = page_path.relative_to(project_dir).as_posix()
    if rel.startswith(("raw/", "_meta/", "_history/", "_reports/")):
        return
    import datetime
    import shutil
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    hist_path = _history_path_for(project_dir, page_path, ts)
    try:
        hist_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(page_path, hist_path)
    except OSError as e:
        logger.warning(f"页面历史快照失败 {rel}: {e}")
        return
    # 只保留最近 PAGE_HISTORY_MAX 份（文件名含时间戳，字典序即时间序）
    versions = sorted(hist_path.parent.glob(f"{hist_path.name.rsplit('.', 2)[0]}.*.md"))
    for old in versions[:-PAGE_HISTORY_MAX]:
        old.unlink(missing_ok=True)


def _list_page_versions(wiki_id: str, page_name: str) -> list[dict]:
    """列出页面历史版本（旧→新），[{ts, chars}]。"""
    try:
        path = _wiki_page_path(wiki_id, page_name)
        project_dir = _wiki_project_dir(wiki_id)
    except ValueError:
        return []
    hist_dir = project_dir / "_history" / Path(page_name.replace("\\", "/")).parent
    pattern = f"{path.stem}.*.md"
    versions = []
    for f in sorted(hist_dir.glob(pattern)):
        parts = f.name.rsplit(".", 2)
        if len(parts) == 3:
            try:
                versions.append({"ts": parts[1], "bytes": f.stat().st_size})
            except OSError:
                continue
    return versions


def _read_page_version(wiki_id: str, page_name: str, ts: str) -> str:
    """读取页面历史版本内容，不存在返回空串。"""
    try:
        path = _wiki_page_path(wiki_id, page_name)
        project_dir = _wiki_project_dir(wiki_id)
        if not re.fullmatch(r"[0-9]{8}_[0-9]{6}_[0-9]{6}", ts or ""):
            return ""
        hist_path = _history_path_for(project_dir, path, ts)
        return hist_path.read_text(encoding="utf-8")
    except (ValueError, OSError):
        return ""


def _diff_page_version(wiki_id: str, page_name: str, ts: str, context_lines: int = 3) -> str:
    """历史版本 vs 当前版本的 unified diff 文本。"""
    import difflib
    old_content = _read_page_version(wiki_id, page_name, ts)
    current = _read_wiki_page(wiki_id, page_name)
    diff = difflib.unified_diff(
        old_content.splitlines(keepends=True),
        current.splitlines(keepends=True),
        fromfile=f"{page_name}@{ts}",
        tofile=f"{page_name}@current",
        n=context_lines,
    )
    return "".join(diff)


async def _save_wiki_page(wiki_id: str, page_name: str, content: str) -> bool:
    """保存页面到 Wiki 库（线程池执行避免阻塞事件循环）。

    写入失败时抛出异常而不是返回 False：调用方要么就地处理（逐页生成跳过该页），
    要么由主端点兜底转为 error SSE + 失败构建历史，避免静默丢页。
    """
    path = _wiki_page_path(wiki_id, page_name)

    def _write() -> None:
        project_dir = _wiki_project_dir(wiki_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        _snapshot_page_history(project_dir, path)
        # 原子写：先写临时文件再 os.replace，避免进程中断留下半截页面
        tmp_path = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            tmp_path.write_text(content, encoding="utf-8")
            os.replace(tmp_path, path)
        finally:
            tmp_path.unlink(missing_ok=True)

    try:
        await asyncio.to_thread(_write)
    except Exception as e:
        logger.error(f"保存 Wiki 页面 {page_name} 失败: {e}")
        raise
    logger.info(f"Wiki 页面 {page_name} 已保存到 {wiki_id}")
    return True


def _delete_wiki_page_sync(wiki_id: str, page_name: str) -> bool:
    """删除 Wiki 页面文件（同步版本，供线程池调用）"""
    try:
        try:
            path = _wiki_page_path(wiki_id, page_name)
        except ValueError:
            return False
        if path.exists():
            path.unlink()
            logger.info(f"Wiki 页面 {page_name} 已从 {wiki_id} 删除")
            return True
        return False
    except Exception as e:
        logger.warning(f"删除 Wiki 页面 {page_name} 失败: {e}")
        return False


async def _delete_wiki_page(wiki_id: str, page_name: str) -> bool:
    return await asyncio.to_thread(_delete_wiki_page_sync, wiki_id, page_name)


async def _append_wiki_log(wiki_id: str, action: str, detail: str, count: int = 0) -> str:
    """追加操作日志到 log.md（仅追加，返回更新后的日志内容）"""
    import datetime
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    entry = f"- [{ts}] {action} | {detail} | {count} 页"
    existing = _read_wiki_page(wiki_id, "log.md")
    content = (existing.rstrip() + "\n" + entry + "\n") if existing else f"# 操作日志\n\n{entry}\n"
    await _save_wiki_page(wiki_id, "log.md", content)
    return content


# 构建历史保留条数上限（_meta/build-history.json）
BUILD_HISTORY_MAX = 50


async def _record_build_history(wiki_id: str, entry_id: str, **fields) -> None:
    """写入结构化构建历史到 _meta/build-history.json（Node 侧库管理接口直接读取）。

    - 同 entry_id 视为更新（running → success/failed），否则追加新条目
    - 每次写入时将遗留的 running 条目收敛为 failed（进程中断/崩溃自愈）
    - 仅保留最近 BUILD_HISTORY_MAX 条
    """
    def _write() -> None:
        meta_dir = _wiki_page_path(wiki_id, "_meta")
        meta_dir.mkdir(parents=True, exist_ok=True)
        path = meta_dir / "build-history.json"
        history = []
        if path.exists():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8") or "[]")
                if isinstance(loaded, list):
                    history = loaded
            except Exception:
                history = []
        # 收敛遗留 running（异常中断自愈）
        for item in history:
            if isinstance(item, dict) and item.get("status") == "running":
                item["status"] = "failed"
                item["error"] = item.get("error") or "构建中断"
        entry = {"id": entry_id, **fields}
        for i, item in enumerate(history):
            if isinstance(item, dict) and item.get("id") == entry_id:
                merged = {**item, **entry}
                if entry.get("status") == "success":
                    merged.pop("error", None)
                history[i] = merged
                break
        else:
            history.append(entry)
        tmp_path = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            tmp_path.write_text(
                json.dumps(history[-BUILD_HISTORY_MAX:], ensure_ascii=False, indent=1),
                encoding="utf-8",
            )
            os.replace(tmp_path, path)
        finally:
            tmp_path.unlink(missing_ok=True)

    try:
        await asyncio.to_thread(_write)
    except Exception as e:
        logger.warning(f"写入构建历史失败: {e}")


# ─── 库级构建要求 ──────────────────────────────────────────

def _load_wiki_build_requirements(wiki_id: Optional[str]) -> str:
    """读取库目录 _meta/build-requirements.md 中的用户自定义构建要求。空表示未配置。"""
    if not wiki_id:
        return ""
    try:
        _validate_wiki_id(wiki_id)
    except ValueError:
        return ""
    path = _wiki_project_dir(wiki_id) / "_meta" / "build-requirements.md"
    try:
        if path.is_file():
            return path.read_text(encoding="utf-8").strip()
    except Exception as e:
        logger.warning(f"读取 Wiki 库构建要求 {wiki_id} 失败: {e}")
    return ""


def _save_wiki_build_requirements(wiki_id: str, requirements: str) -> None:
    """将构建要求落盘到库目录 _meta/build-requirements.md（新建库场景随请求携带时立即持久化）。"""
    req = (requirements or "").strip()
    if not req:
        return
    try:
        meta_dir = _wiki_project_dir(wiki_id) / "_meta"
        meta_dir.mkdir(parents=True, exist_ok=True)
        (meta_dir / "build-requirements.md").write_text(req + "\n", encoding="utf-8")
    except Exception as e:
        logger.warning(f"保存 Wiki 库构建要求 {wiki_id} 失败: {e}")


# ─── 库元数据（名称/简介） ──────────────────────────────────

def _load_wiki_library_meta(wiki_id: Optional[str]) -> dict:
    """读取库目录 _meta/library.json。"""
    if not wiki_id:
        return {}
    try:
        _validate_wiki_id(wiki_id)
    except ValueError:
        return {}
    path = _wiki_project_dir(wiki_id) / "_meta" / "library.json"
    try:
        if path.is_file():
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
    except Exception as e:
        logger.warning(f"读取 Wiki 库元数据 {wiki_id} 失败: {e}")
    return {}


def _save_wiki_library_meta(wiki_id: str, name: str, description: str = "") -> None:
    """将库名称落盘到 _meta/library.json（仅在文件不存在时写入，不覆盖用户改名）。"""
    if not wiki_id or not (name or "").strip():
        return
    try:
        meta_dir = _wiki_project_dir(wiki_id) / "_meta"
        meta_dir.mkdir(parents=True, exist_ok=True)
        meta_file = meta_dir / "library.json"
        if meta_file.is_file():
            return  # 已有元数据（含用户改名），不覆盖
        payload = {
            "name": name.strip()[:120],
            "description": (description or "").strip()[:1000],
            "created_by": "chat",
            "auto_named": True,
        }
        meta_file.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
    except Exception as e:
        logger.warning(f"保存 Wiki 库元数据 {wiki_id} 失败: {e}")


def _upgrade_wiki_library_meta(wiki_id: str, name: str) -> None:
    """构建成功后用更准确的名称升级自动生成的默认库名（仅 auto_named 标记时覆盖）。"""
    if not wiki_id or not (name or "").strip():
        return
    try:
        meta = _load_wiki_library_meta(wiki_id)
        if not meta.get("auto_named"):
            return  # 用户已通过库管理改名，不动
        meta_file = _wiki_project_dir(wiki_id) / "_meta" / "library.json"
        meta["name"] = name.strip()[:120]
        meta_file.write_text(
            json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
    except Exception as e:
        logger.warning(f"升级 Wiki 库元数据 {wiki_id} 失败: {e}")


def _apply_build_requirements(system_prompt: str, requirements: str) -> str:
    """把用户自定义构建要求追加到 system prompt 末尾（空要求原样返回）。"""
    req = (requirements or "").strip()
    if not req:
        return system_prompt
    return (
        system_prompt
        + "\n\n# 本库构建要求（用户自定义，优先级高于上述通用规则，必须严格遵循）\n"
        + req
    )


# ─── raw 层（失败续建） ─────────────────────────────────────

_SYNTHETIC_RAW_NAMES = {"raw层已有源文档.md", "resume-from-raw.md"}


def is_reusable_raw_document(path: Path) -> bool:
    """Exclude retry-generated bundles so raw resume cannot recursively duplicate input."""
    return path.name not in _SYNTHETIC_RAW_NAMES


async def _load_raw_documents(wiki_id: Optional[str]) -> list[tuple[str, str]]:
    """读取库 raw 层已保存的源文档（失败续建场景复用，无需重新上传）。"""
    if not wiki_id:
        return []
    raw_dir = _wiki_page_path(wiki_id, "raw")

    def _read() -> list[tuple[str, str]]:
        if not raw_dir.is_dir():
            return []
        docs = []
        for p in sorted(raw_dir.rglob("*.md")):
            if not is_reusable_raw_document(p):
                continue
            try:
                content = p.read_text(encoding="utf-8", errors="replace").strip()
            except Exception:
                continue
            if content:
                docs.append((p.relative_to(raw_dir).as_posix(), content))
        return docs

    try:
        return await asyncio.to_thread(_read)
    except Exception as e:
        logger.warning(f"读取 raw 层源文档失败: {e}")
        return []


# ─── Schema 多版本备份 ─────────────────────────────────────

async def _backup_schema_versioned(wiki_id: str, schema_content: str) -> None:
    """Schema 多版本备份：_reports/SCHEMA.backup.md（最新）+ _reports/backups/SCHEMA.{ts}.md（保留 10 份）。"""
    import datetime
    try:
        await _save_wiki_page(wiki_id, "_reports/SCHEMA.backup.md", schema_content)
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        backup_dir = _wiki_page_path(wiki_id, "_reports/backups")

        def _write_backup() -> None:
            backup_dir.mkdir(parents=True, exist_ok=True)
            (backup_dir / f"SCHEMA.{ts}.md").write_text(schema_content, encoding="utf-8")
            versions = sorted(backup_dir.glob("SCHEMA.*.md"))
            for old in versions[:-10]:
                old.unlink(missing_ok=True)

        await asyncio.to_thread(_write_backup)
    except Exception as e:
        logger.warning(f"Schema 版本备份失败: {e}")


def _default_library_name(message: str) -> str:
    """Schema 无标题时，用首条构建消息生成默认库名。"""
    text = re.sub(r"\s+", " ", (message or "").strip())
    if not text:
        return "未命名 Wiki 库"
    return (text[:24] + "…") if len(text) > 24 else text
