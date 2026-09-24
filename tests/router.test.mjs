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
