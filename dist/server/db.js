const statements = [
  'CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at)',
  'CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, expires_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states(expires_at)',
  'CREATE TABLE IF NOT EXISTS oauth_tokens (encrypted_token TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS video_tasks (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, remote_id TEXT, mode TEXT NOT NULL, status TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_video_tasks_remote ON video_tasks(remote_id)',
  'CREATE TABLE IF NOT EXISTS task_outputs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, object_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL, byte_size INTEGER, created_at INTEGER NOT NULL, FOREIGN KEY (task_id) REFERENCES video_tasks(id) ON DELETE CASCADE)',
  'CREATE TABLE IF NOT EXISTS stored_objects (id TEXT PRIMARY KEY, object_key TEXT UNIQUE NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS project_assets (project_id TEXT NOT NULL, object_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, PRIMARY KEY (project_id, object_id))',
  'CREATE INDEX IF NOT EXISTS idx_project_assets_project_created ON project_assets(project_id, created_at)',
  'CREATE TABLE IF NOT EXISTS project_tasks (project_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, PRIMARY KEY (project_id, task_id))',
  'CREATE INDEX IF NOT EXISTS idx_project_tasks_project_created ON project_tasks(project_id, created_at)',
  'CREATE TABLE IF NOT EXISTS project_settings (project_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS project_settings_versions (project_id TEXT PRIMARY KEY, version INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS migration_markers (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
];

let initialized = false;

async function addColumn(db, sql) {
  try { await db.prepare(sql).run(); }
  catch (error) { if (!/duplicate column name/i.test(String(error?.message))) throw error; }
}

export async function ensureSchema(db) {
  if (initialized) return;
  if (typeof db.batch === 'function') await db.batch(statements.map((sql) => db.prepare(sql)));
  else for (const sql of statements) await db.prepare(sql).run();
  await addColumn(db, 'ALTER TABLE stored_objects ADD COLUMN filename TEXT');
  await addColumn(db, "ALTER TABLE projects ADD COLUMN video_provider TEXT NOT NULL DEFAULT 'kling'");
  await addColumn(db, "ALTER TABLE video_tasks ADD COLUMN provider TEXT NOT NULL DEFAULT 'kling'");
  initialized = true;
}
