import test from 'node:test';
import assert from 'node:assert/strict';
import { submitTask } from '../src/tasks.js';

const capabilities = {
  text_to_video: {
    models: [{
      model: 'kling-v1',
      arguments: [
        { name: 'duration', allowedValues: ['5'] },
        { name: 'resolution', allowedValues: ['720p'] },
        { name: 'aspect_ratio', allowedValues: ['16:9'] },
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
    this.projects = [{ id: 'project-1' }];
    this.tasks = [];
    this.projectTasks = [];
    this.settings = [];
    this.batchCount = 0;
    this.queries = [];
    this.failReservation = false;
    this.failProjectTask = false;
    this.finalizationFailuresRemaining = 0;
    this.finalizationAttempts = 0;
    this.failSettings = false;
    this.upload = null;
  }

  prepare(sql) {
    const db = this;
    const statement = {
      sql,
      values: [],
      bind(...values) { return { ...statement, values }; },
      async first() {
        db.queries.push({ sql, values: this.values });
        if (sql.includes('JOIN project_tasks')) {
          const [idempotencyKey, projectId] = this.values;
          const taskIds = db.projectTasks.filter(({ project_id }) => project_id === projectId).map(({ task_id }) => task_id);
          return db.tasks.find(({ id, idempotency_key }) => idempotency_key === idempotencyKey && taskIds.includes(id)) ?? null;
        }
        if (sql.includes('FROM video_tasks')) return db.tasks.find(({ idempotency_key }) => idempotency_key === this.values[0]) ?? null;
        if (sql.includes('FROM project_settings')) return db.settings.find(({ project_id }) => project_id === this.values[0]) ?? null;
        if (sql.includes('FROM projects')) return db.projects.find(({ id }) => id === this.values[0]) ?? null;
        if (sql.includes('FROM stored_objects')) return db.upload;
        throw new Error(`Unexpected first query: ${sql}`);
      },
      async run() {
        const values = this.values;
        if (sql.startsWith('INSERT INTO video_tasks')) {
          if (db.tasks.some(({ idempotency_key }) => idempotency_key === values[1])) throw new Error('UNIQUE constraint failed: video_tasks.idempotency_key');
          db.tasks.push({ id: values[0], idempotency_key: values[1], remote_id: values[2], mode: values[3], status: values[4], request_json: values[5] });
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
        }
        else if (sql.startsWith('UPDATE video_tasks SET status')) {
          const task = db.tasks.find(({ id }) => id === values[2]);
          task.status = values[0];
        }
        else if (sql.startsWith('INSERT INTO project_tasks')) {
          if (db.failProjectTask) throw new Error('mapping unavailable');
          db.projectTasks.push({ project_id: values[0], task_id: values[1], created_at: values[2] });
        }
        else if (sql.startsWith('INSERT INTO project_settings')) {
          if (db.failSettings) throw new Error('settings unavailable');
          db.settings = [{ project_id: values[0], settings_json: values[1], updated_at: values[2] }];
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
  db.settings[0].updated_at = staleRecord.createdAt + 1;
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

  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'id', 'projectId', 'remoteId', 'result', 'settings']);
  assert.equal(typeof record.createdAt, 'number');
  assert.equal(record.remoteId, 'remote-safe');
  assert.deepEqual(record.result, { taskId: 'remote-safe' });
  assert.equal(JSON.stringify(record).includes('secret'), false);
  assert.equal(JSON.stringify(record).includes('rawFile'), false);
});

test('recovery write failure is bounded and returns the remote id without provider internals', async () => {
  const db = new TaskDb();
  const media = new RecoveryMedia();
  media.failPutsRemaining = 3;
  let calls = 0;

  await assert.rejects(
    () => submitTask(input, taskEnv(db, media), 'recovery-put-fail', capabilities, fetch, async () => { calls += 1; return { taskId: 'remote-visible', secret: 'provider-secret' }; }),
    (error) => error.status === 503 && error.message === '任务恢复记录保存失败' && error.task?.remote_id === 'remote-visible' && !JSON.stringify(error).includes('provider-secret'),
  );
  assert.equal(calls, 1);
  assert.equal(media.putAttempts, 3);
  assert.equal(db.tasks[0].status, 'submitting');
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

test('provider failure is marked failed and returned as a sanitized gateway error', async () => {
  const db = new TaskDb();

  await assert.rejects(
    () => submitTask(input, { DB: db }, 'provider-failure', capabilities, fetch, async () => { throw new Error('provider secret response'); }),
    (error) => error.status === 502 && error.message === '视频生成服务暂不可用' && !error.message.includes('secret'),
  );
  assert.equal(db.tasks[0].status, 'failed');
});

test('provider success without a task id is marked failed and rejected as malformed', async () => {
  const db = new TaskDb();

  await assert.rejects(
    () => submitTask(input, { DB: db }, 'malformed-provider', capabilities, fetch, async () => ({ status: 'accepted' })),
    (error) => error.status === 502 && error.message === '视频生成服务返回无效',
  );
  assert.equal(db.tasks[0].status, 'failed');
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
