import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, imagePreviewState, renderImagePreview } from '../public/image-preview.js';

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
