import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const publicFile = (name) => new URL(`../public/${name}`, import.meta.url);
const videoUrl = 'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260521_014404_fadafdb1-4df6-4699-be9c-77d25f39a3d0.mp4';

test('login and workspace are independent documents with only their own forms', async () => {
  const [login, workspace] = await Promise.all(['login.html', 'workspace.html'].map((name) => readFile(publicFile(name), 'utf8')));
  assert.match(login, /<body class="login-page">/);
  assert.match(login, /id="login-form"/);
  assert.doesNotMatch(login, /id="generator-form"|id="workspace-view"|src="\/app\.js"/);
  assert.match(login, /src="\/login\.js"/);
  assert.match(workspace, /<body class="workspace-page">/);
  assert.match(workspace, /id="generator-form"/);
  assert.doesNotMatch(workspace, /id="login-form"|id="login-view"|src="\/login\.js"/);
  assert.match(workspace, /src="\/app\.js"/);
  assert.doesNotMatch(workspace, /id="workspace-view"[^>]*\bhidden\b/);
  for (const html of [login, workspace]) {
    const tag = html.match(/<video\b[^>]*class="stage-video"[^>]*>/)?.[0] || '';
    for (const attribute of ['muted', 'autoplay', 'loop', 'playsinline']) assert.match(tag, new RegExp(`\\b${attribute}\\b`));
    assert.match(tag, /poster="\/assets\/alpine-runner\.jpg"/);
    assert.match(tag, /aria-hidden="true"/);
    assert.doesNotMatch(tag, /\bcontrols\b/);
    assert.ok(html.includes(`<source src="${videoUrl}"`));
    assert.match(html, /href="\/styles\.css"/);
  }
});

test('obsolete combined index document is removed', async () => {
  await assert.rejects(access(publicFile('index.html')), { code: 'ENOENT' });
});

test('result page is standalone with safe background and stable media layout', async () => {
  const html = await readFile(publicFile('result.html'), 'utf8');
  for (const id of ['result-detail', 'result-player', 'result-progress', 'result-terminal', 'result-meta', 'result-error', 'back-to-workspace']) assert.ok(html.includes(`id="${id}"`));
  assert.doesNotMatch(html, /id="login-form"|id="generator-form"|src="\/app\.js"|src="\/login\.js"/);
  assert.match(html, /src="\/result\.js"/);
  assert.match(html, /href="\/result-detail\.css"/);
  const video = html.match(/<video\b[^>]*class="stage-video"[^>]*>/)?.[0] || '';
  for (const attribute of ['muted', 'autoplay', 'loop', 'playsinline']) assert.match(video, new RegExp(`\\b${attribute}\\b`));
  assert.match(video, /poster="\/assets\/alpine-runner\.jpg"/);
  assert.match(video, /aria-hidden="true"/);
  assert.doesNotMatch(video, /\bcontrols\b/);
  assert.ok(html.includes(`<source src="${videoUrl}"`));
  const css = await readFile(publicFile('result-detail.css'), 'utf8');
  assert.match(css, /\.result-media-stage\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/);
  assert.match(css, /\.result-detail-layer\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*place-content:\s*center/);
  assert.match(css, /#result-player\s*\{[^}]*object-fit:\s*contain/);
  assert.match(css, /#result-meta\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)[\s\S]*#result-meta\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('page overlays are scoped with stronger workspace contrast', async () => {
  const css = await readFile(publicFile('styles.css'), 'utf8');
  assert.match(css, /\.login-page \.stage:before\{[^}]*rgba\(3,5,3,\.62\)/);
  assert.match(css, /\.workspace-page \.stage:before\{[^}]*rgba\(3,5,3,\.82\)/);
});

async function loginHarness(fetch) {
  const elements = {
    '#login-form': {},
    '#username': { value: 'entered-user' },
    '#password': { value: 'entered-password', type: 'password' },
    '#password-toggle': { textContent: '显示', setAttribute(name, value) { this[name] = value; } },
    '#login-error': { textContent: '' },
  };
  const submit = { disabled: false };
  elements['#login-form'].querySelector = () => submit;
  const redirects = [];
  const source = await readFile(publicFile('login.js'), 'utf8');
  runInNewContext(source, { document: { querySelector: (selector) => elements[selector] }, fetch, location: { replace: (path) => redirects.push(path) } });
  return { elements, submit, redirects, submitForm: () => elements['#login-form'].onsubmit({ preventDefault() {} }) };
}

test('login toggles password visibility with an accurate control label', async () => {
  const { elements } = await loginHarness(() => {});
  elements['#password-toggle'].onclick();
  assert.equal(elements['#password'].type, 'text');
  assert.equal(elements['#password-toggle'].textContent, '隐藏');
  elements['#password-toggle'].onclick();
  assert.equal(elements['#password'].type, 'password');
  assert.equal(elements['#password-toggle'].textContent, '显示');
});

test('login posts entered credentials once while pending and replaces the page on success', async () => {
  let complete;
  const calls = [];
  const { submitForm, submit, redirects } = await loginHarness((path, options) => {
    calls.push({ path, options });
    return new Promise((resolve) => { complete = resolve; });
  });
  const pending = submitForm();
  assert.equal(submit.disabled, true);
  await submitForm();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/session');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), { username: 'entered-user', password: 'entered-password' });
  complete({ ok: true, json: async () => ({}) });
  await pending;
  assert.deepEqual(redirects, ['/workspace']);
});

test('failed login displays safe inline errors and allows a retry', async () => {
  const { elements, submitForm, submit, redirects } = await loginHarness(async () => ({ ok: false, json: async () => ({ error: '<script>unsafe</script>' }) }));
  await submitForm();
  assert.equal(elements['#login-error'].textContent, '<script>unsafe</script>');
  assert.equal(elements['#login-error'].innerHTML, undefined);
  assert.equal(submit.disabled, false);
  assert.deepEqual(redirects, []);
});

test('workspace starts its retryable loader directly and logs out to the login page', async () => {
  const source = await readFile(publicFile('app.js'), 'utf8');
  assert.doesNotMatch(source, /loginView|loginForm|enterWorkspace|#password-toggle|#login-error/);
  assert.doesNotMatch(source, /request\('\/api\/session'\)\.then/);
  assert.match(source, /loadWorkspace\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(source, /retryWorkspace\.onclick = \(\) => \{ loadWorkspace\(\)\.catch/);
  assert.match(source, /await request\('\/api\/session', \{ method: 'DELETE' \}\); location\.replace\('\/login'\)/);
});
