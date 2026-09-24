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
} from '../public/app.js';

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
