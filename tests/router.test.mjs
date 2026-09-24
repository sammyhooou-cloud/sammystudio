import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

function env() {
  return {
    ASSETS: { fetch: async () => new Response('asset') },
    DB: { prepare: () => ({ run: async () => ({ success: true }) }) },
  };
}

test('returns health JSON and security headers', async () => {
  const response = await worker.fetch(new Request('https://site.test/api/health'), env(), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('project routes require a session', async () => {
  for (const [method, pathname] of [
    ['GET', '/api/projects'],
    ['POST', '/api/projects'],
    ['PATCH', '/api/projects/project-1'],
    ['GET', '/api/projects/project-1/workspace'],
  ]) {
    const response = await worker.fetch(new Request(`https://site.test${pathname}`, {
      method,
      headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ name: '项目' }),
    }), env(), {});
    assert.equal(response.status, 401, `${method} ${pathname}`);
  }
});
