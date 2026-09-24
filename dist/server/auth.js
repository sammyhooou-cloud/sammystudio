import { randomToken, sha256, base64url, verifyPassword } from './crypto.js';

const COOKIE = 'keling_session';

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

export async function createSession(body, env) {
  const validUser = body.username === env.ADMIN_USERNAME;
  const validPassword = await verifyPassword(body.password || '', env.ADMIN_PASSWORD_HASH);
  if (!validUser || !validPassword) return json({ error: '用户名或密码错误' }, 401);
  const token = randomToken();
  const tokenHash = base64url(await sha256(token));
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  await env.DB.prepare('INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)').bind(tokenHash, expiresAt).run();
  return json({ authenticated: true }, 200, { 'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800` });
}

function cookieValue(request, name) {
  const cookies = request.headers.get('cookie') || '';
  const item = cookies.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item?.slice(name.length + 1) || '';
}

export async function requireSession(request, env) {
  const token = cookieValue(request, COOKIE);
  if (!token) return null;
  const tokenHash = base64url(await sha256(token));
  const record = await env.DB.prepare('SELECT token_hash, expires_at FROM admin_sessions WHERE token_hash = ?').bind(tokenHash).first();
  if (!record || Number(record.expires_at) <= Date.now()) return null;
  return record;
}

export async function deleteSession(request, env) {
  const token = cookieValue(request, COOKIE);
  if (token) await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(base64url(await sha256(token))).run();
  return json({ authenticated: false }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
}

export const unauthorized = () => json({ error: '请先登录' }, 401);
