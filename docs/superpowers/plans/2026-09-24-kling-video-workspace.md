# Kling Video Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing login-only Site into a secure cloud application that authenticates one administrator, authorizes Kling with OAuth PKCE, displays live MCP/credit status, and creates real text-to-video and image-to-video tasks.

**Architecture:** A Cloudflare Worker-compatible ES module serves the existing visual frontend and JSON APIs. D1 stores sessions, encrypted OAuth tokens, registered OAuth client data, and video task metadata; R2 stores reference images and retained outputs. Focused modules isolate authentication, OAuth, MCP transport, storage, task orchestration, and browser UI.

**Tech Stack:** JavaScript ES modules, Cloudflare Workers Web APIs, D1, R2, Node built-in test runner, Kling MCP streamable HTTP, OAuth 2.1 authorization code with PKCE.

---

## File map

- `src/worker.js`: request routing, static fallback, security headers, dependency composition.
- `src/auth.js`: password verification, signed session cookies, session guards.
- `src/crypto.js`: PKCE, SHA-256, AES-GCM token encryption, constant-time comparison.
- `src/kling-oauth.js`: discovery, dynamic registration, authorization start, callback, refresh and revoke.
- `src/kling-mcp.js`: authenticated MCP initialize and tool calls.
- `src/tasks.js`: parameter validation, upload coordination, generation submission and polling.
- `src/db.js`: prepared D1 statements and record mapping.
- `public/index.html`, `public/styles.css`, `public/app.js`: login and video workspace UI.
- `migrations/0001_initial.sql`: sessions, OAuth, tasks and storage metadata.
- `tests/*.test.mjs`: unit and request-level behavior tests.
- `.openai/hosting.json`: Worker entrypoint plus logical D1/R2 bindings.

### Task 1: Establish the Worker application and data schema

**Files:**
- Create: `package.json`
- Create: `src/worker.js`
- Create: `src/db.js`
- Create: `migrations/0001_initial.sql`
- Create: `tests/router.test.mjs`
- Modify: `.openai/hosting.json`

- [ ] **Step 1: Write a failing router test**

```js
test('returns health JSON and security headers', async () => {
  const response = await worker.fetch(new Request('https://site.test/api/health'), env(), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});
```

- [ ] **Step 2: Run `node --test tests/router.test.mjs`**

Expected: FAIL because `src/worker.js` does not exist.

- [ ] **Step 3: Implement the minimal Worker router and schema**

`worker.fetch()` returns JSON for `/api/health`, applies CSP and security headers, and delegates non-API requests to `env.ASSETS.fetch(request)`. The migration creates `admin_sessions`, `oauth_clients`, `oauth_states`, `oauth_tokens`, `video_tasks`, and `stored_objects` with expiry and status indexes.

- [ ] **Step 4: Configure logical bindings**

Update `.openai/hosting.json` to declare the built Worker entrypoint, one D1 binding named `DB`, one R2 binding named `MEDIA`, and the public asset directory. Do not store physical resource IDs.

- [ ] **Step 5: Run `node --test tests/router.test.mjs`**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json src/worker.js src/db.js migrations/0001_initial.sql tests/router.test.mjs .openai/hosting.json
git commit -m "feat: establish video workspace backend"
```

### Task 2: Implement secure administrator sessions

**Files:**
- Create: `src/auth.js`
- Create: `src/crypto.js`
- Create: `tests/auth.test.mjs`
- Modify: `src/worker.js`

- [ ] **Step 1: Write failing authentication tests**

```js
test('rejects an invalid administrator password', async () => {
  const response = await login({ username: 'wrong', password: 'wrong' }, testEnv());
  assert.equal(response.status, 401);
});

test('creates a secure server session for valid credentials', async () => {
  const response = await login(validCredentials(), testEnv());
  assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
});
```

- [ ] **Step 2: Run `node --test tests/auth.test.mjs`**

Expected: FAIL because the auth module does not exist.

- [ ] **Step 3: Implement authentication**

Read `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` only from Worker secrets. Verify a versioned PBKDF2-SHA256 string with constant-time byte comparison, store only a random session hash in D1, expire sessions after eight hours, and protect every private API route with the session cookie.

- [ ] **Step 4: Add session routes**

`POST /api/session` accepts strict JSON credentials; `GET /api/session` returns `{ authenticated: true }`; `DELETE /api/session` deletes the session and clears the cookie. All failures return the same `用户名或密码错误` message.

- [ ] **Step 5: Run `node --test tests/auth.test.mjs tests/router.test.mjs`**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/auth.js src/crypto.js src/worker.js tests/auth.test.mjs
git commit -m "feat: secure administrator sessions"
```

### Task 3: Implement Kling OAuth and MCP status

**Files:**
- Create: `src/kling-oauth.js`
- Create: `src/kling-mcp.js`
- Create: `tests/kling-oauth.test.mjs`
- Create: `tests/kling-mcp.test.mjs`
- Modify: `src/worker.js`

- [ ] **Step 1: Write failing OAuth and MCP tests**

```js
test('creates an S256 authorization request with all required scopes', async () => {
  const result = await beginAuthorization(testRequest(), testEnv());
  assert.equal(result.url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(result.url.searchParams.get('scope'), 'generation.create generation.read account.credit.read');
});

test('maps a successful who_am_i call to a green status', async () => {
  const status = await getKlingStatus(testEnv(), fakeMcpSuccess());
  assert.equal(status.connection, 'online');
});
```

- [ ] **Step 2: Run `node --test tests/kling-oauth.test.mjs tests/kling-mcp.test.mjs`**

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement OAuth PKCE**

Discover protected-resource and authorization metadata, dynamically register the Site callback URI once, create random `state` and `code_verifier` records with ten-minute expiry, validate state exactly once, exchange the code, encrypt tokens with AES-GCM using `TOKEN_ENCRYPTION_KEY`, and refresh expired tokens without exposing them to the browser.

- [ ] **Step 4: Implement MCP transport and status**

Send authenticated streamable-HTTP JSON-RPC calls for `initialize`, `tools/list`, and `tools/call`. Implement `who_am_i` and `query_membership_and_credits`; return `{ connection, membership, credits, models, checkedAt }`. Treat missing authorization, HTTP errors, invalid RPC responses and timeouts as `offline` with a recoverable public message.

- [ ] **Step 5: Add OAuth and status routes**

Add `GET /api/kling/oauth/start`, `GET /api/kling/oauth/callback`, `DELETE /api/kling/oauth`, and `GET /api/kling/status`. Require an administrator session, except that the callback proves its session through the one-time state record.

- [ ] **Step 6: Run `node --test tests/kling-oauth.test.mjs tests/kling-mcp.test.mjs tests/auth.test.mjs tests/router.test.mjs`**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/kling-oauth.js src/kling-mcp.js src/worker.js tests/kling-oauth.test.mjs tests/kling-mcp.test.mjs
git commit -m "feat: connect Kling OAuth and MCP status"
```

### Task 4: Implement uploads and real video tasks

**Files:**
- Create: `src/tasks.js`
- Create: `tests/tasks.test.mjs`
- Modify: `src/worker.js`

- [ ] **Step 1: Write failing parameter and idempotency tests**

```js
test('rejects a duration unsupported by the selected model', () => {
  assert.throws(() => validateTask({ ...validTextTask(), duration: 16 }, capabilities), /时长/);
});

test('requires a stored first image for image-to-video', () => {
  assert.throws(() => validateTask({ ...validImageTask(), firstImageKey: '' }, capabilities), /参考图/);
});

test('returns the existing task for a repeated idempotency key', async () => {
  const task = await submitTask(validTextTask(), testEnv(), 'same-key');
  const repeated = await submitTask(validTextTask(), testEnv(), 'same-key');
  assert.equal(repeated.id, task.id);
});
```

- [ ] **Step 2: Run `node --test tests/tasks.test.mjs`**

Expected: FAIL because the task module does not exist.

- [ ] **Step 3: Implement reference-image storage**

`POST /api/uploads` accepts one JPEG, PNG or WebP image up to 15 MB, validates magic bytes, writes it to R2 under a random private key, records metadata in D1, and returns only an opaque upload ID. The server passes the object to Kling `file_upload`; external URLs and local paths are never accepted from the browser.

- [ ] **Step 4: Implement generation submission**

Validate mode, model, prompt, resolution, duration, aspect ratio and image count against the current `who_am_i` capability response. Call `text_to_video` or `image_to_video`, persist the remote task ID and request summary, and require an idempotency key so network retries cannot double-charge credits.

- [ ] **Step 5: Implement task status reads**

`GET /api/video/tasks/:id` calls `query_tasks`, maps remote states to `queued`, `generating`, `succeeded` or `failed`, updates D1, and returns result URLs only for the signed-in administrator. A successful submission invalidates the cached credit balance.

- [ ] **Step 6: Run `node --test tests/tasks.test.mjs tests/kling-mcp.test.mjs`**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tasks.js src/worker.js tests/tasks.test.mjs
git commit -m "feat: submit real Kling video tasks"
```

### Task 5: Build the responsive video workspace UI

**Files:**
- Create: `public/index.html`
- Create: `public/styles.css`
- Create: `public/app.js`
- Create: `tests/ui-state.test.mjs`
- Remove: `dist/index.html`
- Remove: `dist/styles.css`
- Remove: `dist/app.js`
- Move: `dist/assets/alpine-runner.jpg` to `public/assets/alpine-runner.jpg`

- [ ] **Step 1: Write failing UI-state tests**

```js
test('filters resolution and duration from model capabilities', () => {
  assert.deepEqual(optionsForModel(capabilities, 'kling-video-v3_0_turbo').resolutions, ['720p', '1080p']);
});

test('image mode requires an uploaded first frame', () => {
  assert.equal(validateWorkspace({ ...validForm(), mode: 'image', uploadId: '' }).uploadId, '请上传首帧参考图');
});
```

- [ ] **Step 2: Run `node --test tests/ui-state.test.mjs`**

Expected: FAIL because the UI state helpers do not exist.

- [ ] **Step 3: Port and extend the interface**

Preserve the approved photographic login visual. After session creation, render a full-screen workspace with navigation title, red/green MCP light, OAuth action, membership, credit balance, refresh time, mode tabs, model selector, prompt, image dropzone, resolution, duration, ratio, count, submit button, and task result panel. Use one-column ordering below 760 px and honor reduced-motion preferences.

- [ ] **Step 4: Wire real APIs**

Load `/api/session` and `/api/kling/status`; redirect to Kling authorization when requested; upload a selected reference image; submit tasks with a UUID idempotency key; poll only the active task with exponential backoff capped at ten seconds; stop polling on success, failure or logout; refresh credits after submission.

- [ ] **Step 5: Run `node --test tests/ui-state.test.mjs tests/*.test.mjs`**

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add public tests/ui-state.test.mjs
git rm -r dist
git commit -m "feat: add responsive Kling video workspace"
```

### Task 6: Configure secrets, migrate, verify and publish

**Files:**
- Modify: `.openai/hosting.json`
- Create: `.env.example`
- Create: `scripts/hash-admin-password.mjs`

- [ ] **Step 1: Add safe configuration documentation**

`.env.example` contains only `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `SESSION_SIGNING_KEY`, and `TOKEN_ENCRYPTION_KEY` names with non-secret examples. The hashing script accepts a password from a hidden terminal prompt and prints a versioned PBKDF2 string; it never writes the password.

- [ ] **Step 2: Run the complete verification**

```bash
node --test tests/*.test.mjs
npm run build
```

Expected: all tests pass and the Cloudflare-compatible Worker bundle plus public assets are produced.

- [ ] **Step 3: Perform one visual and interaction check**

Verify desktop and mobile login, authenticated workspace, red/green MCP state, balance loading/failure, model option filtering, reference upload preview, and task progress. Do not submit a paid generation during visual QA.

- [ ] **Step 4: Configure hosted secrets and resources**

Set the administrator username, derived password hash, random session signing key and random token-encryption key through Sites environment tools. Apply the D1 migration and confirm the R2 binding without exposing values in output.

- [ ] **Step 5: Publish privately**

Run the Sites source/package workflow, save the version, deploy to the existing private Site, and poll the deployment until it returns a successful production URL.

- [ ] **Step 6: Commit final configuration**

```bash
git add .env.example scripts/hash-admin-password.mjs .openai/hosting.json
git commit -m "chore: configure Kling workspace deployment"
```
