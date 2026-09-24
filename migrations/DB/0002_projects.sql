CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS project_assets (project_id TEXT NOT NULL, object_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, PRIMARY KEY (project_id, object_id));
CREATE INDEX IF NOT EXISTS idx_project_assets_project_created ON project_assets(project_id, created_at);
CREATE TABLE IF NOT EXISTS project_tasks (project_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, PRIMARY KEY (project_id, task_id));
CREATE INDEX IF NOT EXISTS idx_project_tasks_project_created ON project_tasks(project_id, created_at);
CREATE TABLE IF NOT EXISTS project_settings (project_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS project_settings_versions (project_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
