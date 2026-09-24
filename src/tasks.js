import { callTool } from './kling-mcp.js';

export class TaskError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function validateTask(input, capabilities) {
  const mode = input.mode;
  if (!['text', 'image'].includes(mode)) throw new Error('生成模式无效');
  const group = mode === 'text' ? capabilities.text_to_video : capabilities.image_to_video;
  const model = group?.models?.find((item) => item.model === input.model);
  if (!model) throw new Error('模型不可用');
  const values = Object.fromEntries(model.arguments.map((item) => [item.name, item]));
  for (const [name, value] of [['duration', String(input.duration)], ['resolution', input.resolution], ['aspect_ratio', input.aspectRatio]]) {
    if (values[name]?.allowedValues && !values[name].allowedValues.includes(value)) throw new Error(`${name} 参数不受支持`);
  }
  if (mode === 'text' && !String(input.prompt || '').trim()) throw new Error('请输入视频提示词');
  if (mode === 'image' && !input.uploadId) throw new Error('请上传首帧参考图');
  return { ...input, duration: String(input.duration), imageCount: String(input.imageCount || 1) };
}

function settingsSnapshot(valid) {
  return {
    mode: valid.mode,
    model: valid.model,
    prompt: valid.prompt || '',
    uploadId: valid.uploadId || null,
    duration: valid.duration,
    resolution: valid.resolution,
    aspectRatio: valid.aspectRatio,
    imageCount: valid.imageCount,
  };
}

async function loadCapabilities(source) {
  if (typeof source !== 'function') return source;
  const status = await source();
  if (status.connection !== 'online') {
    throw new TaskError('请先连接可灵 MCP', 409);
  }
  return status.models;
}

function taskDto(task) {
  return { id: task.id, remote_id: task.remote_id || null, status: task.status };
}

async function markFailed(db, id) {
  try {
    await db.prepare('UPDATE video_tasks SET status = ?, updated_at = ? WHERE id = ?').bind('failed', Date.now(), id).run();
  } catch {}
}

export async function submitTask(input, env, idempotencyKey, capabilitiesSource, fetcher = fetch, toolCaller = callTool) {
  const projectId = String(input?.projectId || '').trim();
  if (!projectId) throw new TaskError('请选择项目', 400);
  const project = await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
  if (!project) throw new TaskError('请选有效项目', 400);
  const internalKey = JSON.stringify([projectId, idempotencyKey]);
  const existing = await env.DB.prepare('SELECT video_tasks.* FROM video_tasks JOIN project_tasks ON project_tasks.task_id = video_tasks.id WHERE video_tasks.idempotency_key = ? AND project_tasks.project_id = ?').bind(internalKey, projectId).first();
  if (existing) return taskDto(existing);
  const legacy = await env.DB.prepare('SELECT video_tasks.* FROM video_tasks JOIN project_tasks ON project_tasks.task_id = video_tasks.id WHERE video_tasks.idempotency_key = ? AND project_tasks.project_id = ?').bind(idempotencyKey, projectId).first();
  if (legacy) return taskDto(legacy);
  const capabilities = await loadCapabilities(capabilitiesSource);
  let valid;
  try { valid = validateTask(input, capabilities); }
  catch (error) { throw new TaskError(error.message, 400); }
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const reservation = [
    env.DB.prepare('INSERT INTO video_tasks (id, idempotency_key, remote_id, mode, status, request_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, internalKey, null, valid.mode, 'submitting', JSON.stringify(valid), createdAt, createdAt),
    env.DB.prepare('INSERT INTO project_tasks (project_id, task_id, created_at) VALUES (?, ?, ?)').bind(projectId, id, createdAt),
  ];
  try {
    if (typeof env.DB.batch === 'function') await env.DB.batch(reservation);
    else for (const statement of reservation) await statement.run();
  } catch {
    const reserved = await env.DB.prepare('SELECT video_tasks.* FROM video_tasks JOIN project_tasks ON project_tasks.task_id = video_tasks.id WHERE video_tasks.idempotency_key = ? AND project_tasks.project_id = ?').bind(internalKey, projectId).first();
    if (reserved) return taskDto(reserved);
    throw new TaskError('任务保存失败', 500);
  }
  let result;
  try {
    if (valid.mode === 'text') {
      result = await toolCaller(env, 'text_to_video', { model: valid.model, prompt: valid.prompt, duration: valid.duration, aspect_ratio: valid.aspectRatio, resolution: valid.resolution, imageCount: valid.imageCount }, fetcher);
    } else {
      const upload = await env.DB.prepare('SELECT stored_objects.object_key FROM stored_objects JOIN project_assets ON project_assets.object_id = stored_objects.id WHERE stored_objects.id = ? AND project_assets.project_id = ?').bind(valid.uploadId, projectId).first();
      if (!upload) throw new TaskError('参考图不存在', 404);
      const file = await env.MEDIA.get(upload.object_key);
      if (!file) throw new TaskError('参考图存储不可用', 500);
      const uploaded = await toolCaller(env, 'file_upload', { file: await file.arrayBuffer(), filename: 'reference-image' }, fetcher);
      result = await toolCaller(env, 'image_to_video', { model: valid.model, prompt: valid.prompt || '', first_image: uploaded.url || uploaded, duration: valid.duration, resolution: valid.resolution, imageCount: valid.imageCount }, fetcher);
    }
  } catch (error) {
    await markFailed(env.DB, id);
    if (error instanceof TaskError) throw error;
    throw new TaskError('视频生成服务暂不可用', 502);
  }
  const remoteId = result.taskId || result.task_id || result.id || null;
  const statements = [
    env.DB.prepare('UPDATE video_tasks SET remote_id = ?, status = ?, result_json = ?, updated_at = ? WHERE id = ?').bind(remoteId, 'queued', JSON.stringify(result), Date.now(), id),
    env.DB.prepare('INSERT INTO project_settings (project_id, settings_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at').bind(projectId, JSON.stringify(settingsSnapshot(valid)), createdAt),
  ];
  try {
    if (typeof env.DB.batch === 'function') await env.DB.batch(statements);
    else for (const statement of statements) await statement.run();
  } catch {
    throw new TaskError('任务保存失败', 500);
  }
  return taskDto({ id, remote_id: remoteId, status: 'queued' });
}
