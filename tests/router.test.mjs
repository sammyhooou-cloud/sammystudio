import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { siteAssets } from '../src/site-assets.js';
import { TaskError } from '../src/tasks.js';

function env() {
  return {
    ASSETS: { fetch: async () => new Response('asset') },
    DB: { prepare: () => ({ run: async () => ({ success: true }) }) },
  };
}

class RouteDb {
  constructor() {
    this.projects = [{ id: 'project-1', name: '项目一', created_at: 1, updated_at: 1 }];
    this.migrationMarkers = [];
  }

  prepare(sql) {
    const db = this;
    const statement = {
      values: [],
      bind(...values) { return { ...statement, values }; },
      async first() {
        if (sql.includes('FROM admin_sessions')) return { token_hash: 'valid', expires_at: Date.now() + 60_000 };
        if (sql.includes('FROM migration_markers')) return db.migrationMarkers.includes(this.values[0]) ? { name: this.values[0] } : null;
        if (sql.includes('FROM project_settings')) return null;
        if (sql.includes('FROM projects') && sql.includes('WHERE id = ?')) return db.projects.find(({ id }) => id === this.values[0]) ?? null;
        if (sql.includes('FROM projects')) return db.projects[0] ?? null;
        throw new Error(`Unexpected first query: ${sql}`);
      },
      async all() {
        if (sql.includes('FROM projects')) return { results: [...db.projects].sort((a, b) => b.updated_at - a.updated_at) };
        if (sql.includes('FROM project_assets') || sql.includes('FROM project_tasks')) return { results: [] };
        throw new Error(`Unexpected all query: ${sql}`);
      },
      async run() {
        const values = this.values;
        if (sql.startsWith('INSERT OR IGNORE INTO migration_markers')) { db.migrationMarkers.push(values[0]); return { success: true }; }
        if (sql.startsWith('INSERT OR IGNORE INTO projects')) { if (!db.projects.some(({ id }) => id === values[0])) db.projects.push({ id: values[0], name: values[1], created_at: values[2], updated_at: values[3] }); return { success: true }; }
        if (sql.startsWith('INSERT INTO projects')) {
          db.projects.push({ id: values[0], name: values[1], created_at: values[2], updated_at: values[3] });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE projects')) {
          const project = db.projects.find(({ id }) => id === values[2]);
          if (!project) return { success: true, meta: { changes: 0 } };
          if (sql.startsWith('UPDATE projects SET video_provider')) project.video_provider = values[0];
          else project.name = values[0];
          project.updated_at = values[1];
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true };
      },
    };
    return statement;
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

const sessionHeaders = { cookie: 'keling_session=test-token', origin: 'https://site.test', 'content-type': 'application/json' };

function seedDocumentAssets(t) {
  for (const page of ['login', 'workspace', 'result']) {
    const key = `/${page}.html`;
    const previous = siteAssets.get(key);
    siteAssets.set(key, { body: `<html>${page} page</html>`, type: 'text/html; charset=utf-8' });
    t.after(() => previous ? siteAssets.set(key, previous) : siteAssets.delete(key));
  }
}

function pageDb() {
  return {
    prepare(sql) {
      assert.match(sql, /^SELECT token_hash, expires_at FROM admin_sessions/);
      return { bind() { return { async first() { return { token_hash: 'valid', expires_at: Date.now() + 60_000 }; } }; } };
    },
  };
}

test('root document navigation redirects according to authentication', async () => {
  for (const method of ['GET', 'HEAD']) {
    for (const authenticated of [false, true]) {
      const response = await worker.fetch(new Request('https://site.test/', { method, headers: authenticated ? sessionHeaders : undefined }), { DB: pageDb() }, {});
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), `https://site.test/${authenticated ? 'workspace' : 'login'}`);
    }
  }
});

test('login document serves anonymous visitors and redirects authenticated visitors', async (t) => {
  seedDocumentAssets(t);
  for (const method of ['GET', 'HEAD']) {
    const anonymous = await worker.fetch(new Request('https://site.test/login', { method }), { DB: pageDb() }, {});
    assert.equal(anonymous.status, 200);
    assert.match(anonymous.headers.get('content-type'), /^text\/html/);
    if (method === 'GET') assert.equal(await anonymous.text(), '<html>login page</html>');
    const authenticated = await worker.fetch(new Request('https://site.test/login', { method, headers: sessionHeaders }), { DB: pageDb() }, {});
    assert.equal(authenticated.status, 302);
    assert.equal(authenticated.headers.get('location'), 'https://site.test/workspace');
  }
});

test('workspace and result documents require authentication without schema initialization', async (t) => {
  seedDocumentAssets(t);
  for (const [pathname, page] of [['/workspace', 'workspace'], ['/projects/project-1/results/task-1', 'result']]) {
    for (const method of ['GET', 'HEAD']) {
      const anonymous = await worker.fetch(new Request(`https://site.test${pathname}`, { method }), { DB: pageDb() }, {});
      assert.equal(anonymous.status, 302, `${method} ${pathname}`);
      assert.equal(anonymous.headers.get('location'), 'https://site.test/login');
      const authenticated = await worker.fetch(new Request(`https://site.test${pathname}`, { method, headers: sessionHeaders }), { DB: pageDb() }, {});
      assert.equal(authenticated.status, 200, `${method} ${pathname}`);
      assert.match(authenticated.headers.get('content-type'), /^text\/html/);
      if (method === 'GET') assert.equal(await authenticated.text(), `<html>${page} page</html>`);
    }
  }
});

test('static assets, unmatched paths, and unrelated POSTs preserve asset fallback', async (t) => {
  const key = '/styles.css';
  const previous = siteAssets.get(key);
  siteAssets.set(key, { body: 'body { color: red; }', type: 'text/css' });
  t.after(() => previous ? siteAssets.set(key, previous) : siteAssets.delete(key));
  const runtime = { DB: { prepare() { throw new Error('Assets must not query sessions or initialize schema'); } }, ASSETS: { fetch: async () => new Response('fallback asset') } };
  const css = await worker.fetch(new Request('https://site.test/styles.css'), runtime, {});
  assert.equal(await css.text(), 'body { color: red; }');
  for (const pathname of ['/app.js', '/image.png', '/missing', '/projects//results/task-1', '/projects/project-1/results/', '/projects/project-1/results/task-1/extra']) {
    const response = await worker.fetch(new Request(`https://site.test${pathname}`), runtime, {});
    assert.equal(response.status, 200, pathname);
    assert.equal(await response.text(), 'fallback asset');
  }
  for (const pathname of ['/', '/login', '/workspace', '/projects/project-1/results/task-1']) {
    const response = await worker.fetch(new Request(`https://site.test${pathname}`, { method: 'POST' }), runtime, {});
    assert.equal(response.status, 200, pathname);
    assert.equal(await response.text(), 'fallback asset');
  }
});

test('missing document assets use the normal fallback or 404 response', async () => {
  for (const [pathname, headers] of [['/login', undefined], ['/workspace', sessionHeaders], ['/projects/project-1/results/task-1', sessionHeaders]]) {
    const request = new Request(`https://site.test${pathname}`, { headers });
    const missing = await worker.fetch(request, { DB: pageDb() }, {});
    assert.equal(missing.status, 404, pathname);
    assert.equal(await missing.text(), 'Not found');
    const fallback = await worker.fetch(request, { DB: pageDb(), ASSETS: { fetch: async () => new Response('fallback asset') } }, {});
    assert.equal(await fallback.text(), 'fallback asset');
  }
});

async function projectRequest(db, pathname, method = 'GET', body) {
  return worker.fetch(new Request(`https://site.test${pathname}`, {
    method,
    headers: sessionHeaders,
    body,
  }), { DB: db }, {});
}

class UploadDb extends RouteDb {
  constructor() {
    super();
    this.storedObjects = [];
    this.projectAssets = [];
    this.failBatch = false;
    this.failMapping = false;
  }

  prepare(sql) {
    const base = super.prepare(sql);
    const db = this;
    if (sql.includes('stored_objects.object_key') && sql.includes('JOIN project_assets')) {
      return {
        values: [],
        bind(...values) { return { ...this, values }; },
        async first() {
          const [assetId, projectId] = this.values;
          const linked = db.projectAssets.some((row) => row.project_id === projectId && row.object_id === assetId);
          return linked ? db.storedObjects.find(({ id }) => id === assetId) ?? null : null;
        },
      };
    }
    if (!sql.startsWith('INSERT INTO stored_objects') && !sql.startsWith('INSERT INTO project_assets')) return base;
    return {
      sql,
      values: [],
      bind(...values) { return { ...this, values }; },
      async run() {
        if (sql.startsWith('INSERT INTO stored_objects')) {
          db.storedObjects.push({ id: this.values[0], object_key: this.values[1], filename: this.values[4] });
        } else {
          db.projectAssets.push({ project_id: this.values[0], object_id: this.values[1], created_at: this.values[2] });
        }
        return { success: true };
      },
    };
  }

  async batch(statements) {
    if (this.failBatch && statements.some(({ sql }) => sql?.startsWith('INSERT INTO stored_objects'))) throw new Error('database credentials leaked');
    const snapshot = structuredClone({ storedObjects: this.storedObjects, projectAssets: this.projectAssets });
    try {
      const results = [];
      for (const statement of statements) {
        if (this.failMapping && statement.sql?.startsWith('INSERT INTO project_assets')) throw new Error('mapping unavailable');
        results.push(await statement.run());
      }
      return results;
    } catch (error) {
      this.storedObjects = snapshot.storedObjects;
      this.projectAssets = snapshot.projectAssets;
      throw error;
    }
  }
}

class TaskRouteDb extends RouteDb {
  constructor() {
    super();
    this.tasks = [];
    this.projectTasks = [];
    this.statusQueries = 0;
  }

  prepare(sql) {
    const base = super.prepare(sql);
    const db = this;
    if (sql.includes('FROM oauth_tokens')) {
      return { async first() { db.statusQueries += 1; return null; } };
    }
    if (!sql.startsWith('SELECT') || !sql.includes('FROM video_tasks')) return base;
    return {
      values: [],
      bind(...values) { return { ...this, values }; },
      async first() {
        if (sql.includes('JOIN project_tasks')) {
          if (sql.includes('video_tasks.id = ?')) {
            const [id, projectId] = this.values;
            if (!db.projectTasks.some(({ task_id, project_id }) => task_id === id && project_id === projectId)) return null;
            const task = db.tasks.find((task) => task.id === id) ?? null;
            if (!sql.includes('JOIN projects')) return task;
            const project = db.projects.find(({ id }) => id === projectId);
            return task && project ? { ...task, project_name: project.name } : null;
          }
          const [idempotencyKey, projectId] = this.values;
          const taskIds = db.projectTasks.filter(({ project_id }) => project_id === projectId).map(({ task_id }) => task_id);
          return db.tasks.find(({ id, idempotency_key }) => idempotency_key === idempotencyKey && taskIds.includes(id)) ?? null;
        }
        return db.tasks.find(({ idempotency_key }) => idempotency_key === this.values[0]) ?? null;
      },
    };
  }
}

test('task detail API preserves anonymous JSON 401 responses', async () => {
  const response = await worker.fetch(new Request('https://site.test/api/projects/project-1/tasks/task-1'), { DB: new TaskRouteDb() }, {});
  assert.equal(response.status, 401);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('location'), null);
  assert.deepEqual(await response.json(), { error: '请先登录' });
});

test('task detail API decodes both IDs and returns the owned task detail', async () => {
  const db = new TaskRouteDb();
  db.projects.push({ id: 'project one', name: '项目详情', created_at: 1, updated_at: 2 });
  db.tasks.push({ id: 'task one', remote_id: 'remote-1', mode: 'text', status: 'succeeded', request_json: JSON.stringify({ prompt: 'ocean', model: 'kling-v1', duration: 5, resolution: '720p', aspectRatio: '16:9', privateToken: 'secret' }), result_json: '{"url":"https://video.test/result.mp4"}', created_at: 1, updated_at: 2 });
  db.projectTasks.push({ project_id: 'project one', task_id: 'task one' });
  const response = await projectRequest(db, '/api/projects/project%20one/tasks/task%20one');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'task one', projectId: 'project one', projectName: '项目详情', remoteId: 'remote-1', mode: 'text', status: 'succeeded', request: { prompt: 'ocean', model: 'kling-v1', duration: 5, resolution: '720p', aspectRatio: '16:9' }, resultJson: '{"url":"https://video.test/result.mp4"}', createdAt: 1, updatedAt: 2 });
  assert.equal(db.statusQueries, 0);
});

test('task detail API hides missing and cross-project tasks', async () => {
  const db = new TaskRouteDb();
  db.projects.push({ id: 'project-2', name: 'Two', created_at: 2, updated_at: 2 });
  db.tasks.push({ id: 'task-1', status: 'queued' });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'task-1' });
  for (const pathname of ['/api/projects/project-2/tasks/task-1', '/api/projects/project-1/tasks/missing', '/api/projects/missing/tasks/task-1']) {
    const response = await projectRequest(db, pathname);
    assert.equal(response.status, 404, pathname);
    assert.deepEqual(await response.json(), { error: '任务不存在' });
  }
});

test('task detail API rejects malformed and empty IDs', async () => {
  for (const pathname of ['/api/projects/%E0%A4%A/tasks/task-1', '/api/projects/project-1/tasks/%E0%A4%A', '/api/projects//tasks/task-1', '/api/projects/project-1/tasks/']) {
    const response = await projectRequest(new TaskRouteDb(), pathname);
    assert.equal(response.status, 400, pathname);
    assert.deepEqual(await response.json(), { error: '任务参数无效' });
  }
});

test('task detail API sanitizes unexpected database failures', async () => {
  class FailingDetailDb extends TaskRouteDb {
    prepare(sql) {
      if (!sql.includes('FROM video_tasks')) return super.prepare(sql);
      return { bind() { return { async first() { throw new Error('database password leaked'); } }; } };
    }
  }
  const response = await projectRequest(new FailingDetailDb(), '/api/projects/project-1/tasks/task-1');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: '任务详情暂不可用' });
});

test('failed OAuth callbacks return to the workspace with an error flag', async () => {
  const response = await worker.fetch(new Request('https://site.test/api/kling/oauth/callback'), { DB: new RouteDb() }, {});
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://site.test/workspace?oauth_error=1');
});

test('successful OAuth callbacks return to the workspace with an authorization flag', async (t) => {
  class OAuthRouteDb extends RouteDb {
    prepare(sql) {
      if (sql.startsWith('SELECT') && sql.includes('FROM oauth_states')) return { bind() { return { async first() { return { verifier: 'verifier', redirect_uri: 'https://site.test/api/kling/oauth/callback', expires_at: Date.now() + 60_000 }; } }; } };
      if (sql.startsWith('SELECT') && sql.includes('FROM oauth_clients')) return { async first() { return { client_id: 'client-1' }; } };
      return super.prepare(sql);
    }
  }
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === 'https://klingai.com/auth/.well-known/oauth-authorization-server') return Response.json({ token_endpoint: 'https://klingai.com/auth/token' });
    assert.equal(url, 'https://klingai.com/auth/token');
    return Response.json({ access_token: 'token', expires_in: 3600 });
  });
  const response = await worker.fetch(new Request('https://site.test/api/kling/oauth/callback?state=valid-state&code=valid-code'), { DB: new OAuthRouteDb(), TOKEN_ENCRYPTION_KEY: 'test-secret' }, {});
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://site.test/workspace?authorized=1');
});

test('task status route requires authentication and project ownership', async () => {
  const db = new TaskRouteDb();
  db.tasks.push({ id: 'task-1', remote_id: null, status: 'unknown', result_json: null });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'task-1' });
  const runtime = { DB: db, MEDIA: { get: async () => null } };
  const owned = await worker.fetch(new Request('https://site.test/api/video/tasks/task-1?projectId=project-1', { headers: sessionHeaders }), runtime, {});
  assert.equal(owned.status, 200);
  assert.equal((await owned.json()).status, 'unknown');
  const foreign = await worker.fetch(new Request('https://site.test/api/video/tasks/task-1?projectId=project-2', { headers: sessionHeaders }), runtime, {});
  assert.equal(foreign.status, 404);
  const anonymous = await worker.fetch(new Request('https://site.test/api/video/tasks/task-1?projectId=project-1'), runtime, {});
  assert.equal(anonymous.status, 401);
});

test('attempt lookup finds only the owned task by stable key without a paid tool call', async () => {
  const db = new TaskRouteDb();
  db.tasks.push({ id: 'task-1', idempotency_key: JSON.stringify(['project-1', 'stable-key']), remote_id: 'remote-1', status: 'queued' });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'task-1' });
  const runtime = { DB: db, MEDIA: { get: async () => null } };
  const url = 'https://site.test/api/video/tasks/attempt?projectId=project-1';
  const found = await worker.fetch(new Request(url, { headers: { ...sessionHeaders, 'idempotency-key': 'stable-key' } }), runtime, {});
  assert.equal(found.status, 200);
  assert.equal((await found.json()).id, 'task-1');
  assert.equal(db.statusQueries, 0);
  const missing = await worker.fetch(new Request(url, { headers: { ...sessionHeaders, 'idempotency-key': 'other-key' } }), runtime, {});
  assert.equal(missing.status, 404);
  const foreign = await worker.fetch(new Request('https://site.test/api/video/tasks/attempt?projectId=project-2', { headers: { ...sessionHeaders, 'idempotency-key': 'stable-key' } }), runtime, {});
  assert.equal(foreign.status, 404);
  const anonymous = await worker.fetch(new Request(url, { headers: { 'idempotency-key': 'stable-key' } }), runtime, {});
  assert.equal(anonymous.status, 401);
});

function taskRequest(projectId, idempotencyKey = 'shared-key') {
  return new Request('https://site.test/api/video/tasks', {
    method: 'POST',
    headers: { ...sessionHeaders, 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ projectId, mode: 'text', model: 'kling-v1', prompt: 'ocean', duration: 5, resolution: '720p', aspectRatio: '16:9' }),
  });
}

function uploadRequest(projectId) {
  const form = new FormData();
  if (projectId !== undefined) form.append('projectId', projectId);
  form.append('file', new Blob(['image'], { type: 'image/png' }), 'image.png');
  return new Request('https://site.test/api/uploads', {
    method: 'POST',
    headers: { cookie: 'keling_session=test-token', origin: 'https://site.test' },
    body: form,
  });
}

test('returns health JSON and security headers', async () => {
  const response = await worker.fetch(new Request('https://site.test/api/health'), env(), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('project routes require a session', async () => {
  for (const [method, pathname] of [
    ['GET', '/api/projects'],
    ['POST', '/api/projects'],
    ['PATCH', '/api/projects/project-1'],
    ['GET', '/api/projects/project-1/workspace'],
  ]) {
    const response = await worker.fetch(new Request(`https://site.test${pathname}`, {
      method,
      headers: method === 'GET' ? undefined : { origin: 'https://site.test', 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ name: '项目' }),
    }), env(), {});
    assert.equal(response.status, 401, `${method} ${pathname}`);
  }
});

test('authenticated project routes wire list, create, rename, and workspace reads', async () => {
  const db = new RouteDb();
  const listed = await projectRequest(db, '/api/projects');
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).projects.some(({ id }) => id === 'project-1'), true);

  const createdResponse = await projectRequest(db, '/api/projects', 'POST', JSON.stringify({ name: '  新项目  ' }));
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.name, '新项目');

  const renamedResponse = await projectRequest(db, `/api/projects/${created.id}`, 'PATCH', JSON.stringify({ name: '已更名' }));
  assert.equal(renamedResponse.status, 200);
  assert.equal((await renamedResponse.json()).name, '已更名');

  const workspaceResponse = await projectRequest(db, `/api/projects/${created.id}/workspace`);
  assert.equal(workspaceResponse.status, 200);
  assert.deepEqual(await workspaceResponse.json(), {
    project: { ...created, name: '已更名', updatedAt: db.projects.find(({ id }) => id === created.id).updated_at },
    assets: [],
    tasks: [],
    settings: {},
  });
});

test('project routes map invalid input, missing projects, and malformed ids to JSON errors', async () => {
  const db = new RouteDb();
  for (const [pathname, method, body, status] of [
    ['/api/projects', 'POST', '{broken', 400],
    ['/api/projects', 'POST', JSON.stringify({ name: '   ' }), 400],
    ['/api/projects/missing', 'PATCH', JSON.stringify({ name: '更名' }), 404],
    ['/api/projects/missing/workspace', 'GET', undefined, 404],
    ['/api/projects/%E0%A4%A', 'PATCH', JSON.stringify({ name: '更名' }), 400],
    ['/api/projects/%E0%A4%A/workspace', 'GET', undefined, 400],
  ]) {
    const response = await projectRequest(db, pathname, method, body);
    assert.equal(response.status, status, `${method} ${pathname}`);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});

test('authenticated provider updates decode the project id and persist the provider', async () => {
  const db = new RouteDb();
  db.projects.push({ id: 'project one', name: '项目供应商', created_at: 1, updated_at: 2 });
  const response = await projectRequest(db, '/api/projects/project%20one/provider', 'PATCH', JSON.stringify({ provider: ' MiniMax ' }));

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, { id: 'project one', videoProvider: 'minimax', updatedAt: db.projects[1].updated_at });
  assert.equal(db.projects[1].name, '项目供应商');
  const workspace = await projectRequest(db, '/api/projects/project%20one/workspace');
  assert.equal((await workspace.json()).project.videoProvider, 'minimax');
});

test('provider route returns JSON errors for invalid input, malformed ids, and missing projects', async () => {
  for (const [pathname, body, status, error] of [
    ['/api/projects/project-1/provider', '{broken', 400, '请提供有效的 JSON'],
    ['/api/projects/project-1/provider', JSON.stringify({ provider: 'other' }), 400, '视频供应商无效'],
    ['/api/projects/project-1/provider', JSON.stringify({}), 400, '视频供应商无效'],
    ['/api/projects/missing/provider', JSON.stringify({ provider: 'minimax' }), 404, '项目不存在'],
    ['/api/projects/%E0%A4%A/provider', JSON.stringify({ provider: 'minimax' }), 400, '项目 ID 格式无效'],
  ]) {
    const response = await projectRequest(new RouteDb(), pathname, 'PATCH', body);
    assert.equal(response.status, status, pathname);
    assert.deepEqual(await response.json(), { error });
  }
});

test('provider route requires a session and enforces mutation origin and content type', async () => {
  for (const [headers, status, error] of [
    [{ origin: 'https://site.test', 'content-type': 'application/json' }, 401, '请先登录'],
    [{ ...sessionHeaders, origin: 'https://other.test' }, 403, '请求来源无效'],
    [{ ...sessionHeaders, 'content-type': 'text/plain' }, 415, '请求内容类型无效'],
  ]) {
    const db = new RouteDb();
    const response = await worker.fetch(new Request('https://site.test/api/projects/project-1/provider', {
      method: 'PATCH', headers, body: JSON.stringify({ provider: 'minimax' }),
    }), { DB: db }, {});
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
    assert.equal(db.projects[0].video_provider, undefined);
  }
});

test('provider route sanitizes unexpected database errors', async () => {
  class FailingProviderDb extends RouteDb {
    prepare(sql) {
      if (!sql.startsWith('UPDATE projects SET video_provider')) return super.prepare(sql);
      return { bind() { return { async run() { throw new Error('database password leaked'); } }; } };
    }
  }
  const response = await projectRequest(new FailingProviderDb(), '/api/projects/project-1/provider', 'PATCH', JSON.stringify({ provider: 'minimax' }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: '项目供应商更新暂不可用' });
});

test('upload rejects a missing or invalid project before writing media', async () => {
  for (const projectId of [undefined, 'missing']) {
    const db = new UploadDb();
    let mediaWrites = 0;
    const response = await worker.fetch(uploadRequest(projectId), {
      DB: db,
      MEDIA: { put: async () => { mediaWrites += 1; } },
    }, {});

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /(?:请选择项目|请选有效项目)/);
    assert.equal(mediaWrites, 0);
    assert.deepEqual(db.storedObjects, []);
  }
});

test('upload links the stored object to the selected project', async () => {
  const db = new UploadDb();
  const mediaKeys = [];
  const response = await worker.fetch(uploadRequest('project-1'), {
    DB: db,
    MEDIA: { put: async (key) => { mediaKeys.push(key); } },
  }, {});

  assert.equal(response.status, 200);
  const { uploadId } = await response.json();
  assert.deepEqual(db.projectAssets, [{ project_id: 'project-1', object_id: uploadId, created_at: db.projectAssets[0].created_at }]);
  assert.equal(db.storedObjects[0].id, uploadId);
  assert.equal(db.storedObjects[0].object_key, `references/${uploadId}`);
  assert.equal(db.storedObjects[0].filename, 'image.png');
  assert.deepEqual(mediaKeys, [`references/${uploadId}`]);
});

test('authenticated asset route returns owned R2 bytes with stored MIME and safe caching', async () => {
  const db = new UploadDb();
  db.storedObjects.push({ id: 'asset-1', object_key: 'references/asset-1', mime_type: 'image/png' });
  db.projectAssets.push({ project_id: 'project-1', object_id: 'asset-1', created_at: 1 });
  const response = await worker.fetch(new Request('https://site.test/api/projects/project-1/assets/asset-1', { headers: sessionHeaders }), {
    DB: db,
    MEDIA: { get: async (key) => key === 'references/asset-1' ? new Response(new Uint8Array([1, 2, 3])) : null },
  }, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'private, max-age=3600');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
});

test('asset route hides missing and cross-project objects and requires authentication', async () => {
  const db = new UploadDb();
  db.projects.push({ id: 'project-2', name: 'Two', created_at: 2, updated_at: 2 });
  db.storedObjects.push({ id: 'asset-1', object_key: 'references/asset-1', mime_type: 'image/png' });
  db.projectAssets.push({ project_id: 'project-1', object_id: 'asset-1', created_at: 1 });
  let reads = 0;
  const runtime = { DB: db, MEDIA: { get: async () => { reads += 1; return new Response('secret'); } } };
  const unauthorized = await worker.fetch(new Request('https://site.test/api/projects/project-1/assets/asset-1'), runtime, {});
  const crossProject = await worker.fetch(new Request('https://site.test/api/projects/project-2/assets/asset-1', { headers: sessionHeaders }), runtime, {});
  const missing = await worker.fetch(new Request('https://site.test/api/projects/project-1/assets/missing', { headers: sessionHeaders }), runtime, {});
  assert.equal(unauthorized.status, 401);
  assert.equal(crossProject.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(reads, 0);
});

test('upload deletes the R2 object and sanitizes the response when database persistence fails', async () => {
  const db = new UploadDb();
  db.failBatch = true;
  const written = [];
  const deleted = [];
  const response = await worker.fetch(uploadRequest('project-1'), {
    DB: db,
    MEDIA: {
      put: async (key) => { written.push(key); },
      delete: async (key) => { deleted.push(key); },
    },
  }, {});

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: '上传保存失败' });
  assert.deepEqual(deleted, written);
});

test('upload sanitizes object storage failures', async () => {
  const response = await worker.fetch(uploadRequest('project-1'), {
    DB: new UploadDb(),
    MEDIA: { put: async () => { throw new Error('secret storage endpoint'); } },
  }, {});

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: '上传存储失败' });
});

test('upload requires transactional batch support before writing R2', async () => {
  const db = new UploadDb();
  db.batch = undefined;
  let writes = 0;

  const response = await worker.fetch(uploadRequest('project-1'), { DB: db, MEDIA: { put: async () => { writes += 1; } } }, {});

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: '上传保存失败' });
  assert.equal(writes, 0);
});

test('upload mapping failure rolls back database rows and deletes the R2 object', async () => {
  const db = new UploadDb();
  db.failMapping = true;
  const deleted = [];

  const response = await worker.fetch(uploadRequest('project-1'), {
    DB: db,
    MEDIA: { put: async () => {}, delete: async (key) => { deleted.push(key); } },
  }, {});

  assert.equal(response.status, 500);
  assert.equal(deleted.length, 1);
  assert.deepEqual(db.storedObjects, []);
  assert.deepEqual(db.projectAssets, []);
});

test('task route rejects an invalid project before checking Kling status', async () => {
  const db = new RouteDb();
  const response = await worker.fetch(new Request('https://site.test/api/video/tasks', {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ projectId: 'missing' }),
  }), { DB: db }, {});

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: '请选有效项目' });
});

test('task route replays a same-project idempotency key without checking offline MCP status', async () => {
  const db = new TaskRouteDb();
  const existing = { id: 'task-1', idempotency_key: '["project-1","shared-key"]', remote_id: 'remote-1', status: 'queued' };
  db.tasks.push(existing);
  db.projectTasks.push({ project_id: 'project-1', task_id: 'task-1' });

  const response = await worker.fetch(taskRequest('project-1'), { DB: db }, {});

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'task-1', remote_id: 'remote-1', status: 'queued' });
  assert.equal(db.statusQueries, 0);
});

test('task route treats the same external key in another project as a fresh task', async () => {
  const db = new TaskRouteDb();
  db.projects.push({ id: 'project-2', name: 'Project 2', created_at: 2, updated_at: 2 });
  db.tasks.push({ id: 'task-1', idempotency_key: '["project-1","shared-key"]', remote_id: 'remote-secret', status: 'queued' });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'task-1' });

  const response = await worker.fetch(taskRequest('project-2'), { DB: db }, {});

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: '请先连接可灵 MCP' });
  assert.equal(db.statusQueries, 1);
});

test('fresh task still checks status and rejects an offline MCP connection', async () => {
  const db = new TaskRouteDb();

  const response = await worker.fetch(taskRequest('project-1', 'fresh-key'), { DB: db }, {});

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: '请先连接可灵 MCP' });
  assert.equal(db.statusQueries, 1);
});

test('fresh task resolves the project provider before checking Kling status', async () => {
  const db = new TaskRouteDb(); db.projects[0].video_provider = 'unknown';
  const response = await worker.fetch(taskRequest('project-1', 'unknown-provider'), { DB: db }, {});
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: '视频供应商无效' });
  assert.equal(db.statusQueries, 0);
});

test('task API serializes errorCode only for coded TaskError responses', async () => {
  class CodedTaskDb extends TaskRouteDb {
    prepare(sql) {
      if (!sql.startsWith('SELECT') || !sql.includes('FROM video_tasks')) return super.prepare(sql);
      return { bind() { return { async first() { throw new TaskError('供应商暂不可用', 503, undefined, 'PROVIDER_UNAVAILABLE'); } }; } };
    }
  }
  const db = new CodedTaskDb();
  for (const request of [taskRequest('project-1'), new Request('https://site.test/api/video/tasks/task-1?projectId=project-1', { headers: sessionHeaders }), new Request('https://site.test/api/video/tasks/attempt?projectId=project-1', { headers: { ...sessionHeaders, 'idempotency-key': 'key' } }), new Request('https://site.test/api/projects/project-1/tasks/task-1', { headers: sessionHeaders })]) {
    const response = await worker.fetch(request, { DB: db }, {});
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: '供应商暂不可用', errorCode: 'PROVIDER_UNAVAILABLE' });
  }
});

test('unexpected database failures return a sanitized server response', async () => {
  class FailingDb extends RouteDb {
    prepare(sql) {
      const statement = super.prepare(sql);
      if (!sql.includes('FROM projects') || !sql.includes('WHERE id = ?')) return statement;
      return { bind() { return { async first() { throw new Error('database password leaked'); } }; } };
    }
  }

  const response = await worker.fetch(taskRequest('project-1', 'db-failure'), { DB: new FailingDb() }, {});

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: '任务处理失败' });
});
