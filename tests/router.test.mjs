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
  }

  prepare(sql) {
    const base = super.prepare(sql);
    const db = this;
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
