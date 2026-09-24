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

export async function submitTask(input, env, idempotencyKey, capabilities, fetcher = fetch) {
  const existing = await env.DB.prepare('SELECT * FROM video_tasks WHERE idempotency_key = ?').bind(idempotencyKey).first();
  if (existing) return existing;
  const valid = validateTask(input, capabilities);
  const id = crypto.randomUUID();
  let result;
  if (valid.mode === 'text') {
    result = await callTool(env, 'text_to_video', { model: valid.model, prompt: valid.prompt, duration: valid.duration, aspect_ratio: valid.aspectRatio, resolution: valid.resolution, imageCount: valid.imageCount }, fetcher);
  } else {
    const upload = await env.DB.prepare('SELECT object_key FROM stored_objects WHERE id = ?').bind(valid.uploadId).first();
    if (!upload) throw new Error('参考图不存在');
    const file = await env.MEDIA.get(upload.object_key);
    const uploaded = await callTool(env, 'file_upload', { file: await file.arrayBuffer(), filename: 'reference-image' }, fetcher);
    result = await callTool(env, 'image_to_video', { model: valid.model, prompt: valid.prompt || '', first_image: uploaded.url || uploaded, duration: valid.duration, resolution: valid.resolution, imageCount: valid.imageCount }, fetcher);
  }
  const remoteId = result.taskId || result.task_id || result.id || null;
  await env.DB.prepare('INSERT INTO video_tasks (id, idempotency_key, remote_id, mode, status, request_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, idempotencyKey, remoteId, valid.mode, 'queued', JSON.stringify(valid), Date.now(), Date.now()).run();
  return { id, remote_id: remoteId, status: 'queued' };
}
