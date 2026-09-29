import { callTool, getKlingStatus, toolData } from '../kling-mcp.js';

function controlledError(message, status, submissionState) {
  const error = new Error(message);
  error.status = status;
  if (submissionState) error.submissionState = submissionState;
  return error;
}

function generationArguments(model, input) {
  const values = { prompt: input.prompt || '', duration: input.duration, resolution: input.resolution, aspect_ratio: input.aspectRatio, imageCount: input.imageCount };
  return (model?.arguments || []).filter(({ name }) => Object.hasOwn(values, name) && values[name] != null)
    .map(({ name }) => ({ name, value: String(values[name]) }));
}

function normalizeRemoteStatus(raw) {
  const status = String(raw || '').toUpperCase();
  if (['COMPLETED', 'PARTIAL_COMPLETED', 'SUCCEED', 'SUCCEEDED', 'SUCCESS'].includes(status)) return 'succeeded';
  if (['FAILED', 'FAIL', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status)) return 'failed';
  if (['RUNNING', 'PROCESSING', 'GENERATING'].includes(status)) return 'generating';
  return 'queued';
}

export function createKlingProvider(env, deps = {}) {
  const fetcher = deps.fetcher || fetch;
  const toolCaller = deps.toolCaller || callTool;
  const statusSource = deps.statusSource || getKlingStatus;
  let models;

  async function status() {
    return statusSource(env, fetcher);
  }

  async function capabilities() {
    if (models) return models;
    const source = deps.capabilitiesSource;
    if (source && typeof source !== 'function') {
      models = source;
      return models;
    }
    const current = await (typeof source === 'function' ? source() : status());
    if (current.connection !== 'online') throw controlledError('请先连接可灵 MCP', 409);
    models = current.models;
    return models;
  }

  async function create({ input, reference, traceId }) {
    const available = await capabilities();
    const group = input.mode === 'text' ? available.text_to_video : available.image_to_video;
    const modelSpec = group?.models?.find(({ model }) => model === input.model);
    let paidStarted = false;
    try {
      let raw;
      if (input.mode === 'text') {
        paidStarted = true;
        raw = toolData(await toolCaller(env, 'text_to_video', { model: input.model, taskTraceId: traceId, arguments: generationArguments(modelSpec, input) }, fetcher));
      } else {
        const filename = reference.filename || 'reference-image';
        const uploaded = toolData(await toolCaller(env, 'file_upload', { filename, contentType: reference.mime_type, size: reference.size, taskTraceId: traceId }, fetcher));
        let imageUrl = uploaded.url;
        if (!imageUrl) {
          if (!uploaded.ticket || !/^https:\/\//.test(uploaded.uploadUrl || '')) throw new Error('upload_ticket_invalid');
          const form = new FormData();
          form.append('ticket', uploaded.ticket);
          form.append('file', new Blob([await reference.object.arrayBuffer()], { type: reference.mime_type || 'image/png' }), filename);
          const response = await fetcher(uploaded.uploadUrl, { method: 'POST', body: form });
          if (!response.ok) throw new Error('upload_failed');
          const body = await response.json();
          imageUrl = body.url || body.data?.url;
        }
        if (!/^https:\/\//.test(imageUrl || '')) throw new Error('upload_url_invalid');
        const imageInputs = modelSpec.inputs || [];
        const inputName = imageInputs.find((item) => item.required)?.name || imageInputs[0]?.name || 'input';
        paidStarted = true;
        raw = toolData(await toolCaller(env, 'image_to_video', { model: input.model, taskTraceId: traceId, arguments: generationArguments(modelSpec, input), inputs: [{ name: inputName, inputType: 'URL', url: imageUrl }] }, fetcher));
      }
      const remoteId = raw?.generationId || raw?.taskId || raw?.task_id || raw?.id || null;
      if (!remoteId) throw new Error('generation_id_missing');
      return { remoteId, status: 'queued', raw };
    } catch {
      if (!paidStarted) throw controlledError('参考图上传失败', 502, 'failed');
      throw controlledError('提交结果未确认，请勿重新创建任务；请联系管理员核对可灵记录', 502, 'unknown');
    }
  }

  async function query(remoteId) {
    try {
      const raw = toolData(await toolCaller(env, 'query_tasks', { generationId: remoteId }, fetcher));
      if (!raw || raw.isError || (raw.generationId && raw.generationId !== remoteId)) throw new Error('generation_result_invalid');
      const outputUrl = raw.works?.find?.((work) => work.contentType === 'video')?.url || null;
      return { status: normalizeRemoteStatus(raw.status), raw, outputUrl };
    } catch {
      throw controlledError('任务状态暂不可用', 503);
    }
  }

  return { id: 'kling', persistOutput: false, status, capabilities, create, query };
}
