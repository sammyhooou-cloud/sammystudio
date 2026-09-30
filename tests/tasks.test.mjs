import test from 'node:test';
import assert from 'node:assert/strict';
import { submitTask, getTaskStatus } from '../src/tasks.js';
import * as taskApi from '../src/tasks.js';
import { ProviderError } from '../src/providers/minimax.js';

const capabilities = {
  text_to_video: {
    models: [{
      model: 'kling-v1',
      arguments: [
        { name: 'prompt', required: true },
        { name: 'duration', allowedValues: ['5'] },
        { name: 'resolution', allowedValues: ['720p'] },
        { name: 'aspect_ratio', allowedValues: ['16:9'] },
        { name: 'imageCount' },
      ],
    }],
  },
};

const input = {
  projectId: 'project-1',
  mode: 'text',
  model: 'kling-v1',
  prompt: 'ocean at dawn',
  duration: 5,
  resolution: '720p',
  aspectRatio: '16:9',
  imageCount: 1,
};

class RecoveryMedia {
  constructor() {
    this.objects = new Map();
    this.putAttempts = 0;
    this.failPutsRemaining = 0;
    this.failDeletesRemaining = 0;
    this.deleted = [];
  }

  async put(key, value) {
    this.putAttempts += 1;
    if (this.failPutsRemaining > 0) {
      this.failPutsRemaining -= 1;
      throw new Error('r2 unavailable');
    }
    this.objects.set(key, String(value));
  }

  async get(key) {
    if (!this.objects.has(key)) return null;
    const value = this.objects.get(key);
    return { text: async () => value };
  }

  async delete(key) {
    if (this.failDeletesRemaining > 0) {
      this.failDeletesRemaining -= 1;
      throw new Error('r2 delete unavailable');
    }
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

const taskEnv = (db, media = new RecoveryMedia()) => ({ DB: db, MEDIA: media });

class TaskDb {
  constructor() {
    this.projects = [{ id: 'project-1', name: 'Project One' }, { id: 'project-2', name: 'Project Two' }];
    this.tasks = [];
    this.projectTasks = [];
    this.taskOutputs = [];
    this.settings = [];
    this.settingsVersions = new Map();
    this.batchCount = 0;
    this.queries = [];
    this.failReservation = false;
    this.failProjectTask = false;
    this.finalizationFailuresRemaining = 0;
    this.finalizationAttempts = 0;
    this.failSettings = false;
    this.afterSettingsRead = null;
    this.upload = null;
    this.beforeOrphanUpdate = null;
    this.failOutputInsert = false;
  }

  prepare(sql) {
    const db = this;
    const statement = {
      sql,
      values: [],
      bind(...values) { return { ...statement, values }; },
      async first() {
        db.queries.push({ sql, values: this.values });
        if (sql.includes('FROM task_outputs')) {
          const [taskId, projectId] = this.values;
          if (!db.projectTasks.some(({ task_id, project_id }) => task_id === taskId && project_id === projectId)) return null;
          return db.taskOutputs.find(({ task_id }) => task_id === taskId) ?? null;
        }
        if (sql.startsWith('INSERT INTO project_settings_versions')) {
          const projectId = this.values[0];
          const version = (db.settingsVersions.get(projectId) || 0) + 1;
          db.settingsVersions.set(projectId, version);
          return { version };
        }
        if (sql.includes('JOIN project_tasks')) {
          if (sql.includes('video_tasks.id = ?')) {
            const [taskId, projectId] = this.values;
            const belongs = db.projectTasks.some(({ task_id, project_id }) => task_id === taskId && project_id === projectId);
            if (!belongs) return null;
            const task = db.tasks.find(({ id }) => id === taskId);
            if (!task) return null;
            if (sql.includes('JOIN projects')) {
              const project = db.projects.find(({ id }) => id === projectId);
              return project ? { ...task, project_name: project.name } : null;
            }
            return task;
          }
          const [idempotencyKey, projectId] = this.values;
          const taskIds = db.projectTasks.filter(({ project_id }) => project_id === projectId).map(({ task_id }) => task_id);
          return db.tasks.find(({ id, idempotency_key }) => idempotency_key === idempotencyKey && taskIds.includes(id)) ?? null;
        }
        if (sql.includes('FROM video_tasks')) return db.tasks.find(({ idempotency_key }) => idempotency_key === this.values[0]) ?? null;
        if (sql.includes('FROM project_settings')) {
          const found = db.settings.find(({ project_id }) => project_id === this.values[0]) ?? null;
          if (db.afterSettingsRead) {
            const hook = db.afterSettingsRead;
            db.afterSettingsRead = null;
            hook();
          }
          return found;
        }
        if (sql.includes('FROM projects')) return db.projects.find(({ id }) => id === this.values[0]) ?? null;
        if (sql.includes('FROM stored_objects')) return db.upload;
        throw new Error(`Unexpected first query: ${sql}`);
      },
      async run() {
        const values = this.values;
        if (sql.startsWith('INSERT OR IGNORE INTO task_outputs')) {
          if (db.failOutputInsert) throw new Error('database outputs/minimax-poll.mp4 private insert failure');
          if (!db.taskOutputs.some(({ task_id }) => task_id === values[1])) db.taskOutputs.push({ id: values[0], task_id: values[1], object_key: values[2], content_type: values[3], byte_size: values[4], created_at: values[5] });
        }
        else if (sql.startsWith('INSERT INTO video_tasks')) {
          if (db.tasks.some(({ idempotency_key }) => idempotency_key === values[1])) throw new Error('UNIQUE constraint failed: video_tasks.idempotency_key');
          db.tasks.push({ id: values[0], idempotency_key: values[1], remote_id: values[2], mode: values[3], status: values[4], request_json: values[5], ...(sql.includes('provider') ? { provider: values[8] } : {}) });
        }
        else if (sql.startsWith('UPDATE video_tasks SET remote_id')) {
          db.finalizationAttempts += 1;
          if (db.finalizationFailuresRemaining > 0) {
            db.finalizationFailuresRemaining -= 1;
            throw new Error('database unavailable');
          }
          const task = db.tasks.find(({ id }) => id === values[4]);
          task.remote_id = values[0];
          task.status = values[1];
          task.result_json = values[2];
        }
        else if (sql.startsWith('UPDATE video_tasks SET status')) {
          const task = db.tasks.find(({ id }) => id === (sql.includes('result_json') ? values[3] : values[2]));
          const guardedOrphanUpdate = sql.includes('remote_id IS NULL');
          if (guardedOrphanUpdate && db.beforeOrphanUpdate) {
            const hook = db.beforeOrphanUpdate;
            db.beforeOrphanUpdate = null;
            hook(task);
          }
          const allowedStatuses = guardedOrphanUpdate ? values.slice(3) : null;
          if (!guardedOrphanUpdate || (task && task.remote_id == null && allowedStatuses.includes(task.status))) {
            task.status = values[0];
            if (sql.includes('result_json')) task.result_json = values[1];
          }
        }
        else if (sql.startsWith('INSERT INTO project_tasks')) {
          if (db.failProjectTask) throw new Error('mapping unavailable');
          db.projectTasks.push({ project_id: values[0], task_id: values[1], created_at: values[2] });
        }
        else if (sql.startsWith('INSERT INTO project_settings')) {
          if (db.failSettings) throw new Error('settings unavailable');
          const existing = db.settings.find(({ project_id }) => project_id === values[0]);
          if (!existing || existing.updated_at < values[2]) db.settings = [{ project_id: values[0], settings_json: values[1], updated_at: values[2] }];
        }
        else throw new Error(`Unexpected run query: ${sql}`);
        return { success: true };
      },
    };
    return statement;
  }

  async batch(statements) {
    this.batchCount += 1;
    if (this.failReservation && statements.some(({ sql }) => sql?.startsWith('INSERT INTO video_tasks'))) throw new Error('database unavailable');
    const snapshot = structuredClone({ tasks: this.tasks, projectTasks: this.projectTasks, settings: this.settings });
    try { return await Promise.all(statements.map((statement) => statement.run())); }
    catch (error) {
      this.tasks = snapshot.tasks;
      this.projectTasks = snapshot.projectTasks;
      this.settings = snapshot.settings;
      throw error;
    }
  }
}

test('task detail returns a sanitized project-owned DTO', async () => {
  const db = new TaskDb();
  db.tasks.push({
    id: 'detail-1', remote_id: 'remote-1', mode: 'text', status: 'succeeded',
    request_json: JSON.stringify({ prompt: 'ocean', model: 'kling-v1', duration: '5', resolution: '720p', aspectRatio: '16:9', idempotency_key: 'secret-key', uploadId: 'upload-1', settingsVersion: 7, providerSecret: 'do-not-return' }),
    result_json: '{"generationId":"remote-1"}', created_at: 10, updated_at: 20,
  });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'detail-1' });

  const detail = await taskApi.getTaskDetail('detail-1', 'project-1', taskEnv(db));

  assert.deepEqual(detail, {
    id: 'detail-1', projectId: 'project-1', projectName: 'Project One', remoteId: 'remote-1', provider: 'kling',
    mode: 'text', status: 'succeeded',
    request: { prompt: 'ocean', model: 'kling-v1', duration: '5', resolution: '720p', aspectRatio: '16:9' },
    resultJson: '{"generationId":"remote-1"}', createdAt: 10, updatedAt: 20,
  });
  assert.equal(Object.hasOwn(detail.request, 'idempotency_key'), false);
});

test('task detail rejects access through a different project', async () => {
  const db = new TaskDb();
  db.tasks.push({ id: 'detail-private', request_json: '{}', status: 'queued' });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'detail-private' });

  await assert.rejects(() => taskApi.getTaskDetail('detail-private', 'project-2', taskEnv(db)), (error) => {
    assert.equal(error.message, '任务不存在');
    assert.equal(error.status, 404);
    return true;
  });
});

test('task detail safely handles malformed request JSON and absent optional values', async () => {
  const db = new TaskDb();
  db.tasks.push({ id: 'detail-malformed', request_json: '{bad json', status: 'queued', remote_id: null, result_json: null });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'detail-malformed' });

  const detail = await taskApi.getTaskDetail('detail-malformed', 'project-1', taskEnv(db));

  assert.deepEqual(detail.request, {});
  assert.equal(detail.remoteId, null);
  assert.equal(detail.resultJson, null);
});

test('task detail rejects missing task or project identifiers', async () => {
  await assert.rejects(() => taskApi.getTaskDetail('', 'project-1', taskEnv(new TaskDb())), (error) => error.message === '任务参数无效' && error.status === 400);
  await assert.rejects(() => taskApi.getTaskDetail('detail-1', '', taskEnv(new TaskDb())), (error) => error.message === '任务参数无效' && error.status === 400);
});

test('same project idempotency replay returns its task without another Kling call', async () => {
  const db = new TaskDb();
  const existing = { id: 'task-1', idempotency_key: '["project-1","shared-key"]', remote_id: 'remote-1', status: 'queued' };
  db.tasks.push(existing);
  db.projectTasks.push({ project_id: 'project-1', task_id: 'task-1', created_at: 1 });
  let calls = 0;

  const result = await submitTask(input, { DB: db }, 'shared-key', capabilities, fetch, async () => { calls += 1; });

  assert.deepEqual(result, { id: 'task-1', remote_id: 'remote-1', status: 'queued' });
  assert.equal(calls, 0);
  assert.equal(db.tasks.length, 1);
});

test('queued or generating legacy tasks without a remote id become unknown without a Kling call', async () => {
  for (const status of ['queued', 'generating']) {
    const db = new TaskDb();
    const resultJson = status === 'queued' ? '{"legacy":true}' : null;
    db.tasks.push({ id: `orphan-${status}`, remote_id: null, status, result_json: resultJson });
    db.projectTasks.push({ project_id: 'project-1', task_id: `orphan-${status}`, created_at: 1 });
    let calls = 0;

    const result = await getTaskStatus(`orphan-${status}`, 'project-1', taskEnv(db), fetch, async () => { calls += 1; });

    assert.deepEqual(result, { id: `orphan-${status}`, remote_id: null, status: 'unknown', resultJson });
    assert.equal(db.tasks[0].status, 'unknown');
    assert.equal(calls, 0);
  }
});

test('orphan transition returns the current task if finalization attaches a remote id concurrently', async () => {
  const db = new TaskDb();
  db.tasks.push({ id: 'orphan-race', remote_id: null, status: 'queued', result_json: null });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'orphan-race', created_at: 1 });
  db.beforeOrphanUpdate = (task) => {
    task.remote_id = 'remote-finalized';
    task.status = 'queued';
    task.result_json = '{"generationId":"remote-finalized"}';
  };
  let calls = 0;

  const result = await getTaskStatus('orphan-race', 'project-1', taskEnv(db), fetch, async () => { calls += 1; });

  assert.deepEqual(result, { id: 'orphan-race', remote_id: 'remote-finalized', status: 'queued', resultJson: '{"generationId":"remote-finalized"}' });
  assert.equal(calls, 0);
});

test('writes paid-call intent before generation and uses a stable trace identifier', async () => {
  const db = new TaskDb(); const media = new RecoveryMedia(); let observed;
  const result = await submitTask(input, taskEnv(db, media), 'intent-key', capabilities, fetch, async (_env, name, args) => {
    assert.equal(name, 'text_to_video');
    observed = JSON.parse(media.objects.get(`task-recovery/${db.tasks[0].id}.json`));
    assert.equal(observed.idempotencyKey, 'intent-key');
    assert.equal(observed.projectId, 'project-1');
    assert.equal(args.taskTraceId, observed.traceId);
    return { generationId: 'generation-1', status: 'submitted' };
  });
  assert.equal(result.remote_id, 'generation-1');
  assert.equal(observed.request.prompt, input.prompt);
});

test('generation envelope includes only arguments declared by the selected model', async () => {
  const db = new TaskDb();
  const limited = { text_to_video: { models: [{ model: 'limited', arguments: [{ name: 'prompt' }, { name: 'duration', allowedValues: ['5'] }] }] } };
  await submitTask({ ...input, model: 'limited' }, taskEnv(db), 'limited-model', limited, fetch, async (_env, _name, args) => {
    assert.deepEqual(args.arguments, [{ name: 'prompt', value: input.prompt }, { name: 'duration', value: '5' }]);
    return { generationId: 'generation-limited' };
  });
});

test('ambiguous generation failure remains unknown and replay never makes another paid call', async () => {
  const db = new TaskDb(); const media = new RecoveryMedia(); let calls = 0;
  await assert.rejects(() => submitTask(input, taskEnv(db, media), 'lost-response', capabilities, fetch, async () => {
    calls += 1; throw new Error('connection lost');
  }));
  assert.equal(db.tasks[0].status, 'unknown');
  const replay = await submitTask(input, taskEnv(db, media), 'lost-response', capabilities, fetch, async () => { calls += 1; });
  assert.equal(replay.status, 'unknown');
  assert.equal(calls, 1);
});

test('orphaned intent becomes action-required after the crash window without a second paid call', async () => {
  const db = new TaskDb(); const media = new RecoveryMedia();
  const id = 'orphan-1';
  db.tasks.push({ id, idempotency_key: '["project-1","orphan-key"]', remote_id: null, status: 'submitting', created_at: Date.now() - 6 * 60_000 });
  db.projectTasks.push({ project_id: 'project-1', task_id: id });
  media.objects.set(`task-recovery/${id}.json`, JSON.stringify({ id, projectId: 'project-1', idempotencyKey: 'orphan-key', traceId: 'trace', request: {}, settings: {}, settingsVersion: 1, remoteId: null, phase: 'intent' }));
  let calls = 0;
  const replay = await submitTask(input, taskEnv(db, media), 'orphan-key', capabilities, fetch, async () => { calls += 1; });
  assert.equal(replay.status, 'unknown');
  assert.equal(calls, 0);
});

test('accepted generation is finalized from known remote ID if post-response R2 update fails', async () => {
  const db = new TaskDb(); const media = new RecoveryMedia();
  const result = await submitTask(input, taskEnv(db, media), 'post-write-fail', capabilities, fetch, async () => {
    media.failPutsRemaining = 3;
    return { generationId: 'generation-known' };
  });
  assert.equal(result.remote_id, 'generation-known');
  assert.equal(db.tasks[0].remote_id, 'generation-known');
});

test('status lookup checks ownership, polls by generationId, and stores completed works', async () => {
  const db = new TaskDb(); db.tasks.push({ id: 'local-1', remote_id: 'generation-1', status: 'queued' });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'local-1' });
  let calls = 0;
  const task = await getTaskStatus('local-1', 'project-1', taskEnv(db), fetch, async (_env, name, args) => {
    calls += 1; assert.equal(name, 'query_tasks'); assert.deepEqual(args, { generationId: 'generation-1' });
    return { generationId: 'generation-1', status: 'COMPLETED', works: [{ contentType: 'video', url: 'https://cdn.test/result.mp4' }] };
  });
  assert.equal(task.status, 'succeeded');
  assert.equal(JSON.parse(db.tasks[0].result_json).works[0].url, 'https://cdn.test/result.mp4');
  await assert.rejects(() => getTaskStatus('local-1', 'other-project', taskEnv(db), fetch, async () => { calls += 1; }));
  await getTaskStatus('local-1', 'project-1', taskEnv(db), fetch, async () => { calls += 1; });
  assert.equal(calls, 1);
});

test('image generation uses Kling upload ticket and a multipart byte upload before paid call', async () => {
  const db = new TaskDb(); db.upload = { object_key: 'references/asset-1', mime_type: 'image/png', filename: 'scene.png', size: 3 };
  const media = new RecoveryMedia(); const originalGet = media.get.bind(media);
  media.get = async (key) => key === 'references/asset-1' ? { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } : originalGet(key);
  const imageCapabilities = { image_to_video: { models: [{ model: 'kling-v1', arguments: capabilities.text_to_video.models[0].arguments, inputs: [{ name: 'first_image' }] }] } };
  let uploaded = false;
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://upload.test/image');
    assert.equal(options.method, 'POST');
    assert.equal(options.body.get('ticket'), 'upload-ticket');
    assert.equal(options.body.get('file').name, 'scene.png');
    assert.deepEqual([...new Uint8Array(await options.body.get('file').arrayBuffer())], [1, 2, 3]);
    uploaded = true;
    return new Response(JSON.stringify({ url: 'https://cdn.test/scene.png' }), { headers: { 'content-type': 'application/json' } });
  };
  const task = await submitTask({ ...input, mode: 'image', uploadId: 'asset-1' }, taskEnv(db, media), 'image-ticket', imageCapabilities, fetcher, async (_env, name, args) => {
    if (name === 'file_upload') {
      assert.equal(args.filename, 'scene.png');
      assert.equal('file' in args, false);
      return { ticket: 'upload-ticket', uploadUrl: 'https://upload.test/image' };
    }
    assert.equal(name, 'image_to_video');
    assert.equal(uploaded, true);
    assert.equal(args.inputs[0].name, 'first_image');
    assert.equal(args.inputs[0].url, 'https://cdn.test/scene.png');
    return { generationId: 'generation-image' };
  });
  assert.equal(task.remote_id, 'generation-image');
});

test('same-project tasks saved with legacy external keys still replay without a paid call', async () => {
  const db = new TaskDb();
  db.tasks.push({ id: 'legacy-task', idempotency_key: 'legacy-key', remote_id: 'legacy-remote', status: 'queued' });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'legacy-task', created_at: 1 });
  let calls = 0;

  const result = await submitTask(input, { DB: db }, 'legacy-key', capabilities, fetch, async () => { calls += 1; });

  assert.deepEqual(result, { id: 'legacy-task', remote_id: 'legacy-remote', status: 'queued' });
  assert.equal(calls, 0);
});

test('the same external idempotency key is independent across projects', async () => {
  const db = new TaskDb();
  db.projects.push({ id: 'project-2' });
  db.tasks.push({ id: 'task-project-1', idempotency_key: '["project-1","shared-key"]', remote_id: 'secret-remote', status: 'queued' });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'task-project-1', created_at: 1 });
  let calls = 0;

  const result = await submitTask({ ...input, projectId: 'project-2' }, taskEnv(db), 'shared-key', capabilities, fetch, async () => {
    calls += 1;
    return { taskId: 'remote-project-2' };
  });

  assert.equal(calls, 1);
  assert.equal(result.remote_id, 'remote-project-2');
  assert.equal(db.tasks.length, 2);
  assert.equal(db.tasks[1].idempotency_key, '["project-2","shared-key"]');
  assert.equal(db.projectTasks[1].project_id, 'project-2');
});

test('concurrent same-project submissions reserve once and make one paid Kling call', async () => {
  const db = new TaskDb();
  let calls = 0;
  let release;
  const paidCall = new Promise((resolve) => { release = resolve; });
  const tool = async () => {
    calls += 1;
    await paidCall;
    return { taskId: 'remote-race' };
  };

  const media = new RecoveryMedia();
  const first = submitTask(input, taskEnv(db, media), 'race-key', capabilities, fetch, tool);
  const second = submitTask(input, taskEnv(db, media), 'race-key', capabilities, fetch, tool);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(db.tasks.length, 1);
  assert.equal(db.tasks[0].status, 'submitting');
  release();
  const results = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(results[0].id, results[1].id);
  assert.deepEqual(results[0], { id: results[0].id, remote_id: 'remote-race', status: 'queued' });
  assert.deepEqual(results[1], { id: results[1].id, remote_id: null, status: 'submitting' });
});

test('reservation persistence failure prevents a paid call and returns a sanitized server error', async () => {
  const db = new TaskDb();
  db.failReservation = true;
  let calls = 0;

  await assert.rejects(
    () => submitTask(input, { DB: db }, 'persist-key', capabilities, fetch, async () => { calls += 1; }),
    (error) => error.status === 500 && error.message === '任务保存失败' && !error.message.includes('database'),
  );
  assert.equal(calls, 0);
  assert.deepEqual(db.tasks, []);
});

test('reservation mapping failure rolls back the task and prevents a paid call', async () => {
  const db = new TaskDb();
  db.failProjectTask = true;
  let calls = 0;

  await assert.rejects(
    () => submitTask(input, { DB: db }, 'mapping-key', capabilities, fetch, async () => { calls += 1; }),
    (error) => error.status === 500 && error.message === '任务保存失败',
  );
  assert.equal(calls, 0);
  assert.deepEqual(db.tasks, []);
  assert.deepEqual(db.projectTasks, []);
});

test('settings failure after core finalization replays the tracked remote task', async () => {
  const db = new TaskDb();
  db.failSettings = true;
  const media = new RecoveryMedia();
  let calls = 0;

  await assert.rejects(
    () => submitTask(input, taskEnv(db, media), 'settings-key', capabilities, fetch, async () => { calls += 1; return { taskId: 'remote-1' }; }),
    (error) => error.status === 500 && error.message === '项目设置保存失败',
  );
  db.failSettings = false;
  const replay = await submitTask(input, taskEnv(db, media), 'settings-key', capabilities, fetch, async () => { calls += 1; });

  assert.equal(calls, 1);
  assert.deepEqual(replay, { id: replay.id, remote_id: 'remote-1', status: 'queued' });
  assert.equal(db.settings.length, 1);
  assert.equal(media.objects.size, 0);
  assert.equal(media.deleted.length, 1);
});

test('same-timestamp newer task gets a monotonic settings version and repairs on replay', async () => {
  const originalNow = Date.now;
  Date.now = () => 10_000;
  try {
    const db = new TaskDb();
    const media = new RecoveryMedia();
    await submitTask({ ...input, prompt: 'prompt A' }, taskEnv(db, media), 'same-time-a', capabilities, fetch, async () => ({ taskId: 'remote-a' }));
    assert.equal(db.settings[0].updated_at, 1);
    db.failSettings = true;

    await assert.rejects(() => submitTask({ ...input, prompt: 'prompt B' }, taskEnv(db, media), 'same-time-b', capabilities, fetch, async () => ({ taskId: 'remote-b' })));
    const record = JSON.parse([...media.objects.values()][0]);
    assert.equal(record.settingsVersion, 2);
    assert.equal(db.settings[0].updated_at, 1);
    db.failSettings = false;

    const replay = await submitTask({ ...input, prompt: 'prompt B' }, taskEnv(db, media), 'same-time-b', capabilities, fetch, async () => { throw new Error('provider must not run'); });
    assert.equal(replay.remote_id, 'remote-b');
    assert.equal(db.settings[0].updated_at, 2);
    assert.equal(JSON.parse(db.settings[0].settings_json).prompt, 'prompt B');
    assert.equal(media.objects.size, 0);
  } finally {
    Date.now = originalNow;
  }
});

test('concurrent tasks atomically allocate distinct versions and higher recovery wins', async () => {
  const db = new TaskDb();
  const media = new RecoveryMedia();
  const releases = new Map();
  let calls = 0;
  const tool = async (_env, _name, args) => {
    calls += 1;
    const prompt = args.arguments.find(({ name }) => name === 'prompt').value;
    await new Promise((resolve) => releases.set(prompt, resolve));
    return { taskId: `remote-${prompt}` };
  };

  const taskAInput = { ...input, prompt: 'A' };
  const taskBInput = { ...input, prompt: 'B' };
  const taskA = submitTask(taskAInput, taskEnv(db, media), 'atomic-a', capabilities, fetch, tool);
  const taskB = submitTask(taskBInput, taskEnv(db, media), 'atomic-b', capabilities, fetch, tool);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(db.settingsVersions.get('project-1'), 2);
  const reservedVersions = db.tasks.map(({ request_json }) => JSON.parse(request_json).settingsVersion).sort();
  assert.deepEqual(reservedVersions, [1, 2]);

  media.failDeletesRemaining = 1;
  releases.get('A')();
  await taskA;
  db.failSettings = true;
  releases.get('B')();
  await assert.rejects(taskB, /项目设置保存失败/);
  db.failSettings = false;

  const replayB = await submitTask(taskBInput, taskEnv(db, media), 'atomic-b', capabilities, fetch, async () => { throw new Error('provider must not run'); });
  const replayA = await submitTask(taskAInput, taskEnv(db, media), 'atomic-a', capabilities, fetch, async () => { throw new Error('provider must not run'); });

  assert.equal(calls, 2);
  assert.equal(replayB.remote_id, 'remote-B');
  assert.equal(replayA.remote_id, 'remote-A');
  assert.equal(db.settings[0].updated_at, 2);
  assert.equal(JSON.parse(db.settings[0].settings_json).prompt, 'B');
  assert.equal(media.objects.size, 0);
});

test('reverse completion keeps higher-version settings when version 2 saves before version 1', async () => {
  const db = new TaskDb();
  const media = new RecoveryMedia();
  const releases = new Map();
  const tool = async (_env, _name, args) => {
    const prompt = args.arguments.find(({ name }) => name === 'prompt').value;
    await new Promise((resolve) => releases.set(prompt, resolve));
    return { taskId: `remote-${prompt}` };
  };
  const taskA = submitTask({ ...input, prompt: 'A' }, taskEnv(db, media), 'reverse-a', capabilities, fetch, tool);
  const taskB = submitTask({ ...input, prompt: 'B' }, taskEnv(db, media), 'reverse-b', capabilities, fetch, tool);
  await new Promise((resolve) => setTimeout(resolve, 0));

  releases.get('B')();
  await taskB;
  releases.get('A')();
  await taskA;

  assert.equal(db.settings[0].updated_at, 2);
  assert.equal(JSON.parse(db.settings[0].settings_json).prompt, 'B');
});

test('stale recovery write cannot overwrite newer settings inserted after its pre-check', async () => {
  const db = new TaskDb();
  const media = new RecoveryMedia();
  db.failSettings = true;
  await assert.rejects(() => submitTask({ ...input, prompt: 'A' }, taskEnv(db, media), 'toctou-a', capabilities, fetch, async () => ({ taskId: 'remote-a' })));
  db.failSettings = false;
  db.afterSettingsRead = () => {
    db.settings = [{ project_id: 'project-1', settings_json: JSON.stringify({ prompt: 'B' }), updated_at: 2 }];
  };

  await submitTask({ ...input, prompt: 'A' }, taskEnv(db, media), 'toctou-a', capabilities, fetch, async () => { throw new Error('provider must not run'); });

  assert.equal(db.settings[0].updated_at, 2);
  assert.equal(JSON.parse(db.settings[0].settings_json).prompt, 'B');
  assert.equal(media.objects.size, 0);
});

test('replaying an older queued task does not roll back newer project settings', async () => {
  const db = new TaskDb();
  const media = new RecoveryMedia();
  let calls = 0;
  const taskAInput = { ...input, prompt: 'prompt A' };
  const taskBInput = { ...input, prompt: 'prompt B', duration: 5 };

  const taskA = await submitTask(taskAInput, taskEnv(db, media), 'key-a', capabilities, fetch, async () => { calls += 1; return { taskId: 'remote-a' }; });
  await submitTask(taskBInput, taskEnv(db, media), 'key-b', capabilities, fetch, async () => { calls += 1; return { taskId: 'remote-b' }; });
  const settingsBeforeReplay = db.settings[0].settings_json;
  const replay = await submitTask(taskAInput, taskEnv(db, media), 'key-a', capabilities, fetch, async () => { calls += 1; });

  assert.deepEqual(replay, taskA);
  assert.equal(calls, 2);
  assert.equal(db.settings[0].settings_json, settingsBeforeReplay);
  assert.equal(JSON.parse(db.settings[0].settings_json).prompt, 'prompt B');
});

test('stale recovery cleanup does not overwrite newer project settings', async () => {
  const db = new TaskDb();
  const media = new RecoveryMedia();
  media.failDeletesRemaining = 1;
  const taskAInput = { ...input, prompt: 'prompt A' };
  const taskBInput = { ...input, prompt: 'prompt B' };

  const taskA = await submitTask(taskAInput, taskEnv(db, media), 'stale-a', capabilities, fetch, async () => ({ taskId: 'remote-stale-a' }));
  const staleRecord = JSON.parse([...media.objects.values()][0]);
  await submitTask(taskBInput, taskEnv(db, media), 'stale-b', capabilities, fetch, async () => ({ taskId: 'remote-stale-b' }));
  db.settings[0].updated_at = staleRecord.settingsVersion + 1;
  const settingsBeforeReplay = db.settings[0].settings_json;

  const replay = await submitTask(taskAInput, taskEnv(db, media), 'stale-a', capabilities, fetch, async () => { throw new Error('provider must not run'); });

  assert.deepEqual(replay, taskA);
  assert.equal(db.settings[0].settings_json, settingsBeforeReplay);
  assert.equal(JSON.parse(db.settings[0].settings_json).prompt, 'prompt B');
  assert.equal(media.objects.size, 0);
});

test('core finalization retries transient database failures without another provider call', async () => {
  const db = new TaskDb();
  db.finalizationFailuresRemaining = 2;
  let calls = 0;

  const result = await submitTask(input, taskEnv(db), 'retry-finalize', capabilities, fetch, async () => { calls += 1; return { taskId: 'remote-retry' }; });

  assert.equal(calls, 1);
  assert.equal(db.finalizationAttempts, 3);
  assert.deepEqual(result, { id: result.id, remote_id: 'remote-retry', status: 'queued' });
});

test('persistent core finalization failure recovers from R2 on replay without another provider call', async () => {
  const db = new TaskDb();
  const media = new RecoveryMedia();
  db.finalizationFailuresRemaining = 3;
  let calls = 0;

  await assert.rejects(
    () => submitTask(input, taskEnv(db, media), 'recover-core', capabilities, fetch, async () => { calls += 1; return { taskId: 'remote-recover' }; }),
    (error) => error.status === 500 && error.message === '任务保存失败',
  );
  assert.equal(media.objects.size, 1);
  db.finalizationFailuresRemaining = 0;
  const replay = await submitTask(input, taskEnv(db, media), 'recover-core', capabilities, fetch, async () => { calls += 1; });

  assert.equal(calls, 1);
  assert.deepEqual(replay, { id: replay.id, remote_id: 'remote-recover', status: 'queued' });
  assert.equal(media.objects.size, 0);
  assert.equal(media.deleted.length, 1);
});

test('recovery record is minimal and excludes extra secrets or raw input data', async () => {
  const db = new TaskDb();
  const media = new RecoveryMedia();
  db.finalizationFailuresRemaining = 3;

  await assert.rejects(() => submitTask({ ...input, apiToken: 'secret-token', rawFile: [1, 2, 3] }, taskEnv(db, media), 'safe-recovery', capabilities, fetch, async () => ({ taskId: 'remote-safe', access_token: 'provider-secret' })));
  const record = JSON.parse([...media.objects.values()][0]);

  assert.deepEqual(Object.keys(record).sort(), ['id', 'idempotencyKey', 'phase', 'projectId', 'provider', 'remoteId', 'request', 'result', 'settings', 'settingsVersion', 'traceId']);
  assert.equal(record.provider, 'kling');
  assert.equal(typeof record.settingsVersion, 'number');
  assert.equal(record.remoteId, 'remote-safe');
  assert.deepEqual(record.result, { generationId: 'remote-safe' });
  assert.equal(JSON.stringify(record).includes('secret'), false);
  assert.equal(JSON.stringify(record).includes('rawFile'), false);
});

test('intent write failure is bounded and prevents a paid provider call', async () => {
  const db = new TaskDb();
  const media = new RecoveryMedia();
  media.failPutsRemaining = 3;
  let calls = 0;

  await assert.rejects(
    () => submitTask(input, taskEnv(db, media), 'recovery-put-fail', capabilities, fetch, async () => { calls += 1; return { taskId: 'remote-visible', secret: 'provider-secret' }; }),
    (error) => error.status === 503 && error.message === '任务恢复记录保存失败' && !JSON.stringify(error).includes('provider-secret'),
  );
  assert.equal(calls, 0);
  assert.equal(media.putAttempts, 3);
  assert.equal(db.tasks[0].status, 'failed');
});

test('database without batch support fails before a paid call or reservation write', async () => {
  const db = new TaskDb();
  db.batch = undefined;
  let calls = 0;

  await assert.rejects(
    () => submitTask(input, { DB: db }, 'no-batch', capabilities, fetch, async () => { calls += 1; }),
    (error) => error.status === 500 && error.message === '任务保存失败',
  );
  assert.equal(calls, 0);
  assert.deepEqual(db.tasks, []);
});

test('missing R2 image object returns a controlled server error before provider upload', async () => {
  const db = new TaskDb();
  db.upload = { object_key: 'references/missing' };
  const imageCapabilities = { image_to_video: { models: [{ model: 'kling-v1', arguments: capabilities.text_to_video.models[0].arguments }] } };
  let calls = 0;

  await assert.rejects(
    () => submitTask({ ...input, mode: 'image', uploadId: 'asset-1' }, { DB: db, MEDIA: { get: async () => null } }, 'missing-file', imageCapabilities, fetch, async () => { calls += 1; }),
    (error) => error.status === 500 && error.message === '参考图存储不可用',
  );
  assert.equal(calls, 0);
});

test('image storage read errors fail before any paid call', async () => {
  const db = new TaskDb(); db.upload = { object_key: 'references/unavailable' };
  const imageCapabilities = { image_to_video: { models: [{ model: 'kling-v1', arguments: capabilities.text_to_video.models[0].arguments }] } };
  let calls = 0;
  await assert.rejects(() => submitTask({ ...input, mode: 'image', uploadId: 'asset-1' }, { DB: db, MEDIA: { get: async () => { throw new Error('secret storage detail'); } } }, 'storage-error', imageCapabilities, fetch, async () => { calls += 1; }),
    (error) => error.status === 500 && error.message === '参考图存储不可用');
  assert.equal(calls, 0);
  assert.equal(db.tasks[0].status, 'failed');
});

test('empty paid response is action-required rather than permanently submitting', async () => {
  const db = new TaskDb();
  await assert.rejects(() => submitTask(input, taskEnv(db), 'empty-response', capabilities, fetch, async () => null),
    (error) => error.task?.status === 'unknown');
  assert.equal(db.tasks[0].status, 'unknown');
});

test('provider response loss is marked unknown and returned as a sanitized gateway error', async () => {
  const db = new TaskDb();

  await assert.rejects(
    () => submitTask(input, taskEnv(db), 'provider-failure', capabilities, fetch, async () => { throw new Error('provider secret response'); }),
    (error) => error.status === 502 && error.task?.status === 'unknown' && !error.message.includes('secret'),
  );
  assert.equal(db.tasks[0].status, 'unknown');
});

test('provider success without a task id remains unknown', async () => {
  const db = new TaskDb();

  await assert.rejects(
    () => submitTask(input, taskEnv(db), 'malformed-provider', capabilities, fetch, async () => ({ status: 'accepted' })),
    (error) => error.status === 502 && error.task?.status === 'unknown',
  );
  assert.equal(db.tasks[0].status, 'unknown');
  assert.equal(db.tasks[0].remote_id, null);
});

test('image task cannot use an upload associated with another project', async () => {
  const db = new TaskDb();
  db.projects.push({ id: 'project-2' });
  let calls = 0;
  const imageCapabilities = {
    image_to_video: { models: [{ model: 'kling-v1', arguments: capabilities.text_to_video.models[0].arguments }] },
  };

  await assert.rejects(
    () => submitTask({ ...input, projectId: 'project-2', mode: 'image', uploadId: 'asset-project-1' }, { DB: db }, 'image-key', imageCapabilities, fetch, async () => { calls += 1; }),
    { message: '参考图不存在' },
  );
  assert.equal(calls, 0);
});

test('task rejects a missing or invalid project before calling Kling', async () => {
  for (const projectId of [undefined, 'missing']) {
    const db = new TaskDb();
    let calls = 0;
    await assert.rejects(
      () => submitTask({ ...input, projectId }, { DB: db }, `key-${projectId}`, capabilities, fetch, async () => { calls += 1; }),
      { message: projectId ? '请选有效项目' : '请选择项目' },
    );
    assert.equal(calls, 0);
    assert.deepEqual(db.tasks, []);
  }
});

test('task links the generated task and saves a serializable settings snapshot', async () => {
  const db = new TaskDb();
  const calls = [];
  const result = await submitTask(input, taskEnv(db), 'key-1', capabilities, fetch, async (_env, name, args) => {
    calls.push({ name, args });
    return { taskId: 'remote-1' };
  });

  assert.equal(result.status, 'queued');
  assert.deepEqual(calls.map(({ name }) => name), ['text_to_video']);
  assert.deepEqual(db.projectTasks, [{ project_id: 'project-1', task_id: result.id, created_at: db.projectTasks[0].created_at }]);
  assert.equal(db.settings[0].project_id, 'project-1');
  assert.deepEqual(JSON.parse(db.settings[0].settings_json), {
    mode: 'text', model: 'kling-v1', prompt: 'ocean at dawn', uploadId: null, duration: '5', resolution: '720p', aspectRatio: '16:9', imageCount: '1',
  });
  assert.equal(db.batchCount, 1);
  assert.doesNotThrow(() => JSON.stringify(JSON.parse(db.settings[0].settings_json)));
});

test('fresh task injects a provider factory and snapshots the project provider', async () => {
  const db = new TaskDb(); const media = new RecoveryMedia();
  db.projects[0].video_provider = 'custom';
  let created = 0; let intent;
  const providerFactory = (id, env) => {
    assert.equal(id, 'custom'); assert.equal(env.DB, db);
    return { id, persistOutput: false, capabilities: async () => capabilities, create: async ({ input: valid, reference, traceId }) => {
      created += 1; assert.equal(valid.duration, '5'); assert.equal(reference, undefined);
      intent = JSON.parse(media.objects.get(`task-recovery/${db.tasks[0].id}.json`));
      assert.equal(intent.traceId, traceId);
      return { remoteId: 'custom-remote', status: 'queued', raw: { privateProviderResult: true } };
    } };
  };
  const result = await submitTask(input, taskEnv(db, media), 'factory', { providerFactory });
  assert.equal(created, 1); assert.equal(result.remote_id, 'custom-remote');
  assert.equal(db.tasks[0].provider, 'custom'); assert.equal(intent.provider, 'custom');
  assert.match(db.queries.find(({ sql }) => sql.includes('FROM projects')).sql, /SELECT id, video_provider/);
});

test('legacy project provider defaults to Kling for fresh tasks', async () => {
  const db = new TaskDb();
  await submitTask(input, taskEnv(db), 'legacy-provider', { providerFactory: (id) => {
    assert.equal(id, 'kling');
    return { id, capabilities: async () => capabilities, create: async () => ({ remoteId: 'legacy-remote', status: 'queued', raw: {} }) };
  } });
  assert.equal(db.tasks[0].provider, 'kling');
});

test('replay with an existing remote ID never instantiates or creates the current project provider', async () => {
  const db = new TaskDb(); db.projects[0].video_provider = 'different';
  db.tasks.push({ id: 'stored', provider: 'kling', idempotency_key: '["project-1","stored-key"]', remote_id: 'paid-remote', status: 'submitting' });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'stored' });
  const replay = await submitTask(input, taskEnv(db), 'stored-key', { providerFactory: () => { assert.fail('replay must not create a provider'); } });
  assert.equal(replay.remote_id, 'paid-remote');
  assert.equal(db.tasks.length, 1);
});

test('polling uses the saved task provider after the project switches providers', async () => {
  const db = new TaskDb(); db.projects[0].video_provider = 'different';
  db.tasks.push({ id: 'poll-provider', provider: 'custom', remote_id: 'paid-remote', status: 'queued' });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'poll-provider' });
  const result = await getTaskStatus('poll-provider', 'project-1', taskEnv(db), { providerFactory: (id) => {
    assert.equal(id, 'custom');
    return { id, create: async () => { assert.fail('polling must never create'); }, query: async (remoteId) => {
      assert.equal(remoteId, 'paid-remote'); return { status: 'succeeded', raw: { url: 'https://cdn.test/custom.mp4' }, outputUrl: 'https://cdn.test/custom.mp4' };
    } };
  } });
  assert.equal(result.status, 'succeeded');
  assert.equal(JSON.parse(result.resultJson).url, 'https://cdn.test/custom.mp4');
});

test('polling legacy tasks defaults to Kling independently of the project provider', async () => {
  const db = new TaskDb(); db.projects[0].video_provider = 'different';
  db.tasks.push({ id: 'legacy-poll', remote_id: 'legacy-remote', status: 'queued' });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'legacy-poll' });
  await getTaskStatus('legacy-poll', 'project-1', taskEnv(db), { providerFactory: (id) => {
    assert.equal(id, 'kling'); return { query: async () => ({ status: 'generating', raw: { status: 'RUNNING' } }) };
  } });
  assert.equal(db.tasks[0].status, 'generating');
});

test('accepted recovery follows the stored provider even when the project changes', async () => {
  const db = new TaskDb(); const media = new RecoveryMedia(); db.projects[0].video_provider = 'different';
  db.tasks.push({ id: 'recover-provider', provider: 'custom', idempotency_key: '["project-1","recover-provider"]', remote_id: null, status: 'submitting' });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'recover-provider' });
  media.objects.set('task-recovery/recover-provider.json', JSON.stringify({ id: 'recover-provider', projectId: 'project-1', provider: 'custom', settings: {}, settingsVersion: 1, remoteId: 'known-paid', result: { generationId: 'known-paid' } }));
  const replay = await submitTask(input, taskEnv(db, media), 'recover-provider', { providerFactory: () => { assert.fail('accepted replay must not create'); } });
  assert.equal(replay.remote_id, 'known-paid'); assert.equal(db.tasks[0].provider, 'custom');
});

test('recovery provider mismatch is rejected before attaching a remote ID', async () => {
  const db = new TaskDb(); const media = new RecoveryMedia();
  db.tasks.push({ id: 'mismatch-provider', provider: 'custom', idempotency_key: '["project-1","mismatch-provider"]', remote_id: null, status: 'submitting' });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'mismatch-provider' });
  media.objects.set('task-recovery/mismatch-provider.json', JSON.stringify({ id: 'mismatch-provider', projectId: 'project-1', provider: 'kling', settings: {}, settingsVersion: 1, remoteId: 'wrong-provider-remote', result: {} }));
  await assert.rejects(() => submitTask(input, taskEnv(db, media), 'mismatch-provider', { providerFactory: () => { assert.fail('replay must not create'); } }), { message: '任务恢复记录无效' });
  assert.equal(db.tasks[0].remote_id, null);
});

test('injected provider ambiguous error remains unknown and replay makes no second paid call', async () => {
  const db = new TaskDb(); const env = taskEnv(db); let creates = 0;
  const options = { providerFactory: () => ({ id: 'kling', capabilities: async () => capabilities, create: async () => { creates += 1; throw new Error('raw secret provider failure'); } }) };
  await assert.rejects(() => submitTask(input, env, 'injected-unknown', options), (error) => error.task?.status === 'unknown' && !error.message.includes('secret'));
  const replay = await submitTask(input, env, 'injected-unknown', options);
  assert.equal(replay.status, 'unknown'); assert.equal(creates, 1);
});

test('injected provider without a remote ID remains unknown', async () => {
  const db = new TaskDb();
  await assert.rejects(() => submitTask(input, taskEnv(db), 'injected-empty', { providerFactory: () => ({ id: 'kling', capabilities: async () => capabilities, create: async () => ({ status: 'queued', raw: {} }) }) }), (error) => error.task?.status === 'unknown');
});

test('non-Error provider rejection still marks a paid submission unknown', async () => {
  for (const reason of [null, undefined, 'raw secret rejection']) {
    const db = new TaskDb();
    await assert.rejects(() => submitTask(input, taskEnv(db), 'untyped-rejection', { providerFactory: () => ({ id: 'kling', capabilities: async () => capabilities, create: async () => { throw reason; } }) }), (error) => error.task?.status === 'unknown' && !error.message.includes('secret'));
    assert.equal(db.tasks[0].status, 'unknown');
  }
});

test('TaskError supports coded positional and options forms without changing legacy calls', () => {
  const task = { id: 'task-1', status: 'failed' };
  const legacy = new taskApi.TaskError('旧错误', 400, task);
  assert.equal(legacy.status, 400); assert.deepEqual(legacy.task, task); assert.equal(legacy.code, undefined);
  const coded = new taskApi.TaskError('明确错误', 409, task, 'PROVIDER_UNAVAILABLE');
  assert.equal(coded.code, 'PROVIDER_UNAVAILABLE');
  const options = new taskApi.TaskError({ message: '明确错误', status: 409, code: 'PROVIDER_UNAVAILABLE', task });
  assert.equal(options.message, '明确错误'); assert.equal(options.status, 409);
  assert.equal(options.code, 'PROVIDER_UNAVAILABLE'); assert.deepEqual(options.task, task);
});

function minimaxPollingTask(db, status = 'queued') {
  db.tasks.push({ id: 'minimax-poll', provider: 'minimax', remote_id: 'minimax-remote', status, result_json: '{"task_id":"minimax-remote"}' });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'minimax-poll' });
  return db.tasks[0];
}

const miniMaxQueryResult = { status: 'succeeded', raw: { id: 'minimax-remote', status: 'succeeded', content: { url: 'https://cdn.test/minimax.mp4' } }, outputUrl: 'https://cdn.test/minimax.mp4' };

test('MiniMax succeeds only after output persistence and exposes the internal playback URL', async () => {
  const db = new TaskDb(); const task = minimaxPollingTask(db); const media = new RecoveryMedia();
  let factories = 0; let downloads = 0; let storedKey;
  media.put = async (key, body, options) => {
    assert.equal(task.status, 'queued', 'success must wait for R2');
    assert.equal(db.taskOutputs.length, 0);
    assert.match(key, /^outputs\/minimax-poll\/[0-9a-f-]{36}\.mp4$/);
    storedKey = key;
    assert.ok(body instanceof ReadableStream);
    assert.equal(options.httpMetadata.contentType, 'video/mp4');
    return { size: (await new Response(body).arrayBuffer()).byteLength };
  };
  const options = {
    providerFactory: (id) => { factories += 1; assert.equal(id, 'minimax'); return { id, persistOutput: true, query: async () => miniMaxQueryResult }; },
    fetcher: async (url) => { downloads += 1; assert.equal(task.status, 'queued'); assert.equal(url, miniMaxQueryResult.outputUrl); return new Response('video', { headers: { 'content-type': 'video/mp4', 'content-length': '5' } }); },
  };
  const result = await getTaskStatus(task.id, 'project-1', taskEnv(db, media), options);
  assert.equal(factories, 1); assert.equal(downloads, 1);
  assert.equal(db.taskOutputs.length, 1);
  assert.equal(db.taskOutputs[0].object_key, storedKey);
  assert.equal(task.status, 'succeeded');
  assert.deepEqual(JSON.parse(result.resultJson), { providerResult: miniMaxQueryResult.raw, videoUrl: '/api/projects/project-1/tasks/minimax-poll/output' });
  assert.equal(task.result_json, result.resultJson);
});

test('MiniMax output persistence failures retain polling status and a later poll retries successfully', async () => {
  for (const status of ['queued', 'generating']) {
    const db = new TaskDb(); const task = minimaxPollingTask(db, status); const oldResult = task.result_json;
    let fail = true; let downloads = 0;
    const media = { put: async (_key, body) => { if (fail) throw new Error('outputs/minimax-poll.mp4 provider private storage error'); return { size: (await new Response(body).arrayBuffer()).byteLength }; } };
    const options = { providerFactory: () => ({ persistOutput: true, query: async () => miniMaxQueryResult }), fetcher: async () => { downloads += 1; return new Response('video', { headers: { 'content-type': 'video/mp4' } }); } };
    await assert.rejects(() => getTaskStatus(task.id, 'project-1', taskEnv(db, media), options), (error) => {
      assert.ok(error instanceof taskApi.TaskError); assert.equal(error.status, 503); assert.equal(error.code, 'output_persist_failed');
      assert.doesNotMatch(error.message, /outputs\/|https:|private/);
      return true;
    });
    assert.equal(task.status, status); assert.equal(task.result_json, oldResult); assert.equal(db.taskOutputs.length, 0);
    fail = false;
    const result = await getTaskStatus(task.id, 'project-1', taskEnv(db, media), options);
    assert.equal(result.status, 'succeeded'); assert.equal(downloads, 2); assert.equal(db.taskOutputs.length, 1);
  }
});

test('MiniMax success without an output URL stays retryable and never marks success', async () => {
  const db = new TaskDb(); const task = minimaxPollingTask(db, 'generating');
  await assert.rejects(() => getTaskStatus(task.id, 'project-1', taskEnv(db), { providerFactory: () => ({ persistOutput: true, query: async () => ({ ...miniMaxQueryResult, outputUrl: null }) }), fetcher: () => assert.fail('missing URL must not download') }), { status: 503, code: 'output_persist_failed' });
  assert.equal(task.status, 'generating'); assert.equal(db.taskOutputs.length, 0);
});

test('MiniMax status retry reuses an already persisted output without downloading again', async () => {
  const db = new TaskDb(); const task = minimaxPollingTask(db);
  db.taskOutputs.push({ id: 'existing', task_id: task.id, object_key: 'outputs/minimax-poll.mp4', content_type: 'video/mp4' });
  const media = { put: () => assert.fail('existing output must not be written again') };
  const result = await getTaskStatus(task.id, 'project-1', taskEnv(db, media), { providerFactory: () => ({ persistOutput: true, query: async () => miniMaxQueryResult }), fetcher: () => assert.fail('existing output must not be downloaded again') });
  assert.equal(result.status, 'succeeded');
  assert.equal(JSON.parse(result.resultJson).videoUrl, '/api/projects/project-1/tasks/minimax-poll/output');
  assert.equal(db.taskOutputs.length, 1);
});

test('MiniMax completes an already persisted output even when the supplier URL is unavailable', async () => {
  for (const outputUrl of [null, undefined, '', 'invalid-url', 'http://expired.test/clip.mp4']) {
    const db = new TaskDb(); const task = minimaxPollingTask(db, 'generating');
    db.taskOutputs.push({ id: 'existing', task_id: task.id, object_key: 'outputs/minimax-poll.mp4', content_type: 'video/mp4' });
    const raw = { id: 'minimax-remote', status: 'succeeded' };
    const media = { put: () => assert.fail('existing output must not write R2'), get: () => assert.fail('existing output must not read R2') };
    const result = await getTaskStatus(task.id, 'project-1', taskEnv(db, media), {
      providerFactory: () => ({ persistOutput: true, query: async () => ({ status: 'succeeded', raw, outputUrl }) }),
      fetcher: () => assert.fail('existing output must not download again'),
    });
    assert.equal(result.status, 'succeeded'); assert.equal(task.status, 'succeeded');
    assert.deepEqual(JSON.parse(result.resultJson), { providerResult: raw, videoUrl: '/api/projects/project-1/tasks/minimax-poll/output' });
    assert.equal(task.result_json, result.resultJson); assert.equal(db.taskOutputs.length, 1);
  }
});

test('MiniMax non-success queries update normally without persisting an output', async () => {
  for (const status of ['failed', 'queued', 'generating']) {
    const db = new TaskDb(); const task = minimaxPollingTask(db);
    const result = await getTaskStatus(task.id, 'project-1', taskEnv(db, { put: () => assert.fail('non-success must not persist') }), { providerFactory: () => ({ persistOutput: true, query: async () => ({ status, raw: { status } }) }), fetcher: () => assert.fail('non-success must not download') });
    assert.equal(result.status, status); assert.deepEqual(JSON.parse(result.resultJson), { status });
  }
});

test('Kling external result handling is unchanged with persistence disabled', async () => {
  const db = new TaskDb(); db.tasks.push({ id: 'kling-poll', provider: 'kling', remote_id: 'kling-remote', status: 'queued' });
  db.projectTasks.push({ project_id: 'project-1', task_id: 'kling-poll' });
  const raw = { works: [{ contentType: 'video', url: 'https://kling.test/clip.mp4' }] };
  const result = await getTaskStatus('kling-poll', 'project-1', taskEnv(db, { put: () => assert.fail('Kling must not persist output') }), { providerFactory: () => ({ persistOutput: false, query: async () => ({ status: 'succeeded', raw, outputUrl: raw.works[0].url }) }), fetcher: () => assert.fail('Kling must not download output') });
  assert.deepEqual(JSON.parse(result.resultJson), raw); assert.equal(result.status, 'succeeded'); assert.equal(db.taskOutputs.length, 0);
});

test('polling preserves safe ProviderError codes without exposing supplier error text', async () => {
  for (const code of ['provider_auth_failed', 'provider_not_configured', 'provider_unavailable', 'invalid_response']) {
    const db = new TaskDb(); const task = minimaxPollingTask(db);
    await assert.rejects(() => getTaskStatus(task.id, 'project-1', taskEnv(db), { providerFactory: () => ({ query: async () => { const error = new ProviderError(code); error.message = 'raw supplier secret'; throw error; } }) }), (error) => {
      assert.equal(error.code, code); assert.ok(error instanceof taskApi.TaskError); assert.equal(error.status, 503); assert.equal(error.message, '任务状态暂不可用'); return true;
    });
    assert.equal(task.status, 'queued');
  }
});

test('definitive MiniMax create errors fail the task with useful safe Chinese messages and codes', async () => {
  const cases = {
    provider_not_configured: '请配置 MiniMax API Key',
    provider_auth_failed: 'MiniMax 认证失败，请检查服务端配置',
    insufficient_balance: 'MiniMax 额度不足，请前往控制台查看',
    invalid_parameters: 'MiniMax 生成参数或参考图无效',
    provider_unavailable: 'MiniMax 暂不可用，请稍后重试',
  };
  for (const [code, message] of Object.entries(cases)) {
    const db = new TaskDb(); db.projects[0].video_provider = 'minimax';
    await assert.rejects(() => submitTask(input, taskEnv(db), `minimax-create-${code}`, { providerFactory: () => ({ id: 'minimax', capabilities: async () => capabilities, create: async () => { const error = new ProviderError(code, { definitive: true, submissionState: 'failed' }); error.message = 'raw supplier secret'; throw error; } }) }), (error) => {
      assert.ok(error instanceof taskApi.TaskError); assert.equal(error.message, message); assert.equal(error.code, code); assert.equal(error.task.status, 'failed'); return true;
    });
    assert.equal(db.tasks[0].status, 'failed');
  }
});

test('ambiguous MiniMax submission preserves the safe error code and remains unknown', async () => {
  const db = new TaskDb(); db.projects[0].video_provider = 'minimax';
  await assert.rejects(() => submitTask(input, taskEnv(db), 'minimax-create-unknown', { providerFactory: () => ({ id: 'minimax', capabilities: async () => capabilities, create: async () => { throw new ProviderError('provider_unavailable', { submissionState: 'unknown' }); } }) }), (error) => error.code === 'provider_unavailable' && error.task.status === 'unknown');
});

test('provider construction and capability errors preserve safe codes through TaskError', async () => {
  for (const phase of ['factory', 'capabilities']) {
    const db = new TaskDb(); db.projects[0].video_provider = 'minimax';
    const fail = () => { throw new ProviderError('provider_not_configured'); };
    const options = { providerFactory: phase === 'factory' ? fail : () => ({ id: 'minimax', capabilities: fail }) };
    await assert.rejects(() => submitTask(input, taskEnv(db), `configuration-${phase}`, options), (error) => error instanceof taskApi.TaskError && error.code === 'provider_not_configured' && error.status === 503);
    assert.equal(db.tasks.length, 0);
  }
});

test('polling drops unrecognized supplier codes instead of exposing raw supplier text', async () => {
  const db = new TaskDb(); const task = minimaxPollingTask(db);
  await assert.rejects(() => getTaskStatus(task.id, 'project-1', taskEnv(db), { providerFactory: () => ({ query: async () => { const error = new Error('secret supplier message'); error.code = 'https://supplier.test/private?secret=token'; throw error; } }) }), (error) => error.code === undefined && error.message === '任务状态暂不可用');
});

test('MiniMax output database insertion failure never reports success and can retry', async () => {
  const db = new TaskDb(); const task = minimaxPollingTask(db, 'generating'); db.failOutputInsert = true;
  const media = { put: async (_key, body) => ({ size: (await new Response(body).arrayBuffer()).byteLength }) };
  const options = { providerFactory: () => ({ persistOutput: true, query: async () => miniMaxQueryResult }), fetcher: async () => new Response('video', { headers: { 'content-type': 'video/mp4' } }) };
  await assert.rejects(() => getTaskStatus(task.id, 'project-1', taskEnv(db, media), options), { status: 503, code: 'output_persist_failed' });
  assert.equal(task.status, 'generating'); assert.equal(db.taskOutputs.length, 0);
  db.failOutputInsert = false;
  const result = await getTaskStatus(task.id, 'project-1', taskEnv(db, media), options);
  assert.equal(result.status, 'succeeded'); assert.equal(db.taskOutputs.length, 1);
});
