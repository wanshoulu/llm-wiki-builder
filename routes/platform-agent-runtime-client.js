'use strict';

function runtimeError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode || 500;
  return error;
}

function createPlatformAgentRuntimeClient(options) {
  const source = options || {};
  const fetchImpl = source.fetchImpl || globalThis.fetch;
  const baseUrl = String(source.baseUrl || process.env.AGENT_SERVICE_URL
    || process.env.ONTOMIND_AGENT_URL || 'http://ontomind-agent:8000').replace(/\/+$/, '');
  const timeoutMs = Number(source.timeoutMs || 180000);
  if (typeof fetchImpl !== 'function') throw runtimeError('AGENT_RUNTIME_UNAVAILABLE', '平台 Agent Runtime 客户端不可用');

  async function runSkillTests(input) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(baseUrl + '/agent/runtime/skill-tests:run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input || {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw runtimeError('AGENT_RUNTIME_TIMEOUT', '平台智能体测试超时，请减少用例或调大运行时限', 504);
      }
      throw runtimeError('AGENT_RUNTIME_UNAVAILABLE', '平台智能体运行服务不可用，请检查服务状态', 503);
    } finally {
      clearTimeout(timer);
    }

    let body;
    try { body = await response.json(); }
    catch (_) { throw runtimeError('AGENT_RUNTIME_RESPONSE_INVALID', '平台智能体返回了无法识别的结果', 502); }
    if (!response.ok) {
      const detail = body && body.detail;
      const message = typeof detail === 'string' ? detail
        : detail && detail.message ? detail.message : '平台智能体测试请求失败';
      const code = response.status === 400 || response.status === 422
        ? 'AGENT_RUNTIME_REQUEST_INVALID' : 'AGENT_RUNTIME_EXECUTION_FAILED';
      throw runtimeError(code, String(message).slice(0, 500), response.status);
    }
    if (!body || typeof body !== 'object' || typeof body.runtime_provider !== 'string'
      || typeof body.runtime_version !== 'string' || !Array.isArray(body.results)) {
      throw runtimeError('AGENT_RUNTIME_RESPONSE_INVALID', '平台智能体返回结果缺少必要字段', 502);
    }
    return body;
  }

  return { runSkillTests };
}

module.exports = { createPlatformAgentRuntimeClient };
