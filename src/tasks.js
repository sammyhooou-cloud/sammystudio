import { createVideoProvider } from './providers/index.js';
import { persistTaskOutput } from './task-outputs.js';

export class TaskError extends Error {
  constructor(message, status, task, code) {
    if (message && typeof message === 'object') ({ message, status, task, code } = message);
    super(message);
    this.status = status;
    if (task) this.task = task;
    if (code) this.code = code;
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

function submissionOptions(source, fetcher, toolCaller) {
  if (source && typeof source === 'object' && ['providerFactory', 'capabilitiesSource', 'fetcher', 'toolCaller'].some((key) => Object.hasOwn(source, key))) return source;
  return { capabilitiesSource: source, fetcher, toolCaller };
}

function taskProvider(id, env, options) {
  try { return (options.providerFactory || createVideoProvider)(id, env, options); }
  catch (error) {
    if (error instanceof TaskError) throw error;
    if (error.message === '视频供应商无效') throw new TaskError('视频供应商无效', 400);
    throw new TaskError('视频供应商暂不可用', 503, undefined, safeErrorCode(error));
  }
}

const providerErrorMessages = Object.freeze({
  provider_not_configured: '请配置 MiniMax API Key',
  provider_auth_failed: 'MiniMax 认证失败，请检查服务端配置',
  insufficient_balance: 'MiniMax 额度不足，请前往控制台查看',
  invalid_parameters: 'MiniMax 生成参数或参考图无效',
  provider_unavailable: 'MiniMax 暂不可用，请稍后重试',
  invalid_response: 'MiniMax 返回结果未确认，请勿重新创建任务',
});

function safeErrorCode(error) {
  if (error instanceof TaskError) return error.code;
  return Object.hasOwn(providerErrorMessages, error?.code) ? error.code : undefined;
}

async function loadCapabilities(provider) {
  try { return await provider.capabilities(); }
  catch (error) {
    if (error instanceof TaskError) throw error;
    if (provider.id === 'kling' && error.status === 409) throw new TaskError('请先连接可灵 MCP', 409);
    throw new TaskError('视频供应商暂不可用', 503, undefined, safeErrorCode(error));
  }
}

function taskDto(task) {
  return { id: task.id, remote_id: task.remote_id || null, status: task.status };
}

const recoveryKey = (id) => `task-recovery/${id}.json`;

async function saveSettings(db, projectId, settings, settingsVersion) {
  try {
    await db.prepare('INSERT INTO project_settings (project_id, settings_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at WHERE project_settings.updated_at < excluded.updated_at').bind(projectId, JSON.stringify(settings), settingsVersion).run();
  } catch {
    throw new TaskError('项目设置保存失败', 500);
  }
}

async function writeRecovery(media, record) {
  const body = JSON.stringify(record);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await media.put(recoveryKey(record.id), body, { httpMetadata: { contentType: 'application/json' } });
      return;
    } catch {
      if (attempt === 2) throw new TaskError('任务恢复记录保存失败', 503, { id: record.id, remote_id: record.remoteId, status: 'submitting' });
    }
  }
}

async function deleteRecovery(media, id) {
  try { await media.delete(recoveryKey(id)); } catch {}
}

async function markFailed(db, id) {
  try {
    await db.prepare('UPDATE video_tasks SET status = ?, updated_at = ? WHERE id = ?').bind('failed', Date.now(), id).run();
  } catch {}
}

async function markUnknown(db, id) {
  try { await db.prepare('UPDATE video_tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?').bind('unknown', Date.now(), id, 'submitting').run(); } catch {}
}

async function finalizeTask(db, id, remoteId, result) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await db.prepare('UPDATE video_tasks SET remote_id = ?, status = ?, result_json = ?, updated_at = ? WHERE id = ?').bind(remoteId, 'queued', JSON.stringify(result), Date.now(), id).run();
      return;
    } catch {
      if (attempt === 2) throw new TaskError('任务保存失败', 500);
    }
  }
}

async function replayTask(task, env, projectId) {
  const stale = async () => {
    if (task.status === 'submitting' && !task.remote_id && Number(task.created_at) > 0 && Date.now() - Number(task.created_at) > 5 * 60_000) {
      await markUnknown(env.DB, task.id);
      return taskDto({ ...task, status: 'unknown' });
    }
    return taskDto(task);
  };
  let object;
  try { object = await env.MEDIA.get(recoveryKey(task.id)); } catch { return stale(); }
  if (!object) return stale();
  let record;
  try { record = JSON.parse(await object.text()); } catch { throw new TaskError('任务恢复记录无效', 500); }
  if (record.id !== task.id || record.projectId !== projectId || (record.provider || 'kling') !== (task.provider || 'kling') || !record.settings || !Number.isFinite(record.settingsVersion)) throw new TaskError('任务恢复记录无效', 500);
  let replayed = task;
  if (task.status === 'submitting' && !task.remote_id && record.remoteId) {
    await finalizeTask(env.DB, task.id, record.remoteId, record.result);
    replayed = { id: task.id, remote_id: record.remoteId, status: 'queued' };
  } else if (task.status === 'submitting' && !task.remote_id) {
    return stale();
  }
  if (replayed.status === 'queued') {
    const current = await env.DB.prepare('SELECT settings_json, updated_at FROM project_settings WHERE project_id = ?').bind(projectId).first();
    if (!current || Number(current.updated_at) < record.settingsVersion) await saveSettings(env.DB, projectId, record.settings, record.settingsVersion);
    await deleteRecovery(env.MEDIA, task.id);
  }
  return taskDto(replayed);
}

export async function submitTask(input, env, idempotencyKey, capabilitiesSource, fetcher = fetch, toolCaller) {
  const projectId = String(input?.projectId || '').trim();
  if (!projectId) throw new TaskError('请选择项目', 400);
  const project = await env.DB.prepare('SELECT id, video_provider FROM projects WHERE id = ?').bind(projectId).first();
  if (!project) throw new TaskError('请选有效项目', 400);
  const internalKey = JSON.stringify([projectId, idempotencyKey]);
  const existing = await env.DB.prepare('SELECT video_tasks.* FROM video_tasks JOIN project_tasks ON project_tasks.task_id = video_tasks.id WHERE video_tasks.idempotency_key = ? AND project_tasks.project_id = ?').bind(internalKey, projectId).first();
  if (existing) return replayTask(existing, env, projectId);
  const legacy = await env.DB.prepare('SELECT video_tasks.* FROM video_tasks JOIN project_tasks ON project_tasks.task_id = video_tasks.id WHERE video_tasks.idempotency_key = ? AND project_tasks.project_id = ?').bind(idempotencyKey, projectId).first();
  if (legacy) return replayTask(legacy, env, projectId);
  if (typeof env.DB.batch !== 'function') throw new TaskError('任务保存失败', 500);
  const options = submissionOptions(capabilitiesSource, fetcher, toolCaller);
  const providerId = project.video_provider || 'kling';
  const provider = taskProvider(providerId, env, options);
  const capabilities = await loadCapabilities(provider);
  let valid;
  try { valid = validateTask(input, capabilities); }
  catch (error) { throw new TaskError(error.message, 400); }
  let versionRow;
  try {
    versionRow = await env.DB.prepare('INSERT INTO project_settings_versions (project_id, version) VALUES (?, 1) ON CONFLICT(project_id) DO UPDATE SET version = project_settings_versions.version + 1 RETURNING version').bind(projectId).first();
  } catch {
    throw new TaskError('任务保存失败', 500);
  }
  const settingsVersion = Number(versionRow?.version);
  if (!Number.isFinite(settingsVersion)) throw new TaskError('任务保存失败', 500);
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const reservation = [
    env.DB.prepare('INSERT INTO video_tasks (id, idempotency_key, remote_id, mode, status, request_json, created_at, updated_at, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, internalKey, null, valid.mode, 'submitting', JSON.stringify({ ...valid, settingsVersion }), createdAt, createdAt, providerId),
    env.DB.prepare('INSERT INTO project_tasks (project_id, task_id, created_at) VALUES (?, ?, ?)').bind(projectId, id, createdAt),
  ];
  try {
    await env.DB.batch(reservation);
  } catch {
    const reserved = await env.DB.prepare('SELECT video_tasks.* FROM video_tasks JOIN project_tasks ON project_tasks.task_id = video_tasks.id WHERE video_tasks.idempotency_key = ? AND project_tasks.project_id = ?').bind(internalKey, projectId).first();
    if (reserved) return taskDto(reserved);
    throw new TaskError('任务保存失败', 500);
  }
  let imageFile, imageUpload;
  if (valid.mode === 'image') {
    imageUpload = await env.DB.prepare('SELECT stored_objects.object_key, stored_objects.mime_type, stored_objects.size, stored_objects.filename FROM stored_objects JOIN project_assets ON project_assets.object_id = stored_objects.id WHERE stored_objects.id = ? AND project_assets.project_id = ?').bind(valid.uploadId, projectId).first();
    if (!imageUpload) { await markFailed(env.DB, id); throw new TaskError('参考图不存在', 404); }
    try { imageFile = await env.MEDIA.get(imageUpload.object_key); } catch { imageFile = null; }
    if (!imageFile) { await markFailed(env.DB, id); throw new TaskError('参考图存储不可用', 500); }
  }
  const traceId = id.replace(/-/g, '');
  const settings = settingsSnapshot(valid);
  const recovery = { id, projectId, provider: providerId, idempotencyKey, traceId, request: settings, settings, settingsVersion, remoteId: null, phase: 'intent' };
  try { await writeRecovery(env.MEDIA, recovery); }
  catch (error) { await markFailed(env.DB, id); throw new TaskError(error.message, error.status, { id, remote_id: null, status: 'failed' }); }
  let created;
  try {
    created = await provider.create({ input: valid, reference: imageUpload ? { ...imageUpload, object: imageFile } : undefined, traceId });
  } catch (error) {
    if (error?.submissionState === 'failed') {
      await markFailed(env.DB, id);
      const code = safeErrorCode(error);
      const message = providerId === 'minimax' ? providerErrorMessages[code] || 'MiniMax 提交失败，请稍后重试' : '参考图上传失败';
      throw new TaskError(message, 502, { id, remote_id: null, status: 'failed' }, code);
    }
    await markUnknown(env.DB, id);
    const message = providerId === 'kling' ? '提交结果未确认，请勿重新创建任务；请联系管理员核对可灵记录' : '提交结果未确认，请勿重新创建任务；请联系管理员核对供应商记录';
    throw new TaskError(message, 502, { id, remote_id: null, status: 'unknown' }, safeErrorCode(error));
  }
  const remoteId = created?.remoteId || null;
  if (!remoteId) {
    await markUnknown(env.DB, id);
    const message = providerId === 'kling' ? '提交结果未确认，请勿重新创建任务；请联系管理员核对可灵记录' : '提交结果未确认，请勿重新创建任务；请联系管理员核对供应商记录';
    throw new TaskError(message, 502, { id, remote_id: null, status: 'unknown' });
  }
  try { await writeRecovery(env.MEDIA, { ...recovery, remoteId, phase: 'accepted', result: { generationId: remoteId } }); }
  catch { /* The remote identifier remains available for direct DB finalization. */ }
  await finalizeTask(env.DB, id, remoteId, created.raw);
  await saveSettings(env.DB, projectId, settings, settingsVersion);
  await deleteRecovery(env.MEDIA, id);
  return taskDto({ id, remote_id: remoteId, status: 'queued' });
}

export function normalizeRemoteStatus(raw) {
  const status = String(raw || '').toUpperCase();
  if (['COMPLETED', 'PARTIAL_COMPLETED', 'SUCCEED', 'SUCCEEDED', 'SUCCESS'].includes(status)) return 'succeeded';
  if (['FAILED', 'FAIL', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status)) return 'failed';
  if (['RUNNING', 'PROCESSING', 'GENERATING'].includes(status)) return 'generating';
  return 'queued';
}

export async function getTaskDetail(id, projectId, env) {
  if (!id || !projectId) throw new TaskError('任务参数无效', 400);
  const task = await env.DB.prepare(`SELECT video_tasks.id, video_tasks.remote_id, video_tasks.mode,
      video_tasks.status, video_tasks.request_json, video_tasks.result_json,
      video_tasks.created_at, video_tasks.updated_at, projects.name AS project_name
    FROM video_tasks
    JOIN project_tasks ON project_tasks.task_id = video_tasks.id
    JOIN projects ON projects.id = project_tasks.project_id
    WHERE video_tasks.id = ? AND project_tasks.project_id = ?`).bind(id, projectId).first();
  if (!task) throw new TaskError('任务不存在', 404);
  let request = {};
  try {
    const parsed = JSON.parse(task.request_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) request = parsed;
  } catch {}
  const safeRequest = Object.fromEntries(['prompt', 'model', 'duration', 'resolution', 'aspectRatio']
    .filter((key) => request[key] !== undefined)
    .map((key) => [key, request[key]]));
  return {
    id: task.id,
    projectId,
    projectName: task.project_name,
    remoteId: task.remote_id || null,
    mode: task.mode,
    status: task.status,
    request: safeRequest,
    resultJson: task.result_json || null,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

export async function getTaskStatus(id, projectId, env, fetcher = fetch, toolCaller) {
  const task = await env.DB.prepare('SELECT video_tasks.* FROM video_tasks JOIN project_tasks ON project_tasks.task_id = video_tasks.id WHERE video_tasks.id = ? AND project_tasks.project_id = ?').bind(id, projectId).first();
  if (!task) throw new TaskError('任务不存在', 404);
  if (task.status === 'submitting' && !task.remote_id) {
    const recovered = await replayTask(task, env, projectId);
    return { ...recovered, resultJson: task.result_json || null };
  }
  if (!task.remote_id && ['queued', 'generating'].includes(task.status)) {
    await env.DB.prepare('UPDATE video_tasks SET status = ?, updated_at = ? WHERE id = ? AND remote_id IS NULL AND status IN (?, ?)').bind('unknown', Date.now(), id, 'queued', 'generating').run();
    const current = await env.DB.prepare('SELECT video_tasks.* FROM video_tasks JOIN project_tasks ON project_tasks.task_id = video_tasks.id WHERE video_tasks.id = ? AND project_tasks.project_id = ?').bind(id, projectId).first();
    if (!current) throw new TaskError('任务不存在', 404);
    return { ...taskDto(current), resultJson: current.result_json || null };
  }
  if (!task.remote_id || !['queued', 'generating'].includes(task.status)) return { ...taskDto(task), resultJson: task.result_json || null };
  const options = fetcher && typeof fetcher === 'object' ? fetcher : { fetcher, toolCaller };
  let provider, result;
  try {
    provider = taskProvider(task.provider || 'kling', env, options);
    result = await provider.query(task.remote_id);
  } catch (error) { throw new TaskError('任务状态暂不可用', 503, undefined, safeErrorCode(error)); }
  const status = result.status;
  let storedResult = result.raw;
  if (provider.persistOutput && status === 'succeeded') {
    let videoUrl;
    try {
      if (!result.outputUrl) throw new Error('missing output');
      videoUrl = await persistTaskOutput({ taskId: id, projectId, sourceUrl: result.outputUrl, env, fetcher: options.fetcher || fetch });
    } catch { throw new TaskError('视频输出保存暂不可用，请稍后重试', 503, undefined, 'output_persist_failed'); }
    storedResult = { providerResult: result.raw, videoUrl };
  }
  const resultJson = JSON.stringify(storedResult);
  await env.DB.prepare('UPDATE video_tasks SET status = ?, result_json = ?, updated_at = ? WHERE id = ? AND status IN (?, ?)').bind(status, resultJson, Date.now(), id, 'queued', 'generating').run();
  return { id, remote_id: task.remote_id, status, resultJson };
}

export async function getTaskByAttempt(projectId, key, env) {
  if (!projectId || !key) throw new TaskError('任务参数无效', 400);
  const internalKey = JSON.stringify([projectId, key]);
  const sql = 'SELECT video_tasks.* FROM video_tasks JOIN project_tasks ON project_tasks.task_id = video_tasks.id WHERE video_tasks.idempotency_key = ? AND project_tasks.project_id = ?';
  const task = await env.DB.prepare(sql).bind(internalKey, projectId).first() || await env.DB.prepare(sql).bind(key, projectId).first();
  if (!task) throw new TaskError('任务不存在', 404);
  return replayTask(task, env, projectId);
}
