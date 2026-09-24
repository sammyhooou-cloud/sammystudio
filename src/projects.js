export function normalizeProjectName(name) {
  const normalized = String(name ?? '').trim();
  if (!normalized) throw new Error('项目名称不能为空');
  if ([...normalized].length > 60) throw new Error('项目名称不能超过60个字符');
  return normalized;
}

export async function ensureDefaultProject(db, idFactory = crypto.randomUUID, now = Date.now()) {
  const existing = await db
    .prepare('SELECT id, name, created_at, updated_at FROM projects ORDER BY created_at ASC, id ASC LIMIT 1')
    .first();
  if (existing) return existing;

  const project = {
    id: idFactory(),
    name: '未分类项目',
    created_at: now,
    updated_at: now,
  };

  await db
    .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(project.id, project.name, project.created_at, project.updated_at)
    .run();
  await db
    .prepare('INSERT OR IGNORE INTO project_assets (project_id, object_id, created_at) SELECT ?, id, ? FROM stored_objects')
    .bind(project.id, now)
    .run();
  await db
    .prepare('INSERT OR IGNORE INTO project_tasks (project_id, task_id, created_at) SELECT ?, id, ? FROM video_tasks')
    .bind(project.id, now)
    .run();

  return project;
}
