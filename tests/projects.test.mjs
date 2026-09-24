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
    this.runs = [];
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
            if (sql.startsWith('INSERT INTO projects')) {
              db.projects.push({
                id: values[0],
                name: values[1],
                created_at: values[2],
                updated_at: values[3],
              });
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
  const idFactory = () => 'project-default';

  const created = await ensureDefaultProject(db, idFactory, 1234);
  const existing = await ensureDefaultProject(db, () => 'must-not-be-used', 9999);

  assert.deepEqual(created, {
    id: 'project-default',
    name: '未分类项目',
    created_at: 1234,
    updated_at: 1234,
  });
  assert.deepEqual(existing, created);
  assert.equal(db.runs.filter(({ sql }) => sql.startsWith('INSERT INTO projects')).length, 1);
  assert.equal(db.runs.filter(({ sql }) => sql.includes('project_assets')).length, 1);
  assert.equal(db.runs.filter(({ sql }) => sql.includes('project_tasks')).length, 1);
});

test('returns the earliest existing project without creating a default', async () => {
  const db = new FakeD1();
  db.projects.push(
    { id: 'newer', name: '新项目', created_at: 20, updated_at: 20 },
    { id: 'older', name: '旧项目', created_at: 10, updated_at: 10 },
  );

  const project = await ensureDefaultProject(db, () => 'unused', 30);

  assert.equal(project.id, 'older');
  assert.equal(db.runs.length, 0);
});
