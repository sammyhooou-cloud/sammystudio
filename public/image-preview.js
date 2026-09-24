const MIME_LABELS = { 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/webp': 'WebP' };

export function formatBytes(bytes) {
  const size = Number.isFinite(Number(bytes)) ? Math.max(0, Number(bytes)) : 0;
  if (size < 1024) return `${size} B`;
  const value = size < 1024 * 1024 ? size / 1024 : size / (1024 * 1024);
  return `${Number(value.toFixed(2))} ${size < 1024 * 1024 ? 'KB' : 'MB'}`;
}

function friendlyFormat(file) {
  if (MIME_LABELS[file?.type]) return MIME_LABELS[file.type];
  const subtype = file?.type?.match(/^image\/([a-z0-9.+-]+)$/i)?.[1];
  if (subtype) return subtype.split('+')[0].toUpperCase();
  const extension = file?.name?.match(/\.([a-z0-9]+)$/i)?.[1];
  return extension ? extension.toUpperCase() : '未知格式';
}

const PHASES = { uploading: { status: '上传中…', canSubmit: false }, uploaded: { status: '上传成功', canSubmit: true }, failed: { status: '上传失败', canSubmit: false } };

export function imagePreviewState(file, src, phase = 'uploading') {
  return { src, name: file?.name || '未命名图片', format: friendlyFormat(file), size: formatBytes(file?.size), ...(PHASES[phase] || PHASES.failed) };
}

export function renderImagePreview(view, state) {
  view.empty.hidden = true; view.preview.hidden = false;
  view.image.src = state.src; view.image.alt = `${state.name} 预览`;
  view.name.textContent = state.name; view.details.textContent = `${state.format} · ${state.size}`; view.status.textContent = state.status;
  if (view.status.dataset) view.status.dataset.phase = state.canSubmit ? 'uploaded' : state.status === PHASES.failed.status ? 'failed' : 'uploading';
}
