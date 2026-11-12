'use strict';

const DEFAULT_THRESHOLDS = Object.freeze({
  source_recall_at_5: 0.9,
  source_mrr: 0.8,
  source_precision_at_5: 0.6,
  answer_correctness: 0.8,
  answer_relevancy: 0.8,
  groundedness: 0.85,
  citation_coverage: 0.9,
});

function round4(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function normalizeReference(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function uniqueReferences(items, limit) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const reference = normalizeReference(typeof item === 'string' ? item : (item && (item.id || item.path || item.ref)));
    if (!reference || seen.has(reference)) continue;
    seen.add(reference);
    result.push(reference);
    if (result.length >= limit) break;
  }
  return result;
}

function computeSourceMetrics(retrievedSources, expectedSourceRefs) {
  const retrieved = uniqueReferences(retrievedSources, 5);
  const expected = uniqueReferences(expectedSourceRefs, 50);
  if (!expected.length) {
    return { source_recall_at_5: 1, source_mrr: 1, source_precision_at_5: 1 };
  }
  if (!retrieved.length) {
    return { source_recall_at_5: 0, source_mrr: 0, source_precision_at_5: 0 };
  }
  const expectedSet = new Set(expected);
  const matches = retrieved.filter((reference) => expectedSet.has(reference));
  const firstRank = retrieved.findIndex((reference) => expectedSet.has(reference));
  return {
    source_recall_at_5: round4(matches.length / expected.length),
    source_mrr: firstRank < 0 ? 0 : round4(1 / (firstRank + 1)),
    source_precision_at_5: round4(matches.length / retrieved.length),
  };
}

function computeCitationCoverage(answer, sources) {
  const text = String(answer || '').trim();
  if (!text) return 0;
  const validRanks = new Set((Array.isArray(sources) ? sources : []).map((source, index) => {
    const explicit = Number(source && source.rank);
    return Number.isInteger(explicit) && explicit > 0 ? explicit : index + 1;
  }));
  const sentences = text.match(/[^.!?。！？]+(?:[.!?。！？]+|$)/g) || [];
  const substantive = sentences.filter((sentence) => sentence.replace(/\[\d+\]/g, '').trim().length >= 3);
  if (!substantive.length) return 0;
  const covered = substantive.filter((sentence) => {
    const citations = Array.from(sentence.matchAll(/\[(\d+)\]/g), (match) => Number(match[1]));
    return citations.some((rank) => validRanks.has(rank));
  }).length;
  return round4(covered / substantive.length);
}

function validateJudge(judge) {
  const result = {};
  for (const key of ['answer_correctness', 'answer_relevancy', 'groundedness']) {
    const value = Number(judge && judge[key]);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      const error = new Error(`Invalid Wiki evaluator metric: ${key}`);
      error.code = 'WIKI_QA_EVALUATOR_CONTRACT_INVALID';
      throw error;
    }
    result[key] = round4(value);
  }
  return result;
}

function publicSources(sources) {
  return (Array.isArray(sources) ? sources : []).slice(0, 5).map((source, index) => ({
    id: normalizeReference(source && (source.id || source.path || source.ref)),
    title: String(source && source.title || '').slice(0, 300),
    rank: Number.isInteger(Number(source && source.rank)) ? Number(source.rank) : index + 1,
    score: Number.isFinite(Number(source && source.score)) ? round4(Number(source.score)) : null,
  }));
}

function evaluateCaseResult(input, thresholds) {
  const source = input && typeof input === 'object' ? input : {};
  const qa = source.qa && typeof source.qa === 'object' ? source.qa : {};
  const sources = publicSources(qa.sources);
  const sourceMetrics = computeSourceMetrics(sources, source.expected_source_refs);
  const base = {
    case_id: String(source.case_id || ''),
    question: String(source.question || ''),
    expected_source_refs: uniqueReferences(source.expected_source_refs, 50),
    generation_mode: String(qa.generation_mode || 'FAILED'),
    answer: typeof qa.answer === 'string' ? qa.answer : null,
    sources,
    retrieved_sources: sources,
    ...sourceMetrics,
    answer_correctness: null,
    answer_relevancy: null,
    groundedness: null,
    citation_coverage: null,
    passed: null,
    error: qa.error ? JSON.parse(JSON.stringify(qa.error)) : null,
  };
  if (base.generation_mode !== 'GENERATED') return base;

  if (!source.judge) return {
    ...base,
    citation_coverage: computeCitationCoverage(base.answer, sources),
  };

  const judge = validateJudge(source.judge);
  const citationCoverage = computeCitationCoverage(base.answer, sources);
  const effective = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const scores = { ...sourceMetrics, ...judge, citation_coverage: citationCoverage };
  return {
    ...base,
    ...judge,
    citation_coverage: citationCoverage,
    passed: Object.entries(effective).every(([key, threshold]) => Number(scores[key]) >= Number(threshold)),
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  computeSourceMetrics,
  computeCitationCoverage,
  evaluateCaseResult,
};
