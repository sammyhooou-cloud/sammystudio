# Fixed Generation Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the deep-black frosted login card and make the video result area a fixed stage where active generation, completed video, and completed-history states never overlap or drift.

**Architecture:** Keep the existing static client and Worker APIs. Add pure task-presentation helpers in `public/app.js`, render mutually exclusive layers inside a stable `result-stage`, and filter the lower history to successful playable videos only. CSS owns fixed positioning and non-translating gradient animation; JavaScript only switches state and media.

**Tech Stack:** Browser ES modules, semantic HTML, CSS, Node.js built-in test runner, existing Cloudflare Worker build and Sites hosting flow.

---

### Task 1: Task presentation state

**Files:**
- Modify: `tests/ui-state.test.mjs`
- Modify: `public/app.js`

- [ ] **Step 1: Write failing tests for active, completed, and real-progress state**

Import `taskPresentationState` and add tests equivalent to:

```js
test('active task owns the stage while older playable successes remain completed clips', () => {
  const state = taskPresentationState([
    { id: 'new', status: 'generating', resultJson: '{"status":"PROCESSING"}' },
    { id: 'old', status: 'succeeded', resultJson: '{"works":[{"contentType":"video","url":"https://cdn.test/old.mp4"}]}' },
  ]);
  assert.equal(state.current.id, 'new');
  assert.equal(state.kind, 'active');
  assert.equal(state.progress, null);
  assert.deepEqual(state.completed.map(({ task }) => task.id), ['old']);
});

test('only explicit provider progress is displayed and completed video becomes current', () => {
  const active = taskPresentationState([{ id: 'a', status: 'generating', resultJson: '{"data":{"progress":42}}' }]);
  assert.equal(active.progress, 42);
  const complete = taskPresentationState([{ id: 'b', status: 'succeeded', resultJson: '{"videoUrl":"https://cdn.test/b.mp4"}' }]);
  assert.equal(complete.kind, 'video');
  assert.equal(complete.videoUrl, 'https://cdn.test/b.mp4');
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/ui-state.test.mjs`

Expected: FAIL because `taskPresentationState` is not exported.

- [ ] **Step 3: Implement the minimal pure presentation helpers**

In `public/app.js`, add a safe JSON reader, explicit percentage extraction, completed-video filtering, and selection logic:

```js
const ACTIVE_TASK_STATUSES = new Set(['submitting', 'queued', 'generating']);
const SUCCESS_TASK_STATUSES = new Set(['succeeded', 'success', 'done', 'completed']);

function taskResult(task) {
  try { return task?.resultJson ? JSON.parse(task.resultJson) : null; } catch { return null; }
}

export function extractTaskProgress(result) {
  const raw = result?.progress ?? result?.percentage ?? result?.percent
    ?? result?.data?.progress ?? result?.data?.percentage ?? result?.data?.percent;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;
}

export function taskPresentationState(tasks = [], selectedTaskId = '') {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const completed = safeTasks.flatMap((task) => {
    const videoUrl = extractVideoUrl(taskResult(task));
    return SUCCESS_TASK_STATUSES.has(String(task.status || '').toLowerCase()) && videoUrl ? [{ task, videoUrl }] : [];
  });
  const current = safeTasks.find(({ id }) => id === selectedTaskId) || safeTasks[0] || null;
  const result = taskResult(current);
  const videoUrl = extractVideoUrl(result);
  const status = String(current?.status || '').toLowerCase();
  const kind = !current ? 'empty' : ACTIVE_TASK_STATUSES.has(status) ? 'active' : videoUrl ? 'video' : 'terminal';
  return { tasks: safeTasks, current, kind, videoUrl, progress: kind === 'active' ? extractTaskProgress(result) : null, completed };
}
```

- [ ] **Step 4: Run focused and full tests and verify GREEN**

Run: `node --test tests/ui-state.test.mjs`

Expected: all focused tests pass.

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 5: Commit**

```bash
git add public/app.js tests/ui-state.test.mjs
git commit -m "feat: model fixed generation stage state"
```

### Task 2: Fixed result stage and completed clip list

**Files:**
- Create: `tests/result-stage.test.mjs`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `public/task-history.css`

- [ ] **Step 1: Write failing structural and CSS tests**

Create `tests/result-stage.test.mjs` that reads the public assets and asserts:

```js
assert.match(html, /id="result-stage" class="result-stage"/);
assert.match(html, /id="task-progress"[^>]*hidden/);
assert.match(html, /id="result-terminal"[^>]*hidden/);
assert.match(css, /\.result-stage\{[^}]*position:relative/);
assert.match(css, /\.result-layer\{[^}]*position:absolute[^}]*inset:0[^}]*place-content:center/);
assert.match(css, /@keyframesgeneration-glow\{[^}]*opacity:/);
assert.doesNotMatch(css, /@keyframesgeneration-glow\{[^}]*translate/);
```

Also assert the history heading is `已完成片段` and the legacy translating progress animation is absent.

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test tests/result-stage.test.mjs`

Expected: FAIL because the stable stage markup and CSS do not exist.

- [ ] **Step 3: Add mutually exclusive stage layers**

Replace the current result body in `public/index.html` with this structure while preserving the header:

```html
<div id="result-stage" class="result-stage">
  <div id="result-empty" class="result-layer empty"><b>◌</b><p>设置参数并提交后，任务进度与视频将在这里出现。</p></div>
  <div id="result-progress" class="result-layer generation-state" hidden>
    <div class="generation-glow" aria-hidden="true"><i></i></div>
    <h3>生成中</h3>
    <p id="task-progress" class="task-progress" hidden></p>
    <p id="task-id"></p>
  </div>
  <div id="result-terminal" class="result-layer terminal-state" hidden><h3 id="terminal-title"></h3><p id="terminal-copy"></p></div>
  <video id="result-video" controls hidden></video>
</div>
<div id="task-history-wrap" class="task-history-wrap" hidden><p class="eyebrow">已完成片段</p><div id="task-history" class="task-history"></div></div>
```

- [ ] **Step 4: Render only the selected stage state and playable history**

Update `renderTasks()` to call `taskPresentationState(projectTasks, selectedTaskId)`, build history buttons only from `state.completed`, hide the history wrapper when empty, and call a single `renderSelectedTask(state)` path.

Update the selected-state renderer so it first hides all stage layers and clears video, then shows exactly one state:

```js
empty.hidden = state.kind !== 'empty';
progress.hidden = state.kind !== 'active';
terminal.hidden = state.kind !== 'terminal';
progressText.hidden = state.progress === null;
progressText.textContent = state.progress === null ? '' : `${state.progress}%`;
if (state.kind === 'video') {
  video.src = state.videoUrl;
  video.hidden = false;
}
```

Set user-facing status text to `生成中`, `已完成`, `生成失败`, or `状态待核对`. A selected completed history item must never show the progress layer.

- [ ] **Step 5: Fix the stage position and use non-drifting gradient motion**

In `public/styles.css` and `public/task-history.css`:

```css
.result-stage { position:relative; min-height:390px; overflow:hidden; border-radius:16px; }
.result-layer { position:absolute; inset:0; display:grid; place-content:center; justify-items:center; text-align:center; }
.result-stage video { position:absolute; inset:0; width:100%; height:100%; margin:0; object-fit:contain; border-radius:16px; background:#030503; }
.generation-glow { width:96px; height:96px; border-radius:50%; padding:2px; background:conic-gradient(from 0deg,var(--acid),rgba(200,255,120,.08),var(--acid)); animation:generation-spin 2.4s linear infinite; }
.generation-glow i { display:block; width:100%; height:100%; border-radius:inherit; background:#090c09; }
@keyframes generation-spin { to { rotate:1turn; } }
@keyframes generation-glow { 50% { opacity:.62; } }
```

No stage animation may modify layout position or translate the progress container. Preserve a static visible state under reduced-motion preferences.

- [ ] **Step 6: Run focused and full tests and verify GREEN**

Run: `node --test tests/result-stage.test.mjs tests/ui-state.test.mjs`

Expected: all focused tests pass.

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/app.js public/styles.css public/task-history.css tests/result-stage.test.mjs
git commit -m "feat: anchor video generation stage"
```

### Task 3: Deep-black frosted login restoration

**Files:**
- Modify: `tests/visual-background.test.mjs`
- Modify: `public/styles.css`

- [ ] **Step 1: Tighten the login visual regression test**

Add assertions that the card uses a near-black translucent gradient, at least `28px` blur, border highlight and inset shadow, while no login-card or login-wrap animation references a translating or floating keyframe.

- [ ] **Step 2: Run the visual test and verify RED**

Run: `node --test tests/visual-background.test.mjs`

Expected: FAIL because the current card does not meet the restored deep-black token values.

- [ ] **Step 3: Apply the restored glass tokens without a device frame**

Update only the login card and its fields:

```css
.login-card {
  border:1px solid rgba(255,255,255,.16);
  background:linear-gradient(145deg,rgba(10,13,10,.90),rgba(2,4,3,.82));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.13),0 38px 100px rgba(0,0,0,.66);
  backdrop-filter:blur(30px) saturate(126%);
  -webkit-backdrop-filter:blur(30px) saturate(126%);
}
```

Keep the current rounded login card, background video and borderless page. Do not add an outer phone shell or a floating transform animation.

- [ ] **Step 4: Run visual and full tests and verify GREEN**

Run: `node --test tests/visual-background.test.mjs tests/result-stage.test.mjs`

Expected: all focused tests pass.

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 5: Commit**

```bash
git add public/styles.css tests/visual-background.test.mjs
git commit -m "style: restore deep black frosted login"
```

### Task 4: Build, review, and publish

**Files:**
- Generated: `dist/**`
- Verify: `.openai/hosting.json`

- [ ] **Step 1: Run the complete verification suite**

Run: `npm test`

Expected: all tests pass with zero failures.

Run: `npm run build`

Expected: exit code `0` and fingerprinted client assets are produced.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 2: Request focused code review**

Provide the reviewer the design spec, this plan, base commit `910a063b1b8044fbab012537cdb8edd162cbad8e`, and the implementation HEAD. Fix every Critical or Important issue, then rerun `npm test` and `npm run build`.

- [ ] **Step 3: Commit the verified build output**

```bash
git add dist
git commit -m "build: package fixed generation stage"
```

- [ ] **Step 4: Publish the exact verified commit**

Push the branch with a short-lived Sites repository credential, save a new Site version from the exact pushed commit, deploy that saved version, and wait for terminal deployment status. Preserve the existing `public` site access mode.

- [ ] **Step 5: Verify production**

Confirm the Site reports `active`, the deployed version is current, access mode remains `public`, and recent Worker error logs contain no new deployment errors. Report the live URL and verification evidence.
