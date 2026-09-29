# Motion Background and Frosted Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static page background with the authorized MotionSites looping video and restyle the login card as dark frosted glass without changing authentication or workspace behavior.

**Architecture:** Add one decorative `<video>` layer inside the existing `.stage` stacking context, keeping the alpine image as the poster and CSS fallback. Keep all visual behavior in `public/styles.css`; add a focused source-level test that protects media attributes, reduced-motion behavior, responsive focal positioning, and login glass styling.

**Tech Stack:** Static HTML, CSS, Node.js built-in test runner, existing Sites Worker build.

---

### Task 1: Protect the visual contract with failing tests

**Files:**
- Create: `tests/visual-background.test.mjs`
- Read: `public/index.html`
- Read: `public/styles.css`

- [ ] **Step 1: Write the failing source-level tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const htmlUrl = new URL('../public/index.html', import.meta.url);
const cssUrl = new URL('../public/styles.css', import.meta.url);
const videoUrl = 'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260521_014404_fadafdb1-4df6-4699-be9c-77d25f39a3d0.mp4';

test('decorative MotionSites background is safe and non-interactive', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  const tag = html.match(/<video\b[^>]*class="stage-video"[^>]*>/)?.[0] || '';
  assert.match(tag, /\bautoplay\b/);
  assert.match(tag, /\bmuted\b/);
  assert.match(tag, /\bloop\b/);
  assert.match(tag, /\bplaysinline\b/);
  assert.match(tag, /poster="\/assets\/alpine-runner\.jpg"/);
  assert.match(tag, /aria-hidden="true"/);
  assert.match(tag, /tabindex="-1"/);
  assert.doesNotMatch(tag, /\bcontrols\b/);
  assert.match(html, new RegExp(videoUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('background and frosted login styles include fallback and responsive behavior', async () => {
  const css = (await readFile(cssUrl, 'utf8')).replace(/\s+/g, '');
  assert.match(css, /\.stage-video\{[^}]*object-fit:cover/);
  assert.match(css, /\.stage-video\{[^}]*pointer-events:none/);
  assert.match(css, /@media\(max-width:760px\)\{[^}]*\.stage-video\{[^}]*object-position:/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{[^}]*\.stage-video\{[^}]*display:none/);
  assert.match(css, /\.login-card\{[^}]*backdrop-filter:blur\(/);
  assert.match(css, /\.login-card\{[^}]*border:1pxsolidrgba\(/);
  assert.match(css, /\.login-cardinput\{[^}]*background:rgba\(/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/visual-background.test.mjs`

Expected: FAIL because `.stage-video` and the frosted-login rules do not exist yet.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/visual-background.test.mjs
git commit -m "test: define motion background visual contract"
```

### Task 2: Add the decorative video and dark frosted glass

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Test: `tests/visual-background.test.mjs`

- [ ] **Step 1: Add the decorative background video as the first child of `.stage`**

```html
<video class="stage-video" aria-hidden="true" tabindex="-1" muted autoplay loop playsinline preload="metadata" poster="/assets/alpine-runner.jpg">
  <source src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260521_014404_fadafdb1-4df6-4699-be9c-77d25f39a3d0.mp4" type="video/mp4">
</video>
```

- [ ] **Step 2: Add the video layer and reduce the global contrast overlay**

```css
.stage { overflow: hidden; }
.stage-video {
  position: fixed;
  inset: 0;
  z-index: -2;
  width: 100vw;
  height: 100svh;
  object-fit: cover;
  object-position: 50% 50%;
  pointer-events: none;
  background: #171a14 url('/assets/alpine-runner.jpg') center/cover no-repeat;
}
.stage:before {
  background:
    linear-gradient(90deg, rgba(3,5,3,.68), rgba(3,5,3,.22) 48%, rgba(3,5,3,.55)),
    linear-gradient(0deg, rgba(2,3,2,.52), transparent 58%);
}
```

- [ ] **Step 3: Apply the dark frosted-glass login treatment**

```css
.login-card {
  position: relative;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.18);
  background: linear-gradient(145deg, rgba(21,26,21,.70), rgba(5,8,6,.52));
  box-shadow: inset 0 1px 0 rgba(255,255,255,.16), 0 38px 90px rgba(0,0,0,.50);
  backdrop-filter: blur(30px) saturate(132%);
  -webkit-backdrop-filter: blur(30px) saturate(132%);
}
.login-card input {
  border-color: rgba(255,255,255,.17);
  background: rgba(255,255,255,.075);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.055);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
```

- [ ] **Step 4: Add mobile focal positioning, lower-cost mobile blur, and reduced-motion fallback**

```css
@media (max-width:760px) {
  .stage-video { object-position: 58% 50%; }
  .login-card {
    backdrop-filter: blur(20px) saturate(120%);
    -webkit-backdrop-filter: blur(20px) saturate(120%);
  }
}
@media (prefers-reduced-motion:reduce) {
  .stage-video { display: none; }
}
```

- [ ] **Step 5: Run the focused test and verify it passes**

Run: `node --test tests/visual-background.test.mjs`

Expected: 2 tests pass.

- [ ] **Step 6: Commit the implementation**

```bash
git add public/index.html public/styles.css
git commit -m "feat: add motion background and frosted login"
```

### Task 3: Verify the complete application

**Files:**
- Verify: `public/index.html`
- Verify: `public/styles.css`
- Verify: `dist/client/index.html`
- Verify: `dist/client/styles.css`

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: all tests pass, including the two new visual tests.

- [ ] **Step 2: Build the production bundle**

Run: `npm run build`

Expected: exit code 0 and updated `dist/client` plus `dist/server/site-assets.js`.

- [ ] **Step 3: Verify generated output contains the new media contract**

Run: `rg -n "stage-video|hf_20260521_014404|backdrop-filter" dist/client/index.html dist/client/styles.css dist/server/site-assets.js`

Expected: all three generated outputs contain the relevant video or frosted-glass rules.

- [ ] **Step 4: Review the final diff and commit generated output**

```bash
git diff --check
git status --short
git add dist
git commit -m "build: update motion background bundle"
```

### Task 4: Publish and verify the private Site

**Files:**
- Read: `.openai/hosting.json`
- Package: committed repository state at `HEAD`

- [ ] **Step 1: Open the existing Site through the Sites hosting workflow**

Confirm the registered project remains `appgprj_6ab47eea36f88191a54f7310abe42c68` and retain its existing private access policy.

- [ ] **Step 2: Create and deploy a version from the exact committed `HEAD`**

Run: `git rev-parse HEAD`

Expected: one immutable commit SHA used for both the source push and deployment archive.

- [ ] **Step 3: Wait for terminal deployment status**

Expected: deployment status `succeeded`; do not report completion while status is queued or building.

- [ ] **Step 4: Check the live Site and recent worker errors**

Expected: Site remains active and private, and recent worker errors contain no new entry caused by this release.

