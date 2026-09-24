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

class TaskDb {
  constructor() {
    this.projects = [{ id: 'project-1' }];
    this.tasks = [];
    this.projectTasks = [];
    this.settings = [];
    this.batchCount = 0;
  }

  prepare(sql) {
    const db = this;
    const statement = {
      sql,
      values: [],
      bind(...values) { return { ...statement, values }; },
      async first() {
        if (sql.includes('FROM video_tasks')) return db.tasks.find(({ idempotency_key }) => idempotency_key === this.values[0]) ?? null;
        if (sql.includes('FROM projects')) return db.projects.find(({ id }) => id === this.values[0]) ?? null;
        if (sql.includes('FROM stored_objects')) return null;
        throw new Error(`Unexpected first query: ${sql}`);
      },
      async run() {
        const values = this.values;
        if (sql.startsWith('INSERT INTO video_tasks')) db.tasks.push({ id: values[0], idempotency_key: values[1], request_json: values[5] });
        else if (sql.startsWith('INSERT INTO project_tasks')) db.projectTasks.push({ project_id: values[0], task_id: values[1], created_at: values[2] });
        else if (sql.startsWith('INSERT INTO project_settings')) db.settings = [{ project_id: values[0], settings_json: values[1], updated_at: values[2] }];
        else throw new Error(`Unexpected run query: ${sql}`);
        return { success: true };
      },
    };
    return statement;
  }

  async batch(statements) {
    this.batchCount += 1;
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

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
  const result = await submitTask(input, { DB: db }, 'key-1', capabilities, fetch, async (_env, name, args) => {
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
