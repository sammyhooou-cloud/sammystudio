import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGenerationPayload, optionsForModel, validateWorkspace } from '../public/app.js';

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
