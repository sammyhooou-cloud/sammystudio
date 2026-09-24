import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject,
  backfillLegacyRows,
  ensureDefaultProject,
  listProjects,
  normalizeProjectName,
  readProjectWorkspace,
  renameProject,
} from '../src/projects.js';

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
    this.projectSettings = [];
    this.queries = [];
    this.runs = [];
    this.batchCount = 0;
    this.failAssetBackfillOnce = false;
    this.migrationMarkers = [];
  }

  prepare(sql) {
    const db = this;
    const statement = {
      sql,
      values: [],
      bind(...values) {
        return { ...statement, values };
      },
      async first() {
        const values = this.values;
        if (sql.includes('FROM migration_markers')) return db.migrationMarkers.includes(values[0]) ? { name: values[0] } : null;
        if (sql.includes('WHERE id = ?')) {
          return db.projects.find(({ id }) => id === values[0]) ?? null;
        }
        if (sql.includes('FROM project_settings')) {
          return db.projectSettings.find(({ project_id }) => project_id === values[0]) ?? null;
        }
        if (sql.includes('FROM projects')) {
          return [...db.projects].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0] ?? null;
        }
        throw new Error(`Unexpected first query: ${sql}`);
      },
      async all() {
        db.queries.push(sql);
        const values = this.values;
        if (sql.includes('FROM projects')) {
          return { results: [...db.projects].sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id)) };
        }
        if (sql.includes('FROM project_assets')) {
          const ids = db.projectAssets.filter((link) => link.project_id === values[0]).map((link) => link.object_id);
          return { results: db.storedObjects.filter(({ id }) => ids.includes(id)).sort((a, b) => b.created_at - a.created_at) };
        }
        if (sql.includes('FROM project_tasks')) {
          const ids = db.projectTasks.filter((link) => link.project_id === values[0]).map((link) => link.task_id);
          return { results: db.videoTasks.filter(({ id }) => ids.includes(id)).sort((a, b) => b.updated_at - a.updated_at) };
        }
        throw new Error(`Unexpected all query: ${sql}`);
      },
      async run() {
        const values = this.values;
        db.runs.push({ sql, values });
        if (sql.startsWith('INSERT OR IGNORE INTO projects') && !db.projects.some(({ id }) => id === values[0])) {
          db.projects.push({
            id: values[0],
            name: values[1],
            created_at: values[2],
            updated_at: values[3],
          });
        }
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
        if (sql.startsWith('INSERT OR IGNORE INTO migration_markers')) db.migrationMarkers.push(values[0]);
        return { success: true };
      },
    };
    return statement;
  }

  async batch(statements) {
    this.batchCount += 1;
    const snapshot = {
      projects: structuredClone(this.projects),
      projectAssets: structuredClone(this.projectAssets),
      projectTasks: structuredClone(this.projectTasks),
      migrationMarkers: structuredClone(this.migrationMarkers),
    };
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.projects = snapshot.projects;
      this.projectAssets = snapshot.projectAssets;
      this.projectTasks = snapshot.projectTasks;
      this.migrationMarkers = snapshot.migrationMarkers;
      throw error;
    }
  }
}

test('one-time legacy migration assigns unassociated rows even when projects exist', async () => {
  const db = new FakeD1();
  db.projects.push({ id: 'existing', name: 'Existing', created_at: 1, updated_at: 1 });
  db.storedObjects.push({ id: 'legacy-file', created_at: 2, filename: null });
  db.videoTasks.push({ id: 'legacy-task', created_at: 3 });
  await backfillLegacyRows(db, 10);
  assert.deepEqual(db.projectAssets.map(({ object_id }) => object_id), ['legacy-file']);
  assert.equal(db.projectAssets[0].project_id, 'uncategorized');
  assert.equal(db.projectTasks[0].project_id, 'uncategorized');
  db.storedObjects.push({ id: 'new-unassociated', created_at: 11 });
  await backfillLegacyRows(db, 12);
  assert.equal(db.projectAssets.some(({ object_id }) => object_id === 'new-unassociated'), false);
});

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
  assert.equal(db.batchCount, 1);
  assert.deepEqual(db.projectAssets, [{ project_id: 'project-default', object_id: 'object-1', created_at: 101 }]);
  assert.deepEqual(db.projectTasks, [{ project_id: 'project-default', task_id: 'task-1', created_at: 202 }]);
});

test('returns the earliest existing project without sweeping later unassociated rows', async () => {
  const db = new FakeD1();
  db.projects.push(
    { id: 'newer', name: '新项目', created_at: 20, updated_at: 20 },
    { id: 'older', name: '旧项目', created_at: 10, updated_at: 10 },
  );
  db.storedObjects.push({ id: 'in-flight-object', created_at: 25 });
  db.videoTasks.push({ id: 'in-flight-task', created_at: 26 });

  const project = await ensureDefaultProject(db, () => 'unused', 30);

  assert.equal(project.id, 'older');
  assert.equal(db.batchCount, 0);
  assert.deepEqual(db.projectAssets, []);
  assert.deepEqual(db.projectTasks, []);
});

test('repairs incomplete backfills when initialization is retried', async () => {
  const db = new FakeD1();
  db.storedObjects.push({ id: 'object-1', created_at: 101 });
  db.videoTasks.push({ id: 'task-1', created_at: 202 });
  db.failAssetBackfillOnce = true;

  await assert.rejects(() => ensureDefaultProject(db, () => 'project-default', 1234), /simulated asset backfill failure/);
  assert.equal(db.projects.length, 0);
  assert.deepEqual(db.projectAssets, []);
  assert.deepEqual(db.projectTasks, []);
  const project = await ensureDefaultProject(db, () => 'must-not-be-used', 9999);

  assert.equal(project.id, 'must-not-be-used');
  assert.equal(db.projects.length, 1);
  assert.deepEqual(db.projectAssets, [{ project_id: 'must-not-be-used', object_id: 'object-1', created_at: 101 }]);
  assert.deepEqual(db.projectTasks, [{ project_id: 'must-not-be-used', task_id: 'task-1', created_at: 202 }]);
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

test('lists projects most recently updated after ensuring the default project', async () => {
  const db = new FakeD1();
  db.projects.push(
    { id: 'older', name: '较早', created_at: 10, updated_at: 20 },
    { id: 'newer', name: '较新', created_at: 30, updated_at: 40 },
  );

  assert.deepEqual(await listProjects(db), [
    { id: 'newer', name: '较新', createdAt: 30, updatedAt: 40 },
    { id: 'older', name: '较早', createdAt: 10, updatedAt: 20 },
  ]);
});

test('creates and renames a normalized project', async () => {
  const db = new FakeD1();
  const created = await createProject(db, { name: '  新项目  ' }, () => 'project-1', 100);
  const renamed = await renameProject(db, 'project-1', { name: '  更名后  ' }, 200);

  assert.deepEqual(created, { id: 'project-1', name: '新项目', createdAt: 100, updatedAt: 100 });
  assert.deepEqual(renamed, { id: 'project-1', name: '更名后', createdAt: 100, updatedAt: 200 });
  await assert.rejects(() => renameProject(db, 'missing', { name: '不存在' }, 300), { message: '项目不存在' });
});

test('reads only assets and tasks linked to one project and parses settings', async () => {
  const db = new FakeD1();
  db.projects.push({ id: 'project-a', name: 'A', created_at: 1, updated_at: 2 });
  db.storedObjects.push(
    { id: 'asset-a', object_key: 'references/a', mime_type: 'image/png', size: 11, filename: 'first-frame.png', created_at: 30 },
    { id: 'asset-b', object_key: 'references/b', mime_type: 'image/jpeg', size: 22, created_at: 40 },
  );
  db.videoTasks.push(
    { id: 'task-a', idempotency_key: 'secret-a', remote_id: 'remote-a', mode: 'image', status: 'done', request_json: '{}', result_json: '{"url":"a"}', created_at: 10, updated_at: 50 },
    { id: 'task-b', idempotency_key: 'secret-b', remote_id: 'remote-b', mode: 'text', status: 'queued', request_json: '{}', result_json: null, created_at: 20, updated_at: 60 },
  );
  db.projectAssets.push({ project_id: 'project-a', object_id: 'asset-a', created_at: 30 }, { project_id: 'project-b', object_id: 'asset-b', created_at: 40 });
  db.projectTasks.push({ project_id: 'project-a', task_id: 'task-a', created_at: 10 }, { project_id: 'project-b', task_id: 'task-b', created_at: 20 });
  db.projectSettings.push({ project_id: 'project-a', settings_json: '{"duration":5}', updated_at: 70 });

  const workspace = await readProjectWorkspace(db, 'project-a');

  assert.equal(workspace.project.id, 'project-a');
  assert.deepEqual(workspace.assets.map(({ id }) => id), ['asset-a']);
  assert.equal(workspace.assets[0].name, 'first-frame.png');
  assert.deepEqual(workspace.tasks.map(({ id }) => id), ['task-a']);
  assert.deepEqual(workspace.settings, { duration: 5 });
  assert.equal('objectKey' in workspace.assets[0], false);
  assert.equal('idempotencyKey' in workspace.tasks[0], false);
  assert.equal(db.queries.filter((sql) => sql.includes('LIMIT 100')).length, 2);
});

test('falls back to empty settings and rejects missing projects', async () => {
  const db = new FakeD1();
  db.projects.push({ id: 'project-a', name: 'A', created_at: 1, updated_at: 2 });

  assert.deepEqual((await readProjectWorkspace(db, 'project-a')).settings, {});
  db.projectSettings.push({ project_id: 'project-a', settings_json: '{broken', updated_at: 3 });
  assert.deepEqual((await readProjectWorkspace(db, 'project-a')).settings, {});
  await assert.rejects(() => readProjectWorkspace(db, 'missing'), { message: '项目不存在' });
});

test('legacy stored objects use their id as a display name when filename is absent', async () => {
  const db = new FakeD1();
  db.projects.push({ id: 'project-a', name: 'A', created_at: 1, updated_at: 1 });
  db.storedObjects.push({ id: 'legacy-asset', mime_type: 'image/png', size: 1, created_at: 2 });
  db.projectAssets.push({ project_id: 'project-a', object_id: 'legacy-asset', created_at: 2 });
  assert.equal((await readProjectWorkspace(db, 'project-a')).assets[0].name, 'legacy-asset');
});
