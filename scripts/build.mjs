import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/client', { recursive: true });
await mkdir('dist/server', { recursive: true });
await cp('public', 'dist/client', { recursive: true });
await cp('src', 'dist/server', { recursive: true });

const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);
const previewSource = await readFile('public/image-preview.js', 'utf8');
const previewHash = digest(previewSource);
const previewRoute = `/image-preview.${previewHash}.js`;
const appSource = await readFile('public/app.js', 'utf8');
const appHash = digest(`${appSource}\n${previewHash}`);
const appRoute = `/app.${appHash}.js`;
const generatedApp = appSource.replace("'./image-preview.js'", `'./image-preview.${previewHash}.js'`);
const generatedIndex = (await readFile('public/index.html', 'utf8')).replace('src="/app.js"', `src="${appRoute}"`);

await writeFile('dist/client/index.html', generatedIndex);
await writeFile(`dist/client${appRoute}`, generatedApp);
await writeFile(`dist/client${previewRoute}`, previewSource);

const assets = [
  ['/index.html', 'dist/client/index.html', 'text/html; charset=utf-8', false, false],
  ['/styles.css', 'public/styles.css', 'text/css; charset=utf-8', false, false],
  ['/project-navigation.css', 'public/project-navigation.css', 'text/css; charset=utf-8', false, false],
  ['/image-preview.css', 'public/image-preview.css', 'text/css; charset=utf-8', false, false],
  ['/task-history.css', 'public/task-history.css', 'text/css; charset=utf-8', false, false],
  [appRoute, `dist/client${appRoute}`, 'text/javascript; charset=utf-8', false, true],
  [previewRoute, `dist/client${previewRoute}`, 'text/javascript; charset=utf-8', false, true],
  ['/assets/alpine-runner.jpg', 'public/assets/alpine-runner.jpg', 'image/jpeg', true, false],
];
const rows = [];
for (const [route, path, type, binary, immutable] of assets) {
  const value = await readFile(path);
  rows.push([route, { type, base64: binary, immutable, body: binary ? value.toString('base64') : value.toString('utf8') }]);
}
await writeFile('dist/server/site-assets.js', `export const siteAssets = new Map(${JSON.stringify(rows)});\n`);
