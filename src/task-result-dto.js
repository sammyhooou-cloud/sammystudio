export function safeTaskResultJson({ provider, projectId, taskId, resultJson }) {
  if (provider !== 'minimax') return resultJson;
  if (resultJson == null || resultJson === '') return null;

  let result;
  try { result = JSON.parse(resultJson); } catch { return '{}'; }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '{}';

  const safeResult = {};
  const internalUrl = `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/output`;
  if (result.videoUrl === internalUrl) safeResult.videoUrl = internalUrl;
  for (const source of [result, result.data, result.providerResult, result.providerResult?.data]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const key of ['progress', 'percentage', 'percent']) {
      const progress = source[key];
      if (typeof progress === 'number' && Number.isFinite(progress) && progress >= 0 && progress <= 100) {
        safeResult.progress = progress;
        return JSON.stringify(safeResult);
      }
    }
  }
  return JSON.stringify(safeResult);
}
