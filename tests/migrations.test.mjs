import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../src/db.js';

const migration = (name) => readFileSync(new URL(`../migrations/DB/${name}`, import.meta.url), 'utf8');

test('0004 adds video provider columns and unique task outputs', () => {
  const sql = migration('0004_video_providers.sql');
  assert.match(sql, /ALTER TABLE projects ADD COLUMN video_provider TEXT NOT NULL DEFAULT 'kling'/);
  assert.match(sql, /ALTER TABLE video_tasks ADD COLUMN provider TEXT NOT NULL DEFAULT 'kling'/);
  assert.match(sql, /CREATE TABLE(?: IF NOT EXISTS)? task_outputs/);
  assert.match(sql, /task_id TEXT NOT NULL UNIQUE/);
  assert.match(sql, /FOREIGN KEY \(task_id\) REFERENCES video_tasks\(id\) ON DELETE CASCADE/);
});

test('0004 defaults existing rows to kling and cascades task output deletion', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(migration('0001_initial.sql'));
  db.exec(migration('0002_projects.sql'));
  db.exec("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('project', 'Project', 1, 1)");
  db.exec("INSERT INTO video_tasks (id, idempotency_key, mode, status, request_json, created_at, updated_at) VALUES ('task', 'key', 'text', 'succeeded', '{}', 1, 1)");
  db.exec(migration('0004_video_providers.sql'));
  assert.equal(db.prepare('SELECT video_provider FROM projects').get().video_provider, 'kling');
  assert.equal(db.prepare('SELECT provider FROM video_tasks').get().provider, 'kling');
  assert.deepEqual(db.prepare('PRAGMA index_info(idx_video_tasks_provider_remote)').all().map(({ name }) => name), ['provider', 'remote_id']);
  const insertOutput = db.prepare('INSERT INTO task_outputs (id, task_id, object_key, content_type, created_at) VALUES (?, ?, ?, ?, ?)');
  insertOutput.run('output', 'task', 'videos/output.mp4', 'video/mp4', 1);
  assert.throws(() => insertOutput.run('duplicate', 'task', 'videos/duplicate.mp4', 'video/mp4', 1), /UNIQUE constraint failed: task_outputs.task_id/);
  db.exec("DELETE FROM video_tasks WHERE id = 'task'");
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_outputs').get().count, 0);
  db.close();
});

test('0003 adds a nullable filename to an existing 0001/0002 database', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migration('0001_initial.sql'));
  db.exec(migration('0002_projects.sql'));
  db.prepare('INSERT INTO stored_objects (id, object_key, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?)').run('old', 'references/old', 'image/png', 1, 1);
  db.exec(migration('0003_stored_object_filename.sql'));
  assert.equal(db.prepare('SELECT filename FROM stored_objects WHERE id = ?').get('old').filename, null);
  assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get('migration_markers'));
  db.close();
});

test('runtime schema compatibility adds filename, providers, and outputs before migrations run', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migration('0001_initial.sql'));
  db.exec(migration('0002_projects.sql'));
  await ensureSchema({ prepare: (sql) => db.prepare(sql) });
  assert.ok(db.prepare('PRAGMA table_info(stored_objects)').all().some(({ name }) => name === 'filename'));
  for (const [table, column] of [['projects', 'video_provider'], ['video_tasks', 'provider']]) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all().find(({ name }) => name === column);
    assert.equal(info?.notnull, 1);
    assert.equal(info?.dflt_value, "'kling'");
  }
  assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get('task_outputs'));
  db.close();
});
