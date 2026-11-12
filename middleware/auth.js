'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-do-not-use-in-production';
if (!process.env.JWT_SECRET && process.env.DEV_MODE !== 'true' && process.env.NODE_ENV !== 'development') {
  console.log('[DEV] JWT_SECRET 未设置，使用开发模式默认密钥');
}
// In production, refuse to start with the dev secret
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('[ERROR] 生产模式下必须设置 JWT_SECRET 环境变量');
  process.exit(1);
}
const JWT_EXPIRES = '7d';

function generateToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username, role: user.role || 'user' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Middleware: extract user from Authorization header.
 * On success, sets req.user = { userId, username, role } and returns true.
 * On failure, sends 401 and returns false.
 */
function authenticate(req, res) {
  // 全局跳过认证
  if (process.env.SKIP_AUTH === 'true' || process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development') {
    req.user = {
      userId: 1, username: 'dev', role: 'admin',
      workspaceId: 'shared-development', workspaceMode: 'SHARED_DEVELOPMENT',
    };
    Object.defineProperty(req.user, '__sharedDevelopmentAuth', { value: true, enumerable: false });
    return true;
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    sendJson(res, 401, { error: '请先登录', code: 'AUTH_REQUIRED' });
    return false;
  }
  try {
    const verified = verifyToken(token);
    req.user = { userId: verified.userId, username: verified.username, role: verified.role };
    return true;
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      sendJson(res, 401, { error: '登录已过期，请重新登录', code: 'TOKEN_EXPIRED' });
    } else {
      sendJson(res, 401, { error: '无效的登录凭证', code: 'INVALID_TOKEN' });
    }
    return false;
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' });
  res.end(body);
}

module.exports = { generateToken, verifyToken, authenticate };
