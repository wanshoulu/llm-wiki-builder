'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createWikiReviewStore } = require('./knowledge-builder-wiki-reviews');
const { createWikiLibraryStore } = require('./knowledge-builder-wiki-libraries');

const DEFAULT_WIKI_STAGES = Object.freeze([
  'source-snapshot',
  'parse-normalize',
  'outline-pages',
  'citation-linking',
  'wiki-lint',
  'content-security',
]);

// 对话式构建历史映射为 run 时的统一前缀（与流水线 run_id 'wiki-build-run:' 并列）
const CHAT_RUN_PREFIX = 'wiki-chat-build:';

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

function safeSegment(value, code) {
  const segment = String(value || '').trim();
  if (!segment || segment === '.' || segment === '..' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(segment)) {
    fail(code || 'WIKI_BUILD_SEGMENT_INVALID', '标识只能包含字母、数字、点、下划线和连字符', 400);
  }
  return segment;
}

function resolveInside(root, relative, code) {
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, String(relative || ''));
  if (resolved !== absoluteRoot && !resolved.startsWith(absoluteRoot + path.sep)) {
    fail(code || 'WIKI_BUILD_PATH_INVALID', '路径超出允许范围', 400);
  }
  return resolved;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function digestBuffer(buffer) {
  return 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
}

function markdownProjectDigest(projectRoot) {
  const files = [];
  const visit = (directory) => {
    fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .forEach((entry) => {
        if (entry.name.startsWith('.')) return;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(fullPath);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'log.md') files.push(fullPath);
      });
  };
  visit(projectRoot);
  const hash = crypto.createHash('sha256');
  files.forEach((filePath) => {
    hash.update(path.relative(projectRoot, filePath).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  });
  return 'sha256:' + hash.digest('hex');
}

function normalizeSourceRefs(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('WIKI_BUILD_SOURCE_REFS_INVALID', 'source_refs must be an array of strings', 400);
  if (value.length > 100) fail('WIKI_BUILD_SOURCE_REFS_TOO_MANY', 'source_refs cannot contain more than 100 entries', 400);
  const unique = new Set();
  value.forEach((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      fail('WIKI_BUILD_SOURCE_REFS_INVALID', 'source_refs must contain non-empty strings', 400);
    }
    const reference = item.trim();
    if (reference.length > 160) fail('WIKI_BUILD_SOURCE_REF_TOO_LONG', 'each source reference is limited to 160 characters', 400);
    unique.add(reference);
  });
  return Array.from(unique);
}

function requestFingerprint(input, stages) {
  const stable = JSON.stringify({
    project: input.project,
    source_batch_id: input.source_batch_id || null,
    source_refs: input.source_refs || [],
    dataset_ref: input.dataset_ref || null,
    model: input.model || null,
    stages,
  });
  return digestBuffer(Buffer.from(stable));
}

function publicError(error) {
  return {
    code: error && error.code || 'WIKI_BUILD_STAGE_FAILED',
    message: error && error.statusCode && error.statusCode < 500
      ? String(error.message || '构建阶段执行失败').slice(0, 500)
      : '构建阶段执行失败，请查看服务日志后重试',
  };
}

function createWikiBuildRunStore(options) {
  const opts = options || {};
  const workspaceRoot = path.resolve(opts.workspaceRoot || path.join(__dirname, '..'));
  const dataRoot = path.resolve(opts.dataRoot || path.join(workspaceRoot, 'data', 'knowledge-builder'));
  const wikiRoot = path.resolve(opts.wikiRoot || path.join(workspaceRoot, 'wiki'));
  const runRoot = ensureDir(path.join(dataRoot, 'wiki-build-runs'));
  const revisionRoot = ensureDir(path.join(dataRoot, 'wiki-revisions'));
  const now = typeof opts.now === 'function' ? opts.now : () => new Date().toISOString();
  const schedule = typeof opts.schedule === 'function' ? opts.schedule : (task) => setImmediate(task);
  const candidateFileHook = typeof opts.candidate_file_hook === 'function' ? opts.candidate_file_hook : null;
  const controlIntervalMs = Math.max(5, Number(opts.control_interval_ms || 250));
  const stageTimeoutMs = Math.max(100, Number(opts.stage_timeout_ms || 15 * 60 * 1000));
  const reviewStore = opts.reviewStore || createWikiReviewStore({ workspaceRoot, dataRoot, now });
  const wikiLibraryStore = opts.wikiLibraryStore || createWikiLibraryStore({ workspaceRoot, wikiRoot, dataRoot, now });
  let runtime = opts.runtime || null;
  const active = new Map();

  function getRuntime() {
    if (!runtime) {
      const { createKnowledgeBuilderRuntime } = require('./knowledge-builder-runtime');
      runtime = createKnowledgeBuilderRuntime({ workspaceRoot });
    }
    return runtime;
  }

  function runFile(runId) {
    const segment = safeSegment(String(runId || '').replace(/^wiki-build-run:/, ''), 'WIKI_BUILD_RUN_ID_INVALID');
    return resolveInside(runRoot, segment + '.json', 'WIKI_BUILD_RUN_ID_INVALID');
  }

  function persist(run) {
    run.updated_at = now();
    writeJsonAtomic(runFile(run.run_id), run);
    return clone(run);
  }

  function getRun(runId) {
    if (isChatRunId(runId)) return getChatRun(runId);
    const run = readJson(runFile(runId));
    if (!run) fail('WIKI_BUILD_RUN_NOT_FOUND', 'Wiki 构建运行不存在', 404);
    return run;
  }

  function allRuns() {
    return fs.readdirSync(runRoot)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(path.join(runRoot, name)))
      .filter(Boolean);
  }

  function listWikiProjects() {
    try {
      return fs.readdirSync(wikiRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name));
    } catch (_) {
      return [];
    }
  }

  // 读取各库 _meta/build-history.json（Python 对话构建落盘），映射为统一 run 形态
  function chatBuildEntries(project) {
    const targets = project ? [project] : listWikiProjects();
    const entries = [];
    targets.forEach((wikiId) => {
      const history = readJson(path.join(wikiRoot, wikiId, '_meta', 'build-history.json'));
      if (!Array.isArray(history)) return;
      history.forEach((entry) => {
        if (!entry || typeof entry !== 'object' || !entry.id) return;
        entries.push({
          run_id: CHAT_RUN_PREFIX + entry.id,
          artifact_type: 'LLM_WIKI',
          artifact_id: 'artifact:wiki:' + wikiId,
          artifact_version_id: 'artifact-version:wiki:' + wikiId + ':' + entry.id,
          project: wikiId,
          source: 'chat',
          chat_type: entry.type === 'update' ? 'update' : 'build',
          status: entry.status === 'success' ? 'CHAT_DONE'
            : entry.status === 'running' ? 'CHAT_RUNNING' : 'CHAT_FAILED',
          cancel_requested: false,
          created_at: entry.started_at || entry.finished_at || now(),
          updated_at: entry.finished_at || entry.started_at || now(),
          started_at: entry.started_at || null,
          completed_at: entry.finished_at || null,
          source_batch_id: null,
          source_refs: entry.source ? [String(entry.source).slice(0, 160)] : [],
          dataset_ref: null,
          model: entry.model || null,
          last_error: entry.error
            ? { code: 'WIKI_CHAT_BUILD_FAILED', message: String(entry.error).slice(0, 500) }
            : null,
          stages: [],
          candidate_revision: null,
          chat_summary: {
            duration_ms: Number(entry.duration_ms) || null,
            topics: Number(entry.topics) || null,
            pages_filled: Number(entry.pages_filled) || null,
            requirements_applied: Boolean(entry.requirements_applied),
          },
        });
      });
    });
    return entries.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  function isChatRunId(runId) {
    return String(runId || '').startsWith(CHAT_RUN_PREFIX);
  }

  // 对话式构建条目只读展示：阶段重试/取消/候选审阅等流水线操作不适用
  function ensurePipelineRun(runId) {
    if (isChatRunId(runId)) {
      fail('WIKI_CHAT_BUILD_ACTION_UNSUPPORTED', '对话式构建不支持该操作，请在 Wiki 构建对话中继续完善', 409);
    }
  }

  function getChatRun(runId) {
    const entry = chatBuildEntries().find((item) => item.run_id === runId);
    if (!entry) fail('WIKI_BUILD_RUN_NOT_FOUND', 'Wiki 构建运行不存在', 404);
    return entry;
  }

  function recoverInterruptedRuns() {
    allRuns().forEach((run) => {
      if (run.status !== 'RUNNING') return;
      run.status = 'PAUSED';
      run.cancel_requested = false;
      run.stages.forEach((stage) => {
        if (stage.status !== 'RUNNING') return;
        stage.status = 'PENDING';
        stage.started_at = null;
        stage.completed_at = null;
        stage.error = null;
      });
      run.last_error = {
        code: 'WIKI_BUILD_INTERRUPTED',
        message: '服务重启中断了构建，可从未完成阶段继续执行',
      };
      persist(run);
    });
  }

  function listRuns(project) {
    const target = project ? safeSegment(project, 'WIKI_BUILD_PROJECT_INVALID') : null;
    const runs = allRuns()
      .filter((run) => !target || run.project === target)
      .concat(chatBuildEntries(target))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { runs: clone(runs), total: runs.length };
  }

  function candidateContext(runId) {
    ensurePipelineRun(runId);
    const run = getRun(runId);
    if (!run.candidate_revision || !run.candidate_revision.revision_id) {
      fail('WIKI_CANDIDATE_NOT_READY', 'Wiki 构建运行尚未生成不可变候选版本', 409);
    }
    const project = safeSegment(run.project, 'WIKI_BUILD_PROJECT_INVALID');
    const revisionId = safeSegment(run.candidate_revision.revision_id, 'WIKI_CANDIDATE_REVISION_INVALID');
    const root = resolveInside(revisionRoot, path.join(project, revisionId), 'WIKI_CANDIDATE_REVISION_INVALID');
    const manifest = readJson(path.join(root, 'manifest.json'));
    if (!manifest || manifest.run_id !== run.run_id || manifest.revision_id !== revisionId || !Array.isArray(manifest.files)) {
      fail('WIKI_CANDIDATE_MANIFEST_INVALID', 'Wiki 候选版本清单缺失或与构建运行不一致', 409);
    }
    return { run, root, manifest };
  }

  function normalizeCandidateFilePath(value) {
    const normalized = String(value || '').replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
      fail('WIKI_CANDIDATE_FILE_INVALID', '候选文件路径无效', 400);
    }
    return normalized;
  }

  function getCandidateFile(runId, requestedPath) {
    const context = candidateContext(runId);
    const relative = normalizeCandidateFilePath(requestedPath);
    const entry = context.manifest.files.find((file) => file && file.path === relative);
    if (!entry) fail('WIKI_CANDIDATE_FILE_NOT_FOUND', '候选版本中不存在该文件', 404);
    const filePath = resolveInside(path.join(context.root, 'pages'), relative, 'WIKI_CANDIDATE_FILE_INVALID');
    let buffer;
    try { buffer = fs.readFileSync(filePath); }
    catch (_) { fail('WIKI_CANDIDATE_FILE_NOT_FOUND', '候选版本文件缺失', 404); }
    const actualDigest = digestBuffer(buffer);
    if (actualDigest !== entry.digest) {
      fail('WIKI_CANDIDATE_DIGEST_MISMATCH', '候选版本文件摘要校验失败，已拒绝返回内容', 409);
    }
    return {
      path: entry.path,
      role: entry.role,
      bytes: entry.bytes,
      digest: entry.digest,
      content_type: entry.role === 'GRAPH' ? 'application/json' : 'text/markdown',
      content: buffer.toString('utf8'),
    };
  }

  function getCandidate(runId) {
    const context = candidateContext(runId);
    const graphEntry = context.manifest.files.find((file) => file && file.role === 'GRAPH');
    let graph = null;
    if (graphEntry) {
      const graphFile = getCandidateFile(runId, graphEntry.path);
      try { graph = JSON.parse(graphFile.content); }
      catch (_) { fail('WIKI_CANDIDATE_GRAPH_INVALID', '候选版本图谱不是有效 JSON', 409); }
    }
    return {
      run: clone(context.run),
      revision: clone(context.run.candidate_revision),
      manifest: clone(context.manifest),
      graph,
    };
  }

  function listReviews(runId) {
    ensurePipelineRun(runId);
    const run = getRun(runId);
    if (!run.candidate_revision) fail('WIKI_REVIEW_CANDIDATE_REQUIRED', '构建尚未生成候选快照，不能读取审阅', 409);
    return reviewStore.listDecisions(run.run_id);
  }

  function createReview(runId, input, reviewer) {
    ensurePipelineRun(runId);
    return reviewStore.createDecision(getRun(runId), input, reviewer);
  }

  function createRun(input) {
    const payload = input || {};
    const project = safeSegment(payload.project, 'WIKI_BUILD_PROJECT_INVALID');
    wikiLibraryStore.assertWritable(project);
    const projectRoot = resolveInside(wikiRoot, project, 'WIKI_BUILD_PROJECT_INVALID');
    if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
      fail('WIKI_BUILD_PROJECT_NOT_FOUND', 'Wiki 项目不存在', 404);
    }
    const stages = DEFAULT_WIKI_STAGES.slice();
    const idempotencyKey = payload.idempotency_key
      ? safeSegment(payload.idempotency_key, 'WIKI_BUILD_IDEMPOTENCY_KEY_INVALID')
      : null;
    const normalized = {
      project,
      source_batch_id: payload.source_batch_id ? String(payload.source_batch_id).slice(0, 160) : null,
      source_refs: normalizeSourceRefs(payload.source_refs),
      dataset_ref: payload.dataset_ref ? String(payload.dataset_ref).slice(0, 160) : null,
      model: payload.model ? String(payload.model).slice(0, 160) : null,
    };
    const fingerprint = requestFingerprint(normalized, stages);
    if (idempotencyKey) {
      const existing = allRuns().find((run) => run.idempotency_key === idempotencyKey);
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          fail('WIKI_BUILD_IDEMPOTENCY_CONFLICT', '幂等键已经绑定到不同的构建请求', 409);
        }
        return clone(existing);
      }
    }
    const uuid = crypto.randomUUID();
    const timestamp = now();
    const run = {
      run_id: 'wiki-build-run:' + uuid,
      artifact_type: 'LLM_WIKI',
      artifact_id: 'artifact:wiki:' + project,
      artifact_version_id: 'artifact-version:wiki:' + project + ':' + uuid,
      project,
      source_batch_id: normalized.source_batch_id,
      source_refs: normalized.source_refs,
      dataset_ref: normalized.dataset_ref,
      model: normalized.model,
      idempotency_key: idempotencyKey,
      request_fingerprint: fingerprint,
      requested_by: String(payload.requested_by || 'local-user').slice(0, 160),
      status: 'PENDING',
      cancel_requested: false,
      created_at: timestamp,
      updated_at: timestamp,
      started_at: null,
      completed_at: null,
      source_content_digest: null,
      candidate_revision: null,
      retry_from_stage_index: null,
      last_error: null,
      stages: stages.map((stageId) => ({
        stage_id: stageId,
        status: 'PENDING',
        attempts: 0,
        started_at: null,
        completed_at: null,
        evidence_ref: null,
        status_note: '',
        error: null,
      })),
    };
    return persist(run);
  }

  function collectRevisionFiles(projectRoot) {
    const files = [];
    const visit = (directory) => {
      fs.readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((entry) => {
          const fullPath = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.')) visit(fullPath);
            return;
          }
          if (!entry.isFile()) return;
          if (entry.name === '.graph.json') files.push(fullPath);
          else if (!entry.name.startsWith('.') && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'log.md') files.push(fullPath);
        });
    };
    visit(projectRoot);
    return files;
  }

  async function freezeCandidate(run, preferredDigest) {
    if (run.candidate_revision) return run.candidate_revision;
    const projectRoot = resolveInside(wikiRoot, run.project, 'WIKI_BUILD_PROJECT_INVALID');
    if (markdownProjectDigest(projectRoot) !== preferredDigest) {
      fail('WIKI_BUILD_SOURCE_CHANGED', 'Wiki Markdown changed after the source snapshot; restart the build before freezing a candidate', 409);
    }
    const revisionId = 'wiki-revision-' + crypto.randomUUID();
    const targetRoot = resolveInside(revisionRoot, path.join(run.project, revisionId), 'WIKI_REVISION_PATH_INVALID');
    const pagesRoot = ensureDir(path.join(targetRoot, 'pages'));
    const markdownHash = crypto.createHash('sha256');
    const manifestFiles = [];
    try {
      for (const filePath of collectRevisionFiles(projectRoot)) {
        const relative = path.relative(projectRoot, filePath).split(path.sep).join('/');
        const buffer = await fs.promises.readFile(filePath);
        const target = resolveInside(pagesRoot, relative, 'WIKI_REVISION_PATH_INVALID');
        if (candidateFileHook) await candidateFileHook({ run: clone(run), relative, source_path: filePath, target_path: target, buffer });
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, buffer, { flag: 'wx' });
        const role = relative === '.graph.json' || relative.endsWith('/.graph.json')
          ? 'GRAPH'
          : relative.startsWith('entities/')
            ? 'ENTITY_PAGE'
            : relative.startsWith('sources/')
              ? 'SOURCE_PAGE'
              : 'CONTENT_PAGE';
        if (role !== 'GRAPH') markdownHash.update(relative).update('\0').update(buffer).update('\0');
        manifestFiles.push({ path: relative, role, bytes: buffer.length, digest: digestBuffer(buffer) });
      }
      const contentDigest = 'sha256:' + markdownHash.digest('hex');
      if (contentDigest !== preferredDigest) {
        fail('WIKI_BUILD_SOURCE_CHANGED', 'Wiki Markdown changed while freezing the candidate; restart the build from source-snapshot', 409);
      }
      const manifest = {
        revision_id: revisionId,
        run_id: run.run_id,
        project: run.project,
        artifact_id: run.artifact_id,
        artifact_version_id: run.artifact_version_id,
        content_digest: contentDigest,
        created_at: now(),
        files: manifestFiles,
      };
      await fs.promises.writeFile(path.join(targetRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' });
      run.candidate_revision = {
        revision_id: revisionId,
        content_digest: contentDigest,
        page_count: manifestFiles.filter((file) => file.path.toLowerCase().endsWith('.md')).length,
        content_page_count: manifestFiles.filter((file) => file.role === 'CONTENT_PAGE').length,
        entity_page_count: manifestFiles.filter((file) => file.role === 'ENTITY_PAGE').length,
        source_page_count: manifestFiles.filter((file) => file.role === 'SOURCE_PAGE').length,
        graph_included: manifestFiles.some((file) => file.path === '.graph.json' || file.path.endsWith('/.graph.json')),
        created_at: manifest.created_at,
      };
      return run.candidate_revision;
    } catch (error) {
      await fs.promises.rm(targetRoot, { recursive: true, force: true });
      throw error;
    }
  }

  function normalizeStageStatus(status) {
    const value = String(status || 'FAILED').toUpperCase();
    return ['PASSED', 'WARNING', 'BLOCKED', 'FAILED', 'SKIPPED'].includes(value) ? value : 'FAILED';
  }

  function blockSourceChanged(run, stage) {
    const error = {
      code: 'WIKI_BUILD_SOURCE_CHANGED',
      message: 'Wiki Markdown changed after the source snapshot; restart the build from source-snapshot',
    };
    if (stage) {
      stage.status = 'BLOCKED';
      stage.completed_at = now();
      stage.status_note = error.message;
      stage.error = clone(error);
    }
    run.status = 'BLOCKED';
    run.completed_at = now();
    run.retry_from_stage_index = 0;
    run.last_error = error;
    return persist(run);
  }

  function failCandidateFreeze(run) {
    run.status = 'FAILED';
    run.completed_at = now();
    run.retry_from_stage_index = Math.max(0, run.stages.length - 1);
    run.last_error = {
      code: 'WIKI_CANDIDATE_FREEZE_FAILED',
      message: 'Candidate snapshot could not be stored; retry the build after checking storage',
    };
    return persist(run);
  }

  function executeStageWithControl(runId, stageId, input) {
    const execution = Promise.resolve()
      .then(() => getRuntime().executeWikiStage(stageId, input))
      .then((result) => ({ kind: 'result', result }), (error) => ({ kind: 'error', error }));
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearInterval(controlTimer);
        clearTimeout(timeoutTimer);
        resolve(outcome);
      };
      const controlTimer = setInterval(() => {
        try {
          if (getRun(runId).cancel_requested) finish({ kind: 'cancelled' });
        } catch (error) {
          finish({ kind: 'error', error });
        }
      }, controlIntervalMs);
      const timeoutTimer = setTimeout(() => finish({ kind: 'timeout' }), stageTimeoutMs);
      execution.then(finish);
    });
  }

  async function performRun(runId) {
    let run = getRun(runId);
    if (run.status === 'READY_FOR_REVIEW' || run.status === 'CANCELLED') return clone(run);
    run.status = 'RUNNING';
    run.cancel_requested = false;
    run.started_at = run.started_at || now();
    run.completed_at = null;
    run.last_error = null;
    persist(run);

    for (let index = 0; index < run.stages.length; index += 1) {
      run = getRun(runId);
      const stage = run.stages[index];
      if (run.cancel_requested) {
        run.status = 'CANCELLED';
        run.completed_at = now();
        stage.status = stage.status === 'RUNNING' ? 'CANCELLED' : stage.status;
        return persist(run);
      }
      if (['PASSED', 'WARNING', 'SKIPPED'].includes(stage.status)) continue;
      if (stage.stage_id !== 'source-snapshot') {
        const projectRoot = resolveInside(wikiRoot, run.project, 'WIKI_BUILD_PROJECT_INVALID');
        if (markdownProjectDigest(projectRoot) !== run.source_content_digest) return blockSourceChanged(run, stage);
      }
      stage.status = 'RUNNING';
      stage.attempts += 1;
      stage.started_at = now();
      stage.completed_at = null;
      stage.error = null;
      persist(run);

      const input = {
        project: run.project,
        artifact_type: 'LLM_WIKI',
        artifact_id: run.artifact_id,
        artifact_version_id: run.artifact_version_id,
        run_id: run.run_id,
        source_batch_id: run.source_batch_id,
        source_refs: run.source_refs || [],
        dataset_ref: run.dataset_ref,
        model: run.model,
      };
      const boundContentDigest = run.candidate_revision && run.candidate_revision.content_digest || run.source_content_digest;
      if (boundContentDigest) input.content_digest = boundContentDigest;
      const outcome = await executeStageWithControl(run.run_id, stage.stage_id, input);
      if (outcome.kind === 'cancelled') {
        run = getRun(runId);
        run.stages[index].status = 'CANCELLED';
        run.stages[index].completed_at = now();
        run.status = 'CANCELLED';
        run.completed_at = now();
        return persist(run);
      }
      let result;
      if (outcome.kind === 'timeout') {
        result = {
          status: 'FAILED',
          status_note: '阶段执行超过服务端时间上限',
          error: { code: 'WIKI_BUILD_STAGE_TIMEOUT', message: '构建阶段执行超时，可检查依赖后重试' },
        };
      } else if (outcome.kind === 'error') {
        result = { status: 'FAILED', status_note: '阶段执行异常', error: publicError(outcome.error) };
      } else {
        result = outcome.result;
      }

      run = getRun(runId);
      const current = run.stages[index];
      current.status = normalizeStageStatus(result.status);
      current.completed_at = now();
      current.evidence_ref = result.evidence_ref || null;
      current.status_note = String(result.status_note || '').slice(0, 1000);
      current.error = result.error ? {
        code: String(result.error.code || 'WIKI_BUILD_STAGE_FAILED').slice(0, 160),
        message: String(result.error.message || '构建阶段失败').slice(0, 500),
      } : null;
      const stageDigest = result.content_digest || result.outputs && result.outputs.content_digest || null;
      if (current.stage_id === 'source-snapshot' && stageDigest) run.source_content_digest = stageDigest;
      if (current.status === 'BLOCKED' || current.status === 'FAILED') {
        run.status = current.status;
        run.completed_at = now();
        run.last_error = current.error || {
          code: current.status === 'BLOCKED' ? 'WIKI_BUILD_STAGE_BLOCKED' : 'WIKI_BUILD_STAGE_FAILED',
          message: current.status_note || '构建阶段未通过',
        };
        return persist(run);
      }
      persist(run);
    }

    run = getRun(runId);
    if (!run.candidate_revision) {
      try {
        await freezeCandidate(run, run.source_content_digest);
      } catch (error) {
        if (error && error.code === 'WIKI_BUILD_SOURCE_CHANGED') return blockSourceChanged(run);
        return failCandidateFreeze(run);
      }
    }
    run.status = 'READY_FOR_REVIEW';
    run.completed_at = now();
    run.retry_from_stage_index = null;
    run.last_error = null;
    return persist(run);
  }

  function executeRun(runId) {
    const id = getRun(runId).run_id;
    if (active.has(id)) return active.get(id);
    const promise = performRun(id).finally(() => active.delete(id));
    active.set(id, promise);
    return promise;
  }

  function scheduleRun(runId) {
    const run = getRun(runId);
    if (!['PENDING', 'PAUSED'].includes(run.status)) return clone(run);
    schedule(() => {
      executeRun(run.run_id).catch((error) => console.error('[wiki-build-run]', error && error.message || error));
    });
    return clone(run);
  }

  function resumeRun(runId) {
    ensurePipelineRun(runId);
    const run = getRun(runId);
    if (!['PAUSED', 'PENDING'].includes(run.status)) fail('WIKI_BUILD_RESUME_INVALID', '当前构建状态不能继续', 409);
    run.status = 'PENDING';
    run.cancel_requested = false;
    run.last_error = null;
    persist(run);
    scheduleRun(run.run_id);
    return getRun(run.run_id);
  }

  function retryRun(runId, updates) {
    ensurePipelineRun(runId);
    const patch = updates || {};
    const run = getRun(runId);
    if (!['BLOCKED', 'FAILED', 'PAUSED'].includes(run.status)) fail('WIKI_BUILD_RETRY_INVALID', '当前构建状态不能重试', 409);
    const projectRoot = resolveInside(wikiRoot, run.project, 'WIKI_BUILD_PROJECT_INVALID');
    const sourceChanged = run.last_error && run.last_error.code === 'WIKI_BUILD_SOURCE_CHANGED'
      || Boolean(run.source_content_digest) && markdownProjectDigest(projectRoot) !== run.source_content_digest;
    const failedIndex = run.stages.findIndex((stage) => ['BLOCKED', 'FAILED', 'RUNNING'].includes(stage.status));
    const retryIndex = Number.isInteger(run.retry_from_stage_index) ? run.retry_from_stage_index : -1;
    const pendingIndex = run.stages.findIndex((stage) => stage.status === 'PENDING');
    const start = sourceChanged ? 0 : failedIndex >= 0 ? failedIndex : retryIndex >= 0 ? retryIndex : pendingIndex;
    if (start < 0) fail('WIKI_BUILD_RETRY_STAGE_NOT_FOUND', '没有可重试的构建阶段', 409);
    for (let index = start; index < run.stages.length; index += 1) {
      const stage = run.stages[index];
      stage.status = 'PENDING';
      stage.started_at = null;
      stage.completed_at = null;
      stage.evidence_ref = null;
      stage.status_note = '';
      stage.error = null;
    }
    if (sourceChanged) {
      run.source_content_digest = null;
      run.candidate_revision = null;
    }
    if (patch.dataset_ref !== undefined) run.dataset_ref = patch.dataset_ref ? String(patch.dataset_ref).slice(0, 160) : null;
    if (patch.model !== undefined) run.model = patch.model ? String(patch.model).slice(0, 160) : null;
    run.status = 'PENDING';
    run.cancel_requested = false;
    run.completed_at = null;
    run.retry_from_stage_index = null;
    run.last_error = null;
    persist(run);
    if (patch.auto_start !== false) scheduleRun(run.run_id);
    return getRun(run.run_id);
  }

  function cancelRun(runId) {
    ensurePipelineRun(runId);
    const run = getRun(runId);
    if (run.status === 'CANCELLED') return clone(run);
    if (run.status === 'READY_FOR_REVIEW') fail('WIKI_BUILD_CANCEL_INVALID', '候选版本已经就绪，不能取消', 409);
    if (run.status === 'RUNNING') {
      run.cancel_requested = true;
      persist(run);
      return getRun(run.run_id);
    }
    run.status = 'CANCELLED';
    run.cancel_requested = true;
    run.completed_at = now();
    run.stages.forEach((stage) => {
      if (stage.status === 'PENDING') stage.status = 'CANCELLED';
    });
    return persist(run);
  }

  recoverInterruptedRuns();

  return {
    createRun,
    listRuns,
    getRun: (runId) => clone(getRun(runId)),
    executeRun,
    scheduleRun,
    resumeRun,
    retryRun,
    cancelRun,
    getCandidate,
    getCandidateFile,
    listReviews,
    createReview,
  };
}

function parseJsonBody(req, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const limit = maximumBytes || 256 * 1024;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        const error = new Error('请求体超过限制');
        error.code = 'WIKI_BUILD_BODY_TOO_LARGE';
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(Object.assign(new Error('请求体必须是 JSON'), { code: 'WIKI_BUILD_JSON_INVALID', statusCode: 400 })); }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function createWikiBuildRunsHandler(providedStore, handlerOptions) {
  let store = providedStore || null;
  const options = handlerOptions || {};
  const mutationLimit = Number(options.mutation_limit || 30);
  const windowMs = Number(options.window_ms || 60 * 1000);
  const bodyLimit = Math.max(32, Number(options.body_limit || 256 * 1024));
  const buckets = new Map();
  const { authenticate } = require('../middleware/auth');
  function getStore() {
    if (!store) store = createWikiBuildRunStore();
    return store;
  }
  function consume(actor) {
    const timestamp = Date.now();
    const current = buckets.get(actor);
    if (!current || timestamp >= current.reset_at) {
      buckets.set(actor, { count: 1, reset_at: timestamp + windowMs });
      return true;
    }
    if (current.count >= mutationLimit) return false;
    current.count += 1;
    return true;
  }
  function currentActor(req) {
    return String(req.user && (req.user.userId || req.user.username)
      || req.socket && req.socket.remoteAddress || 'anonymous');
  }
  return function handleWikiBuildRunsRequest(req, res) {
    let url;
    try { url = new URL(req.url || '/', 'http://' + (req.headers && req.headers.host || 'localhost')); }
    catch (_) { return false; }
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/knowledge-builder/wiki/runs')) return false;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
      res.end();
      return true;
    }
    if (!authenticate(req, res)) return true;
    if (req.method === 'POST') {
      const actor = currentActor(req);
      if (!consume(actor)) {
        sendJson(res, 429, { success: false, error: { code: 'WIKI_BUILD_RATE_LIMITED', message: 'Wiki 构建操作过于频繁，请稍后重试' } });
        return true;
      }
    }
    const execute = async () => {
      const runStore = getStore();
      if (req.method === 'GET' && pathname === '/api/knowledge-builder/wiki/runs') {
        return { statusCode: 200, value: runStore.listRuns(url.searchParams.get('project') || '') };
      }
      if (req.method === 'POST' && pathname === '/api/knowledge-builder/wiki/runs') {
        const body = await parseJsonBody(req, bodyLimit);
        body.requested_by = req.user && (req.user.userId || req.user.username) || body.requested_by;
        const run = runStore.createRun(body);
        runStore.scheduleRun(run.run_id);
        return { statusCode: 202, value: runStore.getRun(run.run_id) };
      }
      const reviewMatch = pathname.match(/^\/api\/knowledge-builder\/wiki\/runs\/([^/]+)\/reviews$/);
      if (reviewMatch) {
        const runId = decodeURIComponent(reviewMatch[1]);
        if (req.method === 'GET') return { statusCode: 200, value: runStore.listReviews(runId) };
        if (req.method === 'POST') {
          const body = await parseJsonBody(req, bodyLimit);
          return { statusCode: 201, value: runStore.createReview(runId, body, currentActor(req)) };
        }
        fail('WIKI_REVIEW_ROUTE_NOT_FOUND', 'Wiki 审阅路由不存在', 404);
      }
      const candidateMatch = pathname.match(/^\/api\/knowledge-builder\/wiki\/runs\/([^/]+)\/candidate(?:\/(file))?$/);
      if (candidateMatch) {
        if (req.method !== 'GET') fail('WIKI_BUILD_ROUTE_NOT_FOUND', 'Wiki 候选版本路由不存在', 404);
        const runId = decodeURIComponent(candidateMatch[1]);
        if (candidateMatch[2] === 'file') return { statusCode: 200, value: runStore.getCandidateFile(runId, url.searchParams.get('path') || '') };
        return { statusCode: 200, value: runStore.getCandidate(runId) };
      }
      const match = pathname.match(/^\/api\/knowledge-builder\/wiki\/runs\/([^/]+)(?:\/(resume|retry|cancel))?$/);
      if (!match) fail('WIKI_BUILD_ROUTE_NOT_FOUND', 'Wiki 构建运行路由不存在', 404);
      const runId = decodeURIComponent(match[1]);
      const action = match[2] || null;
      if (req.method === 'GET' && !action) return { statusCode: 200, value: runStore.getRun(runId) };
      if (req.method !== 'POST' || !action) fail('WIKI_BUILD_ROUTE_NOT_FOUND', 'Wiki 构建运行路由不存在', 404);
      const body = await parseJsonBody(req, bodyLimit);
      if (action === 'resume') return { statusCode: 202, value: runStore.resumeRun(runId) };
      if (action === 'retry') return { statusCode: 202, value: runStore.retryRun(runId, body) };
      return { statusCode: 200, value: runStore.cancelRun(runId) };
    };
    execute()
      .then(({ statusCode, value }) => sendJson(res, statusCode, { success: true, data: value }))
      .catch((error) => {
        const statusCode = error.statusCode || 500;
        const safeMessage = statusCode >= 500 ? 'Wiki 构建运行服务执行失败，请查看服务日志后重试' : String(error.message || '请求失败').slice(0, 500);
        sendJson(res, statusCode, { success: false, error: { code: error.code || 'WIKI_BUILD_RUN_ERROR', message: safeMessage } });
      });
    return true;
  };
}

const handleWikiBuildRunsRequest = createWikiBuildRunsHandler();

module.exports = {
  DEFAULT_WIKI_STAGES,
  createWikiBuildRunStore,
  createWikiBuildRunsHandler,
  handleWikiBuildRunsRequest,
};
