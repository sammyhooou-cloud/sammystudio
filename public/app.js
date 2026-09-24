import { createImageUploadController, openImageReplacement, renderImagePreview } from './image-preview.js';

let currentProjectId = '';
let projectChangeHandler;
export function setCurrentProjectId(projectId) {
  currentProjectId = projectId || '';
  projectChangeHandler?.();
}

export function selectCurrentProject(projects, savedId) {
  return projects.find(({ id }) => id === savedId) || projects[0] || null;
}

export function upsertProject(projects, project) {
  return [project, ...projects.filter(({ id }) => id !== project.id)];
}

export function renameProjectInList(projects, project) {
  return projects.map((item) => item.id === project.id ? project : item);
}

export function closeProjectDrawer(open, reason) {
  return open && !['backdrop', 'escape', 'selection'].includes(reason);
}

export function drawerShouldReturnFocus(reason) {
  return reason === 'backdrop' || reason === 'escape';
}

export function shouldSwitchProject(selectedId, project) {
  return Boolean(project?.id) && project.id !== selectedId;
}

export function readStoredProjectId(storage) {
  try { return storage?.getItem('currentProjectId') || ''; } catch { return ''; }
}

export function storeCurrentProjectId(storage, projectId) {
  try { storage?.setItem('currentProjectId', projectId); return Boolean(storage); } catch { return false; }
}

export function optionsForModel(capabilities, mode, modelId) {
  const group = mode === 'text' ? capabilities.text_to_video : capabilities.image_to_video;
  const model = group?.models?.find((item) => item.model === modelId);
  const args = Object.fromEntries((model?.arguments || []).map((item) => [item.name, item]));
  return { resolutions: args.resolution?.allowedValues || [], durations: args.duration?.allowedValues || [], aspectRatios: args.aspect_ratio?.allowedValues || ['16:9', '9:16', '1:1'] };
}

export function validateWorkspace(value) {
  const errors = {};
  if (!value.projectId) errors.projectId = '请先选择项目';
  if (!value.model) errors.model = '请选择模型';
  if (value.mode === 'text' && !value.prompt?.trim()) errors.prompt = '请输入视频提示词';
  if (value.mode === 'image' && !value.uploadId) errors.uploadId = '请上传首帧参考图';
  return errors;
}

export function buildGenerationPayload(value) {
  return {
    projectId: value.projectId,
    mode: value.mode,
    uploadId: value.uploadId || '',
    model: value.model,
    prompt: value.prompt || '',
    resolution: value.resolution,
    duration: value.duration,
    aspectRatio: value.aspectRatio,
    imageCount: value.imageCount ?? 1,
  };
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
  let mode = 'text', capabilities = {}, projects = [];
  let drawerOpen = false, workspaceLoadSequence = 0, enterPromise;
  const imageInput = document.querySelector('#reference-image');
  const previewView = { empty: document.querySelector('#upload-copy'), preview: document.querySelector('#image-preview'), image: document.querySelector('#image-preview-img'), name: document.querySelector('#image-preview-name'), details: document.querySelector('#image-preview-details'), status: document.querySelector('#image-preview-status') };

  const uploadController = createImageUploadController({
    createObjectURL: (file) => URL.createObjectURL(file), revokeObjectURL: (url) => URL.revokeObjectURL(url), createFormData: () => new FormData(),
    request: (form) => request('/api/uploads', { method: 'POST', body: form }),
    render: (state) => { if (state) renderImagePreview(previewView, state); else { previewView.preview.hidden = true; previewView.empty.hidden = false; } document.querySelector('#generate').disabled = mode === 'image' && !state?.canSubmit; },
  });
  function clearImage() { imageInput.value = ''; uploadController.remove(); }
  projectChangeHandler = () => { imageInput.value = ''; uploadController.projectSwitch(); };
  window.addEventListener('beforeunload', () => uploadController.unload(), { once: true });

  const projectList = document.querySelector('#project-list');
  const projectError = document.querySelector('#project-error');
  const drawerToggle = document.querySelector('#project-drawer-toggle');
  const sidebar = document.querySelector('#project-sidebar');
  const backdrop = document.querySelector('#project-backdrop');
  const createForm = document.querySelector('#create-project-form');
  const renameForm = document.querySelector('#rename-project-form');

  function projectStorage() {
    try { return window.localStorage; } catch { return null; }
  }

  function setDrawer(open, { returnFocus = false, focusTarget = null } = {}) {
    drawerOpen = open;
    sidebar.classList.toggle('open', open);
    backdrop.hidden = !open;
    drawerToggle.setAttribute('aria-expanded', String(open));
    if (open && matchMedia('(max-width: 760px)').matches) document.querySelector('#new-project').focus();
    if (returnFocus) drawerToggle.focus();
    else if (!open && focusTarget) focusTarget.focus();
  }

  function renderProjects() {
    projectList.replaceChildren();
    for (const project of projects) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'project-item';
      button.classList.toggle('active', project.id === currentProjectId);
      button.setAttribute('aria-current', project.id === currentProjectId ? 'page' : 'false');
      const marker = document.createElement('span'); marker.textContent = project.id === currentProjectId ? '●' : '○';
      const name = document.createElement('strong'); name.textContent = project.name;
      button.append(marker, name);
      button.onclick = () => switchProject(project, 'selection');
      projectList.append(button);
    }
    const current = projects.find(({ id }) => id === currentProjectId);
    document.querySelector('#current-project-name').textContent = current?.name || '—';
    document.querySelector('#mobile-project-name').textContent = current?.name || '—';
    document.querySelector('#rename-project').disabled = !current;
    document.querySelector('#rename-project-mobile').disabled = !current;
  }

  function applyWorkspace(workspaceState) {
    const settings = workspaceState?.settings || {};
    document.querySelector('#prompt').value = typeof settings.prompt === 'string' ? settings.prompt : '';
    if (settings.model && [...modelSelect.options].some(({ value }) => value === settings.model)) modelSelect.value = settings.model;
    updateOptions();
    for (const [select, value] of [[resolution, settings.resolution], [duration, settings.duration], [ratio, settings.aspectRatio]]) {
      if (value != null && [...select.options].some((option) => option.value === String(value))) select.value = String(value);
    }
  }

  async function switchProject(project, closeReason) {
    if (!project) return;
    const drawerWasOpen = drawerOpen;
    if (!shouldSwitchProject(currentProjectId, project)) {
      renderProjects();
      if (closeReason) setDrawer(closeProjectDrawer(drawerOpen, closeReason), {
        returnFocus: drawerShouldReturnFocus(closeReason),
        focusTarget: drawerWasOpen && closeReason === 'selection' ? document.querySelector('.workspace-main') : null,
      });
      return;
    }
    const sequence = ++workspaceLoadSequence;
    projectError.textContent = '';
    setCurrentProjectId(project.id);
    storeCurrentProjectId(projectStorage(), project.id);
    renderProjects();
    if (closeReason) setDrawer(closeProjectDrawer(drawerOpen, closeReason), {
      returnFocus: drawerShouldReturnFocus(closeReason),
      focusTarget: drawerWasOpen && closeReason === 'selection' ? document.querySelector('.workspace-main') : null,
    });
    try {
      const workspaceState = await request(`/api/projects/${encodeURIComponent(project.id)}/workspace`);
      if (sequence === workspaceLoadSequence && currentProjectId === project.id) applyWorkspace(workspaceState);
    } catch (error) {
      if (sequence === workspaceLoadSequence) projectError.textContent = error.message;
    }
  }

  async function loadProjects() {
    const response = await request('/api/projects');
    projects = response.projects || [];
    const selected = selectCurrentProject(projects, readStoredProjectId(projectStorage()));
    renderProjects();
    if (selected) await switchProject(selected);
    else projectError.textContent = '暂无可用项目';
  }

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
  async function enterWorkspace() {
    if (enterPromise) return enterPromise;
    loginView.hidden = true; workspace.hidden = false;
    enterPromise = (async () => { await refreshStatus(); await loadProjects(); })();
    try { await enterPromise; } catch (error) { projectError.textContent = error.message; throw error; }
  }
  request('/api/session').then(enterWorkspace).catch(() => {});
  document.querySelector('#password-toggle').onclick = () => { const input = document.querySelector('#password'); input.type = input.type === 'password' ? 'text' : 'password'; };
  loginForm.onsubmit = async (event) => { event.preventDefault(); try { await request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: document.querySelector('#username').value, password: document.querySelector('#password').value }) }); await enterWorkspace(); } catch (error) { document.querySelector('#login-error').textContent = error.message; } };
  document.querySelectorAll('[data-mode]').forEach((button) => button.onclick = () => { mode = button.dataset.mode; document.querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === button)); document.querySelector('#upload-field').hidden = mode !== 'image'; if (mode !== 'image') clearImage(); document.querySelector('#generate').disabled = mode === 'image' && !uploadController.canSubmit; fillModels(); });
  modelSelect.onchange = updateOptions;
  imageInput.onchange = async (event) => {
    const file = event.target.files[0]; if (!file) return;
    try { document.querySelector('#form-error').textContent = ''; await uploadController.select(file, currentProjectId); }
    catch (error) { document.querySelector('#form-error').textContent = error.message; }
  };
  document.querySelector('#replace-image').onclick = () => openImageReplacement(imageInput);
  document.querySelector('#remove-image').onclick = clearImage;
  drawerToggle.onclick = () => setDrawer(!drawerOpen);
  backdrop.onclick = () => setDrawer(closeProjectDrawer(drawerOpen, 'backdrop'), { returnFocus: true });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && drawerOpen) setDrawer(closeProjectDrawer(drawerOpen, 'escape'), { returnFocus: true }); });
  document.querySelector('#new-project').onclick = () => { createForm.hidden = false; document.querySelector('#new-project-name').focus(); };
  document.querySelector('#cancel-create-project').onclick = () => { createForm.hidden = true; createForm.reset(); projectError.textContent = ''; };
  createForm.onsubmit = async (event) => {
    event.preventDefault(); projectError.textContent = '';
    try {
      const project = await request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.querySelector('#new-project-name').value }) });
      projects = upsertProject(projects, project); createForm.hidden = true; createForm.reset(); await switchProject(project, 'selection');
    } catch (error) { projectError.textContent = error.message; }
  };
  function openRenameForm() {
    const project = projects.find(({ id }) => id === currentProjectId); if (!project) return;
    document.querySelector('#rename-project-name').value = project.name; renameForm.hidden = false; document.querySelector('#rename-project-name').focus();
  }
  document.querySelector('#rename-project').onclick = openRenameForm;
  document.querySelector('#rename-project-mobile').onclick = () => { setDrawer(false); openRenameForm(); };
  document.querySelector('#cancel-rename-project').onclick = () => { renameForm.hidden = true; projectError.textContent = ''; };
  renameForm.onsubmit = async (event) => {
    event.preventDefault(); projectError.textContent = '';
    try {
      const project = await request(`/api/projects/${encodeURIComponent(currentProjectId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.querySelector('#rename-project-name').value }) });
      projects = renameProjectInList(projects, project); renameForm.hidden = true; renderProjects();
    } catch (error) { projectError.textContent = error.message; }
  };
  generator.onsubmit = async (event) => { event.preventDefault(); const payload = buildGenerationPayload({ projectId: currentProjectId, mode, uploadId: uploadController.uploadId, model: modelSelect.value, prompt: document.querySelector('#prompt').value, resolution: resolution.value, duration: duration.value, aspectRatio: ratio.value, imageCount: 1 }); const errors = validateWorkspace(payload); if (Object.keys(errors).length) { document.querySelector('#form-error').textContent = Object.values(errors)[0]; return; } try { document.querySelector('#form-error').textContent = ''; document.querySelector('#result-empty').hidden = true; document.querySelector('#result-progress').hidden = false; document.querySelector('#task-state').textContent = '已进入队列'; const task = await request('/api/video/tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(payload) }); document.querySelector('#task-id').textContent = `任务 ${task.id}`; await refreshStatus(); } catch (error) { document.querySelector('#form-error').textContent = error.message; document.querySelector('#task-state').textContent = '提交失败'; } };
  document.querySelector('#refresh-status').onclick = refreshStatus;
  document.querySelector('#logout').onclick = async () => { await request('/api/session', { method: 'DELETE' }); location.reload(); };
}
if (typeof document !== 'undefined') setup();
