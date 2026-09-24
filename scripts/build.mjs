import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/client', { recursive: true });
await mkdir('dist/server', { recursive: true });
await cp('public', 'dist/client', { recursive: true });
await cp('src', 'dist/server', { recursive: true });
const assets = [
  ['/index.html', 'public/index.html', 'text/html; charset=utf-8', false],
  ['/styles.css', 'public/styles.css', 'text/css; charset=utf-8', false],
  ['/project-navigation.css', 'public/project-navigation.css', 'text/css; charset=utf-8', false],
  ['/image-preview.css', 'public/image-preview.css', 'text/css; charset=utf-8', false],
  ['/task-history.css', 'public/task-history.css', 'text/css; charset=utf-8', false],
  ['/app.js', 'public/app.js', 'text/javascript; charset=utf-8', false],
  ['/image-preview.js', 'public/image-preview.js', 'text/javascript; charset=utf-8', false],
  ['/assets/alpine-runner.jpg', 'public/assets/alpine-runner.jpg', 'image/jpeg', true],
];
const rows = [];
for (const [route, path, type, binary] of assets) {
  const value = await readFile(path);
  rows.push([route, { type, base64: binary, body: binary ? value.toString('base64') : value.toString('utf8') }]);
}
await writeFile('dist/server/site-assets.js', `export const siteAssets = new Map(${JSON.stringify(rows)});\n`);
