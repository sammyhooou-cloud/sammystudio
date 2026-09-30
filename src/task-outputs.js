// Generated videos may be large; bound declared and streamed sizes without buffering their bodies.
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

class OutputError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

const persistenceError = () => new OutputError('视频输出保存暂不可用，请稍后重试', 503, 'output_persist_failed');
const outputUrl = (projectId, taskId) => `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/output`;

function validIds(taskId, projectId) {
  return [taskId, projectId].every((id) => typeof id === 'string' && id.trim());
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function cancelBody(response) {
  try { response?.body?.cancel().catch(() => {}); } catch {}
}

function videoMetadata(response, source, maxBytes) {
  const finalUrl = response.url ? httpsUrl(response.url) : source;
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const allowedType = /^video\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(contentType) || contentType === 'application/mp4' ||
    (contentType === 'application/octet-stream' && [source, finalUrl].some((url) => url && /\.mp4$/i.test(url.pathname)));
  const declaredLength = response.headers.get('content-length');
  let byteSize = null;
  if (declaredLength !== null) {
    const value = declaredLength.trim();
    byteSize = /^\d+$/.test(value) ? Number(value) : NaN;
  }
  if (!response.ok || !response.body || !finalUrl || !allowedType ||
      (byteSize !== null && (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > maxBytes))) {
    cancelBody(response);
    throw persistenceError();
  }
  return { contentType, byteSize };
}

function limitedVideoBody(body, maxBytes) {
  const reader = body.getReader();
  let size = 0;
  let completed = false;
  let exceeded = false;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          completed = true;
          controller.close();
          return;
        }
        if (!(chunk.value instanceof Uint8Array)) throw persistenceError();
        size += chunk.value.byteLength;
        if (size > maxBytes) {
          exceeded = true;
          controller.error(persistenceError());
          reader.cancel().catch(() => {});
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
  return { stream, complete: () => completed, exceeded: () => exceeded, cancel: () => reader.cancel().catch(() => {}) };
}

async function ownedOutput(db, taskId, projectId) {
  return db.prepare(`SELECT task_outputs.* FROM task_outputs
    JOIN project_tasks ON project_tasks.task_id = task_outputs.task_id
    WHERE task_outputs.task_id = ? AND project_tasks.project_id = ?`).bind(taskId, projectId).first();
}

async function cleanupIncompleteOutput(env, taskId, projectId, objectKey) {
  try {
    if (!await ownedOutput(env.DB, taskId, projectId)) await env.MEDIA.delete(objectKey);
  } catch { /* Preserve a concurrent winner when ownership cannot be checked. */ }
}

export async function persistTaskOutput({ taskId, projectId, sourceUrl, env, fetcher = fetch, now = Date.now, idFactory = () => crypto.randomUUID(), maxBytes = MAX_VIDEO_BYTES }) {
  if (!validIds(taskId, projectId)) throw new OutputError('任务输出参数无效', 400);
  const sizeLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_VIDEO_BYTES ? maxBytes : MAX_VIDEO_BYTES;
  let objectKey, monitored;
  try {
    const owner = await env.DB.prepare(`SELECT video_tasks.id FROM video_tasks
      JOIN project_tasks ON project_tasks.task_id = video_tasks.id
      WHERE video_tasks.id = ? AND project_tasks.project_id = ?`).bind(taskId, projectId).first();
    if (!owner) throw new OutputError('任务不存在', 404);
    if (await ownedOutput(env.DB, taskId, projectId)) return outputUrl(projectId, taskId);
    if (typeof sourceUrl !== 'string' || !httpsUrl(sourceUrl)) throw new OutputError('任务输出参数无效', 400);

    const response = await fetcher(sourceUrl, { redirect: 'follow' });
    const { contentType, byteSize } = videoMetadata(response, httpsUrl(sourceUrl), sizeLimit);
    monitored = limitedVideoBody(response.body, sizeLimit);
    objectKey = `outputs/${taskId}.mp4`;
    const stored = await env.MEDIA.put(objectKey, monitored.stream, { httpMetadata: { contentType } });
    if (!monitored.complete() || monitored.exceeded() || (Number.isSafeInteger(stored?.size) && stored.size > sizeLimit)) throw persistenceError();
    const storedSize = Number.isSafeInteger(stored?.size) && stored.size >= 0 && stored.size <= MAX_VIDEO_BYTES ? stored.size : null;
    await env.DB.prepare('INSERT OR IGNORE INTO task_outputs (id, task_id, object_key, content_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(idFactory(), taskId, objectKey, contentType, byteSize ?? storedSize, now()).run();
    // A concurrent poll may have inserted first. Keep that winning row and object.
    if (!await ownedOutput(env.DB, taskId, projectId)) throw persistenceError();
    return outputUrl(projectId, taskId);
  } catch (error) {
    if (monitored) await monitored.cancel();
    if (objectKey) await cleanupIncompleteOutput(env, taskId, projectId, objectKey);
    if (error instanceof OutputError) throw error;
    throw persistenceError();
  }
}

export async function readTaskOutput({ taskId, projectId, env }) {
  if (!validIds(taskId, projectId)) throw new OutputError('任务参数无效', 400);
  try {
    const output = await ownedOutput(env.DB, taskId, projectId);
    if (!output) return null;
    const object = await env.MEDIA.get(output.object_key);
    if (!object) return null;
    return new Response(object.body, { headers: { 'content-type': output.content_type, 'cache-control': 'private, max-age=3600' } });
  } catch {
    throw new OutputError('视频输出暂不可用', 503);
  }
}
