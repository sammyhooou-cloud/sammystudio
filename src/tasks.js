import { callTool } from './kling-mcp.js';

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

export async function submitTask(input, env, idempotencyKey, capabilities, fetcher = fetch, toolCaller = callTool) {
  const existing = await env.DB.prepare('SELECT * FROM video_tasks WHERE idempotency_key = ?').bind(idempotencyKey).first();
  if (existing) return existing;
  const projectId = String(input?.projectId || '').trim();
  if (!projectId) throw new Error('请选择项目');
  const project = await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
  if (!project) throw new Error('请选有效项目');
  const valid = validateTask(input, capabilities);
  const id = crypto.randomUUID();
  let result;
  if (valid.mode === 'text') {
    result = await toolCaller(env, 'text_to_video', { model: valid.model, prompt: valid.prompt, duration: valid.duration, aspect_ratio: valid.aspectRatio, resolution: valid.resolution, imageCount: valid.imageCount }, fetcher);
  } else {
    const upload = await env.DB.prepare('SELECT stored_objects.object_key FROM stored_objects JOIN project_assets ON project_assets.object_id = stored_objects.id WHERE stored_objects.id = ? AND project_assets.project_id = ?').bind(valid.uploadId, projectId).first();
    if (!upload) throw new Error('参考图不存在');
    const file = await env.MEDIA.get(upload.object_key);
    const uploaded = await toolCaller(env, 'file_upload', { file: await file.arrayBuffer(), filename: 'reference-image' }, fetcher);
    result = await toolCaller(env, 'image_to_video', { model: valid.model, prompt: valid.prompt || '', first_image: uploaded.url || uploaded, duration: valid.duration, resolution: valid.resolution, imageCount: valid.imageCount }, fetcher);
  }
  const remoteId = result.taskId || result.task_id || result.id || null;
  const createdAt = Date.now();
  const statements = [
    env.DB.prepare('INSERT INTO video_tasks (id, idempotency_key, remote_id, mode, status, request_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, idempotencyKey, remoteId, valid.mode, 'queued', JSON.stringify(valid), createdAt, createdAt),
    env.DB.prepare('INSERT INTO project_tasks (project_id, task_id, created_at) VALUES (?, ?, ?)').bind(projectId, id, createdAt),
    env.DB.prepare('INSERT INTO project_settings (project_id, settings_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at').bind(projectId, JSON.stringify(settingsSnapshot(valid)), createdAt),
  ];
  if (typeof env.DB.batch === 'function') await env.DB.batch(statements);
  else for (const statement of statements) await statement.run();
  return { id, remote_id: remoteId, status: 'queued' };
}
