import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

function env() {
  return {
    ASSETS: { fetch: async () => new Response('asset') },
    DB: { prepare: () => ({ run: async () => ({ success: true }) }) },
  };
}

class RouteDb {
  constructor() {
    this.projects = [{ id: 'project-1', name: '项目一', created_at: 1, updated_at: 1 }];
  }

  prepare(sql) {
    const db = this;
    const statement = {
      values: [],
      bind(...values) { return { ...statement, values }; },
      async first() {
        if (sql.includes('FROM admin_sessions')) return { token_hash: 'valid', expires_at: Date.now() + 60_000 };
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
        if (sql.startsWith('INSERT INTO projects')) {
          db.projects.push({ id: values[0], name: values[1], created_at: values[2], updated_at: values[3] });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE projects')) {
          const project = db.projects.find(({ id }) => id === values[2]);
          if (!project) return { success: true, meta: { changes: 0 } };
          project.name = values[0];
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

const sessionHeaders = { cookie: 'keling_session=test-token', 'content-type': 'application/json' };

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
          db.storedObjects.push({ id: this.values[0], object_key: this.values[1] });
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
    if (!sql.includes('FROM video_tasks')) return base;
    return {
      values: [],
      bind(...values) { return { ...this, values }; },
      async first() {
        if (sql.includes('JOIN project_tasks')) {
          const [idempotencyKey, projectId] = this.values;
          const taskIds = db.projectTasks.filter(({ project_id }) => project_id === projectId).map(({ task_id }) => task_id);
          return db.tasks.find(({ id, idempotency_key }) => idempotency_key === idempotencyKey && taskIds.includes(id)) ?? null;
        }
        return db.tasks.find(({ idempotency_key }) => idempotency_key === this.values[0]) ?? null;
      },
    };
  }
}

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
    headers: { cookie: 'keling_session=test-token' },
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
      headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ name: '项目' }),
    }), env(), {});
    assert.equal(response.status, 401, `${method} ${pathname}`);
  }
});

test('authenticated project routes wire list, create, rename, and workspace reads', async () => {
  const db = new RouteDb();
  const listed = await projectRequest(db, '/api/projects');
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).projects[0].id, 'project-1');

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
