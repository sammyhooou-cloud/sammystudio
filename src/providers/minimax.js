const API_URL = 'https://api.minimax.io/v2/video_generation';
const QUERY_URL = 'https://api.minimax.io/v2/query/video_generation';
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const BALANCE_LABEL = '额度：控制台查看';
const INSUFFICIENT_BALANCE_LABEL = '额度不足，请前往控制台查看';
const FAILURE_MESSAGE = 'MiniMax 视频生成失败';
const ERROR_MESSAGES = Object.freeze({
  provider_not_configured: '请配置 MiniMax API Key',
  invalid_parameters: 'MiniMax 生成参数或参考图无效',
  provider_auth_failed: 'MiniMax 认证失败，请检查服务端配置',
  insufficient_balance: 'MiniMax 额度不足，请前往控制台查看',
  provider_unavailable: 'MiniMax 暂不可用，提交结果未确认，请勿重新创建任务',
  invalid_response: 'MiniMax 返回结果未确认，请勿重新创建任务',
});

export class ProviderError extends Error {
  constructor(code, { httpStatus = 503, definitive = false, submissionState } = {}) {
    super(ERROR_MESSAGES[code] || 'MiniMax 暂不可用');
    this.name = 'ProviderError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.definitive = definitive;
    if (submissionState) this.submissionState = submissionState;
  }
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function modelSpecs(image) {
  return [['MiniMax-H3', ['768P', '2K'], 4], ['MiniMax-H3-Max', ['480P', '768P'], 5]].map(([model, resolutions, minimum]) => ({
    model,
    arguments: [
      { name: 'prompt' },
      { name: 'resolution', allowedValues: resolutions },
      { name: 'duration', allowedValues: Array.from({ length: 16 - minimum }, (_, index) => String(index + minimum)) },
      { name: 'aspect_ratio', allowedValues: image ? ['adaptive'] : [...RATIOS] },
    ],
    ...(image ? { inputs: [{ name: 'first_frame', required: true }] } : {}),
  }));
}

export const minimaxCapabilities = freeze({
  text_to_video: { models: modelSpecs(false) },
  image_to_video: { models: modelSpecs(true) },
});

function invalidInput() {
  return new ProviderError('invalid_parameters', { httpStatus: 400, definitive: true, submissionState: 'failed' });
}

function validPrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return false;
  let length = 0;
  for (const character of prompt) {
    length += 1;
    if (length > 7000) return false;
  }
  return true;
}

function validateInput(input) {
  if (!input || !['text', 'image'].includes(input.mode)) throw invalidInput();
  const group = input.mode === 'text' ? minimaxCapabilities.text_to_video : minimaxCapabilities.image_to_video;
  const spec = group.models.find(({ model }) => model === input.model);
  if (!spec || !validPrompt(input.prompt)) throw invalidInput();
  const args = Object.fromEntries(spec.arguments.map((argument) => [argument.name, argument]));
  if (!['string', 'number'].includes(typeof input.duration) || !args.duration.allowedValues.includes(String(input.duration))) throw invalidInput();
  if (!args.resolution.allowedValues.includes(input.resolution)) throw invalidInput();
  if (input.mode === 'text' && !RATIOS.includes(input.aspectRatio)) throw invalidInput();
  return { model: input.model, content: [{ type: 'text', text: input.prompt }], resolution: input.resolution, duration: Number(input.duration), ...(input.mode === 'text' ? { ratio: input.aspectRatio } : {}) };
}

async function imageDataUri(reference) {
  if (!reference || !IMAGE_MIME_TYPES.includes(reference.mime_type) || !Number.isInteger(reference.size) || reference.size <= 0 || reference.size > MAX_IMAGE_BYTES || typeof reference.object?.arrayBuffer !== 'function') throw invalidInput();
  try {
    const buffer = await reference.object.arrayBuffer();
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= 0 || buffer.byteLength > MAX_IMAGE_BYTES || buffer.byteLength !== reference.size) throw invalidInput();
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    return `data:${reference.mime_type};base64,${btoa(chunks.join(''))}`;
  } catch {
    throw invalidInput();
  }
}

function httpError(status, submission) {
  const code = ({ 400: 'invalid_parameters', 401: 'provider_auth_failed', 402: 'insufficient_balance', 422: 'invalid_parameters' })[status] || 'provider_unavailable';
  const definitive = [400, 401, 402, 422].includes(status);
  return new ProviderError(code, { httpStatus: status, definitive, ...(submission ? { submissionState: definitive ? 'failed' : 'unknown' } : {}) });
}

function normalizedStatus(status) {
  if (status === 'running') return 'generating';
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  return 'queued';
}

function safeTask(task, apiKey) {
  const raw = {};
  const redact = (value) => typeof value === 'string' ? value.split(apiKey).join('[REDACTED]') : value;
  for (const field of ['id', 'model', 'status', 'resolution', 'duration', 'ratio']) {
    if (Object.hasOwn(task, field) && ['string', 'number'].includes(typeof task[field])) raw[field] = redact(task[field]);
  }
  if (task.content && typeof task.content === 'object' && !Array.isArray(task.content)) {
    raw.content = typeof task.content.url === 'string' ? { url: redact(task.content.url) } : {};
  }
  if (Object.hasOwn(task, 'error')) raw.error = FAILURE_MESSAGE;
  return raw;
}

function cancelStream(stream) {
  try { stream?.cancel().catch(() => {}); } catch {}
}

function assertResponseLength(response, invalidResponse) {
  const declaredLength = response.headers.get('content-length')?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    cancelStream(response.body);
    throw invalidResponse();
  }
}

async function readResponseJson(response, invalidResponse) {
  if (typeof response.body?.getReader !== 'function') throw invalidResponse();
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || length + value.byteLength > MAX_RESPONSE_BYTES) {
        cancelStream(reader);
        throw invalidResponse();
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { throw invalidResponse(); }
  } finally { reader.releaseLock(); }
}

export function createMiniMaxProvider(env = {}, deps = {}) {
  const fetcher = deps.fetcher || fetch;
  const timeoutMs = deps.timeoutMs ?? 30_000;

  function apiKey() {
    const key = typeof env.MINIMAX_API_KEY === 'string' ? env.MINIMAX_API_KEY.trim() : '';
    if (!key) throw new ProviderError('provider_not_configured', { httpStatus: 503, definitive: true, submissionState: 'failed' });
    return key;
  }

  async function request(url, { body, checkStatus = false } = {}) {
    const key = apiKey();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetcher(url, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        signal: controller.signal,
        redirect: 'error',
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (checkStatus && response.status !== 200) { cancelStream(response.body); return response.status; }
      if (!checkStatus && !response.ok) { cancelStream(response.body); throw httpError(response.status, Boolean(body)); }
      const invalidResponse = () => new ProviderError('invalid_response', { httpStatus: response.status, ...(body ? { submissionState: 'unknown' } : {}) });
      assertResponseLength(response, invalidResponse);
      if (checkStatus) { cancelStream(response.body); return response.status; }
      return { payload: await readResponseJson(response, invalidResponse), httpStatus: response.status };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('provider_unavailable', { httpStatus: timedOut ? 504 : 503, ...(body ? { submissionState: 'unknown' } : {}) });
    } finally { clearTimeout(timer); }
  }

  async function status() {
    try { apiKey(); }
    catch { return { connection: 'unconfigured', label: 'MiniMax 未配置', balanceLabel: BALANCE_LABEL }; }
    try {
      const code = await request(`${QUERY_URL}?page_num=1&page_size=1`, { checkStatus: true });
      if (code === 200) return { connection: 'online', label: 'MiniMax 已连接', balanceLabel: BALANCE_LABEL };
      if (code === 401) return { connection: 'auth_error', label: 'MiniMax 认证失败', balanceLabel: BALANCE_LABEL };
      if (code === 402) return { connection: 'offline', label: `MiniMax ${INSUFFICIENT_BALANCE_LABEL}`, balanceLabel: INSUFFICIENT_BALANCE_LABEL };
    } catch {}
    return { connection: 'offline', label: 'MiniMax 暂不可用', balanceLabel: BALANCE_LABEL };
  }

  async function capabilities() { return minimaxCapabilities; }

  async function create({ input, reference } = {}) {
    const key = apiKey();
    const body = validateInput(input);
    if (input.mode === 'image') body.content.push({ type: 'image_url', image_url: { url: await imageDataUri(reference) }, role: 'first_frame' });
    const { payload, httpStatus } = await request(API_URL, { body });
    if (!payload || Array.isArray(payload) || typeof payload.task_id !== 'string' || !payload.task_id.trim() || payload.task_id.includes(key)) throw new ProviderError('invalid_response', { httpStatus, submissionState: 'unknown' });
    return { remoteId: payload.task_id, status: 'queued', raw: { task_id: payload.task_id } };
  }

  async function query(remoteId) {
    const key = apiKey();
    if (typeof remoteId !== 'string' || !remoteId.trim()) throw invalidInput();
    const { payload, httpStatus } = await request(`${QUERY_URL}/${encodeURIComponent(remoteId)}`);
    const task = payload?.task;
    if (!task || typeof task !== 'object' || Array.isArray(task) || (Object.hasOwn(task, 'id') && task.id !== remoteId)) throw new ProviderError('invalid_response', { httpStatus });
    const status = normalizedStatus(task.status);
    const raw = safeTask(task, key);
    const outputUrl = status === 'succeeded' && typeof raw.content?.url === 'string' ? raw.content.url : null;
    return { status, raw, outputUrl, error: status === 'failed' ? FAILURE_MESSAGE : null };
  }

  return { id: 'minimax', persistOutput: true, status, capabilities, create, query };
}
