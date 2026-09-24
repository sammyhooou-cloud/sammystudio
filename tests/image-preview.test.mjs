import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createImageUploadController, formatBytes, imagePreviewState, openImageReplacement, renderImagePreview } from '../public/image-preview.js';

test('formatBytes formats bytes, kilobytes, and megabytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(2.25 * 1024 * 1024), '2.25 MB');
});

test('imagePreviewState exposes friendly image metadata', () => {
  assert.deepEqual(imagePreviewState({ name: 'frame.webp', type: 'image/webp', size: 2048 }, 'blob:frame', 'uploaded'), {
    src: 'blob:frame', name: 'frame.webp', format: 'WebP', size: '2 KB', status: '上传成功', canSubmit: true,
  });
});

test('imagePreviewState handles unknown and empty MIME types', () => {
  assert.equal(imagePreviewState({ name: 'frame.avif', type: 'image/avif', size: 1 }, 'blob:a', 'uploading').format, 'AVIF');
  assert.equal(imagePreviewState({ name: 'frame', type: '', size: 1 }, 'blob:b', 'failed').format, '未知格式');
});

test('imagePreviewState maps upload phases to status and submission state', () => {
  const file = { name: 'x.png', type: 'image/png', size: 8 };
  assert.deepEqual(['uploading', 'uploaded', 'failed'].map((phase) => {
    const state = imagePreviewState(file, 'blob:x', phase);
    return [state.status, state.canSubmit];
  }), [['上传中…', false], ['上传成功', true], ['上传失败', false]]);
});

test('renderImagePreview writes untrusted filenames as text', () => {
  const node = () => ({ textContent: '', hidden: false, src: '', alt: '', setAttribute(name, value) { this[name] = value; } });
  const view = { empty: node(), preview: node(), image: node(), name: node(), details: node(), status: node() };
  const unsafe = '<img src=x onerror=alert(1)>';
  renderImagePreview(view, { src: 'blob:x', name: unsafe, format: 'PNG', size: '1 KB', status: '上传成功', canSubmit: true });
  assert.equal(view.name.textContent, unsafe);
  assert.equal(view.image.alt, `${unsafe} 预览`);
  assert.equal(view.details.textContent, 'PNG · 1 KB');
  assert.equal(view.empty.hidden, true);
  assert.equal(view.preview.hidden, false);
});

function uploadHarness() {
  const created = [], revoked = [], forms = [], renders = [], requests = [];
  const deferred = () => { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; };
  const controller = createImageUploadController({
    createObjectURL(file) { created.push(file.name); return `blob:${file.name}`; },
    revokeObjectURL(url) { revoked.push(url); },
    createFormData() { const entries = []; forms.push(entries); return { append(key, value) { entries.push([key, value]); } }; },
    request(form) { const pending = deferred(); requests.push({ form, ...pending }); return pending.promise; },
    render(state) { renders.push(state); },
  });
  return { controller, created, revoked, forms, renders, requests };
}

test('controller creates a preview immediately and submits file with projectId', () => {
  const harness = uploadHarness();
  const file = { name: 'frame.png', type: 'image/png', size: 12 };
  const pending = harness.controller.select(file, 'project-7');
  assert.equal(harness.created[0], 'frame.png');
  assert.equal(harness.renders[0].status, '上传中…');
  assert.equal(harness.controller.canSubmit, false);
  assert.deepEqual(harness.forms[0], [['file', file], ['projectId', 'project-7']]);
  harness.requests[0].resolve({ uploadId: 'upload-7' });
  return pending.then(() => { assert.equal(harness.controller.uploadId, 'upload-7'); assert.equal(harness.controller.canSubmit, true); });
});

test('controller clears uploadId and gates submission when upload fails', async () => {
  const harness = uploadHarness();
  const pending = harness.controller.select({ name: 'bad.png', type: 'image/png', size: 1 }, 'project-1');
  harness.requests[0].reject(new Error('network'));
  await assert.rejects(pending, /network/);
  assert.equal(harness.controller.uploadId, '');
  assert.equal(harness.controller.canSubmit, false);
  assert.equal(harness.renders.at(-1).status, '上传失败');
});

test('controller suppresses stale upload responses and revokes replacement URLs', async () => {
  const harness = uploadHarness();
  const first = harness.controller.select({ name: 'one.png', type: 'image/png', size: 1 }, 'p');
  const second = harness.controller.select({ name: 'two.png', type: 'image/png', size: 1 }, 'p');
  assert.deepEqual(harness.revoked, ['blob:one.png']);
  harness.requests[0].resolve({ uploadId: 'stale' }); await first;
  assert.equal(harness.controller.uploadId, '');
  harness.requests[1].resolve({ uploadId: 'current' }); await second;
  assert.equal(harness.controller.uploadId, 'current');
});

test('controller revokes URLs on removal, project switch, and unload', () => {
  for (const action of ['remove', 'projectSwitch', 'unload']) {
    const harness = uploadHarness();
    harness.controller.select({ name: `${action}.png`, type: 'image/png', size: 1 }, 'p');
    harness.controller[action]();
    assert.deepEqual(harness.revoked, [`blob:${action}.png`]);
    assert.equal(harness.controller.uploadId, '');
    assert.equal(harness.controller.canSubmit, false);
  }
});

test('controller restores an authenticated server asset without creating or revoking an object URL', () => {
  const harness = uploadHarness();
  harness.controller.restore({ id: 'asset-7', mimeType: 'image/webp', size: 2048 }, '/api/projects/project-1/assets/asset-7');
  assert.equal(harness.controller.uploadId, 'asset-7');
  assert.equal(harness.controller.canSubmit, true);
  assert.equal(harness.created.length, 0);
  assert.equal(harness.renders.at(-1).src, '/api/projects/project-1/assets/asset-7');
  assert.equal(harness.renders.at(-1).format, 'WebP');
  harness.controller.remove();
  assert.equal(harness.revoked.length, 0);
});

test('replacement clears the input before opening the picker without clearing preview state', () => {
  const events = [];
  const input = { _value: 'C:/fakepath/frame.png', set value(value) { events.push(['value', value]); this._value = value; }, click() { events.push(['click']); } };
  openImageReplacement(input);
  assert.deepEqual(events, [['value', ''], ['click']]);
});

test('invalid files render failed metadata without making an upload request', async () => {
  for (const [file, message] of [
    [{ name: 'frame.gif', type: 'image/gif', size: 12 }, '仅支持 JPG、PNG 或 WebP 图片'],
    [{ name: 'huge.png', type: 'image/png', size: 16 * 1024 * 1024 }, '图片不能超过 15MB'],
  ]) {
    const harness = uploadHarness();
    await assert.rejects(harness.controller.select(file, 'project-1'), { message });
    assert.equal(harness.created.length, 1);
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.controller.uploadId, '');
    assert.equal(harness.controller.canSubmit, false);
    assert.deepEqual({ name: harness.renders.at(-1).name, status: harness.renders.at(-1).status }, { name: file.name, status: message });
  }
});

test('upload surface uses a full-area label and visible focus proxy', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/image-preview.css', import.meta.url), 'utf8');
  assert.match(html, /<label id="upload-copy" for="reference-image"/);
  assert.match(css, /\.upload > label[\s\S]*min-height:\s*112px/);
  assert.match(css, /\.upload:focus-within/);
});
