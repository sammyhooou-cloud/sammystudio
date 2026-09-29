import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const outputDir = join(projectDir, 'dist');
const clientDir = join(outputDir, 'client');
const serverDir = join(outputDir, 'server');
const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);
const source = (name) => readFile(join(projectDir, 'public', name), 'utf8');

function replaceOnce(value, before, after) {
  if (value.split(before).length !== 2) throw new Error(`Expected one build reference: ${before}`);
  return value.replace(before, after);
}

const moduleAsset = (name, body) => ({ route: `/${name}.${digest(body)}.js`, body });
const [previewSource, presenterSource, loginSource, appSource, resultSource] = await Promise.all([
  source('image-preview.js'), source('task-presenter.js'), source('login.js'), source('app.js'), source('result.js'),
]);
const preview = moduleAsset('image-preview', previewSource);
const presenter = moduleAsset('task-presenter', presenterSource);
const login = moduleAsset('login', loginSource);
const app = moduleAsset('app', replaceOnce(
  replaceOnce(appSource, "from './image-preview.js'", `from '.${preview.route}'`),
  "from './task-presenter.js'", `from '.${presenter.route}'`,
));
const result = moduleAsset('result', replaceOnce(resultSource, "from './task-presenter.js'", `from '.${presenter.route}'`));
const modules = [login, app, result, preview, presenter];
const documents = await Promise.all([
  ['login', login], ['workspace', app], ['result', result],
].map(async ([name, entry]) => ({
  route: `/${name}.html`,
  body: replaceOnce(await source(`${name}.html`), `src="/${name === 'workspace' ? 'app' : name}.js"`, `src="${entry.route}"`),
})));

await rm(outputDir, { recursive: true, force: true });
await mkdir(join(clientDir, 'assets'), { recursive: true });
await mkdir(serverDir, { recursive: true });
await cp(join(projectDir, 'src'), serverDir, { recursive: true });

const assets = [];
for (const { route, body } of documents) {
  const path = join(clientDir, route.slice(1));
  await writeFile(path, body);
  assets.push([route, path, 'text/html; charset=utf-8', false, false]);
}
for (const name of ['styles.css', 'project-navigation.css', 'image-preview.css', 'task-history.css', 'result-detail.css']) {
  const path = join(clientDir, name);
  await cp(join(projectDir, 'public', name), path);
  assets.push([`/${name}`, path, 'text/css; charset=utf-8', false, false]);
}
for (const { route, body } of modules) {
  const path = join(clientDir, route.slice(1));
  await writeFile(path, body);
  assets.push([route, path, 'text/javascript; charset=utf-8', false, true]);
}
const posterPath = join(clientDir, 'assets/alpine-runner.jpg');
await cp(join(projectDir, 'public/assets/alpine-runner.jpg'), posterPath);
assets.push(['/assets/alpine-runner.jpg', posterPath, 'image/jpeg', true, false]);

const rows = [];
for (const [route, path, type, binary, immutable] of assets) {
  const value = await readFile(path);
  rows.push([route, { type, base64: binary, immutable, body: binary ? value.toString('base64') : value.toString('utf8') }]);
}
await writeFile(join(serverDir, 'site-assets.js'), `export const siteAssets = new Map(${JSON.stringify(rows)});\n`);
