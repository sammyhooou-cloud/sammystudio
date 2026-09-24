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

export function createRetryableLoader(load) {
  let active = null;
  return () => {
    if (!active) active = Promise.resolve().then(load).catch((error) => { active = null; throw error; });
    return active;
  };
}

export function nextDrawerFocusIndex(index, count, backwards) {
  if (!count) return -1;
  return (index + (backwards ? -1 : 1) + count) % count;
}

export function switchFailureState(previousProjectId) {
  return { keepProjectId: previousProjectId || '', submissionDisabled: !previousProjectId };
}

export function drawerModalState(open, mobile) {
  const modal = Boolean(open && mobile);
  return { modal, backgroundInert: modal };
}

export function workspaceFormState(capabilities, _previousMode, settings = {}) {
  const mode = settings.mode === 'image' || settings.mode === 'text' ? settings.mode : 'text';
  const group = mode === 'text' ? capabilities.text_to_video : capabilities.image_to_video;
  const models = group?.models || [];
  const model = models.some(({ model: id }) => id === settings.model) ? settings.model : (models[0]?.model || '');
  const options = optionsForModel(capabilities, mode, model);
  const choose = (value, values) => values.includes(String(value)) ? String(value) : (values[0] || '');
  return {
    mode,
    prompt: typeof settings.prompt === 'string' ? settings.prompt : '',
    model,
    resolution: choose(settings.resolution, options.resolutions),
    duration: choose(settings.duration, options.durations),
    aspectRatio: choose(settings.aspectRatio, options.aspectRatios),
    imageCount: Number.isFinite(Number(settings.imageCount)) && Number(settings.imageCount) > 0 ? Number(settings.imageCount) : 1,
  };
}

export function workspaceImageState(projectId, settings = {}, assets = []) {
  const uploadId = typeof settings.uploadId === 'string' ? settings.uploadId : '';
  const asset = assets.find(({ id }) => id === uploadId);
  if (!projectId || !asset) return null;
  return { asset, url: `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(asset.id)}` };
}

function safeMediaUrl(value) {
  if (typeof value !== 'string' || /\s/.test(value)) return '';
  return /^https:\/\/[^\s]+$/i.test(value) || /^\/(?!\/)/.test(value) ? value : '';
}

function hasVideoExtension(value) {
  return /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(value);
}

function videoTyped(value) {
  return [value?.type, value?.mediaType, value?.media_type, value?.mimeType, value?.mime_type, value?.kind]
    .some((item) => typeof item === 'string' && /(?:^|[\/_-])video(?:$|[\/_-])|^video\//i.test(item));
}

export function extractVideoUrl(value) {
  if (typeof value === 'string') { const url = safeMediaUrl(value); return url && hasVideoExtension(url) ? url : ''; }
  if (!value || typeof value !== 'object') return '';
  for (const key of ['videoUrl', 'video_url']) {
    const url = safeMediaUrl(value[key]); if (url) return url;
  }
  const direct = safeMediaUrl(value.url);
  if (direct && (videoTyped(value) || hasVideoExtension(direct))) return direct;
  for (const key of ['video', 'result', 'data']) {
    const found = extractVideoUrl(value[key]); if (found) return found;
  }
  for (const key of ['videos', 'outputs']) {
    if (!Array.isArray(value[key])) continue;
    for (const output of value[key]) {
      const found = extractVideoUrl(output); if (found) return found;
    }
  }
  return '';
}

export function workspaceTaskState(tasks = []) {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const current = safeTasks[0] || null;
  let result = null;
  try { result = current?.resultJson ? JSON.parse(current.resultJson) : null; } catch {}
  return { tasks: safeTasks, current, videoUrl: extractVideoUrl(result) };
}

export function clearVideoElement(video) {
  if (!video) return;
  video.pause?.(); video.removeAttribute?.('src'); video.load?.(); video.hidden = true;
}

export function isCurrentSubmission(activeProjectId, submittedProjectId, token, latestToken) {
  return Boolean(submittedProjectId) && activeProjectId === submittedProjectId && token === latestToken;
}

export async function performGenerationSubmission({ submit, isCurrent, success, fail }) {
  try {
    const result = await submit();
    if (!isCurrent()) return false;
    success(result); return true;
  } catch (error) {
    if (!isCurrent()) return false;
    fail(error); return true;
  }
}

export function commitProjectWorkspace(invalidate, commit, workspaceState) {
  invalidate(); commit(workspaceState);
}

export async function refreshAccountSnapshot({ load, isCurrent, apply }) {
  const status = await load();
  if (!isCurrent()) return false;
  apply(status); return true;
}

export function prependProjectTask(activeProjectId, submittedProjectId, tasks, task) {
  if (!task?.id || activeProjectId !== submittedProjectId) return tasks;
  return [task, ...tasks.filter(({ id }) => id !== task.id)].slice(0, 100);
}

export async function performProjectSwitch({ load, setBusy, commit, fail }) {
  setBusy(true);
  try { await commit(await load()); return true; }
  catch (error) { await fail(error); return false; }
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
  let mode = 'text', capabilities = {}, projects = [], imageCount = 1, projectTasks = [];
  let drawerOpen = false, workspaceLoadSequence = 0, generationSequence = 0, projectSwitchBusy = false;
  const imageInput = document.querySelector('#reference-image');
  const previewView = { empty: document.querySelector('#upload-copy'), preview: document.querySelector('#image-preview'), image: document.querySelector('#image-preview-img'), name: document.querySelector('#image-preview-name'), details: document.querySelector('#image-preview-details'), status: document.querySelector('#image-preview-status') };

  const uploadController = createImageUploadController({
    createObjectURL: (file) => URL.createObjectURL(file), revokeObjectURL: (url) => URL.revokeObjectURL(url), createFormData: () => new FormData(),
    request: (form) => request('/api/uploads', { method: 'POST', body: form }),
    render: (state) => { if (state) renderImagePreview(previewView, state); else { previewView.preview.hidden = true; previewView.empty.hidden = false; } updateSubmitDisabled(); },
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
  const workspaceMain = document.querySelector('.workspace-main');
  const masthead = document.querySelector('.masthead');
  const retryWorkspace = document.querySelector('#workspace-retry');

  function updateSubmitDisabled() {
    document.querySelector('#generate').disabled = projectSwitchBusy || (mode === 'image' && !uploadController.canSubmit);
  }

  function setProjectSwitchBusy(busy) {
    projectSwitchBusy = busy;
    generator.setAttribute('aria-busy', String(busy));
    [...generator.elements].forEach((control) => { control.disabled = busy; });
    updateSubmitDisabled();
  }

  function projectStorage() {
    try { return window.localStorage; } catch { return null; }
  }

  function isMobileDrawer() { return matchMedia('(max-width: 760px)').matches; }

  function setModalState(active) {
    if (active) { sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true'); }
    else { sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal'); }
    for (const element of [workspaceMain, masthead, drawerToggle]) {
      element.inert = active;
      if (active) element.setAttribute('aria-hidden', 'true'); else element.removeAttribute('aria-hidden');
    }
  }

  function setDrawer(open, { returnFocus = false, focusTarget = null } = {}) {
    const { modal: modalOpen } = drawerModalState(open, isMobileDrawer());
    drawerOpen = open;
    sidebar.classList.toggle('open', open);
    backdrop.hidden = !open;
    drawerToggle.setAttribute('aria-expanded', String(open));
    setModalState(modalOpen);
    if (modalOpen) document.querySelector('#new-project').focus();
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
    const state = workspaceFormState(capabilities, mode, workspaceState?.settings || {});
    mode = state.mode;
    document.querySelectorAll('[data-mode]').forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    document.querySelector('#upload-field').hidden = mode !== 'image';
    document.querySelector('#prompt').value = state.prompt;
    fillModels();
    modelSelect.value = state.model;
    updateOptions();
    resolution.value = state.resolution;
    duration.value = state.duration;
    ratio.value = state.aspectRatio;
    imageCount = state.imageCount;
    const restoredImage = workspaceImageState(currentProjectId, workspaceState?.settings, workspaceState?.assets);
    if (restoredImage && mode === 'image') uploadController.restore(restoredImage.asset, restoredImage.url);
    else clearImage();
    projectTasks = Array.isArray(workspaceState?.tasks) ? workspaceState.tasks : [];
    renderTasks();
  }

  function renderTasks() {
    const state = workspaceTaskState(projectTasks);
    const empty = document.querySelector('#result-empty');
    const progress = document.querySelector('#result-progress');
    const video = document.querySelector('#result-video');
    const history = document.querySelector('#task-history');
    history.replaceChildren();
    for (const task of state.tasks) {
      const item = document.createElement('button'); item.type = 'button'; item.className = 'task-history-item';
      const id = document.createElement('strong'); id.textContent = task.id || '未知任务';
      const status = document.createElement('span'); status.textContent = task.status || '未知状态';
      item.append(id, status); item.onclick = () => renderSelectedTask(task); history.append(item);
    }
    if (!state.current) {
      empty.hidden = false; progress.hidden = true; clearVideoElement(video);
      document.querySelector('#task-state').textContent = '等待提交'; document.querySelector('#task-id').textContent = '';
      return;
    }
    renderSelectedTask(state.current);
  }

  function renderSelectedTask(task) {
    const state = workspaceTaskState([task]);
    document.querySelector('#result-empty').hidden = true; document.querySelector('#result-progress').hidden = false;
    document.querySelector('#task-state').textContent = task.status || '未知状态';
    document.querySelector('#task-id').textContent = `任务 ${task.id || '—'}`;
    const video = document.querySelector('#result-video');
    clearVideoElement(video);
    if (state.videoUrl) { video.src = state.videoUrl; video.hidden = false; }
  }

  function showProjectLoadError(error) {
    projectError.textContent = `项目加载失败：${error.message}`;
    if (isMobileDrawer()) { setDrawer(true); projectError.focus(); }
  }

  async function switchProject(project, closeReason) {
    if (!project) return;
    const drawerWasOpen = drawerOpen;
    if (!shouldSwitchProject(currentProjectId, project)) {
      ++workspaceLoadSequence;
      setProjectSwitchBusy(false);
      projectError.textContent = '';
      renderProjects();
      if (closeReason) setDrawer(closeProjectDrawer(drawerOpen, closeReason), {
        returnFocus: drawerShouldReturnFocus(closeReason),
        focusTarget: drawerWasOpen && closeReason === 'selection' ? document.querySelector('.workspace-main') : null,
      });
      return;
    }
    const sequence = ++workspaceLoadSequence;
    projectError.textContent = '正在加载项目…';
    if (closeReason) setDrawer(closeProjectDrawer(drawerOpen, closeReason), {
      returnFocus: drawerShouldReturnFocus(closeReason),
      focusTarget: drawerWasOpen && closeReason === 'selection' ? document.querySelector('.workspace-main') : null,
    });
    await performProjectSwitch({
      setBusy: setProjectSwitchBusy,
      load: () => request(`/api/projects/${encodeURIComponent(project.id)}/workspace`),
      commit: (workspaceState) => {
        if (sequence !== workspaceLoadSequence) return;
        commitProjectWorkspace(
          () => { generationSequence += 1; },
          () => {
            setCurrentProjectId(project.id);
            storeCurrentProjectId(projectStorage(), project.id);
            applyWorkspace(workspaceState);
            renderProjects();
            projectError.textContent = '';
            setProjectSwitchBusy(false);
          },
          workspaceState,
        );
      },
      fail: (error) => {
        if (sequence !== workspaceLoadSequence) return;
        const failure = switchFailureState(currentProjectId);
        showProjectLoadError(error);
        renderProjects();
        if (!failure.submissionDisabled) setProjectSwitchBusy(false);
        else throw error;
      },
    });
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
  function applyAccountStatus(status) {
    const online = status.connection === 'online';
    statusLight.classList.toggle('online', online); statusText.textContent = online ? 'MCP 在线' : 'MCP 未连接';
    document.querySelector('#membership').textContent = status.membership ?? '—';
    document.querySelector('#credits').textContent = status.credits ?? '暂不可用';
    document.querySelector('#last-check').textContent = `最后检查 ${new Date(status.checkedAt).toLocaleTimeString()}`;
  }
  const loadWorkspaceEntry = createRetryableLoader(async () => {
    await refreshStatus();
    await loadProjects();
  });
  async function enterWorkspace() {
    loginView.hidden = true; workspace.hidden = false;
    retryWorkspace.hidden = true;
    try { await loadWorkspaceEntry(); }
    catch (error) { projectError.textContent = `工作台加载失败：${error.message}`; retryWorkspace.hidden = false; throw error; }
  }
  request('/api/session').then(enterWorkspace).catch(() => {});
  document.querySelector('#password-toggle').onclick = () => { const input = document.querySelector('#password'); input.type = input.type === 'password' ? 'text' : 'password'; };
  loginForm.onsubmit = async (event) => { event.preventDefault(); try { await request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: document.querySelector('#username').value, password: document.querySelector('#password').value }) }); await enterWorkspace(); } catch (error) { document.querySelector('#login-error').textContent = error.message; } };
  document.querySelectorAll('[data-mode]').forEach((button) => button.onclick = () => { mode = button.dataset.mode; document.querySelectorAll('[data-mode]').forEach((item) => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); }); document.querySelector('#upload-field').hidden = mode !== 'image'; if (mode !== 'image') clearImage(); updateSubmitDisabled(); fillModels(); });
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
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawerOpen) { setDrawer(false, { returnFocus: true }); return; }
    if (event.key !== 'Tab' || !drawerOpen || !isMobileDrawer()) return;
    const focusable = [...sidebar.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')].filter((element) => !element.hidden && element.offsetParent !== null);
    const current = focusable.indexOf(document.activeElement);
    const next = nextDrawerFocusIndex(current < 0 ? (event.shiftKey ? 0 : -1) : current, focusable.length, event.shiftKey);
    if (next >= 0 && ((event.shiftKey && current <= 0) || (!event.shiftKey && current === focusable.length - 1) || current < 0)) { event.preventDefault(); focusable[next].focus(); }
  });
  addEventListener('resize', () => { if (drawerOpen && !isMobileDrawer()) setDrawer(false); });
  retryWorkspace.onclick = () => { enterWorkspace().catch(() => {}); };
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
  generator.onsubmit = async (event) => { event.preventDefault(); if (projectSwitchBusy) return; const submittedProjectId = currentProjectId; const submissionToken = ++generationSequence; const submissionIsCurrent = () => isCurrentSubmission(currentProjectId, submittedProjectId, submissionToken, generationSequence); const payload = buildGenerationPayload({ projectId: submittedProjectId, mode, uploadId: uploadController.uploadId, model: modelSelect.value, prompt: document.querySelector('#prompt').value, resolution: resolution.value, duration: duration.value, aspectRatio: ratio.value, imageCount }); const errors = validateWorkspace(payload); if (Object.keys(errors).length) { document.querySelector('#form-error').textContent = Object.values(errors)[0]; return; } document.querySelector('#form-error').textContent = ''; document.querySelector('#result-empty').hidden = true; document.querySelector('#result-progress').hidden = false; document.querySelector('#task-state').textContent = '已进入队列'; await performGenerationSubmission({ submit: () => request('/api/video/tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(payload) }), isCurrent: submissionIsCurrent, success: (task) => { projectTasks = prependProjectTask(currentProjectId, submittedProjectId, projectTasks, { id: task.id, remoteId: task.remote_id, status: task.status, mode: payload.mode, resultJson: null, createdAt: Date.now(), updatedAt: Date.now() }); renderTasks(); void refreshAccountSnapshot({ load: () => request('/api/kling/status'), isCurrent: submissionIsCurrent, apply: applyAccountStatus }).catch(() => {}); }, fail: (error) => { document.querySelector('#form-error').textContent = error.message; document.querySelector('#task-state').textContent = '提交失败'; } }); };
  document.querySelector('#refresh-status').onclick = refreshStatus;
  document.querySelector('#logout').onclick = async () => { await request('/api/session', { method: 'DELETE' }); location.reload(); };
}
if (typeof document !== 'undefined') setup();
