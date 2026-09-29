import test from 'node:test';
import assert from 'node:assert/strict';
import * as registry from '../src/providers/index.js';

let adapter = {};
try { adapter = await import('../src/providers/minimax.js'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const key = 'test-only-minimax-key';
const endpoint = 'https://api.minimax.io/v2/video_generation';
const queryEndpoint = 'https://api.minimax.io/v2/query/video_generation';
const input = { mode: 'text', model: 'MiniMax-H3', prompt: '海浪轻轻拍打岸边', duration: '6', resolution: '768P', aspectRatio: '16:9' };
const balanceLabel = '额度：控制台查看';
const ratios = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const maxImageSize = 15 * 1024 * 1024;
const maxResponseSize = 1024 * 1024;

function chunkedResponse(chunks, { headers, onCancel } = {}) {
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
    cancel() { onCancel?.(); },
  });
  return new Response(body, { headers });
}

function abortingResponse(signal) {
  return new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener('abort', () => controller.error(new Error(`${key} supplier-private-detail`)), { once: true });
    },
  }));
}

function provider(deps = {}, env = { MINIMAX_API_KEY: key }) {
  assert.equal(typeof adapter.createMiniMaxProvider, 'function', 'MiniMax provider adapter must exist');
  return adapter.createMiniMaxProvider(env, { fetcher: async () => { assert.fail('unexpected API request'); }, ...deps });
}

function reference(bytes = new Uint8Array([1, 2, 255]), overrides = {}) {
  return { filename: 'private-scene.png', mime_type: 'image/png', size: bytes.byteLength, object: { arrayBuffer: async () => bytes.buffer }, ...overrides };
}

function assertSafe(error, fields = {}) {
  assert.equal(error instanceof adapter.ProviderError, true);
  for (const [field, value] of Object.entries(fields)) assert.equal(error[field], value, field);
  assert.equal(error.message.includes(key), false);
  assert.equal(error.message.includes('supplier-private-detail'), false);
  assert.equal(JSON.stringify(error).includes(key), false);
  assert.equal(JSON.stringify(error).includes('supplier-private-detail'), false);
  return true;
}

test('MiniMax capabilities expose exact independent model choices for both modes', async () => {
  const instance = provider();
  assert.equal(instance.id, 'minimax');
  assert.equal(instance.persistOutput, true);
  assert.deepEqual(Object.keys(instance).sort(), ['capabilities', 'create', 'id', 'persistOutput', 'query', 'status']);
  const capabilities = await instance.capabilities();
  assert.equal(capabilities, adapter.minimaxCapabilities);
  assert.equal(Object.isFrozen(capabilities), true);
  assert.notEqual(capabilities.text_to_video.models, capabilities.image_to_video.models);
  for (const [mode, group] of Object.entries(capabilities)) {
    assert.deepEqual(group.models.map((model) => model.model), ['MiniMax-H3', 'MiniMax-H3-Max']);
    assert.equal(Object.isFrozen(group.models), true);
    for (const model of group.models) {
      const args = Object.fromEntries(model.arguments.map((argument) => [argument.name, argument]));
      assert.deepEqual(args.resolution.allowedValues, model.model === 'MiniMax-H3' ? ['768P', '2K'] : ['480P', '768P']);
      assert.deepEqual(args.duration.allowedValues, Array.from({ length: model.model === 'MiniMax-H3' ? 12 : 11 }, (_, i) => String(i + (model.model === 'MiniMax-H3' ? 4 : 5))));
      assert.deepEqual(args.aspect_ratio.allowedValues, mode === 'text_to_video' ? ratios : ['adaptive']);
      assert.equal(Object.isFrozen(args.duration.allowedValues), true);
      assert.equal(args.prompt.name, 'prompt');
      if (mode === 'image_to_video') assert.deepEqual(model.inputs, [{ name: 'first_frame', required: true }]);
    }
  }
});

test('MiniMax registry accepts both providers and rejects inherited or unknown IDs', () => {
  assert.deepEqual(registry.providerIds, ['kling', 'minimax']);
  assert.equal(Object.isFrozen(registry.providerIds), true);
  for (const id of ['unknown', 'toString', '__proto__', 'constructor', undefined]) assert.throws(() => registry.createVideoProvider(id, {}), { message: '视频供应商无效' });
  assert.equal(registry.createVideoProvider('kling', {}).id, 'kling');
  assert.equal(registry.createVideoProvider('minimax', {}).id, 'minimax');
});

test('MiniMax T2V submits exact JSON with numeric duration and Bearer headers', async () => {
  const raw = { task_id: 'remote-text' };
  const instance = provider({ fetcher: async (url, options) => {
    assert.equal(url, endpoint);
    assert.equal(options.method, 'POST');
    const headers = new Headers(options.headers);
    assert.equal(headers.get('authorization'), `Bearer ${key}`);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(options.signal instanceof AbortSignal, true);
    assert.deepEqual(JSON.parse(options.body), { model: 'MiniMax-H3', content: [{ type: 'text', text: input.prompt }], resolution: '768P', duration: 6, ratio: '16:9' });
    return Response.json(raw);
  } });
  const result = await instance.create({ input, traceId: 'not-a-supplier-field' });
  assert.deepEqual(result, { remoteId: 'remote-text', status: 'queued', raw });
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('MiniMax I2V embeds private bytes as a data URI and omits ratio', async () => {
  const instance = provider({ fetcher: async (url, options) => {
    assert.equal(url, endpoint);
    assert.deepEqual(JSON.parse(options.body), { model: 'MiniMax-H3-Max', content: [{ type: 'text', text: input.prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQL/' }, role: 'first_frame' }], resolution: '480P', duration: 5 });
    return Response.json({ task_id: 'remote-image' });
  } });
  assert.equal((await instance.create({ input: { ...input, mode: 'image', model: 'MiniMax-H3-Max', duration: '5', resolution: '480P', aspectRatio: 'adaptive' }, reference: reference() })).remoteId, 'remote-image');
});

test('MiniMax image encoding handles large byte arrays without Node Buffer', async () => {
  const bytes = new Uint8Array(200_000).fill(255);
  const expected = Buffer.from(bytes).toString('base64');
  const savedBuffer = globalThis.Buffer;
  const instance = provider({ fetcher: async (_url, options) => {
    assert.equal(JSON.parse(options.body).content[1].image_url.url, `data:image/webp;base64,${expected}`);
    return { ok: true, status: 200, headers: new Headers(), body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"task_id":"large-image"}')); controller.close(); } }), json: async () => ({ task_id: 'large-image' }) };
  } });
  try {
    globalThis.Buffer = undefined;
    await instance.create({ input: { ...input, mode: 'image', aspectRatio: 'adaptive' }, reference: reference(bytes, { mime_type: 'image/webp' }) });
  } finally { globalThis.Buffer = savedBuffer; }
});

test('MiniMax missing configuration fails before any API request', async () => {
  for (const env of [{}, { MINIMAX_API_KEY: '' }, { MINIMAX_API_KEY: '   ' }]) {
    await assert.rejects(() => provider({}, env).create({ input }), (error) => assertSafe(error, { code: 'provider_not_configured', httpStatus: 503, definitive: true, submissionState: 'failed' }));
    await assert.rejects(() => provider({}, env).query('task-1'), (error) => assertSafe(error, { code: 'provider_not_configured', definitive: true }));
  }
});

test('MiniMax unconfigured status never requests the API', async () => {
  assert.deepEqual(await provider({}, {}).status(), { connection: 'unconfigured', label: 'MiniMax 未配置', balanceLabel });
});

for (const [status, connection, label] of [[200, 'online', 'MiniMax 已连接'], [401, 'auth_error', 'MiniMax 认证失败'], [402, 'offline', 'MiniMax 暂不可用'], [429, 'offline', 'MiniMax 暂不可用'], [500, 'offline', 'MiniMax 暂不可用']]) {
  test(`MiniMax status maps HTTP ${status} without creating a paid task`, async () => {
    let calls = 0;
    const instance = provider({ fetcher: async (url, options) => {
      calls += 1;
      assert.equal(url, `${queryEndpoint}?page_num=1&page_size=1`);
      assert.equal(options.method, 'GET');
      assert.equal(options.body, undefined);
      assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${key}`);
      return Response.json({ supplier_message: `${key} supplier-private-detail` }, { status });
    } });
    assert.deepEqual(await instance.status(), { connection, label, balanceLabel });
    assert.equal(calls, 1);
  });
}

test('MiniMax status sanitizes network errors', async () => {
  const instance = provider({ fetcher: async () => { throw new Error(`${key} supplier-private-detail`); } });
  assert.deepEqual(await instance.status(), { connection: 'offline', label: 'MiniMax 暂不可用', balanceLabel });
});

for (const [status, code, definitive, submissionState] of [[400, 'invalid_parameters', true, 'failed'], [401, 'provider_auth_failed', true, 'failed'], [402, 'insufficient_balance', true, 'failed'], [422, 'invalid_parameters', true, 'failed'], [429, 'provider_unavailable', false, 'unknown'], ...[500, 501, 502, 503, 504, 599].map((status) => [status, 'provider_unavailable', false, 'unknown'])]) {
  test(`MiniMax create maps HTTP ${status} to safe ${submissionState} submission`, async () => {
    const instance = provider({ fetcher: async () => Response.json({ error: `${key} supplier-private-detail` }, { status }) });
    await assert.rejects(() => instance.create({ input }), (error) => assertSafe(error, { code, httpStatus: status, definitive, submissionState }));
  });
}

for (const [name, response] of [['missing task ID', {}], ['empty task ID', { task_id: '' }], ['invalid task ID', { task_id: {} }], ['null body', null], ['array body', []]]) {
  test(`MiniMax create keeps a successful response with ${name} ambiguous`, async () => {
    await assert.rejects(() => provider({ fetcher: async () => Response.json(response) }).create({ input }), (error) => assertSafe(error, { code: 'invalid_response', httpStatus: 200, definitive: false, submissionState: 'unknown' }));
  });
}

test('MiniMax create keeps malformed success JSON ambiguous', async () => {
  await assert.rejects(() => provider({ fetcher: async () => new Response(`${key} supplier-private-detail`, { status: 200 }) }).create({ input }), (error) => assertSafe(error, { code: 'invalid_response', httpStatus: 200, definitive: false, submissionState: 'unknown' }));
});

test('MiniMax create keeps a network failure ambiguous', async () => {
  await assert.rejects(() => provider({ fetcher: async () => { throw new Error(`${key} supplier-private-detail`); } }).create({ input }), (error) => assertSafe(error, { code: 'provider_unavailable', httpStatus: 503, definitive: false, submissionState: 'unknown' }));
});

test('MiniMax create keeps a timeout ambiguous', async () => {
  const instance = provider({ timeoutMs: 5, fetcher: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(`${key} supplier-private-detail`)), { once: true })) });
  await assert.rejects(() => instance.create({ input }), (error) => assertSafe(error, { code: 'provider_unavailable', httpStatus: 504, definitive: false, submissionState: 'unknown' }));
});

test('MiniMax create keeps a timeout reading success JSON ambiguous', async () => {
  const instance = provider({ timeoutMs: 5, fetcher: async (_url, { signal }) => abortingResponse(signal) });
  await assert.rejects(() => instance.create({ input }), (error) => assertSafe(error, { code: 'provider_unavailable', httpStatus: 504, definitive: false, submissionState: 'unknown' }));
});

test('MiniMax create discards supplier metadata from loggable results', async () => {
  const result = await provider({ fetcher: async () => Response.json({ task_id: 'task-1', headers: { authorization: `Bearer ${key}` }, api_key: key, detail: 'supplier-private-detail' }) }).create({ input });
  assert.deepEqual(result.raw, { task_id: 'task-1' });
  assert.equal(JSON.stringify(result).includes(key), false);
  await assert.rejects(() => provider({ fetcher: async () => Response.json({ task_id: key }) }).create({ input }), (error) => assertSafe(error, { code: 'invalid_response', submissionState: 'unknown' }));
});

test('MiniMax status maps an aborted connection check to offline', async () => {
  const instance = provider({ timeoutMs: 5, fetcher: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('supplier-private-detail')), { once: true })) });
  assert.deepEqual(await instance.status(), { connection: 'offline', label: 'MiniMax 暂不可用', balanceLabel });
});

test('MiniMax query classifies response-body timeouts safely', async () => {
  const instance = provider({ timeoutMs: 5, fetcher: async (_url, { signal }) => abortingResponse(signal) });
  await assert.rejects(() => instance.query('task-1'), (error) => assertSafe(error, { code: 'provider_unavailable', httpStatus: 504, definitive: false }));
});

test('MiniMax query encodes the task ID and returns the parsed task only', async () => {
  const remoteId = 'task /?#&中文';
  const task = { id: remoteId, model: 'MiniMax-H3', status: 'succeeded', content: { url: 'https://cdn.test/result.mp4' }, resolution: '768P', duration: 6, ratio: '16:9' };
  const instance = provider({ fetcher: async (url, options) => {
    assert.equal(url, `${queryEndpoint}/${encodeURIComponent(remoteId)}`);
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${key}`);
    return Response.json({ task, supplier_message: `${key} supplier-private-detail` });
  } });
  assert.deepEqual(await instance.query(remoteId), { status: 'succeeded', raw: task, outputUrl: task.content.url, error: null });
});

for (const [remoteStatus, status] of [['queued', 'queued'], ['running', 'generating'], ['succeeded', 'succeeded'], ['failed', 'failed'], ['cancelled', 'failed'], ['unexpected', 'queued'], [undefined, 'queued']]) {
  test(`MiniMax query maps ${remoteStatus} and gates the output URL on success`, async () => {
    const task = { id: 'task-1', status: remoteStatus, content: { url: 'https://cdn.test/result.mp4' } };
    const result = await provider({ fetcher: async () => Response.json({ task }) }).query('task-1');
    assert.equal(result.status, status);
    assert.equal(result.outputUrl, status === 'succeeded' ? task.content.url : null);
    assert.equal(result.error, status === 'failed' ? 'MiniMax 视频生成失败' : null);
  });
}

test('MiniMax failed query sanitizes the supplier error', async () => {
  const result = await provider({ fetcher: async () => Response.json({ task: { id: 'task-1', status: 'failed', error: { message: `${key} supplier-private-detail` } } }) }).query('task-1');
  assert.equal(result.error, 'MiniMax 视频生成失败');
  assert.equal(result.outputUrl, null);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(JSON.stringify(result).includes('supplier-private-detail'), false);
});

for (const [name, body] of [['missing task', {}], ['null task', { task: null }], ['array task', { task: [] }], ['mismatched task ID', { task: { id: 'another-task', status: 'succeeded' } }], ['invalid task ID', { task: { id: {}, status: 'succeeded' } }]]) {
  test(`MiniMax query rejects ${name}`, async () => {
    await assert.rejects(() => provider({ fetcher: async () => Response.json(body) }).query('task-1'), (error) => assertSafe(error, { code: 'invalid_response', httpStatus: 200 }));
  });
}

test('MiniMax query handles a task without an echoed ID', async () => {
  const result = await provider({ fetcher: async () => Response.json({ task: { status: 'running' } }) }).query('task-1');
  assert.equal(result.status, 'generating');
});

test('MiniMax query sanitizes malformed JSON and HTTP errors', async () => {
  await assert.rejects(() => provider({ fetcher: async () => new Response('supplier-private-detail') }).query('task-1'), (error) => assertSafe(error, { code: 'invalid_response' }));
  for (const [status, code] of [[401, 'provider_auth_failed'], [500, 'provider_unavailable']]) await assert.rejects(() => provider({ fetcher: async () => Response.json({ error: `${key} supplier-private-detail` }, { status }) }).query('task-1'), (error) => assertSafe(error, { code, httpStatus: status }));
  await assert.rejects(() => provider({ fetcher: async () => { throw new Error(`${key} supplier-private-detail`); } }).query('task-1'), (error) => assertSafe(error, { code: 'provider_unavailable' }));
});

test('MiniMax validates prompt and generation parameters before dispatch', async () => {
  for (const change of [{ mode: 'unknown' }, { model: 'unknown' }, { prompt: '' }, { prompt: '   ' }, { prompt: null }, { prompt: 42 }, { prompt: 'a'.repeat(7001) }, { duration: '3' }, { duration: '16' }, { duration: 4.5 }, { duration: '' }, { duration: true }, { duration: '6junk' }, { resolution: '480P' }, { resolution: '1080P' }, { aspectRatio: 'adaptive' }, { aspectRatio: undefined }, { aspectRatio: '2:1' }, { model: 'MiniMax-H3-Max', resolution: '2K' }, { model: 'MiniMax-H3-Max', duration: '4' }]) {
    await assert.rejects(() => provider().create({ input: { ...input, ...change } }), (error) => assertSafe(error, { code: 'invalid_parameters', httpStatus: 400, definitive: true, submissionState: 'failed' }));
  }
  await assert.rejects(() => provider().create({}), (error) => assertSafe(error, { code: 'invalid_parameters', submissionState: 'failed' }));
  await assert.rejects(() => provider().query(''), (error) => assertSafe(error, { code: 'invalid_parameters' }));
});

test('MiniMax accepts model boundaries and concrete text ratios', async () => {
  const instance = provider({ fetcher: async () => Response.json({ task_id: 'accepted' }) });
  for (const [model, resolution, durations] of [['MiniMax-H3', '2K', [4, 15]], ['MiniMax-H3-Max', '480P', [5, 15]]]) for (const duration of durations) for (const aspectRatio of ratios) {
    assert.equal((await instance.create({ input: { ...input, model, resolution, duration, aspectRatio, prompt: 'a'.repeat(7000) } })).remoteId, 'accepted');
  }
});

test('MiniMax counts Unicode characters for its 7000-character prompt limit', async () => {
  const instance = provider({ fetcher: async () => Response.json({ task_id: 'unicode-prompt' }) });
  assert.equal((await instance.create({ input: { ...input, prompt: '🙂'.repeat(7000) } })).remoteId, 'unicode-prompt');
  await assert.rejects(() => provider().create({ input: { ...input, prompt: '🙂'.repeat(7001) } }), (error) => assertSafe(error, { code: 'invalid_parameters', submissionState: 'failed' }));
});

test('MiniMax validates private references before dispatch', async () => {
  const imageInput = { ...input, mode: 'image', aspectRatio: 'adaptive' };
  for (const invalid of [undefined, {}, reference(new Uint8Array()), reference(undefined, { mime_type: 'image/gif' }), reference(undefined, { size: maxImageSize + 1 }), reference(undefined, { size: -1 }), reference(undefined, { size: 0 }), reference(undefined, { object: {} }), reference(undefined, { object: { arrayBuffer: async () => { throw new Error(`${key} supplier-private-detail`); } } }), reference(undefined, { object: { arrayBuffer: async () => 'bad' } }), reference(new Uint8Array(maxImageSize + 1), { size: 3 })]) {
    await assert.rejects(() => provider().create({ input: imageInput, reference: invalid }), (error) => assertSafe(error, { code: 'invalid_parameters', definitive: true, submissionState: 'failed' }));
  }
});

test('MiniMax accepts JPEG, PNG and WebP reference MIME types', async () => {
  for (const mime_type of ['image/jpeg', 'image/png', 'image/webp']) {
    const instance = provider({ fetcher: async (_url, options) => {
      assert.equal(JSON.parse(options.body).content[1].image_url.url, `data:${mime_type};base64,AQL/`);
      return Response.json({ task_id: 'mime-accepted' });
    } });
    await instance.create({ input: { ...input, mode: 'image', aspectRatio: 'adaptive' }, reference: reference(undefined, { mime_type }) });
  }
});

test('MiniMax accepts the 15MB reference boundary within the 64MB request limit', async () => {
  const bytes = new Uint8Array(maxImageSize).fill(1);
  const instance = provider({ fetcher: async (_url, options) => {
    assert.equal(new TextEncoder().encode(options.body).byteLength < 64 * 1024 * 1024, true);
    const dataUri = JSON.parse(options.body).content[1].image_url.url;
    assert.equal(dataUri.length, 'data:image/png;base64,'.length + 4 * Math.ceil(maxImageSize / 3));
    return Response.json({ task_id: 'max-size-image' });
  } });
  assert.equal((await instance.create({ input: { ...input, mode: 'image', aspectRatio: 'adaptive' }, reference: reference(bytes) })).remoteId, 'max-size-image');
});

for (const operation of ['create', 'query']) {
  const call = (instance) => operation === 'create' ? instance.create({ input }) : instance.query('task-1');
  const acceptedBody = operation === 'create' ? { task_id: 'task-1' } : { task: { id: 'task-1', status: 'running', model: '海浪🙂' } };

  test(`MiniMax ${operation} rejects declared oversized JSON before reading`, async () => {
    let cancelled = false;
    let reads = 0;
    const response = chunkedResponse([new TextEncoder().encode(JSON.stringify(acceptedBody))], { headers: { 'content-length': String(maxResponseSize + 1) }, onCancel: () => { cancelled = true; } });
    const getReader = response.body.getReader.bind(response.body);
    response.body.getReader = (...args) => { reads += 1; return getReader(...args); };
    const instance = provider({ fetcher: async () => response });
    await assert.rejects(() => call(instance), (error) => assertSafe(error, { code: 'invalid_response', httpStatus: 200, definitive: false, ...(operation === 'create' ? { submissionState: 'unknown' } : {}) }));
    assert.equal(reads, 0);
    assert.equal(cancelled, true);
  });

  test(`MiniMax ${operation} cancels chunked JSON once cumulative bytes exceed 1 MiB`, async () => {
    let cancelled = false;
    const body = JSON.stringify({ ...acceptedBody, padding: 'x'.repeat(maxResponseSize) });
    const bytes = new TextEncoder().encode(body);
    const response = chunkedResponse([bytes.subarray(0, 600_000), bytes.subarray(600_000, 1_050_000), bytes.subarray(1_050_000)], { onCancel: () => { cancelled = true; } });
    const instance = provider({ fetcher: async () => response });
    await assert.rejects(() => call(instance), (error) => assertSafe(error, { code: 'invalid_response', httpStatus: 200, definitive: false, ...(operation === 'create' ? { submissionState: 'unknown' } : {}) }));
    assert.equal(cancelled, true);
  });

  test(`MiniMax ${operation} parses streamed JSON without unbounded convenience methods`, async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(acceptedBody));
    const response = chunkedResponse(Array.from(bytes, (byte) => new Uint8Array([byte])));
    for (const method of ['json', 'text', 'arrayBuffer']) response[method] = async () => { assert.fail(`${method} must not read a supplier response`); };
    const result = await call(provider({ fetcher: async () => response }));
    if (operation === 'create') assert.equal(result.remoteId, 'task-1');
    else assert.deepEqual(result, { status: 'generating', raw: acceptedBody.task, outputUrl: null, error: null });
  });
}

test('MiniMax accepts valid JSON exactly at the response byte limit', async () => {
  const prefix = '{"task_id":"at-limit","padding":"';
  const suffix = '"}';
  const bytes = new TextEncoder().encode(prefix + 'x'.repeat(maxResponseSize - prefix.length - suffix.length) + suffix);
  assert.equal(bytes.byteLength, maxResponseSize);
  const response = chunkedResponse([bytes], { headers: { 'content-length': String(maxResponseSize) } });
  assert.equal((await provider({ fetcher: async () => response }).create({ input })).remoteId, 'at-limit');
});

test('MiniMax rejects a response without a readable byte stream', async () => {
  const response = { ok: true, status: 200, headers: new Headers(), body: null, json: async () => ({ task_id: 'unbounded-fallback' }) };
  await assert.rejects(() => provider({ fetcher: async () => response }).create({ input }), (error) => assertSafe(error, { code: 'invalid_response', submissionState: 'unknown' }));
});

test('MiniMax status rejects declared oversized list responses safely', async () => {
  let cancelled = false;
  const response = chunkedResponse([new Uint8Array([123, 125])], { headers: { 'content-length': String(maxResponseSize + 1) }, onCancel: () => { cancelled = true; } });
  assert.deepEqual(await provider({ fetcher: async () => response }).status(), { connection: 'offline', label: 'MiniMax 暂不可用', balanceLabel });
  assert.equal(cancelled, true);
});

test('MiniMax classifies a response stream network failure as provider unavailable', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new TypeError(`${key} supplier-private-detail`)); } }));
  await assert.rejects(() => provider({ fetcher: async () => response }).create({ input }), (error) => assertSafe(error, { code: 'provider_unavailable', httpStatus: 503, definitive: false, submissionState: 'unknown' }));
});
