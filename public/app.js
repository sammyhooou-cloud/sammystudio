import { imagePreviewState, renderImagePreview } from './image-preview.js';

let currentProjectId = '';
let projectChangeHandler;
export function setCurrentProjectId(projectId) {
  currentProjectId = projectId || '';
  projectChangeHandler?.();
}

export function optionsForModel(capabilities, mode, modelId) {
  const group = mode === 'text' ? capabilities.text_to_video : capabilities.image_to_video;
  const model = group?.models?.find((item) => item.model === modelId);
  const args = Object.fromEntries((model?.arguments || []).map((item) => [item.name, item]));
  return { resolutions: args.resolution?.allowedValues || [], durations: args.duration?.allowedValues || [], aspectRatios: args.aspect_ratio?.allowedValues || ['16:9', '9:16', '1:1'] };
}

export function validateWorkspace(value) {
  const errors = {};
  if (!value.model) errors.model = '请选择模型';
  if (value.mode === 'text' && !value.prompt?.trim()) errors.prompt = '请输入视频提示词';
  if (value.mode === 'image' && !value.uploadId) errors.uploadId = '请上传首帧参考图';
  return errors;
}

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body;
}

function setup() {
  const loginView = document.querySelector('#login-view');
  const workspace = document.querySelector('#workspace-view');
  const loginForm = document.querySelector('#login-form');
  const generator = document.querySelector('#generator-form');
  const statusLight = document.querySelector('#status-light');
  const statusText = document.querySelector('#status-text');
  const modelSelect = document.querySelector('#model');
  const resolution = document.querySelector('#resolution');
  const duration = document.querySelector('#duration');
  const ratio = document.querySelector('#aspect-ratio');
  let mode = 'text', uploadId = '', capabilities = {}, imageUrl = '', imageSelection = 0;
  const imageInput = document.querySelector('#reference-image');
  const previewView = { empty: document.querySelector('#upload-copy'), preview: document.querySelector('#image-preview'), image: document.querySelector('#image-preview-img'), name: document.querySelector('#image-preview-name'), details: document.querySelector('#image-preview-details'), status: document.querySelector('#image-preview-status') };

  function clearImage() {
    imageSelection += 1; uploadId = ''; imageInput.value = '';
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = ''; previewView.preview.hidden = true; previewView.empty.hidden = false;
  }
  projectChangeHandler = clearImage;
  window.addEventListener('beforeunload', () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, { once: true });

  const fill = (select, values) => { select.innerHTML = values.map((value) => `<option value="${value}">${value}${select === duration ? ' 秒' : ''}</option>`).join(''); };
  function updateOptions() { const values = optionsForModel(capabilities, mode, modelSelect.value); fill(resolution, values.resolutions); fill(duration, values.durations); fill(ratio, values.aspectRatios); }
  function fillModels() { const group = mode === 'text' ? capabilities.text_to_video : capabilities.image_to_video; modelSelect.innerHTML = (group?.models || []).map((item) => `<option value="${item.model}">${item.alias?.split(',')[0] || item.model}</option>`).join(''); updateOptions(); }

  async function refreshStatus() {
    statusText.textContent = '正在检测';
    const status = await request('/api/kling/status'); capabilities = status.models || {};
    const online = status.connection === 'online'; statusLight.classList.toggle('online', online); statusText.textContent = online ? 'MCP 在线' : 'MCP 未连接';
    document.querySelector('#membership').textContent = status.membership ?? '—'; document.querySelector('#credits').textContent = status.credits ?? '暂不可用'; document.querySelector('#last-check').textContent = `最后检查 ${new Date(status.checkedAt).toLocaleTimeString()}`;
    fillModels(); if (!online) statusText.parentElement.onclick = () => { location.href = '/api/kling/oauth/start'; };
  }
  async function enterWorkspace() { loginView.hidden = true; workspace.hidden = false; await refreshStatus(); }
  request('/api/session').then(enterWorkspace).catch(() => {});
  document.querySelector('#password-toggle').onclick = () => { const input = document.querySelector('#password'); input.type = input.type === 'password' ? 'text' : 'password'; };
  loginForm.onsubmit = async (event) => { event.preventDefault(); try { await request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: document.querySelector('#username').value, password: document.querySelector('#password').value }) }); await enterWorkspace(); } catch (error) { document.querySelector('#login-error').textContent = error.message; } };
  document.querySelectorAll('[data-mode]').forEach((button) => button.onclick = () => { mode = button.dataset.mode; document.querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === button)); document.querySelector('#upload-field').hidden = mode !== 'image'; if (mode !== 'image') clearImage(); fillModels(); });
  modelSelect.onchange = updateOptions;
  imageInput.onchange = async (event) => {
    const file = event.target.files[0]; if (!file) return;
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type) || file.size > 15 * 1024 * 1024) { clearImage(); document.querySelector('#form-error').textContent = !allowed.includes(file.type) ? '仅支持 JPG、PNG 或 WebP 图片' : '图片不能超过 15MB'; return; }
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    const selection = ++imageSelection;
    imageUrl = URL.createObjectURL(file); uploadId = '';
    renderImagePreview(previewView, imagePreviewState(file, imageUrl, 'uploading'));
    const form = new FormData(); form.append('file', file);
    if (!currentProjectId) { renderImagePreview(previewView, imagePreviewState(file, imageUrl, 'failed')); document.querySelector('#form-error').textContent = '请先选择项目'; return; }
    form.append('projectId', currentProjectId);
    try { document.querySelector('#form-error').textContent = ''; const result = await request('/api/uploads', { method: 'POST', body: form }); if (selection !== imageSelection) return; uploadId = result.uploadId; renderImagePreview(previewView, imagePreviewState(file, imageUrl, 'uploaded')); }
    catch (error) { if (selection !== imageSelection) return; uploadId = ''; renderImagePreview(previewView, imagePreviewState(file, imageUrl, 'failed')); document.querySelector('#form-error').textContent = error.message; }
  };
  document.querySelector('#replace-image').onclick = () => imageInput.click();
  document.querySelector('#remove-image').onclick = clearImage;
  generator.onsubmit = async (event) => { event.preventDefault(); const payload = { mode, uploadId, model: modelSelect.value, prompt: document.querySelector('#prompt').value, resolution: resolution.value, duration: duration.value, aspectRatio: ratio.value, imageCount: 1 }; const errors = validateWorkspace(payload); if (Object.keys(errors).length) { document.querySelector('#form-error').textContent = Object.values(errors)[0]; return; } try { document.querySelector('#form-error').textContent = ''; document.querySelector('#result-empty').hidden = true; document.querySelector('#result-progress').hidden = false; document.querySelector('#task-state').textContent = '已进入队列'; const task = await request('/api/video/tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(payload) }); document.querySelector('#task-id').textContent = `任务 ${task.id}`; await refreshStatus(); } catch (error) { document.querySelector('#form-error').textContent = error.message; document.querySelector('#task-state').textContent = '提交失败'; } };
  document.querySelector('#refresh-status').onclick = refreshStatus;
  document.querySelector('#logout').onclick = async () => { await request('/api/session', { method: 'DELETE' }); location.reload(); };
}
if (typeof document !== 'undefined') setup();
