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
  return { stream, complete: () => completed, exceeded: () => exceeded, bytes: () => size, cancel: () => reader.cancel().catch(() => {}) };
}

function validSingleRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (first !== null && !Number.isSafeInteger(first)) return false;
  if (last !== null && !Number.isSafeInteger(last)) return false;
  if (first === null) return last > 0 && size > 0;
  return first < size && (last === null || last >= first);
}

function rangeNotSatisfiable(size) {
  return new Response(null, { status: 416, headers: {
    'accept-ranges': 'bytes',
    'content-range': `bytes */${size}`,
    'cache-control': 'private, max-age=3600',
  } });
}

async function ownedOutput(db, taskId, projectId) {
  return db.prepare(`SELECT task_outputs.* FROM task_outputs
    JOIN project_tasks ON project_tasks.task_id = task_outputs.task_id
    WHERE task_outputs.task_id = ? AND project_tasks.project_id = ?`).bind(taskId, projectId).first();
}

async function cleanupIncompleteOutput(env, taskId, projectId, objectKey) {
  try {
    const winner = await ownedOutput(env.DB, taskId, projectId);
    if (winner?.object_key !== objectKey) await env.MEDIA.delete(objectKey);
  } catch { /* Preserve a winning object when ownership cannot be checked. */ }
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
    const { contentType } = videoMetadata(response, httpsUrl(sourceUrl), sizeLimit);
    monitored = limitedVideoBody(response.body, sizeLimit);
    const outputId = idFactory();
    objectKey = `outputs/${taskId}/${outputId}.mp4`;
    await env.MEDIA.put(objectKey, monitored.stream, { httpMetadata: { contentType } });
    if (!monitored.complete() || monitored.exceeded() || monitored.bytes() === 0) throw persistenceError();
    await env.DB.prepare('INSERT OR IGNORE INTO task_outputs (id, task_id, object_key, content_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(outputId, taskId, objectKey, contentType, monitored.bytes(), now()).run();
    const winner = await ownedOutput(env.DB, taskId, projectId);
    if (!winner) throw persistenceError();
    if (winner.object_key !== objectKey) await env.MEDIA.delete(objectKey);
    return outputUrl(projectId, taskId);
  } catch (error) {
    if (monitored) await monitored.cancel();
    if (objectKey) await cleanupIncompleteOutput(env, taskId, projectId, objectKey);
    if (error instanceof OutputError) throw error;
    throw persistenceError();
  }
}

export async function readTaskOutput({ taskId, projectId, env, range = null }) {
  if (!validIds(taskId, projectId)) throw new OutputError('任务参数无效', 400);
  try {
    const output = await ownedOutput(env.DB, taskId, projectId);
    if (!output) return null;
    const requestedRange = range !== null;
    if (requestedRange && (!Number.isSafeInteger(output.byte_size) || output.byte_size < 0)) throw new Error('invalid output size');
    if (requestedRange && (typeof range !== 'string' || !validSingleRange(range, output.byte_size))) return rangeNotSatisfiable(output.byte_size);
    const object = await env.MEDIA.get(output.object_key, requestedRange ? { range: new Headers({ range }) } : undefined);
    if (!object) return null;
    const size = Number.isSafeInteger(object.size) && object.size >= 0 ? object.size : output.byte_size;
    const headers = { 'content-type': output.content_type, 'cache-control': 'private, max-age=3600', 'accept-ranges': 'bytes' };
    if (requestedRange) {
      const { offset, length } = object.range || {};
      if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
          offset < 0 || length <= 0 || offset + length > size) throw new Error('invalid R2 range');
      headers['content-range'] = `bytes ${offset}-${offset + length - 1}/${size}`;
      headers['content-length'] = String(length);
      return new Response(object.body, { status: 206, headers });
    }
    if (Number.isSafeInteger(size) && size >= 0) headers['content-length'] = String(size);
    return new Response(object.body, { headers });
  } catch {
    throw new OutputError('视频输出暂不可用', 503);
  }
}
