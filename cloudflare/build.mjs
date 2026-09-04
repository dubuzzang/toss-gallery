import { rm, mkdir, cp, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('assets', 'dist/assets', { recursive: true });
await writeFile('dist/index.html', '<!doctype html><meta charset="utf-8"><title>Loading…</title>');
