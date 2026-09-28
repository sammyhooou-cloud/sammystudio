import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTaskStatus,
  parseTaskRequest,
  safeVideoUrl,
  taskProgress,
  taskDetailHref,
} from '../public/task-presenter.js';
import * as stageHelpers from '../public/app.js';
import { parseResultRoute, resultViewModel, setupResultPage } from '../public/result.js';
import {
  buildGenerationPayload,
  closeProjectDrawer,
  createRetryableLoader,
  drawerModalState,
  drawerShouldReturnFocus,
  nextDrawerFocusIndex,
  optionsForModel,
  performProjectSwitch,
  readStoredProjectId,
  renameProjectInList,
  selectCurrentProject,
  shouldSwitchProject,
  storeCurrentProjectId,
  switchFailureState,
  upsertProject,
  validateWorkspace,
  workspaceFormState,
  workspaceImageState,
  workspaceTaskState,
  prependProjectTask,
  clearVideoElement,
  extractVideoUrl,
  extractTaskProgress,
  taskPresentationState,
  isCurrentSubmission,
  performGenerationSubmission,
  commitProjectWorkspace,
  refreshAccountSnapshot,
  createSubmissionAttemptController,
  createActiveTaskPoller,
  pendingWorkspaceSettings,
  createProjectDrafts,
  nextPollDelay,
  shouldSaveStaleUpload,
  sidebarShouldBeInert,
} from '../public/app.js';

test('result routes decode exact project and task segments', () => {
  assert.deepEqual(parseResultRoute('/projects/project%20a/results/task%2F1'), { projectId: 'project a', taskId: 'task/1' });
  for (const path of ['', '/', '/projects//results/task', '/projects/p/results/', '/projects/p/results/t/', '/projects/p/results/t/extra', '/projects/%ZZ/results/t', '/projects/p/results/%E0%A4%A', '/projects/p/tasks/t', '/projects/p/results/t?x=1', '/projects/p/results/t#x']) {
    assert.equal(parseResultRoute(path), null);
  }
});

test('result states expose only explicit active progress', () => {
  for (const status of ['queued', 'generating', 'submitting']) {
    const state = resultViewModel({ status, resultJson: '{}' });
    assert.equal(state.kind, 'active');
    assert.equal(state.title, '生成中');
    assert.equal(state.progress, null);
    assert.equal(state.videoUrl, '');
  }
  assert.equal(resultViewModel({ status: 'generating', resultJson: '{"data":{"progress":35}}' }).progress, 35);
  assert.equal(resultViewModel({ status: 'generating', resultJson: '{"progress":"35"}' }).progress, null);
});

test('result states distinguish playable successes from unavailable results', () => {
  for (const status of ['succeeded', 'completed', 'done', 'SUCCESS']) {
    const state = resultViewModel({ status, resultJson: '{"videoUrl":"https://cdn.test/a.mp4"}' });
    assert.equal(state.kind, 'video');
    assert.equal(state.videoUrl, 'https://cdn.test/a.mp4');
    assert.equal(state.progress, null);
  }
  for (const resultJson of ['{}', '{broken', '{"videoUrl":"javascript:alert(1)"}']) {
    const state = resultViewModel({ status: 'succeeded', resultJson });
    assert.equal(state.kind, 'unavailable');
    assert.equal(state.videoUrl, '');
  }
});

test('result states give failed and unknown tasks explicit terminal messages', () => {
  for (const status of ['failed', 'error', 'cancelled']) {
    assert.equal(resultViewModel({ status }).kind, 'failed');
  }
  for (const detail of [null, {}, { status: 'unknown' }, { status: 'unexpected' }]) {
    const state = resultViewModel(detail);
    assert.equal(state.kind, 'unknown');
    assert.ok(state.title);
    assert.ok(state.copy);
    assert.equal(state.videoUrl, '');
  }
});

test('workspace query selection prefers only an owned project and preserves saved-project fallback', () => {
  assert.equal(typeof stageHelpers.selectInitialProject, 'function');
  const projects = [{ id: 'first' }, { id: 'saved' }, { id: 'project a' }];
  assert.equal(stageHelpers.selectInitialProject(projects, 'saved', '?project=project%20a'), projects[2]);
  assert.equal(stageHelpers.selectInitialProject(projects, 'saved', '?project=not-owned'), projects[1]);
  assert.equal(stageHelpers.selectInitialProject(projects, 'saved', ''), projects[1]);
  assert.equal(stageHelpers.selectInitialProject(projects, 'missing', '?project=not-owned'), projects[0]);
  assert.equal(stageHelpers.selectInitialProject([], 'saved', '?project=project%20a'), null);
});

function resultPageHarness() {
  const createElement = (tagName) => ({
    tagName, children: [], hidden: false, disabled: false, textContent: '', attributes: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; if (name === 'src') delete this.src; },
    pause() {}, load() {},
  });
  const ids = ['result-detail', 'result-player', 'result-progress', 'result-terminal', 'result-meta', 'result-error', 'back-to-workspace', 'result-project', 'result-heading', 'result-status', 'result-percentage', 'result-terminal-title', 'result-terminal-copy', 'result-prompt', 'result-retry'];
  const elements = Object.fromEntries(ids.map((id) => [id, createElement(id === 'result-player' ? 'video' : 'div')]));
  const view = { querySelector: (selector) => elements[selector.slice(1)], createElement };
  const redirects = [];
  const pageLocation = { pathname: '/projects/project%20a/results/task%2F1', replace: (path) => redirects.push(path) };
  return { view, pageLocation, redirects, elements };
}

test('result page loads the encoded API route, renders safe metadata, and clears an invalid player on retry', async () => {
  const { view, pageLocation, elements, redirects } = resultPageHarness();
  const calls = [];
  let detail = { id: 'task/1', projectId: 'project a', projectName: '<img src=x>', status: 'succeeded', mode: 'image', request: { prompt: '<script>prompt</script>', model: 'm', resolution: '1080p', duration: 5, aspectRatio: '16:9', secret: 'never-render' }, resultJson: '{"videoUrl":"https://cdn.test/a.mp4"}', createdAt: 1750000000000, updatedAt: 1750000001000 };
  await setupResultPage({ view, pageLocation, fetcher: async (path) => { calls.push(path); return { ok: true, status: 200, json: async () => detail }; } });
  assert.deepEqual(calls, ['/api/projects/project%20a/tasks/task%2F1']);
  assert.equal(elements['result-player'].src, 'https://cdn.test/a.mp4');
  assert.equal(elements['result-player'].controls, true);
  assert.equal(elements['result-player'].hidden, false);
  assert.equal(elements['result-project'].textContent, '<img src=x>');
  assert.equal(elements['result-project'].innerHTML, undefined);
  assert.equal(elements['result-prompt'].textContent, '<script>prompt</script>');
  assert.equal(elements['back-to-workspace'].href, '/workspace?project=project%20a');
  assert.equal(elements['result-meta'].children.length, 7);
  assert.equal(JSON.stringify(elements['result-meta']).includes('never-render'), false);
  assert.deepEqual(redirects, []);
  detail = { ...detail, resultJson: '{"videoUrl":"javascript:alert(1)"}' };
  await elements['result-retry'].onclick();
  assert.equal(elements['result-player'].src, undefined);
  assert.equal(elements['result-player'].hidden, true);
  assert.equal(elements['result-terminal'].hidden, false);
  assert.equal(elements['result-terminal-title'].textContent, '结果暂不可播放');
});

test('result page keeps active progress centered and shows percentages only when present', async () => {
  const { view, pageLocation, elements } = resultPageHarness();
  let resultJson = '{}';
  await setupResultPage({ view, pageLocation, fetcher: async () => ({ ok: true, status: 200, json: async () => ({ projectId: 'project a', status: 'generating', resultJson }) }) });
  assert.equal(elements['result-progress'].hidden, false);
  assert.equal(elements['result-percentage'].hidden, true);
  resultJson = '{"progress":35}';
  await elements['result-retry'].onclick();
  assert.equal(elements['result-percentage'].hidden, false);
  assert.equal(elements['result-percentage'].textContent, '35%');
});

test('only result API 401 redirects; missing and network failures provide safe retry states', async () => {
  const unauthorized = resultPageHarness();
  await setupResultPage({ ...unauthorized, fetcher: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.deepEqual(unauthorized.redirects, ['/login']);
  for (const status of [404, 403, 503]) {
    const harness = resultPageHarness();
    await setupResultPage({ ...harness, fetcher: async () => ({ ok: false, status, json: async () => ({ error: '<script>failure</script>' }) }) });
    assert.deepEqual(harness.redirects, []);
    assert.equal(harness.elements['result-error'].textContent, '<script>failure</script>');
    assert.equal(harness.elements['result-error'].innerHTML, undefined);
    assert.equal(harness.elements['result-terminal'].hidden, false);
    assert.equal(harness.elements['result-retry'].disabled, false);
  }
  const network = resultPageHarness();
  await setupResultPage({ ...network, fetcher: async () => { throw new Error('offline'); } });
  assert.equal(network.elements['result-error'].textContent, 'offline');
  assert.deepEqual(network.redirects, []);
});

test('invalid result routes never request task data', async () => {
  const harness = resultPageHarness();
  harness.pageLocation.pathname = '/projects/p/results/t/extra';
  let calls = 0;
  await setupResultPage({ ...harness, fetcher: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(harness.elements['result-terminal-title'].textContent, '任务链接无效');
});

test('shared task presenter encodes each task detail path segment', () => {
  assert.equal(taskDetailHref('project a', 'task/1'), '/projects/project%20a/results/task%2F1');
});

test('shared task presenter preserves normalized status values', () => {
  for (const status of ['SUCCEEDED', 'GENERATING', 'FAILED', 'UNKNOWN']) {
    assert.equal(normalizeTaskStatus(status), status.toLowerCase());
  }
  for (const status of [undefined, null, 42]) assert.equal(normalizeTaskStatus(status), '');
});

test('shared task presenter reads explicit nested progress without fabricating absent progress', () => {
  assert.equal(taskProgress({ data: { progress: 42 } }), 42);
  assert.equal(taskProgress({ data: { percentage: 42.6 } }), 43);
  assert.equal(taskProgress({ data: { percent: 0 } }), 0);
  for (const result of [undefined, null, {}, { data: {} }, ...[-1, 101, '42', NaN, Infinity].map((progress) => ({ progress }))]) {
    assert.equal(taskProgress(result), null);
  }
});

test('shared task presenter rejects unsafe and unrelated video results', () => {
  assert.equal(safeVideoUrl({ works: [{ contentType: 'video/mp4', url: 'https://cdn.test/clip' }] }), 'https://cdn.test/clip');
  assert.equal(safeVideoUrl({ data: { video_url: '/media/result.webm' } }), '/media/result.webm');
  for (const result of [
    { videoUrl: 'javascript:alert(1)' },
    { videoUrl: 'http://cdn.test/clip.mp4' },
    { url: 'https://cdn.test/readme.txt' },
    '{broken',
    null,
  ]) assert.equal(safeVideoUrl(result), '');
});

test('shared task presenter accepts request objects and JSON objects', () => {
  const request = { prompt: 'ocean' };
  assert.equal(parseTaskRequest(request), request);
  assert.deepEqual(parseTaskRequest('{"prompt":"ocean"}'), request);
});

test('shared task presenter safely rejects malformed request JSON and non-object requests', () => {
  for (const request of [undefined, null, '{broken', [], ['prompt'], 42, true, 'plain text', 'null', '[]', '42', 'true', '"text"']) {
    assert.deepEqual(parseTaskRequest(request), {});
  }
});

test('task records expose a project-scoped result link only for playable successes', () => {
  assert.equal(typeof stageHelpers.taskListItemModel, 'function');
  const completed = { id: 'task-1', status: 'succeeded', resultJson: '{"videoUrl":"https://cdn.test/clip.mp4"}' };
  assert.deepEqual(stageHelpers.taskListItemModel(completed, 'project-1'), {
    label: '已完成', action: '查看结果', href: '/projects/project-1/results/task-1', tone: 'success',
  });
  for (const resultJson of [undefined, '{broken', '{"videoUrl":"javascript:alert(1)"}']) {
    assert.equal(stageHelpers.taskListItemModel({ ...completed, resultJson }, 'project-1').action, '查看详情');
  }
});

test('task records keep active tasks non-clickable with truthful status labels', () => {
  assert.equal(typeof stageHelpers.taskListItemModel, 'function');
  for (const [status, label] of [['queued', '排队中'], ['generating', '生成中'], ['submitting', '正在提交']]) {
    assert.deepEqual(stageHelpers.taskListItemModel({ id: 'task-1', status }, 'project-1'), {
      label, action: '生成中', href: '', tone: 'active',
    });
  }
});

test('failed and unknown task records offer encoded project-scoped detail links', () => {
  assert.equal(typeof stageHelpers.taskListItemModel, 'function');
  for (const [status, label, tone] of [['FAILED', '生成失败', 'failure'], ['unknown', '状态待核对', 'warning']]) {
    assert.deepEqual(stageHelpers.taskListItemModel({ id: 'task/1', status }, 'project a'), {
      label, action: '查看详情', href: '/projects/project%20a/results/task%2F1', tone,
    });
  }
});

function taskHistoryHarness() {
  const view = { activeElement: null };
  const createElement = (tagName) => ({
    tagName, children: [], dataset: {}, className: '', textContent: '',
    classList: { toggle() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    contains(element) { return this === element || this.children.some((child) => child.contains(element)); },
    querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.tagName === 'a' ? [child] : []), ...child.querySelectorAll(selector)]); },
    focus() { view.activeElement = this; },
    setAttribute(name, value) { this[name] = value; },
  });
  view.createElement = createElement;
  const history = createElement('div');
  history.ownerDocument = view;
  return { history, view };
}

test('task history renders every task in server order with safe metadata and explicit navigation', () => {
  assert.equal(typeof stageHelpers.renderTaskHistory, 'function');
  const { history } = taskHistoryHarness();
  const tasks = [
    { id: 'active', status: 'generating', mode: 'image', createdAt: 1750000000000, requestJson: '{"model":"<script>model</script>","resolution":"1080p","duration":5,"aspectRatio":"16:9"}' },
    { id: 'done', status: 'succeeded', mode: 'text', resultJson: '{"videoUrl":"https://cdn.test/clip.mp4"}' },
    { id: 'failed', status: 'failed', requestJson: '{broken' },
    { id: 'unknown', status: 'unknown', requestJson: '[]' },
  ];
  stageHelpers.renderTaskHistory(history, tasks, 'project a');
  assert.deepEqual(history.children.map((row) => row.dataset.taskId), tasks.map(({ id }) => id));
  const [active, completed] = history.children;
  assert.equal(active.children[0].children[1].children[0].textContent, '图生视频');
  assert.equal(active.children[0].children[1].children[1].dateTime, '2025-06-15T15:06:40.000Z');
  assert.equal(active.children[0].children[2].textContent, '<script>model</script> · 1080p · 5秒 · 16:9');
  assert.equal(active.children[0].children[2].innerHTML, undefined);
  assert.equal(active.children[1].tagName, 'span');
  assert.equal(active.children[1].textContent, '生成中');
  assert.equal(completed.children[1].tagName, 'a');
  assert.equal(completed.children[1].href, '/projects/project%20a/results/done');
  assert.equal(completed.children[1].textContent, '查看结果');
  assert.equal(completed.children[1].onclick, undefined);
  assert.equal(history.children[2].children[0].children[2].textContent, '参数待同步');
});

test('task history preserves link focus across polling renders and safely clears an empty list', () => {
  assert.equal(typeof stageHelpers.renderTaskHistory, 'function');
  const { history, view } = taskHistoryHarness();
  const tasks = [{ id: 'task-1', status: 'failed', createdAt: 'invalid' }];
  stageHelpers.renderTaskHistory(history, tasks, 'project-1');
  const oldLink = history.children[0].children[1];
  oldLink.focus();
  stageHelpers.renderTaskHistory(history, tasks, 'project-1');
  assert.notEqual(view.activeElement, oldLink);
  assert.equal(view.activeElement, history.children[0].children[1]);
  assert.equal(history.children[0].children[0].children[1].children[1].textContent, '时间待同步');
  stageHelpers.renderTaskHistory(history, [], 'project-1');
  assert.deepEqual(history.children, []);
});

test('new active task owns the stage while older playable success remains completed', () => {
  const tasks = [
    { id: 'new', status: 'generating', resultJson: '{"status":"PROCESSING"}' },
    { id: 'old', status: 'succeeded', resultJson: '{"works":[{"contentType":"video/mp4","url":"https://cdn.example/old.mp4"}]}' },
  ];
  const state = taskPresentationState(tasks);
  assert.equal(state.current, tasks[0]);
  assert.equal(state.kind, 'active');
  assert.equal(state.progress, null);
  assert.deepEqual(state.completed, [{ task: tasks[1], videoUrl: 'https://cdn.example/old.mp4' }]);
});

test('selecting an older playable success keeps the newer task out of the video stage', () => {
  const tasks = [
    { id: 'new', status: 'queued', resultJson: '{"progress":20}' },
    { id: 'old', status: 'succeeded', resultJson: '{"videoUrl":"https://cdn.example/old.mp4"}' },
  ];
  const state = taskPresentationState(tasks, 'old');
  assert.equal(state.current, tasks[1]);
  assert.equal(state.kind, 'video');
  assert.equal(state.videoUrl, 'https://cdn.example/old.mp4');
  assert.equal(state.progress, null);
  assert.deepEqual(state.completed.map(({ task }) => task.id), ['old']);
});

test('return target is the newest task when an older completed clip owns the visible stage', () => {
  const old = { id: 'old', status: 'succeeded', resultJson: '{"videoUrl":"https://cdn.example/old.mp4"}' };
  for (const status of ['queued', 'failed', 'unknown', 'succeeded']) {
    const head = { id: 'head', status, resultJson: status === 'succeeded' ? '{"videoUrl":"https://cdn.example/head.mp4"}' : null };
    assert.equal(stageHelpers.returnCurrentTaskId([head, old], 'old'), 'head');
  }
});

test('return target is absent for the head, default stage, overrides, and empty tasks', () => {
  const tasks = [
    { id: 'head', status: 'queued' },
    { id: 'old', status: 'succeeded', resultJson: '{"videoUrl":"https://cdn.example/old.mp4"}' },
  ];
  assert.equal(stageHelpers.returnCurrentTaskId(tasks, 'head'), '');
  assert.equal(stageHelpers.returnCurrentTaskId(tasks, ''), '');
  assert.equal(stageHelpers.returnCurrentTaskId(tasks, 'old', { kind: 'terminal' }), '');
  assert.equal(stageHelpers.returnCurrentTaskId(tasks, 'old', null, true), '');
  assert.equal(stageHelpers.returnCurrentTaskId([], 'old'), '');
});

test('stale reconciliation preserves the new task and its override while merging the old row behind it', () => {
  const old = { id: 'old', status: 'succeeded' };
  const newer = { id: 'new', status: 'queued' };
  const override = { kind: 'terminal', title: '状态待核对' };
  const canClaim = stageHelpers.reconciliationMayClaimStage(1, 2, 'old-key', 'new-key');
  assert.equal(canClaim, false);
  const tasks = stageHelpers.mergeReconciledTask([newer], old, canClaim);
  assert.deepEqual(tasks.map(({ id }) => id), ['new', 'old']);
  assert.equal(taskPresentationState(tasks).current.id, 'new');
  assert.deepEqual(stageHelpers.reconciledStageSelection('new', override, old.id, canClaim), { selectedTaskId: 'new', stageOverride: override });
  assert.equal(stageHelpers.reconciliationMayClaimStage(1, 1, 'old-key', 'new-key'), false);
});

test('current reconciliation may claim the stage and prepend its recovered task', () => {
  const recovered = { id: 'recovered', status: 'queued' };
  const canClaim = stageHelpers.reconciliationMayClaimStage(1, 1, 'same-key', 'same-key');
  assert.equal(canClaim, true);
  assert.deepEqual(stageHelpers.mergeReconciledTask([{ id: 'older' }], recovered, canClaim).map(({ id }) => id), ['recovered', 'older']);
  assert.deepEqual(stageHelpers.reconciledStageSelection('older', { kind: 'terminal' }, recovered.id, canClaim), { selectedTaskId: 'recovered', stageOverride: null });
  assert.deepEqual(stageHelpers.mergeReconciledTask([{ id: 'newer' }, { id: 'recovered', status: 'submitting' }], recovered, false).map(({ id }) => id), ['newer', 'recovered']);
});

test('stale queued reconciliation keeps a completed clip playable and in its original position', () => {
  const video = '{"videoUrl":"https://cdn.example/clip.mp4"}';
  const tasks = [{ id: 'newer', status: 'queued' }, { id: 'clip', status: 'succeeded', resultJson: video, remoteId: '' }];
  const merged = stageHelpers.mergeReconciledTask(tasks, { id: 'clip', status: 'queued', resultJson: null, remoteId: 'remote-clip' }, false);
  assert.deepEqual(merged.map(({ id }) => id), ['newer', 'clip']);
  assert.equal(merged[1].status, 'succeeded');
  assert.equal(merged[1].resultJson, video);
  assert.equal(merged[1].remoteId, 'remote-clip');
  const selected = taskPresentationState(merged, 'clip');
  assert.equal(selected.kind, 'video');
  assert.equal(selected.videoUrl, 'https://cdn.example/clip.mp4');
  assert.equal(stageHelpers.selectedCompletedTaskId(selected), 'clip');
  assert.equal(stageHelpers.returnCurrentTaskId(merged, 'clip'), 'newer');
});

test('stale active reconciliation preserves failed and unknown terminal states', () => {
  for (const status of ['failed', 'unknown']) {
    const existing = { id: 'task', status, resultJson: '{"detail":"final"}', remoteId: 'current-remote' };
    const merged = stageHelpers.mergeReconciledTask([existing], { id: 'task', status: 'queued', remoteId: 'stale-remote', resultJson: null }, false);
    assert.equal(merged[0].status, status);
    assert.equal(merged[0].resultJson, existing.resultJson);
    assert.equal(merged[0].remoteId, 'current-remote');
    assert.equal(taskPresentationState(merged, 'task').kind, 'terminal');
  }
});

test('stale submitting or queued reconciliation cannot move generating backwards', () => {
  for (const status of ['queued', 'submitting']) {
    const existing = { id: 'task', status: 'generating', resultJson: '{"progress":47}' };
    const merged = stageHelpers.mergeReconciledTask([existing], { id: 'task', status, resultJson: null }, false);
    assert.equal(merged[0].status, 'generating');
    assert.equal(taskPresentationState(merged).progress, 47);
  }
});

test('stale terminal reconciliation can promote an active row without taking stage selection', () => {
  const tasks = [{ id: 'newer', status: 'queued' }, { id: 'old', status: 'generating', resultJson: null }];
  const merged = stageHelpers.mergeReconciledTask(tasks, { id: 'old', status: 'succeeded', resultJson: '{"videoUrl":"https://cdn.example/old.mp4"}' }, false);
  assert.deepEqual(merged.map(({ id }) => id), ['newer', 'old']);
  assert.equal(merged[1].status, 'succeeded');
  assert.equal(taskPresentationState(merged).current.id, 'newer');
  assert.equal(taskPresentationState(merged, 'old').kind, 'video');
  assert.deepEqual(stageHelpers.reconciledStageSelection('newer', { kind: 'terminal' }, 'old', false), { selectedTaskId: 'newer', stageOverride: { kind: 'terminal' } });
});

test('current reconciliation keeps existing result data when recovered row has none', () => {
  const resultJson = '{"videoUrl":"https://cdn.example/task.mp4"}';
  const merged = stageHelpers.mergeReconciledTask([{ id: 'task', status: 'generating', resultJson }], { id: 'task', status: 'succeeded', resultJson: null }, true);
  assert.equal(merged[0].status, 'succeeded');
  assert.equal(merged[0].resultJson, resultJson);
  assert.equal(taskPresentationState(merged).videoUrl, 'https://cdn.example/task.mp4');
});

test('current reconciliation cannot downgrade a task completed by polling during its lookup', () => {
  const canClaimStage = stageHelpers.reconciliationMayClaimStage(4, 4, 'same-key', 'same-key');
  assert.equal(canClaimStage, true);
  const resultJson = '{"videoUrl":"https://cdn.example/task.mp4"}';
  const polled = [{ id: 'task', status: 'succeeded', resultJson, remoteId: '' }];
  const merged = stageHelpers.mergeReconciledTask(polled, { id: 'task', status: 'queued', resultJson: null, remoteId: 'remote-task' }, canClaimStage);
  const selection = stageHelpers.reconciledStageSelection('', { kind: 'terminal' }, 'task', canClaimStage);
  const visibleStage = stageHelpers.resolveResultStage(taskPresentationState(merged, selection.selectedTaskId), selection.stageOverride);
  assert.equal(merged[0].status, 'succeeded');
  assert.equal(merged[0].resultJson, resultJson);
  assert.equal(merged[0].remoteId, 'remote-task');
  assert.equal(visibleStage.kind, 'video');
  assert.equal(visibleStage.videoUrl, 'https://cdn.example/task.mp4');
  assert.equal(stageHelpers.selectedCompletedTaskId(visibleStage), 'task');
});

test('completed history selection follows the video actually shown in the stage', () => {
  assert.equal(typeof stageHelpers.selectedCompletedTaskId, 'function');
  const clip = { id: 'clip', status: 'succeeded', resultJson: '{"videoUrl":"https://cdn.example/clip.mp4"}' };
  const defaultVideo = taskPresentationState([clip], '');
  assert.equal(stageHelpers.selectedCompletedTaskId(defaultVideo), 'clip');
  assert.equal(stageHelpers.selectedCompletedTaskId(stageHelpers.resolveResultStage(defaultVideo, { kind: 'terminal' })), '');
  assert.equal(stageHelpers.selectedCompletedTaskId({ kind: 'submitting' }), '');
  assert.equal(stageHelpers.selectedCompletedTaskId(taskPresentationState([{ id: 'new', status: 'queued' }, clip])), '');
  assert.equal(stageHelpers.selectedCompletedTaskId(taskPresentationState([{ id: 'new', status: 'queued' }, clip], 'clip')), 'clip');
});

test('unknown selection falls back to the first task and empty tasks are safe', () => {
  const first = { id: 'first', status: 'queued', resultJson: null };
  const state = taskPresentationState([first], 'missing');
  assert.equal(state.current, first);
  assert.equal(state.kind, 'active');
  assert.deepEqual(taskPresentationState([], 'missing'), {
    tasks: [], current: null, kind: 'empty', videoUrl: '', progress: null, completed: [],
  });
  assert.equal(taskPresentationState(null).kind, 'empty');
});

test('malformed task results do not crash active or terminal presentation', () => {
  const active = taskPresentationState([{ id: 'a', status: 'generating', resultJson: '{broken' }]);
  assert.equal(active.kind, 'active');
  assert.equal(active.progress, null);
  const terminal = taskPresentationState([{ id: 'b', status: 'succeeded', resultJson: '{broken' }]);
  assert.equal(terminal.kind, 'terminal');
  assert.equal(terminal.videoUrl, '');
  assert.deepEqual(terminal.completed, []);
});

test('presentation state exposes explicit provider progress and a successful video URL', () => {
  const active = { id: 'new', status: 'generating', resultJson: '{"data":{"progress":42}}' };
  assert.equal(taskPresentationState([active]).progress, 42);
  const succeeded = { id: 'done', status: 'success', resultJson: '{"works":[{"contentType":"video/mp4","url":"https://cdn.example/done.mp4"}]}' };
  const state = taskPresentationState([succeeded]);
  assert.equal(state.kind, 'video');
  assert.equal(state.videoUrl, 'https://cdn.example/done.mp4');
});

test('task progress accepts only explicit numeric values from zero through one hundred', () => {
  for (const value of [-1, 101, '42', NaN, Infinity]) {
    assert.equal(extractTaskProgress({ progress: value }), null);
  }
  assert.equal(extractTaskProgress({ data: { percentage: 42.6 } }), 43);
  assert.equal(extractTaskProgress({ data: { percent: 0 } }), 0);
});

test('completed presentation excludes failed, unsafe, and nonplayable tasks', () => {
  const tasks = [
    { id: 'failed', status: 'failed', resultJson: '{"videoUrl":"https://cdn.example/fail.mp4"}' },
    { id: 'unsafe', status: 'completed', resultJson: '{"videoUrl":"javascript:alert(1)"}' },
    { id: 'not-video', status: 'done', resultJson: '{"url":"https://cdn.example/readme.txt"}' },
  ];
  const state = taskPresentationState(tasks);
  assert.deepEqual(state.completed, []);
  assert.equal(state.kind, 'terminal');
});

test('double submit is locked immediately and ambiguous retry reuses the same key', () => {
  let next = 0;
  const attempts = createSubmissionAttemptController(() => `key-${++next}`);
  const first = attempts.begin({ projectId: 'a', prompt: 'ocean' });
  assert.equal(attempts.inFlight, true);
  assert.equal(attempts.begin({ projectId: 'a', prompt: 'ocean' }), null);
  attempts.settle(first, false);
  assert.equal(attempts.begin({ projectId: 'a', prompt: 'ocean' }).key, first.key);
  attempts.settle(first, false);
  assert.equal(attempts.begin({ projectId: 'a', prompt: 'forest' }), null);
  assert.equal(next, 1);
  attempts.settle(first, true);
  assert.equal(attempts.begin({ projectId: 'a', prompt: 'forest' }).key, 'key-2');
});

test('an unresolved attempt keeps its key across a tab reload', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const first = createSubmissionAttemptController(() => 'original-key', storage);
  const payload = { projectId: 'p', mode: 'image', model: 'image-pro', prompt: 'scene', resolution: '1080p', duration: '5', aspectRatio: '16:9', imageCount: 1, uploadId: 'asset-1', token: 'never-persist' };
  const attempt = first.begin(payload);
  first.settle(attempt, false);
  const reloaded = createSubmissionAttemptController(() => 'new-key', storage);
  assert.deepEqual(pendingWorkspaceSettings(reloaded, 'p', [{ id: 'asset-1' }], capabilities), { mode: 'image', model: 'image-pro', prompt: 'scene', resolution: '1080p', duration: '5', aspectRatio: '16:9', imageCount: 1, uploadId: 'asset-1' });
  assert.equal(reloaded.begin(payload).key, 'original-key');
  assert.equal(reloaded.begin({ ...payload, prompt: 'different' }), null);
  assert.equal(values.get('klingPendingAttempts').includes('never-persist'), false);
  reloaded.resolve(reloaded.pendingForProject('p'));
  assert.equal(reloaded.pendingForProject('p'), null);
});

test('pending guidance appears for settled unresolved attempts, not an in-flight submission', () => {
  assert.equal(typeof stageHelpers.shouldShowPendingAttemptGuidance, 'function');
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const attempts = createSubmissionAttemptController(() => 'key', storage);
  const first = attempts.begin({ projectId: 'p', mode: 'text', prompt: 'scene' });
  assert.equal(stageHelpers.shouldShowPendingAttemptGuidance(attempts, 'p'), false);
  attempts.settle(first, true);
  assert.equal(stageHelpers.shouldShowPendingAttemptGuidance(attempts, 'p'), false);
  const unresolved = attempts.begin({ projectId: 'p', mode: 'text', prompt: 'scene' });
  assert.equal(stageHelpers.shouldShowPendingAttemptGuidance(attempts, 'p'), false);
  attempts.settle(unresolved, false);
  assert.equal(stageHelpers.shouldShowPendingAttemptGuidance(attempts, 'p'), true);
  const reloaded = createSubmissionAttemptController(() => 'other', storage);
  assert.equal(stageHelpers.shouldShowPendingAttemptGuidance(reloaded, 'p'), true);
});

test('pending guidance clears only its own text after resolution', () => {
  assert.equal(typeof stageHelpers.pendingAttemptMessage, 'function');
  const warning = stageHelpers.pendingAttemptMessage('', true);
  assert.match(warning, /上次提交结果尚未确认/);
  assert.equal(stageHelpers.pendingAttemptMessage(warning, false), '');
  assert.equal(stageHelpers.pendingAttemptMessage('请输入视频提示词', false), '请输入视频提示词');
  assert.equal(stageHelpers.pendingAttemptMessage('请求失败', true), '请求失败');
});

test('unresolved image submission requires the same project asset on reload', () => {
  const attempts = createSubmissionAttemptController(() => 'key');
  attempts.settle(attempts.begin({ projectId: 'p', mode: 'image', uploadId: 'asset-1' }), false);
  assert.equal(pendingWorkspaceSettings(attempts, 'p', [], capabilities).uploadId, '');
});

test('poller continues older active task after newer task completes', async () => {
  const timers = new Map(); let nextTimer = 0;
  const schedule = (fn, ms) => { assert.ok(ms >= 3000 && ms <= 30000); const id = ++nextTimer; timers.set(id, fn); return id; };
  const cancel = (id) => timers.delete(id);
  const runNext = async () => { const [id, fn] = timers.entries().next().value; timers.delete(id); await fn(); };
  let tasks = [{ id: 'b', status: 'queued' }, { id: 'a', status: 'queued' }];
  const calls = [];
  const poller = createActiveTaskPoller({
    load: async (_projectId, id) => { calls.push(id); return { id, status: 'succeeded' }; },
    onUpdate: (task) => { tasks = tasks.map((row) => row.id === task.id ? task : row); poller.sync('p', tasks); },
    schedule, cancel,
  });
  poller.sync('p', tasks);
  await runNext();
  assert.deepEqual(calls, ['b']);
  assert.equal(timers.size, 1);
  await runNext();
  assert.deepEqual(calls, ['b', 'a']);
  assert.equal(timers.size, 0);
});

test('poller discards stale project responses and prioritizes a selected active task', async () => {
  const timers = new Map(); let nextTimer = 0; let release;
  const schedule = (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; };
  const cancel = (id) => timers.delete(id);
  const calls = [], updates = [];
  const poller = createActiveTaskPoller({
    load: async (projectId, id) => {
      calls.push([projectId, id]);
      if (projectId === 'old') await new Promise((resolve) => { release = resolve; });
      return { id, status: 'succeeded' };
    },
    onUpdate: (task) => { updates.push(task.id); poller.sync('new', [{ id: 'a', status: 'succeeded' }, { id: 'b', status: 'succeeded' }]); },
    schedule, cancel,
  });
  poller.sync('old', [{ id: 'old-task', status: 'queued' }]);
  const oldTimer = timers.entries().next().value; timers.delete(oldTimer[0]);
  const inflight = oldTimer[1]();
  poller.sync('new', [{ id: 'a', status: 'queued' }, { id: 'b', status: 'queued' }]);
  poller.prioritize('b');
  release(); await inflight;
  assert.deepEqual(updates, []);
  const newTimer = timers.entries().next().value; timers.delete(newTimer[0]); await newTimer[1]();
  assert.deepEqual(calls, [['old', 'old-task'], ['new', 'b']]);
  assert.deepEqual(updates, ['b']);
});

test('session drafts restore per-project controls including upload removal', () => {
  const drafts = createProjectDrafts();
  drafts.save('a', { prompt: 'unsubmitted', uploadId: 'asset-a' });
  drafts.save('b', { prompt: 'other', uploadId: '' });
  assert.deepEqual(drafts.load('a', { prompt: 'submitted', uploadId: '' }), { prompt: 'unsubmitted', uploadId: 'asset-a' });
  drafts.save('a', { prompt: 'unsubmitted', uploadId: '' });
  assert.equal(drafts.load('a', { uploadId: 'asset-a' }).uploadId, '');
  assert.equal(drafts.load('c', { prompt: 'server' }).prompt, 'server');
});

test('polling backs off within a 30 second ceiling and resets after success', () => {
  assert.equal(nextPollDelay(3000, false), 6000);
  assert.equal(nextPollDelay(30000, false), 30000);
  assert.equal(nextPollDelay(30000, true), 3000);
});

test('late upload response restores its project after switching away and back', () => {
  assert.equal(shouldSaveStaleUpload(1, 2), true);
  assert.equal(shouldSaveStaleUpload(1, 1), false);
});

test('closed mobile navigation is inert while desktop navigation stays usable', () => {
  assert.equal(sidebarShouldBeInert(false, true), true);
  assert.equal(sidebarShouldBeInert(true, true), false);
  assert.equal(sidebarShouldBeInert(false, false), false);
});

const capabilities = {
  text_to_video: { models: [{ model: 'turbo', arguments: [{ name: 'duration', allowedValues: ['5', '10'] }, { name: 'resolution', allowedValues: ['720p', '1080p'] }, { name: 'aspect_ratio', allowedValues: ['16:9', '9:16'] }] }] },
  image_to_video: { models: [{ model: 'image-pro', arguments: [{ name: 'duration', allowedValues: ['5'] }, { name: 'resolution', allowedValues: ['1080p'] }, { name: 'aspect_ratio', allowedValues: ['1:1', '16:9'] }] }] },
};

test('filters options from model capabilities', () => {
  assert.deepEqual(optionsForModel(capabilities, 'text', 'turbo').resolutions, ['720p', '1080p']);
  assert.deepEqual(optionsForModel(capabilities, 'text', 'turbo').durations, ['5', '10']);
});

test('requires a first frame in image mode', () => {
  assert.equal(validateWorkspace({ mode: 'image', model: 'turbo', uploadId: '', prompt: '' }).uploadId, '请上传首帧参考图');
});

test('requires a selected project and includes it in the generation payload', () => {
  assert.equal(validateWorkspace({ mode: 'text', model: 'turbo', prompt: 'ocean', projectId: '' }).projectId, '请先选择项目');
  assert.equal(buildGenerationPayload({ projectId: 'project-7', mode: 'text', model: 'turbo', prompt: 'ocean' }).projectId, 'project-7');
});

test('selects a saved project or falls back to the first project', () => {
  const projects = [{ id: 'one' }, { id: 'two' }];
  assert.equal(selectCurrentProject(projects, 'two'), projects[1]);
  assert.equal(selectCurrentProject(projects, 'missing'), projects[0]);
  assert.equal(selectCurrentProject([], 'missing'), null);
});

test('create and rename state helpers preserve a single updated project', () => {
  const projects = [{ id: 'one', name: 'One' }];
  assert.deepEqual(upsertProject(projects, { id: 'two', name: 'Two' }), [
    { id: 'two', name: 'Two' },
    { id: 'one', name: 'One' },
  ]);
  assert.deepEqual(upsertProject(projects, { id: 'one', name: 'New One' }), [{ id: 'one', name: 'New One' }]);
  assert.deepEqual(renameProjectInList(projects, { id: 'one', name: 'Renamed' }), [{ id: 'one', name: 'Renamed' }]);
});

test('drawer closes on backdrop, escape, and project selection only', () => {
  for (const reason of ['backdrop', 'escape', 'selection']) assert.equal(closeProjectDrawer(true, reason), false);
  assert.equal(closeProjectDrawer(true, 'unrelated'), true);
  assert.equal(closeProjectDrawer(false, 'escape'), false);
});

test('does not switch or clear pending state when selecting the current project', () => {
  assert.equal(shouldSwitchProject('project-1', { id: 'project-1' }), false);
  assert.equal(shouldSwitchProject('project-1', { id: 'project-2' }), true);
  assert.equal(shouldSwitchProject('', { id: 'project-1' }), true);
});

test('project storage helpers degrade safely when localStorage is unavailable', () => {
  const unavailable = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.equal(readStoredProjectId(unavailable), '');
  assert.equal(storeCurrentProjectId(unavailable, 'project-1'), false);
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(storeCurrentProjectId(storage, 'project-2'), true);
  assert.equal(readStoredProjectId(storage), 'project-2');
});

test('drawer returns focus only for dismiss actions', () => {
  assert.equal(drawerShouldReturnFocus('backdrop'), true);
  assert.equal(drawerShouldReturnFocus('escape'), true);
  assert.equal(drawerShouldReturnFocus('selection'), false);
});

test('entry loader deduplicates active loads and retries after rejection', async () => {
  let calls = 0;
  const loader = createRetryableLoader(async () => {
    calls += 1;
    if (calls === 1) throw new Error('offline');
    return 'ready';
  });
  await assert.rejects(loader(), { message: 'offline' });
  const first = loader();
  const second = loader();
  assert.equal(first, second);
  assert.equal(await first, 'ready');
  assert.equal(calls, 2);
});

test('drawer focus cycle wraps forward and backward', () => {
  assert.equal(nextDrawerFocusIndex(2, 3, false), 0);
  assert.equal(nextDrawerFocusIndex(0, 3, true), 2);
  assert.equal(nextDrawerFocusIndex(1, 3, false), 2);
  assert.equal(nextDrawerFocusIndex(0, 0, false), -1);
});

test('switch failure restores an existing project but blocks an uninitialized workspace', () => {
  assert.deepEqual(switchFailureState('project-1'), { keepProjectId: 'project-1', submissionDisabled: false });
  assert.deepEqual(switchFailureState(''), { keepProjectId: '', submissionDisabled: true });
});

test('drawer is modal only while open on mobile', () => {
  assert.deepEqual(drawerModalState(true, true), { modal: true, backgroundInert: true });
  assert.deepEqual(drawerModalState(true, false), { modal: false, backgroundInert: false });
  assert.deepEqual(drawerModalState(false, true), { modal: false, backgroundInert: false });
});

test('empty project workspace resets values inherited from a populated project', () => {
  const populated = workspaceFormState(capabilities, 'text', {
    mode: 'text', prompt: 'ocean', model: 'turbo', resolution: '1080p', duration: '10', aspectRatio: '9:16',
  });
  const empty = workspaceFormState(capabilities, 'text', {});
  assert.deepEqual(populated, { mode: 'text', prompt: 'ocean', model: 'turbo', resolution: '1080p', duration: '10', aspectRatio: '9:16', imageCount: 1 });
  assert.deepEqual(empty, { mode: 'text', prompt: '', model: 'turbo', resolution: '720p', duration: '5', aspectRatio: '16:9', imageCount: 1 });
});

test('workspace form state restores cross-mode projects without inheriting the previous mode', () => {
  const image = workspaceFormState(capabilities, 'text', { mode: 'image', model: 'image-pro', resolution: '1080p', duration: '5', aspectRatio: '1:1' });
  const text = workspaceFormState(capabilities, 'image', { mode: 'text', model: 'turbo' });
  assert.deepEqual(image, { mode: 'image', prompt: '', model: 'image-pro', resolution: '1080p', duration: '5', aspectRatio: '1:1', imageCount: 1 });
  assert.deepEqual(text, { mode: 'text', prompt: '', model: 'turbo', resolution: '720p', duration: '5', aspectRatio: '16:9', imageCount: 1 });
});

test('workspace form state restores imageCount and clears it for an empty workspace', () => {
  assert.equal(workspaceFormState(capabilities, 'text', { imageCount: '4' }).imageCount, 4);
  assert.equal(workspaceFormState(capabilities, 'text', {}).imageCount, 1);
});

test('workspace image state restores only an asset owned by the loaded workspace', () => {
  const asset = { id: 'asset-a', mimeType: 'image/png', size: 42 };
  assert.deepEqual(workspaceImageState('project-a', { uploadId: 'asset-a' }, [asset]), {
    asset,
    url: '/api/projects/project-a/assets/asset-a',
  });
  assert.equal(workspaceImageState('project-a', { uploadId: 'asset-b' }, [asset]), null);
  assert.equal(workspaceImageState('project-a', {}, [asset]), null);
});

test('workspace task state is isolated, keeps latest status, and finds a usable video URL', () => {
  const tasks = [
    { id: '<task-a>', status: 'done', resultJson: '{"data":{"video_url":"https://cdn.test/a.mp4"}}' },
    { id: 'task-b', status: 'queued', resultJson: '{broken' },
  ];
  const state = workspaceTaskState(tasks);
  assert.equal(state.current.id, '<task-a>');
  assert.equal(state.current.status, 'done');
  assert.equal(state.videoUrl, 'https://cdn.test/a.mp4');
  assert.deepEqual(workspaceTaskState([]), { tasks: [], current: null, videoUrl: '' });
});

test('video URL extraction accepts known video results and rejects unrelated or unsafe URLs', () => {
  assert.equal(extractVideoUrl({ videoUrl: 'https://cdn.test/watch/123' }), 'https://cdn.test/watch/123');
  assert.equal(extractVideoUrl({ data: { video_url: '/media/result.webm' } }), '/media/result.webm');
  assert.equal(extractVideoUrl({ outputs: [{ type: 'video', url: 'https://cdn.test/output?id=1' }] }), 'https://cdn.test/output?id=1');
  assert.equal(extractVideoUrl({ outputs: [{ url: 'https://cdn.test/output.mp4' }] }), 'https://cdn.test/output.mp4');
  assert.equal(extractVideoUrl({ works: [{ contentType: 'video', url: 'https://cdn.test/output' }] }), 'https://cdn.test/output');
  assert.equal(extractVideoUrl({ works: [{ url: 'https://cdn.test/watermarked.mp4', urlWithoutWatermark: 'https://cdn.test/clean.mp4' }] }), 'https://cdn.test/clean.mp4');
  assert.equal(extractVideoUrl({ works: [{ url_without_watermark: 'https://cdn.test/clean.webm' }] }), 'https://cdn.test/clean.webm');
  assert.equal(extractVideoUrl({ works: [{ type: 'image', urlWithoutWatermark: 'https://cdn.test/poster.jpg' }] }), '');
  assert.equal(extractVideoUrl({ works: [{ contentType: 'image', url_without_watermark: 'https://cdn.test/poster.jpg' }] }), '');
  for (const result of [
    { thumbnail_url: 'https://cdn.test/thumb.jpg' },
    { statusUrl: 'https://cdn.test/status' },
    { outputs: [{ type: 'image', url: 'https://cdn.test/image.jpg' }] },
    { videoUrl: 'javascript:alert(1)' },
    { video_url: 'data:video/mp4;base64,AAAA' },
    { works: [{ urlWithoutWatermark: 'javascript:alert(1)' }] },
    { works: [{ url_without_watermark: 'data:video/mp4;base64,AAAA' }] },
  ]) assert.equal(extractVideoUrl(result), '');
});

test('video cleanup stops playback, detaches the resource, reloads, and hides the element', () => {
  const events = [];
  const video = {
    hidden: false,
    pause() { events.push('pause'); },
    removeAttribute(name) { events.push(`remove:${name}`); },
    load() { events.push('load'); },
  };
  clearVideoElement(video);
  assert.deepEqual(events, ['pause', 'remove:src', 'load']);
  assert.equal(video.hidden, true);
});

test('video sync preserves a playing clip at the same URL and clears changed or non-video media', () => {
  assert.equal(typeof stageHelpers.syncResultVideo, 'function');
  const events = [];
  let source = 'https://cdn.test/old.mp4';
  const video = {
    hidden: false,
    getAttribute(name) { return name === 'src' ? source : null; },
    set src(value) { source = value; events.push(`set:${value}`); },
    pause() { events.push('pause'); },
    removeAttribute(name) { events.push(`remove:${name}`); source = ''; },
    load() { events.push('load'); },
  };
  stageHelpers.syncResultVideo(video, 'https://cdn.test/old.mp4');
  assert.deepEqual(events, []);
  assert.equal(source, 'https://cdn.test/old.mp4');
  assert.equal(video.hidden, false);

  stageHelpers.syncResultVideo(video, 'https://cdn.test/new.mp4');
  assert.deepEqual(events, ['pause', 'remove:src', 'load', 'set:https://cdn.test/new.mp4']);
  assert.equal(video.hidden, false);

  stageHelpers.syncResultVideo(video, '');
  assert.deepEqual(events.slice(-3), ['pause', 'remove:src', 'load']);
  assert.equal(source, '');
  assert.equal(video.hidden, true);
});

test('terminal stage override survives older task updates until deliberately cleared', () => {
  assert.equal(typeof stageHelpers.resolveResultStage, 'function');
  const terminal = { kind: 'terminal', title: '提交失败', copy: '请重试。' };
  const initial = taskPresentationState([{ id: 'old', status: 'queued' }]);
  const updated = taskPresentationState([{ id: 'old', status: 'generating', resultJson: '{"progress":28}' }]);
  assert.equal(stageHelpers.resolveResultStage(initial, terminal), terminal);
  assert.equal(stageHelpers.resolveResultStage(updated, terminal), terminal);
  assert.equal(stageHelpers.resolveResultStage(updated, null), updated);
});

test('submission responses mutate UI only for the latest token in the submitted project', () => {
  assert.equal(isCurrentSubmission('project-a', 'project-a', 3, 3), true);
  assert.equal(isCurrentSubmission('project-b', 'project-a', 3, 3), false);
  assert.equal(isCurrentSubmission('project-a', 'project-a', 2, 3), false);
});

test('stale project generation success and failure do not mutate the replacement workspace', async () => {
  for (const outcome of ['success', 'failure']) {
    const mutations = [];
    let current = true;
    const pending = performGenerationSubmission({
      submit: async () => {
        await Promise.resolve();
        current = false;
        if (outcome === 'failure') throw new Error('old project failed');
        return { id: 'old-task' };
      },
      isCurrent: () => current,
      success: () => mutations.push('success'),
      fail: () => mutations.push('failure'),
    });
    assert.equal(await pending, false);
    assert.deepEqual(mutations, []);
  }
});

test('failed project switch keeps the prior pending submission current', async () => {
  let generationToken = 4;
  let activeProjectId = 'project-a';
  const mutations = [];
  await performProjectSwitch({
    load: async () => { throw new Error('switch failed'); },
    setBusy: () => {},
    commit: (workspace) => commitProjectWorkspace(() => { generationToken += 1; }, () => { activeProjectId = 'project-b'; }, workspace),
    fail: () => {},
  });
  const applied = await performGenerationSubmission({
    submit: async () => ({ id: 'task-a' }),
    isCurrent: () => isCurrentSubmission(activeProjectId, 'project-a', 4, generationToken),
    success: () => mutations.push('success'),
    fail: () => mutations.push('failure'),
  });
  assert.equal(applied, true);
  assert.deepEqual(mutations, ['success']);
  assert.equal(generationToken, 4);
});

test('successful project commit invalidates pending submissions immediately before selection changes', () => {
  const events = [];
  commitProjectWorkspace(() => events.push('invalidate'), () => events.push('commit'), { project: { id: 'project-b' } });
  assert.deepEqual(events, ['invalidate', 'commit']);
});

test('task success refreshes account status once and suppresses stale refresh UI', async () => {
  let calls = 0;
  const applied = [];
  let current = true;
  const refreshed = await refreshAccountSnapshot({
    load: async () => { calls += 1; current = false; return { membership: 'pro', credits: 9 }; },
    isCurrent: () => current,
    apply: (status) => applied.push(status),
  });
  assert.equal(calls, 1);
  assert.equal(refreshed, false);
  assert.deepEqual(applied, []);

  current = true;
  assert.equal(await refreshAccountSnapshot({ load: async () => { calls += 1; return { credits: 8 }; }, isCurrent: () => current, apply: (status) => applied.push(status) }), true);
  assert.equal(calls, 2);
  assert.deepEqual(applied, [{ credits: 8 }]);
});

test('new task is prepended only to the active project task list', () => {
  assert.deepEqual(prependProjectTask('project-a', 'project-a', [{ id: 'old' }], { id: 'new', status: 'queued' }).map(({ id }) => id), ['new', 'old']);
  assert.deepEqual(prependProjectTask('project-a', 'project-b', [{ id: 'old' }], { id: 'foreign' }).map(({ id }) => id), ['old']);
});

test('workspace form state falls back to text mode for missing or invalid saved modes', () => {
  assert.equal(workspaceFormState(capabilities, 'image', {}).mode, 'text');
  assert.equal(workspaceFormState(capabilities, 'image', { mode: 'unknown', model: 'image-pro' }).mode, 'text');
  assert.equal(workspaceFormState(capabilities, 'image', { mode: 'unknown', model: 'image-pro' }).model, 'turbo');
});

test('project switch controller preserves selection and surfaces a visible failure', async () => {
  const state = { busy: false, projectId: 'project-a', error: '', drawerOpen: false, focused: '' };
  const switched = await performProjectSwitch({
    load: async () => { throw new Error('network down'); },
    setBusy: (busy) => { state.busy = busy; },
    commit: () => { state.projectId = 'project-b'; },
    fail: (error) => { state.busy = false; state.error = `项目加载失败：${error.message}`; state.drawerOpen = true; state.focused = 'project-error'; },
  });
  assert.equal(switched, false);
  assert.deepEqual(state, { busy: false, projectId: 'project-a', error: '项目加载失败：network down', drawerOpen: true, focused: 'project-error' });
});
