// Serve Monaco from this installation; project source never needs a third-party editor CDN.
import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const source = resolve(dirname(require.resolve('monaco-editor/package.json')), 'min/vs');
const destination = resolve(import.meta.dirname, '../public/code-editor/vs');
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
