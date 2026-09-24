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

export function createImageUploadController(adapters) {
  let objectUrl = '', uploadId = '', canSubmit = false, selection = 0;

  function revokeCurrent() {
    if (objectUrl) adapters.revokeObjectURL(objectUrl);
    objectUrl = '';
  }

  function clear() {
    selection += 1; uploadId = ''; canSubmit = false; revokeCurrent();
    adapters.render(null);
  }

  return {
    get uploadId() { return uploadId; },
    get canSubmit() { return canSubmit; },
    restore(asset, src) {
      selection += 1; revokeCurrent();
      uploadId = asset?.id || ''; canSubmit = Boolean(uploadId && src);
      if (!canSubmit) { adapters.render(null); return; }
      adapters.render(imagePreviewState({ name: asset.name || `参考图 ${asset.id}`, type: asset.mimeType || '', size: asset.size }, src, 'uploaded'));
    },
    async select(file, projectId) {
      selection += 1; const current = selection;
      uploadId = ''; canSubmit = false; revokeCurrent();
      objectUrl = adapters.createObjectURL(file);
      adapters.render(imagePreviewState(file, objectUrl, 'uploading'));
      const validationError = !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
        ? '仅支持 JPG、PNG 或 WebP 图片'
        : file.size > 15 * 1024 * 1024 ? '图片不能超过 15MB' : '';
      if (validationError) {
        adapters.render({ ...imagePreviewState(file, objectUrl, 'failed'), status: validationError });
        throw new Error(validationError);
      }
      if (!projectId) {
        adapters.render(imagePreviewState(file, objectUrl, 'failed'));
        throw new Error('请先选择项目');
      }
      const form = adapters.createFormData(); form.append('file', file); form.append('projectId', projectId);
      try {
        const result = await adapters.request(form);
        if (current !== selection) return;
        uploadId = result.uploadId; canSubmit = Boolean(uploadId);
        adapters.render(imagePreviewState(file, objectUrl, canSubmit ? 'uploaded' : 'failed'));
      } catch (error) {
        if (current !== selection) return;
        uploadId = ''; canSubmit = false; adapters.render(imagePreviewState(file, objectUrl, 'failed'));
        throw error;
      }
    },
    remove: clear,
    projectSwitch: clear,
    unload: clear,
  };
}

export function openImageReplacement(input) {
  input.value = '';
  input.click();
}
