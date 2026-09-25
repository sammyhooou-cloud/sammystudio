import test from 'node:test';
import assert from 'node:assert/strict';
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
  for (const result of [
    { thumbnail_url: 'https://cdn.test/thumb.jpg' },
    { statusUrl: 'https://cdn.test/status' },
    { outputs: [{ type: 'image', url: 'https://cdn.test/image.jpg' }] },
    { videoUrl: 'javascript:alert(1)' },
    { video_url: 'data:video/mp4;base64,AAAA' },
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
