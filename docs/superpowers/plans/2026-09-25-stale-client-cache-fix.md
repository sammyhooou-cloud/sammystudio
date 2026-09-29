# Stale Client Cache Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every production HTML build loads the matching project-management and upload JavaScript instead of a previously immutable cached client.

**Architecture:** Keep source module names stable for local development, but generate content-fingerprinted JavaScript filenames in `dist/client` and matching routes in the Worker asset map. Rewrite the generated HTML entry and the generated app module import so both the entry module and its dependency get new cache keys whenever their content changes.

**Tech Stack:** Node.js build script, SHA-256 content hashes, Node.js built-in test runner, existing static Worker asset map.

---

### Task 1: Fingerprint the production JavaScript module graph

**Files:**
- Modify: `tests/release.test.mjs`
- Modify: `scripts/build.mjs`
- Generated: `dist/client/index.html`
- Generated: `dist/client/app.<hash>.js`
- Generated: `dist/client/image-preview.<hash>.js`
- Generated: `dist/server/site-assets.js`

- [ ] **Step 1: Add a failing production-build regression test**

Add a test that runs `node scripts/build.mjs`, reads the generated HTML, requires `/app.<12 hex chars>.js`, reads that module, requires its import to point to `/image-preview.<12 hex chars>.js`, verifies both files exist, and verifies the Worker asset map contains both fingerprinted routes. Also assert the generated HTML does not contain `src="/app.js"`.

```js
test('production build fingerprints the complete client module graph', async () => {
  await execFileAsync(process.execPath, ['scripts/build.mjs'], { cwd: projectRoot });
  const html = await readFile(new URL('../dist/client/index.html', import.meta.url), 'utf8');
  const appRoute = html.match(/src="(\/app\.[a-f0-9]{12}\.js)"/)?.[1];
  assert.ok(appRoute, 'generated HTML must reference a fingerprinted app module');
  assert.doesNotMatch(html, /src="\/app\.js"/);

  const app = await readFile(new URL(`../dist/client${appRoute}`, import.meta.url), 'utf8');
  const previewRoute = app.match(/from ['"](\.\/image-preview\.[a-f0-9]{12}\.js)['"]/)?.[1];
  assert.ok(previewRoute, 'generated app must reference a fingerprinted preview module');
  await access(new URL(`../dist/client/${previewRoute.slice(2)}`, import.meta.url));

  const assets = await readFile(new URL('../dist/server/site-assets.js', import.meta.url), 'utf8');
  assert.match(assets, new RegExp(appRoute.replaceAll('.', '\\.')));
  assert.match(assets, new RegExp(previewRoute.slice(1).replaceAll('.', '\\.')));
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/release.test.mjs`

Expected: the new test fails because generated HTML still references `/app.js`.

- [ ] **Step 3: Implement deterministic content fingerprints in the build**

Use `createHash('sha256')` to hash the preview module content first, then hash the app source together with the preview hash so a dependency change also changes the entry module URL. Write transformed generated files and use their transformed strings in `site-assets.js`.

```js
const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);
const previewSource = await readFile('public/image-preview.js', 'utf8');
const previewHash = digest(previewSource);
const previewRoute = `/image-preview.${previewHash}.js`;
const appSource = await readFile('public/app.js', 'utf8');
const appHash = digest(`${appSource}\n${previewHash}`);
const appRoute = `/app.${appHash}.js`;
const generatedApp = appSource.replace("'./image-preview.js'", `'./image-preview.${previewHash}.js'`);
const generatedIndex = (await readFile('public/index.html', 'utf8')).replace('src="/app.js"', `src="${appRoute}"`);
```

Write `generatedIndex`, `generatedApp`, and `previewSource` to the matching `dist/client` paths. Build `site-assets.js` with `/index.html`, `appRoute`, and `previewRoute` mapped to those exact transformed bodies. Do not change source URLs used by local development.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/release.test.mjs`

Expected: all release tests pass.

- [ ] **Step 5: Run the full suite and production build**

Run: `npm test && npm run build`

Expected: all tests pass and the final production build succeeds.

- [ ] **Step 6: Commit the cache fix and generated bundle**

```bash
git add tests/release.test.mjs scripts/build.mjs dist
git commit -m "fix: fingerprint production client modules"
```

