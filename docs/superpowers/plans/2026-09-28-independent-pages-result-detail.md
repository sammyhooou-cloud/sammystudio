# Independent Login, Workspace, and Result Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the combined login/workspace document with authenticated standalone pages and give every persisted video task a stable, project-scoped detail page.

**Architecture:** The Worker will distinguish JSON API routes from session-aware HTML document routes. Three independent entry documents will load focused client modules, while a small shared task-presentation module will keep task status and video URL interpretation consistent between the workspace and result page. A project-owned read-only task endpoint will provide a sanitized detail DTO without exposing provider secrets.

**Tech Stack:** Cloudflare Worker-style Fetch API, D1-compatible SQL, vanilla ES modules, HTML/CSS, Node.js test runner, custom static-asset build script.

---

## File structure

- Create `public/login.html`: standalone login document and decorative MotionSites background.
- Create `public/login.js`: session check, password visibility, and login submission only.
- Create `public/workspace.html`: current project and generation workspace without login markup.
- Delete `public/index.html`: remove the obsolete combined login/workspace document after the split.
- Modify `public/app.js`: workspace boot only, task list navigation, and logout redirect.
- Create `public/result.html`: standalone task result document.
- Create `public/result.js`: route parsing, task detail loading, safe state rendering, and return navigation.
- Create `public/task-presenter.js`: shared status normalization, request parsing, progress extraction, and safe video URL extraction.
- Create `public/result-detail.css`: result-page layout and fixed centered progress presentation.
- Modify `public/styles.css`: page-specific background/glass selectors and shared screen-reader/error utilities.
- Modify `public/task-history.css`: orderly all-status task list and explicit detail actions.
- Modify `src/tasks.js`: project-owned sanitized task-detail reader.
- Modify `src/worker.js`: detail API, session-aware document routing, and OAuth destination.
- Modify `scripts/build.mjs`: fingerprint all entry modules and embed all three documents and shared assets.
- Modify `tests/tasks.test.mjs`: detail DTO and ownership coverage.
- Modify `tests/router.test.mjs`: document routing, redirects, OAuth destination, and detail API coverage.
- Modify `tests/release.test.mjs`: multi-page build and module-graph coverage.
- Modify `tests/ui-state.test.mjs`: shared presenter and task-detail-link behavior.
- Create `tests/page-isolation.test.mjs`: structural separation of login, workspace, and result documents.

### Task 1: Add the sanitized task-detail data boundary

**Files:**
- Modify: `src/tasks.js`
- Test: `tests/tasks.test.mjs`

- [ ] **Step 1: Write failing ownership and sanitization tests**

Append tests that construct a task containing `idempotency_key`, `request_json`, and `result_json`, then assert the returned DTO is exactly:

```js
{
  id: 'task-1',
  projectId: 'project-1',
  projectName: '项目一',
  remoteId: 'remote-1',
  mode: 'text',
  status: 'succeeded',
  request: {
    prompt: '山间奔跑',
    model: 'kling-v1',
    duration: '5',
    resolution: '720p',
    aspectRatio: '16:9',
  },
  resultJson: '{"videoUrl":"https://cdn.test/task-1.mp4"}',
  createdAt: 10,
  updatedAt: 20,
}
```

Also assert a mismatched project rejects with `TaskError` status `404`, malformed `request_json` becomes an empty request object, and no `idempotency_key` property is present.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --test tests/tasks.test.mjs`

Expected: FAIL because `getTaskDetail` is not exported.

- [ ] **Step 3: Implement the minimal project-owned reader**

Add this public function to `src/tasks.js`:

```js
export async function getTaskDetail(id, projectId, env) {
  if (!id || !projectId) throw new TaskError('任务参数无效', 400);
  const task = await env.DB.prepare(`SELECT video_tasks.id, video_tasks.remote_id, video_tasks.mode,
      video_tasks.status, video_tasks.request_json, video_tasks.result_json,
      video_tasks.created_at, video_tasks.updated_at, projects.name AS project_name
    FROM video_tasks
    JOIN project_tasks ON project_tasks.task_id = video_tasks.id
    JOIN projects ON projects.id = project_tasks.project_id
    WHERE video_tasks.id = ? AND project_tasks.project_id = ?`).bind(id, projectId).first();
  if (!task) throw new TaskError('任务不存在', 404);
  let request = {};
  try { request = JSON.parse(task.request_json || '{}'); } catch {}
  const safeRequest = Object.fromEntries(['prompt', 'model', 'duration', 'resolution', 'aspectRatio']
    .filter((key) => request[key] !== undefined)
    .map((key) => [key, request[key]]));
  return {
    id: task.id,
    projectId,
    projectName: task.project_name,
    remoteId: task.remote_id || null,
    mode: task.mode,
    status: task.status,
    request: safeRequest,
    resultJson: task.result_json || null,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}
```

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/tasks.test.mjs`

Expected: all task tests PASS.

- [ ] **Step 5: Commit the data boundary**

```bash
git add src/tasks.js tests/tasks.test.mjs
git commit -m "feat: expose sanitized project task detail"
```

### Task 2: Add authenticated document routing and the detail API

**Files:**
- Modify: `src/worker.js`
- Test: `tests/router.test.mjs`

- [ ] **Step 1: Write failing route tests**

Add tests for these exact outcomes:

```js
// anonymous HTML navigation
assert.equal(response.status, 302);
assert.equal(response.headers.get('location'), 'https://site.test/login');

// authenticated root and login navigation
assert.equal(response.headers.get('location'), 'https://site.test/workspace');

// API auth remains JSON
assert.equal(response.status, 401);
assert.match(response.headers.get('content-type'), /application\/json/);

// project-owned task detail
assert.equal(detail.status, 200);
assert.equal((await detail.json()).projectId, 'project-1');
```

Cover `/`, `/login`, `/workspace`, `/projects/project-1/results/task-1`, and `GET /api/projects/project-1/tasks/task-1`. Extend the test DB only with the SQL branches used by the new joined task query.

- [ ] **Step 2: Run route tests and verify failure**

Run: `node --test tests/router.test.mjs`

Expected: FAIL because all non-API requests still use the old static-asset lookup.

- [ ] **Step 3: Implement document routing**

Import `getTaskDetail`, add a document helper, and route documents before generic static assets:

```js
async function documentResponse(request, env) {
  const url = new URL(request.url);
  const session = await requireSession(request, env);
  if (url.pathname === '/') return Response.redirect(`${url.origin}${session ? '/workspace' : '/login'}`, 302);
  if (url.pathname === '/login') {
    if (session) return Response.redirect(`${url.origin}/workspace`, 302);
    return siteAsset('/login.html');
  }
  if (url.pathname === '/workspace') {
    if (!session) return Response.redirect(`${url.origin}/login`, 302);
    return siteAsset('/workspace.html');
  }
  if (/^\/projects\/[^/]+\/results\/[^/]+$/.test(url.pathname)) {
    if (!session) return Response.redirect(`${url.origin}/login`, 302);
    return siteAsset('/result.html');
  }
  return null;
}
```

Only use this helper for `GET` and `HEAD` document requests; CSS, JS, images, and unrecognized paths continue through `siteAsset()` and the optional asset binding.

- [ ] **Step 4: Implement the read-only detail route and OAuth redirect**

Add this API route before the legacy `/api/video/tasks/:id` matcher:

```js
const taskDetailMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)$/);
if (taskDetailMatch && request.method === 'GET') {
  const projectId = decodeProjectId(taskDetailMatch[1]);
  const taskId = decodeProjectId(taskDetailMatch[2]);
  if (!projectId || !taskId) return json({ error: '任务参数无效' }, 400);
  try { return json(await getTaskDetail(taskId, projectId, env)); }
  catch (error) {
    if (error instanceof TaskError) return json({ error: error.message }, error.status);
    return json({ error: '任务详情暂不可用' }, 503);
  }
}
```

Change OAuth completion destinations to `/workspace?authorized=1` and `/workspace?oauth_error=1`.

- [ ] **Step 5: Run route tests**

Run: `node --test tests/router.test.mjs`

Expected: all route tests PASS.

- [ ] **Step 6: Commit routing**

```bash
git add src/worker.js tests/router.test.mjs
git commit -m "feat: route independent authenticated pages"
```

### Task 3: Extract shared task presentation rules

**Files:**
- Create: `public/task-presenter.js`
- Modify: `public/app.js`
- Modify: `tests/ui-state.test.mjs`

- [ ] **Step 1: Write failing shared-module tests**

Move the existing status, progress, and playable-video assertions to import these named exports from `public/task-presenter.js`:

```js
import {
  normalizeTaskStatus,
  parseTaskRequest,
  safeVideoUrl,
  taskProgress,
  taskDetailHref,
} from '../public/task-presenter.js';
```

Add these cases:

```js
assert.equal(taskDetailHref('project a', 'task/1'), '/projects/project%20a/results/task%2F1');
assert.equal(taskProgress({ resultJson: '{"data":{"progress":42}}' }), 42);
assert.equal(taskProgress({ resultJson: '{}' }), null);
assert.equal(safeVideoUrl('{"videoUrl":"javascript:alert(1)"}'), '');
assert.deepEqual(parseTaskRequest('{broken'), {});
```

- [ ] **Step 2: Run UI state tests and verify failure**

Run: `node --test tests/ui-state.test.mjs`

Expected: FAIL because the shared module does not exist.

- [ ] **Step 3: Create the focused shared module**

Move the already-tested pure parsing logic out of `public/app.js`. Keep DOM access out of the new file. Add the deterministic link helper:

```js
export function taskDetailHref(projectId, taskId) {
  return `/projects/${encodeURIComponent(projectId)}/results/${encodeURIComponent(taskId)}`;
}

export function parseTaskRequest(value) {
  if (!value) return {};
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch { return {}; }
}
```

Use HTTPS-only validation for video URLs and clamp provider progress to integer `0..100`; return `null` when no provider progress exists.

- [ ] **Step 4: Update workspace imports without changing behavior**

Import the shared functions in `public/app.js`, remove only the duplicate implementations, and retain the existing exported workspace helpers required by tests.

- [ ] **Step 5: Run UI tests**

Run: `node --test tests/ui-state.test.mjs tests/result-stage.test.mjs`

Expected: all selected tests PASS.

- [ ] **Step 6: Commit the shared rules**

```bash
git add public/task-presenter.js public/app.js tests/ui-state.test.mjs
git commit -m "refactor: share task presentation rules"
```

### Task 4: Split login and workspace into independent pages

**Files:**
- Create: `public/login.html`
- Create: `public/login.js`
- Create: `public/workspace.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `tests/page-isolation.test.mjs`

- [ ] **Step 1: Write failing page-isolation tests**

Read the three source HTML files and assert:

```js
assert.match(login, /id="login-form"/);
assert.doesNotMatch(login, /id="generator-form"/);
assert.match(workspace, /id="generator-form"/);
assert.doesNotMatch(workspace, /id="login-form"/);
```

Also assert the decorative video has `muted autoplay loop playsinline`, no controls, a poster, and the approved MotionSites source URL wherever the background component is present.

- [ ] **Step 2: Run isolation tests and verify failure**

Run: `node --test tests/page-isolation.test.mjs`

Expected: FAIL because the independent documents do not exist.

- [ ] **Step 3: Create `login.html` and `login.js`**

Move only the background, masthead, and login card markup into `login.html`. In `login.js`, implement:

```js
const form = document.querySelector('#login-form');
document.querySelector('#password-toggle').onclick = () => {
  const input = document.querySelector('#password');
  input.type = input.type === 'password' ? 'text' : 'password';
};
form.onsubmit = async (event) => {
  event.preventDefault();
  const errorNode = document.querySelector('#login-error');
  errorNode.textContent = '';
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: document.querySelector('#username').value,
      password: document.querySelector('#password').value,
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorNode.textContent = body.error || '登录失败';
    return;
  }
  location.replace('/workspace');
};
```

- [ ] **Step 4: Create `workspace.html` and make `app.js` workspace-only**

Move the existing workspace markup into `workspace.html`, then delete the obsolete combined `public/index.html`. Remove `loginView`, `loginForm`, `enterWorkspace()`, the client-side session probe, password handlers, and login submission from `app.js`. Call the existing retryable workspace loader directly during setup. Change logout success to:

```js
await request('/api/session', { method: 'DELETE' });
location.replace('/login');
```

- [ ] **Step 5: Preserve or safely adjust the background**

Keep the authorized MotionSites video as a decorative `muted autoplay loop playsinline` layer with the existing poster. Scope overlays separately:

```css
.login-page .stage::before{background:linear-gradient(90deg,rgba(2,3,2,.72),rgba(2,3,2,.34)),linear-gradient(0deg,rgba(2,3,2,.58),transparent 62%)}
.workspace-page .stage::before{background:linear-gradient(90deg,rgba(2,4,2,.84),rgba(2,4,2,.48) 48%,rgba(2,4,2,.76)),linear-gradient(0deg,rgba(2,3,2,.7),transparent 58%)}
.login-card{background:rgba(3,5,4,.7);border:1px solid rgba(255,255,255,.14);box-shadow:0 36px 90px rgba(0,0,0,.56);backdrop-filter:blur(28px) saturate(118%)}
```

If autoplay is unavailable, the existing poster remains a complete background. Do not replace the licensed source unless it causes an actual compatibility failure in desktop or mobile verification.

- [ ] **Step 6: Run page and UI tests**

Run: `node --test tests/page-isolation.test.mjs tests/ui-state.test.mjs tests/visual-background.test.mjs`

Expected: all selected tests PASS.

- [ ] **Step 7: Commit the split pages**

```bash
git add public/index.html public/login.html public/login.js public/workspace.html public/app.js public/styles.css tests/page-isolation.test.mjs
git commit -m "feat: split login from video workspace"
```

### Task 5: Rebuild the workspace task list and detail navigation

**Files:**
- Modify: `public/workspace.html`
- Modify: `public/app.js`
- Modify: `public/task-history.css`
- Modify: `tests/ui-state.test.mjs`

- [ ] **Step 1: Write failing task-row tests**

Test a pure `taskListItemModel(task, projectId)` helper for active, succeeded, failed, and unknown tasks. Expected completed output includes:

```js
{
  label: '已完成',
  action: '查看结果',
  href: '/projects/project-1/results/task-1',
  tone: 'success',
}
```

Active output must use `action: '生成中'` with an empty `href`; failed and unknown output must use `action: '查看详情'` with a detail URL.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/ui-state.test.mjs`

Expected: FAIL because `taskListItemModel` does not exist.

- [ ] **Step 3: Implement the pure task-row model and all-status history rendering**

Build task rows from the complete `projectTasks` collection instead of only completed clips. Render text with `textContent`; render navigation as a same-origin anchor only when `href` is non-empty. Keep the existing current-stage selection logic separate from task detail navigation.

- [ ] **Step 4: Stabilize layout and state hierarchy**

Use a vertical list with fixed action width and no absolute positioning:

```css
.task-history{display:grid;gap:10px}
.task-history-item{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:18px;min-height:66px}
.task-history-copy{min-width:0}
.task-history-action{min-width:92px;text-align:right}
.task-history-item[data-tone="active"] .task-history-status{color:var(--acid)}
.task-history-item[data-tone="failure"] .task-history-status{color:#ff8d82}
```

Rename the section label from “已完成片段” to “任务记录”. Keep the current task stage centered and fixed; list growth must only extend below the stage.

- [ ] **Step 5: Run UI tests**

Run: `node --test tests/ui-state.test.mjs tests/result-stage.test.mjs`

Expected: all selected tests PASS.

- [ ] **Step 6: Commit workspace task presentation**

```bash
git add public/workspace.html public/app.js public/task-history.css tests/ui-state.test.mjs
git commit -m "feat: organize workspace task records"
```

### Task 6: Build the independent result detail page

**Files:**
- Create: `public/result.html`
- Create: `public/result.js`
- Create: `public/result-detail.css`
- Modify: `tests/page-isolation.test.mjs`
- Modify: `tests/ui-state.test.mjs`

- [ ] **Step 1: Write failing result-state tests**

Test a pure `resultViewModel(detail)` export for:

```js
assert.equal(resultViewModel({ status: 'generating', resultJson: '{}' }).kind, 'active');
assert.deepEqual(resultViewModel({ status: 'generating', resultJson: '{"progress":35}' }).progress, 35);
assert.equal(resultViewModel({ status: 'succeeded', resultJson: '{"videoUrl":"https://cdn.test/a.mp4"}' }).kind, 'video');
assert.equal(resultViewModel({ status: 'succeeded', resultJson: '{}' }).kind, 'unavailable');
assert.equal(resultViewModel({ status: 'failed', resultJson: '{}' }).kind, 'failed');
```

Test route parsing with encoded identifiers and reject any path that does not exactly match `/projects/:projectId/results/:taskId`.

Extend `tests/page-isolation.test.mjs` with:

```js
assert.match(result, /id="result-detail"/);
assert.doesNotMatch(result, /id="generator-form"|id="login-form"/);
```

- [ ] **Step 2: Run result tests and verify failure**

Run: `node --test tests/ui-state.test.mjs tests/page-isolation.test.mjs`

Expected: FAIL because the result module and document do not exist.

- [ ] **Step 3: Create the result document and safe renderer**

The document contains `#result-detail`, `#result-player`, `#result-progress`, `#result-terminal`, `#result-meta`, `#result-error`, and `#back-to-workspace`. The script:

1. Parses the project and task identifiers from `location.pathname`.
2. Fetches `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`.
3. Redirects to `/login` only on `401`.
4. Renders all task text via `textContent`.
5. Assigns the video `src` only after `safeVideoUrl()` returns an HTTPS URL.
6. Uses a fixed centered gradient animation and “生成中” for active states.
7. Displays percentage only when `taskProgress()` returns a real number.
8. Displays explicit terminal messages for failed, unknown, missing, and succeeded-without-video states.

- [ ] **Step 4: Render metadata and return navigation**

Map the sanitized DTO to labels without raw JSON:

```js
const fields = [
  ['生成模式', detail.mode === 'image' ? '图生视频' : '文生视频'],
  ['模型', detail.request.model || '—'],
  ['分辨率', detail.request.resolution || '—'],
  ['时长', detail.request.duration ? `${detail.request.duration} 秒` : '—'],
  ['画幅', detail.request.aspectRatio || '—'],
  ['创建时间', formatDate(detail.createdAt)],
  ['更新时间', formatDate(detail.updatedAt)],
];
```

Set the return link to `/workspace?project=${encodeURIComponent(detail.projectId)}` and let workspace startup select that owned project when present.

- [ ] **Step 5: Add responsive result-page styling**

Use a centered content width, a stable `aspect-ratio:16/9` media stage, a two-column metadata grid on desktop, and one column below `720px`. Keep the same authorized background and use an overlay only where content requires contrast.

- [ ] **Step 6: Run result and isolation tests**

Run: `node --test tests/ui-state.test.mjs tests/page-isolation.test.mjs`

Expected: all selected tests PASS.

- [ ] **Step 7: Commit the result page**

```bash
git add public/result.html public/result.js public/result-detail.css public/app.js tests/page-isolation.test.mjs tests/ui-state.test.mjs
git commit -m "feat: add video task result pages"
```

### Task 7: Package the multi-page client

**Files:**
- Modify: `scripts/build.mjs`
- Modify: `tests/release.test.mjs`

- [ ] **Step 1: Write failing production-build tests**

Assert production output contains `login.html`, `workspace.html`, and `result.html`; each document references its own fingerprinted entry script; both workspace and result scripts reference one fingerprinted `task-presenter` module; and every generated route is present in `dist/server/site-assets.js`.

- [ ] **Step 2: Run release tests and verify failure**

Run: `node --test tests/release.test.mjs`

Expected: FAIL because the build fingerprints only `app.js` and `image-preview.js`.

- [ ] **Step 3: Extend the explicit module graph build**

Read and hash `image-preview.js` and `task-presenter.js` first. Rewrite those imports in `app.js` and `result.js`, hash the rewritten entries, then replace source script paths in their corresponding HTML files. Embed these stable documents:

```js
['/login.html', 'dist/client/login.html', 'text/html; charset=utf-8', false, false],
['/workspace.html', 'dist/client/workspace.html', 'text/html; charset=utf-8', false, false],
['/result.html', 'dist/client/result.html', 'text/html; charset=utf-8', false, false],
```

Embed fingerprinted `login`, `app`, `result`, `image-preview`, and `task-presenter` scripts as immutable assets. Continue embedding CSS and the poster as revalidated or binary assets as appropriate.

- [ ] **Step 4: Run release tests and build**

Run: `node --test tests/release.test.mjs && npm run build`

Expected: release tests PASS and build exits `0`.

- [ ] **Step 5: Commit packaging changes**

```bash
git add scripts/build.mjs tests/release.test.mjs dist
git commit -m "build: package independent application pages"
```

### Task 8: Full verification and browser acceptance

**Files:**
- Modify only files required by defects found during verification.

- [ ] **Step 1: Run the complete automated suite**

Run: `npm test`

Expected: all tests PASS with zero failures, skips, or cancellations.

- [ ] **Step 2: Run the production build from a clean output directory**

Run: `npm run build`

Expected: command exits `0`; `dist/client` contains all three documents and their fingerprinted modules.

- [ ] **Step 3: Verify desktop behavior**

Check these exact flows in the local preview:

1. Anonymous `/` redirects to `/login`.
2. Login card is a deep-black frosted glass surface over the looping background.
3. Login success navigates to `/workspace` with no login markup present.
4. Project create, select, rename, and image upload still work.
5. A generated task has a fixed centered progress state with no fabricated percentage.
6. A completed task moves into “任务记录” and exposes “查看结果”.
7. The detail page plays the result and shows sanitized metadata.
8. Logout returns to `/login`; protected deep links redirect to login.

- [ ] **Step 4: Verify mobile behavior**

At a viewport no wider than `430px`, confirm the login card, project drawer, generation form, fixed result stage, task list, result video, and metadata do not overflow horizontally. Confirm the background remains cover-fitted and the subject motion remains useful; adjust only `object-position` and overlay opacity if needed.

- [ ] **Step 5: Commit verification fixes, if any**

```bash
git add public src tests scripts dist
git commit -m "fix: complete independent page acceptance"
```

If verification produces no source changes, do not create an empty commit.

### Task 9: Publish only the verified build

**Files:**
- No source changes expected.

- [ ] **Step 1: Confirm the branch is clean and record the release commit**

Run: `git status --short && git log -1 --oneline`

Expected: empty status output followed by the verified release commit.

- [ ] **Step 2: Publish the verified `dist` artifact through Sites**

Use the existing Sites project `appgprj_6ab47eea36f88191a54f7310abe42c68`. Do not publish an earlier intermediate build. Preserve public access.

- [ ] **Step 3: Verify the live deployment**

Open `https://keling-workspace-login.sammyhooou.chatgpt.site/` in a fresh unauthenticated context and repeat the route, login, workspace, task-list, result-detail, and logout smoke checks. Report the deployed version and any live-only difference.
