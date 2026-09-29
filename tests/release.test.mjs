import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import worker, { sanitizeFilename } from '../src/worker.js';
import { siteAssets } from '../src/site-assets.js';
import { access, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = new URL('..', import.meta.url);
const fingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);

test('production build packages independent pages and their complete fingerprinted module graph', async () => {
  await execFileAsync(process.execPath, ['scripts/build.mjs'], { cwd: projectRoot });
  const modules = new Map();
  const documents = new Map();
  for (const [page, entry] of [['login', 'login'], ['workspace', 'app'], ['result', 'result']]) {
    const html = await readFile(new URL(`../dist/client/${page}.html`, import.meta.url), 'utf8');
    const route = html.match(new RegExp(`src="(/${entry}\\.[a-f0-9]{12}\\.js)"`))?.[1];
    assert.ok(route, `${page} must reference its own fingerprinted entry`);
    assert.doesNotMatch(html, /src="\/(?:app|login|result)\.js"/);
    assert.equal((html.match(/<script\b/g) || []).length, 1);
    documents.set(`/${page}.html`, html);
    modules.set(route, await readFile(new URL(`../dist/client${route}`, import.meta.url), 'utf8'));
  }
  await assert.rejects(access(new URL('../dist/client/index.html', import.meta.url)), { code: 'ENOENT' });
  for (const name of ['login', 'app', 'result', 'image-preview', 'task-presenter']) {
    await assert.rejects(access(new URL(`../dist/client/${name}.js`, import.meta.url)), { code: 'ENOENT' });
  }

  const appRoute = [...modules.keys()].find((route) => route.startsWith('/app.'));
  const resultRoute = [...modules.keys()].find((route) => route.startsWith('/result.'));
  const app = modules.get(appRoute);
  const result = modules.get(resultRoute);
  const previewImport = app.match(/from ['"](\.\/image-preview\.[a-f0-9]{12}\.js)['"]/)?.[1];
  const presenterImport = app.match(/from ['"](\.\/task-presenter\.[a-f0-9]{12}\.js)['"]/)?.[1];
  assert.ok(previewImport, 'workspace references the fingerprinted image-preview module');
  assert.ok(presenterImport, 'workspace references the fingerprinted presenter module');
  assert.equal(result.match(/from ['"](\.\/task-presenter\.[a-f0-9]{12}\.js)['"]/)?.[1], presenterImport);
  assert.doesNotMatch(`${app}\n${result}`, /from ['"]\.\/(?:image-preview|task-presenter)\.js['"]/);
  for (const specifier of [previewImport, presenterImport]) {
    const route = specifier.slice(1);
    modules.set(route, await readFile(new URL(`../dist/client${route}`, import.meta.url), 'utf8'));
  }
  assert.equal(modules.size, 5);
  for (const [route, source] of modules) {
    assert.ok(route.endsWith(`.${fingerprint(source)}.js`), 'module name hashes its final rewritten source');
  }
  for (const [name, importPath] of [['image-preview', previewImport], ['task-presenter', presenterImport]]) {
    const source = await readFile(new URL(`../public/${name}.js`, import.meta.url), 'utf8');
    assert.equal(modules.get(importPath.slice(1)), source);
  }
  const sourceApp = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const sourceResult = await readFile(new URL('../public/result.js', import.meta.url), 'utf8');
  assert.equal(app, sourceApp.replace("from './image-preview.js'", `from '${previewImport}'`).replace("from './task-presenter.js'", `from '${presenterImport}'`));
  assert.equal(result, sourceResult.replace("from './task-presenter.js'", `from '${presenterImport}'`));

  const { siteAssets: builtAssets } = await import(new URL(`../dist/server/site-assets.js?asset-test=${Date.now()}`, import.meta.url));
  const styles = ['styles.css', 'project-navigation.css', 'image-preview.css', 'task-history.css', 'result-detail.css'];
  assert.deepEqual([...builtAssets.keys()].sort(), [...documents.keys(), ...modules.keys(), ...styles.map((name) => `/${name}`), '/assets/alpine-runner.jpg'].sort());
  const { default: builtWorker } = await import(new URL(`../dist/server/worker.js?cache-test=${Date.now()}`, import.meta.url));
  for (const [route, source] of modules) {
    assert.equal(builtAssets.get(route).immutable, true);
    const response = await builtWorker.fetch(new Request(`https://site.test${route}`), {}, {});
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(await response.text(), source);
  }
  for (const [route, html] of documents) {
    assert.equal(builtAssets.get(route).immutable, false);
    const response = await builtWorker.fetch(new Request(`https://site.test${route}`), {}, {});
    assert.equal(response.headers.get('cache-control'), 'no-cache, must-revalidate');
    assert.equal(await response.text(), html);
  }
  for (const name of styles) {
    const response = await builtWorker.fetch(new Request(`https://site.test/${name}`), {}, {});
    assert.equal(response.headers.get('cache-control'), 'no-cache, must-revalidate');
    assert.equal(await response.text(), await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8'));
  }
  const imageResponse = await builtWorker.fetch(new Request('https://site.test/assets/alpine-runner.jpg'), {}, {});
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), await readFile(new URL('../public/assets/alpine-runner.jpg', import.meta.url)));
  assert.equal(builtAssets.get('/assets/alpine-runner.jpg').base64, true);

  const snapshot = await readFile(new URL('../dist/server/site-assets.js', import.meta.url), 'utf8');
  await execFileAsync(process.execPath, ['scripts/build.mjs'], { cwd: projectRoot });
  assert.equal(await readFile(new URL('../dist/server/site-assets.js', import.meta.url), 'utf8'), snapshot, 'repeat builds produce identical assets');
});

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
  const html = await readFile(new URL('../public/workspace.html', import.meta.url), 'utf8');
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
