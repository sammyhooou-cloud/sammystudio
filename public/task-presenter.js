export function normalizeTaskStatus(status) {
  return typeof status === 'string' ? status.toLowerCase() : '';
}

export function parseTaskRequest(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function parseTaskResult(value) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : null;
  try { return JSON.parse(value); } catch { return null; }
}

function safeMediaUrl(value) {
  if (typeof value !== 'string' || /\s/.test(value)) return '';
  return /^https:\/\/[^\s]+$/i.test(value) || /^\/(?!\/)/.test(value) ? value : '';
}

function hasVideoExtension(value) {
  return /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(value);
}

function videoTyped(value) {
  return [value?.type, value?.mediaType, value?.media_type, value?.mimeType, value?.mime_type, value?.contentType, value?.kind]
    .some((item) => typeof item === 'string' && /(?:^|[\/_-])video(?:$|[\/_-])|^video\//i.test(item));
}

export function safeVideoUrl(value) {
  if (typeof value === 'string') { const url = safeMediaUrl(value); return url && hasVideoExtension(url) ? url : ''; }
  if (!value || typeof value !== 'object') return '';
  for (const key of ['videoUrl', 'video_url', 'urlWithoutWatermark', 'url_without_watermark']) {
    const url = safeMediaUrl(value[key]);
    if (url && (key === 'videoUrl' || key === 'video_url' || videoTyped(value) || hasVideoExtension(url))) return url;
  }
  const direct = safeMediaUrl(value.url);
  if (direct && (videoTyped(value) || hasVideoExtension(direct))) return direct;
  for (const key of ['video', 'result', 'data']) {
    const found = safeVideoUrl(value[key]); if (found) return found;
  }
  for (const key of ['videos', 'outputs', 'works']) {
    if (!Array.isArray(value[key])) continue;
    for (const output of value[key]) {
      const found = safeVideoUrl(output); if (found) return found;
    }
  }
  return '';
}

export function taskProgress(result) {
  for (const source of [result, result?.data]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of ['progress', 'percentage', 'percent']) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) return Math.round(value);
    }
  }
  return null;
}

export function taskDetailHref(projectId, taskId) {
  return `/projects/${encodeURIComponent(projectId)}/results/${encodeURIComponent(taskId)}`;
}
