# MiniMax / 可灵双视频供应商与 GitHub CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有视频工作台中加入按一级项目保存的 MiniMax / 可灵切换，支持 MiniMax 文生视频和单首帧图生视频，把 MiniMax 成片持久化到 R2，并为仓库加入只检查、不部署的 GitHub CI。

**Architecture:** 服务端新增统一视频供应商适配层，任务状态机根据任务自身的 `provider` 调用对应适配器；可灵现有 MCP/OAuth 行为由适配器保留，MiniMax 通过官方 V2 HTTP API接入。MiniMax 成功结果先写入 R2 和 `task_outputs`，再把任务标记为成功；前端只消费统一能力、状态和任务 DTO。

**Tech Stack:** Cloudflare Worker、D1/SQLite、R2、原生 JavaScript ES modules、Node.js test runner、MiniMax Video Generation V2 API、GitHub Actions（Node.js 22）

---

## 文件结构

### 新建

- `migrations/DB/0004_video_providers.sql`：项目供应商、任务供应商和任务输出表迁移。
- `src/providers/index.js`：供应商白名单、查找和统一入口。
- `src/providers/kling.js`：把现有 Kling MCP 创建/查询封装成统一接口。
- `src/providers/minimax.js`：MiniMax V2 状态、能力、创建、查询和错误归一化。
- `src/task-outputs.js`：供应商临时视频下载、R2 唯一持久化和鉴权输出读取。
- `tests/providers.test.mjs`：供应商注册表和 Kling 适配器测试。
- `tests/minimax-provider.test.mjs`：MiniMax 请求、响应、参数与错误测试。
- `tests/task-outputs.test.mjs`：R2 输出唯一性、类型限制和读取权限测试。
- `.github/workflows/ci.yml`：PR 与 `main` 推送时的测试、构建和产物一致性检查。

### 修改

- `src/db.js`：本地/首次访问时确保新列和 `task_outputs` 存在。
- `src/projects.js`：读写项目供应商，工作区返回任务供应商。
- `src/tasks.js`：供应商无关的校验、提交、恢复、查询和 MiniMax 成片固化。
- `src/worker.js`：项目供应商、供应商状态、任务输出 API 路由。
- `public/workspace.html`：供应商选择控件与动态状态文案容器。
- `public/app.js`：项目供应商状态、能力切换、提交载荷、任务标签。
- `public/styles.css`：供应商切换和状态样式。
- `public/task-history.css`：任务供应商标签样式。
- `public/task-presenter.js`：内部 R2 视频 URL 与供应商展示模型。
- `public/result.html`：结果详情供应商字段。
- `public/result.js`：渲染供应商与站内视频 URL。
- `.env.example`：只增加 `MINIMAX_API_KEY` 的变量名说明，不写真实值。
- `tests/migrations.test.mjs`、`tests/projects.test.mjs`、`tests/tasks.test.mjs`、`tests/router.test.mjs`、`tests/ui-state.test.mjs`、`tests/result-stage.test.mjs`、`tests/release.test.mjs`：对应回归与新行为测试。
- `dist/**`：最后由 `npm run build` 统一重建，不手工编辑。

## 官方接口基线

实施时以以下官方文档为准：

- 创建任务：`POST https://api.minimax.io/v2/video_generation`
- 查询单任务：`GET https://api.minimax.io/v2/query/video_generation/{task_id}`
- 非付费连接检查：`GET https://api.minimax.io/v2/query/video_generation?page_num=1&page_size=1`
- 文生视频必须提供具体 `ratio`；图生视频不发送具体画幅，按参考图自适应。
- `MiniMax-H3`：`768P`、`2K`，4–15 秒整数。
- `MiniMax-H3-Max`：`480P`、`768P`，5–15 秒整数。

参考：

- https://platform.minimax.io/docs/api-reference/video-generation-v2-create
- https://platform.minimax.io/docs/api-reference/video-generation-v2-query
- https://platform.minimax.io/docs/api-reference/video-generation-v2-list

### Task 1: 数据库迁移与兼容建表

**Files:**
- Create: `migrations/DB/0004_video_providers.sql`
- Modify: `src/db.js`
- Modify: `tests/migrations.test.mjs`

- [ ] **Step 1: 为迁移要求写失败测试**

在 `tests/migrations.test.mjs` 增加断言，要求迁移包含项目和任务供应商列、输出表、任务唯一约束和级联删除：

```js
test('video provider migration stores project choice, task provider, and one output', async () => {
  const sql = await readFile(new URL('../migrations/DB/0004_video_providers.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER TABLE projects ADD COLUMN video_provider TEXT NOT NULL DEFAULT 'kling'/);
  assert.match(sql, /ALTER TABLE video_tasks ADD COLUMN provider TEXT NOT NULL DEFAULT 'kling'/);
  assert.match(sql, /CREATE TABLE task_outputs/);
  assert.match(sql, /task_id TEXT NOT NULL UNIQUE/);
  assert.match(sql, /FOREIGN KEY \(task_id\) REFERENCES video_tasks\(id\) ON DELETE CASCADE/);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/migrations.test.mjs`

Expected: FAIL，指出 `0004_video_providers.sql` 不存在。

- [ ] **Step 3: 写迁移和运行时兼容建表**

创建 `migrations/DB/0004_video_providers.sql`：

```sql
ALTER TABLE projects ADD COLUMN video_provider TEXT NOT NULL DEFAULT 'kling';
ALTER TABLE video_tasks ADD COLUMN provider TEXT NOT NULL DEFAULT 'kling';
CREATE INDEX IF NOT EXISTS idx_video_tasks_provider_remote ON video_tasks(provider, remote_id);
CREATE TABLE IF NOT EXISTS task_outputs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES video_tasks(id) ON DELETE CASCADE
);
```

在 `src/db.js` 的基础 schema 中加入 `task_outputs`，并把可重复执行的加列逻辑收敛为：

```js
async function addColumn(db, sql) {
  try { await db.prepare(sql).run(); }
  catch (error) { if (!/duplicate column name/i.test(String(error?.message))) throw error; }
}

await addColumn(db, "ALTER TABLE stored_objects ADD COLUMN filename TEXT");
await addColumn(db, "ALTER TABLE projects ADD COLUMN video_provider TEXT NOT NULL DEFAULT 'kling'");
await addColumn(db, "ALTER TABLE video_tasks ADD COLUMN provider TEXT NOT NULL DEFAULT 'kling'");
```

- [ ] **Step 4: 验证迁移测试和全量测试**

Run: `node --test tests/migrations.test.mjs && npm test`

Expected: PASS，现有迁移回归不变。

- [ ] **Step 5: 提交数据库改动**

```bash
git add migrations/DB/0004_video_providers.sql src/db.js tests/migrations.test.mjs
git commit -m "feat: add video provider storage schema"
```

### Task 2: 项目级供应商读写 API

**Files:**
- Modify: `src/projects.js`
- Modify: `src/worker.js`
- Modify: `tests/projects.test.mjs`
- Modify: `tests/router.test.mjs`

- [ ] **Step 1: 写项目供应商失败测试**

增加以下行为测试：

```js
test('project workspace exposes provider and each task provider', async () => {
  const workspace = await readProjectWorkspace(db, 'project-a');
  assert.equal(workspace.project.videoProvider, 'minimax');
  assert.equal(workspace.tasks[0].provider, 'minimax');
});

test('updateProjectProvider accepts only registered provider ids', async () => {
  assert.equal((await updateProjectProvider(db, 'project-a', { provider: 'minimax' })).videoProvider, 'minimax');
  await assert.rejects(() => updateProjectProvider(db, 'project-a', { provider: 'other' }), /供应商无效/);
});
```

在路由测试中覆盖 `PATCH /api/projects/project-a/provider` 的 200、400、404、401 和跨源 403。

- [ ] **Step 2: 运行定向测试并确认失败**

Run: `node --test tests/projects.test.mjs tests/router.test.mjs`

Expected: FAIL，缺少 `updateProjectProvider` 和供应商路由。

- [ ] **Step 3: 实现项目供应商规范化和持久化**

在 `src/projects.js` 增加：

```js
const videoProviders = new Set(['kling', 'minimax']);

export function normalizeVideoProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (!videoProviders.has(provider)) throw new Error('视频供应商无效');
  return provider;
}

export async function updateProjectProvider(db, id, body, now = Date.now()) {
  const provider = normalizeVideoProvider(body?.provider);
  const result = await db.prepare(
    'UPDATE projects SET video_provider = ?, updated_at = ? WHERE id = ?',
  ).bind(provider, now, id).run();
  if (!result?.meta?.changes) throw new Error('项目不存在');
  return { id, videoProvider: provider, updatedAt: now };
}
```

更新项目读取 SQL：

```sql
SELECT id, name, video_provider, created_at, updated_at FROM projects
```

`projectRecord()` 返回 `videoProvider: row.video_provider || 'kling'`；工作区任务查询和 DTO 增加 `video_tasks.provider`。

- [ ] **Step 4: 增加路由**

在 `src/worker.js` 的通用项目 PATCH 路由之前匹配：

```js
const providerMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/provider$/);
if (providerMatch && request.method === 'PATCH') {
  const projectId = decodeProjectId(providerMatch[1]);
  if (projectId === null) return json({ error: '项目 ID 格式无效' }, 400);
  try { return json(await updateProjectProvider(env.DB, projectId, await request.json())); }
  catch (error) {
    if (error.message === '项目不存在') return json({ error: error.message }, 404);
    if (error.message === '视频供应商无效' || error instanceof SyntaxError) {
      return json({ error: error instanceof SyntaxError ? '请提供有效的 JSON' : error.message }, 400);
    }
    throw error;
  }
}
```

- [ ] **Step 5: 验证并提交**

Run: `node --test tests/projects.test.mjs tests/router.test.mjs && npm test`

Expected: PASS。

```bash
git add src/projects.js src/worker.js tests/projects.test.mjs tests/router.test.mjs
git commit -m "feat: persist video provider per project"
```

### Task 3: 统一供应商接口与 Kling 适配器

**Files:**
- Create: `src/providers/index.js`
- Create: `src/providers/kling.js`
- Create: `tests/providers.test.mjs`
- Modify: `src/tasks.js`
- Modify: `src/worker.js`
- Modify: `tests/tasks.test.mjs`
- Modify: `tests/router.test.mjs`

- [ ] **Step 1: 写供应商注册表和 Kling 行为失败测试**

测试固定接口：

```js
test('provider registry rejects unknown ids', () => {
  assert.throws(() => createVideoProvider('unknown', env), /供应商无效/);
});

test('kling adapter returns normalized create and query responses', async () => {
  const provider = createKlingProvider(env, { toolCaller });
  assert.deepEqual(await provider.create({ input, traceId: 'trace' }), { remoteId: 'k-1', status: 'queued', raw: { generationId: 'k-1' } });
  assert.equal((await provider.query('k-1')).status, 'succeeded');
});
```

同时把任务测试改为注入 `providerFactory`，验证：

- 新任务从项目 `video_provider` 复制到 `video_tasks.provider`。
- 恢复和轮询根据任务自身的 `provider`，而不是项目当前值。
- 已有 `remote_id` 时不会再次调用 `create()`。
- Kling 现有提交、图片上传和 `unknown` 防重复扣费语义不变。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/providers.test.mjs tests/tasks.test.mjs tests/router.test.mjs`

Expected: FAIL，缺少 `src/providers/*` 和 provider-aware 任务字段。

- [ ] **Step 3: 建立固定供应商接口**

`src/providers/index.js` 只负责白名单和实例化：

```js
import { createKlingProvider } from './kling.js';

const factories = Object.freeze({ kling: createKlingProvider });
export const providerIds = Object.freeze(Object.keys(factories));

export function createVideoProvider(id, env, dependencies = {}) {
  const factory = factories[id];
  if (!factory) throw new Error('视频供应商无效');
  return factory(env, dependencies);
}
```

本任务的注册表只包含 Kling，保证每个中间提交都可独立构建。Task 4 创建 MiniMax 文件后，再把 `minimax: createMiniMaxProvider` 加入 `factories`。

`src/providers/kling.js` 暴露统一对象：

```js
{
  id: 'kling',
  persistOutput: false,
  async status(),
  async capabilities(),
  async create({ input, reference, traceId }),
  async query(remoteId),
}
```

`create()` 内保留现有 `file_upload` + `text_to_video` / `image_to_video` 调用；`query()` 把可灵状态转成 `queued | generating | succeeded | failed`，并返回 `{ status, raw, outputUrl }`。

- [ ] **Step 4: 将任务状态机改为依赖统一接口**

`submitTask()` 改为读取项目：

```js
const project = await env.DB.prepare(
  'SELECT id, video_provider FROM projects WHERE id = ?',
).bind(projectId).first();
const providerId = project.video_provider || 'kling';
const provider = providerFactory(providerId, env, { fetcher, toolCaller });
```

预留任务时写入 provider：

```sql
INSERT INTO video_tasks
  (id, idempotency_key, remote_id, provider, mode, status, request_json, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
```

恢复记录增加 `provider` 并验证与数据库一致。`getTaskStatus()` 使用 `task.provider || 'kling'` 创建适配器。所有对 Kling MCP 的直接调用从 `src/tasks.js` 移入 `src/providers/kling.js`。

同时扩展 `TaskError` 为 `{ message, status, code, task }`，`src/worker.js` 的任务错误响应增加 `errorCode: error.code`（仅在 code 存在时输出），为 Task 4 的稳定供应商错误码建立端到端通路。

- [ ] **Step 5: 运行 Kling 全回归并提交**

Run: `node --test tests/providers.test.mjs tests/tasks.test.mjs tests/router.test.mjs && npm test`

Expected: PASS；不需要真实 MCP 或付费任务。

```bash
git add src/providers/index.js src/providers/kling.js src/tasks.js src/worker.js tests/providers.test.mjs tests/tasks.test.mjs tests/router.test.mjs
git commit -m "refactor: route video tasks through provider adapters"
```

### Task 4: MiniMax V2 适配器

**Files:**
- Create: `src/providers/minimax.js`
- Create: `tests/minimax-provider.test.mjs`
- Modify: `src/providers/index.js`
- Modify: `.env.example`

- [ ] **Step 1: 写 MiniMax 能力与请求失败测试**

覆盖以下精确断言：

```js
test('MiniMax H3 text request includes ratio', async () => {
  await provider.create({ input: { mode: 'text', model: 'MiniMax-H3', prompt: '山间奔跑', resolution: '2K', duration: '5', aspectRatio: '16:9' } });
  assert.deepEqual(JSON.parse(fetcher.calls[0].options.body), {
    model: 'MiniMax-H3',
    content: [{ type: 'text', text: '山间奔跑' }],
    resolution: '2K', duration: 5, ratio: '16:9',
  });
});

test('MiniMax image request sends private data URI and omits ratio', async () => {
  await provider.create({ input: imageInput, reference: { bytes, mimeType: 'image/png' } });
  const body = JSON.parse(fetcher.calls[0].options.body);
  assert.equal(body.content[1].role, 'first_frame');
  assert.match(body.content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal('ratio' in body, false);
});
```

再覆盖：Bearer header、H3/H3-Max 参数范围、7000 字提示词上限、缺失密钥、200 无 `task_id`、401、402、422、429、500、超时、畸形 JSON、查询 `queued/running/succeeded/failed/cancelled` 映射以及输出 `task.content.url`。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/minimax-provider.test.mjs`

Expected: FAIL，`src/providers/minimax.js` 不存在。

- [ ] **Step 3: 实现能力和错误类型**

能力对象使用现有前端可消费的结构：

```js
export const minimaxCapabilities = {
  text_to_video: { models: [
    { model: 'MiniMax-H3', arguments: [
      { name: 'resolution', allowedValues: ['768P', '2K'] },
      { name: 'duration', allowedValues: Array.from({ length: 12 }, (_, index) => String(index + 4)) },
      { name: 'aspect_ratio', allowedValues: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] },
    ] },
    { model: 'MiniMax-H3-Max', arguments: [
      { name: 'resolution', allowedValues: ['480P', '768P'] },
      { name: 'duration', allowedValues: Array.from({ length: 11 }, (_, index) => String(index + 5)) },
      { name: 'aspect_ratio', allowedValues: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] },
    ] },
  ] },
  image_to_video: { models: [] },
};
minimaxCapabilities.image_to_video.models = minimaxCapabilities.text_to_video.models;
```

定义 `ProviderError`，字段固定为 `code`、`httpStatus`、`definitive`；映射：401 → `provider_auth_failed`，402 → `insufficient_balance`，400/422 → `invalid_parameters`，429/5xx/网络错误 → `provider_unavailable`。

在 `src/providers/index.js` 导入 `createMiniMaxProvider`，并把 `minimax: createMiniMaxProvider` 加入 Task 3 建立的 `factories`。此后 `providerIds` 同时包含 `kling`、`minimax`。

- [ ] **Step 4: 实现状态、创建和查询**

所有请求使用：

```js
const headers = { Authorization: `Bearer ${env.MINIMAX_API_KEY}`, 'content-type': 'application/json' };
```

`status()` 在密钥缺失时直接返回：

```js
{ connection: 'unconfigured', label: 'MiniMax 未配置', balanceLabel: '额度：控制台查看' }
```

有密钥时请求 `page_num=1&page_size=1`；200 为 online，401 为 auth_error，其余为 offline。状态检查绝不创建视频。

创建成功返回：

```js
{ remoteId: String(body.task_id), status: 'queued', raw: { task_id: String(body.task_id) } }
```

查询成功返回：

```js
{
  status: normalizeMiniMaxStatus(body.task.status),
  raw: body.task,
  outputUrl: body.task.status === 'succeeded' ? body.task.content?.url || '' : '',
  error: body.task.error || null,
}
```

- [ ] **Step 5: 更新 Secret 示例、验证和提交**

`.env.example` 只增加：

```dotenv
# Server-side only. Never expose this value to client code.
MINIMAX_API_KEY=
```

Run: `node --test tests/minimax-provider.test.mjs tests/providers.test.mjs && npm test`

Expected: PASS；测试 fetch 全部为 mock，调用次数中没有真实网络请求。

```bash
git add src/providers/minimax.js src/providers/index.js tests/minimax-provider.test.mjs .env.example
git commit -m "feat: add MiniMax H3 video provider"
```

### Task 5: 当前供应商状态与能力 API

**Files:**
- Modify: `src/worker.js`
- Modify: `tests/router.test.mjs`

- [ ] **Step 1: 写统一状态路由失败测试**

覆盖：

```js
GET /api/video/providers/kling/status
GET /api/video/providers/minimax/status
```

期望响应结构：

```js
{
  provider: 'minimax',
  connection: 'online',
  label: 'MiniMax 已连接',
  balanceLabel: '额度：控制台查看',
  models: minimaxCapabilities,
}
```

未知供应商返回 404；未登录返回 401；响应不得包含 `MINIMAX_API_KEY` 或供应商原始错误体。

- [ ] **Step 2: 运行路由测试并确认失败**

Run: `node --test tests/router.test.mjs`

Expected: FAIL，统一状态路由不存在。

- [ ] **Step 3: 实现统一状态路由**

在 `/api/kling/status` 兼容路由旁加入：

```js
const providerStatusMatch = url.pathname.match(/^\/api\/video\/providers\/([^/]+)\/status$/);
if (providerStatusMatch && request.method === 'GET') {
  const providerId = decodeProjectId(providerStatusMatch[1]);
  try {
    const provider = createVideoProvider(providerId, env);
    return json({ provider: provider.id, ...(await provider.status()), models: await provider.capabilities() });
  } catch (error) {
    if (error.message === '视频供应商无效') return json({ error: error.message }, 404);
    return json({ provider: providerId, connection: 'offline', label: '供应商暂不可用', balanceLabel: '额度：暂不可用', models: {} }, 503);
  }
}
```

保留 `/api/kling/status`，避免旧客户端缓存短期失效；新前端只使用统一路由。

- [ ] **Step 4: 验证无密钥泄漏并提交**

Run: `node --test tests/router.test.mjs && npm test`

Expected: PASS，序列化全部响应后搜索不到 mock secret。

```bash
git add src/worker.js tests/router.test.mjs
git commit -m "feat: expose active video provider status"
```

### Task 6: MiniMax 成片 R2 持久化与鉴权播放

**Files:**
- Create: `src/task-outputs.js`
- Create: `tests/task-outputs.test.mjs`
- Modify: `src/tasks.js`
- Modify: `src/worker.js`
- Modify: `tests/tasks.test.mjs`
- Modify: `tests/router.test.mjs`

- [ ] **Step 1: 写输出持久化失败测试**

覆盖：

- 已存在 `task_outputs` 时不重复下载或写 R2。
- 只接受 HTTPS 下载地址。
- 只接受 `video/*` 或明确 MP4 响应，拒绝 HTML/JSON。
- 下载失败时任务保持 `generating`，返回 `output_persist_failed`，不得提前标记成功。
- R2 写入成功后插入一条输出并返回站内 URL。
- 输出读取必须同时匹配登录、项目、任务和输出记录。

核心断言：

```js
assert.equal(result.url, '/api/projects/project-1/tasks/task-1/output');
assert.equal(media.putCalls[0].key, 'outputs/task-1.mp4');
assert.equal(db.outputRows.length, 1);
```

- [ ] **Step 2: 运行定向测试并确认失败**

Run: `node --test tests/task-outputs.test.mjs tests/tasks.test.mjs tests/router.test.mjs`

Expected: FAIL，输出模块和路由不存在。

- [ ] **Step 3: 实现唯一持久化**

`src/task-outputs.js` 暴露：

```js
export async function persistTaskOutput({ taskId, projectId, sourceUrl, env, fetcher = fetch })
export async function readTaskOutput({ taskId, projectId, env })
```

持久化顺序固定为：

1. 查询 `task_outputs WHERE task_id = ?`，存在则返回内部 URL。
2. 验证 `sourceUrl` 为 HTTPS。
3. `fetcher(sourceUrl, { redirect: 'follow' })`，要求 2xx 和视频内容类型。
4. 流式 `env.MEDIA.put('outputs/<taskId>.mp4', response.body, { httpMetadata: { contentType } })`。
5. `INSERT OR IGNORE` 输出记录。
6. 若并发插入落败，删除本次多余对象仅限其唯一临时 key；实现中使用任务固定 key 时保留对象并读取胜出行。

- [ ] **Step 4: 在任务查询成功路径中固化 MiniMax 输出**

`getTaskStatus()` 在 `provider.persistOutput && queried.status === 'succeeded'` 时先执行：

```js
const output = await persistTaskOutput({ taskId: id, projectId, sourceUrl: queried.outputUrl, env, fetcher });
const resultJson = JSON.stringify({ providerResult: queried.raw, videoUrl: output.url });
```

只有以上成功后才更新 `video_tasks.status = 'succeeded'`。失败时保持原活动状态，并抛出不含临时 URL 的 `TaskError('视频已生成，但保存到本站失败，请稍后重试状态同步', 503)`。

Kling `persistOutput: false`，继续保存其现有归一化结果，不改变真实生成流程。

- [ ] **Step 5: 增加鉴权输出路由**

在 `src/worker.js` 增加：

```js
const outputMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/output$/);
if (outputMatch && request.method === 'GET') {
  const projectId = decodeProjectId(outputMatch[1]);
  const taskId = decodeProjectId(outputMatch[2]);
  if (!projectId || !taskId) return json({ error: '任务参数无效' }, 400);
  const output = await readTaskOutput({ projectId, taskId, env });
  return output || json({ error: '视频不存在' }, 404);
}
```

`readTaskOutput()` 返回 `cache-control: private, max-age=3600`，不得把 R2 object key 暴露给浏览器。

- [ ] **Step 6: 验证并提交**

Run: `node --test tests/task-outputs.test.mjs tests/tasks.test.mjs tests/router.test.mjs && npm test`

Expected: PASS。

```bash
git add src/task-outputs.js src/tasks.js src/worker.js tests/task-outputs.test.mjs tests/tasks.test.mjs tests/router.test.mjs
git commit -m "feat: persist MiniMax video outputs to R2"
```

### Task 7: 工作台供应商切换与动态参数

**Files:**
- Modify: `public/workspace.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `tests/ui-state.test.mjs`
- Modify: `tests/router.test.mjs`

- [ ] **Step 1: 写前端状态失败测试**

给纯函数增加测试：

```js
assert.equal(normalizeWorkspaceProvider('minimax'), 'minimax');
assert.equal(normalizeWorkspaceProvider('bad'), 'kling');
assert.equal(aspectRatioControl('minimax', 'image').label, '跟随参考图');
assert.equal(buildGenerationPayload({ ...value, provider: 'minimax' }).provider, undefined);
```

再测试：

- 项目 A、B 各自恢复 `project.videoProvider`。
- 供应商切换后能力和表单值回落到有效默认值。
- 状态请求只访问当前供应商 URL，迟到的旧请求不得覆盖当前状态。
- MiniMax 未配置时禁用生成；切回可灵后恢复。

- [ ] **Step 2: 运行 UI 测试并确认失败**

Run: `node --test tests/ui-state.test.mjs tests/router.test.mjs`

Expected: FAIL，缺少供应商状态纯函数和控件。

- [ ] **Step 3: 增加无边界供应商切换控件**

在 `public/workspace.html` 的模式切换上方加入：

```html
<fieldset class="provider-switch" aria-label="视频生成服务">
  <legend>生成服务</legend>
  <button type="button" data-provider="kling" aria-pressed="true">可灵</button>
  <button type="button" data-provider="minimax" aria-pressed="false">MiniMax</button>
</fieldset>
```

沿用深色工作台视觉，以焦点边框、激活底色和文字标签区分，不增加实体手机边框或独立浮层。

- [ ] **Step 4: 实现项目级切换和状态竞态保护**

`public/app.js` 增加：

```js
export function normalizeWorkspaceProvider(value) {
  return value === 'minimax' ? 'minimax' : 'kling';
}

export function aspectRatioControl(provider, mode) {
  return provider === 'minimax' && mode === 'image'
    ? { disabled: true, label: '跟随参考图', value: 'adaptive' }
    : { disabled: false, label: '画幅', value: '' };
}
```

在 `applyWorkspace()` 先应用 `workspaceState.project.videoProvider`，再加载对应状态与能力。点击供应商时：

1. 设置 busy 状态。
2. `PATCH /api/projects/<id>/provider`。
3. 仅在项目 ID 和请求序号仍匹配时提交 UI 状态。
4. 加载 `/api/video/providers/<provider>/status`。
5. 用新能力重建表单有效默认值。

提交载荷不信任额外 `provider` 字段；服务端始终以项目数据库值为准。

- [ ] **Step 5: 更新状态栏和参数行为**

状态栏按统一响应渲染：

- `online`：绿灯。
- `unconfigured`、`offline`、`auth_error`：红灯。
- MiniMax 余额文字固定使用服务端 `balanceLabel`。
- MiniMax 图生视频画幅 select 禁用并显示“跟随参考图”。
- 可灵切回后恢复原 MCP 会员与点数余额显示。

- [ ] **Step 6: 验证桌面和移动布局并提交**

Run: `node --test tests/ui-state.test.mjs tests/router.test.mjs && npm test && npm run build`

Expected: PASS；供应商控件在移动断点不横向溢出。

```bash
git add public/workspace.html public/app.js public/styles.css tests/ui-state.test.mjs tests/router.test.mjs dist
git commit -m "feat: add project video provider switcher"
```

### Task 8: 历史任务与结果详情显示供应商

**Files:**
- Modify: `src/tasks.js`
- Modify: `public/app.js`
- Modify: `public/task-presenter.js`
- Modify: `public/task-history.css`
- Modify: `public/result.html`
- Modify: `public/result.js`
- Modify: `tests/result-stage.test.mjs`
- Modify: `tests/ui-state.test.mjs`
- Modify: `tests/router.test.mjs`

- [ ] **Step 1: 写展示失败测试**

要求任务详情 DTO 包含 `provider`，历史模型返回标签：

```js
assert.equal(taskProviderLabel({ provider: 'minimax' }), 'MiniMax');
assert.equal(taskProviderLabel({ provider: 'kling' }), '可灵');
assert.equal(resultViewModel(detail).videoUrl, '/api/projects/p/tasks/t/output');
```

结果元数据必须包含“生成服务”，旧任务 provider 缺失时回落为“可灵”。没有真实百分比时仍只显示渐变动画和“生成中”。

- [ ] **Step 2: 运行定向测试并确认失败**

Run: `node --test tests/result-stage.test.mjs tests/ui-state.test.mjs tests/router.test.mjs`

Expected: FAIL，DTO 和展示模型缺少 provider。

- [ ] **Step 3: 扩展安全 DTO**

`getTaskDetail()` 的 SELECT 和返回值增加：

```js
provider: task.provider || 'kling'
```

工作区任务 DTO 同样返回 provider，但不得返回 Secret、R2 key 或 MiniMax 原始 Authorization 信息。

- [ ] **Step 4: 增加历史和结果供应商标签**

在 `public/task-presenter.js` 增加：

```js
export function taskProviderLabel(task) {
  return task?.provider === 'minimax' ? 'MiniMax' : '可灵';
}
```

历史 metadata 在模式前插入供应商标签。`public/result.html` 增加供应商字段容器，`public/result.js` 在元数据数组首部加入：

```js
['生成服务', taskProviderLabel(detail)]
```

内部 `/api/.../output` 已被 `safeVideoUrl()` 允许，播放器继续使用站内 URL。

- [ ] **Step 5: 验证进度 UI 不回归并提交**

Run: `node --test tests/result-stage.test.mjs tests/ui-state.test.mjs tests/router.test.mjs && npm test && npm run build`

Expected: PASS；没有百分比的 active 任务不渲染 `%` 文本。

```bash
git add src/tasks.js public/app.js public/task-presenter.js public/task-history.css public/result.html public/result.js tests/result-stage.test.mjs tests/ui-state.test.mjs tests/router.test.mjs dist
git commit -m "feat: show provider on video tasks and results"
```

### Task 9: GitHub Actions 只检查 CI

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `tests/release.test.mjs`

- [ ] **Step 1: 写 CI 合同失败测试**

在 `tests/release.test.mjs` 读取 workflow 并断言：

- 有 `pull_request`。
- 只对 `main` push。
- 使用 Node 22。
- 执行 `npm test`、`npm run build`、`git diff --exit-code -- dist`、`git diff --check`。
- 不出现 `deploy`、`wrangler deploy`、`MINIMAX_API_KEY`、`KLING` Secret。

```js
test('CI checks tests, build, and tracked artifacts without deploying', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const command of ['npm test', 'npm run build', 'git diff --exit-code -- dist', 'git diff --check']) assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(workflow, /wrangler\s+deploy|MINIMAX_API_KEY|KLING.*SECRET/i);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/release.test.mjs`

Expected: FAIL，`.github/workflows/ci.yml` 不存在。

- [ ] **Step 3: 创建 CI 工作流**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
      - run: npm run build
      - run: git diff --exit-code -- dist
      - run: git diff --check
```

- [ ] **Step 4: 验证并提交**

Run: `node --test tests/release.test.mjs && npm test && npm run build && git diff --exit-code -- dist && git diff --check`

Expected: 全部退出码 0。

```bash
git add .github/workflows/ci.yml tests/release.test.mjs
git commit -m "ci: verify tests build and generated assets"
```

### Task 10: 完整回归、构建和部署前验收

**Files:**
- Modify only if verification finds a defect in files already listed above.
- Verify: `dist/**`

- [ ] **Step 1: 运行全量自动验证**

Run:

```bash
npm test
npm run build
git diff --exit-code -- dist
git diff --check
git status --short
```

Expected: 测试全通过；构建成功；`dist` 无差异；无未提交文件。

- [ ] **Step 2: 做静态安全扫描**

Run:

```bash
rg -n "sk-api-|MINIMAX_API_KEY=.+|Authorization: Bearer [A-Za-z0-9]" . --glob '!docs/**' --glob '!.git/**'
```

Expected: 没有真实密钥；允许出现读取 `env.MINIMAX_API_KEY` 的代码和空的 `.env.example` 键名。

- [ ] **Step 3: 本地无付费验收**

使用 mock 环境验证：

- 登录独立页面不变。
- 项目切换、创建、重命名、图片上传与自适应预览不变。
- 每项目供应商选择独立保存。
- MiniMax 文生和图生请求体符合 V2 文档。
- 未配置 MiniMax 时显示红灯且只禁用 MiniMax。
- active 任务的进度层固定居中；无真实百分比时只显示“生成中”。
- 完成任务显示供应商标签和“查看结果”。
- 结果详情使用鉴权的站内输出 URL。

- [ ] **Step 4: 代码审查后创建 PR**

先使用 `superpowers:requesting-code-review` 审核规格覆盖、付费调用幂等、Secret 泄漏、跨项目访问和 Kling 回归。修复审查问题并重复 Steps 1–3，再推送：

```bash
git push -u origin codex/minimax-provider-ci
gh pr create --base main --head codex/minimax-provider-ci --title "Add MiniMax video provider and CI checks" --body-file /tmp/minimax-provider-pr.md
```

PR 描述必须注明：自动测试不调用真实供应商；上线前由管理员在托管平台设置新的 `MINIMAX_API_KEY`。

- [ ] **Step 5: 合并后生产配置与一次性真实冒烟**

合并完成后才执行：

1. 在托管平台 Secret 设置中录入新 `MINIMAX_API_KEY`，不得粘贴到聊天、终端历史或仓库。
2. 部署合并后的 `main`。
3. 检查 MiniMax 绿灯和“额度：控制台查看”。
4. 使用单一验收项目各提交一次低成本 MiniMax 文生和单首帧图生。
5. 确认任务只创建一次、状态正确、R2 成片可在结果页播放、历史标签正确。
6. 再执行一次可灵低成本任务或查询既有可灵任务，确认 MCP/OAuth/余额/结果无回归。

生产真实冒烟是唯一允许调用付费接口的验证阶段；执行前明确告知用户预计会产生供应商费用。
