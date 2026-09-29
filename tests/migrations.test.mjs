import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../src/db.js';

const migration = (name) => readFileSync(new URL(`../migrations/DB/${name}`, import.meta.url), 'utf8');

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

test('runtime schema compatibility adds filename when the migration has not run yet', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migration('0001_initial.sql'));
  db.exec(migration('0002_projects.sql'));
  await ensureSchema({ prepare: (sql) => db.prepare(sql) });
  assert.ok(db.prepare('PRAGMA table_info(stored_objects)').all().some(({ name }) => name === 'filename'));
  db.close();
});
