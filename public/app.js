import { createImageUploadController, openImageReplacement, renderImagePreview } from './image-preview.js';
import { normalizeTaskStatus, parseTaskRequest, parseTaskResult, safeVideoUrl as extractVideoUrl, taskProgress as extractTaskProgress, taskDetailHref } from './task-presenter.js';

export { extractVideoUrl, extractTaskProgress };

let currentProjectId = '';
let projectChangeHandler;
export function setCurrentProjectId(projectId) {
  currentProjectId = projectId || '';
  projectChangeHandler?.();
}

export function selectCurrentProject(projects, savedId) {
  return projects.find(({ id }) => id === savedId) || projects[0] || null;
}

export function selectInitialProject(projects, savedId, search = '') {
  const requestedId = new URLSearchParams(search).get('project');
  return selectCurrentProject(projects, projects.some(({ id }) => id === requestedId) ? requestedId : savedId);
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

export function createProjectDrafts() {
  const drafts = new Map();
  return {
    save(projectId, settings) { if (projectId) drafts.set(projectId, { ...settings }); },
    load(projectId, fallback = {}) { return { ...(drafts.get(projectId) ?? fallback) }; },
  };
}

export function createSubmissionAttemptController(keyFactory = () => crypto.randomUUID(), storage = null) {
  const storageKey = 'klingPendingAttempts';
  let saved = [];
  try { const value = JSON.parse(storage?.getItem(storageKey) || '[]'); if (Array.isArray(value)) saved = value; } catch {}
  const cleanPayload = (value) => buildGenerationPayload(value);
  const pending = new Map();
  for (const entry of saved) {
    // Accept the previous signature/key format without persisting arbitrary fields.
    const payload = Array.isArray(entry) ? (() => { try { return JSON.parse(entry[0]); } catch { return null; } })() : entry?.payload;
    const key = Array.isArray(entry) ? entry[1] : entry?.key;
    if (payload && typeof payload.projectId === 'string' && payload.projectId && typeof key === 'string' && key) {
      const safe = cleanPayload(payload);
      pending.set(safe.projectId, { key, payload: safe, signature: JSON.stringify(safe) });
    }
  }
  let inFlight = false;
  const persist = () => { try { storage?.setItem(storageKey, JSON.stringify([...pending.values()].map(({ key, payload }) => ({ key, payload })))); } catch {} };
  return {
    get inFlight() { return inFlight; },
    pendingForProject(projectId) { const attempt = pending.get(projectId); return attempt ? { ...attempt, payload: { ...attempt.payload } } : null; },
    begin(payload) {
      if (inFlight) return null;
      const safe = cleanPayload(payload);
      const signature = JSON.stringify(safe);
      const existing = pending.get(safe.projectId);
      if (existing && existing.signature !== signature) return null;
      const key = existing?.key || keyFactory();
      pending.set(safe.projectId, { key, signature, payload: safe });
      persist();
      inFlight = true;
      return { key, signature, payload: safe };
    },
    settle(attempt, definitiveSuccess) {
      inFlight = false;
      if (definitiveSuccess && pending.get(attempt.payload.projectId)?.key === attempt.key) { pending.delete(attempt.payload.projectId); persist(); }
    },
    resolve(attempt) {
      if (attempt && pending.get(attempt.payload.projectId)?.key === attempt.key) { pending.delete(attempt.payload.projectId); persist(); }
    },
  };
}

const unresolvedAttemptGuidance = '上次提交结果尚未确认。请保持原设置重试以复用同一请求，或先人工核对可灵任务；不要更改设置后重复提交。';

export function shouldShowPendingAttemptGuidance(attempts, projectId) {
  return Boolean(projectId && !attempts.inFlight && attempts.pendingForProject(projectId));
}

export function pendingAttemptMessage(currentText, shouldShow) {
  const text = typeof currentText === 'string' ? currentText : '';
  if (shouldShow) return text && text !== unresolvedAttemptGuidance ? text : unresolvedAttemptGuidance;
  return text === unresolvedAttemptGuidance ? '' : text;
}

export function pendingWorkspaceSettings(attempts, projectId, assets = [], capabilities = {}) {
  const pending = attempts.pendingForProject(projectId);
  if (!pending) return null;
  const settings = workspaceFormState(capabilities, 'text', pending.payload);
  return { ...settings, uploadId: workspaceImageState(projectId, pending.payload, assets)?.asset.id || '' };
}

export function nextPollDelay(current, success) { return success ? 3000 : Math.min(Math.max(current, 3000) * 2, 30000); }
export function createActiveTaskPoller({ load, onUpdate, schedule = setTimeout, cancel = clearTimeout }) {
  let projectId = '', activeIds = [], timer = null, inFlight = false, generation = 0, nextIndex = 0, delay = 3000;
  const active = (task) => ['queued', 'generating', 'submitting'].includes(task.status);
  const scheduleNext = () => {
    if (!timer && !inFlight && activeIds.length) timer = schedule(tick, delay);
  };
  const tick = async () => {
    timer = null;
    if (!activeIds.length || inFlight) return;
    inFlight = true;
    const selectedId = activeIds[nextIndex % activeIds.length];
    const selectedIndex = nextIndex % activeIds.length;
    const selectedProject = projectId;
    const selectedGeneration = generation;
    try {
      const task = await load(selectedProject, selectedId);
      if (selectedGeneration === generation && selectedProject === projectId) {
        onUpdate(task);
        delay = nextPollDelay(delay, true);
        nextIndex = activeIds.includes(selectedId) ? (activeIds.indexOf(selectedId) + 1) % activeIds.length : Math.min(selectedIndex, Math.max(activeIds.length - 1, 0));
      }
    } catch {
      if (selectedGeneration === generation) delay = nextPollDelay(delay, false);
      if (activeIds.length) nextIndex = (selectedIndex + 1) % activeIds.length;
    } finally { inFlight = false; scheduleNext(); }
  };
  return {
    sync(nextProjectId, tasks) {
      if (nextProjectId !== projectId) { generation += 1; if (timer) cancel(timer); timer = null; projectId = nextProjectId; delay = 3000; nextIndex = 0; }
      activeIds = nextProjectId ? tasks.filter(active).map(({ id }) => id).filter(Boolean) : [];
      if (!activeIds.length && timer) { cancel(timer); timer = null; }
      scheduleNext();
    },
    prioritize(taskId) { const index = activeIds.indexOf(taskId); if (index >= 0) nextIndex = index; },
    stop() { generation += 1; if (timer) cancel(timer); timer = null; projectId = ''; activeIds = []; nextIndex = 0; delay = 3000; },
  };
}
export function shouldSaveStaleUpload(startProjectEpoch, currentProjectEpoch) { return startProjectEpoch !== currentProjectEpoch; }
export function sidebarShouldBeInert(open, mobile) { return mobile && !open; }

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

export function workspaceTaskState(tasks = []) {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const current = safeTasks[0] || null;
  let result = null;
  try { result = current?.resultJson ? JSON.parse(current.resultJson) : null; } catch {}
  return { tasks: safeTasks, current, videoUrl: extractVideoUrl(result) };
}

const activeTaskStatuses = new Set(['submitting', 'queued', 'generating']);
const successfulTaskStatuses = new Set(['succeeded', 'success', 'done', 'completed']);

function taskStatus(task) {
  return normalizeTaskStatus(task?.status);
}

function taskResult(task) {
  return parseTaskResult(task?.resultJson);
}

export function taskListItemModel(task, projectId) {
  const status = taskStatus(task);
  if (activeTaskStatuses.has(status)) {
    const label = { submitting: '正在提交', queued: '排队中', generating: '生成中' }[status];
    return { label, action: '生成中', href: '', tone: 'active' };
  }
  const href = projectId && task?.id ? taskDetailHref(projectId, task.id) : '';
  if (successfulTaskStatuses.has(status)) {
    return { label: '已完成', action: extractVideoUrl(taskResult(task)) ? '查看结果' : '查看详情', href, tone: 'success' };
  }
  return status === 'failed'
    ? { label: '生成失败', action: '查看详情', href, tone: 'failure' }
    : { label: '状态待核对', action: '查看详情', href, tone: 'warning' };
}

export function renderTaskHistory(history, tasks, projectId, selectedTaskId = '') {
  const view = history.ownerDocument;
  const focusedTaskId = history.contains(view.activeElement) ? view.activeElement.dataset.taskId : '';
  history.replaceChildren();
  for (const task of tasks) {
    const model = taskListItemModel(task, projectId);
    const item = view.createElement('article');
    item.className = `task-history-item tone-${model.tone}`;
    item.dataset.taskId = task?.id || '';
    item.classList.toggle('active', Boolean(selectedTaskId) && selectedTaskId === task?.id);
    const details = view.createElement('div');
    details.className = 'task-history-details';
    const status = view.createElement('strong');
    status.className = 'task-history-status';
    status.textContent = model.label;
    const metadata = view.createElement('div');
    metadata.className = 'task-history-meta';
    const mode = view.createElement('span');
    mode.textContent = task?.mode === 'image' ? '图生视频' : task?.mode === 'text' ? '文生视频' : '模式待同步';
    const time = view.createElement('time');
    const value = task?.createdAt;
    const date = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? new Date(value) : null;
    if (date && Number.isFinite(date.getTime())) {
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleString('zh-CN', { hour12: false });
    } else time.textContent = '时间待同步';
    metadata.append(mode, time);
    const summary = view.createElement('p');
    summary.className = 'task-history-summary';
    const request = parseTaskRequest(task?.requestJson);
    const scalar = (value) => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    const duration = scalar(request.duration);
    summary.textContent = [scalar(request.model), scalar(request.resolution), duration ? `${duration}秒` : '', scalar(request.aspectRatio)].filter(Boolean).join(' · ') || '参数待同步';
    details.append(status, metadata, summary);
    const action = view.createElement(model.href ? 'a' : 'span');
    action.className = 'task-history-action';
    action.textContent = model.action;
    if (model.href) { action.href = model.href; action.dataset.taskId = task?.id || ''; }
    item.append(details, action);
    history.append(item);
  }
  if (focusedTaskId) [...history.querySelectorAll('a[data-task-id]')].find((link) => link.dataset.taskId === focusedTaskId)?.focus();
}

export function taskPresentationState(tasks = [], selectedTaskId = '') {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const current = safeTasks.find((task) => task?.id === selectedTaskId) || safeTasks[0] || null;
  const completed = safeTasks
    .filter((task) => successfulTaskStatuses.has(taskStatus(task)))
    .map((task) => ({ task, videoUrl: extractVideoUrl(taskResult(task)) }))
    .filter(({ videoUrl }) => Boolean(videoUrl));
  const status = taskStatus(current);
  const active = activeTaskStatuses.has(status);
  const videoUrl = successfulTaskStatuses.has(status)
    ? (completed.find(({ task }) => task === current)?.videoUrl || '')
    : '';
  const kind = !current ? 'empty' : active ? 'active' : videoUrl ? 'video' : 'terminal';
  return {
    tasks: safeTasks,
    current,
    kind,
    videoUrl,
    progress: active ? extractTaskProgress(taskResult(current)) : null,
    completed,
  };
}

export function clearVideoElement(video) {
  if (!video) return;
  video.pause?.(); video.removeAttribute?.('src'); video.load?.(); video.hidden = true;
}

export function syncResultVideo(video, videoUrl = '') {
  if (!video) return;
  const currentUrl = video.getAttribute?.('src') || '';
  if (videoUrl && currentUrl === videoUrl && !video.hidden) return;
  if (currentUrl || !video.hidden) clearVideoElement(video);
  if (videoUrl) { video.src = videoUrl; video.hidden = false; }
}

export function resolveResultStage(baseState, stageOverride = null) {
  return stageOverride ?? baseState;
}

export function selectedCompletedTaskId(stageState) {
  return stageState?.kind === 'video' ? stageState.current?.id || '' : '';
}

export function returnCurrentTaskId(tasks, selectedTaskId, stageOverride = null, submittingWithoutTask = false) {
  if (!selectedTaskId || stageOverride || submittingWithoutTask) return '';
  const state = taskPresentationState(tasks, selectedTaskId);
  const headId = state.tasks[0]?.id || '';
  return headId && headId !== selectedTaskId && state.current?.id === selectedTaskId && state.kind === 'video' ? headId : '';
}

export function reconciliationMayClaimStage(startGeneration, currentGeneration, startKey, currentKey) {
  return startGeneration === currentGeneration && Boolean(startKey) && startKey === currentKey;
}

function reconciliationStatusRank(status) {
  const normalized = taskStatus({ status });
  if (!normalized) return -1;
  return { submitting: 0, queued: 1, generating: 2 }[normalized] ?? 3;
}

export function mergeReconciledTask(tasks, row, canClaimStage) {
  if (!row?.id) return tasks;
  if (tasks.some(({ id }) => id === row.id)) {
    return tasks.map((item) => {
      if (item.id !== row.id) return item;
      const promoteStatus = reconciliationStatusRank(row.status) > reconciliationStatusRank(item.status);
      return {
        ...item,
        remoteId: canClaimStage ? (row.remoteId || item.remoteId) : (item.remoteId || row.remoteId),
        status: promoteStatus && row.status ? row.status : item.status,
        resultJson: canClaimStage ? (row.resultJson ?? item.resultJson) : (item.resultJson ?? row.resultJson),
      };
    });
  }
  return canClaimStage ? [row, ...tasks].slice(0, 100) : [...tasks.slice(0, 99), row];
}

export function reconciledStageSelection(selectedTaskId, stageOverride, recoveredTaskId, canClaimStage) {
  return canClaimStage
    ? { selectedTaskId: recoveredTaskId || '', stageOverride: null }
    : { selectedTaskId, stageOverride };
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
  if (!response.ok) { const error = new Error(body.error || '请求失败'); error.task = body.task; error.status = response.status; throw error; }
  return body;
}

function setup() {
  const generator = document.querySelector('#generator-form');
  const statusLight = document.querySelector('#status-light');
  const statusText = document.querySelector('#status-text');
  const modelSelect = document.querySelector('#model');
  const resolution = document.querySelector('#resolution');
  const duration = document.querySelector('#duration');
  const ratio = document.querySelector('#aspect-ratio');
  let mode = 'text', capabilities = {}, projects = [], imageCount = 1, projectTasks = [];
  let drawerOpen = false, workspaceLoadSequence = 0, generationSequence = 0, projectSwitchBusy = false, projectEpoch = 0;
  const drafts = createProjectDrafts();
  const attempts = createSubmissionAttemptController(undefined, attemptStorage());
  let selectedTaskId = '', submittingWithoutTask = false, stageOverride = null;
  const returnCurrentTask = document.querySelector('#return-current-task');
  const resultHeading = document.querySelector('#result-heading');
  const imageInput = document.querySelector('#reference-image');
  const previewView = { empty: document.querySelector('#upload-copy'), preview: document.querySelector('#image-preview'), image: document.querySelector('#image-preview-img'), name: document.querySelector('#image-preview-name'), details: document.querySelector('#image-preview-details'), status: document.querySelector('#image-preview-status') };

  const uploadController = createImageUploadController({
    createObjectURL: (file) => URL.createObjectURL(file), revokeObjectURL: (url) => URL.revokeObjectURL(url), createFormData: () => new FormData(),
    request: (form) => request('/api/uploads', { method: 'POST', body: form }),
    render: (state) => { if (state) renderImagePreview(previewView, state); else { previewView.preview.hidden = true; previewView.empty.hidden = false; } updateSubmitDisabled(); },
  });
  function clearImage() { imageInput.value = ''; uploadController.remove(); saveDraft(); }
  projectChangeHandler = () => { projectEpoch += 1; imageInput.value = ''; uploadController.projectSwitch(); };
  window.addEventListener('beforeunload', () => uploadController.unload(), { once: true });

  const projectList = document.querySelector('#project-list');
  const projectError = document.querySelector('#project-error');
  const drawerToggle = document.querySelector('#project-drawer-toggle');
  const sidebar = document.querySelector('#project-sidebar');
  const sidebarCollapse = document.querySelector('#sidebar-collapse');
  const workspaceShell = document.querySelector('.workspace-shell');
  const backdrop = document.querySelector('#project-backdrop');
  const createForm = document.querySelector('#create-project-form');
  const renameForm = document.querySelector('#rename-project-form');
  const workspaceMain = document.querySelector('.workspace-main');
  const masthead = document.querySelector('.masthead');
  const retryWorkspace = document.querySelector('#workspace-retry');

  function updateSubmitDisabled() {
    document.querySelector('#generate').disabled = projectSwitchBusy || attempts.inFlight || (mode === 'image' && !uploadController.canSubmit);
  }

  function draftSnapshot() {
    return { mode, prompt: document.querySelector('#prompt').value, model: modelSelect.value, resolution: resolution.value, duration: duration.value, aspectRatio: ratio.value, imageCount, uploadId: uploadController.uploadId };
  }
  function saveDraft() { drafts.save(currentProjectId, draftSnapshot()); }

  const poller = createActiveTaskPoller({
    load: (projectId, id) => request(`/api/video/tasks/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`),
    onUpdate: (updated) => {
      projectTasks = projectTasks.map((item) => item.id === updated.id ? { ...item, remoteId: updated.remote_id, status: updated.status, resultJson: updated.resultJson ?? item.resultJson, updatedAt: Date.now() } : item);
      renderTasks();
    },
  });

  function renderPendingAttemptState() {
    const error = document.querySelector('#form-error');
    error.textContent = pendingAttemptMessage(error.textContent, shouldShowPendingAttemptGuidance(attempts, currentProjectId));
  }

  async function reconcilePendingAttempt(projectId, sequence) {
    const pending = attempts.pendingForProject(projectId);
    if (!pending) return;
    const generationAtStart = generationSequence;
    const pendingKeyAtStart = pending.key;
    try {
      const task = await request(`/api/video/tasks/attempt?projectId=${encodeURIComponent(projectId)}`, { headers: { 'idempotency-key': pending.key } });
      if (sequence !== workspaceLoadSequence || projectId !== currentProjectId) return;
      if (task.remote_id || ['succeeded', 'failed'].includes(task.status)) {
        const canClaimStage = reconciliationMayClaimStage(generationAtStart, generationSequence, pendingKeyAtStart, attempts.pendingForProject(projectId)?.key);
        attempts.resolve(pending);
        renderPendingAttemptState();
        const row = { id: task.id, remoteId: task.remote_id, status: task.status, mode: pending.payload.mode, resultJson: null, createdAt: Date.now(), updatedAt: Date.now() };
        projectTasks = mergeReconciledTask(projectTasks, row, canClaimStage);
        ({ selectedTaskId, stageOverride } = reconciledStageSelection(selectedTaskId, stageOverride, task.id, canClaimStage));
        renderTasks();
      }
    } catch { /* Absence or temporary lookup failure keeps the stable key for explicit retry. */ }
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

  function attemptStorage() {
    try { return window.sessionStorage; } catch { return null; }
  }

  function isMobileDrawer() { return matchMedia('(max-width: 1200px)').matches; }

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
    sidebar.inert = sidebarShouldBeInert(open, isMobileDrawer());
    backdrop.hidden = !open;
    drawerToggle.setAttribute('aria-expanded', String(open));
    setModalState(modalOpen);
    if (modalOpen) document.querySelector('#new-project').focus();
    if (returnFocus) drawerToggle.focus();
    else if (!open && focusTarget) focusTarget.focus();
  }
  let sidebarCollapsed = false;
  function setSidebarCollapsed(value) {
    sidebarCollapsed = value;
    workspaceShell.classList.toggle('sidebar-collapsed', value);
    sidebarCollapse.setAttribute('aria-expanded', String(!value));
    sidebarCollapse.setAttribute('aria-label', value ? '展开项目导航' : '收起项目导航');
    for (const element of [projectList, createForm, document.querySelector('#new-project'), document.querySelector('#rename-project-mobile'), projectError, retryWorkspace]) element.inert = value && !isMobileDrawer();
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
    const pendingSettings = pendingWorkspaceSettings(attempts, currentProjectId, workspaceState?.assets, capabilities);
    const settings = pendingSettings || drafts.load(currentProjectId, workspaceState?.settings || {});
    const state = workspaceFormState(capabilities, mode, settings);
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
    const restoredImage = workspaceImageState(currentProjectId, settings, workspaceState?.assets);
    if (restoredImage && mode === 'image') uploadController.restore(restoredImage.asset, restoredImage.url);
    else clearImage();
    projectTasks = Array.isArray(workspaceState?.tasks) ? workspaceState.tasks : [];
    selectedTaskId = '';
    submittingWithoutTask = false;
    stageOverride = null;
    renderTasks();
    renderPendingAttemptState();
  }

  function renderTasks() {
    const state = taskPresentationState(projectTasks, selectedTaskId);
    const visibleStage = submittingWithoutTask ? { kind: 'submitting' } : resolveResultStage(state, stageOverride);
    const selectedHistoryId = selectedCompletedTaskId(visibleStage);
    returnCurrentTask.hidden = !returnCurrentTaskId(projectTasks, selectedTaskId, stageOverride, submittingWithoutTask);
    const history = document.querySelector('#task-history');
    const historyWrap = document.querySelector('#task-history-wrap');
    renderTaskHistory(history, projectTasks, currentProjectId, selectedHistoryId);
    historyWrap.hidden = projectTasks.length === 0;
    if (submittingWithoutTask) showSubmittingStage();
    else renderSelectedTask(visibleStage);
    poller.sync(currentProjectId, projectTasks);
    renderPendingAttemptState();
  }

  returnCurrentTask.onclick = () => {
    const currentTaskId = returnCurrentTaskId(projectTasks, selectedTaskId, stageOverride, submittingWithoutTask);
    if (!currentTaskId) return;
    selectedTaskId = '';
    stageOverride = null;
    submittingWithoutTask = false;
    renderTasks();
    poller.prioritize(currentTaskId);
    resultHeading.focus();
  };

  function clearResultStage(videoUrl = '') {
    document.querySelector('#result-empty').hidden = true;
    document.querySelector('#result-progress').hidden = true;
    document.querySelector('#result-terminal').hidden = true;
    document.querySelector('#task-progress').hidden = true;
    document.querySelector('#task-progress').textContent = '';
    document.querySelector('#task-id').textContent = '';
    const video = document.querySelector('#result-video');
    syncResultVideo(video, videoUrl);
  }

  function showSubmittingStage() {
    clearResultStage();
    document.querySelector('#result-progress').hidden = false;
    document.querySelector('#generation-title').textContent = '正在提交';
    document.querySelector('#task-state').textContent = '正在提交';
  }

  function renderSelectedTask(state) {
    clearResultStage(state.kind === 'video' ? state.videoUrl : '');
    const status = document.querySelector('#task-state');
    if (state.kind === 'empty') {
      document.querySelector('#result-empty').hidden = false;
      status.textContent = '等待提交';
    } else if (state.kind === 'active') {
      document.querySelector('#result-progress').hidden = false;
      document.querySelector('#generation-title').textContent = '生成中';
      document.querySelector('#task-id').textContent = `任务 ${state.current.id || '—'}`;
      if (state.progress !== null) {
        const progress = document.querySelector('#task-progress');
        progress.textContent = `${state.progress}%`;
        progress.hidden = false;
      }
      status.textContent = '生成中';
    } else if (state.kind === 'video') {
      status.textContent = '已完成';
    } else {
      const failed = taskStatus(state.current) === 'failed';
      const title = state.title || (failed ? '生成失败' : '状态待核对');
      document.querySelector('#terminal-title').textContent = title;
      document.querySelector('#terminal-copy').textContent = state.copy || (failed
        ? '任务未能完成，请检查任务后重试。'
        : '任务暂无可播放视频，请核对任务状态后再提交。');
      document.querySelector('#result-terminal').hidden = false;
      status.textContent = title;
    }
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
    saveDraft();
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
          () => { generationSequence += 1; poller.stop(); },
          () => {
            setCurrentProjectId(project.id);
            storeCurrentProjectId(projectStorage(), project.id);
            applyWorkspace(workspaceState);
            void reconcilePendingAttempt(project.id, sequence);
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
    const selected = selectInitialProject(projects, readStoredProjectId(projectStorage()), window.location.search);
    renderProjects();
    if (selected) {
      await switchProject(selected);
      if (currentProjectId === selected.id && new URLSearchParams(window.location.search).has('project')) {
        const url = new URL(window.location.href);
        url.searchParams.delete('project');
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      }
    } else projectError.textContent = '暂无可用项目';
  }

  const fill = (select, values) => { select.innerHTML = values.map((value) => `<option value="${value}">${value}${select === duration ? ' 秒' : ''}</option>`).join(''); };
  function updateOptions() { const values = optionsForModel(capabilities, mode, modelSelect.value); fill(resolution, values.resolutions); fill(duration, values.durations); fill(ratio, values.aspectRatios); }
  function fillModels() { const group = mode === 'text' ? capabilities.text_to_video : capabilities.image_to_video; modelSelect.innerHTML = (group?.models || []).map((item) => `<option value="${item.model}">${item.alias?.split(',')[0] || item.model}</option>`).join(''); updateOptions(); }

  async function refreshStatus() {
    statusText.textContent = '正在检测';
    const priorSettings = draftSnapshot();
    const status = await request('/api/kling/status'); capabilities = status.models || {};
    const online = status.connection === 'online'; statusLight.classList.toggle('online', online); statusText.textContent = online ? 'MCP 在线' : 'MCP 未连接';
    document.querySelector('#membership').textContent = status.membership ?? '—'; document.querySelector('#credits').textContent = status.credits ?? '暂不可用'; document.querySelector('#last-check').textContent = `最后检查 ${new Date(status.checkedAt).toLocaleTimeString()}`;
    fillModels();
    const restored = workspaceFormState(capabilities, mode, priorSettings);
    modelSelect.value = restored.model; updateOptions();
    resolution.value = restored.resolution; duration.value = restored.duration; ratio.value = restored.aspectRatio;
    if (!online) statusText.parentElement.onclick = () => { location.href = '/api/kling/oauth/start'; };
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
  async function loadWorkspace() {
    retryWorkspace.hidden = true;
    try { await loadWorkspaceEntry(); }
    catch (error) { projectError.textContent = `工作台加载失败：${error.message}`; retryWorkspace.hidden = false; throw error; }
  }
  document.querySelectorAll('[data-mode]').forEach((button) => button.onclick = () => { mode = button.dataset.mode; document.querySelectorAll('[data-mode]').forEach((item) => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); }); document.querySelector('#upload-field').hidden = mode !== 'image'; updateSubmitDisabled(); fillModels(); saveDraft(); });
  modelSelect.onchange = () => { updateOptions(); saveDraft(); };
  generator.addEventListener('input', saveDraft);
  generator.addEventListener('change', saveDraft);
  imageInput.onchange = async (event) => {
    const file = event.target.files[0]; if (!file) return;
    const selectedProjectId = currentProjectId;
    const selectedProjectEpoch = projectEpoch;
    try {
      document.querySelector('#form-error').textContent = '';
      const result = await uploadController.select(file, selectedProjectId);
      if (result?.current && currentProjectId === selectedProjectId) saveDraft();
      else if (result?.uploadId && shouldSaveStaleUpload(selectedProjectEpoch, projectEpoch)) drafts.save(selectedProjectId, { ...drafts.load(selectedProjectId), uploadId: result.uploadId });
    }
    catch (error) { document.querySelector('#form-error').textContent = error.message; }
  };
  document.querySelector('#replace-image').onclick = () => openImageReplacement(imageInput);
  document.querySelector('#remove-image').onclick = clearImage;
  drawerToggle.onclick = () => setDrawer(!drawerOpen);
  sidebarCollapse.onclick = () => setSidebarCollapsed(!sidebarCollapsed);
  setDrawer(false);
  backdrop.onclick = () => setDrawer(closeProjectDrawer(drawerOpen, 'backdrop'), { returnFocus: true });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawerOpen) { setDrawer(false, { returnFocus: true }); return; }
    if (event.key !== 'Tab' || !drawerOpen || !isMobileDrawer()) return;
    const focusable = [...sidebar.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')].filter((element) => !element.hidden && element.offsetParent !== null);
    const current = focusable.indexOf(document.activeElement);
    const next = nextDrawerFocusIndex(current < 0 ? (event.shiftKey ? 0 : -1) : current, focusable.length, event.shiftKey);
    if (next >= 0 && ((event.shiftKey && current <= 0) || (!event.shiftKey && current === focusable.length - 1) || current < 0)) { event.preventDefault(); focusable[next].focus(); }
  });
  addEventListener('resize', () => { if (drawerOpen && !isMobileDrawer()) setDrawer(false); else sidebar.inert = sidebarShouldBeInert(drawerOpen, isMobileDrawer()); setSidebarCollapsed(sidebarCollapsed); });
  retryWorkspace.onclick = () => { loadWorkspace().catch(() => {}); };
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
  generator.onsubmit = async (event) => {
    event.preventDefault();
    if (projectSwitchBusy || attempts.inFlight) return;
    const submittedProjectId = currentProjectId;
    const payload = buildGenerationPayload({ projectId: submittedProjectId, mode, uploadId: uploadController.uploadId, model: modelSelect.value, prompt: document.querySelector('#prompt').value, resolution: resolution.value, duration: duration.value, aspectRatio: ratio.value, imageCount });
    const pending = attempts.pendingForProject(submittedProjectId);
    if (pending && JSON.stringify(pending.payload) !== JSON.stringify(payload)) {
      document.querySelector('#form-error').textContent = '上次提交待确认；请恢复原设置并使用原请求重试，不能以新设置再次提交。';
      return;
    }
    const errors = validateWorkspace(payload);
    if (Object.keys(errors).length) { document.querySelector('#form-error').textContent = Object.values(errors)[0]; return; }
    const attempt = attempts.begin(payload);
    if (!attempt) return;
    updateSubmitDisabled();
    saveDraft();
    const submissionToken = ++generationSequence;
    const submissionIsCurrent = () => isCurrentSubmission(currentProjectId, submittedProjectId, submissionToken, generationSequence);
    document.querySelector('#form-error').textContent = '';
    selectedTaskId = '';
    stageOverride = null;
    submittingWithoutTask = true;
    renderTasks();
    try {
      const task = await request('/api/video/tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': attempt.key }, body: JSON.stringify(payload) });
      attempts.settle(attempt, Boolean(task.remote_id || task.status === 'succeeded' || task.status === 'failed'));
      if (submissionIsCurrent()) {
        projectTasks = prependProjectTask(currentProjectId, submittedProjectId, projectTasks, { id: task.id, remoteId: task.remote_id, status: task.status, mode: payload.mode, resultJson: null, createdAt: Date.now(), updatedAt: Date.now() });
        selectedTaskId = task.id || '';
        submittingWithoutTask = false;
        stageOverride = null;
        renderTasks();
        renderPendingAttemptState();
        void refreshAccountSnapshot({ load: () => request('/api/kling/status'), isCurrent: submissionIsCurrent, apply: applyAccountStatus }).catch(() => {});
      }
    } catch (error) {
      attempts.settle(attempt, error.task?.status === 'failed' || [400, 403, 404, 422].includes(error.status));
      if (submissionIsCurrent()) {
        submittingWithoutTask = false;
        document.querySelector('#form-error').textContent = error.message;
        if (error.task?.id) {
          projectTasks = prependProjectTask(currentProjectId, submittedProjectId, projectTasks, { id: error.task.id, remoteId: error.task.remote_id, status: error.task.status, mode: payload.mode, resultJson: null, createdAt: Date.now(), updatedAt: Date.now() });
          selectedTaskId = error.task.id;
          stageOverride = null;
          renderTasks();
        } else {
          const pendingAttempt = attempts.pendingForProject(submittedProjectId);
          stageOverride = {
            kind: 'terminal',
            title: pendingAttempt ? '状态待核对' : '提交失败',
            copy: pendingAttempt ? '提交结果尚未确认，请核对任务后再试。' : '提交未能完成，请检查输入后重试。',
          };
          renderTasks();
        }
        renderPendingAttemptState();
      }
    } finally { updateSubmitDisabled(); }
  };
  document.querySelector('#refresh-status').onclick = refreshStatus;
  document.querySelector('#logout').onclick = async () => { await request('/api/session', { method: 'DELETE' }); location.replace('/login'); };
  loadWorkspace().catch(() => {});
}
if (typeof document !== 'undefined') setup();
