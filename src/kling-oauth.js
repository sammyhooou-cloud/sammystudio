import { randomToken, pkceChallenge, encryptJson, decryptJson } from './crypto.js';

const AUTH_ISSUER = 'https://klingai.com/auth';
const SCOPES = 'generation.create generation.read account.credit.read';

async function metadata(fetcher = fetch) {
  const response = await fetcher(`${AUTH_ISSUER}/.well-known/oauth-authorization-server`);
  if (!response.ok) throw new Error('无法读取可灵授权配置');
  return response.json();
}

export async function beginAuthorization(request, env, fetcher = fetch) {
  const meta = await metadata(fetcher);
  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/kling/oauth/callback`;
  let client = await env.DB.prepare('SELECT client_id FROM oauth_clients LIMIT 1').first();
  if (!client) {
    const response = await fetcher(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Keling Video Workspace', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    if (!response.ok) throw new Error('无法注册可灵 OAuth 客户端');
    client = await response.json();
    await env.DB.prepare('INSERT INTO oauth_clients (client_id, created_at) VALUES (?, ?)').bind(client.client_id, Date.now()).run();
  }
  const state = randomToken();
  const verifier = randomToken(48);
  await env.DB.prepare('INSERT INTO oauth_states (state, verifier, redirect_uri, expires_at) VALUES (?, ?, ?, ?)').bind(state, verifier, redirectUri, Date.now() + 600000).run();
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, scope: SCOPES, state, code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', resource: 'https://klingai.com/mcp' }).toString();
  return { url, state };
}

export async function finishAuthorization(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const saved = state && await env.DB.prepare('SELECT * FROM oauth_states WHERE state = ?').bind(state).first();
  if (!saved || Number(saved.expires_at) <= Date.now() || !code) throw new Error('授权状态无效或已过期');
  await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
  const client = await env.DB.prepare('SELECT client_id FROM oauth_clients LIMIT 1').first();
  const meta = await metadata(fetcher);
  const response = await fetcher(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: saved.redirect_uri, code_verifier: saved.verifier, resource: 'https://klingai.com/mcp' }) });
  if (!response.ok) throw new Error('可灵令牌交换失败');
  const token = await response.json();
  await saveTokens(env, token);
}

async function saveTokens(env, token) {
  const encrypted = await encryptJson(token, env.TOKEN_ENCRYPTION_KEY);
  const expiresAt = Date.now() + Math.max(30, Number(token.expires_in || 3600) - 60) * 1000;
  await env.DB.prepare('DELETE FROM oauth_tokens').run();
  await env.DB.prepare('INSERT INTO oauth_tokens (encrypted_token, expires_at, updated_at) VALUES (?, ?, ?)').bind(encrypted, expiresAt, Date.now()).run();
}

export async function accessToken(env, fetcher = fetch) {
  const record = await env.DB.prepare('SELECT * FROM oauth_tokens LIMIT 1').first();
  if (!record) return null;
  const token = await decryptJson(record.encrypted_token, env.TOKEN_ENCRYPTION_KEY);
  if (Number(record.expires_at) > Date.now()) return token.access_token;
  if (!token.refresh_token) return null;
  const client = await env.DB.prepare('SELECT client_id FROM oauth_clients LIMIT 1').first();
  const meta = await metadata(fetcher);
  const response = await fetcher(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: client.client_id, scope: SCOPES, resource: 'https://klingai.com/mcp' }) });
  if (!response.ok) return null;
  const refreshed = await response.json();
  if (!refreshed.refresh_token) refreshed.refresh_token = token.refresh_token;
  await saveTokens(env, refreshed);
  return refreshed.access_token;
}
