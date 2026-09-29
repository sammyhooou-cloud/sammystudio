import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { persistTaskOutput, readTaskOutput } from '../src/task-outputs.js';

class OutputDb {
  constructor(taskId = 'task-1', projectId = 'project-1') {
    this.sqlite = new DatabaseSync(':memory:');
    for (const name of ['0001_initial.sql', '0002_projects.sql', '0004_video_providers.sql']) this.sqlite.exec(readFileSync(new URL(`../migrations/DB/${name}`, import.meta.url), 'utf8'));
    this.sqlite.prepare('INSERT INTO video_tasks (id, idempotency_key, mode, status, request_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(taskId, taskId, 'text', 'generating', '{}', 1, 1);
    this.sqlite.prepare('INSERT INTO project_tasks (project_id, task_id, created_at) VALUES (?, ?, ?)').run(projectId, taskId, 1);
    this.queries = [];
    this.failInsert = false;
    this.beforeInsert = null;
  }

  prepare(sql) {
    const db = this;
    return {
      values: [],
      bind(...values) { return { ...this, values }; },
      async first() {
        db.queries.push({ sql, values: this.values });
        return db.sqlite.prepare(sql).get(...this.values) ?? null;
      },
      async run() {
        db.queries.push({ sql, values: this.values });
        if (sql.startsWith('INSERT') && sql.includes('task_outputs')) {
          if (db.failInsert) throw new Error('SQL outputs/task-1.mp4 secret database');
          db.beforeInsert?.();
        }
        return { success: true, meta: db.sqlite.prepare(sql).run(...this.values) };
      },
    };
  }

  output(row = {}) {
    this.sqlite.prepare('INSERT INTO task_outputs (id, task_id, object_key, content_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(row.id || 'existing-output', row.task_id || 'task-1', row.object_key || 'outputs/task-1.mp4', row.content_type || 'video/mp4', row.byte_size ?? 5, row.created_at ?? 1);
  }

  rows() { return this.sqlite.prepare('SELECT * FROM task_outputs').all().map((row) => ({ ...row })); }
}

function setup(t, taskId = 'task-1', projectId = 'project-1') {
  const db = new OutputDb(taskId, projectId);
  t.after(() => db.sqlite.close());
  const puts = [];
  const gets = [];
  const objects = new Map();
  const media = {
    async put(key, body, options) {
      assert.ok(body instanceof ReadableStream, 'video must reach R2 as a stream');
      puts.push({ key, body, options });
      const bytes = await new Response(body).arrayBuffer();
      objects.set(key, bytes);
      return { size: bytes.byteLength };
    },
    async get(key) {
      gets.push(key);
      const bytes = objects.get(key);
      return bytes ? { body: new Response(bytes).body } : null;
    },
  };
  return { db, env: { DB: db, MEDIA: media }, puts, gets, objects };
}

function videoResponse({ type = 'video/mp4', length = '5', status = 200, finalUrl = '' } = {}) {
  const response = new Response('video', { status, headers: { 'content-type': type, ...(length === null ? {} : { 'content-length': length }) } });
  if (finalUrl) Object.defineProperty(response, 'url', { value: finalUrl });
  response.arrayBuffer = () => assert.fail('persistence must not buffer the response');
  response.blob = () => assert.fail('persistence must not buffer the response');
  return response;
}

async function persist(options) {
  return persistTaskOutput({ taskId: 'task-1', projectId: 'project-1', sourceUrl: 'https://video.test/generated.mp4?private=signed', now: () => 1234, idFactory: () => 'output-1', ...options });
}

async function read(options) {
  return readTaskOutput({ taskId: 'task-1', projectId: 'project-1', ...options });
}

test('output persistence rejects invalid IDs and unsafe source URLs before remote access', async (t) => {
  const { env, puts } = setup(t);
  for (const input of [{ taskId: '' }, { taskId: '  ' }, { projectId: null }, { projectId: ' ' }, { sourceUrl: 'http://video.test/clip.mp4' }, { sourceUrl: 'https://user:password@video.test/clip.mp4' }, { sourceUrl: 'bad-url' }]) {
    await assert.rejects(() => persist({ env, fetcher: () => assert.fail('invalid input must not fetch'), ...input }), (error) => error.status === 400 && !error.message.includes('password'));
  }
  assert.equal(puts.length, 0);
});

test('output persistence checks project ownership before downloading', async (t) => {
  const { env, puts, db } = setup(t);
  await assert.rejects(() => persist({ env, projectId: 'other-project', fetcher: () => assert.fail('cross-project task must not fetch') }), { status: 404 });
  assert.equal(puts.length, 0);
  assert.equal(db.rows().length, 0);
});

test('an existing owned output immediately returns an encoded internal URL without storage writes', async (t) => {
  const taskId = 'task /一'; const projectId = 'project /二';
  const { env, db, puts } = setup(t, taskId, projectId);
  db.output({ task_id: taskId });
  const url = await persist({ env, taskId, projectId, fetcher: () => assert.fail('existing output must not fetch') });
  assert.equal(url, `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/output`);
  assert.equal(puts.length, 0);
  assert.equal(db.rows().length, 1);
  await assert.rejects(() => persist({ env, taskId, projectId: 'other', fetcher: () => assert.fail('output lookup must be project-scoped') }), { status: 404 });
});

test('successful video persistence streams to R2 and writes complete output metadata once', async (t) => {
  const { env, db, puts } = setup(t);
  const response = videoResponse(); const stream = response.body;
  let fetches = 0;
  const fetcher = async (url, options) => {
    fetches += 1;
    assert.equal(url, 'https://video.test/generated.mp4?private=signed');
    assert.equal(options.redirect, 'follow');
    return response;
  };
  assert.equal(await persist({ env, fetcher }), '/api/projects/project-1/tasks/task-1/output');
  assert.equal(puts[0].body, stream);
  assert.equal(puts[0].key, 'outputs/task-1.mp4');
  assert.deepEqual(puts[0].options.httpMetadata, { contentType: 'video/mp4' });
  assert.deepEqual(db.rows(), [{ id: 'output-1', task_id: 'task-1', object_key: 'outputs/task-1.mp4', content_type: 'video/mp4', byte_size: 5, created_at: 1234 }]);
  assert.equal(await persist({ env, fetcher }), '/api/projects/project-1/tasks/task-1/output');
  assert.equal(fetches, 1);
  assert.equal(puts.length, 1);
});

test('video persistence accepts video media, explicit MP4 and octet streams with MP4 URLs', async (t) => {
  for (const [type, sourceUrl, finalUrl] of [['video/webm', 'https://video.test/blob', ''], ['application/mp4', 'https://video.test/blob', ''], ['application/octet-stream', 'https://video.test/clip.mp4?signature=x', ''], ['application/octet-stream', 'https://video.test/blob', 'https://cdn.test/CLIP.MP4?token=x']]) {
    const { env, db } = setup(t);
    await persist({ env, sourceUrl, fetcher: async () => videoResponse({ type, status: 201, finalUrl }) });
    assert.equal(db.rows()[0].content_type, type);
  }
});

test('video persistence rejects failed responses, arbitrary content and unsafe redirect URLs', async (t) => {
  for (const responseOptions of [{ status: 404 }, { type: 'text/html' }, { type: 'application/json' }, { type: 'application/octet-stream', finalUrl: 'https://cdn.test/blob' }, { finalUrl: 'http://cdn.test/clip.mp4' }, { finalUrl: 'https://user:secret@cdn.test/clip.mp4' }]) {
    const { env, db, puts } = setup(t);
    await assert.rejects(() => persist({ env, sourceUrl: 'https://video.test/blob', fetcher: async () => videoResponse(responseOptions) }), (error) => error.status === 503 && error.code === 'output_persist_failed' && !error.message.includes('secret'));
    assert.equal(puts.length, 0);
    assert.equal(db.rows().length, 0);
  }
});

test('video persistence validates declared sizes before writing to R2', async (t) => {
  for (const length of ['', '-1', 'NaN', '1.5', '1e3', '1073741825', '999999999999999999999']) {
    const { env, puts } = setup(t);
    await assert.rejects(() => persist({ env, fetcher: async () => videoResponse({ length }) }), { code: 'output_persist_failed' });
    assert.equal(puts.length, 0);
  }
});

test('video persistence permits missing size using the R2 size or null', async (t) => {
  for (const returnedSize of [5, undefined]) {
    const { env, db } = setup(t);
    const originalPut = env.MEDIA.put;
    env.MEDIA.put = async (...args) => { await originalPut(...args); return returnedSize === undefined ? {} : { size: returnedSize }; };
    await persist({ env, fetcher: async () => videoResponse({ length: null }) });
    assert.equal(db.rows()[0].byte_size, returnedSize ?? null);
  }
});

test('fetch, R2 and database failures return only safe persistence errors and remain retryable', async (t) => {
  for (const failure of ['fetch', 'r2', 'db']) {
    const { env, db } = setup(t);
    const originalPut = env.MEDIA.put;
    if (failure === 'r2') env.MEDIA.put = async () => { throw new Error('outputs/task-1.mp4 private=signed secret storage'); };
    if (failure === 'db') db.failInsert = true;
    const fetcher = async () => { if (failure === 'fetch') throw new Error('https://video.test/generated.mp4?private=signed'); return videoResponse(); };
    await assert.rejects(() => persist({ env, fetcher }), (error) => {
      assert.equal(error.status, 503); assert.equal(error.code, 'output_persist_failed');
      assert.doesNotMatch(error.message, /signed|outputs\/|https:|secret/);
      return true;
    });
    assert.equal(db.rows().length, 0);
    db.failInsert = false; env.MEDIA.put = originalPut;
    assert.equal(await persist({ env, fetcher: async () => videoResponse() }), '/api/projects/project-1/tasks/task-1/output');
  }
});

test('output insertion races retain the winning row and never delete its R2 object', async (t) => {
  const { env, db } = setup(t);
  db.beforeInsert = () => { db.output({ id: 'race-winner' }); db.beforeInsert = null; };
  env.MEDIA.delete = () => assert.fail('must not delete a winning output');
  assert.equal(await persist({ env, fetcher: async () => videoResponse() }), '/api/projects/project-1/tasks/task-1/output');
  assert.equal(db.rows()[0].id, 'race-winner');
  assert.equal(db.rows().length, 1);
});

test('reading an owned output uses a project-scoped JOIN and returns a private streamed response', async (t) => {
  const { env, db, objects } = setup(t);
  db.output({ content_type: 'video/webm' });
  objects.set('outputs/task-1.mp4', new TextEncoder().encode('video').buffer);
  const response = await read({ env });
  assert.ok(response instanceof Response);
  assert.equal(response.headers.get('content-type'), 'video/webm');
  assert.equal(response.headers.get('cache-control'), 'private, max-age=3600');
  assert.equal(await response.text(), 'video');
  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0].sql, /JOIN project_tasks/);
  assert.match(db.queries[0].sql, /project_tasks\.project_id = \?/);
  assert.deepEqual(db.queries[0].values, ['task-1', 'project-1']);
});

test('reading missing, cross-project or missing-R2 outputs returns null without revealing keys', async (t) => {
  const { env, db, gets } = setup(t);
  assert.equal(await read({ env }), null);
  db.output();
  assert.equal(await read({ env, projectId: 'other' }), null);
  assert.equal(gets.length, 0);
  assert.equal(await read({ env }), null);
});

test('output reads sanitize database and storage exceptions', async (t) => {
  const { env, db } = setup(t); db.output();
  env.MEDIA.get = async () => { throw new Error('outputs/task-1.mp4 private R2 credentials'); };
  await assert.rejects(() => read({ env }), (error) => error.status === 503 && !/outputs|credentials/.test(error.message));
  env.DB = { prepare: () => { throw new Error('database secret'); } };
  await assert.rejects(() => read({ env }), (error) => error.status === 503 && !error.message.includes('secret'));
});
