export function normalizeProjectName(name) {
  const normalized = String(name ?? '').trim();
  if (!normalized) throw new Error('项目名称不能为空');
  if ([...normalized].length > 60) throw new Error('项目名称不能超过60个字符');
  return normalized;
}

export async function ensureDefaultProject(db, idFactory = () => 'uncategorized', now = Date.now()) {
  let project = await db
    .prepare('SELECT id, name, created_at, updated_at FROM projects ORDER BY created_at ASC, id ASC LIMIT 1')
    .first();
  if (!project) {
    const id = idFactory();
    await db
      .prepare('INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind(id, '未分类项目', now, now)
      .run();
    project = await db
      .prepare('SELECT id, name, created_at, updated_at FROM projects ORDER BY created_at ASC, id ASC LIMIT 1')
      .first();
  }

  await db
    .prepare('INSERT OR IGNORE INTO project_assets (project_id, object_id, created_at) SELECT ?, id, created_at FROM stored_objects')
    .bind(project.id)
    .run();
  await db
    .prepare('INSERT OR IGNORE INTO project_tasks (project_id, task_id, created_at) SELECT ?, id, created_at FROM video_tasks')
    .bind(project.id)
    .run();

  return project;
}
