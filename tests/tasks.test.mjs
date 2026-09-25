import test from 'node:test';
import assert from 'node:assert/strict';
import { submitTask, getTaskStatus } from '../src/tasks.js';

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
    this.projects = [{ id: 'project-1' }];
    this.tasks = [];
    this.projectTasks = [];
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
  }

  prepare(sql) {
    const db = this;
    const statement = {
      sql,
      values: [],
      bind(...values) { return { ...statement, values }; },
      async first() {
        db.queries.push({ sql, values: this.values });
        if (sql.startsWith('INSERT INTO project_settings_versions')) {
          const projectId = this.values[0];
          const version = (db.settingsVersions.get(projectId) || 0) + 1;
          db.settingsVersions.set(projectId, version);
          return { version };
        }
        if (sql.includes('JOIN project_tasks')) {
          if (sql.includes('video_tasks.id = ?')) {
            const [taskId, projectId] = this.values;
            return db.projectTasks.some(({ task_id, project_id }) => task_id === taskId && project_id === projectId)
              ? db.tasks.find(({ id }) => id === taskId) ?? null : null;
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
          task.result_json = values[2];
        }
        else if (sql.startsWith('UPDATE video_tasks SET status')) {
          const task = db.tasks.find(({ id }) => id === (sql.includes('result_json') ? values[3] : values[2]));
          const guardedOrphanUpdate = sql.includes('remote_id IS NULL');
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

  assert.deepEqual(Object.keys(record).sort(), ['id', 'idempotencyKey', 'phase', 'projectId', 'remoteId', 'request', 'result', 'settings', 'settingsVersion', 'traceId']);
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
