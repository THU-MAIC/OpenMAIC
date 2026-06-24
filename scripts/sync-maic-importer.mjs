#!/usr/bin/env node
/**
 * Copy maic-importer's built bundle to public/vendor/ so the app can
 * load it at runtime via a URL-based dynamic import.
 *
 * Why: the bundle contains dynamic `require()` patterns (from pdfjs-dist)
 * that Turbopack rejects as a hard "Module not found: Can't resolve <dynamic>"
 * error. By serving it as a static asset and importing it via a runtime URL,
 * we bypass the bundler entirely while keeping types via the workspace package.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'packages/@openmaic/importer/dist');
const destDir = path.join(root, 'public/vendor/maic-importer');

try {
  await stat(srcDir);
} catch {
  console.error(`[sync-maic-importer] missing dist: ${srcDir}`);
  console.error('Run `cd packages/@openmaic/importer && pnpm run build` first.');
  process.exit(1);
}

await rm(destDir, { recursive: true, force: true });
await mkdir(destDir, { recursive: true });
await cp(srcDir, destDir, { recursive: true });

console.log(
  `[sync-maic-importer] copied ${path.relative(root, srcDir)} → ${path.relative(root, destDir)}`,
);
