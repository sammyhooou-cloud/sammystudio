ALTER TABLE projects ADD COLUMN video_provider TEXT NOT NULL DEFAULT 'kling';
ALTER TABLE video_tasks ADD COLUMN provider TEXT NOT NULL DEFAULT 'kling';
CREATE INDEX IF NOT EXISTS idx_video_tasks_provider_remote ON video_tasks(provider, remote_id);
CREATE TABLE IF NOT EXISTS task_outputs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES video_tasks(id) ON DELETE CASCADE
);
