import test from 'node:test';
import assert from 'node:assert/strict';

import * as registry from '../src/providers/index.js';
import * as adapter from '../src/providers/kling.js';
const models = {
  text_to_video: { models: [{ model: 'kling-v1', arguments: [{ name: 'prompt' }, { name: 'duration' }] }] },
  image_to_video: { models: [{ model: 'kling-v1', arguments: [{ name: 'duration' }], inputs: [{ name: 'optional' }, { name: 'first_frame', required: true }] }] },
};
const input = { mode: 'text', model: 'kling-v1', prompt: 'ocean', duration: '5', resolution: '720p', aspectRatio: '16:9', imageCount: '1' };
function provider(deps = {}) {
  assert.equal(typeof adapter.createKlingProvider, 'function', 'Kling provider adapter must exist');
  return adapter.createKlingProvider({}, { capabilitiesSource: models, ...deps });
}

test('provider registry contains Kling and MiniMax and rejects unknown or inherited IDs', () => {
  assert.equal(typeof registry.createVideoProvider, 'function', 'provider registry must exist');
  assert.deepEqual(registry.providerIds, ['kling', 'minimax']);
  assert.equal(Object.isFrozen(registry.providerIds), true);
  for (const id of ['unknown', 'toString', '__proto__', undefined]) {
    assert.throws(() => registry.createVideoProvider(id, {}), { message: '视频供应商无效' });
  }
  assert.equal(registry.createVideoProvider('kling', {}).id, 'kling');
  assert.equal(registry.createVideoProvider('minimax', {}).id, 'minimax');
});

test('Kling adapter exposes the fixed provider contract and injectable status source', async () => {
  const online = { connection: 'online', models, credits: 20 };
  const instance = provider({ statusSource: async () => online });
  assert.deepEqual(Object.keys(instance).sort(), ['capabilities', 'create', 'id', 'persistOutput', 'query', 'status']);
  assert.equal(instance.id, 'kling');
  assert.equal(instance.persistOutput, false);
  assert.deepEqual(await instance.status(), online);
});

test('Kling capabilities reject offline status with the controlled connection error', async () => {
  const instance = provider({ capabilitiesSource: async () => ({ connection: 'offline', message: 'private failure' }) });
  await assert.rejects(() => instance.capabilities(), (error) => error.message === '请先连接可灵 MCP' && error.status === 409 && !error.message.includes('private'));
});

test('Kling create normalizes remote IDs and filters undeclared model arguments', async () => {
  const raw = { task_id: 'remote-text', status: 'submitted' };
  const instance = provider({ toolCaller: async (_env, name, args) => {
    assert.equal(name, 'text_to_video');
    assert.deepEqual(args, { model: 'kling-v1', taskTraceId: 'trace', arguments: [{ name: 'prompt', value: 'ocean' }, { name: 'duration', value: '5' }] });
    return { structuredContent: raw };
  } });
  assert.deepEqual(await instance.create({ input, traceId: 'trace' }), { remoteId: 'remote-text', status: 'queued', raw });
});

test('Kling create keeps a missing task ID and paid response loss ambiguous', async () => {
  for (const toolCaller of [async () => ({ status: 'accepted' }), async () => { throw new Error('provider secret'); }]) {
    await assert.rejects(() => provider({ toolCaller }).create({ input, traceId: 'trace' }), (error) => error.submissionState === 'unknown' && !error.message.includes('secret'));
  }
});

test('Kling image ticket uploads original bytes before the paid call and uses the required input', async () => {
  let uploaded = false;
  const instance = provider({
    fetcher: async (url, options) => {
      assert.equal(url, 'https://upload.test/image');
      assert.equal(options.method, 'POST');
      assert.equal(options.body.get('ticket'), 'ticket-1');
      const file = options.body.get('file');
      assert.equal(file.name, 'scene.png');
      assert.equal(file.type, 'image/png');
      assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 255]);
      uploaded = true;
      return Response.json({ data: { url: 'https://cdn.test/scene.png' } });
    },
    toolCaller: async (_env, name, args) => {
      if (name === 'file_upload') {
        assert.deepEqual(args, { filename: 'scene.png', contentType: 'image/png', size: 3, taskTraceId: 'trace' });
        return { ticket: 'ticket-1', uploadUrl: 'https://upload.test/image' };
      }
      assert.equal(name, 'image_to_video');
      assert.equal(uploaded, true);
      assert.deepEqual(args.inputs, [{ name: 'first_frame', inputType: 'URL', url: 'https://cdn.test/scene.png' }]);
      return { generationId: 'remote-image' };
    },
  });
  const reference = { filename: 'scene.png', mime_type: 'image/png', size: 3, object: { arrayBuffer: async () => new Uint8Array([1, 2, 255]).buffer } };
  assert.equal((await instance.create({ input: { ...input, mode: 'image' }, reference, traceId: 'trace' })).remoteId, 'remote-image');
});

test('Kling image direct URL skips the byte upload and preserves the default input name', async () => {
  const imageModels = { image_to_video: { models: [{ model: 'kling-v1', arguments: [] }] } };
  const calls = [];
  const instance = provider({ capabilitiesSource: imageModels, fetcher: async () => { assert.fail('ticket upload must not run'); }, toolCaller: async (_env, name, args) => {
    calls.push(name);
    if (name === 'file_upload') return { url: 'https://cdn.test/direct.png' };
    assert.deepEqual(args.inputs, [{ name: 'input', inputType: 'URL', url: 'https://cdn.test/direct.png' }]);
    return { id: 'remote-direct' };
  } });
  await instance.create({ input: { ...input, mode: 'image' }, reference: {}, traceId: 'trace' });
  assert.deepEqual(calls, ['file_upload', 'image_to_video']);
});

test('Kling upload failure is controlled and happens before a paid call', async () => {
  const calls = [];
  const instance = provider({ toolCaller: async (_env, name) => { calls.push(name); return { ticket: 'secret', uploadUrl: 'http://invalid' }; } });
  await assert.rejects(() => instance.create({ input: { ...input, mode: 'image' }, reference: {}, traceId: 'trace' }), (error) => error.submissionState === 'failed' && error.message === '参考图上传失败');
  assert.deepEqual(calls, ['file_upload']);
});

test('Kling query normalizes status and exposes the output URL without changing raw result', async () => {
  const raw = { generationId: 'remote-1', status: 'PARTIAL_COMPLETED', works: [{ contentType: 'video', url: 'https://cdn.test/video.mp4' }] };
  const instance = provider({ toolCaller: async (_env, name, args) => {
    assert.equal(name, 'query_tasks');
    assert.deepEqual(args, { generationId: 'remote-1' });
    return { content: [{ type: 'text', text: JSON.stringify(raw) }] };
  } });
  assert.deepEqual(await instance.query('remote-1'), { status: 'succeeded', raw, outputUrl: 'https://cdn.test/video.mp4' });
});

test('Kling query preserves all status aliases', async () => {
  for (const [aliases, normalized] of [[['COMPLETED', 'PARTIAL_COMPLETED', 'SUCCEED', 'SUCCEEDED', 'SUCCESS'], 'succeeded'], [['FAILED', 'FAIL', 'ERROR', 'CANCELLED', 'CANCELED'], 'failed'], [['RUNNING', 'PROCESSING', 'GENERATING'], 'generating'], [['PENDING', undefined], 'queued']]) {
    for (const status of aliases) {
      const result = await provider({ toolCaller: async () => ({ status }) }).query('remote-1');
      assert.equal(result.status, normalized, String(status));
    }
  }
});

test('Kling query rejects malformed or mismatched responses and sanitizes raw errors', async () => {
  for (const response of [null, { isError: true }, { generationId: 'another-task', status: 'COMPLETED' }]) {
    await assert.rejects(() => provider({ toolCaller: async () => response }).query('remote-1'), (error) => error.message === '任务状态暂不可用' && error.status === 503);
  }
  await assert.rejects(() => provider({ toolCaller: async () => { throw new Error('secret token'); } }).query('remote-1'), { message: '任务状态暂不可用' });
});
