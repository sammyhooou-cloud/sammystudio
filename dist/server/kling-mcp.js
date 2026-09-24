import { accessToken } from './kling-oauth.js';

async function rpc(env, method, params = {}, fetcher = fetch) {
  const token = await accessToken(env, fetcher);
  if (!token) throw new Error('not_authorized');
  const response = await fetcher('https://klingai.com/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  if (!response.ok) throw new Error(`mcp_${response.status}`);
  const text = await response.text();
  const payloadText = text.includes('data:') ? text.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim() : text;
  const payload = JSON.parse(payloadText);
  if (payload.error) throw new Error(payload.error.message || 'mcp_error');
  return payload.result;
}

export async function callTool(env, name, args = {}, fetcher = fetch) {
  return rpc(env, 'tools/call', { name, arguments: args }, fetcher);
}

function toolData(result) {
  const text = result?.content?.find?.((item) => item.type === 'text')?.text;
  if (!text) return result;
  try { return JSON.parse(text); } catch { return { message: text }; }
}

export async function getKlingStatus(env, fetcher = fetch) {
  try {
    const identity = toolData(await callTool(env, 'who_am_i', { tools: ['text_to_video', 'image_to_video'] }, fetcher));
    const credits = toolData(await callTool(env, 'query_membership_and_credits', {}, fetcher));
    return { connection: 'online', membership: credits.membership ?? credits.member ?? null, credits: credits.credits ?? credits.balance ?? null, models: identity.availableModels || {}, checkedAt: new Date().toISOString() };
  } catch (error) {
    return { connection: 'offline', membership: null, credits: null, models: {}, checkedAt: new Date().toISOString(), message: error.message === 'not_authorized' ? '请连接可灵 MCP' : '可灵 MCP 暂不可用' };
  }
}
