import { createSession, deleteSession, requireSession, unauthorized } from './auth.js';
import { beginAuthorization, finishAuthorization } from './kling-oauth.js';
import { getKlingStatus } from './kling-mcp.js';
import { submitTask } from './tasks.js';
import { siteAssets } from './site-assets.js';
import { ensureSchema } from './db.js';
import { createProject, listProjects, readProjectWorkspace, renameProject } from './projects.js';

const securityHeaders = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()', 'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self' https:; style-src 'self'; script-src 'self'; connect-src 'self' https://klingai.com" };

function withSecurity(response) {
  const result = new Response(response.body, response);
  for (const [key, value] of Object.entries(securityHeaders)) result.headers.set(key, value);
  return result;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

function projectInputError(error) {
  return error instanceof SyntaxError || ['项目名称不能为空', '项目名称不能超过60个字符'].includes(error?.message);
}

function decodeProjectId(value) {
  try { return decodeURIComponent(value); }
  catch { return null; }
}

function siteAsset(pathname) {
  const key = pathname === '/' ? '/index.html' : pathname;
  const asset = siteAssets.get(key);
  if (!asset) return null;
  const body = asset.base64 ? Uint8Array.from(atob(asset.body), (char) => char.charCodeAt(0)) : asset.body;
  return new Response(body, { headers: { 'content-type': asset.type, 'cache-control': key === '/index.html' ? 'no-cache' : 'public, max-age=31536000, immutable' } });
}

async function upload(request, env) {
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File) || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 15 * 1024 * 1024) return json({ error: '请上传 15MB 以内的 JPG、PNG 或 WebP 图片' }, 400);
  const projectId = String(form.get('projectId') || '').trim();
  if (!projectId) return json({ error: '请选择项目' }, 400);
  const project = await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
  if (!project) return json({ error: '请选有效项目' }, 400);
  const id = crypto.randomUUID();
  const key = `references/${id}`;
  const createdAt = Date.now();
  await env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  const statements = [
    env.DB.prepare('INSERT INTO stored_objects (id, object_key, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, key, file.type, file.size, createdAt),
    env.DB.prepare('INSERT INTO project_assets (project_id, object_id, created_at) VALUES (?, ?, ?)').bind(projectId, id, createdAt),
  ];
  if (typeof env.DB.batch === 'function') await env.DB.batch(statements);
  else for (const statement of statements) await statement.run();
  return json({ uploadId: id });
}

async function api(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/api/health') return json({ ok: true });
  if (url.pathname === '/api/session' && request.method === 'POST') return createSession(await request.json(), env);
  const session = await requireSession(request, env);
  if (!session && url.pathname !== '/api/kling/oauth/callback') return unauthorized();
  if (url.pathname === '/api/session' && request.method === 'GET') return json({ authenticated: true });
  if (url.pathname === '/api/session' && request.method === 'DELETE') return deleteSession(request, env);
  if (url.pathname === '/api/projects' && request.method === 'GET') return json({ projects: await listProjects(env.DB) });
  if (url.pathname === '/api/projects' && request.method === 'POST') {
    try { return json(await createProject(env.DB, await request.json()), 201); }
    catch (error) {
      if (projectInputError(error)) return json({ error: error instanceof SyntaxError ? '请提供有效的 JSON' : error.message }, 400);
      throw error;
    }
  }
  const workspaceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/workspace$/);
  if (workspaceMatch && request.method === 'GET') {
    const projectId = decodeProjectId(workspaceMatch[1]);
    if (projectId === null) return json({ error: '项目 ID 格式无效' }, 400);
    try { return json(await readProjectWorkspace(env.DB, projectId)); }
    catch (error) {
      if (error.message === '项目不存在') return json({ error: error.message }, 404);
      throw error;
    }
  }
  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && request.method === 'PATCH') {
    const projectId = decodeProjectId(projectMatch[1]);
    if (projectId === null) return json({ error: '项目 ID 格式无效' }, 400);
    try { return json(await renameProject(env.DB, projectId, await request.json())); }
    catch (error) {
      if (error.message === '项目不存在') return json({ error: error.message }, 404);
      if (projectInputError(error)) return json({ error: error instanceof SyntaxError ? '请提供有效的 JSON' : error.message }, 400);
      throw error;
    }
  }
  if (url.pathname === '/api/kling/status' && request.method === 'GET') return json(await getKlingStatus(env));
  if (url.pathname === '/api/kling/oauth/start' && request.method === 'GET') return Response.redirect((await beginAuthorization(request, env)).url.toString(), 302);
  if (url.pathname === '/api/kling/oauth/callback' && request.method === 'GET') { try { await finishAuthorization(request, env); return Response.redirect(`${url.origin}/?authorized=1`, 302); } catch (error) { return Response.redirect(`${url.origin}/?oauth_error=1`, 302); } }
  if (url.pathname === '/api/uploads' && request.method === 'POST') return upload(request, env);
  if (url.pathname === '/api/video/tasks' && request.method === 'POST') {
    let input;
    try { input = await request.json(); }
    catch { return json({ error: '请提供有效的 JSON' }, 400); }
    const projectId = String(input?.projectId || '').trim();
    if (!projectId) return json({ error: '请选择项目' }, 400);
    if (!await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first()) return json({ error: '请选有效项目' }, 400);
    const status = await getKlingStatus(env);
    if (status.connection !== 'online') return json({ error: '请先连接可灵 MCP' }, 409);
    try { return json(await submitTask(input, env, request.headers.get('idempotency-key') || crypto.randomUUID(), status.models)); } catch (error) { return json({ error: error.message }, 400); }
  }
  return json({ error: '接口不存在' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) await ensureSchema(env.DB);
    const response = url.pathname.startsWith('/api/') ? await api(request, env, ctx) : siteAsset(url.pathname) || (env.ASSETS ? await env.ASSETS.fetch(request) : new Response('Not found', { status: 404 }));
    return withSecurity(response);
  },
};
