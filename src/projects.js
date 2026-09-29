const videoProviders = new Set(['kling', 'minimax']);

export function normalizeVideoProvider(value) {
  const provider = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!videoProviders.has(provider)) throw new Error('视频供应商无效');
  return provider;
}

export function normalizeProjectName(name) {
  const normalized = String(name ?? '').trim();
  if (!normalized) throw new Error('项目名称不能为空');
  if ([...normalized].length > 60) throw new Error('项目名称不能超过60个字符');
  return normalized;
}

function projectRecord(row) {
  return {
    id: row.id,
    name: row.name,
    videoProvider: row.video_provider || 'kling',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function resultsOf(query) {
  return query?.results ?? [];
}

export async function backfillLegacyRows(db, now = Date.now()) {
  const marker = 'legacy_project_backfill_v1';
  const done = await db.prepare('SELECT name FROM migration_markers WHERE name = ?').bind(marker).first();
  if (done) return;
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('uncategorized', '未分类项目', now, now),
    db.prepare(`INSERT OR IGNORE INTO project_assets (project_id, object_id, created_at)
      SELECT ?, stored_objects.id, stored_objects.created_at FROM stored_objects
      WHERE NOT EXISTS (SELECT 1 FROM project_assets WHERE object_id = stored_objects.id)
        AND NOT EXISTS (SELECT 1 FROM migration_markers WHERE name = ?)` ).bind('uncategorized', marker),
    db.prepare(`INSERT OR IGNORE INTO project_tasks (project_id, task_id, created_at)
      SELECT ?, video_tasks.id, video_tasks.created_at FROM video_tasks
      WHERE NOT EXISTS (SELECT 1 FROM project_tasks WHERE task_id = video_tasks.id)
        AND NOT EXISTS (SELECT 1 FROM migration_markers WHERE name = ?)` ).bind('uncategorized', marker),
    db.prepare('INSERT OR IGNORE INTO migration_markers (name, applied_at) VALUES (?, ?)').bind(marker, now),
  ]);
}

export async function ensureDefaultProject(db, idFactory = () => 'uncategorized', now = Date.now()) {
  const existing = await db
    .prepare('SELECT id, name, video_provider, created_at, updated_at FROM projects ORDER BY created_at ASC, id ASC LIMIT 1')
    .first();
  if (existing) return existing;

  const id = idFactory();
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind(id, '未分类项目', now, now),
    db.prepare('INSERT OR IGNORE INTO project_assets (project_id, object_id, created_at) SELECT ?, id, created_at FROM stored_objects')
      .bind(id),
    db.prepare('INSERT OR IGNORE INTO project_tasks (project_id, task_id, created_at) SELECT ?, id, created_at FROM video_tasks')
      .bind(id),
  ]);

  return db
    .prepare('SELECT id, name, video_provider, created_at, updated_at FROM projects ORDER BY created_at ASC, id ASC LIMIT 1')
    .first();
}

export async function listProjects(db) {
  await ensureDefaultProject(db);
  const query = await db
    .prepare('SELECT id, name, video_provider, created_at, updated_at FROM projects ORDER BY updated_at DESC, id ASC')
    .all();
  return resultsOf(query).map(projectRecord);
}

export async function createProject(db, body, idFactory = () => crypto.randomUUID(), now = Date.now()) {
  const name = normalizeProjectName(body?.name);
  const id = idFactory();
  await db
    .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(id, name, now, now)
    .run();
  return { id, name, videoProvider: 'kling', createdAt: now, updatedAt: now };
}

export async function renameProject(db, id, body, now = Date.now()) {
  const name = normalizeProjectName(body?.name);
  const result = await db
    .prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
    .bind(name, now, id)
    .run();
  if (!result?.meta?.changes) throw new Error('项目不存在');
  const project = await db
    .prepare('SELECT id, name, video_provider, created_at, updated_at FROM projects WHERE id = ?')
    .bind(id)
    .first();
  return projectRecord(project);
}

export async function updateProjectProvider(db, id, body, now = Date.now()) {
  const videoProvider = normalizeVideoProvider(body?.provider);
  const result = await db
    .prepare('UPDATE projects SET video_provider = ?, updated_at = ? WHERE id = ?')
    .bind(videoProvider, now, id)
    .run();
  if (!result?.meta?.changes) throw new Error('项目不存在');
  return { id, videoProvider, updatedAt: now };
}

export async function readProjectWorkspace(db, id) {
  const project = await db
    .prepare('SELECT id, name, video_provider, created_at, updated_at FROM projects WHERE id = ?')
    .bind(id)
    .first();
  if (!project) throw new Error('项目不存在');

  const [assetQuery, taskQuery, setting] = await Promise.all([
    db.prepare(`SELECT stored_objects.id, stored_objects.mime_type, stored_objects.size, stored_objects.filename, stored_objects.created_at
      FROM project_assets
      JOIN stored_objects ON stored_objects.id = project_assets.object_id
      WHERE project_assets.project_id = ?
      ORDER BY stored_objects.created_at DESC, stored_objects.id ASC
      LIMIT 100`).bind(id).all(),
    db.prepare(`SELECT video_tasks.id, video_tasks.remote_id, video_tasks.provider, video_tasks.mode, video_tasks.status,
        video_tasks.request_json, video_tasks.result_json, video_tasks.created_at, video_tasks.updated_at
      FROM project_tasks
      JOIN video_tasks ON video_tasks.id = project_tasks.task_id
      WHERE project_tasks.project_id = ?
      ORDER BY video_tasks.updated_at DESC, video_tasks.id ASC
      LIMIT 100`).bind(id).all(),
    db.prepare('SELECT settings_json FROM project_settings WHERE project_id = ?').bind(id).first(),
  ]);

  let settings = {};
  if (setting?.settings_json) {
    try { settings = JSON.parse(setting.settings_json); } catch { settings = {}; }
  }

  return {
    project: projectRecord(project),
    assets: resultsOf(assetQuery).map((asset) => ({
      id: asset.id,
      name: asset.filename || asset.id,
      mimeType: asset.mime_type,
      size: asset.size,
      createdAt: asset.created_at,
    })),
    tasks: resultsOf(taskQuery).map((task) => ({
      id: task.id,
      remoteId: task.remote_id,
      provider: task.provider || 'kling',
      mode: task.mode,
      status: task.status,
      requestJson: task.request_json,
      resultJson: task.result_json,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
    })),
    settings,
  };
}
