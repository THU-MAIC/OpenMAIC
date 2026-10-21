/** Copy only allowlisted installed assets. No build or runtime CDN downloads. */
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERACTIVE_LIBRARIES } from '../packages/@openmaic/generation/dist/interactive-libraries.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const output = join(root, 'public/vendor/interactive');
await mkdir(output, { recursive: true });
for (const library of INTERACTIVE_LIBRARIES) {
  // Resolve the entry, then find its package root (some packages hide package.json).
  let directory = dirname(require.resolve(library.package));
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (manifest.name === library.package) {
        if (manifest.version !== library.version)
          throw new Error(
            `${library.package}: expected ${library.version}, installed ${manifest.version}`,
          );
        break;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Package root not found: ${library.package}`);
    directory = parent;
  }
  const target = join(output, `${library.package}@${library.version}`);
  await rm(target, { recursive: true, force: true });
  for (const file of [...library.files, library.license]) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await cp(join(directory, file), join(target, file), { recursive: true });
  }
}
console.log('Synced deployment-hosted interactive libraries.');
