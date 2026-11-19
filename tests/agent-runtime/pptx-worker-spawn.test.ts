/**
 * The PPTX worker path has to be a literal inside `new Worker(...)`.
 *
 * Turbopack rewrites that shape into the bundled worker chunk, which is the only
 * reason a standalone deployment can run the worker: the chunk carries `linkedom`
 * and `@openmaic/importer` with it, so neither the raw `.mjs` nor a `node_modules`
 * beside it is needed. Compute the path first and pass it in -- `const file =
 * join(...); new Worker(file)` -- and the bundler sees nothing, so the deployment
 * spawns the raw file, whose `linkedom/worker` import has nothing to resolve from
 * and PRO-mode import fails with "Cannot find package 'linkedom'".
 *
 * `document-image-parser.ts` has had this shape all along, which is why the
 * document-image worker never hit the same failure. This case keeps the two
 * symmetric: it is the whole fix, and it is invisible in a type check.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const CASES = [
  {
    source: 'lib/server/agent-runtime/import-pptx.ts',
    worker: 'lib/server/agent-runtime/import-pptx-worker.mjs',
  },
  {
    source: 'lib/server/material-extraction/document-image-parser.ts',
    worker: 'lib/server/material-extraction/document-image-worker.mjs',
  },
];

/** Comments are prose; what the bundler reads is code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The argument text of every `new Worker(...)` call in `source`. */
function workerCallArguments(source: string): string[] {
  const found: string[] = [];
  const marker = 'new Worker(';
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
    let depth = 0;
    let end = at + marker.length;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    found.push(source.slice(at + marker.length, end));
  }
  return found;
}

describe('runtime workers are spawned by a literal Turbopack can rewrite', () => {
  for (const { source, worker } of CASES) {
    it(`${source}: passes ${path.basename(worker)} to \`new Worker\` as a literal`, () => {
      const code = stripComments(readFileSync(path.join(root, source), 'utf8'));
      const calls = workerCallArguments(code);
      expect(
        calls.some((args) => args.includes(`'${worker}'`)),
        `${source} no longer passes ${worker} to \`new Worker(...)\` as a literal. A path ` +
          'computed first and passed in is invisible to the bundler, and a standalone ' +
          'deployment would spawn the raw file with no dependencies beside it.',
      ).toBe(true);
    });
  }
});
