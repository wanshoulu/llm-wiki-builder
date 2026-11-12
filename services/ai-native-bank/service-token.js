'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

class ServiceTokenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ServiceTokenError';
    this.code = code;
    this.isOperational = true;
  }
}

function fail(code, message) {
  throw new ServiceTokenError(code, message);
}

function validateToken(value) {
  const token = String(value || '').trim();
  if (token.length < 16 || token.length > 512 || /\s/.test(token)) {
    fail('service_token_invalid', '内部服务身份配置无效');
  }
  return token;
}

function loadServiceToken(options) {
  const source = options || {};
  const direct = String(source.envValue || '').trim();
  if (direct) return validateToken(direct);
  const tokenFile = String(source.tokenFile || '').trim();
  if (!tokenFile) return '';
  const fsImpl = source.fsImpl || fs;
  let stat;
  let value;
  try {
    stat = fsImpl.statSync(tokenFile);
    if (!stat.isFile() || stat.size < 16 || stat.size > 513) {
      fail('service_token_invalid', '内部服务身份配置无效');
    }
    if ((stat.mode & 0o077) !== 0) {
      fail('service_token_permissions_invalid', '内部服务身份文件权限不安全');
    }
    value = fsImpl.readFileSync(tokenFile, 'utf8');
  } catch (error) {
    if (error instanceof ServiceTokenError) throw error;
    fail('service_token_unavailable', '内部服务身份不可用');
  }
  return validateToken(value);
}

function verifyBearer(value, token) {
  const expected = token ? 'Bearer ' + token : '';
  const left = Buffer.from(String(value || ''));
  const right = Buffer.from(expected);
  return Boolean(token) && left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = { ServiceTokenError, loadServiceToken, verifyBearer };

