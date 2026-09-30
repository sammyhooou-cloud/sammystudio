import { normalizeTaskStatus, parseTaskRequest, parseTaskResult, safeVideoUrl, taskProgress, taskProviderLabel } from './task-presenter.js';

export function parseResultRoute(pathname) {
  if (typeof pathname !== 'string') return null;
  const match = /^\/projects\/([^/?#]+)\/results\/([^/?#]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const projectId = decodeURIComponent(match[1]);
    const taskId = decodeURIComponent(match[2]);
    return projectId && taskId ? { projectId, taskId } : null;
  } catch { return null; }
}

export function resultViewModel(detail) {
  const status = normalizeTaskStatus(detail?.status);
  const result = parseTaskResult(detail?.resultJson);
  const state = { kind: 'unknown', title: '状态待核对', copy: '任务状态暂未确认，请重新加载或返回工作台核对。', videoUrl: '', progress: null };
  if (['queued', 'generating', 'submitting'].includes(status)) {
    return { ...state, kind: 'active', title: '生成中', copy: '任务正在处理中，可重新加载查看最新状态。', progress: taskProgress(result) };
  }
  if (['succeeded', 'completed', 'done', 'success'].includes(status)) {
    const videoUrl = safeVideoUrl(result);
    return videoUrl
      ? { ...state, kind: 'video', title: '生成结果', copy: '', videoUrl }
      : { ...state, kind: 'unavailable', title: '结果暂不可播放', copy: '任务已完成，但暂未取得可播放的视频。请重新加载或返回工作台核对。' };
  }
  if (['failed', 'error', 'cancelled'].includes(status)) {
    return { ...state, kind: 'failed', title: status === 'cancelled' ? '任务已取消' : '生成失败', copy: '本次任务未生成可播放的视频，请返回工作台核对任务。' };
  }
  return state;
}

const scalarText = (value, fallback = '—') => typeof value === 'string' && value.trim() ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback;

function dateText(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—';
}

export async function setupResultPage({ view = document, pageLocation = location, fetcher = fetch } = {}) {
  const element = (id) => view.querySelector(`#${id}`);
  const player = element('result-player');
  const progress = element('result-progress');
  const percentage = element('result-percentage');
  const terminal = element('result-terminal');
  const retry = element('result-retry');
  const route = parseResultRoute(pageLocation.pathname);
  let inFlight = false;
  let hasRenderedDetail = false;

  function requireDetail(detail) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail) || typeof detail.status !== 'string' || !detail.status.trim()) {
      throw new Error('任务详情暂不可用');
    }
    return detail;
  }

  function showRetryError(message) {
    element('result-error').textContent = `${scalarText(message, '任务详情暂不可用')}。可重新加载重试。`;
  }

  function clearStage() {
    player.pause();
    player.removeAttribute('src');
    player.load();
    player.hidden = true;
    progress.hidden = true;
    percentage.hidden = true;
    percentage.textContent = '';
    terminal.hidden = true;
  }

  function showTerminal(title, copy) {
    clearStage();
    hasRenderedDetail = false;
    terminal.hidden = false;
    element('result-terminal-title').textContent = title;
    element('result-terminal-copy').textContent = copy;
    element('result-heading').textContent = title;
    element('result-status').textContent = title;
  }

  function renderDetail(detail) {
    clearStage();
    const state = resultViewModel(detail);
    element('result-project').textContent = scalarText(detail?.projectName, '任务详情');
    element('result-heading').textContent = state.title;
    element('result-status').textContent = state.kind === 'video' || state.kind === 'unavailable' ? '已完成' : state.title;
    element('back-to-workspace').href = `/workspace?project=${encodeURIComponent(scalarText(detail?.projectId, route.projectId))}`;
    if (state.kind === 'video') {
      player.src = state.videoUrl;
      player.controls = true;
      player.hidden = false;
    } else if (state.kind === 'active') {
      progress.hidden = false;
      if (state.progress !== null) { percentage.textContent = `${state.progress}%`; percentage.hidden = false; }
    } else showTerminal(state.title, state.copy);
    const request = parseTaskRequest(detail?.request);
    element('result-prompt').textContent = scalarText(request.prompt);
    const mode = detail?.mode === 'image' ? '图生视频' : detail?.mode === 'text' ? '文生视频' : '—';
    const duration = scalarText(request.duration);
    const fields = [
      ['生成服务', taskProviderLabel(detail)], ['生成模式', mode], ['模型', scalarText(request.model)], ['分辨率', scalarText(request.resolution)],
      ['视频时长', duration === '—' ? duration : `${duration}秒`], ['画幅', scalarText(request.aspectRatio)],
      ['创建时间', dateText(detail?.createdAt)], ['更新时间', dateText(detail?.updatedAt)],
    ];
    const metadata = element('result-meta');
    metadata.replaceChildren();
    for (const [label, value] of fields) {
      const row = view.createElement('div');
      if (label === '生成服务') row.id = 'result-provider';
      const term = view.createElement('dt'); term.textContent = label;
      const definition = view.createElement('dd'); definition.textContent = value;
      row.append(term, definition);
      metadata.append(row);
    }
    hasRenderedDetail = true;
  }

  async function load() {
    if (inFlight) return;
    if (!route) {
      showTerminal('任务链接无效', '请返回工作台，从任务记录打开结果。');
      retry.hidden = true;
      element('result-detail').setAttribute('aria-busy', 'false');
      return;
    }
    inFlight = true;
    retry.disabled = true;
    element('result-detail').setAttribute('aria-busy', 'true');
    element('result-error').textContent = '';
    try {
      const detailPath = `/api/projects/${encodeURIComponent(route.projectId)}/tasks/${encodeURIComponent(route.taskId)}`;
      const response = await fetcher(detailPath);
      if (response.status === 401) { pageLocation.replace('/login'); return; }
      const detail = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (hasRenderedDetail && (response.status >= 500 || response.status === 408 || response.status === 429)) {
          showRetryError(detail?.error);
          return;
        }
        showTerminal(response.status === 404 ? '任务不可访问' : '结果加载失败', response.status === 404 ? '任务不存在，或不属于当前项目。' : '请检查连接后重新加载。');
        element('result-error').textContent = scalarText(detail?.error, '任务详情暂不可用');
        return;
      }
      renderDetail(requireDetail(detail));
      if (resultViewModel(detail).kind === 'active') {
        try {
          const sync = await fetcher(`/api/video/tasks/${encodeURIComponent(route.taskId)}?projectId=${encodeURIComponent(route.projectId)}`);
          if (sync.status === 401) { pageLocation.replace('/login'); return; }
          if (!sync.ok) {
            const body = await sync.json().catch(() => ({}));
            throw new Error(scalarText(body?.error, '状态同步暂不可用'));
          }
          const refreshed = await fetcher(detailPath);
          if (refreshed.status === 401) { pageLocation.replace('/login'); return; }
          const latestDetail = await refreshed.json();
          if (!refreshed.ok) throw new Error(scalarText(latestDetail?.error, '任务详情刷新暂不可用'));
          renderDetail(requireDetail(latestDetail));
        } catch (error) {
          renderDetail(detail);
          showRetryError(error?.message);
        }
      }
    } catch (error) {
      if (hasRenderedDetail) showRetryError(error?.message);
      else {
        showTerminal('结果加载失败', '请检查连接后重新加载。');
        element('result-error').textContent = scalarText(error?.message, '任务详情暂不可用');
      }
    } finally {
      inFlight = false;
      retry.disabled = false;
      element('result-detail').setAttribute('aria-busy', 'false');
    }
  }

  retry.onclick = load;
  await load();
}

if (typeof document !== 'undefined') void setupResultPage();
