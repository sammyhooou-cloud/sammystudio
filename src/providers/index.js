import { createKlingProvider } from './kling.js';
import { createMiniMaxProvider } from './minimax.js';

const factories = Object.freeze({ kling: createKlingProvider, minimax: createMiniMaxProvider });
export const providerIds = Object.freeze(Object.keys(factories));

export function createVideoProvider(id, env, deps = {}) {
  if (!Object.hasOwn(factories, id)) throw new Error('视频供应商无效');
  return factories[id](env, deps);
}
