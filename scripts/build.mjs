import { cp, mkdir, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/client', { recursive: true });
await mkdir('dist/server', { recursive: true });
await cp('public', 'dist/client', { recursive: true });
await cp('src', 'dist/server', { recursive: true });
