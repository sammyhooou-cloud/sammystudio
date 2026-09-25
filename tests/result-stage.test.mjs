import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = [
  readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8'),
  readFileSync(new URL('../public/task-history.css', import.meta.url), 'utf8'),
].join('\n');

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || '';
}

test('result markup defines distinct layers and a completed clips list', () => {
  assert.match(html, /id="result-stage"\s+class="result-stage"/);
  assert.match(html, /id="result-empty"[^>]*class="[^"]*result-layer/);
  assert.match(html, /id="result-progress"[^>]*class="[^"]*result-layer generation-state[^"]*"[^>]*hidden/);
  assert.match(html, /id="generation-title"[^>]*>生成中<\/h3>/);
  assert.match(html, /id="task-progress"[^>]*class="task-progress"[^>]*hidden/);
  assert.match(html, /id="result-terminal"[^>]*class="[^"]*result-layer terminal-state[^"]*"[^>]*hidden/);
  assert.match(html, /id="terminal-title"/);
  assert.match(html, /id="terminal-copy"/);
  assert.match(html, /id="result-video"[^>]*controls[^>]*hidden/);
  assert.match(html, /id="task-history-wrap"[^>]*hidden/);
  assert.match(html, /<p class="eyebrow">已完成片段<\/p>/);
});

test('result stage keeps all display states in one fixed region', () => {
  assert.match(rule('.result-stage'), /position\s*:\s*relative/);
  assert.match(rule('.result-stage'), /min-height\s*:\s*(?:3[6-9]\d|4\d\d)px/);
  assert.match(rule('.result-layer'), /position\s*:\s*absolute/);
  assert.match(rule('.result-layer'), /inset\s*:\s*0/);
  assert.match(rule('.result-layer'), /place-content\s*:\s*center/);
  assert.match(rule('#result-video'), /position\s*:\s*absolute/);
  assert.match(rule('#result-video'), /inset\s*:\s*0/);
  assert.match(rule('#result-video'), /object-fit\s*:\s*contain/);
});

test('generation visual animates a gradient without moving its container', () => {
  assert.match(rule('.generation-visual'), /(?:conic|linear|radial)-gradient\s*\(/);
  assert.match(css, /@keyframes\s+generation-[\w-]+\s*\{[^}]*\}[^}]*\}/);
  for (const animation of css.matchAll(/@keyframes\s+(generation-[\w-]+)\s*\{([^}]*\}[^}]*)\}/g)) {
    assert.doesNotMatch(animation[2], /translate(?:X|Y)?\s*\(|(?:^|[;{])\s*(?:top|left)\s*:/);
  }
  assert.doesNotMatch(css, /@keyframes\s+progress\b/);
});

test('reduced motion leaves a static generation visual', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion\s*:\s*reduce\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion\s*:\s*reduce\)\s*\{[^}]*\.generation-visual[^}]*animation\s*:\s*none/);
  assert.match(rule('.generation-visual'), /(?:conic|linear|radial)-gradient\s*\(/);
});

test('pending attempt guidance does not replace the visible stage status', () => {
  const guidance = app.match(/function renderPendingAttemptState\(\)\s*\{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.ok(guidance);
  assert.doesNotMatch(guidance, /#task-state/);
  const blockedSubmit = app.match(/if \(pending && JSON\.stringify\(pending\.payload\)[\s\S]*?\n    \}/)?.[0] || '';
  assert.ok(blockedSubmit);
  assert.doesNotMatch(blockedSubmit, /#task-state/);
});

test('choosing a completed clip can replace the temporary submission stage', () => {
  assert.match(app, /item\.onclick\s*=\s*\(\)\s*=>\s*\{\s*selectedTaskId\s*=\s*task\.id;\s*stageOverride\s*=\s*null;\s*submittingWithoutTask\s*=\s*false;\s*renderTasks\(\)/);
});
