import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureDefaultProject, normalizeProjectName } from '../src/projects.js';

test('normalizes project names by trimming surrounding whitespace', () => {
  assert.equal(normalizeProjectName('  项目 A  '), '项目 A');
});

test('rejects blank project names', () => {
  assert.throws(() => normalizeProjectName(' \n\t '), { message: '项目名称不能为空' });
});

test('rejects project names longer than 60 characters', () => {
  assert.throws(() => normalizeProjectName('a'.repeat(61)), { message: '项目名称不能超过60个字符' });
});

class FakeD1 {
  constructor() {
    this.projects = [];
    this.storedObjects = [];
    this.videoTasks = [];
    this.projectAssets = [];
    this.projectTasks = [];
    this.runs = [];
    this.failAssetBackfillOnce = false;
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...values) {
        return {
          async first() {
            if (sql.includes('FROM projects')) {
              return [...db.projects].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0] ?? null;
            }
            throw new Error(`Unexpected first query: ${sql}`);
          },
          async run() {
            db.runs.push({ sql, values });
            if (sql.startsWith('INSERT OR IGNORE INTO projects') && !db.projects.some(({ id }) => id === values[0])) {
              db.projects.push({
                id: values[0],
                name: values[1],
                created_at: values[2],
                updated_at: values[3],
              });
            }
            if (sql.startsWith('INSERT OR IGNORE INTO project_assets')) {
              if (db.failAssetBackfillOnce) {
                db.failAssetBackfillOnce = false;
                throw new Error('simulated asset backfill failure');
              }
              for (const object of db.storedObjects) {
                if (!db.projectAssets.some(({ object_id }) => object_id === object.id)) {
                  db.projectAssets.push({ project_id: values[0], object_id: object.id, created_at: object.created_at });
                }
              }
            }
            if (sql.startsWith('INSERT OR IGNORE INTO project_tasks')) {
              for (const task of db.videoTasks) {
                if (!db.projectTasks.some(({ task_id }) => task_id === task.id)) {
                  db.projectTasks.push({ project_id: values[0], task_id: task.id, created_at: task.created_at });
                }
              }
            }
            return { success: true };
          },
        };
      },
      async first() {
        if (sql.includes('FROM projects')) {
          return [...db.projects].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0] ?? null;
        }
        throw new Error(`Unexpected first query: ${sql}`);
      },
    };
  }
}

test('creates and returns one default project idempotently', async () => {
  const db = new FakeD1();
  db.storedObjects.push({ id: 'object-1', created_at: 101 });
  db.videoTasks.push({ id: 'task-1', created_at: 202 });

  const created = await ensureDefaultProject(db, () => 'project-default', 1234);
  const existing = await ensureDefaultProject(db, () => 'must-not-be-used', 9999);

  assert.deepEqual(created, {
    id: 'project-default',
    name: '未分类项目',
    created_at: 1234,
    updated_at: 1234,
  });
  assert.deepEqual(existing, created);
  assert.equal(db.runs.filter(({ sql }) => sql.includes('INTO projects')).length, 1);
  assert.deepEqual(db.projectAssets, [{ project_id: 'project-default', object_id: 'object-1', created_at: 101 }]);
  assert.deepEqual(db.projectTasks, [{ project_id: 'project-default', task_id: 'task-1', created_at: 202 }]);
});

test('returns the earliest existing project without creating a default', async () => {
  const db = new FakeD1();
  db.projects.push(
    { id: 'newer', name: '新项目', created_at: 20, updated_at: 20 },
    { id: 'older', name: '旧项目', created_at: 10, updated_at: 10 },
  );

  const project = await ensureDefaultProject(db, () => 'unused', 30);

  assert.equal(project.id, 'older');
  assert.equal(db.runs.filter(({ sql }) => sql.includes('project_assets')).length, 1);
  assert.equal(db.runs.filter(({ sql }) => sql.includes('project_tasks')).length, 1);
});

test('repairs incomplete backfills when initialization is retried', async () => {
  const db = new FakeD1();
  db.storedObjects.push({ id: 'object-1', created_at: 101 });
  db.videoTasks.push({ id: 'task-1', created_at: 202 });
  db.failAssetBackfillOnce = true;

  await assert.rejects(() => ensureDefaultProject(db, () => 'project-default', 1234), /simulated asset backfill failure/);
  const project = await ensureDefaultProject(db, () => 'must-not-be-used', 9999);

  assert.equal(project.id, 'project-default');
  assert.equal(db.projects.length, 1);
  assert.deepEqual(db.projectAssets, [{ project_id: 'project-default', object_id: 'object-1', created_at: 101 }]);
  assert.deepEqual(db.projectTasks, [{ project_id: 'project-default', task_id: 'task-1', created_at: 202 }]);
});

test('prevents duplicate default projects during concurrent initialization', async () => {
  const db = new FakeD1();

  const [first, second] = await Promise.all([
    ensureDefaultProject(db, undefined, 1234),
    ensureDefaultProject(db, undefined, 1234),
  ]);

  assert.equal(first.id, 'uncategorized');
  assert.deepEqual(second, first);
  assert.equal(db.projects.length, 1);
});
