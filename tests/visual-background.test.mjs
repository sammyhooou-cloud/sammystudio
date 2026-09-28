import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const htmlUrl = new URL('../public/login.html', import.meta.url);
const cssUrl = new URL('../public/styles.css', import.meta.url);
const videoUrl = 'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260521_014404_fadafdb1-4df6-4699-be9c-77d25f39a3d0.mp4';

for (const page of ['login', 'workspace']) test(`${page} decorative MotionSites background is safe and non-interactive`, async () => {
  const html = await readFile(new URL(`../public/${page}.html`, import.meta.url), 'utf8');
  const tag = html.match(/<video\b[^>]*class="stage-video"[^>]*>/)?.[0] || '';
  assert.ok(tag, 'stage video exists');
  assert.match(tag, /\bautoplay\b/);
  assert.match(tag, /\bmuted\b/);
  assert.match(tag, /\bloop\b/);
  assert.match(tag, /\bplaysinline\b/);
  assert.match(tag, /poster="\/assets\/alpine-runner\.jpg"/);
  assert.match(tag, /aria-hidden="true"/);
  assert.match(tag, /tabindex="-1"/);
  assert.doesNotMatch(tag, /\bcontrols\b/);
  assert.ok(html.includes(`<source src="${videoUrl}"`), 'uses the authorized MotionSites asset');
});

test('background fallback, layering, and frosted login styles are defined', async () => {
  const css = (await readFile(cssUrl, 'utf8')).replace(/\s+/g, '');
  assert.match(css, /\.stage-video\{[^}]*position:fixed/);
  assert.match(css, /\.stage-video\{[^}]*inset:0/);
  assert.match(css, /\.stage-video\{[^}]*object-fit:cover/);
  assert.match(css, /\.stage-video\{[^}]*pointer-events:none/);
  assert.match(css, /\.stage-video\{[^}]*z-index:-2/);
  assert.match(css, /\.stage-video\{[^}]*object-position:/);
  assert.match(css, /@media\(max-width:760px\)\{[^}]*\.stage-video\{[^}]*object-position:/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{[^}]*\.stage-video\{[^}]*display:none/);
  assert.match(css, /\.login-card\{[^}]*backdrop-filter:blur\([^}]*saturate\(/);
  assert.match(css, /\.login-card\{[^}]*-webkit-backdrop-filter:blur\(/);
  assert.match(css, /\.login-card\{[^}]*border:1pxsolidrgba\(/);
  assert.match(css, /\.login-cardinput\{[^}]*background:rgba\(/);
  assert.match(css, /\.login-cardinput:focus\{[^}]*border-color:var\(--acid\)[^}]*box-shadow:/);
  assert.ok(css.includes('@media(max-width:760px){.stage-video{object-position:58%50%}.login-card{backdrop-filter:blur(20px)saturate(120%)'), 'mobile video focal point and reduced card blur are set');
  assert.match(css, /\.stage\{[^}]*background:[^}]*alpine-runner\.jpg/);
});

test('login uses deep black glass without a device shell or floating motion', async () => {
  const [rawCss, html] = await Promise.all([
    readFile(cssUrl, 'utf8'),
    readFile(htmlUrl, 'utf8'),
  ]);
  const css = rawCss.replace(/\s+/g, '');
  const cardRules = [...css.matchAll(/\.login-card\{([^}]*)\}/g)].map((match) => match[1]);
  const card = cardRules.find((rule) => rule.includes('linear-gradient(')) || '';
  const wrapRules = [...css.matchAll(/\.login-wrap\{([^}]*)\}/g)].map((match) => match[1]);
  const input = css.match(/\.login-cardinput\{([^}]*)\}/)?.[1] || '';
  const focusedInput = css.match(/\.login-cardinput:focus\{([^}]*)\}/)?.[1] || '';

  assert.match(card, /background:linear-gradient\(145deg,rgba\(10,13,10,\.90\),rgba\(2,4,3,\.82\)\)/);
  assert.match(card, /border:1pxsolidrgba\(255,255,255,\.16\)/);
  assert.match(card, /box-shadow:inset01px0rgba\(255,255,255,\.13\),038px100pxrgba\(0,0,0,\.66\)/);
  assert.match(card, /(?:^|;)backdrop-filter:blur\((?:2[89]|[3-9]\d)px\)saturate\(\d+%\)/);
  assert.match(card, /(?:^|;)-webkit-backdrop-filter:blur\((?:2[89]|[3-9]\d)px\)saturate\(\d+%\)/);
  assert.match(input, /background:rgba\(255,255,255,\.075\)/);
  assert.match(input, /box-shadow:inset01px0rgba\(255,255,255,\.055\)/);
  assert.match(focusedInput, /border-color:var\(--acid\)/);
  assert.match(focusedInput, /box-shadow:0{1,2}0{1,2}0{1,2}3px#c8ff7815/);
  assert.doesNotMatch([...cardRules, ...wrapRules].join(';'), /(?:animation(?:-name)?|transform):/);
  assert.doesNotMatch(`${css}${html}`, /(?:phone-frame|mock-phone|device-shell)/);
});
