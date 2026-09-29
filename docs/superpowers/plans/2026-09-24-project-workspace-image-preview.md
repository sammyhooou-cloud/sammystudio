# 一级项目工作区与参考图预览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为可灵视频工作台增加一级项目管理，并让参考图上传后以自适应缩略图和完整文件信息显示。

**Architecture:** 使用 D1 的 `projects`、`project_assets`、`project_tasks` 和 `project_settings` 表隔离项目数据，避免对已有生产表执行不兼容的列变更。Worker 提供项目 CRUD 与工作区读取接口；前端以桌面侧栏/手机抽屉管理项目，并用独立的图片预览状态函数驱动上传反馈。

**Tech Stack:** Cloudflare Worker-compatible JavaScript、D1/SQLite、R2、原生 HTML/CSS/ES Modules、Node.js test runner、OpenAI Sites。

---

## 文件结构

- 创建 `src/projects.js`：项目验证、默认项目、列表、创建、重命名和工作区查询。
- 创建 `public/image-preview.js`：文件信息格式化和预览状态转换，保持 DOM 逻辑可测试。
- 创建 `tests/projects.test.mjs`：项目名称、默认项目和项目隔离行为测试。
- 创建 `tests/image-preview.test.mjs`：文件名、格式、大小和预览状态测试。
- 创建 `migrations/DB/0002_projects.sql`：项目及关联表。
- 修改 `src/db.js`：运行时幂等建表。
- 修改 `src/worker.js`：项目路由、上传归属和项目工作区接口。
- 修改 `src/tasks.js`：任务提交时验证并记录项目归属。
- 修改 `public/index.html`：项目侧栏、手机抽屉入口和图片预览结构。
- 修改 `public/app.js`：项目状态、切换、创建、重命名和上传预览交互。
- 修改 `public/styles.css`：项目导航与响应式图片预览。

### Task 1: 项目数据模型与默认项目

**Files:**
- Create: `migrations/DB/0002_projects.sql`
- Create: `src/projects.js`
- Modify: `src/db.js`
- Test: `tests/projects.test.mjs`

- [ ] **Step 1: 写项目名称与默认项目的失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjectName, ensureDefaultProject } from '../src/projects.js';

test('normalizes project names and rejects blanks', () => {
  assert.equal(normalizeProjectName('  新项目  '), '新项目');
  assert.throws(() => normalizeProjectName('   '), /项目名称不能为空/);
});

test('creates the uncategorized project only when none exists', async () => {
  const calls = [];
  const db = fakeDb({ first: null, calls });
  const project = await ensureDefaultProject(db, () => 'project-default', 1000);
  assert.equal(project.name, '未分类项目');
  assert.equal(calls.filter((sql) => sql.startsWith('INSERT INTO projects')).length, 1);
});
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `node --test tests/projects.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/projects.js`.

- [ ] **Step 3: 添加项目表与关联表**

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_assets (
  project_id TEXT NOT NULL,
  object_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, object_id)
);
CREATE INDEX IF NOT EXISTS idx_project_assets_project ON project_assets(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS project_tasks (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS project_settings (
  project_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

将相同的幂等 `CREATE TABLE/INDEX` 语句加入 `src/db.js` 的 `statements`。

- [ ] **Step 4: 实现名称规范化和默认项目**

```js
export function normalizeProjectName(value) {
  const name = String(value || '').trim();
  if (!name) throw new Error('项目名称不能为空');
  if (name.length > 60) throw new Error('项目名称不能超过 60 个字符');
  return name;
}

export async function ensureDefaultProject(db, idFactory = crypto.randomUUID, now = Date.now()) {
  const existing = await db.prepare('SELECT * FROM projects ORDER BY created_at ASC LIMIT 1').first();
  if (existing) return existing;
  const project = { id: idFactory(), name: '未分类项目', created_at: now, updated_at: now };
  await db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(project.id, project.name, now, now).run();
  await db.prepare('INSERT OR IGNORE INTO project_assets (project_id, object_id, created_at) SELECT ?, id, created_at FROM stored_objects')
    .bind(project.id).run();
  await db.prepare('INSERT OR IGNORE INTO project_tasks (project_id, task_id, created_at) SELECT ?, id, created_at FROM video_tasks')
    .bind(project.id).run();
  return project;
}
```

- [ ] **Step 5: 运行测试并提交**

Run: `node --test tests/projects.test.mjs && node --test tests/*.test.mjs`

Expected: all tests PASS.

```bash
git add migrations/DB/0002_projects.sql src/db.js src/projects.js tests/projects.test.mjs
git commit -m "feat: add project workspace data model"
```

### Task 2: 项目 API 与工作区读取

**Files:**
- Modify: `src/projects.js`
- Modify: `src/worker.js`
- Modify: `tests/router.test.mjs`
- Test: `tests/projects.test.mjs`

- [ ] **Step 1: 写项目创建、重命名和隔离查询的失败测试**

```js
test('workspace query scopes assets and tasks to one project', async () => {
  const workspace = await readProjectWorkspace(fakeWorkspaceDb(), 'project-a');
  assert.deepEqual(workspace.assets.map((item) => item.id), ['asset-a']);
  assert.deepEqual(workspace.tasks.map((item) => item.id), ['task-a']);
});

test('project routes require an authenticated session', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/projects'), envWithoutSession());
  assert.equal(response.status, 401);
});
```

- [ ] **Step 2: 运行测试并确认缺少项目 API**

Run: `node --test tests/projects.test.mjs tests/router.test.mjs`

Expected: FAIL because `readProjectWorkspace` and project routes are missing.

- [ ] **Step 3: 实现项目服务函数**

```js
export async function listProjects(db) {
  await ensureDefaultProject(db);
  return (await db.prepare('SELECT id, name, created_at, updated_at FROM projects ORDER BY updated_at DESC').all()).results;
}

export async function createProject(db, body) {
  const now = Date.now();
  const project = { id: crypto.randomUUID(), name: normalizeProjectName(body.name), createdAt: now, updatedAt: now };
  await db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(project.id, project.name, now, now).run();
  return project;
}

export async function renameProject(db, id, body) {
  const name = normalizeProjectName(body.name);
  const result = await db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').bind(name, Date.now(), id).run();
  if (!result.meta?.changes) throw new Error('项目不存在');
  return { id, name };
}
```

工作区查询通过 `project_assets`/`project_tasks` 关联现有表，并解析 `project_settings.settings_json`。

- [ ] **Step 4: 添加项目路由**

```js
if (url.pathname === '/api/projects' && request.method === 'GET')
  return json({ projects: await listProjects(env.DB) });
if (url.pathname === '/api/projects' && request.method === 'POST')
  return json(await createProject(env.DB, await request.json()), 201);
const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
if (projectMatch && request.method === 'PATCH')
  return json(await renameProject(env.DB, projectMatch[1], await request.json()));
const workspaceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/workspace$/);
if (workspaceMatch && request.method === 'GET')
  return json(await readProjectWorkspace(env.DB, workspaceMatch[1]));
```

- [ ] **Step 5: 运行全套测试并提交**

Run: `node --test tests/*.test.mjs`

Expected: all tests PASS.

```bash
git add src/projects.js src/worker.js tests/projects.test.mjs tests/router.test.mjs
git commit -m "feat: add project workspace APIs"
```

### Task 3: 上传与生成任务绑定项目

**Files:**
- Modify: `src/worker.js`
- Modify: `src/tasks.js`
- Modify: `tests/router.test.mjs`
- Test: `tests/projects.test.mjs`

- [ ] **Step 1: 写缺少或错误 projectId 的失败测试**

```js
test('upload rejects a missing project id', async () => {
  const response = await uploadRequest({ projectId: '' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /请选择项目/);
});

test('task records project ownership', async () => {
  const result = await submitTask(payload({ projectId: 'project-a' }), env, 'idem-1', models);
  assert.equal(env.recordedProjectTask.project_id, 'project-a');
});
```

- [ ] **Step 2: 运行测试并确认项目归属尚未写入**

Run: `node --test tests/projects.test.mjs tests/router.test.mjs`

Expected: FAIL because upload/task submission ignores `projectId`.

- [ ] **Step 3: 上传接口验证项目并保存关联**

```js
const projectId = String(form.get('projectId') || '');
const project = await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
if (!project) return json({ error: '请选择有效项目' }, 400);
// R2 和 stored_objects 写入成功后：
await env.DB.prepare('INSERT INTO project_assets (project_id, object_id, created_at) VALUES (?, ?, ?)')
  .bind(projectId, id, Date.now()).run();
```

- [ ] **Step 4: 任务接口验证项目并保存关联与参数快照**

```js
const project = await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(body.projectId).first();
if (!project) throw new Error('请选择有效项目');
await env.DB.prepare('INSERT INTO project_tasks (project_id, task_id, created_at) VALUES (?, ?, ?)')
  .bind(body.projectId, task.id, now).run();
await env.DB.prepare('INSERT INTO project_settings (project_id, settings_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at')
  .bind(body.projectId, JSON.stringify(body), now).run();
```

- [ ] **Step 5: 运行测试并提交**

Run: `node --test tests/*.test.mjs`

Expected: all tests PASS.

```bash
git add src/worker.js src/tasks.js tests/projects.test.mjs tests/router.test.mjs
git commit -m "feat: scope uploads and tasks to projects"
```

### Task 4: 图片预览状态与文件信息

**Files:**
- Create: `public/image-preview.js`
- Create: `tests/image-preview.test.mjs`
- Modify: `public/index.html`
- Modify: `public/app.js`

- [ ] **Step 1: 写文件信息和状态转换的失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, imagePreviewState } from '../public/image-preview.js';

test('formats uploaded image metadata', () => {
  assert.equal(formatBytes(1536000), '1.46 MB');
  assert.deepEqual(imagePreviewState({ name: 'runner.png', type: 'image/png', size: 1536000 }, 'blob:test', 'uploaded'), {
    src: 'blob:test', name: 'runner.png', format: 'PNG', size: '1.46 MB', status: '上传成功', canSubmit: true
  });
});
```

- [ ] **Step 2: 运行测试并确认模块不存在**

Run: `node --test tests/image-preview.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: 实现纯状态函数**

```js
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

export function imagePreviewState(file, src, phase = 'uploading') {
  const labels = { uploading: '上传中…', uploaded: '上传成功', failed: '上传失败' };
  return { src, name: file.name, format: file.type.split('/')[1].toUpperCase(), size: formatBytes(file.size), status: labels[phase], canSubmit: phase === 'uploaded' };
}
```

- [ ] **Step 4: 添加预览 DOM 并接入上传流程**

```html
<div id="image-preview" class="image-preview" hidden>
  <img id="preview-image" alt="已上传的参考图">
  <div class="image-meta"><strong id="preview-name"></strong><span id="preview-details"></span><span id="preview-status"></span>
    <div class="image-actions"><button id="replace-image" type="button">重新选择</button><button id="remove-image" type="button">移除</button></div>
  </div>
</div>
```

上传前调用 `URL.createObjectURL(file)` 并显示 `uploading`；成功后显示 `uploaded` 并保存 `uploadId`；失败后清空 `uploadId`、显示 `failed`；替换或移除时调用 `URL.revokeObjectURL`。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test tests/image-preview.test.mjs tests/ui-state.test.mjs`

Expected: all tests PASS.

```bash
git add public/image-preview.js public/index.html public/app.js tests/image-preview.test.mjs
git commit -m "feat: show adaptive reference image details"
```

### Task 5: 项目侧栏与移动端抽屉

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `public/app.js`
- Modify: `tests/ui-state.test.mjs`

- [ ] **Step 1: 写项目选择状态的失败测试**

```js
import { selectCurrentProject } from '../public/app.js';

test('selects the saved project or falls back to the first project', () => {
  const projects = [{ id: 'a' }, { id: 'b' }];
  assert.equal(selectCurrentProject(projects, 'b').id, 'b');
  assert.equal(selectCurrentProject(projects, 'missing').id, 'a');
});
```

- [ ] **Step 2: 运行测试并确认 helper 不存在**

Run: `node --test tests/ui-state.test.mjs`

Expected: FAIL because `selectCurrentProject` is not exported.

- [ ] **Step 3: 添加项目导航结构**

```html
<button id="project-drawer-toggle" class="project-drawer-toggle" type="button">项目</button>
<aside id="project-sidebar" class="project-sidebar">
  <div class="project-sidebar-head"><span>项目</span><button id="new-project" type="button">＋</button></div>
  <nav id="project-list" aria-label="项目列表"></nav>
</aside>
```

- [ ] **Step 4: 实现项目加载、创建、重命名与切换**

```js
export function selectCurrentProject(projects, savedId) {
  return projects.find((project) => project.id === savedId) || projects[0] || null;
}

async function loadProjects() {
  const { projects } = await request('/api/projects');
  currentProject = selectCurrentProject(projects, localStorage.getItem('currentProjectId'));
  renderProjects(projects, currentProject);
  if (currentProject) await loadProjectWorkspace(currentProject.id);
}
```

创建使用内联输入；重命名通过当前项目的编辑按钮进入内联编辑，不使用阻塞式 `prompt()`。切换后保存 `currentProjectId` 并关闭手机抽屉。

- [ ] **Step 5: 添加响应式样式**

```css
.workspace-shell{display:grid;grid-template-columns:220px minmax(0,1fr);gap:18px}
.project-sidebar{border-radius:20px;background:var(--panel);padding:16px;backdrop-filter:blur(24px)}
.image-preview{display:grid;grid-template-columns:minmax(120px,42%) 1fr;gap:16px;align-items:center;text-align:left}
.image-preview img{width:100%;max-height:220px;object-fit:contain;border-radius:12px;background:#0006}
@media(max-width:760px){
  .workspace-shell{display:block}.project-sidebar{position:fixed;inset:0 auto 0 0;width:min(82vw,320px);transform:translateX(-105%);z-index:10}
  .project-sidebar.open{transform:translateX(0)}.image-preview{grid-template-columns:1fr}.image-preview img{max-height:280px}
}
```

- [ ] **Step 6: 运行测试并提交**

Run: `node --test tests/*.test.mjs`

Expected: all tests PASS.

```bash
git add public/index.html public/styles.css public/app.js tests/ui-state.test.mjs
git commit -m "feat: add responsive project navigation"
```

### Task 6: 集成项目表单状态与工作区恢复

**Files:**
- Modify: `public/app.js`
- Modify: `tests/ui-state.test.mjs`

- [ ] **Step 1: 写项目请求载荷和表单恢复的失败测试**

```js
import { generationPayload, restoredSettings } from '../public/app.js';

test('includes the current project in uploads and generation', () => {
  assert.equal(generationPayload({ projectId: 'project-a', mode: 'text' }).projectId, 'project-a');
});

test('restores only the selected project settings', () => {
  assert.equal(restoredSettings({ settings: { prompt: 'A' } }).prompt, 'A');
});
```

- [ ] **Step 2: 运行测试并确认 helpers 不存在**

Run: `node --test tests/ui-state.test.mjs`

Expected: FAIL because payload/restoration helpers are missing.

- [ ] **Step 3: 将 projectId 接入上传和任务提交**

```js
const form = new FormData();
form.append('file', file);
form.append('projectId', currentProject.id);

const payload = generationPayload({
  projectId: currentProject.id,
  mode, uploadId, model: modelSelect.value, prompt: promptInput.value,
  resolution: resolution.value, duration: duration.value,
  aspectRatio: ratio.value, imageCount: 1
});
```

切换项目时调用工作区接口，恢复该项目的最近参数、参考图元数据和任务列表；未上传的本地文件不跨项目复用。

- [ ] **Step 4: 运行全套测试并提交**

Run: `node --test tests/*.test.mjs && git diff --check`

Expected: all tests PASS and no whitespace errors.

```bash
git add public/app.js tests/ui-state.test.mjs
git commit -m "feat: restore project-specific workspace state"
```

### Task 7: 构建、视觉验证与生产发布

**Files:**
- Modify: `dist/server/*` via `npm run build`
- Verify: `.openai/hosting.json`

- [ ] **Step 1: 执行完整自动化验证**

Run: `npm run build && node --test tests/*.test.mjs && git diff --check`

Expected: build succeeds, all tests PASS, and `git diff --check` prints nothing.

- [ ] **Step 2: 本地验证桌面布局**

在宽度约 1440px 下确认：项目侧栏可见、项目切换有效、横图/竖图完整显示、文件信息与操作按钮不重叠。

- [ ] **Step 3: 本地验证手机布局**

在宽度约 390px 下确认：项目侧栏变为抽屉、预览改为上下排列、图片不横向溢出、按钮触控区域完整。

- [ ] **Step 4: 提交构建产物对应的源代码状态**

```bash
git status --short
git add src public tests migrations scripts package.json
git commit -m "feat: complete project workspace experience"
```

若前面任务已提交所有源文件且工作树干净，则不创建空提交。

- [ ] **Step 5: 推送精确 commit 并部署私有站点**

读取 `.openai/hosting.json` 的现有 `project_id`，推送当前 HEAD 到站点源分支，打包 `.openai/hosting.json`、`dist/server` 与 `migrations`，保存并部署新的私有版本。不得创建第二个 Sites 项目，也不得修改当前访问范围。

- [ ] **Step 6: 验证生产环境**

确认部署状态为 `succeeded`，数据库概览包含四个新表；登录后验证项目创建、重命名、切换和图片预览。检查最近 Worker 日志无 5xx 或未捕获异常。

