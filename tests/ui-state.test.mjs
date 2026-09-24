import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGenerationPayload,
  closeProjectDrawer,
  optionsForModel,
  renameProjectInList,
  selectCurrentProject,
  upsertProject,
  validateWorkspace,
} from '../public/app.js';

const capabilities = { text_to_video: { models: [{ model: 'turbo', arguments: [{ name: 'duration', allowedValues: ['5', '10'] }, { name: 'resolution', allowedValues: ['720p', '1080p'] }, { name: 'aspect_ratio', allowedValues: ['16:9', '9:16'] }] }] } };

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
