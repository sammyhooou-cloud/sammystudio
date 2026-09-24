import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { sanitizeFilename } from '../src/worker.js';
import { siteAssets } from '../src/site-assets.js';
import { readFile } from 'node:fs/promises';

test('unversioned script and style responses require revalidation', async () => {
  for (const path of ['/app.js', '/styles.css', '/image-preview.js']) {
    siteAssets.set(path, { type: path.endsWith('.js') ? 'text/javascript' : 'text/css', body: 'content' });
    const response = await worker.fetch(new Request(`https://site.test${path}`), {}, {});
    assert.match(response.headers.get('cache-control'), /no-cache/);
    assert.doesNotMatch(response.headers.get('cache-control'), /immutable/);
    siteAssets.delete(path);
  }
});

test('two-panel layout switches to stacked drawer before generator is crushed', async () => {
  const css = await readFile(new URL('../public/project-navigation.css', import.meta.url), 'utf8');
  const main = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(css, /max-width:1200px/);
  assert.match(main, /max-width:1200px/);
  assert.match(html, /id="sidebar-collapse"[^>]+aria-expanded="true"/);
});

test('mutation routes reject missing and cross-origin requests and wrong media types', async () => {
  const env = { DB: { prepare() { return { async run() { return {}; } }; }, async batch() { return []; } } };
  const cases = [
    [{ 'content-type': 'application/json' }, 403],
    [{ origin: 'https://evil.test', 'content-type': 'application/json' }, 403],
    [{ origin: 'https://site.test', 'content-type': 'text/plain' }, 415],
  ];
  for (const [headers, status] of cases) {
    const response = await worker.fetch(new Request('https://site.test/api/projects', { method: 'POST', headers, body: '{}' }), env, {});
    assert.equal(response.status, status);
  }
});

test('uploaded names are reduced to a safe original basename', () => {
  assert.equal(sanitizeFilename('../folder/scene\u0000.png'), 'scene.png');
  assert.equal(sanitizeFilename('C:\\photos\\frame.webp'), 'frame.webp');
});
