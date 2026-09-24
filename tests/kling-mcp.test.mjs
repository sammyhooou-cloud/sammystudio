import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptJson } from '../src/crypto.js';
import { getKlingStatus } from '../src/kling-mcp.js';

test('capability discovery uses the documented no-argument tool and normalizes model arrays', async () => {
  const secret = 'test-encryption-key';
  const encrypted_token = await encryptJson({ access_token: 'test-token' }, secret);
  const env = { TOKEN_ENCRYPTION_KEY: secret, DB: { prepare: () => ({ first: async () => ({ encrypted_token, expires_at: Date.now() + 100_000 }) }) } };
  const calls = [];
  const fetcher = async (_url, options) => {
    const call = JSON.parse(options.body); calls.push(call);
    const value = call.params.name === 'who_am_i'
      ? { availableModels: { text_to_video: [{ model: 'kling-v1', arguments: [] }] } }
      : { credits: 10 };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { structuredContent: value } }));
  };
  const status = await getKlingStatus(env, fetcher);
  assert.deepEqual(calls[0].params.arguments, {});
  assert.equal(status.models.text_to_video.models[0].model, 'kling-v1');
});
