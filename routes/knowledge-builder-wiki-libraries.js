'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RESERVED_ROOTS = new Set([
  'concepts', 'entities', 'sources', 'syntheses', 'comparisons',
  'articles', 'papers', 'transcripts', 'assets', 'general',
]);

// wiki-build-agent 容器把 data/wiki 挂载为存储根，会写入 agent 工作区脚手架目录
// （agents/memory/messages/skills/todo/context/coding_memory/assistant-memory 等）。
// 这些不是 wiki 知识库，列库时必须排除，否则知识库页面全是假库。
// work-assistant/graph-builder-demo 是真实 wiki 库（documents/*.md），保留。
const AGENT_WORKSPACE_ROOTS = new Set([
  'agents', 'memory', 'messages', 'skills', 'todo', 'context',
  'coding_memory', 'assistant-memory', 'work-assistant-memory',
]);

function isAgentWorkspaceDir(name) {
  return AGENT_WORKSPACE_ROOTS.has(name);
}

/** 判断 wikiRoot 下的目录是不是一个真正的 wiki 库：至少有 1 个 .md 页面 */
function hasWikiPages(wikiRoot, name) {
  try {
    const stack = [path.join(wikiRoot, name)];
    let visited = 0;
    while (stack.length && visited < 200) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) return true;
        if (entry.isDirectory() && entry.name !== '_history' && entry.name !== '_reports' && entry.name !== '_meta') {
          stack.push(path.join(dir, entry.name));
        }
      }
      visited += 1;
    }
  } catch { /* 读取失败按无页面处理 */ }
  return false;
}
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;

function fail(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode || 400;
  throw error;
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function safeId(value) {
  const id = String(value || '').trim();
  if (!ID_PATTERN.test(id) || id === '.' || id === '..') {
    fail('WIKI_LIBRARY_ID_INVALID', 'Wiki 库标识只能包含字母、数字、点、下划线和连字符');
  }
  return id;
}

function resolveInside(root, relative, code) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, String(relative || ''));
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    fail(code || 'WIKI_LIBRARY_PATH_INVALID', 'Wiki 库路径超出允许范围');
  }
  return resolved;
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return null; }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const temporary = filePath + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function createWikiLibraryStore(options) {
  const opts = options || {};
  const workspaceRoot = path.resolve(opts.workspaceRoot || path.join(__dirname, '..'));
  const wikiRoot = ensureDir(path.resolve(opts.wikiRoot || path.join(workspaceRoot, 'wiki')));
  // extraRoots：额外只读扫描根（如老链路 wiki/ 下的专用库 doc-rules）。
  // 参与库发现与页面浏览，但编辑/构建/归档等写操作仅限主 wikiRoot——防止管理页误伤外部库。
  const extraRoots = (Array.isArray(opts.extraRoots) ? opts.extraRoots : [])
    .map((root) => path.resolve(root))
    .filter((root) => root !== path.resolve(wikiRoot));
  const sourcesRoot = ensureDir(path.resolve(opts.sourcesRoot || path.join(workspaceRoot, 'sources')));
  const dataRoot = ensureDir(path.resolve(opts.dataRoot || path.join(workspaceRoot, 'data', 'knowledge-builder')));
  const metadataRoot = ensureDir(path.join(dataRoot, 'wiki-libraries'));
  const runRoot = path.join(dataRoot, 'wiki-build-runs');
  const releasesRoot = path.join(dataRoot, 'releases');
  const now = typeof opts.now === 'function' ? opts.now : () => new Date().toISOString();

  function metadataFile(wikiId) {
    return resolveInside(metadataRoot, safeId(wikiId) + '.json', 'WIKI_LIBRARY_ID_INVALID');
  }

  function wikiDirectory(wikiId) {
    // 主根有该库（目录存在且有页面）→ 用主根，可管理
    const id = safeId(wikiId);
    const primary = path.join(wikiRoot, id);
    if (fs.existsSync(primary) && hasWikiPages(wikiRoot, id)) {
      return resolveInside(wikiRoot, id, 'WIKI_LIBRARY_ID_INVALID');
    }
    // 否则看 extraRoots（老链路只读库）
    for (const root of extraRoots) {
      if (fs.existsSync(path.join(root, id)) && hasWikiPages(root, id)) {
        return resolveInside(root, id, 'WIKI_LIBRARY_ID_INVALID');
      }
    }
    // 都没有 → 主根路径（创建/报错场景）
    return resolveInside(wikiRoot, id, 'WIKI_LIBRARY_ID_INVALID');
  }

  // 外链库判定：主根没有有效页面、extra 根才有 → 只读展示
  function extraRootOf(wikiId) {
    const id = safeId(wikiId);
    if (fs.existsSync(path.join(wikiRoot, id)) && hasWikiPages(wikiRoot, id)) return null;
    for (const root of extraRoots) {
      if (fs.existsSync(path.join(root, id)) && hasWikiPages(root, id)) return root;
    }
    return null;
  }

  function sourceDirectory(wikiId) {
    return resolveInside(sourcesRoot, safeId(wikiId), 'WIKI_LIBRARY_ID_INVALID');
  }

  function exists(wikiId) {
    return fs.existsSync(metadataFile(wikiId))
      || fs.existsSync(wikiDirectory(wikiId))
      || fs.existsSync(sourceDirectory(wikiId));
  }

  function rawMetadata(wikiId) {
    return readJson(metadataFile(wikiId));
  }

  // 构建要求镜像文件：存放于库目录 _meta/ 下，供 bind mount 消费方（如 ontomind-agent）直接读取
  function requirementsFile(wikiId) {
    return resolveInside(wikiDirectory(wikiId), '_meta/build-requirements.md', 'WIKI_LIBRARY_ID_INVALID');
  }

  function readRequirementsMirror(wikiId) {
    const file = requirementsFile(wikiId);
    if (!fs.existsSync(file)) return '';
    try { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim(); } catch (_) { return ''; }
  }

  function writeRequirementsMirror(wikiId, value) {
    const file = requirementsFile(wikiId);
    const normalized = String(value || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) {
      if (fs.existsSync(file)) { try { fs.unlinkSync(file); } catch (_) { /* 删除失败忽略 */ } }
      return;
    }
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, normalized + '\n', 'utf8');
  }

  function listPageFiles(wikiId) {
    const root = wikiDirectory(wikiId);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
    const pages = [];
    function visit(directory) {
      fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .forEach((entry) => {
          if (entry.name.startsWith('.')) return;
          if (entry.name === '_meta') return; // 元数据目录不是知识页面
          const fullPath = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(fullPath);
          else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'log.md') {
            const stat = fs.statSync(fullPath);
            pages.push({
              path: path.relative(root, fullPath).split(path.sep).join('/'),
              bytes: stat.size,
              updated_at: stat.mtime.toISOString(),
            });
          }
        });
    }
    visit(root);
    return pages.sort((left, right) => left.path.localeCompare(right.path));
  }

  function sourceCount(wikiId) {
    const root = sourceDirectory(wikiId);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return 0;
    let count = 0;
    function visit(directory) {
      fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(fullPath);
        else if (entry.isFile()) count += 1;
      });
    }
    visit(root);
    return count;
  }

  // 对话构建历史（ontomind-agent 写入 _meta/build-history.json，bind mount 共享）
  function readBuildHistory(wikiId) {
    const file = resolveInside(wikiDirectory(wikiId), path.join('_meta', 'build-history.json'), 'WIKI_LIBRARY_ID_INVALID');
    if (!fs.existsSync(file)) return [];
    const history = readJson(file);
    return Array.isArray(history) ? history : [];
  }

  function buildHistory(wikiId) {
    const id = safeId(wikiId);
    if (!exists(id) || RESERVED_ROOTS.has(id)) fail('WIKI_LIBRARY_NOT_FOUND', 'Wiki 库不存在', 404);
    return readBuildHistory(id);
  }

  function normalizeChatStatus(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'success') return 'SUCCESS';
    if (value === 'running') return 'RUNNING';
    return 'FAILED';
  }

  function buildStats(wikiId) {
    // 对话构建历史条目映射为与 runs 一致的大写状态口径
    const chatBuilds = readBuildHistory(wikiId).map((entry) => ({
      status: normalizeChatStatus(entry && entry.status),
      updated_at: String((entry && (entry.finished_at || entry.started_at)) || ''),
    }));
    let runs = [];
    if (fs.existsSync(runRoot)) {
      runs = fs.readdirSync(runRoot)
        .filter((name) => name.endsWith('.json'))
        .map((name) => readJson(path.join(runRoot, name)))
        .filter((run) => run && run.project === wikiId)
        .map((run) => ({ status: run.status, updated_at: String(run.updated_at || run.created_at || '') }));
    }
    const all = runs
      .concat(chatBuilds)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    return { build_count: all.length, latest_build_status: all[0] && all[0].status || null };
  }

  function latestReleaseId(wikiId) {
    if (!fs.existsSync(releasesRoot)) return null;
    const releases = [];
    function visit(directory) {
      fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(fullPath);
        else if (entry.isFile() && entry.name === 'release-manifest.json') {
          const release = readJson(fullPath);
          if (release && release.project === wikiId && (release.artifact_type === 'LLM_WIKI' || !release.artifact_type)) releases.push(release);
        }
      });
    }
    visit(releasesRoot);
    releases.sort((left, right) => String(right.released_at || '').localeCompare(String(left.released_at || '')));
    return releases[0] && releases[0].release_id || null;
  }

  // 对话式构建（ontomind-agent）写入的库元数据兜底：wiki/<id>/_meta/library.json
  // 仅在 Harbor 自有元数据缺字段时使用，用户在库管理中的改名始终优先
  function chatLibraryMeta(wikiId) {
    const file = resolveInside(wikiDirectory(wikiId), path.join('_meta', 'library.json'), 'WIKI_LIBRARY_ID_INVALID');
    if (!fs.existsSync(file)) return {};
    const meta = readJson(file);
    if (!meta || typeof meta !== 'object') return {};
    const picked = {};
    if (typeof meta.name === 'string' && meta.name.trim()) picked.name = meta.name.trim();
    if (typeof meta.description === 'string' && meta.description.trim()) picked.description = meta.description.trim();
    return picked;
  }

  function record(wikiId) {
    const id = safeId(wikiId);
    if (!exists(id) || RESERVED_ROOTS.has(id)) fail('WIKI_LIBRARY_NOT_FOUND', 'Wiki 库不存在', 404);
    const metadata = rawMetadata(id) || {};
    const chatMeta = chatLibraryMeta(id);
    const builds = buildStats(id);
    return {
      wiki_id: id,
      project: id,
      name: String(metadata.name || chatMeta.name || id),
      description: String(metadata.description || chatMeta.description || ''),
      build_requirements: String(metadata.build_requirements || ''),
      status: metadata.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
      created_at: metadata.created_at || null,
      updated_at: metadata.updated_at || null,
      page_count: listPageFiles(id).length,
      source_count: sourceCount(id),
      build_count: builds.build_count,
      latest_build_status: builds.latest_build_status,
      latest_release_id: latestReleaseId(id),
      // 老链路外链库（只读展示）：管理页据此隐藏编辑/构建入口，避免误写外部库
      readonly_external: !!extraRootOf(id),
    };
  }

  function discoveredIds() {
    const ids = new Set();
    // 主根 + sourcesRoot 可发现可管理库；extraRoots（老链路专用库）只读展示
    [wikiRoot, sourcesRoot, ...extraRoots].forEach((root) => {
      fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .forEach((entry) => {
          if (ID_PATTERN.test(entry.name) && !RESERVED_ROOTS.has(entry.name) && !isAgentWorkspaceDir(entry.name) && hasWikiPages(root, entry.name)) ids.add(entry.name);
        });
    });
    // 元数据注册表中的库不受"必须有页面"限制（刚创建、尚未构建的合法空库）
    fs.readdirSync(metadataRoot)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .forEach((id) => { if (ID_PATTERN.test(id) && !RESERVED_ROOTS.has(id) && !isAgentWorkspaceDir(id)) ids.add(id); });
    return Array.from(ids).sort((left, right) => left.localeCompare(right));
  }

  function listLibraries(filters) {
    const status = String(filters && filters.status || '').trim().toUpperCase();
    const libraries = discoveredIds().map(record).filter((library) => !status || status === 'ALL' || library.status === status);
    return { libraries, total: libraries.length };
  }

  function getLibrary(wikiId) {
    return record(wikiId);
  }

  function normalizeName(value) {
    const name = String(value || '').trim();
    if (!name || name.length > 120) fail('WIKI_LIBRARY_NAME_INVALID', 'Wiki 库名称不能为空且不能超过 120 个字符');
    return name;
  }

  function normalizeDescription(value) {
    const description = String(value || '').trim();
    if (description.length > 1000) fail('WIKI_LIBRARY_DESCRIPTION_INVALID', 'Wiki 库简介不能超过 1000 个字符');
    return description;
  }

  function normalizeBuildRequirements(value) {
    const requirements = String(value || '').replace(/\r\n/g, '\n').trim();
    if (requirements.length > 4000) fail('WIKI_LIBRARY_REQUIREMENTS_INVALID', '构建要求不能超过 4000 个字符');
    return requirements;
  }

  function createLibrary(input) {
    const id = safeId(input && (input.wiki_id || input.project));
    if (RESERVED_ROOTS.has(id)) fail('WIKI_LIBRARY_ID_RESERVED', '该标识是 Wiki 库内保留目录名');
    if (exists(id)) fail('WIKI_LIBRARY_EXISTS', 'Wiki 库已经存在，不能覆盖', 409);
    const timestamp = now();
    const buildRequirements = normalizeBuildRequirements(input && input.build_requirements);
    const metadata = {
      wiki_id: id,
      name: normalizeName(input && input.name || id),
      description: normalizeDescription(input && input.description),
      build_requirements: buildRequirements,
      status: 'ACTIVE',
      created_at: timestamp,
      updated_at: timestamp,
    };
    ensureDir(wikiDirectory(id));
    ensureDir(sourceDirectory(id));
    writeJsonAtomic(metadataFile(id), metadata);
    if (buildRequirements) writeRequirementsMirror(id, buildRequirements);
    return record(id);
  }

  function updateLibrary(wikiId, updates) {
    const id = safeId(wikiId);
    const input = updates || {};
    if (Object.prototype.hasOwnProperty.call(input, 'wiki_id') || Object.prototype.hasOwnProperty.call(input, 'project')) {
      fail('WIKI_LIBRARY_FIELD_IMMUTABLE', 'Wiki 库标识不可修改');
    }
    const current = record(id);
    const previous = rawMetadata(id) || {
      wiki_id: id,
      status: current.status,
      created_at: current.created_at || now(),
    };
    const metadata = Object.assign({}, previous, {
      name: Object.prototype.hasOwnProperty.call(input, 'name') ? normalizeName(input.name) : current.name,
      description: Object.prototype.hasOwnProperty.call(input, 'description') ? normalizeDescription(input.description) : current.description,
      build_requirements: Object.prototype.hasOwnProperty.call(input, 'build_requirements')
        ? normalizeBuildRequirements(input.build_requirements)
        : String(current.build_requirements || ''),
      updated_at: now(),
    });
    writeJsonAtomic(metadataFile(id), metadata);
    writeRequirementsMirror(id, metadata.build_requirements || '');
    return record(id);
  }

  function changeStatus(wikiId, status) {
    const id = safeId(wikiId);
    const current = record(id);
    const previous = rawMetadata(id) || {
      wiki_id: id,
      name: current.name,
      description: current.description,
      created_at: current.created_at || now(),
    };
    writeJsonAtomic(metadataFile(id), Object.assign({}, previous, { status, updated_at: now() }));
    return record(id);
  }

  function archiveLibrary(wikiId) {
    return changeStatus(wikiId, 'ARCHIVED');
  }

  function restoreLibrary(wikiId) {
    return changeStatus(wikiId, 'ACTIVE');
  }

  // ── 库删除（软删回收站 + 可选硬删） ──
  const TRASH_ROOT = path.join(wikiRoot, '.trash');

  /** 把 wikiRoot 下指定 id 的目录移入回收站（.trash/<id>@<时间戳>）；返回是否移动了内容 */
  function moveToTrash(id) {
    const src = path.join(wikiRoot, id);
    if (!fs.existsSync(src)) return false;
    ensureDir(TRASH_ROOT);
    const stamped = `${id}@${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(src, path.join(TRASH_ROOT, stamped));
    return true;
  }

  /**
   * 删除库：
   * - 默认软删：库目录移入 data/wiki/.trash/（带时间戳），元数据删除 → 列表不再发现该库；
   *   回收站由人工/运维按需恢复（目录名可反解回 id）。
   * - purge=true：跳过回收站直接物理删除库目录 + sources + 元数据（不可恢复，需前端二次确认）。
   * extraRoots 老链路只读库禁止删除（那不是本系统的资产）。
   */
  function deleteLibrary(wikiId, opts) {
    const id = safeId(wikiId);
    if (extraRootOf(id)) fail('WIKI_LIBRARY_READONLY_EXTERNAL', '老链路外链库为只读展示，不能在此删除', 409);
    const library = record(id);
    if (library.readonly_external) fail('WIKI_LIBRARY_READONLY_EXTERNAL', '老链路外链库为只读展示，不能在此删除', 409);
    const purge = !!(opts && opts.purge);

    // 1. wiki 内容目录 → 回收站或物理删除
    const wikiDir = wikiDirectory(id);
    if (fs.existsSync(wikiDir)) {
      if (purge) fs.rmSync(wikiDir, { recursive: true, force: true });
      else moveToTrash(id);
    }
    // 2. sources 源文档目录
    const srcDir = sourceDirectory(id);
    if (fs.existsSync(srcDir)) fs.rmSync(srcDir, { recursive: true, force: true });
    // 3. 元数据注册表
    const metaFile = metadataFile(id);
    if (fs.existsSync(metaFile)) fs.rmSync(metaFile, { force: true });

    return {
      wiki_id: id,
      name: library.name,
      purge,
      trash_path: purge ? null : '.trash/',
      deleted_at: now(),
    };
  }

  function listRuns(project) {
    const projFilter = project ? String(project).trim() : '';
    if (!fs.existsSync(runRoot)) return { runs: [], total: 0 };
    const runs = fs.readdirSync(runRoot)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const run = readJson(path.join(runRoot, name));
        if (!run) return null;
        if (!run.run_id) run.run_id = name.slice(0, -5);
        return run;
      })
      .filter((run) => run && (!projFilter || run.project === projFilter))
      .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
    return { runs, total: runs.length };
  }

  function listPages(wikiId) {
    const library = record(wikiId);
    const pages = listPageFiles(library.wiki_id);
    return { wiki_id: library.wiki_id, project: library.wiki_id, pages, total: pages.length };
  }

  function assertWritable(wikiId) {
    const library = record(wikiId);
    if (library.status === 'ARCHIVED') fail('WIKI_LIBRARY_ARCHIVED', 'Wiki 库已归档，只能查看历史', 409);
    return library;
  }

  return {
    listLibraries,
    getLibrary,
    createLibrary,
    updateLibrary,
    archiveLibrary,
    restoreLibrary,
    deleteLibrary,
    listPages,
    listRuns,
    assertWritable,
    buildHistory,
  };
}

module.exports = { createWikiLibraryStore, RESERVED_ROOTS };
