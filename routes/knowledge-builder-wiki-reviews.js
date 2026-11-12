'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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

function safeId(value, prefix, code) {
  const raw = String(value || '');
  const segment = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  if (!segment || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(segment)) {
    fail(code, 'Wiki 审阅标识无效', 400);
  }
  return segment;
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return null; }
}

function writeJsonExclusive(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
}

function createWikiReviewStore(options) {
  const opts = options || {};
  const workspaceRoot = path.resolve(opts.workspaceRoot || path.join(__dirname, '..'));
  const dataRoot = path.resolve(opts.dataRoot || path.join(workspaceRoot, 'data', 'knowledge-builder'));
  const reviewRoot = ensureDir(path.join(dataRoot, 'wiki-reviews'));
  const now = typeof opts.now === 'function' ? opts.now : () => new Date().toISOString();

  function runDirectory(runId) {
    return path.join(reviewRoot, safeId(runId, 'wiki-build-run:', 'WIKI_REVIEW_RUN_ID_INVALID'));
  }

  function listDecisions(runId) {
    const directory = runDirectory(runId);
    const reviews = fs.existsSync(directory)
      ? fs.readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => readJson(path.join(directory, name)))
        .filter(Boolean)
        .sort((left, right) => String(left.decided_at).localeCompare(String(right.decided_at))
          || Number(left.review_sequence || 0) - Number(right.review_sequence || 0)
          || String(left.review_decision_id).localeCompare(String(right.review_decision_id)))
      : [];
    return {
      reviews: JSON.parse(JSON.stringify(reviews)),
      total: reviews.length,
      latest: reviews.length ? JSON.parse(JSON.stringify(reviews[reviews.length - 1])) : null,
    };
  }

  function createDecision(run, input, reviewer) {
    if (!run || !run.candidate_revision) {
      fail('WIKI_REVIEW_CANDIDATE_REQUIRED', '构建尚未生成候选快照，不能提交审阅', 409);
    }
    const decision = String(input && input.decision || '').trim().toUpperCase();
    if (!['APPROVED', 'CHANGES_REQUESTED'].includes(decision)) {
      fail('WIKI_REVIEW_DECISION_INVALID', '审阅决定必须是 APPROVED 或 CHANGES_REQUESTED', 400);
    }
    if (decision === 'APPROVED' && run.status !== 'READY_FOR_REVIEW') {
      fail('WIKI_REVIEW_APPROVAL_INVALID', '只有 READY_FOR_REVIEW 的候选才能通过审阅', 409);
    }
    const comment = String(input && input.comment || '').trim();
    if (comment.length > 2000) fail('WIKI_REVIEW_COMMENT_TOO_LONG', '审阅意见不能超过 2000 个字符', 400);
    const reviewId = 'wiki-review:' + crypto.randomUUID();
    const reviewSequence = listDecisions(run.run_id).total + 1;
    const record = {
      review_decision_id: reviewId,
      review_sequence: reviewSequence,
      run_id: run.run_id,
      project: run.project,
      artifact_id: run.artifact_id,
      artifact_version_id: run.artifact_version_id,
      revision_id: run.candidate_revision.revision_id,
      content_digest: run.candidate_revision.content_digest,
      decision,
      comment,
      reviewer: String(reviewer || 'local-user').slice(0, 160),
      decided_at: now(),
    };
    const filename = safeId(reviewId, 'wiki-review:', 'WIKI_REVIEW_DECISION_ID_INVALID') + '.json';
    writeJsonExclusive(path.join(runDirectory(run.run_id), filename), record);
    return JSON.parse(JSON.stringify(record));
  }

  function assertLatestApproval(input) {
    const source = input || {};
    const history = listDecisions(source.run_id);
    if (!history.latest) fail('WIKI_RELEASE_REVIEW_REQUIRED', '发布前必须完成候选审阅', 409);
    if (history.latest.review_decision_id !== source.review_decision_id) {
      fail('WIKI_RELEASE_REVIEW_STALE', '审阅决定已经过期，请根据最新决定重新发布', 409);
    }
    if (history.latest.decision !== 'APPROVED') {
      fail('WIKI_RELEASE_REVIEW_NOT_APPROVED', '最新审阅决定不是通过，不能发布', 409);
    }
    for (const field of ['run_id', 'artifact_id', 'artifact_version_id', 'content_digest']) {
      if (history.latest[field] !== source[field]) {
        fail('WIKI_RELEASE_REVIEW_BINDING_MISMATCH', '审阅决定与当前候选版本不匹配', 409);
      }
    }
    return history.latest;
  }

  return { createDecision, listDecisions, assertLatestApproval };
}

module.exports = { createWikiReviewStore };
