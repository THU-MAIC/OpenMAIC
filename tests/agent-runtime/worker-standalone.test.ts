import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The rule this file protects: a `.mjs` under `lib/` that the server spawns at
 * runtime -- `new Worker(join(process.cwd(), 'lib/...'))` -- must be named
 * `*-worker.mjs`. Such a worker is an asset to Next's tracer, not a module in its
 * graph: the file is copied into the standalone output, its imports are never
 * followed, and the first request fails with "Cannot find package '<name>'".
 * `scripts/collect-worker-deps.mjs` discovers workers by that suffix, provisions
 * their imports, and rejects a path-loaded module that breaks the rule. The tests
 * apply those checks to every worker that exists.
 *
 * The failure is invisible inside the checkout -- Node walking up from the worker
 * reaches the repository's own `node_modules` -- so reproducing it needs a
 * deployment outside the checkout, which `replicateDeployment()` builds.
 */

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COLLECTOR = path.join(root, 'scripts', 'collect-worker-deps.mjs');

/** Same convention the collector uses: `lib/**` + `-worker.mjs`. */
function discoverWorkers(): string[] {
  return readdirSync(path.join(root, 'lib'), { recursive: true })
    .map((entry) => String(entry).split(path.sep).join('/'))
    .filter((entry) => entry.endsWith('-worker.mjs'))
    .map((entry) => `lib/${entry}`)
    .sort();
}

const workers = discoverWorkers();

/**
 * Modules the server loads by a path literal rather than by import. The naming
 * convention is the only way discovery finds them, so one named otherwise is
 * invisible -- and ships broken. Checked here the way the collector checks it, so
 * the failure shows up in `pnpm test` and not only in a Docker build.
 */
function pathLoadedModules(): Array<{ target: string; from: string }> {
  const found: Array<{ target: string; from: string }> = [];
  const specifier = /['"`]([A-Za-z0-9_./@-]+\.mjs)['"`]/g;
  const roots = ['lib', 'app'];

  for (const dir of roots) {
    for (const entry of readdirSync(path.join(root, dir), { recursive: true })) {
      const rel = `${dir}/${String(entry).split(path.sep).join('/')}`;
      if (rel.includes('node_modules')) continue;
      if (!/\.[cm]?[jt]sx?$/.test(rel) || /\.test\.[cm]?[jt]sx?$/.test(rel)) continue;
      for (const match of readFileSync(path.join(root, rel), 'utf8').matchAll(specifier)) {
        const target = match[1];
        // Same two filters as the collector: a path literal rooted in `lib/` or
        // `app/`, and a file that actually exists (generated paths are a tracing
        // concern, not a packaging one).
        if (!roots.some((scope) => target.startsWith(`${scope}/`))) continue;
        if (!existsSync(path.join(root, target))) continue;
        if (!target.endsWith('-worker.mjs')) found.push({ target, from: rel });
      }
    }
  }
  return found;
}

const scratchDirs: string[] = [];

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Bare and relative specifiers of one file: `import x from`, `import 'x'`, `import('x')`. */
function parseImports(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
    found.add(match[1]);
  }
  return [...found];
}

/**
 * The worker's file graph, walked independently of the collector. Walking matters:
 * `document-image-worker.mjs` imports no package itself, both live one hop deeper
 * in `document-image-plan.mjs`.
 */
async function walkGraph(entryRel: string): Promise<Array<{ file: string; specifier: string }>> {
  const edges: Array<{ file: string; specifier: string }> = [];
  const seen = new Set<string>();

  const visit = async (rel: string): Promise<void> => {
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const specifier of parseImports(await readFile(path.join(root, rel), 'utf8'))) {
      if (specifier.startsWith('node:') || specifier.startsWith('/')) continue;
      if (specifier.startsWith('.')) {
        await visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier)));
        continue;
      }
      edges.push({ file: rel, specifier });
    }
  };

  await visit(entryRel);
  return edges;
}

/**
 * A deployment root outside the checkout with no `node_modules` anywhere near it.
 * Whole directories are copied rather than the worker alone, to keep the sibling
 * `.mjs` files some workers import.
 */
async function replicateDeployment(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'worker-standalone-'));
  scratchDirs.push(dir);
  const copied = new Set<string>();
  for (const worker of workers) {
    const parent = path.posix.dirname(worker);
    if (copied.has(parent)) continue;
    copied.add(parent);
    await cp(path.join(root, parent), path.join(dir, parent), {
      recursive: true,
      filter: (source) => path.basename(source) !== 'node_modules',
    });
  }
  return dir;
}

/**
 * Two deployments, built once and shared: before the collector runs (the bug) and
 * after it (the fix). One invocation covers every worker, so there is no reason to
 * pay for it per case.
 */
let pristine: Promise<string> | undefined;
let provisioned: Promise<string> | undefined;

function pristineDeployment(): Promise<string> {
  return (pristine ??= replicateDeployment());
}

function provisionedDeployment(): Promise<string> {
  return (provisioned ??= (async () => {
    const target = await replicateDeployment();
    await run(process.execPath, [COLLECTOR, '--target', target], { cwd: root });
    return target;
  })());
}

/**
 * Resolve one specifier as the worker will: ESM, based at the importing file's
 * directory. `require.resolve` is the wrong tool -- it reports `linkedom/worker` (an
 * `exports` condition) and `parse5@8` (ESM-only) as broken when they are present.
 */
async function resolves(specifier: string, fromDir: string): Promise<boolean> {
  try {
    await run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`,
      ],
      { cwd: fromDir },
    );
    return true;
  } catch {
    return false;
  }
}

describe('runtime workers in a standalone deployment', () => {
  it('discovers workers by the naming convention', () => {
    expect(workers.length).toBeGreaterThan(0);
    for (const worker of workers) expect(worker.startsWith('lib/')).toBe(true);
  });

  it('names every module loaded by a path literal as a worker', () => {
    // The other half of the convention: discovery is by suffix, so a path that
    // does not follow it is never provisioned. Empty means every runtime module
    // is reachable by `discoverWorkers()`.
    expect(pathLoadedModules()).toEqual([]);
  });

  for (const worker of workers) {
    it(`${worker}: every import resolves once the dependencies are collected`, async () => {
      const edges = await walkGraph(worker);
      const before = await pristineDeployment();

      // Stated positively so the case cannot pass vacuously: with no reachable
      // node_modules, at least one import must be unresolvable.
      let resolvedBefore = 0;
      for (const edge of edges) {
        if (await resolves(edge.specifier, path.join(before, path.dirname(edge.file)))) {
          resolvedBefore++;
        }
      }
      expect(edges.length - resolvedBefore).toBeGreaterThan(0);

      const after = await provisionedDeployment();
      const stillBroken: string[] = [];
      for (const edge of edges) {
        if (!(await resolves(edge.specifier, path.join(after, path.dirname(edge.file))))) {
          stillBroken.push(edge.specifier);
        }
      }
      expect(stillBroken).toEqual([]);
    }, 180_000);
  }

  it('parses a PPTX deck through the shipped worker', async () => {
    const target = await provisionedDeployment();

    const fixture = path.join(
      root,
      'packages/@openmaic/importer/test/fixtures/rendering-regression-demo.pptx',
    );
    const bytes = await readFile(fixture);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    const slides = await new Promise<Array<{ elements?: unknown[] }>>((resolve, reject) => {
      const worker = path.join(target, 'lib/server/agent-runtime/import-pptx-worker.mjs');
      const thread = new Worker(worker, { workerData: { buffer } });
      const timer = setTimeout(() => {
        void thread.terminate();
        reject(new Error('the worker did not answer in 60s'));
      }, 60_000);
      thread.on('message', (message) => {
        clearTimeout(timer);
        void thread.terminate();
        if (message?.error) reject(new Error(`worker error: ${message.error}`));
        else resolve(message?.slides ?? []);
      });
      thread.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    expect(slides.length).toBeGreaterThanOrEqual(1);
    expect(slides[0].elements?.length ?? 0).toBeGreaterThan(0);
  }, 180_000);

  it('plans document images through the shipped worker', async () => {
    const target = await provisionedDeployment();

    const result = await new Promise<{ result?: unknown; error?: string }>((resolve, reject) => {
      const worker = path.join(target, 'lib/server/material-extraction/document-image-worker.mjs');
      const thread = new Worker(worker, {
        workerData: { kind: 'plan', text: '# title\n\n![fig](openmaic-derivative:fig.png)' },
      });
      const timer = setTimeout(() => {
        void thread.terminate();
        reject(new Error('the worker did not answer in 60s'));
      }, 60_000);
      thread.on('message', (message) => {
        clearTimeout(timer);
        void thread.terminate();
        resolve(message ?? {});
      });
      thread.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBeTruthy();
  }, 180_000);
});
