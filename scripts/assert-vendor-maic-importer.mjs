#!/usr/bin/env node
/**
 * Build-time guard for the runtime URL-imported PPTX parser.
 *
 * The app loads the parser at runtime from `/vendor/maic-importer/index.js` — a
 * gitignored build artifact that `scripts/sync-maic-importer.mjs` copies into
 * `public/vendor/` during `postinstall`. If a deploy skips or fails that step
 * the file is missing and the feature 404s at runtime (the 404 HTML gets
 * parsed as JS, surfacing an opaque SyntaxError). Fail the build early with a
 * clear, actionable message instead.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'public/vendor/maic-importer/index.js');
const rel = path.relative(root, entry);

try {
  const info = await stat(entry);
  if (!info.isFile() || info.size === 0) {
    throw new Error('present but not a non-empty file');
  }
} catch {
  console.error(`\n[assert-vendor] Missing PPTX parser bundle: ${rel}`);
  console.error('[assert-vendor] It is loaded at runtime via /vendor/maic-importer/index.js');
  console.error('[assert-vendor] and is produced by the postinstall sync step. To fix:');
  console.error(
    '[assert-vendor]   pnpm --filter @openmaic/importer build && pnpm run sync:maic-importer',
  );
  console.error('[assert-vendor] (a normal `pnpm install` runs both via postinstall).\n');
  process.exit(1);
}

console.log(`[assert-vendor] ok: ${rel}`);
