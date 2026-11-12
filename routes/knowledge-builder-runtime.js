'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { WikiEngine, WikiMaintainer, GraphBuilder } = require('../tools/llm-wiki-engine');
const { RAGEngine } = require('../tools/rag-engine');
const { validateTemplate, validateGraph } = require('../tools/x6-graph-template-validator');
const { createWikiQaService } = require('../tools/knowledge-wiki-qa-service');
const { createRagAnswerService } = require('../tools/knowledge-rag-answer-service');
const wikiQuestionEvaluation = require('../tools/knowledge-wiki-evaluation');
const { API_ROUTES, DEFAULT_CHAT_MODEL } = require('../config/api-keys');
const { authenticate } = require('../middleware/auth');
const { validateSkillPackage } = require('./agent-skill-spec');

// TTL 缓存：releases 递归目录扫描开销大
function createTTLCache(ttlMs) {
  const store = new Map();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.ts > ttlMs) { store.delete(key); return undefined; }
      return entry.value;
    },
    set(key, value) { store.set(key, { value, ts: Date.now() }); },
    clear() { store.clear(); },
  };
}
const { createPlatformAgentRuntimeClient } = require('./platform-agent-runtime-client');
const { createWikiReviewStore } = require('./knowledge-builder-wiki-reviews');

const DEFAULT_RAG_ANSWER_MODEL = DEFAULT_CHAT_MODEL;

// 发布即注册：wiki release 落盘后向 Knowledge Hub 登记（fire-and-forget，失败仅告警不阻断发布）。
function registerHubWikiPublication(release) {
  const hubBase = process.env.KNOWLEDGE_HUB_URL || 'http://ontomind-server:8080';
  const body = {
    assetId: String(release.artifact_id).slice(0, 160),
    version: String(release.artifact_version_id).slice(0, 160),
    name: String(release.alias || release.project || release.artifact_id).slice(0, 300),
    domain: String(release.project || 'general').slice(0, 160),
    channel: release.channel || 'STAGING',
    contentDigest: release.content_digest,
    runtimeRef: '/ontomind/wiki/api/knowledge-builder/wiki/releases',
  };
  const idempotencyKey = `wiki:${body.assetId}:${body.version}:${body.contentDigest}`.slice(0, 160);
  fetch(`${hubBase}/api/v1/knowledge-hub/wiki-publications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`[knowledge-builder] Hub wiki publication registered: ${body.assetId}@${body.version}`);
  }).catch((err) => {
    console.warn(`[knowledge-builder] Hub wiki publication registration failed (non-blocking): ${err.message}`);
  });
}

const WIKI_STAGES = new Set([
  'source-snapshot', 'parse-normalize', 'outline-pages', 'citation-linking',
  'wiki-lint', 'content-security', 'wiki-evaluation', 'observe',
]);
const WIKI_GATE_STAGES = [
  'source-snapshot', 'parse-normalize', 'outline-pages', 'citation-linking',
  'wiki-lint', 'content-security', 'wiki-evaluation',
];
const VECTOR_GATE_STAGES = [
  'source-snapshot', 'parse-elements', 'chunk-index', 'embedding-rerank',
  'index-lint', 'content-security', 'retrieval-evaluation',
];
const VECTOR_STAGES = new Set([
  'source-snapshot', 'parse-elements', 'chunk-index', 'embedding-rerank',
  'index-lint', 'content-security', 'retrieval-evaluation', 'generation-evaluation', 'observe',
]);
const GRAPH_STAGES = new Set([
  'source-snapshot', 'ontology-schema', 'entity-relation', 'entity-resolution',
  'shacl-check', 'graph-security', 'graph-evaluation', 'observe',
]);
const GRAPH_GATE_STAGES = [
  'source-snapshot', 'ontology-schema', 'entity-relation', 'entity-resolution',
  'shacl-check', 'graph-security', 'graph-evaluation',
];
const SKILL_STAGES = new Set([
  'intent-contract', 'skill-package', 'skill-lint', 'supply-chain-security',
  'credential-scan', 'prompt-injection-check',
  'sandbox-execution', 'trigger-evaluation', 'task-evaluation', 'observe',
]);
const SKILL_GATE_STAGES = [
  'intent-contract', 'skill-package', 'skill-lint', 'supply-chain-security',
  'credential-scan', 'prompt-injection-check',
  'sandbox-execution', 'trigger-evaluation', 'task-evaluation',
];
const REGISTRY_IDS = {
  artifacts: 'artifact_id',
  artifactVersions: 'artifact_version_id',
  buildRuns: 'run_id',
  findings: 'finding_id',
  evaluationRuns: 'evaluation_run_id',
  gateDecisions: 'gate_decision_id',
  releases: 'release_id',
};

function fail(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode || 400;
  throw error;
}

function normalizeVectorReleaseProfile(value) {
  const profile = String(value || '').trim().toUpperCase() || 'VECTOR_INDEX';
  if (!['VECTOR_INDEX', 'RAG_SERVICE'].includes(profile)) {
    fail('RELEASE_PROFILE_INVALID', '向量知识库交付形态无效');
  }
  return profile;
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameJsonValue(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return isDeepStrictEqual(clone(left), clone(right));
}

function emptyRegistrySnapshot() {
  return Object.keys(REGISTRY_IDS).reduce((result, group) => {
    result[group] = [];
    return result;
  }, {});
}

function validateRegistrySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    fail('REGISTRY_SNAPSHOT_INVALID', '知识资产注册表快照必须是对象');
  }
  const unknown = Object.keys(snapshot).filter((group) => !Object.prototype.hasOwnProperty.call(REGISTRY_IDS, group));
  if (unknown.length) fail('REGISTRY_SNAPSHOT_INVALID', '知识资产注册表包含未知集合：' + unknown.join(', '));
  const normalized = emptyRegistrySnapshot();
  Object.keys(REGISTRY_IDS).forEach((group) => {
    const records = snapshot[group];
    if (!Array.isArray(records)) fail('REGISTRY_SNAPSHOT_INVALID', group + ' 必须是数组');
    if (records.length > 20000) fail('REGISTRY_SNAPSHOT_TOO_LARGE', group + ' 记录数超过上限', 413);
    const idField = REGISTRY_IDS[group];
    const ids = new Set();
    normalized[group] = records.map((record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        fail('REGISTRY_SNAPSHOT_INVALID', group + ' 包含无效记录');
      }
      const id = record[idField];
      if (typeof id !== 'string' || !id.trim() || id.length > 240) {
        fail('REGISTRY_SNAPSHOT_INVALID', group + ' 记录缺少有效的 ' + idField);
      }
      if (ids.has(id)) fail('REGISTRY_SNAPSHOT_INVALID', group + ' 包含重复标识：' + id);
      ids.add(id);
      return clone(record);
    });
  });
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 4 * 1024 * 1024) {
    fail('REGISTRY_SNAPSHOT_TOO_LARGE', '知识资产注册表快照超过 4MB 上限', 413);
  }
  return normalized;
}

function safeSegment(value, field) {
  const text = String(value || '').trim();
  if (!text || !/^[\w.\-:\u3400-\u9fff]+$/u.test(text) || text === '.' || text === '..') {
    fail('PATH_SEGMENT_INVALID', (field || '标识') + '包含不安全字符');
  }
  return text.replace(/:/g, '__');
}

function resolveInside(root, child, code) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, child);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    fail(code || 'PATH_OUTSIDE_ROOT', '目标路径超出允许范围');
  }
  return resolved;
}

function listMarkdownFiles(projectRoot) {
  const files = [];
  function walk(directory) {
    fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .forEach((entry) => {
        if (entry.name.startsWith('.')) return;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'log.md') files.push(fullPath);
      });
  }
  walk(projectRoot);
  return files;
}

function parseFrontmatter(content) {
  const match = String(content || '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return {};
  return match[1].split(/\r?\n/).reduce((result, line) => {
    const field = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (field) result[field[1].toLowerCase()] = field[2].replace(/^['"]|['"]$/g, '').trim();
    return result;
  }, {});
}

function summarizeProject(projectRoot) {
  const files = listMarkdownFiles(projectRoot);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let headings = 0;
  let wikiLinks = 0;
  let citations = 0;
  let owners = 0;
  let verified = 0;
  const pages = files.map((filePath) => {
    const relativePath = path.relative(projectRoot, filePath).split(path.sep).join('/');
    const buffer = fs.readFileSync(filePath);
    const content = buffer.toString('utf8');
    const metadata = parseFrontmatter(content);
    const pageHeadings = (content.match(/^#{1,6}\s+.+$/gm) || []).length;
    const pageLinks = (content.match(/\[\[[^\]]+\]\]/g) || []).length;
    const pageCitations = (content.match(/\[(?:source|citation|来源|引用)[:：][^\]]+\]/gi) || []).length;
    bytes += buffer.length;
    headings += pageHeadings;
    wikiLinks += pageLinks;
    citations += pageCitations;
    if (metadata.owner) owners += 1;
    if (metadata.verified_until || metadata.verification_expires_at) verified += 1;
    hash.update(relativePath);
    hash.update('\0');
    hash.update(buffer);
    hash.update('\0');
    return {
      path: relativePath,
      size: buffer.length,
      digest: 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex'),
      title: metadata.title || ((content.match(/^#\s+(.+)$/m) || [])[1]) || path.basename(relativePath, '.md'),
      owner: metadata.owner || null,
      verified_until: metadata.verified_until || metadata.verification_expires_at || null,
      headings: pageHeadings,
      wiki_links: pageLinks,
      citations: pageCitations,
    };
  });
  return {
    content_digest: 'sha256:' + hash.digest('hex'),
    page_count: pages.length,
    total_bytes: bytes,
    heading_count: headings,
    wiki_link_count: wikiLinks,
    citation_count: citations,
    owner_coverage: pages.length ? Number((owners / pages.length).toFixed(4)) : 0,
    verification_coverage: pages.length ? Number((verified / pages.length).toFixed(4)) : 0,
    pages,
  };
}

function redactLocation(projectRoot, filePath, lineNumber) {
  return path.relative(projectRoot, filePath).split(path.sep).join('/') + ':' + lineNumber;
}

function scanSecurity(projectRoot) {
  const patterns = [
    { category: 'PRIVATE_KEY', severity: 'CRITICAL', blocking: true, regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i, title: '检测到私钥材料' },
    { category: 'SECRET_EXPOSURE', severity: 'CRITICAL', blocking: true, regex: /\b(?:sk|ak)-[A-Za-z0-9_-]{20,}\b/, title: '检测到疑似访问密钥' },
    { category: 'SECRET_EXPOSURE', severity: 'HIGH', blocking: true, regex: /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s]{12,}/i, title: '检测到疑似凭据赋值' },
    { category: 'PROMPT_INJECTION', severity: 'HIGH', blocking: true, regex: /(?:ignore|disregard)\s+(?:all\s+)?previous\s+instructions|忽略(?:以上|之前|此前).{0,8}(?:指令|提示)|导出.{0,8}(?:凭据|密钥)/i, title: '检测到疑似提示注入指令' },
    { category: 'PII', severity: 'MEDIUM', blocking: false, regex: /\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b/, title: '检测到疑似个人敏感信息' },
  ];
  const findings = [];
  listMarkdownFiles(projectRoot).forEach((filePath) => {
    fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line, index) => {
      patterns.forEach((rule) => {
        rule.regex.lastIndex = 0;
        if (!rule.regex.test(line)) return;
        findings.push({
          category: rule.category,
          severity: rule.severity,
          blocking: rule.blocking,
          title: rule.title,
          detail: '位置：' + redactLocation(projectRoot, filePath, index + 1) + '；命中内容已脱敏，请在源文件中处理。',
          location: redactLocation(projectRoot, filePath, index + 1),
        });
      });
    });
  });
  return findings;
}

function configuredEmbedding() {
  const route = API_ROUTES && API_ROUTES['text-embedding-v4'];
  if (!route) return null;
  const apiKey = typeof route.getKey === 'function' ? route.getKey() : null;
  if (!apiKey) return null;
  return {
    host: route.host,
    path: route.path,
    apiKey,
    model: route.model || 'text-embedding-v4',
    batchSize: 10,
  };
}

function configuredWikiGenerator(model) {
  const route = API_ROUTES && API_ROUTES[String(model || DEFAULT_CHAT_MODEL)];
  if (!route || typeof route.getKey !== 'function') return false;
  try { return Boolean(route.getKey()); } catch (_) { return false; }
}

function configuredRagGenerator(apiRoutes, model) {
  const route = apiRoutes && apiRoutes[String(model || DEFAULT_RAG_ANSWER_MODEL)];
  if (!route || typeof route.getKey !== 'function') return false;
  try { return Boolean(route.getKey()); } catch (_) { return false; }
}

function createKnowledgeBuilderRuntime(options) {
  const source = options || {};
  const workspaceRoot = path.resolve(source.workspaceRoot || path.join(__dirname, '..'));
  const wikiRoot = path.resolve(source.wikiRoot || path.join(workspaceRoot, 'wiki'));
  const sourcesRoot = path.resolve(source.sourcesRoot || path.join(workspaceRoot, 'sources'));
  const dataRoot = path.resolve(source.dataRoot || path.join(workspaceRoot, 'data', 'knowledge-builder'));
  const graphsRoot = path.resolve(source.graphsRoot || path.join(workspaceRoot, 'data', 'graphs'));
  const graphTemplatesRoot = path.resolve(source.graphTemplatesRoot || path.join(workspaceRoot, 'data', 'graph-builder-templates'));
  const skillsRoot = path.resolve(source.skillsRoot || path.join(workspaceRoot, 'skills'));
  const skillVersionsRoot = path.resolve(source.skillVersionsRoot || path.join(dataRoot, 'skill-check-versions'));
  const evidenceRoot = path.join(dataRoot, 'evidence');
  const releasesRoot = path.join(dataRoot, 'releases');
  const releasesCache = createTTLCache(5000);
  const aliasesRoot = path.join(dataRoot, 'aliases');
  const gatesRoot = path.join(dataRoot, 'gates');
  const evalDatasetsRoot = path.join(dataRoot, 'eval-datasets');
  const registryRoot = path.join(dataRoot, 'registry');
  const fetchImpl = source.fetchImpl || globalThis.fetch;
  const now = typeof source.now === 'function' ? source.now : () => new Date().toISOString();
  const wikiReviewStore = source.wikiReviewStore || createWikiReviewStore({ workspaceRoot, dataRoot, now });
  const evaluatorUrl = String(source.evaluatorUrl || process.env.ONTOMIND_KNOWLEDGE_URL || 'http://ontomind-knowledge:8000').replace(/\/$/, '');
  const ragApiRoutes = source.apiRoutes || API_ROUTES;
  const wikiMaintainer = source.wikiMaintainer || new WikiMaintainer(new WikiEngine());
  const graphBuilder = source.graphBuilder || new GraphBuilder();
  const wikiQaService = source.wikiQaService || createWikiQaService({ apiRoutes: API_ROUTES });
  const wikiEvaluation = source.wikiEvaluation || wikiQuestionEvaluation;
  const ragAnswerService = source.ragAnswerService || createRagAnswerService({
    apiRoutes: ragApiRoutes,
    defaultModel: DEFAULT_RAG_ANSWER_MODEL,
    requestImpl: source.ragAnswerRequestImpl,
  });
  const ragGenerationEvaluation = source.ragGenerationEvaluation || require('../tools/knowledge-rag-generation-evaluation');
  const skillRuntimeClient = source.skillRuntimeClient || createPlatformAgentRuntimeClient({
    fetchImpl: source.agentRuntimeFetchImpl,
    baseUrl: source.agentRuntimeUrl,
    timeoutMs: source.agentRuntimeTimeoutMs,
  });
  const ragEngineFactory = source.ragEngineFactory || (() => new RAGEngine({ wikiDir: wikiRoot, embeddingConfig: configuredEmbedding() }));
  const injectedRagCacheVerifier = typeof source.ragCacheVerifier === 'function' ? source.ragCacheVerifier : null;
  const snapshotCopy = typeof source.snapshotCopy === 'function'
    ? source.snapshotCopy
    : (sourceRoot, snapshotPath, copyOptions) => fs.cpSync(sourceRoot, snapshotPath, { recursive: true, errorOnExist: true, force: false, ...copyOptions });
  const ragEngines = new Map();
  ensureDir(evidenceRoot);
  ensureDir(releasesRoot);
  ensureDir(aliasesRoot);
  ensureDir(gatesRoot);
  ensureDir(evalDatasetsRoot);
  ensureDir(registryRoot);

  function registryPath(owner) {
    const identity = String(owner || '').trim();
    if (!identity || identity.length > 160) fail('REGISTRY_OWNER_INVALID', '知识资产注册表缺少有效的所属用户');
    return path.join(registryRoot, crypto.createHash('sha256').update(identity).digest('hex') + '.json');
  }

  function getRegistry(owner) {
    const filePath = registryPath(owner);
    if (!fs.existsSync(filePath)) return { revision: 0, snapshot: emptyRegistrySnapshot(), updated_at: null };
    let stored;
    try { stored = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (_) { fail('REGISTRY_STORAGE_CORRUPT', '服务端知识资产注册表已损坏，已停止读写以保护数据', 500); }
    if (!Number.isSafeInteger(stored.revision) || stored.revision < 1 || typeof stored.updated_at !== 'string') {
      fail('REGISTRY_STORAGE_CORRUPT', '服务端知识资产注册表修订信息无效', 500);
    }
    return { revision: stored.revision, snapshot: validateRegistrySnapshot(stored.snapshot), updated_at: stored.updated_at };
  }

  function validateRegistryBaseRevision(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('REGISTRY_BASE_REVISION_INVALID', 'base_revision 必须是非负整数');
    }
  }

  function putRegistry(owner, request) {
    const input = request || {};
    validateRegistryBaseRevision(input.base_revision);
    const current = getRegistry(owner);
    if (input.base_revision !== current.revision) {
      fail('REGISTRY_REVISION_CONFLICT', '服务端知识资产注册表已有更新，请刷新后重试', 409);
    }
    const record = {
      revision: current.revision + 1,
      snapshot: validateRegistrySnapshot(input.snapshot),
      updated_at: now(),
    };
    const filePath = registryPath(owner);
    const tempPath = filePath + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(tempPath, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(tempPath, filePath);
    } catch (_) {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
      fail('REGISTRY_STORAGE_WRITE_FAILED', '服务端无法持久化知识资产注册表', 500);
    }
    return clone(record);
  }

  function archiveRegistryArtifact(owner, artifactId, request) {
    const input = request || {};
    const id = typeof artifactId === 'string' ? artifactId.trim() : '';
    if (!id || id.length > 500) fail('REGISTRY_ARTIFACT_ID_INVALID', 'artifactId 必须是有效的制品标识');
    validateRegistryBaseRevision(input.base_revision);
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 500) fail('REGISTRY_ARCHIVE_REASON_INVALID', 'reason 必须是 1 到 500 个字符');
    const current = getRegistry(owner);
    if (input.base_revision !== current.revision) {
      fail('REGISTRY_REVISION_CONFLICT', '服务端知识资产注册表已有更新，请刷新后重试', 409);
    }
    const artifact = current.snapshot.artifacts.find(function (record) { return record.artifact_id === id; });
    if (!artifact) fail('REGISTRY_ARTIFACT_NOT_FOUND', '指定的知识制品不存在', 404);
    const versions = current.snapshot.artifactVersions.filter(function (record) { return record.artifact_id === id; });
    const versionIds = new Set(versions.map(function (record) { return record.artifact_version_id; }));
    const versionRunIds = new Set(versions.map(function (record) { return record.build_run_id; }).filter(Boolean));
    const runIds = new Set(current.snapshot.buildRuns.filter(function (record) {
      return record.artifact_id === id || versionRunIds.has(record.run_id);
    }).map(function (record) { return record.run_id; }));
    const gateIds = new Set(current.snapshot.gateDecisions.filter(function (record) {
      return versionIds.has(record.artifact_version_id);
    }).map(function (record) { return record.gate_decision_id; }));
    const releaseIds = new Set(current.snapshot.releases.filter(function (record) {
      return versionIds.has(record.artifact_version_id) || gateIds.has(record.gate_decision_id);
    }).map(function (record) { return record.release_id; }));
    const dependentCounts = {
      artifact_versions: versionIds.size,
      build_runs: runIds.size,
      findings: current.snapshot.findings.filter(function (record) { return versionIds.has(record.artifact_version_id); }).length,
      evaluation_runs: current.snapshot.evaluationRuns.filter(function (record) { return versionIds.has(record.artifact_version_id); }).length,
      gate_decisions: gateIds.size,
      releases: releaseIds.size,
    };
    const archive = { artifact_id: id, dependent_counts: dependentCounts };
    if (artifact.lifecycle_status === 'DEPRECATED') {
      return Object.assign(current, { archive: archive });
    }
    const snapshot = clone(current.snapshot);
    const target = snapshot.artifacts.find(function (record) { return record.artifact_id === id; });
    const timestamp = now();
    target.lifecycle_status = 'DEPRECATED';
    target.archived_at = timestamp;
    target.archived_by = owner;
    target.archive_reason = reason;
    target.updated_at = timestamp;
    const accepted = putRegistry(owner, { base_revision: current.revision, snapshot: snapshot });
    return Object.assign(accepted, { archive: archive });
  }

  function projectPath(project) {
    const name = String(project || '').trim();
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..') fail('PROJECT_PATH_INVALID', 'Wiki 项目标识不合法');
    const resolved = resolveInside(wikiRoot, name, 'PROJECT_PATH_INVALID');
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) fail('WIKI_PROJECT_NOT_FOUND', 'Wiki 项目不存在', 404);
    return resolved;
  }

  function graphAsset(input) {
    const project = safeSegment(input && input.project, 'project').replace(/__/g, ':');
    const templateName = safeSegment(input && input.template_ref || (project === 'org' ? 'org-people' : project), 'template_ref').replace(/__/g, ':');
    const projectRoot = resolveInside(graphsRoot, project, 'GRAPH_PROJECT_PATH_INVALID');
    const templatePath = resolveInside(graphTemplatesRoot, templateName + '.json', 'GRAPH_TEMPLATE_PATH_INVALID');
    if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) fail('GRAPH_PROJECT_NOT_FOUND', '图谱项目不存在', 404);
    if (!fs.existsSync(templatePath)) fail('GRAPH_TEMPLATE_NOT_FOUND', '图谱模板不存在', 404);
    let graphPath;
    if (input && input.graph_ref) {
      const reference = String(input.graph_ref);
      if (!/^[\w.\-\/]+$/.test(reference) || reference.includes('..')) fail('GRAPH_DOCUMENT_PATH_INVALID', '图文档引用不合法');
      graphPath = resolveInside(projectRoot, reference, 'GRAPH_DOCUMENT_PATH_INVALID');
    } else {
      const draftPath = path.join(projectRoot, 'drafts', project + '-graph-draft.json');
      graphPath = fs.existsSync(draftPath) ? draftPath : path.join(projectRoot, project + '-graph-v1.json');
    }
    if (!fs.existsSync(graphPath)) fail('GRAPH_DOCUMENT_NOT_FOUND', '图谱文档不存在', 404);
    const templateBuffer = fs.readFileSync(templatePath);
    const graphBuffer = fs.readFileSync(graphPath);
    const template = JSON.parse(templateBuffer.toString('utf8'));
    const graph = JSON.parse(graphBuffer.toString('utf8'));
    const digest = 'sha256:' + crypto.createHash('sha256').update(templateBuffer).update('\0').update(graphBuffer).digest('hex');
    return { project, projectRoot, templatePath, graphPath, template, graph, content_digest: digest };
  }

  function skillAsset(input) {
    const project = safeSegment(input && input.project, 'project').replace(/__/g, ':');
    const versionRef = String(input && input.version_ref || '').trim();
    let root;
    if (versionRef) {
      const match = versionRef.match(/^skill-version:([^:]+):([a-f0-9]{64})$/);
      if (!match) fail('SKILL_VERSION_REF_INVALID', 'Skill 固定版本标识不合法');
      const versionProject = safeSegment(match[1], 'version_ref project').replace(/__/g, ':');
      if (versionProject !== project) fail('SKILL_VERSION_PROJECT_MISMATCH', 'Skill 固定版本与当前项目不一致', 409);
      root = resolveInside(skillVersionsRoot, path.join(project, match[2]), 'SKILL_VERSION_PATH_INVALID');
    } else {
      root = resolveInside(skillsRoot, project, 'SKILL_PROJECT_PATH_INVALID');
    }
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail('SKILL_PROJECT_NOT_FOUND', 'Skill 项目不存在', 404);
    const skillPath = path.join(root, 'SKILL.md');
    if (!fs.existsSync(skillPath)) fail('SKILL_MD_NOT_FOUND', 'Skill 项目缺少 SKILL.md', 404);
    const files = [];
    function walk(directory) {
      fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((entry) => {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) return;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.isFile()) files.push(fullPath);
      });
    }
    walk(root);
    if (files.length > 2000) fail('SKILL_PACKAGE_TOO_LARGE', 'Skill 包文件数量超过安全上限');
    const hash = crypto.createHash('sha256');
    let totalBytes = 0;
    const manifest = files.map((filePath) => {
      const buffer = fs.readFileSync(filePath);
      const relative = path.relative(root, filePath).split(path.sep).join('/');
      totalBytes += buffer.length;
      hash.update(relative).update('\0').update(buffer).update('\0');
      return { path: relative, size: buffer.length, digest: 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex') };
    });
    const content = fs.readFileSync(skillPath, 'utf8');
    const contentDigest = 'sha256:' + hash.digest('hex');
    if (input && input.content_digest !== undefined && input.content_digest !== contentDigest) {
      fail('SKILL_CONTENT_CHANGED', 'Skill 固定版本的内容摘要不一致，请重新固定版本后再检查', 409);
    }
    return { project, root, skillPath, content, metadata: parseFrontmatter(content), manifest, total_bytes: totalBytes, content_digest: contentDigest, version_ref: versionRef || null };
  }

  function skillSnapshotMatches(snapshotPath, asset) {
    const expected = new Map(asset.manifest.map(entry => [entry.path, entry.digest]));
    let valid = true;
    function walk(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) { walk(filePath); continue; }
        const relative = path.relative(snapshotPath, filePath).split(path.sep).join('/');
        if (!entry.isFile() || !expected.has(relative)) { valid = false; continue; }
        const digest = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
        if (digest !== expected.get(relative)) valid = false;
        expected.delete(relative);
      }
    }
    try { walk(snapshotPath); } catch (_) { return false; }
    return valid && expected.size === 0;
  }

  function persistEvidence(stageId, input, status, outputs, extra) {
    const timestamp = now();
    const payload = {
      evidence_id: 'evidence:' + crypto.randomUUID(),
      evidence_type: extra && extra.evidence_type || 'STAGE_RESULT',
      stage_id: stageId,
      artifact_type: input.artifact_type || 'LLM_WIKI',
      status,
      producer: extra && extra.producer || 'knowledge-builder-runtime:v1',
      inputs: {
        project: input.project,
        artifact_id: input.artifact_id || null,
        artifact_version_id: input.artifact_version_id || null,
        run_id: input.run_id || null,
      },
      outputs: clone(outputs || {}),
      findings: clone(extra && extra.findings || []),
      metrics: clone(extra && extra.metrics || []),
      created_at: timestamp,
    };
    if (input.artifact_type === 'VECTOR_KB' && input.release_profile !== undefined) {
      payload.inputs.release_profile = input.release_profile;
    }
    if (input.content_digest !== undefined) payload.inputs.content_digest = input.content_digest;
    // S11: bind runtime context (dataset / model / runtime / application / policy)
    // into evidence.inputs so trigger-evaluation, task-evaluation and the gate
    // can reject cross-dataset / cross-model re-scoring of an execution that was
    // run under a different context. Previously inputs only carried project +
    // run_id, so an execution from tests-v1 could be scored under other-v1 with
    // a different model. See docs/skill-evolution-review-2026-10-27.md S11.
    if (input.artifact_type === 'AGENT_SKILL') {
      payload.inputs.version_ref = input.version_ref || null;
      if (['sandbox-execution', 'trigger-evaluation', 'task-evaluation'].includes(stageId)) {
        Object.assign(payload.inputs, skillRuntimeContext(input), {
          dataset_version: outputs.dataset_version || null,
          dataset_digest: outputs.dataset_digest || null,
          execution_ref: stageId === 'sandbox-execution' ? null : input.execution_ref || null,
        });
      }
    }
    const id = payload.evidence_id.slice('evidence:'.length);
    fs.writeFileSync(path.join(evidenceRoot, id + '.json'), JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' });
    return 'kb-evidence:' + id;
  }

  function getEvidence(reference) {
    const id = String(reference || '').replace(/^kb-evidence:/, '').replace(/^evidence:/, '');
    if (!/^[a-f0-9-]{36}$/i.test(id)) fail('EVIDENCE_ID_INVALID', '证据标识不合法');
    const filePath = resolveInside(evidenceRoot, id + '.json', 'EVIDENCE_PATH_INVALID');
    if (!fs.existsSync(filePath)) fail('EVIDENCE_NOT_FOUND', '证据不存在', 404);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  function resultWithEvidence(stageId, input, status, outputs, extra) {
    const details = extra || {};
    const evidenceRef = persistEvidence(stageId, input, status, outputs, details);
    return Object.assign({
      stage_id: stageId,
      status,
      status_note: details.status_note || '',
      outputs,
      findings: details.findings || [],
      metrics: details.metrics || [],
      evidence_ref: evidenceRef,
      producer: details.producer || 'knowledge-builder-runtime:v1',
    }, details.content_digest ? { content_digest: details.content_digest } : {}, details.error ? { error: details.error } : {});
  }

  // 聚合 wiki 页面 frontmatter 中的 citations 块（生成端出口 → 评测端输入）
  function collectPageCitations(root) {
    const files = listMarkdownFiles(root).filter((file) => !/(?:^|[\\/])log\.md$/i.test(file)).slice(0, 12);
    const citations = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!frontmatter) continue;
      let current = null;
      for (const line of frontmatter[1].split(/\r?\n/)) {
        if (/^\s*-\s+marker:/.test(line)) {
          if (current && current.source_id) citations.push(current);
          current = { marker: String(line.match(/marker:\s*["']?([^"'\n]+)/)[1] || '').trim() || '[?]', source_id: '', text: '' };
        } else if (current) {
          const sourceId = line.match(/^\s*source_id:\s*["']?([^"'\n]+)/);
          if (sourceId) { current.source_id = String(sourceId[1]).trim(); continue; }
          const text = line.match(/^\s*text:\s*["']?([^"'\n]*)/);
          if (text) current.text = String(text[1]).trim().slice(0, 300);
        }
        if (citations.length >= 50) break;
      }
      if (current && current.source_id) citations.push(current);
      if (citations.length >= 50) break;
    }
    return citations;
  }

  function collectSourceDocuments(project) {
    const candidate = resolveInside(sourcesRoot, project, 'SOURCE_PATH_INVALID');
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) return [];
    const documents = [];
    function walk(directory) {
      fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
        if (entry.name.startsWith('.')) return;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.isFile() && /\.(?:md|txt)$/i.test(entry.name) && documents.length < 20) {
          documents.push({
            id: path.relative(candidate, fullPath).split(path.sep).join('/'),
            title: path.basename(entry.name, path.extname(entry.name)),
            content: fs.readFileSync(fullPath, 'utf8').slice(0, 12000),
          });
        }
      });
    }
    walk(candidate);
    return documents;
  }

  async function evaluateWikiDocumentQuality(input, root) {
    const files = listMarkdownFiles(root).filter((file) => !/(?:^|[\\/])log\.md$/i.test(file));
    const content = files.slice(0, 12).map((file) => fs.readFileSync(file, 'utf8')).join('\n\n---\n\n').slice(0, 24000);
    const sourceDocuments = collectSourceDocuments(input.project);
    const limited = sourceDocuments.length === 0;
    const body = {
      wiki_content: content,
      source_documents: sourceDocuments,
      citations: collectPageCitations(root),
      expected_sections: Array.from(new Set((content.match(/^#{1,3}\s+(.+)$/gm) || []).map((heading) => heading.replace(/^#{1,3}\s+/, '')).slice(0, 12))),
      gold_facts: [],
      eval_mode: limited ? 'structure_only' : 'full',
    };
    try {
      if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
      const response = await fetchImpl(evaluatorUrl + '/api/v1/evaluation/wiki', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response || !response.ok) throw new Error('HTTP ' + (response && response.status || 'unknown'));
      const evaluation = await response.json();
      const metrics = [
        { name: 'Document Overall', value: Number(evaluation.overall_score || 0) / 100, threshold: 0.7, group: 'DOCUMENT' },
        { name: 'Document Factual Precision', value: Number(evaluation.factual_precision || 0), threshold: 0.6, group: 'DOCUMENT' },
        { name: 'Document Structure', value: Number(evaluation.structure_completeness || 0), threshold: 0.8, group: 'DOCUMENT' },
        { name: 'Document Non-redundancy', value: 1 - Number(evaluation.redundancy_score || 0), threshold: 0.75, group: 'DOCUMENT' },
      ];
      return {
        metrics,
        outputs: {
        evaluator_version: evaluation.evaluator_version || 'wiki-eval-v1',
        evaluation_profile: limited ? 'wiki-structure-baseline:v1' : 'wiki-provenance-full:v1',
        evaluation_scope: limited ? 'STRUCTURE_ONLY' : 'FULL',
        source_document_count: sourceDocuments.length,
        statement_count: Number(evaluation.total_statements || 0),
        },
        limited,
      };
    } catch (error) {
      const failure = new Error('Wiki 文档质量评测服务不可用');
      failure.code = 'WIKI_DOCUMENT_EVALUATOR_UNAVAILABLE';
      throw failure;
    }
  }

  function releasedWikiDataset(datasetRef) {
    if (!datasetRef) return null;
    const datasetPath = resolveInside(evalDatasetsRoot, safeSegment(datasetRef, 'dataset_ref') + '.json', 'WIKI_DATASET_PATH_INVALID');
    if (!fs.existsSync(datasetPath)) return null;
    let dataset;
    try { dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8')); }
    catch (_) { fail('WIKI_EVAL_DATASET_INVALID', 'Wiki 评测集无法解析'); }
    if (dataset.artifact_type && dataset.artifact_type !== 'LLM_WIKI') fail('WIKI_EVAL_DATASET_TYPE_MISMATCH', '评测集类型不是 LLM Wiki');
    if (!Array.isArray(dataset.cases) || !dataset.cases.length || dataset.cases.length > 50) {
      fail('WIKI_EVAL_DATASET_INVALID', 'Wiki 评测集必须包含 1-50 个问题用例');
    }
    dataset.cases.forEach((testCase) => {
      // 归一：评测集 API 契约用 question，消费侧统一用 query（原字段不一致 bug 修复）
      if (!testCase.query && typeof testCase.question === 'string' && testCase.question.trim()) {
        testCase.query = testCase.question;
      }
      const hasBaseline = typeof testCase.expected_answer === 'string' && testCase.expected_answer.trim()
        || Array.isArray(testCase.gold_facts) && testCase.gold_facts.some((fact) => String(fact || '').trim());
      if (!testCase || typeof testCase.query !== 'string' || !testCase.query.trim()
        || !Array.isArray(testCase.expected_source_refs) || !hasBaseline) {
        fail('WIKI_EVAL_DATASET_INVALID', 'Wiki 问题用例必须包含 query、expected_source_refs 与期望答案或事实');
      }
    });
    return dataset;
  }

  function meanMetric(caseResults, key) {
    const values = caseResults.map((item) => item[key]).filter((value) => typeof value === 'number' && Number.isFinite(value));
    return values.length ? Number(average(values).toFixed(4)) : null;
  }

  async function judgeWikiAnswer(testCase, qa) {
    if (typeof fetchImpl !== 'function') fail('WIKI_QA_EVALUATOR_UNAVAILABLE', 'Wiki 答案评测服务未配置', 502);
    const response = await fetchImpl(evaluatorUrl + '/api/v1/evaluation/rag', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        query: testCase.query,
        answer: qa.answer,
        retrieved_contexts: (qa.sources || []).slice(0, 5).map((source, index) => ({
          doc_id: source.id, content: String(source.content || '').slice(0, 12000),
          score: Number(source.score || 0), rank: Number(source.rank || index + 1),
        })),
        relevant_doc_ids: testCase.expected_source_refs,
        gold_answer: String(testCase.expected_answer || (testCase.gold_facts || []).join('\n')),
        eval_mode: 'full',
      }),
    });
    if (!response || !response.ok) fail('WIKI_QA_EVALUATOR_UNAVAILABLE', 'Wiki 答案评测服务返回异常', 502);
    const evaluated = await response.json();
    return {
      answer_correctness: evaluated.answer_correctness,
      answer_relevancy: evaluated.answer_relevancy,
      groundedness: evaluated.groundedness !== undefined ? evaluated.groundedness : evaluated.faithfulness,
      evaluator_version: evaluated.evaluator_version || 'rag-eval-v1',
    };
  }

  async function evaluateWiki(input, root) {
    const datasetRef = String(input.dataset_ref || '').trim();
    if (!datasetRef) return resultWithEvidence('wiki-evaluation', input, 'BLOCKED', { evaluation_scope: 'UNAVAILABLE' }, {
      producer: 'knowledge-builder-wiki-qa-eval:v1', metrics: [],
      status_note: '缺少版本化 Wiki 问题评测集，未生成任何替代分数。',
      error: { code: 'WIKI_EVAL_DATASET_REQUIRED', message: '请绑定包含问题、期望来源和答案基线的版本化评测集' },
    });
    const dataset = releasedWikiDataset(datasetRef);
    if (!dataset) return resultWithEvidence('wiki-evaluation', input, 'BLOCKED', { evaluation_scope: 'UNAVAILABLE', dataset_ref: datasetRef }, {
      producer: 'knowledge-builder-wiki-qa-eval:v1', metrics: [], status_note: '绑定的 Wiki 问题评测集不存在。',
      error: { code: 'WIKI_EVAL_DATASET_NOT_FOUND', message: 'Wiki 问题评测集不存在' },
    });

    let documentQuality = { metrics: [], outputs: { evaluation_scope: 'UNAVAILABLE' }, limited: true };
    const findings = [];
    try { documentQuality = await evaluateWikiDocumentQuality(input, root); }
    catch (_) { findings.push({
      category: 'DOCUMENT_EVALUATION', severity: 'MEDIUM', blocking: false,
      title: '文档质量子评测暂不可用', detail: '问题问答主评测继续执行；本次证据不包含文档结构基线。',
    }); }

    const caseResults = [];
    let blockingError = null;
    let evaluatorFailure = null;
    const evaluatorVersions = new Set();
    const generatorVersions = new Set();
    for (const testCase of dataset.cases) {
      let qa;
      try {
        qa = await wikiQaService.answer({ wiki_root: root, question: testCase.query, top_k: Number(input.top_k || 5), model: input.model });
      } catch (_) {
        qa = { generation_mode: 'FAILED', answer: null, sources: [], error: { code: 'WIKI_QA_EXECUTION_FAILED', message: 'Wiki 问答执行失败' } };
      }
      if (qa.generator_version || qa.model) generatorVersions.add(qa.generator_version || qa.model);
      if (qa.generation_mode !== 'GENERATED') {
        const evaluatedCase = wikiEvaluation.evaluateCaseResult({ case_id: testCase.case_id || testCase.id, question: testCase.query, expected_source_refs: testCase.expected_source_refs, qa, judge: null });
        caseResults.push(evaluatedCase);
        const error = qa.error || { code: 'WIKI_QA_GENERATION_FAILED', message: 'Wiki 问答未生成答案' };
        if (qa.generation_mode === 'RETRIEVAL_ONLY' || qa.generation_mode === 'NO_RESULT') blockingError = blockingError || error;
        else evaluatorFailure = evaluatorFailure || error;
        continue;
      }
      try {
        const judge = await judgeWikiAnswer(testCase, qa);
        evaluatorVersions.add(judge.evaluator_version);
        caseResults.push(wikiEvaluation.evaluateCaseResult({
          case_id: testCase.case_id || testCase.id || 'case-' + (caseResults.length + 1),
          question: testCase.query, expected_source_refs: testCase.expected_source_refs, qa, judge,
        }));
      } catch (error) {
        evaluatorFailure = { code: error.code || 'WIKI_QA_EVALUATOR_UNAVAILABLE', message: 'Wiki 答案评测服务不可用' };
        caseResults.push(wikiEvaluation.evaluateCaseResult({
          case_id: testCase.case_id || testCase.id, question: testCase.query, expected_source_refs: testCase.expected_source_refs,
          qa: { ...qa, error: evaluatorFailure }, judge: null,
        }));
      }
    }

    const metricDefinitions = [
      ['Source Recall@5', 'source_recall_at_5', 0.9, 'RETRIEVAL'],
      ['Source MRR', 'source_mrr', 0.8, 'RETRIEVAL'],
      ['Source Precision@5', 'source_precision_at_5', 0.6, 'RETRIEVAL'],
      ['Answer Correctness', 'answer_correctness', 0.8, 'ANSWER'],
      ['Answer Relevancy', 'answer_relevancy', 0.8, 'ANSWER'],
      ['Groundedness', 'groundedness', 0.85, 'ANSWER'],
      ['Citation Coverage', 'citation_coverage', 0.9, 'ANSWER'],
    ];
    const metrics = metricDefinitions.map(([name, key, threshold, group]) => ({ name, value: meanMetric(caseResults, key), threshold, group }))
      .filter((metric) => metric.value !== null);
    metrics.push({ name: 'Generated Answer Coverage', value: Number((caseResults.filter((item) => item.generation_mode === 'GENERATED').length / caseResults.length).toFixed(4)), threshold: 1, group: 'COMPLETENESS' });
    metrics.push({ name: 'Evaluator Success Coverage', value: Number((caseResults.filter((item) => typeof item.answer_correctness === 'number' && typeof item.groundedness === 'number').length / caseResults.length).toFixed(4)), threshold: 1, group: 'COMPLETENESS' });
    metrics.push(...documentQuality.metrics);
    const releaseEligible = dataset.release_eligible === true;
    const thresholdsPassed = metrics.filter((metric) => metric.group !== 'DOCUMENT').every((metric) => metric.value >= metric.threshold);
    const status = evaluatorFailure ? 'FAILED' : blockingError ? 'BLOCKED' : thresholdsPassed && releaseEligible ? 'PASSED' : 'WARNING';
    const error = evaluatorFailure || blockingError;
    const outputs = {
      evaluation_profile: 'wiki-question-answer:v1', evaluation_scope: 'QUESTION_ANSWER',
      dataset_ref: datasetRef, dataset_version: dataset.version || null, dataset_scope: dataset.scope || 'UNSPECIFIED',
      release_eligible: releaseEligible, case_count: caseResults.length, case_summary: caseResults,
      evaluator_versions: Array.from(evaluatorVersions), generator_versions: Array.from(generatorVersions),
      document_quality: documentQuality.outputs,
    };
    return resultWithEvidence('wiki-evaluation', input, status, outputs, {
      producer: 'knowledge-builder-wiki-qa-eval:v1+ontomind', metrics, findings,
      status_note: evaluatorFailure ? 'Wiki 答案裁判不可用，未生成替代答案分数。'
        : blockingError ? '已保留检索证据，但答案生成未完成，不能进入发布门禁。'
          : status === 'PASSED' ? 'Wiki 问题评测达到发布门禁阈值。'
            : !releaseEligible ? 'Wiki 冒烟评测已完成，但该数据集未获准用于发布门禁。' : 'Wiki 问题评测未达到全部门禁阈值。',
      ...(error ? { error } : {}),
    });
  }

  async function executeWikiStage(stageId, input) {
    if (!WIKI_STAGES.has(stageId)) fail('WIKI_STAGE_UNSUPPORTED', '不支持的 Wiki 构建阶段');
    const stageInput = input || {};
    const root = projectPath(stageInput.project);
    const snapshot = summarizeProject(root);
    if (stageId === 'source-snapshot') {
      const outputs = {
        content_digest: snapshot.content_digest,
        page_count: snapshot.page_count,
        total_bytes: snapshot.total_bytes,
        owner_coverage: snapshot.owner_coverage,
        verification_coverage: snapshot.verification_coverage,
        pages: snapshot.pages,
      };
      return resultWithEvidence(stageId, stageInput, snapshot.page_count ? 'PASSED' : 'FAILED', outputs, {
        content_digest: snapshot.content_digest,
        status_note: snapshot.page_count ? '已固定当前 Wiki 页面输入快照。' : 'Wiki 项目没有可构建页面。',
      });
    }
    if (stageId === 'parse-normalize') {
      const status = snapshot.page_count && snapshot.heading_count ? 'PASSED' : 'FAILED';
      return resultWithEvidence(stageId, stageInput, status, {
        page_count: snapshot.page_count, heading_count: snapshot.heading_count, normalized_format: 'MARKDOWN', content_digest: snapshot.content_digest,
      }, { content_digest: snapshot.content_digest, status_note: status === 'PASSED' ? 'Markdown 页面与标题结构可解析。' : '缺少可解析的页面标题结构。' });
    }
    if (stageId === 'outline-pages') {
      const status = snapshot.page_count ? 'PASSED' : 'FAILED';
      return resultWithEvidence(stageId, stageInput, status, {
        page_count: snapshot.page_count, heading_count: snapshot.heading_count, owner_coverage: snapshot.owner_coverage,
      }, { content_digest: snapshot.content_digest, status_note: '已核验页面树、标题和 Owner 元数据。' });
    }
    if (stageId === 'citation-linking') {
      try {
        const analysis = graphBuilder.analyze(root);
        const graph = Object.assign({}, analysis.graph, {
          communities: analysis.communities && analysis.communities.communities || [],
          modularity: analysis.communities && analysis.communities.modularity || 0,
          insights: analysis.insights || [],
        });
        fs.writeFileSync(path.join(root, '.graph.json'), JSON.stringify(graph, null, 2), 'utf8');
        const graphNodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
        const graphEdgeCount = Array.isArray(graph.edges) ? graph.edges.length : 0;
        const graphPageCoverage = snapshot.page_count ? Number((Math.min(graphNodeCount, snapshot.page_count) / snapshot.page_count).toFixed(4)) : 0;
        const orphanCount = graph.stats && Number.isFinite(Number(graph.stats.orphanNodes)) ? Number(graph.stats.orphanNodes) : 0;
        const orphanRatio = graphNodeCount ? Number((orphanCount / graphNodeCount).toFixed(4)) : 0;
        const unresolvedLinks = Array.isArray(graph.unresolved_links) ? graph.unresolved_links : [];
        const coveragePassed = graphPageCoverage >= 0.95;
        const outputs = {
          wiki_link_count: snapshot.wiki_link_count,
          citation_count: snapshot.citation_count,
          graph_node_count: graphNodeCount,
          graph_edge_count: graphEdgeCount,
          graph_page_coverage: graphPageCoverage,
          graph_orphan_count: orphanCount,
          graph_orphan_ratio: orphanRatio,
          unresolved_link_count: unresolvedLinks.length,
        };
        const findings = unresolvedLinks.slice(0, 20).map((link) => ({
          category: 'UNRESOLVED_WIKI_LINK', severity: link.reason === 'AMBIGUOUS' ? 'MEDIUM' : 'LOW', blocking: false,
          title: link.reason === 'AMBIGUOUS' ? 'Wiki 链接存在多个候选页面' : 'Wiki 链接未找到候选页面',
          detail: `${link.source} -> ${link.target}`,
        }));
        return resultWithEvidence(stageId, stageInput, coveragePassed ? 'PASSED' : 'FAILED', outputs, {
          findings,
          metrics: [
            { name: 'Graph Page Coverage', value: graphPageCoverage, threshold: 0.95, group: 'GRAPH_COMPLETENESS' },
            { name: 'Graph Orphan Ratio', value: orphanRatio, threshold: 0.3, comparison: 'LTE', group: 'GRAPH_QUALITY' },
          ],
          content_digest: snapshot.content_digest,
          status_note: coveragePassed
            ? `已重建覆盖 ${(graphPageCoverage * 100).toFixed(1)}% Wiki 页面的引用关系图。`
            : `图谱仅覆盖 ${(graphPageCoverage * 100).toFixed(1)}% Wiki 页面，低于 95% 完整性门槛。`,
          ...(coveragePassed ? {} : { error: { code: 'WIKI_GRAPH_COVERAGE_INCOMPLETE', message: '派生图谱未覆盖足够的 Wiki 页面，候选版本已停止固化' } }),
        });
      } catch (error) {
        return resultWithEvidence(stageId, stageInput, 'FAILED', {}, { error: { code: 'WIKI_GRAPH_BUILD_FAILED', message: error.message }, status_note: '引用关系图构建失败。' });
      }
    }
    if (stageId === 'wiki-lint') {
      try {
        const issues = wikiMaintainer.lintWiki(root, { checkOrphans: true, checkContradictions: true, checkMissingRefs: true });
        const health = Number(issues && issues.summary && issues.summary.healthScore || 0);
        const status = health >= 80 ? 'PASSED' : health >= 60 ? 'WARNING' : 'FAILED';
        const findings = [];
        const groups = [
          ['ORPHAN_PAGE', 'MEDIUM', false, issues.orphans],
          ['MISSING_REFERENCE', 'HIGH', true, issues.missingReferences || issues.missingRefs],
          ['CONTENT_CONFLICT', 'HIGH', true, issues.contradictions],
          ['STALE_CONTENT', 'MEDIUM', false, issues.stalePages],
        ];
        groups.forEach(([category, severity, blocking, items]) => {
          (Array.isArray(items) ? items : []).slice(0, 20).forEach((item) => findings.push({
            category, severity, blocking, title: category === 'MISSING_REFERENCE' ? '页面存在缺失引用' : category === 'CONTENT_CONFLICT' ? '页面存在内容冲突' : category === 'STALE_CONTENT' ? '页面可能已过期' : '页面未被其他知识引用',
            detail: typeof item === 'string' ? item : JSON.stringify(item),
          }));
        });
        return resultWithEvidence(stageId, stageInput, status, { health_score: health, summary: issues.summary || {}, issue_count: findings.length }, {
          findings, content_digest: snapshot.content_digest, status_note: 'Wiki Lint 健康度 ' + health.toFixed(1) + '%。',
        });
      } catch (error) {
        return resultWithEvidence(stageId, stageInput, 'FAILED', {}, { error: { code: 'WIKI_LINT_FAILED', message: error.message }, status_note: 'Wiki 规范检查执行失败。' });
      }
    }
    if (stageId === 'content-security') {
      const findings = scanSecurity(root);
      const blocking = findings.filter((finding) => finding.blocking);
      const status = blocking.length ? 'FAILED' : findings.length ? 'WARNING' : 'PASSED';
      return resultWithEvidence(stageId, stageInput, status, {
        scanned_pages: snapshot.page_count, finding_count: findings.length, blocking_count: blocking.length, scanner_version: 'wiki-content-security:v1',
      }, { findings, content_digest: snapshot.content_digest, status_note: findings.length ? '扫描发现 ' + findings.length + ' 个安全问题。' : '未发现当前规则集覆盖的内容安全问题。' });
    }
    if (stageId === 'wiki-evaluation') return evaluateWiki(stageInput, root);
    if (stageId === 'observe') {
      return resultWithEvidence(stageId, stageInput, 'PASSED', {
        monitored_project: stageInput.project, page_count: snapshot.page_count, content_digest: snapshot.content_digest,
      }, { content_digest: snapshot.content_digest, status_note: '已建立项目级版本与内容漂移观测基线。' });
    }
    fail('WIKI_STAGE_UNSUPPORTED', '不支持的 Wiki 构建阶段');
  }

  function getRagEngine(project) {
    if (!ragEngines.has(project)) ragEngines.set(project, ragEngineFactory(project));
    return ragEngines.get(project);
  }

  function sanitizedCacheVerification(result, certification) {
    if (!result || result.valid !== true) {
      return { valid: false, code: result && result.code || 'CACHE_PAYLOAD_INVALID', cache_file: '.rag-cache.json' };
    }
    const exactCertification = {
      source_digest: certification && certification.source_digest,
      configuration_digest: certification && certification.configuration_digest,
      index_digest: certification && certification.index_digest,
    };
    if (JSON.stringify(result.certification || null) !== JSON.stringify(exactCertification)) {
      return { valid: false, code: 'CACHE_CERTIFICATION_MISMATCH', cache_file: '.rag-cache.json' };
    }
    const stats = result.stats || {};
    const safeStats = ['documents', 'chunks', 'embedded', 'dim'].reduce((safe, key) => {
      safe[key] = Number.isSafeInteger(stats[key]) && stats[key] >= 0 ? stats[key] : 0;
      return safe;
    }, {});
    return { valid: true, cache_file: '.rag-cache.json', certification: exactCertification, stats: safeStats };
  }

  async function verifyVectorCache(project, certification, phase, snapshotRoot) {
    let result;
    if (injectedRagCacheVerifier) {
      result = await injectedRagCacheVerifier({
        project, certification, phase,
        project_root: snapshotRoot || projectPath(project),
      });
    } else if (snapshotRoot) {
      const active = getRagEngine(project);
      result = new RAGEngine({ wikiDir: snapshotRoot, embeddingConfig: active.embeddingConfig || null })
        .verifyCache(null, certification);
    } else {
      const active = getRagEngine(project);
      result = typeof active.verifyCache === 'function'
        ? active.verifyCache(project, certification)
        : { valid: false, code: 'CACHE_VERIFIER_UNAVAILABLE' };
    }
    return sanitizedCacheVerification(result, certification);
  }

  function runtimeCacheCode(verification, snapshot) {
    if (snapshot) return 'RAG_INDEX_SNAPSHOT_CACHE_INVALID';
    if (verification.code === 'CACHE_NOT_FOUND') return 'RAG_INDEX_CACHE_NOT_FOUND';
    if (verification.code === 'CACHE_CERTIFICATION_MISMATCH') return 'RAG_INDEX_CACHE_CERTIFICATION_MISMATCH';
    return 'RAG_INDEX_CACHE_INVALID';
  }

  async function ensureRagIndex(project, input) {
    const rag = getRagEngine(project);
    if (!rag.chunks || !rag.chunks.length) {
      await rag.buildIndex(project, {
        chunkSize: Number(input.chunk_size || 800),
        overlap: Number(input.overlap || 120),
        strategy: input.chunk_strategy || 'markdown',
        forceRebuild: false,
      });
    }
    return rag;
  }

  function average(values) {
    const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
    return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : 0;
  }

  function computeRetrievalMetrics(results, relevantDocIds, topK) {
    const relevant = new Set((relevantDocIds || []).map((value) => String(value)));
    if (!relevant.size) return { recall_at_k: 1, mrr: 1, context_precision: 1 };
    const ranked = (results || []).slice(0, topK).map((item) => String(item.docId || item.id || ''));
    const uniqueRetrieved = new Set(ranked);
    const matchedRelevant = Array.from(relevant).filter((docId) => uniqueRetrieved.has(docId)).length;
    const firstRelevantRank = ranked.findIndex((docId) => relevant.has(docId));
    return {
      recall_at_k: matchedRelevant / relevant.size,
      mrr: firstRelevantRank < 0 ? 0 : 1 / (firstRelevantRank + 1),
      context_precision: ranked.length ? ranked.filter((docId) => relevant.has(docId)).length / ranked.length : 0,
    };
  }

  function exactRagDatasetIdentity(datasetRef, dataset) {
    const canonicalRef = canonicalGenerationDatasetRef(datasetRef);
    if (!canonicalRef || !dataset || typeof dataset !== 'object' || Array.isArray(dataset)) return null;
    const datasetId = canonicalGenerationDatasetRef(dataset.dataset_id);
    const version = typeof dataset.version === 'string' ? dataset.version.trim() : '';
    const reference = typeof dataset.reference === 'string' ? dataset.reference.trim() : '';
    const contentDigest = typeof dataset.content_digest === 'string' ? dataset.content_digest.trim() : '';
    if (!datasetId || !/^v[1-9]\d*$/.test(version) || reference !== canonicalRef
      || datasetId + '-' + version !== canonicalRef || !/^sha256:[a-f0-9]{64}$/i.test(contentDigest)
      || dataset.artifact_type !== 'VECTOR_KB' || contentDigest !== datasetContentDigest(dataset)) return null;
    return {
      dataset_ref: reference, dataset_id: datasetId, dataset_version: version,
      dataset_digest: contentDigest,
      dataset_scope: dataset.scope === undefined ? 'UNSPECIFIED' : dataset.scope,
      release_eligible: dataset.release_eligible === true,
    };
  }

  function ragIndexIdentity(rag) {
    const stats = rag && (typeof rag.getStatus === 'function' ? rag.getStatus() : rag.stats) || {};
    return {
      source_digest: stats.source_digest || null,
      configuration_digest: stats.configuration_digest || null,
      index_digest: stats.index_digest || null,
    };
  }

  async function evaluateRetrieval(input, project) {
    const datasetRef = String(input.dataset_ref || '').trim();
    if (!datasetRef) {
      return resultWithEvidence('retrieval-evaluation', input, 'BLOCKED', { evaluation_scope: 'UNAVAILABLE' }, {
        producer: 'knowledge-builder-rag-eval:v1',
        status_note: '缺少版本化检索评测集，未生成任何替代分数。',
        error: { code: 'RAG_EVAL_DATASET_REQUIRED', message: '请绑定包含 query 与 relevant_doc_ids 的版本化评测集' },
      });
    }
    const loadedDataset = loadExactVectorDataset(datasetRef, 100);
    const dataset = loadedDataset.dataset;
    const datasetIdentity = loadedDataset.identity;
    if (loadedDataset.error === 'NOT_FOUND') {
      return resultWithEvidence('retrieval-evaluation', input, 'BLOCKED', { evaluation_scope: 'UNAVAILABLE', dataset_ref: datasetRef }, {
        producer: 'knowledge-builder-rag-eval:v1',
        status_note: '绑定的检索评测集不存在。',
        error: { code: 'RAG_EVAL_DATASET_NOT_FOUND', message: '检索评测集不存在' },
      });
    }
    if (loadedDataset.error) {
      return resultWithEvidence('retrieval-evaluation', input, 'BLOCKED', {
        evaluation_scope: 'UNAVAILABLE', dataset_ref: datasetRef,
      }, {
        producer: 'knowledge-builder-rag-eval:v1', metrics: [],
        status_note: 'The exact retrieval dataset identity is invalid; no substitute scores were produced.',
        error: { code: 'RAG_EVAL_DATASET_INVALID', message: 'Retrieval dataset identity is invalid' },
      });
    }
    if (!Array.isArray(dataset.cases) || !dataset.cases.length) fail('RAG_EVAL_DATASET_INVALID', '检索评测集必须包含非空 cases');
    const rag = await ensureRagIndex(project, input);
    const caseResults = [];
    const contractFindings = [];
    for (const testCase of dataset.cases.slice(0, 100)) {
      if (!testCase || typeof testCase.query !== 'string' || !Array.isArray(testCase.relevant_doc_ids)) {
        fail('RAG_EVAL_DATASET_INVALID', '每个检索用例必须包含 query 与 relevant_doc_ids');
      }
      const results = await rag.search(testCase.query, { topK: Number(input.top_k || 5), mode: input.search_mode || 'hybrid', rerank: input.rerank === true });
      const response = await fetchImpl(evaluatorUrl + '/api/v1/evaluation/rag', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          query: testCase.query,
          answer: '',
          retrieved_contexts: results.map((item, index) => ({
            doc_id: item.docId || item.id,
            content: item._fullText || item.snippet || '',
            score: Number(item.score || 0),
            rank: index + 1,
          })),
          relevant_doc_ids: testCase.relevant_doc_ids,
          eval_mode: 'retrieval_only',
        }),
      });
      if (!response || !response.ok) fail('RAG_EVALUATOR_UNAVAILABLE', 'RAG 评测服务返回 HTTP ' + (response && response.status || 'unknown'), 502);
      const evaluated = await response.json();
      const authoritative = computeRetrievalMetrics(results, testCase.relevant_doc_ids, Number(input.top_k || 5));
      const evaluatorMetrics = ['recall_at_k', 'mrr', 'context_precision'].reduce((summary, key) => {
        summary[key] = Number(evaluated[key]);
        return summary;
      }, {});
      const invalidMetric = Object.entries(evaluatorMetrics).find(([, value]) => !Number.isFinite(value) || value < 0 || value > 1);
      if (invalidMetric) {
        contractFindings.push({
          code: 'RAG_EVALUATOR_METRIC_OUT_OF_RANGE', severity: 'WARNING', case_id: testCase.case_id || testCase.id || null,
          message: 'Evaluator returned ' + invalidMetric[0] + '=' + invalidMetric[1] + '; the runtime used deterministic bounded metrics.',
        });
      }
      caseResults.push({
        case_id: testCase.case_id || testCase.id || 'case-' + (caseResults.length + 1),
        query: testCase.query,
        relevant_doc_ids: testCase.relevant_doc_ids.slice(),
        recall_at_k: Number(authoritative.recall_at_k.toFixed(4)),
        mrr: Number(authoritative.mrr.toFixed(4)),
        context_precision: Number(authoritative.context_precision.toFixed(4)),
        retrieved_count: results.length,
        passed: authoritative.recall_at_k >= 0.8 && authoritative.mrr >= 0.7 && authoritative.context_precision >= 0.6,
      });
    }
    const metrics = [
      { name: 'Recall@5', value: Number(average(caseResults.map((item) => item.recall_at_k)).toFixed(4)), threshold: 0.8 },
      { name: 'MRR', value: Number(average(caseResults.map((item) => item.mrr)).toFixed(4)), threshold: 0.7 },
      { name: 'Context Precision', value: Number(average(caseResults.map((item) => item.context_precision)).toFixed(4)), threshold: 0.6 },
    ];
    const thresholdsPassed = metrics.every((metric) => metric.value >= metric.threshold);
    const releaseEligible = dataset.release_eligible === true;
    const status = thresholdsPassed && releaseEligible ? 'PASSED' : 'WARNING';
    return resultWithEvidence('retrieval-evaluation', input, status, Object.assign({
      evaluator_version: 'rag-eval-v1', evaluation_profile: 'rag-retrieval:v1', dataset_ref: datasetRef,
      dataset_version: dataset.version || null, dataset_scope: dataset.scope || 'UNSPECIFIED', release_eligible: releaseEligible,
      case_count: caseResults.length, case_summary: caseResults,
    }, datasetIdentity, ragIndexIdentity(rag)), { producer: 'knowledge-builder-rag-eval:v2+ontomind', metrics, findings: contractFindings, status_note: status === 'PASSED' ? '检索评测达到门禁阈值。'
      : !releaseEligible ? 'Smoke/冒烟评测已完成，但该数据集未获准用于发布门禁。' : '检索评测未达到全部门禁阈值。' });
  }

  function generationStageOutputs(datasetRef, dataset, caseResults, rag) {
    return Object.assign({
      evaluation_profile: 'rag-generation:v1',
      release_profile: 'RAG_SERVICE',
      dataset_ref: datasetRef,
      dataset_version: dataset.version === undefined ? null : dataset.version,
      dataset_scope: dataset.scope === undefined ? 'UNSPECIFIED' : dataset.scope,
      release_eligible: dataset.release_eligible === true,
      case_count: caseResults.length,
      case_summary: caseResults,
      generator_versions: Array.from(new Set(caseResults.map((item) => item.generator_version).filter(Boolean))),
      evaluator_versions: Array.from(new Set(caseResults.map((item) => item.evaluator_version).filter(Boolean))),
    }, exactRagDatasetIdentity(datasetRef, dataset) || {}, ragIndexIdentity(rag));
  }

  function generationDatasetResult(input, code, message, datasetRef) {
    const outputs = {
      evaluation_profile: 'rag-generation:v1', evaluation_scope: 'UNAVAILABLE', release_profile: 'RAG_SERVICE',
    };
    if (datasetRef) outputs.dataset_ref = datasetRef;
    return resultWithEvidence('generation-evaluation', input, 'BLOCKED', outputs, {
      producer: 'knowledge-builder-rag-generation-eval:v1', metrics: [],
      status_note: 'The exact answer evaluation dataset is unavailable or invalid; no substitute scores were produced.',
      error: { code, message },
    });
  }

  function canonicalGenerationDatasetRef(value) {
    const text = String(value || '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,119}$/i.test(text) || text === '.' || text === '..') return null;
    return text;
  }

  function canonicalDatasetEntity(value) {
    if (Array.isArray(value)) return value.map(canonicalDatasetEntity);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((result, key) => {
        if (key !== 'content_digest') result[key] = canonicalDatasetEntity(value[key]);
        return result;
      }, {});
    }
    return value;
  }

  function datasetContentDigest(dataset) {
    return 'sha256:' + crypto.createHash('sha256')
      .update(JSON.stringify(canonicalDatasetEntity(dataset))).digest('hex');
  }

  function loadExactVectorDataset(datasetRef, maximumCases) {
    const canonicalRef = canonicalGenerationDatasetRef(datasetRef);
    if (!canonicalRef) return { error: 'INVALID' };
    const datasetPath = resolveInside(evalDatasetsRoot, canonicalRef + '.json', 'RAG_DATASET_PATH_INVALID');
    if (!fs.existsSync(datasetPath)) return { error: 'NOT_FOUND' };
    let dataset;
    try { dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8')); }
    catch (_) { return { error: 'INVALID' }; }
    const maximum = Number(maximumCases || 100);
    if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)
      || !Array.isArray(dataset.cases) || dataset.cases.length < 1 || dataset.cases.length > maximum) {
      return { error: 'INVALID' };
    }
    const identity = exactRagDatasetIdentity(canonicalRef, dataset);
    return identity ? { dataset, identity } : { error: 'INVALID' };
  }

  function loadGenerationDataset(datasetRef) {
    const loaded = loadExactVectorDataset(datasetRef, 50);
    if (loaded.error === 'NOT_FOUND') return { error: 'RAG_GENERATION_DATASET_NOT_FOUND' };
    if (loaded.error) return { error: 'RAG_GENERATION_DATASET_INVALID' };
    const dataset = loaded.dataset;
    for (const testCase of dataset.cases) {
      if (!testCase || typeof testCase !== 'object' || Array.isArray(testCase)
        || typeof testCase.query !== 'string' || !testCase.query.trim() || testCase.query.length > 8000
        || !Array.isArray(testCase.relevant_doc_ids)
        || (!testCase.relevant_doc_ids.length && testCase.should_refuse !== true)
        || testCase.relevant_doc_ids.length > 100
        || testCase.relevant_doc_ids.some((item) => typeof item !== 'string' || !item.trim() || item.length > 1000)) {
        return { error: 'RAG_GENERATION_DATASET_INVALID' };
      }
      const hasExpectedAnswer = Object.prototype.hasOwnProperty.call(testCase, 'expected_answer');
      const hasGoldFacts = Object.prototype.hasOwnProperty.call(testCase, 'gold_facts');
      if (hasExpectedAnswer && (typeof testCase.expected_answer !== 'string'
        || !testCase.expected_answer.trim() || testCase.expected_answer.length > 20000)) {
        return { error: 'RAG_GENERATION_DATASET_INVALID' };
      }
      if (hasGoldFacts && (!Array.isArray(testCase.gold_facts) || !testCase.gold_facts.length || testCase.gold_facts.length > 50
        || testCase.gold_facts.some((item) => typeof item !== 'string' || !item.trim() || item.length > 4000))) {
        return { error: 'RAG_GENERATION_DATASET_INVALID' };
      }
      if (!hasExpectedAnswer && !hasGoldFacts) return { error: 'RAG_GENERATION_DATASET_INVALID' };
      if (testCase.should_refuse !== undefined && typeof testCase.should_refuse !== 'boolean') {
        return { error: 'RAG_GENERATION_DATASET_INVALID' };
      }
    }
    return { dataset };
  }

  function boundedGenerationContexts(sources) {
    const contexts = [];
    let remaining = 12000;
    for (const source of (Array.isArray(sources) ? sources : []).slice(0, 5)) {
      if (!source || typeof source !== 'object' || remaining <= 0) continue;
      const raw = [source.content, source._fullText, source.text, source.snippet]
        .find((value) => typeof value === 'string' && value.trim());
      if (!raw) continue;
      const content = raw.trim().slice(0, remaining);
      if (!content) continue;
      const docId = source.doc_id !== undefined ? source.doc_id : (source.docId !== undefined ? source.docId : source.id);
      const score = Number(source.score);
      const rank = Number(source.rank);
      contexts.push({
        doc_id: docId === undefined || docId === null ? '' : String(docId).slice(0, 1000), content,
        score: Number.isFinite(score) ? score : 0,
        rank: Number.isInteger(rank) && rank > 0 ? rank : contexts.length + 1,
      });
      remaining -= content.length;
    }
    return contexts;
  }

  async function judgeGeneratedAnswer(testCase, generation) {
    if (typeof fetchImpl !== 'function') {
      return { error: { code: 'RAG_GENERATION_EVALUATOR_JUDGE_UNAVAILABLE', message: 'RAG answer evaluator is unavailable' } };
    }
    try {
      const goldAnswer = typeof testCase.expected_answer === 'string'
        ? testCase.expected_answer
        : (Array.isArray(testCase.gold_facts) ? testCase.gold_facts.join('\n').slice(0, 20000) : '');
      const body = {
        query: testCase.query,
        answer: generation.answer,
        retrieved_contexts: boundedGenerationContexts(generation.sources),
        relevant_doc_ids: testCase.relevant_doc_ids.slice(0, 100),
        gold_answer: goldAnswer,
        eval_mode: 'full',
        ...(typeof testCase.should_refuse === 'boolean' ? { should_refuse: testCase.should_refuse } : {}),
      };
      const response = await fetchImpl(evaluatorUrl + '/api/v1/evaluation/rag', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response || !response.ok) {
        return { error: { code: 'RAG_GENERATION_EVALUATOR_JUDGE_UNAVAILABLE', message: 'RAG answer evaluator is unavailable' } };
      }
      const evaluated = await response.json();
      const source = evaluated && typeof evaluated === 'object' && !Array.isArray(evaluated) ? evaluated : {};
      const judge = {
        answer_correctness: source.answer_correctness,
        answer_relevancy: source.answer_relevancy,
        groundedness: source.groundedness !== undefined ? source.groundedness : source.faithfulness,
      };
      if (Object.prototype.hasOwnProperty.call(source, 'refusal_accuracy')) judge.refusal_accuracy = source.refusal_accuracy;
      else if (typeof source.is_refusal_correct === 'boolean') judge.refusal_accuracy = source.is_refusal_correct ? 1 : 0;
      const version = source.evaluator_version || source.evaluatorVersion || source.version;
      if (typeof version === 'string' && version.trim()) judge.evaluator_version = version.trim().slice(0, 200);
      return judge;
    } catch (_) {
      return { error: { code: 'RAG_GENERATION_EVALUATOR_JUDGE_UNAVAILABLE', message: 'RAG answer evaluator is unavailable' } };
    }
  }

  function sanitizedGeneration(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const candidateMode = String(source.generation_mode || source.mode || 'FAILED');
    const mode = ['GENERATED', 'RETRIEVAL_ONLY', 'NO_RESULT', 'FAILED'].includes(candidateMode) ? candidateMode : 'FAILED';
    const answer = typeof source.answer === 'string' && source.answer.trim() && source.answer.length <= 20000
      ? source.answer.trim() : null;
    let error = null;
    if (mode === 'RETRIEVAL_ONLY') error = { code: 'RAG_GENERATOR_CONFIG_REQUIRED', message: 'RAG answer generator is not configured' };
    else if (mode === 'NO_RESULT') error = { code: 'RAG_GENERATION_NO_RESULT', message: 'RAG retrieval returned no usable result' };
    else if (mode === 'FAILED' || !answer) error = { code: 'RAG_GENERATION_FAILED', message: 'RAG answer generation failed' };
    const version = source.generator_version || source.model;
    return {
      generation_mode: mode,
      answer,
      sources: Array.isArray(source.sources) ? source.sources.slice(0, 5) : [],
      generator_version: typeof version === 'string' && version.trim() ? version.trim().slice(0, 200) : null,
      ...(typeof source.refused === 'boolean' ? { refused: source.refused } : {}),
      ...(error ? { error } : {}),
    };
  }

  function generationMetrics(caseResults, hasRefusalCases) {
    const metrics = [
      ['Answer Correctness', 'answer_correctness', 0.80, 'ANSWER'],
      ['Answer Relevancy', 'answer_relevancy', 0.80, 'ANSWER'],
      ['Groundedness', 'groundedness', 0.85, 'ANSWER'],
      ['Citation Coverage', 'citation_coverage', 0.90, 'ANSWER'],
    ].map(([name, key, threshold, group]) => ({ name, value: meanMetric(caseResults, key), threshold, group }));
    metrics.push({
      name: 'Generated Answer Coverage',
      value: caseResults.length ? Number((caseResults.filter((item) => item.generation_mode === 'GENERATED'
        && typeof item.answer === 'string' && item.answer.trim() && item.answer.length <= 20000).length / caseResults.length).toFixed(4)) : 0,
      threshold: 1, group: 'COMPLETENESS',
    });
    metrics.push({
      name: 'Evaluator Success Coverage',
      value: caseResults.length ? Number((caseResults.filter((item) => typeof item.answer_correctness === 'number'
        && typeof item.answer_relevancy === 'number' && typeof item.groundedness === 'number').length / caseResults.length).toFixed(4)) : 0,
      threshold: 1, group: 'COMPLETENESS',
    });
    if (hasRefusalCases) metrics.push({
      name: 'Refusal Accuracy', value: meanMetric(caseResults.filter((item) => item.should_refuse !== null), 'refusal_accuracy'),
      threshold: 0.95, group: 'REFUSAL',
    });
    return metrics;
  }

  async function evaluateGeneration(input, project) {
    const datasetRef = String(input.dataset_ref || '').trim();
    if (!datasetRef) {
      return generationDatasetResult(input, 'RAG_GENERATION_DATASET_REQUIRED', 'A versioned RAG answer dataset is required');
    }
    const loaded = loadGenerationDataset(datasetRef);
    if (loaded.error) {
      const code = loaded.error === 'RAG_GENERATION_DATASET_NOT_FOUND'
        ? 'RAG_GENERATION_DATASET_NOT_FOUND' : 'RAG_GENERATION_DATASET_INVALID';
      return generationDatasetResult(input, code, code === 'RAG_GENERATION_DATASET_NOT_FOUND'
        ? 'The exact RAG answer dataset was not found' : 'The exact RAG answer dataset is invalid', datasetRef);
    }
    const dataset = loaded.dataset;
    let rag;
    try { rag = await ensureRagIndex(project, input); }
    catch (_) {
      return resultWithEvidence('generation-evaluation', input, 'FAILED', generationStageOutputs(datasetRef, dataset, [], null), {
        producer: 'knowledge-builder-rag-generation-eval:v1',
        metrics: generationMetrics([], dataset.cases.some((testCase) => typeof testCase.should_refuse === 'boolean')),
        status_note: 'RAG answer generation failed before case execution; no substitute scores were produced.',
        error: { code: 'RAG_GENERATION_FAILED', message: 'RAG answer generation failed' },
      });
    }

    const caseResults = [];
    let failureError = null;
    let blockingError = null;
    for (const testCase of dataset.cases) {
      let rawGeneration;
      try {
        rawGeneration = await ragAnswerService.answer({
          rag, query: testCase.query, model: input.model, top_k: input.top_k,
          search_mode: input.search_mode, rerank: input.rerank === true,
        });
      } catch (_) {
        rawGeneration = { generation_mode: 'FAILED', error: { code: 'RAG_GENERATION_FAILED' } };
      }
      const generation = sanitizedGeneration(rawGeneration);
      let judge = null;
      if (generation.generation_mode === 'GENERATED' && !generation.error) {
        judge = await judgeGeneratedAnswer(testCase, generation);
      }
      const evaluatedCase = ragGenerationEvaluation.evaluateCaseResult({
        case_id: testCase.case_id || testCase.id || 'case-' + (caseResults.length + 1),
        query: testCase.query, expected_answer: testCase.expected_answer,
        gold_facts: Array.isArray(testCase.gold_facts) ? testCase.gold_facts : [],
        relevant_doc_ids: testCase.relevant_doc_ids, should_refuse: testCase.should_refuse,
        generation, judge,
      });
      caseResults.push(evaluatedCase);

      if (generation.generation_mode === 'RETRIEVAL_ONLY') {
        blockingError = blockingError || { code: 'RAG_GENERATOR_CONFIG_REQUIRED', message: 'RAG answer generator is not configured' };
      } else if (generation.generation_mode === 'NO_RESULT') {
        blockingError = blockingError || { code: 'RAG_GENERATION_NO_RESULT', message: 'RAG retrieval returned no usable result' };
      } else if (generation.generation_mode !== 'GENERATED' || generation.error) {
        failureError = failureError || { code: 'RAG_GENERATION_FAILED', message: 'RAG answer generation failed' };
      } else if (evaluatedCase.error) {
        failureError = failureError || (evaluatedCase.error.code === 'RAG_GENERATION_EVALUATOR_JUDGE_CONTRACT_INVALID'
          ? { code: 'RAG_ANSWER_EVALUATOR_CONTRACT_INVALID', message: 'RAG answer evaluator returned an invalid contract' }
          : { code: 'RAG_ANSWER_EVALUATOR_UNAVAILABLE', message: 'RAG answer evaluator is unavailable' });
      }
    }

    const metrics = generationMetrics(caseResults, dataset.cases.some((testCase) => typeof testCase.should_refuse === 'boolean'));
    const thresholdsPassed = metrics.every((metric) => typeof metric.value === 'number' && metric.value >= metric.threshold);
    const casesPassed = caseResults.every((item) => item.passed === true);
    const releaseDataset = dataset.scope === 'RELEASE' && dataset.release_eligible === true;
    const status = failureError ? 'FAILED' : blockingError ? 'BLOCKED' : thresholdsPassed && casesPassed && releaseDataset ? 'PASSED' : 'WARNING';
    const error = failureError || blockingError;
    return resultWithEvidence('generation-evaluation', input, status, generationStageOutputs(datasetRef, dataset, caseResults, rag), {
      producer: 'knowledge-builder-rag-generation-eval:v1+ontomind', metrics,
      status_note: failureError ? 'RAG answer generation or judging failed closed; unavailable scores remain null.'
        : blockingError ? 'RAG answer generation was incomplete; the stage is blocked without substitute scores.'
          : status === 'PASSED' ? 'RAG answer evaluation met every Release threshold.'
            : !releaseDataset ? 'The complete run is not based on a Release-eligible Release dataset.'
              : 'The complete RAG answer run is below at least one hard threshold.',
      ...(error ? { error } : {}),
    });
  }

  async function executeVectorStage(stageId, input) {
    if (!VECTOR_STAGES.has(stageId)) fail('VECTOR_STAGE_UNSUPPORTED', '不支持的向量知识库构建阶段');
    const stageInput = Object.assign({}, input || {}, { artifact_type: 'VECTOR_KB' });
    const root = projectPath(stageInput.project);
    const snapshot = summarizeProject(root);
    if (stageId === 'source-snapshot') {
      return resultWithEvidence(stageId, stageInput, 'PASSED', {
        content_digest: snapshot.content_digest, document_count: snapshot.page_count, total_bytes: snapshot.total_bytes,
        acl_coverage: snapshot.owner_coverage, source_manifest: snapshot.pages,
      }, { producer: 'knowledge-builder-rag-source:v1', content_digest: snapshot.content_digest, status_note: '已固定数据源、ACL 元数据与内容摘要。' });
    }
    if (stageId === 'parse-elements') {
      return resultWithEvidence(stageId, stageInput, snapshot.page_count ? 'PASSED' : 'FAILED', {
        parsed_documents: snapshot.page_count, heading_count: snapshot.heading_count, total_bytes: snapshot.total_bytes,
        parser_version: 'markdown-elements:v1',
      }, { content_digest: snapshot.content_digest, status_note: snapshot.page_count ? 'Markdown 文档已完成元素化统计。' : '没有可解析文档。' });
    }
    if (stageId === 'chunk-index') {
      const rag = getRagEngine(stageInput.project);
      const stats = await rag.buildIndex(stageInput.project, {
        chunkSize: Number(stageInput.chunk_size || 800), overlap: Number(stageInput.overlap || 120),
        strategy: stageInput.chunk_strategy || 'markdown', forceRebuild: stageInput.force_rebuild === true,
      });
      return resultWithEvidence(stageId, stageInput, 'PASSED', Object.assign({
        document_count: Number(stats.documents || 0), chunk_count: Number(stats.chunks || 0), embedded_count: Number(stats.embedded || 0),
        vector_dimension: Number(stats.dim || 0), chunk_size: Number(stats.chunkSize || stageInput.chunk_size || 800),
        overlap: Number(stats.overlap || stageInput.overlap || 120), strategy: stats.strategy || stageInput.chunk_strategy || 'markdown',
        index_cache: '.rag-cache.json',
      }, ragIndexIdentity(rag)), { content_digest: snapshot.content_digest, producer: 'ai-harbor-rag-engine:v1', status_note: 'RAG 索引构建已完成并写入可复用缓存。' });
    }
    if (stageId === 'embedding-rerank') {
      const rag = await ensureRagIndex(stageInput.project, stageInput);
      const stats = typeof rag.getStatus === 'function' ? rag.getStatus() : rag.stats || {};
      const chunks = Number(stats.chunks || rag.chunks && rag.chunks.length || 0);
      const embedded = Number(stats.embedded || rag.vectors && rag.vectors.length || 0);
      const fullyEmbedded = chunks > 0 && embedded === chunks && Number(stats.dim || 0) > 0;
      return resultWithEvidence(stageId, stageInput, fullyEmbedded ? 'PASSED' : 'WARNING', Object.assign({
        chunk_count: chunks, embedded_count: embedded, vector_dimension: Number(stats.dim || 0),
        retrieval_mode: fullyEmbedded ? 'HYBRID_VECTOR_KEYWORD' : 'KEYWORD_ONLY', embedding_configured: Boolean(configuredEmbedding()),
      }, ragIndexIdentity(rag)), { content_digest: snapshot.content_digest, producer: 'ai-harbor-rag-engine:v1', status_note: fullyEmbedded ? 'Embedding 与混合检索配置可用。' : 'Embedding 未完整生成，当前只能使用关键词检索，不能按向量知识库放行。' });
    }
    if (stageId === 'index-lint') {
      const rag = await ensureRagIndex(stageInput.project, stageInput);
      const chunks = rag.chunks || [];
      const vectors = rag.vectors || [];
      const seen = new Set();
      const findings = [];
      chunks.forEach((chunk) => {
        if (!chunk.id || seen.has(chunk.id)) findings.push({ category: 'CHUNK_ID', severity: 'HIGH', blocking: true, title: 'Chunk ID 缺失或重复', detail: chunk.id || '(missing)' });
        if (chunk.id) seen.add(chunk.id);
        if (!String(chunk.text || '').trim()) findings.push({ category: 'EMPTY_CHUNK', severity: 'HIGH', blocking: true, title: '存在空 Chunk', detail: chunk.id || '(missing)' });
      });
      const dimensions = new Set(vectors.filter((item) => item.vector && item.vector.length).map((item) => item.vector.length));
      if (dimensions.size > 1) findings.push({ category: 'VECTOR_DIMENSION', severity: 'CRITICAL', blocking: true, title: 'Embedding 维度不一致', detail: Array.from(dimensions).join(', ') });
      const blocking = findings.filter((finding) => finding.blocking);
      return resultWithEvidence(stageId, stageInput, blocking.length || !chunks.length ? 'FAILED' : 'PASSED', Object.assign({
        chunk_count: chunks.length, vector_count: vectors.length, dimension_count: dimensions.size, finding_count: findings.length,
        validator_version: 'rag-index-lint:v1',
      }, ragIndexIdentity(rag)), { findings, content_digest: snapshot.content_digest, status_note: blocking.length || !chunks.length ? '索引规范检查未通过。' : '索引结构与 Chunk 基础规范检查通过。' });
    }
    if (stageId === 'content-security') {
      const findings = scanSecurity(root);
      const blocking = findings.filter((finding) => finding.blocking);
      return resultWithEvidence(stageId, stageInput, blocking.length ? 'FAILED' : findings.length ? 'WARNING' : 'PASSED', {
        scanned_documents: snapshot.page_count, finding_count: findings.length, blocking_count: blocking.length,
        scanner_version: 'rag-content-security:v1',
      }, { findings, content_digest: snapshot.content_digest, status_note: findings.length ? '内容安全扫描发现问题。' : '内容安全扫描通过。' });
    }
    if (stageId === 'retrieval-evaluation') return evaluateRetrieval(stageInput, stageInput.project);
    if (stageId === 'generation-evaluation') {
      const releaseProfile = normalizeVectorReleaseProfile(stageInput.release_profile);
      const generationInput = Object.assign({}, stageInput, { release_profile: releaseProfile });
      if (releaseProfile === 'VECTOR_INDEX') {
        return resultWithEvidence(stageId, generationInput, 'SKIPPED', {
          evaluation_profile: 'rag-generation:v1', release_profile: 'VECTOR_INDEX',
        }, {
          producer: 'knowledge-builder-rag-generation-eval:v1', metrics: [],
          status_note: 'Generation evaluation is not required for the VECTOR_INDEX release profile.',
        });
      }
      return evaluateGeneration(generationInput, generationInput.project);
    }
    if (stageId === 'observe') {
      const rag = await ensureRagIndex(stageInput.project, stageInput);
      const stats = typeof rag.getStatus === 'function' ? rag.getStatus() : rag.stats || {};
      return resultWithEvidence(stageId, stageInput, 'PASSED', Object.assign({
        monitored_project: stageInput.project, content_digest: snapshot.content_digest,
        chunk_count: Number(stats.chunks || 0), embedded_count: Number(stats.embedded || 0),
      }, ragIndexIdentity(rag)), { content_digest: snapshot.content_digest, status_note: '已建立内容摘要、Chunk 与 Embedding 数量观测基线。' });
    }
    fail('VECTOR_STAGE_UNSUPPORTED', '不支持的向量知识库构建阶段');
  }

  function graphPrimaryKey(definition) {
    const fields = Array.isArray(definition && definition.fields) ? definition.fields : [];
    const semantic = fields.find((field) => field && field.semantics && field.semantics.primary_label === true);
    return semantic && semantic.key || (fields.find((field) => field && (field.key === 'name' || field.key === 'title')) || fields[0] || {}).key || null;
  }

  function graphStructure(asset) {
    const nodes = Array.isArray(asset.graph.nodes) ? asset.graph.nodes : [];
    const edges = Array.isArray(asset.graph.edges) ? asset.graph.edges : [];
    const connected = new Set();
    edges.forEach((edge) => { connected.add(edge.source); connected.add(edge.target); });
    const definitions = new Map((asset.template.node_types || []).map((item) => [item.type, item]));
    const identities = new Map();
    const duplicates = [];
    nodes.forEach((node) => {
      const key = graphPrimaryKey(definitions.get(node.type));
      const value = key && node.properties && node.properties[key];
      if (value === undefined || value === null || value === '') return;
      const identity = node.type + '\0' + String(value).trim().toLowerCase();
      if (identities.has(identity)) duplicates.push({ node_id: node.id, duplicate_of: identities.get(identity), type: node.type, value });
      else identities.set(identity, node.id);
    });
    return {
      nodes, edges, connected_count: nodes.filter((node) => connected.has(node.id)).length,
      isolated_count: nodes.filter((node) => !connected.has(node.id)).length, duplicates,
    };
  }

  function evaluateGraphCases(asset, dataset) {
    const nodes = Array.isArray(asset.graph.nodes) ? asset.graph.nodes : [];
    const edges = Array.isArray(asset.graph.edges) ? asset.graph.edges : [];
    return dataset.cases.map((testCase, index) => {
      let passed = false;
      if (testCase.assertion === 'NODE_EXISTS') {
        passed = nodes.some((node) => node.type === testCase.node_type
          && (!testCase.property || node.properties && String(node.properties[testCase.property]) === String(testCase.value)));
      } else if (testCase.assertion === 'EDGE_EXISTS') {
        passed = edges.some((edge) => edge.type === testCase.edge_type
          && (!testCase.source || edge.source === testCase.source) && (!testCase.target || edge.target === testCase.target));
      } else fail('GRAPH_EVAL_DATASET_INVALID', '不支持的图谱评测断言');
      return { case_id: testCase.case_id || 'graph-case-' + (index + 1), assertion: testCase.assertion, passed };
    });
  }

  async function executeGraphStage(stageId, input) {
    if (!GRAPH_STAGES.has(stageId)) fail('GRAPH_STAGE_UNSUPPORTED', '不支持的知识图谱构建阶段');
    const stageInput = Object.assign({}, input || {}, { artifact_type: 'KNOWLEDGE_GRAPH' });
    const asset = graphAsset(stageInput);
    const structure = graphStructure(asset);
    if (stageId === 'source-snapshot') {
      return resultWithEvidence(stageId, stageInput, 'PASSED', {
        content_digest: asset.content_digest, template_ref: asset.template.template_id + '@' + asset.template.template_version,
        graph_ref: path.relative(asset.projectRoot, asset.graphPath).split(path.sep).join('/'),
        node_count: structure.nodes.length, edge_count: structure.edges.length,
      }, { producer: 'knowledge-builder-graph-source:v1', content_digest: asset.content_digest, status_note: '已固定图文档、本体模板和内容摘要。' });
    }
    if (stageId === 'ontology-schema') {
      const report = validateTemplate(asset.template);
      return resultWithEvidence(stageId, stageInput, report.valid ? 'PASSED' : 'FAILED', {
        template_id: asset.template.template_id, template_version: asset.template.template_version,
        node_type_count: (asset.template.node_types || []).length, edge_type_count: (asset.template.edge_types || []).length,
        error_count: report.errors.length, warning_count: report.warnings.length,
      }, { producer: 'x6-graph-template-validator:v1', findings: report.errors.concat(report.warnings), content_digest: asset.content_digest,
        status_note: report.valid ? '本体与 Schema 模板校验通过。' : '本体与 Schema 模板存在阻断问题。' });
    }
    if (stageId === 'entity-relation') {
      return resultWithEvidence(stageId, stageInput, structure.nodes.length ? 'PASSED' : 'FAILED', {
        node_count: structure.nodes.length, edge_count: structure.edges.length,
        node_types: Array.from(new Set(structure.nodes.map((node) => node.type))).sort(),
        edge_types: Array.from(new Set(structure.edges.map((edge) => edge.type))).sort(),
        build_task_id: asset.graph.build_task_id || null,
      }, { producer: 'x6-graph-document:v1', content_digest: asset.content_digest,
        status_note: structure.nodes.length ? '已载入实体、关系和构建任务来源。' : '图文档不包含实体。' });
    }
    if (stageId === 'entity-resolution') {
      const findings = structure.duplicates.map((item) => ({ code: 'DUPLICATE_PRIMARY_LABEL', severity: 'WARNING', blocking: false,
        message: item.node_id + ' 与 ' + item.duplicate_of + ' 的主标签重复：' + item.value }));
      return resultWithEvidence(stageId, stageInput, findings.length ? 'WARNING' : 'PASSED', {
        entity_count: structure.nodes.length, duplicate_candidate_count: findings.length, isolated_count: structure.isolated_count,
        resolution_strategy: 'TYPE_AND_PRIMARY_LABEL_EXACT:v1',
      }, { producer: 'knowledge-builder-entity-resolution:v1', findings, content_digest: asset.content_digest,
        status_note: findings.length ? '实体对齐发现待人工确认的重复候选。' : '实体主标签精确对齐未发现重复候选。' });
    }
    if (stageId === 'shacl-check') {
      const report = validateGraph(asset.template, asset.graph);
      return resultWithEvidence(stageId, stageInput, report.valid ? 'PASSED' : 'FAILED', {
        conforms: report.valid, error_count: report.errors.length, warning_count: report.warnings.length,
        validator_profile: 'X6_SCHEMA_CONSTRAINTS:v1',
      }, { producer: 'x6-graph-template-validator:v1', findings: report.errors.concat(report.warnings), content_digest: asset.content_digest,
        status_note: report.valid ? '图文档通过类型、唯一性、端点与属性约束校验。' : '图文档未通过结构约束校验。' });
    }
    if (stageId === 'graph-security') {
      const findings = scanSecurity(asset.projectRoot);
      const blocking = findings.filter((finding) => finding.blocking);
      return resultWithEvidence(stageId, stageInput, blocking.length ? 'FAILED' : findings.length ? 'WARNING' : 'PASSED', {
        scanned_files: 1, finding_count: findings.length, blocking_count: blocking.length, scanner_version: 'graph-content-security:v1',
      }, { producer: 'knowledge-builder-security:v1', findings, content_digest: asset.content_digest,
        status_note: findings.length ? '图谱属性与来源文件安全扫描发现问题。' : '图谱属性与来源文件安全扫描通过。' });
    }
    if (stageId === 'graph-evaluation') {
      const datasetRef = String(stageInput.dataset_ref || '').trim();
      if (!datasetRef) return resultWithEvidence(stageId, stageInput, 'BLOCKED', { evaluation_scope: 'UNAVAILABLE' }, {
        producer: 'knowledge-builder-graph-eval:v1', status_note: '缺少版本化能力问题与事实验真集。',
        error: { code: 'GRAPH_EVAL_DATASET_REQUIRED', message: '请绑定图谱能力问题评测集' },
      });
      const datasetPath = resolveInside(evalDatasetsRoot, safeSegment(datasetRef, 'dataset_ref') + '.json', 'GRAPH_DATASET_PATH_INVALID');
      if (!fs.existsSync(datasetPath)) fail('GRAPH_EVAL_DATASET_NOT_FOUND', '图谱评测集不存在', 404);
      const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
      if (!Array.isArray(dataset.cases) || !dataset.cases.length) fail('GRAPH_EVAL_DATASET_INVALID', '图谱评测集必须包含非空 cases');
      const caseSummary = evaluateGraphCases(asset, dataset);
      const competencyPassRate = caseSummary.filter((item) => item.passed).length / caseSummary.length;
      const connectedRatio = structure.nodes.length ? structure.connected_count / structure.nodes.length : 0;
      const report = validateGraph(asset.template, asset.graph);
      const metrics = [
        { name: 'Competency Pass Rate', value: Number(competencyPassRate.toFixed(4)), threshold: 0.9 },
        { name: 'Schema Conformance', value: report.valid ? 1 : 0, threshold: 1 },
        { name: 'Connected Node Ratio', value: Number(connectedRatio.toFixed(4)), threshold: 0.9 },
      ];
      const releaseEligible = dataset.release_eligible === true;
      const passed = releaseEligible && metrics.every((metric) => metric.value >= metric.threshold);
      return resultWithEvidence(stageId, stageInput, passed ? 'PASSED' : 'WARNING', {
        evaluator_version: 'graph-competency-eval:v1', evaluation_profile: 'graph-competency:v1',
        dataset_ref: datasetRef, dataset_version: dataset.version || null, dataset_scope: dataset.scope || 'UNSPECIFIED',
        release_eligible: releaseEligible, case_count: caseSummary.length, case_summary: caseSummary,
      }, { producer: 'knowledge-builder-graph-eval:v1', metrics, content_digest: asset.content_digest,
        status_note: !releaseEligible ? '图谱冒烟评测已完成，但该数据集未获准用于发布门禁。' : passed ? '图谱评测达到发布阈值。' : '图谱评测未达到全部门禁阈值。' });
    }
    if (stageId === 'observe') {
      return resultWithEvidence(stageId, stageInput, 'PASSED', {
        content_digest: asset.content_digest, node_count: structure.nodes.length, edge_count: structure.edges.length,
        isolated_count: structure.isolated_count, duplicate_candidate_count: structure.duplicates.length,
      }, { producer: 'knowledge-builder-graph-observer:v1', content_digest: asset.content_digest, status_note: '已建立图规模与完整性观测基线。' });
    }
    fail('GRAPH_STAGE_UNSUPPORTED', '不支持的知识图谱构建阶段');
  }

  function lintSkill(asset, profile) {
    return validateSkillPackage({
      root: asset.root,
      markdown: asset.content,
      folderName: asset.project,
    }, { profile });
  }

  function scanSkillSupplyChain(asset) {
    const findings = [];
    const textExtensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.ps1', '.toml']);
    const rules = [
      { code: 'SKILL_SECRET_EXPOSURE', severity: 'CRITICAL', blocking: true, expression: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"\s]{8,}/ig, message: '疑似硬编码凭据' },
      { code: 'SKILL_DESTRUCTIVE_COMMAND', severity: 'HIGH', blocking: true, expression: /(?:rm\s+-rf|Remove-Item\s+[^\r\n]*-Recurse|format\s+[a-z]:)/ig, message: '发现高风险破坏性命令' },
      { code: 'SKILL_DYNAMIC_EXECUTION', severity: 'HIGH', blocking: false, expression: /(?:child_process|\beval\s*\(|exec\s*\(|subprocess\.(?:run|Popen)|os\.system)/ig, message: '发现动态命令执行能力，需要人工审查' },
      { code: 'SKILL_NETWORK_ACCESS', severity: 'MEDIUM', blocking: false, expression: /(?:https?:\/\/|fetch\s*\(|requests\.(?:get|post)|curl\s+)/ig, message: '发现网络访问能力，需要核对域名和数据外传边界' },
      { code: 'SKILL_CODE_FUNCTION_CTOR', severity: 'CRITICAL', blocking: true, expression: /new\s+Function\s*\(/g, message: 'Function() 构造器可能导致任意代码执行' },
      { code: 'SKILL_CODE_TIMER_STRING', severity: 'HIGH', blocking: true, expression: /(?:setTimeout|setInterval)\s*\(\s*['"]/g, message: 'setTimeout/setInterval 使用字符串参数可能导致代码注入' },
      { code: 'SKILL_CODE_INNER_HTML', severity: 'HIGH', blocking: true, expression: /\.innerHTML\s*=/g, message: 'innerHTML 赋值可能导致 XSS 攻击' },
      { code: 'SKILL_CODE_DOC_WRITE', severity: 'HIGH', blocking: true, expression: /document\.write\s*\(/g, message: 'document.write() 可能导致 XSS 攻击' },
      { code: 'SKILL_FS_WRITE', severity: 'MEDIUM', blocking: false, expression: /(?:fs\.writeFileSync|fs\.writeFile)\s*\(/g, message: '检测到文件系统写入操作，需防路径穿越' },
      { code: 'SKILL_FS_DELETE', severity: 'HIGH', blocking: true, expression: /(?:fs\.unlinkSync|fs\.unlink)\s*\(/g, message: '检测到文件删除操作，需严格限制路径' },
    ];
    asset.manifest.forEach((entry) => {
      if (!textExtensions.has(path.extname(entry.path).toLowerCase()) || entry.size > 2 * 1024 * 1024) return;
      const content = fs.readFileSync(path.join(asset.root, entry.path), 'utf8');
      rules.forEach((rule) => {
        rule.expression.lastIndex = 0;
        if (rule.expression.test(content)) findings.push({ code: rule.code, severity: rule.severity, blocking: rule.blocking, path: entry.path, message: rule.message });
      });
    });
    return findings;
  }

  function skillTriggerTokens(description) {
    const ascii = String(description || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [];
    const chinese = String(description || '').match(/[\u3400-\u9fff]{2,}/g) || [];
    return Array.from(new Set(ascii.concat(chinese.flatMap((value) => value.length <= 4 ? [value] : Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2))))));
  }

  function loadSkillTestDataset(datasetRef) {
    const reference = String(datasetRef || '').trim();
    if (!reference) return { error: { code: 'SKILL_TEST_DATASET_REQUIRED', message: '请先选择包含触发用例和任务用例的测试集' } };
    const datasetPath = resolveInside(evalDatasetsRoot, safeSegment(reference, 'dataset_ref') + '.json', 'SKILL_DATASET_PATH_INVALID');
    if (!fs.existsSync(datasetPath)) return { error: { code: 'SKILL_TEST_DATASET_NOT_FOUND', message: '所选 Skill 测试集不存在' } };
    let dataset;
    let datasetBytes;
    try { datasetBytes = fs.readFileSync(datasetPath); dataset = JSON.parse(datasetBytes.toString('utf8')); }
    catch (_) { return { error: { code: 'SKILL_TEST_DATASET_INVALID', message: '所选 Skill 测试集不是有效 JSON' } }; }
    if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)
      || (dataset.artifact_type && dataset.artifact_type !== 'AGENT_SKILL')
      || !Array.isArray(dataset.cases) || dataset.cases.length < 1 || dataset.cases.length > 200) {
      return { error: { code: 'SKILL_TEST_DATASET_INVALID', message: 'Skill 测试集必须包含 1 到 200 条 AGENT_SKILL 用例' } };
    }
    const seen = new Set();
    const cases = [];
    for (let index = 0; index < dataset.cases.length; index += 1) {
      const testCase = dataset.cases[index];
      if (!testCase || typeof testCase !== 'object' || Array.isArray(testCase)) {
        return { error: { code: 'SKILL_TEST_DATASET_INVALID', message: 'Skill 测试集包含无效用例' } };
      }
      const caseId = String(testCase.case_id || 'skill-case-' + (index + 1)).trim();
      const query = String(testCase.input || testCase.query || '').trim();
      let kind = String(testCase.kind || '').trim().toUpperCase();
      if (!kind && typeof testCase.should_trigger === 'boolean') kind = testCase.should_trigger ? 'TRIGGER_POSITIVE' : 'TRIGGER_NEGATIVE';
      if (!kind && (testCase.expected_keywords || testCase.expected_regex || testCase.required_tools)) kind = 'TASK';
      if (!caseId || seen.has(caseId) || !query || query.length > 8000
        || !['TRIGGER_POSITIVE', 'TRIGGER_NEGATIVE', 'TRIGGER_BOUNDARY', 'TASK'].includes(kind)) {
        return { error: { code: 'SKILL_TEST_DATASET_INVALID', message: '每条用例必须有唯一 case_id、输入和有效类型' } };
      }
      seen.add(caseId);
      cases.push({ case_id: caseId, kind, input: query, context: testCase.context || {}, expected: testCase.expected || {} });
    }
    return { dataset, cases, reference, digest: 'sha256:' + crypto.createHash('sha256').update(datasetBytes).digest('hex') };
  }

  function skillRuntimeContext(input) {
    return {
      dataset_ref: input.dataset_ref || null,
      model: String(input.model || '').trim() || null,
      runtime_provider: input.runtime_provider || 'platform-default',
      application_snapshot: input.application_snapshot || { type: 'PLATFORM_STANDARD_TEST_AGENT', version: 'v1' },
      policy: {
        timeout_seconds: Number(input.timeout_seconds || 120),
        max_iterations: Number(input.max_iterations || 30),
        require_isolation: false,
        allowed_tools: Array.isArray(input.allowed_tools) ? input.allowed_tools : [],
        forbidden_tools: Array.isArray(input.forbidden_tools) ? input.forbidden_tools : [],
      },
    };
  }

  function skillRuntimePackage(asset) {
    return {
      name: asset.metadata.name || asset.project,
      version_ref: asset.version_ref || 'workspace-skill:' + asset.project + ':' + asset.content_digest,
      files: asset.manifest.map((entry) => {
        const bytes = fs.readFileSync(path.join(asset.root, entry.path));
        const text = bytes.toString('utf8');
        return Buffer.from(text, 'utf8').equals(bytes)
          ? { path: entry.path, content: text }
          : { path: entry.path, content_base64: bytes.toString('base64') };
      }),
    };
  }

  function skillExecutionEvidence(stageInput) {
    const reference = String(stageInput.execution_ref || '').trim();
    if (!reference) return { error: { code: 'SKILL_RUNTIME_EXECUTION_REQUIRED', message: '请先完成真实 Agent 运行' } };
    let evidence;
    try { evidence = getEvidence(reference); }
    catch (error) {
      if (error.code === 'EVIDENCE_NOT_FOUND' || error.code === 'EVIDENCE_ID_INVALID') {
        return { error: { code: 'SKILL_RUNTIME_EXECUTION_NOT_FOUND', message: '真实 Agent 运行记录不存在或已失效' } };
      }
      throw error;
    }
    if (evidence.stage_id !== 'sandbox-execution' || evidence.artifact_type !== 'AGENT_SKILL'
      || evidence.inputs.project !== stageInput.project
      || evidence.inputs.run_id !== (stageInput.run_id || null)
      || evidence.inputs.artifact_id !== (stageInput.artifact_id || null)
      || evidence.inputs.artifact_version_id !== (stageInput.artifact_version_id || null)
      || evidence.inputs.version_ref !== (stageInput.version_ref || null)
      || evidence.inputs.content_digest !== stageInput.content_digest) {
      return { error: { code: 'SKILL_RUNTIME_EXECUTION_MISMATCH', message: '真实 Agent 运行记录不属于当前 Skill 或本次检查' } };
    }
    // S11: runtime context (dataset / model / runtime_provider / application)
    // must match between the execution evidence and the scoring stage input.
    // Otherwise the scorer re-scores an execution that was run under a
    // different dataset/model, which is forbidden. Incomplete legacy
    // evidence must be regenerated before it can certify scoring.
    // See docs/skill-evolution-review-2026-10-27.md S11.
    const execCtx = evidence.inputs || {};
    const expectedContext = skillRuntimeContext(stageInput);
    for (const [k, stageVal] of Object.entries(expectedContext)) {
      if (!sameJsonValue(execCtx[k], stageVal)) {
        return { error: { code: 'SKILL_RUNTIME_CONTEXT_MISMATCH',
          message: '评分请求的运行上下文与执行记录不一致（' + k + '），不能跨数据集或模型重新评分' } };
      }
    }
    if (evidence.status === 'SKIPPED') {
      return { error: { code: 'SKILL_RUNTIME_SKIPPED', message: '真实 Agent 运行已跳过（运行时服务不可用），触发评估和任务评估同样跳过。' } };
    }
    const loaded = loadSkillTestDataset(stageInput.dataset_ref);
    if (loaded.error) return loaded;
    if (!execCtx.dataset_digest || execCtx.dataset_digest !== loaded.digest
      || execCtx.dataset_version !== (loaded.dataset.version || null)) {
      return { error: { code: 'SKILL_RUNTIME_CONTEXT_MISMATCH', message: '测试集内容或版本与执行记录不一致，请重新执行测试' } };
    }
    if (!evidence.outputs || !Array.isArray(evidence.outputs.case_results)) {
      return { error: { code: 'SKILL_RUNTIME_EXECUTION_MISMATCH', message: '真实 Agent 运行记录不属于当前 Skill 或本次检查' } };
    }
    return { evidence, outputs: evidence.outputs };
  }

  function blockedSkillResult(stageId, stageInput, producer, error, note) {
    return resultWithEvidence(stageId, stageInput, 'BLOCKED', { evaluation_scope: 'UNAVAILABLE' }, {
      producer, status_note: note || error.message, error,
    });
  }

  function skippedSkillResult(stageId, stageInput, producer, error, note) {
    return resultWithEvidence(stageId, stageInput, 'SKIPPED', { evaluation_scope: 'SKIPPED' }, {
      producer, status_note: note || error.message, error,
    });
  }

  async function judgeSkillOutput(testCase, actual, skillMeta) {
    if (typeof fetchImpl !== 'function') return { error: { code: 'SKILL_LLM_JUDGE_UNAVAILABLE', message: 'LLM 评判服务未配置' } };
    const output = String(actual && actual.output || '');
    if (!output) return { error: { code: 'SKILL_LLM_JUDGE_NO_OUTPUT', message: 'Agent 无输出，无法进行 LLM 评判' } };
    const rubric = String(testCase.llm_judge_rubric || testCase.expected_semantics || '');
    if (!rubric) return { error: { code: 'SKILL_LLM_JUDGE_NO_RUBRIC', message: '用例未配置 llm_judge_rubric，跳过 LLM 评判' } };
    const payload = {
      query: String(testCase.user_input || testCase.input || testCase.query || ''),
      answer: output.slice(0, 12000),
      retrieved_contexts: [],
      gold_answer: rubric,
      eval_mode: 'skill_judge',
      skill_name: skillMeta.name,
      skill_description: skillMeta.description,
      judge_criteria: rubric,
      expected_tools: Array.isArray(testCase.required_tools) ? testCase.required_tools : [],
      forbidden_actions: Array.isArray(testCase.forbidden_tools) ? testCase.forbidden_tools : [],
    };
    try {
      const response = await fetchImpl(evaluatorUrl + '/api/v1/evaluation/skill-judge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!response || !response.ok) {
        const detail = response ? await response.text().catch(() => '') : '';
        return { error: { code: 'SKILL_LLM_JUDGE_FAILED', message: `LLM 评判服务返回异常: ${response ? response.status : 'no-response'} ${String(detail).slice(0, 200)}` } };
      }
      const evaluated = await response.json();
      const scoreKeys = ['score', 'answer_correctness'];
      const hasScore = evaluated && scoreKeys.some(key => Object.hasOwn(evaluated, key));
      const validScore = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
      const threshold = testCase.llm_judge_threshold === undefined ? 0.7 : testCase.llm_judge_threshold;
      if (!evaluated || typeof evaluated !== 'object' || Array.isArray(evaluated)
        || Object.hasOwn(evaluated, 'passed') && typeof evaluated.passed !== 'boolean'
        || scoreKeys.some(key => Object.hasOwn(evaluated, key) && !validScore(evaluated[key]))
        || typeof evaluated.passed !== 'boolean' && !hasScore
        || !validScore(threshold)) {
        return { error: { code: 'SKILL_LLM_JUDGE_RESPONSE_INVALID', message: '裁判必须返回明确的布尔结论或 0 到 1 的有限分数' } };
      }
      const score = evaluated.score ?? evaluated.answer_correctness ?? null;
      return {
        llm_score: score,
        llm_feedback: evaluated.feedback || evaluated.reasoning || evaluated.comment || '',
        llm_passed: typeof evaluated.passed === 'boolean' ? evaluated.passed
          : score >= threshold,
        evaluator_version: evaluated.evaluator_version || 'skill-judge-v1',
      };
    } catch (err) {
      return { error: { code: 'SKILL_LLM_JUDGE_ERROR', message: String(err.message || err).slice(0, 300) } };
    }
  }

  async function executeSkillStage(stageId, input) {
    if (!SKILL_STAGES.has(stageId)) fail('SKILL_STAGE_UNSUPPORTED', '不支持的 Agent Skill 构建阶段');
    const stageInput = Object.assign({}, input || {}, { artifact_type: 'AGENT_SKILL' });
    const asset = skillAsset(stageInput);
    stageInput.content_digest = asset.content_digest;
    if (stageId === 'intent-contract') {
      const findings = [];
      if (!asset.metadata.name || !asset.metadata.description) findings.push({ code: 'SKILL_DISCOVERY_CONTRACT_MISSING', severity: 'HIGH', blocking: true, message: '缺少 name 或 description，Agent 无法完成 Discovery' });
      return resultWithEvidence(stageId, stageInput, findings.length ? 'FAILED' : 'PASSED', {
        name: asset.metadata.name || null, description: asset.metadata.description || null,
        discovery_token_count: skillTriggerTokens(asset.metadata.description).length,
      }, { producer: 'knowledge-builder-skill-contract:v1', findings, content_digest: asset.content_digest,
        status_note: findings.length ? 'Skill 意图发现契约不完整。' : 'Skill name 与 description 发现契约已固定。' });
    }
    if (stageId === 'skill-package') {
      return resultWithEvidence(stageId, stageInput, 'PASSED', {
        content_digest: asset.content_digest, file_count: asset.manifest.length, total_bytes: asset.total_bytes,
        manifest: asset.manifest, package_format: 'AGENT_SKILL_DIRECTORY:v1',
      }, { producer: 'knowledge-builder-skill-packager:v1', content_digest: asset.content_digest, status_note: '已固定 SKILL.md、资源与脚本清单。' });
    }
    if (stageId === 'skill-lint') {
      const validation = lintSkill(asset, stageInput.profile);
      const findings = validation.findings;
      const blocking = findings.filter((item) => item.blocking);
      return resultWithEvidence(stageId, stageInput, blocking.length ? 'FAILED' : findings.length ? 'WARNING' : 'PASSED', {
        validator_version: 'agent-skill-spec-lint:v2',
        profile: validation.profile,
        rule_version: validation.rule_version,
        finding_count: findings.length,
        blocking_count: blocking.length,
        exportable: validation.exportable,
        spec_passed: validation.spec_passed,
        runtime_verified: false,
      }, { producer: 'knowledge-builder-skill-lint:v1', findings, content_digest: asset.content_digest,
        status_note: findings.length ? 'Skill 规范检查发现需要处理的项目。' : `${validation.profile} 格式与规范检查通过；真实运行仍需单独验证。` });
    }
    if (stageId === 'supply-chain-security') {
      const findings = scanSkillSupplyChain(asset); const blocking = findings.filter((item) => item.blocking);
      return resultWithEvidence(stageId, stageInput, blocking.length ? 'FAILED' : findings.length ? 'WARNING' : 'PASSED', {
        scanner_version: 'skill-supply-chain-security:v1', scanned_file_count: asset.manifest.length,
        finding_count: findings.length, blocking_count: blocking.length,
      }, { producer: 'knowledge-builder-skill-security:v1', findings, content_digest: asset.content_digest,
        status_note: findings.length ? 'Skill 供应链扫描发现需要审查的权限或代码。' : 'Skill 供应链基础扫描通过。' });
    }
    if (stageId === 'credential-scan') {
      /* 深度凭据扫描：检测硬编码的 API Key、Bearer Token、密码、私钥、JWT、数据库连接串等 */
      var credentialRules = [
        { code: 'SKILL_CRED_API_KEY', severity: 'CRITICAL', blocking: true, pattern: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*['"][a-zA-Z0-9_\-]{20,}['"]/gi, message: '检测到疑似 API 密钥' },
        { code: 'SKILL_CRED_BEARER', severity: 'CRITICAL', blocking: true, pattern: /bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi, message: '检测到疑似 Bearer Token' },
        { code: 'SKILL_CRED_PASSWORD', severity: 'HIGH', blocking: true, pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi, message: '检测到疑似密码' },
        { code: 'SKILL_CRED_PRIVATE_KEY', severity: 'CRITICAL', blocking: true, pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g, message: '检测到私钥文件内容' },
        { code: 'SKILL_CRED_AWS', severity: 'CRITICAL', blocking: true, pattern: /(?:aws[_-]?(?:access[_-]?key|secret[_-]?key))\s*[:=]\s*['"][A-Z0-9]{20}['"]/gi, message: '检测到 AWS 访问密钥' },
        { code: 'SKILL_CRED_JWT', severity: 'HIGH', blocking: false, pattern: /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, message: '检测到疑似 JWT Token' },
        { code: 'SKILL_CRED_DB_URL', severity: 'HIGH', blocking: true, pattern: /(?:mongodb|mysql|postgresql|redis)\+?(?:\w+)?:\/\/(?:[^:]+):([^@]+)@/gi, message: '检测到数据库连接字符串中的密码' },
      ];
      var credentialFindings = [];
      var credentialTextExtensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.ps1', '.toml', '.env']);
      asset.manifest.forEach(function (entry) {
        if (!credentialTextExtensions.has(path.extname(entry.path).toLowerCase()) || entry.size > 2 * 1024 * 1024) return;
        var content = fs.readFileSync(path.join(asset.root, entry.path), 'utf8');
        credentialRules.forEach(function (rule) {
          rule.pattern.lastIndex = 0;
          if (rule.pattern.test(content)) {
            credentialFindings.push({ code: rule.code, severity: rule.severity, blocking: rule.blocking, path: entry.path, message: rule.message });
          }
        });
      });
      var credentialBlocking = credentialFindings.filter(function (item) { return item.blocking; });
      return resultWithEvidence(stageId, stageInput, credentialBlocking.length ? 'FAILED' : credentialFindings.length ? 'WARNING' : 'PASSED', {
        scanner_version: 'skill-credential-scanner:v1', scanned_file_count: asset.manifest.length,
        finding_count: credentialFindings.length, blocking_count: credentialBlocking.length,
      }, { producer: 'knowledge-builder-skill-credential-scan:v1', findings: credentialFindings, content_digest: asset.content_digest,
        status_note: credentialFindings.length ? '深度凭据扫描发现疑似硬编码密钥或密码。' : '深度凭据扫描通过，未发现硬编码凭据。' });
    }
    if (stageId === 'prompt-injection-check') {
      /* 提示注入检测：检查 SKILL.md 中是否包含可能导致 Agent 忽略原有指令的文本 */
      var injectionRules = [
        { code: 'SKILL_PI_IGNORE_PREVIOUS', severity: 'CRITICAL', blocking: true, pattern: /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions?/gi, message: '包含"忽略先前指令"模式，可能导致提示注入' },
        { code: 'SKILL_PI_DISREGARD', severity: 'CRITICAL', blocking: true, pattern: /disregard\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|prompts?)/gi, message: '包含"忽略先前指令"变体，可能导致提示注入' },
        { code: 'SKILL_PI_NEW_ROLE', severity: 'HIGH', blocking: false, pattern: /you\s+are\s+now\s+(?:a|an)\s+/gi, message: '包含角色重定义模式，可能试图覆盖 Agent 身份' },
        { code: 'SKILL_PI_SYSTEM_OVERRIDE', severity: 'HIGH', blocking: false, pattern: /(?:system|developer)\s*(?:prompt|instruction|message)\s*[:：]/gi, message: '包含系统指令覆盖模式' },
        { code: 'SKILL_PI_JAILBREAK', severity: 'CRITICAL', blocking: true, pattern: /(?:\bjailbreak\b|\bDAN\b|\bdo\s+anything\s+now\b|\bact\s+as\s+(?:an?\s+)?unrestricted\b)/gi, message: '包含已知越狱模式' },
        { code: 'SKILL_PI_DATA_EXFIL', severity: 'HIGH', blocking: false, pattern: /(?:repeat|print|output|show)\s+(?:the\s+)?(?:system|hidden|initial)\s+(?:prompt|instruction|message)/gi, message: '包含系统提示泄露模式' },
        { code: 'SKILL_PI_SEPARATOR_CONFUSION', severity: 'MEDIUM', blocking: false, pattern: /---+\s*(?:end\s+of\s+)?(?:system|user|assistant)\s*---+/gi, message: '包含角色分隔符混淆模式' },
      ];
      var injectionFindings = [];
      /* 仅扫描 SKILL.md 本身，因为附属脚本文件不会直接成为 LLM 的指令 */
      var skillContent = asset.content;
      injectionRules.forEach(function (rule) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(skillContent)) {
          injectionFindings.push({ code: rule.code, severity: rule.severity, blocking: rule.blocking, section: 'SKILL.md', message: rule.message });
        }
      });
      var injectionBlocking = injectionFindings.filter(function (item) { return item.blocking; });
      return resultWithEvidence(stageId, stageInput, injectionBlocking.length ? 'FAILED' : injectionFindings.length ? 'WARNING' : 'PASSED', {
        scanner_version: 'skill-prompt-injection-scanner:v1', scanned_file_count: 1,
        finding_count: injectionFindings.length, blocking_count: injectionBlocking.length,
      }, { producer: 'knowledge-builder-skill-prompt-injection:v1', findings: injectionFindings, content_digest: asset.content_digest,
        status_note: injectionFindings.length ? '提示注入检测发现可疑模式，需要人工审查。' : '提示注入检测通过，未发现可疑模式。' });
    }
    if (stageId === 'sandbox-execution') {
      const model = String(stageInput.model || '').trim();
      if (!model) return blockedSkillResult(stageId, stageInput, 'knowledge-builder-skill-runtime:v2',
        { code: 'SKILL_TEST_MODEL_REQUIRED', message: '请先选择测试使用的模型' });
      const loaded = loadSkillTestDataset(stageInput.dataset_ref);
      if (loaded.error) return blockedSkillResult(stageId, stageInput, 'knowledge-builder-skill-runtime:v2', loaded.error);
      let executed;
      try {
        executed = await skillRuntimeClient.runSkillTests({
          provider: String(stageInput.runtime_provider || 'platform-default'),
          model,
          application_snapshot: stageInput.application_snapshot || { type: 'PLATFORM_STANDARD_TEST_AGENT', version: 'v1' },
          skill: skillRuntimePackage(asset),
          cases: loaded.cases,
          policy: {
            timeout_seconds: Number(stageInput.timeout_seconds || 120),
            max_iterations: Number(stageInput.max_iterations || 30),
            require_isolation: false,
            allowed_tools: Array.isArray(stageInput.allowed_tools) ? stageInput.allowed_tools : [],
            forbidden_tools: Array.isArray(stageInput.forbidden_tools) ? stageInput.forbidden_tools : [],
          },
        });
      } catch (error) {
        if (error.code === 'AGENT_RUNTIME_UNAVAILABLE') {
          return skippedSkillResult(stageId, stageInput, 'knowledge-builder-skill-runtime:v2', {
            code: 'AGENT_RUNTIME_UNAVAILABLE', message: '平台智能体运行服务未配置或不可用，已跳过真实运行。请在 .env 中设置 AGENT_SERVICE_URL 指向可用的 agent 服务，或启动 ontomind-agent 容器。',
          });
        }
        return blockedSkillResult(stageId, stageInput, 'knowledge-builder-skill-runtime:v2', {
          code: error.code || 'AGENT_RUNTIME_EXECUTION_FAILED', message: String(error.message || '平台智能体测试失败').slice(0, 500),
        });
      }
      const caseResults = executed.results;
      const requestedIds = new Set(loaded.cases.map(item => item.case_id));
      if (!Array.isArray(caseResults) || caseResults.length !== requestedIds.size
        || new Set(caseResults.map(item => item && item.case_id)).size !== requestedIds.size
        || caseResults.some(item => !item || !requestedIds.has(item.case_id))) {
        return blockedSkillResult(stageId, stageInput, 'knowledge-builder-skill-runtime:v2',
          { code: 'SKILL_RUNTIME_CASES_MISMATCH', message: '运行结果必须完整且唯一地覆盖本次请求的全部用例' });
      }
      const allExecuted = caseResults.length === loaded.cases.length && caseResults.every((item) => item.agent_executed === true);
      const allIsolated = caseResults.length > 0 && caseResults.every((item) => item.isolated === true);
      const failed = caseResults.filter((item) => !['PASSED', 'WARNING'].includes(item.status));
      const violations = caseResults.flatMap((item) => Array.isArray(item.policy_violations) ? item.policy_violations : []);
      const status = !allExecuted ? 'BLOCKED' : failed.length || violations.length ? 'FAILED' : allIsolated ? 'PASSED' : 'WARNING';
      return resultWithEvidence(stageId, stageInput, status, {
        execution_scope: 'PLATFORM_AGENT_RUNTIME', runtime_provider: executed.runtime_provider,
        runtime_version: executed.runtime_version, model, dataset_ref: loaded.reference,
        dataset_version: loaded.dataset.version || null, dataset_digest: loaded.digest,
        application_snapshot: skillRuntimeContext(stageInput).application_snapshot, policy: skillRuntimeContext(stageInput).policy,
        agent_executed: allExecuted, isolated: allIsolated,
        case_count: caseResults.length, failed_case_count: failed.length, policy_violation_count: violations.length,
        case_results: caseResults,
      }, { producer: 'knowledge-builder-skill-runtime:v2', content_digest: asset.content_digest,
        status_note: status === 'PASSED' ? '真实 Agent 与隔离运行均已完成。'
          : status === 'WARNING' ? '真实 Agent 已运行，但没有配置隔离执行器，本次结果不能用于生产发布。'
            : status === 'FAILED' ? '真实 Agent 已运行，但存在失败用例或禁止操作。' : '平台智能体没有完成真实运行。' });
    }
    if (stageId === 'trigger-evaluation') {
      const loaded = loadSkillTestDataset(stageInput.dataset_ref);
      if (loaded.error) return blockedSkillResult(stageId, stageInput, 'knowledge-builder-skill-trigger-eval:v2', loaded.error);
      const execution = skillExecutionEvidence(stageInput);
      if (execution.error) {
        if (execution.error.code === 'SKILL_RUNTIME_SKIPPED') return skippedSkillResult(stageId, stageInput, 'knowledge-builder-skill-trigger-eval:v2', execution.error);
        return blockedSkillResult(stageId, stageInput, 'knowledge-builder-skill-trigger-eval:v2', execution.error);
      }
      const runtimeById = new Map(execution.outputs.case_results.map((item) => [item.case_id, item]));
      const triggerCases = loaded.cases.filter((item) => item.kind.startsWith('TRIGGER_'));
      if (!triggerCases.length) return blockedSkillResult(stageId, stageInput, 'knowledge-builder-skill-trigger-eval:v2',
        { code: 'SKILL_TRIGGER_CASES_REQUIRED', message: '测试集至少需要一条应该触发或不应该触发的用例' });
      const caseSummary = triggerCases.map((testCase) => {
        const actual = runtimeById.get(testCase.case_id);
        const expected = testCase.kind === 'TRIGGER_POSITIVE' ? true
          : testCase.kind === 'TRIGGER_NEGATIVE' ? false : loaded.dataset.cases.find((item) => String(item.case_id) === testCase.case_id).should_trigger;
        const selected = actual && actual.skill_loaded === true;
        return { case_id: testCase.case_id, kind: testCase.kind, expected, selected,
          passed: Boolean(actual && actual.status === 'PASSED' && actual.agent_executed === true
            && typeof expected === 'boolean' && selected === expected) };
      });
      const accuracy = caseSummary.filter((item) => item.passed).length / caseSummary.length;
      const positives = caseSummary.filter((item) => item.expected === true);
      const negatives = caseSummary.filter((item) => item.expected === false);
      const falseNegatives = positives.filter((item) => !item.selected).length;
      const falsePositives = negatives.filter((item) => item.selected).length;
      const threshold = Number(loaded.dataset.trigger_threshold || 0.9);
      const releaseEligible = loaded.dataset.release_eligible === true && loaded.dataset.evaluator_mode === 'AGENT_RUNTIME';
      const metrics = [
        { name: 'Trigger Accuracy', value: Number(accuracy.toFixed(4)), threshold },
        { name: 'False Trigger Rate', value: negatives.length ? Number((falsePositives / negatives.length).toFixed(4)) : 0, threshold: 0.1 },
        { name: 'Missed Trigger Rate', value: positives.length ? Number((falseNegatives / positives.length).toFixed(4)) : 0, threshold: 0.1 },
      ];
      return resultWithEvidence(stageId, stageInput, accuracy >= threshold ? (releaseEligible ? 'PASSED' : 'WARNING') : 'FAILED', {
        evaluator_version: 'platform-agent-trigger-eval:v1', evaluation_profile: 'skill-triggering:v2', evaluator_mode: 'AGENT_RUNTIME',
        dataset_ref: loaded.reference, dataset_version: loaded.dataset.version || null, dataset_digest: loaded.digest, dataset_scope: loaded.dataset.scope || 'SMOKE',
        release_eligible: releaseEligible, execution_ref: stageInput.execution_ref, trigger_accuracy: Number(accuracy.toFixed(4)),
        false_trigger_count: falsePositives, missed_trigger_count: falseNegatives, case_count: caseSummary.length, case_summary: caseSummary,
      }, { producer: 'knowledge-builder-skill-trigger-eval:v2', metrics, content_digest: asset.content_digest,
        status_note: accuracy >= threshold ? '已根据真实 Agent 的 Skill 加载记录完成触发测试。' : '真实 Agent 存在误触发或漏触发。' });
    }
    if (stageId === 'task-evaluation') {
      const loaded = loadSkillTestDataset(stageInput.dataset_ref);
      if (loaded.error) return blockedSkillResult(stageId, stageInput, 'knowledge-builder-skill-task-eval:v2', loaded.error);
      const execution = skillExecutionEvidence(stageInput);
      if (execution.error) {
        if (execution.error.code === 'SKILL_RUNTIME_SKIPPED') return skippedSkillResult(stageId, stageInput, 'knowledge-builder-skill-task-eval:v2', execution.error);
        return blockedSkillResult(stageId, stageInput, 'knowledge-builder-skill-task-eval:v2', execution.error);
      }
      const runtimeById = new Map(execution.outputs.case_results.map((item) => [item.case_id, item]));
      const sourceById = new Map(loaded.dataset.cases.map((item, index) => [String(item.case_id || 'skill-case-' + (index + 1)), item]));
      const taskCases = loaded.cases.filter((item) => item.kind === 'TASK');
      if (!taskCases.length) return blockedSkillResult(stageId, stageInput, 'knowledge-builder-skill-task-eval:v2',
        { code: 'SKILL_TASK_CASES_REQUIRED', message: '测试集至少需要一条真实任务用例' });
      const caseSummary = await Promise.all(taskCases.map(async (testCase) => {
        const actual = runtimeById.get(testCase.case_id);
        const sourceCase = sourceById.get(testCase.case_id) || {};
        const output = String(actual && actual.output || '');
        const toolNames = new Set((actual && Array.isArray(actual.tool_calls) ? actual.tool_calls : []).map((item) => item.name));
        const keywords = Array.isArray(sourceCase.expected_keywords) ? sourceCase.expected_keywords.map(String) : [];
        const requiredTools = Array.isArray(sourceCase.required_tools) ? sourceCase.required_tools.map(String) : [];
        const forbiddenTools = Array.isArray(sourceCase.forbidden_tools) ? sourceCase.forbidden_tools.map(String) : [];
        let regexPassed = true;
        if (sourceCase.expected_regex) {
          try { regexPassed = new RegExp(String(sourceCase.expected_regex), 'u').test(output); }
          catch (_) { regexPassed = false; }
        }
        const assertions = {
          runtime_status: Boolean(actual && actual.status === 'PASSED' && actual.agent_executed === true && actual.skill_loaded === true),
          expected_keywords: keywords.every((keyword) => output.includes(keyword)),
          expected_regex: regexPassed,
          required_tools: requiredTools.every((tool) => toolNames.has(tool)),
          forbidden_tools: forbiddenTools.every((tool) => !toolNames.has(tool)),
          duration: !Number.isFinite(Number(sourceCase.max_duration_ms)) || Number(actual && actual.duration_ms || Infinity) <= Number(sourceCase.max_duration_ms),
        };
        const hasLlmJudge = Boolean(sourceCase.llm_judge_rubric || sourceCase.expected_semantics);
        let llmJudge = null;
        if (hasLlmJudge) {
          llmJudge = await judgeSkillOutput(sourceCase, actual, { name: asset.metadata.name, description: asset.metadata.description });
          if (llmJudge && !llmJudge.error) {
            // Strict: only an explicit boolean true passes. null/undefined (e.g.
            // judge returned {} or omitted `passed`) must NOT be treated as
            // success — leave the assertion null so the every() gate below
            // rejects the case. See docs/skill-evolution-review-2026-10-27.md S02.
            assertions.llm_judge = llmJudge.llm_passed === true;
          } else if (llmJudge && llmJudge.error) {
            assertions.llm_judge = null;
            llmJudge = { error: llmJudge.error };
          } else {
            // N08: judgeSkillOutput returned a falsy value (null/undefined) —
            // neither the success nor the error branch above set llm_judge, so
            // without this guard the assertion key never exists and Object.values
            // would skip it, letting the case pass while the judge silently failed.
            assertions.llm_judge = null;
          }
        }
        const passed = Object.values(assertions).every((value) => value !== false && value !== null);
        return { case_id: testCase.case_id, passed, assertions,
          output: output.slice(0, 20000), tool_calls: Array.from(toolNames), duration_ms: actual && actual.duration_ms || null,
          error_code: actual && actual.error_code || null,
          llm_score: llmJudge ? llmJudge.llm_score ?? null : null,
          llm_feedback: llmJudge && llmJudge.llm_feedback || null,
          llm_judge_applied: hasLlmJudge,
        };
      }));
      const passRate = caseSummary.filter((item) => item.passed).length / caseSummary.length;
      const threshold = Number(loaded.dataset.task_threshold || 0.9);
      const releaseEligible = loaded.dataset.release_eligible === true && loaded.dataset.evaluator_mode === 'AGENT_RUNTIME';
      const llmJudgedCases = caseSummary.filter((item) => item.llm_judge_applied);
      const llmAvgScore = llmJudgedCases.length > 0
        ? Number((llmJudgedCases.reduce((sum, item) => sum + (item.llm_score || 0), 0) / llmJudgedCases.length).toFixed(4))
        : null;
      const metrics = [
        { name: 'Task Pass Rate', value: Number(passRate.toFixed(4)), threshold },
        ...(llmAvgScore !== null ? [{ name: 'LLM Judge Score', value: llmAvgScore, threshold: 0.7 }] : []),
      ];
      return resultWithEvidence(stageId, stageInput, passRate >= threshold ? (releaseEligible ? 'PASSED' : 'WARNING') : 'FAILED', {
        evaluator_version: 'platform-agent-task-eval:v1', evaluation_profile: 'skill-task:v1', evaluator_mode: 'AGENT_RUNTIME',
        dataset_ref: loaded.reference, dataset_version: loaded.dataset.version || null, dataset_digest: loaded.digest, dataset_scope: loaded.dataset.scope || 'SMOKE',
        release_eligible: releaseEligible, execution_ref: stageInput.execution_ref, task_pass_rate: Number(passRate.toFixed(4)),
        llm_judge_enabled: llmJudgedCases.length > 0, llm_judge_score: llmAvgScore, llm_judged_cases: llmJudgedCases.length,
        case_count: caseSummary.length, case_summary: caseSummary,
      }, { producer: 'knowledge-builder-skill-task-eval:v2', metrics, content_digest: asset.content_digest,
        status_note: passRate >= threshold ? '真实任务输出与工具调用检查已完成。' : '部分真实任务未达到预期结果。' });
    }
    if (stageId === 'observe') {
      return resultWithEvidence(stageId, stageInput, 'PASSED', {
        content_digest: asset.content_digest, file_count: asset.manifest.length, total_bytes: asset.total_bytes,
      }, { producer: 'knowledge-builder-skill-observer:v1', content_digest: asset.content_digest, status_note: '已建立 Skill 包摘要与文件规模观测基线。' });
    }
    fail('SKILL_STAGE_UNSUPPORTED', '不支持的 Agent Skill 构建阶段');
  }

  function allReleases() {
    const cached = releasesCache.get('all');
    if (cached) return cached;
    const releases = [];
    if (!fs.existsSync(releasesRoot)) return releases;
    function walk(directory) {
      fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.isFile() && entry.name === 'release-manifest.json') {
          const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          releases.push(manifest);
        }
      });
    }
    walk(releasesRoot);
    releasesCache.set('all', releases);
    return releases;
  }

  function findRelease(releaseId) {
    const matches = allReleases().filter((manifest) => manifest.release_id === releaseId);
    if (matches.length > 1) fail('RELEASE_ID_AMBIGUOUS', '发布标识对应多个不可变清单，已拒绝选择', 409);
    return matches[0] || null;
  }

  function listWikiReleases(query) {
    const project = typeof query === 'string' ? query : query && query.project;
    const releases = allReleases()
      .filter((release) => release.artifact_type === 'LLM_WIKI' && (!project || release.project === project))
      .sort((left, right) => String(right.released_at).localeCompare(String(left.released_at))
        || String(right.release_id).localeCompare(String(left.release_id)));
    return { releases, total: releases.length };
  }

  function listSkillReleases(query) {
    const project = typeof query === 'string' ? query : query && query.project;
    const releases = allReleases()
      .filter((release) => release.artifact_type === 'AGENT_SKILL' && (!project || release.project === project))
      .sort((left, right) => String(right.released_at).localeCompare(String(left.released_at))
        || String(right.release_id).localeCompare(String(left.release_id)));
    return { releases, total: releases.length };
  }

  function listSkillAliases(query) {
    const releases = listSkillReleases(query).releases;
    const aliases = [...new Set(releases.map((release) => release.alias))]
      .map((alias) => getAlias(alias))
      .filter((record) => record && releases.some((release) => release.release_id === record.release_id));
    return { aliases, total: aliases.length };
  }

  function writeAlias(alias, release) {
    const aliasName = safeSegment(alias, 'alias');
    const aliasPath = path.join(aliasesRoot, aliasName + '.json');
    const previous = fs.existsSync(aliasPath) ? JSON.parse(fs.readFileSync(aliasPath, 'utf8')) : null;
    const record = Object.assign({
      alias,
      release_id: release.release_id,
      artifact_id: release.artifact_id,
      artifact_version_id: release.artifact_version_id,
      content_digest: release.content_digest,
      channel: release.channel,
      previous_release_id: previous && previous.release_id || null,
      updated_at: now(),
    }, release.artifact_type === 'VECTOR_KB'
      ? {
        release_profile: normalizeVectorReleaseProfile(release.release_profile),
        index_certification: release.index_certification || null,
        index_cache_verification: release.index_cache_verification || null,
        dataset_certification: release.dataset_certification || null,
      }
      : {});
    const tempPath = aliasPath + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tempPath, aliasPath);
    return record;
  }

  function getAlias(alias) {
    const aliasPath = path.join(aliasesRoot, safeSegment(alias, 'alias') + '.json');
    if (!fs.existsSync(aliasPath)) return null;
    const record = JSON.parse(fs.readFileSync(aliasPath, 'utf8'));
    if (record.release_profile !== undefined) return record;
    const release = findRelease(record.release_id);
    if (!release || release.artifact_type !== 'VECTOR_KB') return record;
    return Object.assign({}, record, { release_profile: normalizeVectorReleaseProfile(release.release_profile) });
  }

  function getGateDecision(gateDecisionId) {
    if (!gateDecisionId) return null;
    const filePath = resolveInside(gatesRoot, safeSegment(gateDecisionId, 'gate_decision_id') + '.json', 'GATE_PATH_INVALID');
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  function certifiedIndexFromEvidence(evidence) {
    const outputs = evidence && evidence.outputs || {};
    const identity = {
      source_digest: outputs.source_digest,
      configuration_digest: outputs.configuration_digest,
      index_digest: outputs.index_digest,
    };
    return Object.values(identity).every((value) => /^sha256:[a-f0-9]{64}$/i.test(String(value || '')))
      ? identity : null;
  }

  function certifiedDatasetFromEvidence(evidence) {
    const outputs = evidence && evidence.outputs || {};
    const identity = {
      dataset_ref: outputs.dataset_ref, dataset_id: outputs.dataset_id,
      dataset_version: outputs.dataset_version, dataset_digest: outputs.dataset_digest,
      dataset_scope: outputs.dataset_scope, release_eligible: outputs.release_eligible,
    };
    if (!canonicalGenerationDatasetRef(identity.dataset_id)
      || !/^v[1-9]\d*$/.test(String(identity.dataset_version || ''))
      || identity.dataset_ref !== identity.dataset_id + '-' + identity.dataset_version
      || !/^sha256:[a-f0-9]{64}$/i.test(String(identity.dataset_digest || ''))) return null;
    return identity;
  }

  async function evaluateWikiGate(input, artifactTypeOverride) {
    const artifactType = artifactTypeOverride || 'LLM_WIKI';
    const releaseProfile = artifactType === 'VECTOR_KB' ? normalizeVectorReleaseProfile(input && input.release_profile) : null;
    const gateStages = artifactType === 'VECTOR_KB'
      ? (releaseProfile === 'RAG_SERVICE' ? VECTOR_GATE_STAGES.concat('generation-evaluation') : VECTOR_GATE_STAGES)
      : artifactType === 'KNOWLEDGE_GRAPH' ? GRAPH_GATE_STAGES
        : artifactType === 'AGENT_SKILL' ? SKILL_GATE_STAGES : WIKI_GATE_STAGES;
    const gateInput = Object.assign({}, input || {}, { artifact_type: artifactType },
      artifactType === 'VECTOR_KB' ? { release_profile: releaseProfile } : {});
    const currentDigest = artifactType === 'KNOWLEDGE_GRAPH' ? graphAsset(gateInput).content_digest
      : artifactType === 'AGENT_SKILL' ? skillAsset(gateInput).content_digest : summarizeProject(projectPath(gateInput.project)).content_digest;
    safeSegment(gateInput.artifact_id, 'artifact_id');
    safeSegment(gateInput.artifact_version_id, 'artifact_version_id');
    safeSegment(gateInput.run_id, 'run_id');
    // auto-fix 整改后 content_digest 可能未更新，用实际计算值补全
    if (!gateInput.content_digest) {
      gateInput.content_digest = currentDigest;
    }
    if (currentDigest !== gateInput.content_digest) {
      fail('GATE_DIGEST_MISMATCH', '门禁内容摘要与当前知识资产不一致', 409);
    }
    if (!Array.isArray(gateInput.evidence_refs) || gateInput.evidence_refs.length > 50) {
      fail('GATE_EVIDENCE_INVALID', '门禁证据列表不合法');
    }
    const evidenceItems = gateInput.evidence_refs.map((reference) => getEvidence(reference));
    const blockers = [];
    gateStages.forEach((stageId) => {
      const stageEvidence = evidenceItems.filter((item) => item.stage_id === stageId);
      if (!stageEvidence.length) {
        blockers.push({ stage_id: stageId, code: 'EVIDENCE_MISSING', reason: '缺少阶段证据' });
        return;
      }
      if (stageEvidence.length > 1) {
        blockers.push({ stage_id: stageId, code: 'EVIDENCE_DUPLICATE', reason: '阶段存在多份相互竞争的证据' });
        return;
      }
      const evidence = stageEvidence[0];
      const evidenceInput = evidence.inputs || {};
      if (artifactType === 'VECTOR_KB') {
        let evidenceProfile;
        try { evidenceProfile = normalizeVectorReleaseProfile(evidenceInput.release_profile); }
        catch (error) {
          if (error.code !== 'RELEASE_PROFILE_INVALID') throw error;
        }
        if (evidenceProfile !== releaseProfile) {
          blockers.push({ stage_id: stageId, code: 'EVIDENCE_RELEASE_PROFILE_MISMATCH', reason: '阶段证据不属于当前向量交付形态' });
          return;
        }
      }
      if (evidence.artifact_type !== artifactType
        || evidenceInput.project !== gateInput.project
        || evidenceInput.artifact_id !== gateInput.artifact_id
        || evidenceInput.artifact_version_id !== gateInput.artifact_version_id
        || evidenceInput.run_id !== gateInput.run_id
        || stageId !== 'source-snapshot' && evidenceInput.content_digest !== gateInput.content_digest) {
        blockers.push({ stage_id: stageId, code: 'EVIDENCE_BINDING_MISMATCH', reason: '阶段证据不属于当前构建运行' });
        return;
      }
      // S11: for sandbox-execution, also verify runtime context (dataset /
      // model / runtime_provider / application_snapshot) matches the gate
      // input — prevents cross-dataset / cross-model re-scoring reaching the
      // gate. See docs/skill-evolution-review-2026-10-27.md S11.
      if (stageId === 'sandbox-execution' && artifactType === 'AGENT_SKILL') {
        const verified = skillExecutionEvidence(Object.assign({}, gateInput, { execution_ref: evidence.evidence_id }));
        if (verified.error) {
          blockers.push({ stage_id: stageId, code: verified.error.code, reason: verified.error.message });
          return;
        }
      }
      if (artifactType === 'AGENT_SKILL' && ['trigger-evaluation', 'task-evaluation'].includes(stageId)) {
        const execution = evidenceItems.find(item => item.stage_id === 'sandbox-execution');
        const scoringRef = String(evidenceInput.execution_ref || '').replace(/^kb-evidence:/, '').replace(/^evidence:/, '');
        if (!execution || 'evidence:' + scoringRef !== execution.evidence_id
          || evidence.outputs.execution_ref !== evidenceInput.execution_ref) {
          blockers.push({ stage_id: stageId, code: 'SKILL_RUNTIME_EXECUTION_MISMATCH', reason: '评分证据未绑定门禁所选的同一次执行' });
          return;
        }
        const executionInput = execution.inputs || {};
        const fields = Object.keys(skillRuntimeContext(gateInput)).concat('dataset_version', 'dataset_digest', 'version_ref');
        if (fields.some(key => !sameJsonValue(evidenceInput[key], executionInput[key]))
          || evidence.outputs.dataset_digest !== executionInput.dataset_digest) {
          blockers.push({ stage_id: stageId, code: 'SKILL_RUNTIME_CONTEXT_MISMATCH', reason: '评分证据的测试集或运行条件与执行不一致' });
          return;
        }
      }
      if (stageId === 'source-snapshot' && (!evidence.outputs || evidence.outputs.content_digest !== gateInput.content_digest)) {
        blockers.push({ stage_id: stageId, code: 'EVIDENCE_DIGEST_MISMATCH', reason: '来源快照摘要与候选版本不一致' });
        return;
      }
      if (evidence.status !== 'PASSED') {
        blockers.push({ stage_id: stageId, code: 'STAGE_NOT_PASSED', reason: '阶段状态为 ' + evidence.status });
      }
    });
    let indexCertification = null;
    let indexCacheVerification = null;
    let datasetCertification = null;
    if (artifactType === 'VECTOR_KB') {
      const indexedStages = ['chunk-index', 'embedding-rerank', 'index-lint', 'retrieval-evaluation']
        .concat(releaseProfile === 'RAG_SERVICE' ? ['generation-evaluation'] : []);
      const indexIdentities = indexedStages.map((stageId) => {
        const evidence = evidenceItems.find((item) => item.stage_id === stageId);
        return { stage_id: stageId, identity: certifiedIndexFromEvidence(evidence) };
      });
      const missingIndex = indexIdentities.find((item) => !item.identity);
      if (missingIndex) {
        blockers.push({ stage_id: missingIndex.stage_id, code: 'RAG_INDEX_CERTIFICATION_MISSING', reason: '索引认证身份缺失' });
      } else {
        indexCertification = indexIdentities[0].identity;
        const mismatch = indexIdentities.find((item) => JSON.stringify(item.identity) !== JSON.stringify(indexCertification));
        if (mismatch) blockers.push({ stage_id: mismatch.stage_id, code: 'RAG_INDEX_CERTIFICATION_MISMATCH', reason: '索引认证身份不一致' });
      }

      const retrievalEvidence = evidenceItems.find((item) => item.stage_id === 'retrieval-evaluation');
      const retrievalDataset = certifiedDatasetFromEvidence(retrievalEvidence);
      const providedDataset = gateInput.dataset_certification === undefined || gateInput.dataset_certification === null
        ? null : certifiedDatasetFromEvidence({ outputs: gateInput.dataset_certification });
      if (gateInput.dataset_certification !== undefined && gateInput.dataset_certification !== null && !providedDataset) {
        blockers.push({ stage_id: 'retrieval-evaluation', code: 'RAG_DATASET_CERTIFICATION_INVALID', reason: 'Gate dataset certification is invalid' });
      }
      if (providedDataset && retrievalDataset && JSON.stringify(providedDataset) !== JSON.stringify(retrievalDataset)) {
        blockers.push({ stage_id: 'retrieval-evaluation', code: 'RAG_DATASET_CERTIFICATION_MISMATCH', reason: 'Gate and evidence dataset certifications differ' });
      }
      const gateDataset = providedDataset || retrievalDataset;
      if (!retrievalDataset) {
        blockers.push({ stage_id: 'retrieval-evaluation', code: 'RAG_DATASET_CERTIFICATION_MISSING', reason: '评测集认证身份缺失' });
      } else {
        datasetCertification = retrievalDataset;
        if (retrievalDataset.dataset_scope !== 'RELEASE' || retrievalDataset.release_eligible !== true) {
          blockers.push({ stage_id: 'retrieval-evaluation', code: 'RAG_DATASET_NOT_RELEASE_ELIGIBLE', reason: '评测集不是 Release 范围或未获准用于发布' });
        }
        if (releaseProfile === 'RAG_SERVICE') {
          const generationDataset = certifiedDatasetFromEvidence(evidenceItems.find((item) => item.stage_id === 'generation-evaluation'));
          if (!generationDataset || JSON.stringify(generationDataset) !== JSON.stringify(retrievalDataset)) {
            blockers.push({ stage_id: 'generation-evaluation', code: 'RAG_DATASET_CERTIFICATION_MISMATCH', reason: '检索与生成评测没有使用同一不可变数据集' });
          }
        }
      }
      if (gateDataset) {
        const authoritativeDataset = loadExactVectorDataset(gateDataset.dataset_ref,
          releaseProfile === 'RAG_SERVICE' ? 50 : 100);
        if (authoritativeDataset.error === 'NOT_FOUND') {
          datasetCertification = null;
          blockers.push({ stage_id: 'retrieval-evaluation', code: 'RAG_DATASET_ENTITY_NOT_FOUND', reason: 'Current evaluation dataset entity does not exist' });
        } else if (authoritativeDataset.error) {
          datasetCertification = null;
          blockers.push({ stage_id: 'retrieval-evaluation', code: 'RAG_DATASET_ENTITY_INVALID', reason: 'Current evaluation dataset entity identity or digest is invalid' });
        } else {
          const currentDataset = authoritativeDataset.identity;
          if (currentDataset.dataset_scope !== 'RELEASE' || currentDataset.release_eligible !== true) {
            datasetCertification = null;
            blockers.push({ stage_id: 'retrieval-evaluation', code: 'RAG_DATASET_ENTITY_NOT_RELEASE_ELIGIBLE', reason: 'Current evaluation dataset entity is not Release eligible' });
          } else if (JSON.stringify(currentDataset) !== JSON.stringify(gateDataset)
            || retrievalDataset && JSON.stringify(currentDataset) !== JSON.stringify(retrievalDataset)) {
            datasetCertification = null;
            blockers.push({ stage_id: 'retrieval-evaluation', code: 'RAG_DATASET_ENTITY_MISMATCH', reason: 'Evidence certification does not match the current evaluation dataset entity' });
          } else {
            datasetCertification = currentDataset;
          }
        }
      }
      if (indexCertification) {
        const verifiedCache = await verifyVectorCache(gateInput.project, indexCertification, 'GATE');
        if (verifiedCache.valid) indexCacheVerification = verifiedCache;
        else blockers.push({
          stage_id: 'chunk-index', code: runtimeCacheCode(verifiedCache, false),
          reason: 'The exact certified RAG cache payload is missing or invalid',
        });
      }
    }
    const gateDecisionId = 'gate-decision:' + crypto.randomUUID();
    const outcome = blockers.length ? 'BLOCKED' : 'PASSED';
    const gateEvidenceRef = persistEvidence('governance-gate', gateInput, outcome, Object.assign({
      gate_decision_id: gateDecisionId,
      outcome,
      blocker_count: blockers.length,
    }, artifactType === 'VECTOR_KB' ? {
      release_profile: releaseProfile,
      index_certification: indexCertification,
      index_cache_verification: indexCacheVerification,
      dataset_certification: datasetCertification,
    } : {}),
    { evidence_type: 'GATE_DECISION', producer: 'knowledge-builder-gate:v1', findings: blockers });
    const decision = Object.assign({
      gate_decision_id: gateDecisionId,
      artifact_type: artifactType,
      artifact_id: gateInput.artifact_id,
      artifact_version_id: gateInput.artifact_version_id,
      run_id: gateInput.run_id,
      project: gateInput.project,
      content_digest: gateInput.content_digest,
      outcome,
      blockers,
      evidence_refs: gateInput.evidence_refs.slice(),
      evidence_ref: gateEvidenceRef,
      policy_version: artifactType === 'VECTOR_KB'
        ? (releaseProfile === 'RAG_SERVICE' ? 'rag-service-release-gate:v1' : 'vector-index-release-gate:v1')
        : artifactType === 'KNOWLEDGE_GRAPH' ? 'graph-snapshot-release-gate:v1'
          : artifactType === 'AGENT_SKILL' ? 'skill-package-release-gate:v1' : 'wiki-release-gate:v1',
      decided_at: now(),
      ...(artifactType === 'AGENT_SKILL' ? { runtime_context: Object.assign({}, skillRuntimeContext(gateInput), { version_ref: gateInput.version_ref || null }) } : {}),
    }, artifactType === 'VECTOR_KB' ? {
      release_profile: releaseProfile,
      index_certification: indexCertification,
      index_cache_verification: indexCacheVerification,
      dataset_certification: datasetCertification,
    } : {});
    const filePath = resolveInside(gatesRoot, safeSegment(gateDecisionId, 'gate_decision_id') + '.json', 'GATE_PATH_INVALID');
    fs.writeFileSync(filePath, JSON.stringify(decision, null, 2), { encoding: 'utf8', flag: 'wx' });
    return decision;
  }

  async function createWikiRelease(input, artifactTypeOverride) {
    const artifactType = artifactTypeOverride || 'LLM_WIKI';
    const releaseInput = input || {};
    if (artifactType === 'LLM_WIKI') {
      if (!releaseInput.run_id || !releaseInput.review_decision_id) {
        fail('WIKI_RELEASE_REVIEW_REQUIRED', 'Wiki 发布必须绑定当前候选的最新通过决定', 409);
      }
      wikiReviewStore.assertLatestApproval({
        run_id: releaseInput.run_id,
        review_decision_id: releaseInput.review_decision_id,
        artifact_id: releaseInput.artifact_id,
        artifact_version_id: releaseInput.artifact_version_id,
        content_digest: releaseInput.content_digest,
      });
    }
    const releaseProfile = artifactType === 'VECTOR_KB' ? normalizeVectorReleaseProfile(releaseInput.release_profile) : null;
    if (!releaseInput.gate_decision_id) fail('RELEASE_GATE_REQUIRED', '发布必须绑定已通过的门禁决策');
    const gateDecision = getGateDecision(releaseInput.gate_decision_id);
    if (!gateDecision) fail('RELEASE_GATE_NOT_FOUND', '发布门禁决策不存在', 404);
    if (gateDecision.outcome !== 'PASSED') fail('RELEASE_GATE_NOT_PASSED', '发布门禁尚未通过', 409);
    if (artifactType === 'VECTOR_KB'
      && normalizeVectorReleaseProfile(gateDecision.release_profile) !== releaseProfile) {
      fail('RELEASE_PROFILE_MISMATCH', '发布交付形态与门禁决策不匹配', 409);
    }
    if (gateDecision.artifact_type !== artifactType
      || gateDecision.artifact_id !== releaseInput.artifact_id
      || gateDecision.artifact_version_id !== releaseInput.artifact_version_id
      || gateDecision.project !== releaseInput.project
      || gateDecision.content_digest !== releaseInput.content_digest) {
      fail('RELEASE_GATE_BINDING_MISMATCH', '发布门禁与候选版本不匹配', 409);
    }
    if (artifactType === 'AGENT_SKILL') {
      if (!gateDecision.runtime_context) fail('RELEASE_SKILL_CERTIFICATION_MISSING', '旧门禁缺少运行条件，请重新检查 Skill', 409);
      const context = gateDecision.runtime_context;
      const currentGate = await evaluateWikiGate(Object.assign({}, context, context.policy, releaseInput, {
        run_id: gateDecision.run_id, evidence_refs: gateDecision.evidence_refs,
      }), 'AGENT_SKILL');
      if (currentGate.outcome !== 'PASSED') fail('RELEASE_GATE_NOT_PASSED', 'Skill 当前证据未通过发布门禁，请重新检查', 409);
    }
    const graphSnapshot = artifactType === 'KNOWLEDGE_GRAPH' ? graphAsset(releaseInput) : null;
    const skillSnapshot = artifactType === 'AGENT_SKILL' ? skillAsset(releaseInput) : null;
    const root = graphSnapshot ? graphSnapshot.projectRoot : skillSnapshot ? skillSnapshot.root : projectPath(releaseInput.project);
    const currentDigest = graphSnapshot ? graphSnapshot.content_digest : skillSnapshot ? skillSnapshot.content_digest : summarizeProject(root).content_digest;
    if (currentDigest !== releaseInput.content_digest) fail('RELEASE_DIGEST_MISMATCH', '当前知识资产与候选版本摘要不一致', 409);
    let sourceCacheVerification = null;
    if (artifactType === 'VECTOR_KB') {
      sourceCacheVerification = await verifyVectorCache(releaseInput.project, gateDecision.index_certification, 'RELEASE_SOURCE');
      if (!sourceCacheVerification.valid) {
        fail(runtimeCacheCode(sourceCacheVerification, false), 'The exact certified RAG cache payload is unavailable for release', 409);
      }
    }
    const artifactSegment = safeSegment(releaseInput.artifact_id, 'artifact_id');
    const versionSegment = safeSegment(releaseInput.artifact_version_id, 'artifact_version_id');
    const versionRoot = resolveInside(releasesRoot, path.join(artifactSegment, versionSegment), 'RELEASE_PATH_INVALID');
    const manifestPath = path.join(versionRoot, 'release-manifest.json');
    if (fs.existsSync(manifestPath)) {
      let existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (existing.artifact_type !== artifactType
        || existing.artifact_id !== releaseInput.artifact_id
        || existing.artifact_version_id !== releaseInput.artifact_version_id) {
        fail('RELEASE_IMMUTABLE_CONFLICT', '不可变发布清单与请求的资产身份不匹配', 409);
      }
      if (existing.content_digest !== releaseInput.content_digest) fail('RELEASE_IMMUTABLE_CONFLICT', '不可变发布版本已存在且摘要不同', 409);
      if (artifactType === 'AGENT_SKILL' && !skillSnapshotMatches(path.join(versionRoot, 'snapshot'), skillSnapshot)) {
        fail('RELEASE_SNAPSHOT_DIGEST_MISMATCH', '已发布 Skill 快照与扫描摘要不一致', 409);
      }
      if (artifactType === 'VECTOR_KB') {
        const existingProfile = normalizeVectorReleaseProfile(existing.release_profile);
        if (existingProfile !== releaseProfile) fail('RELEASE_PROFILE_MISMATCH', '不可变发布已绑定其他交付形态', 409);
        if (JSON.stringify(existing.index_certification || null) !== JSON.stringify(gateDecision.index_certification || null)
          || JSON.stringify(existing.dataset_certification || null) !== JSON.stringify(gateDecision.dataset_certification || null)) {
          fail('RELEASE_CERTIFICATION_MISMATCH', '不可变发布认证身份与当前门禁不一致', 409);
        }
        const existingSnapshotVerification = await verifyVectorCache(releaseInput.project,
          gateDecision.index_certification, 'EXISTING_SNAPSHOT', path.join(versionRoot, 'snapshot'));
        if (!existingSnapshotVerification.valid) {
          fail(runtimeCacheCode(existingSnapshotVerification, true), 'The immutable release snapshot cache is unavailable or invalid', 409);
        }
        existing = Object.assign({}, existing, {
          release_profile: existingProfile,
          index_cache_verification: existingSnapshotVerification,
        });
      }
      writeAlias(releaseInput.alias, existing);
      releasesCache.clear();
      return existing;
    }
    ensureDir(versionRoot);
    const snapshotPath = path.join(versionRoot, 'snapshot');
    if (graphSnapshot) {
      ensureDir(snapshotPath);
      fs.copyFileSync(graphSnapshot.templatePath, path.join(snapshotPath, 'ontology-template.json'), fs.constants.COPYFILE_EXCL);
      fs.copyFileSync(graphSnapshot.graphPath, path.join(snapshotPath, 'graph-document.json'), fs.constants.COPYFILE_EXCL);
    } else if (skillSnapshot) {
      const approvedPaths = new Set(skillSnapshot.manifest.map(entry => entry.path));
      snapshotCopy(root, snapshotPath, { filter: sourcePath => {
        const relative = path.relative(root, sourcePath).split(path.sep).join('/');
        return !relative || approvedPaths.has(relative) || [...approvedPaths].some(file => file.startsWith(relative + '/'));
      } });
    } else snapshotCopy(root, snapshotPath);
    if (artifactType === 'AGENT_SKILL' && !skillSnapshotMatches(snapshotPath, skillSnapshot)) {
      fs.rmSync(versionRoot, { recursive: true, force: true });
      fail('RELEASE_SNAPSHOT_DIGEST_MISMATCH', '复制后的 Skill 快照与扫描摘要不一致', 409);
    }
    let snapshotCacheVerification = null;
    if (artifactType === 'VECTOR_KB') {
      snapshotCacheVerification = await verifyVectorCache(releaseInput.project,
        gateDecision.index_certification, 'SNAPSHOT', snapshotPath);
      if (!snapshotCacheVerification.valid) {
        fs.rmSync(versionRoot, { recursive: true, force: true });
        fail(runtimeCacheCode(snapshotCacheVerification, true), 'The copied immutable snapshot cache is unavailable or invalid', 409);
      }
    }
    const releasedAt = now();
    const releaseChannel = releaseInput.channel || 'STAGING';
    const releaseIdentity = [
      artifactType, releaseInput.artifact_id, releaseInput.artifact_version_id, releaseChannel,
      artifactType === 'VECTOR_KB' ? releaseProfile : null,
    ];
    const release = Object.assign({
      release_id: 'release:' + crypto.createHash('sha256').update(JSON.stringify(releaseIdentity)).digest('hex').slice(0, 20),
      artifact_type: artifactType,
      artifact_id: releaseInput.artifact_id,
      artifact_version_id: releaseInput.artifact_version_id,
      project: releaseInput.project,
      content_digest: releaseInput.content_digest,
      gate_decision_id: releaseInput.gate_decision_id,
      channel: releaseChannel,
      alias: releaseInput.alias,
      released_by: releaseInput.released_by || 'Knowledge Builder',
      released_at: releasedAt,
      snapshot_path: snapshotPath,
      manifest_version: artifactType === 'VECTOR_KB'
        ? (releaseProfile === 'RAG_SERVICE' ? 'knowledge-rag-service-release:v1' : 'knowledge-vector-index-release:v1')
        : artifactType === 'KNOWLEDGE_GRAPH' ? 'knowledge-graph-snapshot-release:v1'
          : artifactType === 'AGENT_SKILL' ? 'agent-skill-package-release:v1' : 'knowledge-wiki-release:v1',
    }, artifactType === 'LLM_WIKI' ? {
      run_id: releaseInput.run_id,
      review_decision_id: releaseInput.review_decision_id,
    } : artifactType === 'VECTOR_KB' ? {
      release_profile: releaseProfile,
      index_certification: gateDecision.index_certification,
      index_cache_verification: snapshotCacheVerification || sourceCacheVerification,
      dataset_certification: gateDecision.dataset_certification,
    } : {});
    release.evidence_ref = persistEvidence('publish', Object.assign({
      project: releaseInput.project, artifact_id: releaseInput.artifact_id, artifact_type: artifactType,
      artifact_version_id: releaseInput.artifact_version_id, content_digest: releaseInput.content_digest,
    }, artifactType === 'VECTOR_KB' ? { release_profile: releaseProfile } : {}), 'PASSED', Object.assign({
      release_id: release.release_id,
      artifact_version_id: release.artifact_version_id,
      content_digest: release.content_digest,
      channel: release.channel,
      alias: release.alias,
    }, artifactType === 'VECTOR_KB' ? {
      release_profile: releaseProfile,
      index_certification: release.index_certification,
      index_cache_verification: release.index_cache_verification,
      dataset_certification: release.dataset_certification,
    } : {}),
    { evidence_type: 'RELEASE_PROVENANCE', producer: 'knowledge-builder-release-manager:v1' });
    fs.writeFileSync(manifestPath, JSON.stringify(release, null, 2), { encoding: 'utf8', flag: 'wx' });
    writeAlias(releaseInput.alias, release);
    releasesCache.clear();
    if (artifactType === 'LLM_WIKI') registerHubWikiPublication(release);
    return release;
  }

  async function switchAlias(input) {
    const release = findRelease(input && input.release_id);
    if (!release) fail('RELEASE_NOT_FOUND', '发布版本不存在', 404);
    return writeAlias(input.alias, release);
  }

  async function switchWikiAlias(input) {
    const sourceInput = input || {};
    const release = findRelease(sourceInput.release_id);
    if (!release || release.artifact_type !== 'LLM_WIKI') fail('WIKI_RELEASE_NOT_FOUND', 'Wiki 发布版本不存在', 404);
    if (release.artifact_id !== sourceInput.artifact_id) {
      fail('WIKI_ALIAS_ARTIFACT_MISMATCH', 'Alias 只能切换到同一 Wiki 制品的历史版本', 409);
    }
    return writeAlias(sourceInput.alias, release);
  }

  async function switchSkillAlias(input) {
    const sourceInput = input || {};
    const release = findRelease(sourceInput.release_id);
    if (!release || release.artifact_type !== 'AGENT_SKILL') fail('SKILL_RELEASE_NOT_FOUND', 'Skill 发布版本不存在', 404);
    if (release.artifact_id !== sourceInput.artifact_id || release.project !== sourceInput.project) {
      fail('SKILL_ALIAS_ARTIFACT_MISMATCH', '只能回滚到同一个 Skill 的历史版本', 409);
    }
    const current = getAlias(sourceInput.alias);
    if (!current || current.artifact_id !== release.artifact_id || current.channel !== release.channel) {
      fail('SKILL_ALIAS_CHANNEL_MISMATCH', '目标别名必须属于同一 Skill 和发布通道', 409);
    }
    return writeAlias(sourceInput.alias, release);
  }

  function getCapabilities() {
    const ragServiceStatus = configuredRagGenerator(ragApiRoutes) ? 'AVAILABLE' : 'CONFIG_REQUIRED';
    return {
      service: 'knowledge-builder-runtime',
      version: 'v1',
      artifact_types: {
        LLM_WIKI: {
          status: 'AVAILABLE',
          provider: 'KNOWLEDGE_STUDIO',
          stages: Array.from(WIKI_STAGES),
          question_answering: { status: configuredWikiGenerator() ? 'CONFIGURED' : 'CONFIG_REQUIRED', mode: 'READ_ONLY_RETRIEVAL_GROUNDED_GENERATION' },
          evaluator: {
            status: 'CONFIGURED', provider: 'ONTOMIND',
            document_endpoint: '/api/v1/evaluation/wiki', answer_endpoint: '/api/v1/evaluation/rag',
            mode: 'VERSIONED_QUESTION_DATASET', metrics: ['SOURCE_RECALL_AT_5', 'SOURCE_MRR', 'SOURCE_PRECISION_AT_5', 'ANSWER_CORRECTNESS', 'ANSWER_RELEVANCY', 'GROUNDEDNESS', 'CITATION_COVERAGE'],
          },
          release: { status: 'AVAILABLE', mode: 'IMMUTABLE_SNAPSHOT_ALIAS', gate: 'RELEASE_ELIGIBLE_QUESTION_DATASET_REQUIRED' },
        },
        VECTOR_KB: {
          status: 'AVAILABLE', provider: 'AI_HARBOR_RAG', stages: Array.from(VECTOR_STAGES),
          embedding: { status: configuredEmbedding() ? 'CONFIGURED' : 'CONFIG_REQUIRED' },
          evaluator: { status: 'CONFIGURED', provider: 'ONTOMIND', endpoint: '/api/v1/evaluation/rag' },
          generation_evaluation: { status: ragServiceStatus },
          release_profiles: {
            VECTOR_INDEX: { status: 'AVAILABLE', gate: 'RETRIEVAL_EVALUATION_REQUIRED' },
            RAG_SERVICE: {
              status: ragServiceStatus,
              gate: 'RETRIEVAL_AND_GENERATION_EVALUATION_REQUIRED',
            },
          },
          release: { status: 'AVAILABLE', mode: 'IMMUTABLE_INDEX_SNAPSHOT_ALIAS', gate: 'RETRIEVAL_EVALUATION_REQUIRED' },
        },
        KNOWLEDGE_GRAPH: {
          status: 'AVAILABLE', provider: 'X6_GRAPH_BUILDER', stages: Array.from(GRAPH_STAGES),
          validator: { status: 'CONFIGURED', provider: 'X6_SCHEMA_CONSTRAINTS' },
          evaluator: { status: 'AVAILABLE', mode: 'VERSIONED_COMPETENCY_DATASET' },
          release: { status: 'AVAILABLE', mode: 'IMMUTABLE_GRAPH_SNAPSHOT_ALIAS' },
        },
        AGENT_SKILL: {
          status: 'PARTIAL', provider: 'PLATFORM_AGENT_RUNTIME', stages: Array.from(SKILL_STAGES),
          lint: { status: 'AVAILABLE' }, security: { status: 'AVAILABLE' },
          agent_execution: { status: 'AVAILABLE', provider: 'PLATFORM_AGENT_RUNTIME', default_adapter: 'HERMES' },
          isolation: { status: 'CONFIG_REQUIRED', reason: '当前 Hermes 适配器执行真实任务，但未提供进程或容器隔离' },
          trigger_evaluation: { status: 'AVAILABLE', requires: ['MODEL', 'VERSIONED_SKILL_DATASET'] },
          task_evaluation: { status: 'AVAILABLE', requires: ['MODEL', 'VERSIONED_SKILL_DATASET'] },
          release: { status: 'CONFIG_REQUIRED', reason: '生产发布仍需隔离运行证据' },
        },
      },
      evidence_store: 'FILE_JSON',
    };
  }

  return {
    getCapabilities,
    executeWikiStage,
    executeVectorStage,
    executeGraphStage,
    executeSkillStage,
    evaluateWikiGate,
    evaluateVectorGate: function (input) { return evaluateWikiGate(input, 'VECTOR_KB'); },
    evaluateGraphGate: function (input) { return evaluateWikiGate(input, 'KNOWLEDGE_GRAPH'); },
    evaluateSkillGate: function (input) { return evaluateWikiGate(input, 'AGENT_SKILL'); },
    createWikiRelease,
    listWikiReleases,
    listSkillReleases,
    listSkillAliases,
    createVectorRelease: function (input) { return createWikiRelease(input, 'VECTOR_KB'); },
    createGraphRelease: function (input) { return createWikiRelease(input, 'KNOWLEDGE_GRAPH'); },
    createSkillRelease: function (input) { return createWikiRelease(input, 'AGENT_SKILL'); },
    switchAlias,
    switchWikiAlias,
    switchSkillAlias,
    getAlias,
    getGateDecision,
    getEvidence,
    getRegistry,
    putRegistry,
    archiveRegistryArtifact,
  };
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function parseBody(req, maximumSize) {
  const limit = Number(maximumSize || 1024 * 1024);
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) reject(Object.assign(new Error('请求体过大'), { code: 'REQUEST_TOO_LARGE', statusCode: 413 }));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (error) { reject(Object.assign(new Error('JSON 请求体无效'), { code: 'REQUEST_JSON_INVALID', statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

const defaultRuntime = createKnowledgeBuilderRuntime();

function registryWorkspace(user) {
  const shared = user && user.__sharedDevelopmentAuth === true;
  return {
    workspace_id: shared ? 'shared-development' : String(user && user.workspaceId || 'user:' + String(user && user.userId || 'unknown')),
    shared_workspace: shared,
    mode: shared ? 'SHARED_DEVELOPMENT' : 'USER_PRIVATE',
  };
}

function registryResponse(user, registry) {
  return Object.assign({}, registry, { workspace: registryWorkspace(user) });
}

function handleKnowledgeBuilderRuntimeRequest(req, res) {
  let url;
  try { url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost')); }
  catch (error) { return false; }
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/knowledge-builder/')) return false;
  // wiki-api / inputs handler 负责的路径：libraries / runs / inputs
  // runtime 不拦截，否则 execute() 兜底 fail(404) 会吞掉这些请求
  if (pathname.startsWith('/api/knowledge-builder/wiki/libraries')) return false;
  if (pathname.startsWith('/api/knowledge-builder/wiki/runs')) return false;
  if (pathname.startsWith('/api/knowledge-builder/inputs/')) return false;
  if (!authenticate(req, res)) return true;
  const execute = async () => {
    const registryOwner = 'user:' + String(req.user && req.user.userId || 'unknown');
    if (req.method === 'GET' && pathname === '/api/knowledge-builder/registry') {
      return registryResponse(req.user, defaultRuntime.getRegistry(registryOwner));
    }
    if (req.method === 'PUT' && pathname === '/api/knowledge-builder/registry') {
      return registryResponse(req.user, defaultRuntime.putRegistry(registryOwner, await parseBody(req, 5 * 1024 * 1024)));
    }
    const archiveMatch = pathname.match(/^\/api\/knowledge-builder\/registry\/artifacts\/([^/]+)$/);
    if (req.method === 'DELETE' && archiveMatch) {
      let artifactId;
      try { artifactId = decodeURIComponent(archiveMatch[1]); }
      catch (_) { fail('REGISTRY_ARTIFACT_ID_INVALID', 'artifactId 必须是有效的制品标识'); }
      return registryResponse(req.user, defaultRuntime.archiveRegistryArtifact(
        registryOwner, artifactId, await parseBody(req, 1024 * 1024)
      ));
    }
    if (req.method === 'GET' && pathname === '/api/knowledge-builder/capabilities') return defaultRuntime.getCapabilities();
    if (req.method === 'GET' && pathname.startsWith('/api/knowledge-builder/evidence/')) {
      return defaultRuntime.getEvidence(decodeURIComponent(pathname.slice('/api/knowledge-builder/evidence/'.length)));
    }
    const stageMatch = pathname.match(/^\/api\/knowledge-builder\/wiki\/stages\/([^/]+)$/);
    if (req.method === 'POST' && stageMatch) return defaultRuntime.executeWikiStage(decodeURIComponent(stageMatch[1]), await parseBody(req));
    const vectorStageMatch = pathname.match(/^\/api\/knowledge-builder\/vector\/stages\/([^/]+)$/);
    if (req.method === 'POST' && vectorStageMatch) return defaultRuntime.executeVectorStage(decodeURIComponent(vectorStageMatch[1]), await parseBody(req));
    const graphStageMatch = pathname.match(/^\/api\/knowledge-builder\/graph\/stages\/([^/]+)$/);
    if (req.method === 'POST' && graphStageMatch) return defaultRuntime.executeGraphStage(decodeURIComponent(graphStageMatch[1]), await parseBody(req));
    const skillStageMatch = pathname.match(/^\/api\/knowledge-builder\/skill\/stages\/([^/]+)$/);
    if (req.method === 'POST' && skillStageMatch) return defaultRuntime.executeSkillStage(decodeURIComponent(skillStageMatch[1]), await parseBody(req));
    if (req.method === 'POST' && pathname === '/api/knowledge-builder/wiki/gates/evaluate') return defaultRuntime.evaluateWikiGate(await parseBody(req));
    if (req.method === 'POST' && pathname === '/api/knowledge-builder/vector/gates/evaluate') return defaultRuntime.evaluateVectorGate(await parseBody(req));
    if (req.method === 'POST' && pathname === '/api/knowledge-builder/graph/gates/evaluate') return defaultRuntime.evaluateGraphGate(await parseBody(req));
    if (req.method === 'POST' && pathname === '/api/knowledge-builder/skill/gates/evaluate') return defaultRuntime.evaluateSkillGate(await parseBody(req));
    if (req.method === 'GET' && pathname === '/api/knowledge-builder/wiki/releases') {
      return defaultRuntime.listWikiReleases({ project: url.searchParams.get('project') || '' });
    }
    if (req.method === 'POST' && pathname === '/api/knowledge-builder/wiki/releases') return defaultRuntime.createWikiRelease(await parseBody(req));
    if (req.method === 'POST' && pathname === '/api/knowledge-builder/vector/releases') return defaultRuntime.createVectorRelease(await parseBody(req));
    if (req.method === 'POST' && pathname === '/api/knowledge-builder/graph/releases') return defaultRuntime.createGraphRelease(await parseBody(req));
    if (req.method === 'POST' && pathname === '/api/knowledge-builder/skill/releases') return defaultRuntime.createSkillRelease(await parseBody(req));
    if (req.method === 'GET' && pathname === '/api/knowledge-builder/skill/releases') {
      return defaultRuntime.listSkillReleases({ project: url.searchParams.get('project') || '' });
    }
    if (req.method === 'GET' && pathname === '/api/knowledge-builder/skill/aliases') {
      return defaultRuntime.listSkillAliases({ project: url.searchParams.get('project') || '' });
    }
    if (req.method === 'POST' && pathname === '/api/knowledge-builder/skill/aliases/switch') return defaultRuntime.switchSkillAlias(await parseBody(req));
    if (req.method === 'POST' && pathname === '/api/knowledge-builder/aliases/switch') return defaultRuntime.switchAlias(await parseBody(req));
    if (req.method === 'POST' && pathname === '/api/knowledge-builder/wiki/aliases/switch') return defaultRuntime.switchWikiAlias(await parseBody(req));
    fail('KNOWLEDGE_BUILDER_ROUTE_NOT_FOUND', 'Knowledge Builder Runtime 路由不存在', 404);
  };
  execute().then((value) => sendJson(res, 200, { success: true, data: value })).catch((error) => {
    sendJson(res, error.statusCode || 500, { success: false, error: { code: error.code || 'KNOWLEDGE_BUILDER_RUNTIME_ERROR', message: error.message } });
  });
  return true;
}

module.exports = { createKnowledgeBuilderRuntime, handleKnowledgeBuilderRuntimeRequest, summarizeProject, scanSecurity };
