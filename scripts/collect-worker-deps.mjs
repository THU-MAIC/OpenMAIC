#!/usr/bin/env node
/**
 * Ship the dependencies of every worker the server spawns from a computed path.
 *
 * `new Worker(join(process.cwd(), 'lib/...'))` makes the worker an asset to Next's
 * output tracer, not a module in its graph: the file is copied into the standalone
 * output, its imports are never followed, its packages never ship, and the first
 * request needing it fails with "Cannot find package '<name>'".
 *
 * **The rule: any `.mjs` under `lib/` spawned at runtime must be named
 * `*-worker.mjs`.** Discovery is by that suffix, so a new worker needs no edit here.
 * Everything else is derived: follow relative imports to the whole file graph, take
 * each bare specifier as a package, copy it to `<worker dir>/node_modules/`, then
 * audit resolution from the deployed copy so a gap fails the build, not the user.
 *
 * The convention is enforced from both sides: `findPathLoadedModules()` reads the
 * sources for modules loaded by a path literal and fails the build when one of them
 * breaks the naming rule, so a worker that would otherwise be invisible to
 * discovery is caught here instead of shipping broken.
 *
 * Nothing is guessed: package locations come from Node's resolver rather than a
 * `.pnpm` path pattern, and no dependency list is written down, so a worker that
 * starts importing something new is covered before anyone notices. `SELF_BUNDLED` is
 * the only per-package knowledge, for entries already published as one bundled file.
 *
 * Usage: node scripts/collect-worker-deps.mjs [--target <root>]
 *   `<root>` mirrors the repository layout (`<root>/lib/.../x-worker.mjs`).
 *   Defaults to `.next/standalone`.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_SUFFIX = '-worker.mjs';
const WORKER_ROOT = 'lib';
/** Where a module loaded by a path literal can live; both are checked for strays. */
const SCAN_ROOTS = [WORKER_ROOT, 'app'];

/**
 * Packages published as one pre-bundled file, so expanding their declared
 * `dependencies` would copy what they already inlined (`pdfjs-dist`, `katex`, ...).
 * Names here are copied as-is; their contents are covered by the behavioural test.
 */
const SELF_BUNDLED = new Set(['@openmaic/importer']);

const targetArg = process.argv.indexOf('--target');
const targetRoot =
  targetArg === -1
    ? path.join(root, '.next', 'standalone')
    : path.resolve(process.argv[targetArg + 1] ?? '');

/** Packages resolve from the project's install tree, never from the target: the
 *  target may be outside the repository (the tests), and the question is "copy
 *  what this project installed over there". */
const projectManifest = path.join(root, 'package.json');

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function* walkFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** Every `lib/**.mjs` following the worker convention, relative and POSIX-style. */
async function discoverWorkers() {
  const found = [];
  for await (const file of walkFiles(path.join(root, WORKER_ROOT))) {
    if (!file.endsWith(WORKER_SUFFIX)) continue;
    found.push(path.relative(root, file).split(path.sep).join('/'));
  }
  return found.sort();
}

/**
 * Modules the server loads by a path literal -- `join(process.cwd(), 'lib/...')` --
 * instead of by import. One named something other than `*-worker.mjs` is invisible
 * to the discovery above and would ship broken, so it fails the build here with the
 * rename to make. Paths that do not exist are skipped: those are generated at build
 * time and are a tracing concern, not a packaging one.
 */
async function findPathLoadedModules() {
  const strays = [];
  const specifier = /['"`]([A-Za-z0-9_./@-]+\.mjs)['"`]/g;
  const sourceFile = /\.[cm]?[jt]sx?$/;

  for (const dir of SCAN_ROOTS) {
    for await (const file of walkFiles(path.join(root, dir))) {
      if (!sourceFile.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file)) continue;
      const rel = path.relative(root, file).split(path.sep).join('/');
      for (const match of (await readFile(file, 'utf8')).matchAll(specifier)) {
        const target = match[1];
        if (!SCAN_ROOTS.some((scope) => target.startsWith(`${scope}/`))) continue;
        if (target.endsWith(WORKER_SUFFIX)) continue;
        if (!existsSync(path.join(root, target))) continue;
        strays.push({ target, from: rel });
      }
    }
  }
  return strays;
}

// ---------------------------------------------------------------------------
// Import graph
// ---------------------------------------------------------------------------

/** Bare and relative specifiers, from `import x from`, `import 'x'`, `import('x')`. */
function parseImports(source) {
  const found = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}

function isRelative(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * The worker's file graph: relative imports are files shipped alongside, bare
 * specifiers are what has to be provisioned. Walking the graph matters --
 * `document-image-worker.mjs` imports no package itself; both live in
 * `document-image-plan.mjs`, one hop deeper.
 */
async function buildGraph(entryRel) {
  const files = [];
  const seen = new Set();
  const edges = [];

  const visit = async (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    files.push(rel);
    const source = await readFile(path.join(root, rel), 'utf8');
    for (const specifier of parseImports(source)) {
      if (specifier.startsWith('node:') || specifier.startsWith('/')) continue;
      if (!isRelative(specifier)) {
        edges.push({ from: rel, specifier, packageName: packageName(specifier) });
        continue;
      }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier));
      await visit(resolved);
    }
  };

  await visit(entryRel);
  return { files, edges };
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/** The package root that owns `name`: resolve an entry file, then walk up to the
 *  matching `package.json` (most packages do not export that subpath). */
function resolvePackage(name, fromFile) {
  const require = createRequire(fromFile);
  let entry;
  try {
    entry = require.resolve(name);
  } catch (error) {
    throw new Error(
      `cannot resolve ${name} from ${path.relative(root, fromFile)}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let dir = path.dirname(entry);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === name) return { dir, pkg };
    } catch {
      // no manifest here; keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`${name} resolved to ${entry} but no package.json matches`);
    dir = parent;
  }
}

async function sizeOf(target) {
  const info = await stat(target);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(target, { withFileTypes: true })) {
    total += await sizeOf(path.join(target, entry.name));
  }
  return total;
}

/**
 * A `files` entry reduced to its static prefix, because entries can be globs --
 * `parse5@8` declares `["dist/**\/*.js", ...]`, and reading that as a literal path
 * copied nothing, shipping a worker that resolved `parse5` yet failed to import it.
 * The prefix (`dist`) copies a superset, which is what shipping needs.
 */
function staticPrefix(entry) {
  const wildcard = entry.search(/[*?[\]{}]/);
  if (wildcard === -1) return entry;
  const head = entry.slice(0, wildcard);
  const cut = head.lastIndexOf('/');
  return cut === -1 ? '.' : head.slice(0, cut);
}

/** Honour the manifest's `files` (the package's own statement about what ships);
 *  otherwise take the directory. Nested `node_modules` are copied on their own. */
async function copyPackage(name, { dir, pkg }, nodeModules) {
  const dest = path.join(nodeModules, name);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  const declared = Array.isArray(pkg.files) && pkg.files.length > 0 ? pkg.files : ['.'];
  const entries = new Set(['package.json', ...declared.map(staticPrefix)]);
  const copyOptions = {
    recursive: true,
    dereference: true,
    filter: (source) => path.basename(source) !== 'node_modules',
  };

  for (const entry of entries) {
    if (entry === '.') {
      await cp(dir, dest, copyOptions);
      continue;
    }
    const from = path.join(dir, entry);
    try {
      await stat(from);
    } catch {
      continue;
    }
    await cp(from, path.join(dest, entry), copyOptions);
  }
  return sizeOf(dest);
}

/** Copy the imports of one worker, expanding `dependencies` breadth-first. */
async function provision(workerRel, edges) {
  const nodeModules = path.join(targetRoot, path.posix.dirname(workerRel), 'node_modules');
  await rm(nodeModules, { recursive: true, force: true });
  await mkdir(nodeModules, { recursive: true });

  const queue = [...new Set(edges.map((edge) => edge.packageName))].map((name) => ({
    name,
    from: projectManifest,
  }));
  const copied = new Map();
  while (queue.length > 0) {
    const { name, from } = queue.shift();
    if (copied.has(name)) continue;
    const resolved = resolvePackage(name, from);
    const bytes = await copyPackage(name, resolved, nodeModules);
    const selfBundled = SELF_BUNDLED.has(name);
    copied.set(name, { version: resolved.pkg.version, bytes, selfBundled });
    if (selfBundled) continue;
    for (const dependency of Object.keys(resolved.pkg.dependencies ?? {})) {
      // `@types/*` are compile-time only and have no runtime entry to resolve.
      if (dependency.startsWith('@types/')) continue;
      queue.push({ name: dependency, from: path.join(resolved.dir, 'package.json') });
    }
  }
  return { nodeModules, copied };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Resolve every specifier again the way the worker will: ESM, from the deployed
 * copy, in the importing file's directory. Catches both a file the tracer never
 * copied and a package that was not provisioned.
 *
 * `import.meta.resolve`, not `require.resolve`: these were disagreeing on exactly
 * the packages that matter -- `linkedom/worker` is an `exports` condition and
 * `parse5@8` has no CommonJS entry, so CJS reports both broken when they are fine.
 */
async function audit(workerRel, graph, problems) {
  const absent = graph.files.filter((rel) => !existsSync(path.join(targetRoot, rel)));
  for (const rel of absent) {
    problems.push(`${rel} is not in the deployment (check outputFileTracingIncludes)`);
  }

  const byDirectory = new Map();
  for (const edge of graph.edges) {
    if (absent.includes(edge.from)) continue;
    const dir = path.posix.dirname(edge.from);
    if (!byDirectory.has(dir)) byDirectory.set(dir, new Set());
    byDirectory.get(dir).add(edge.specifier);
  }

  for (const [dir, specifiers] of byDirectory) {
    const deployedDir = path.join(targetRoot, dir);
    const probe = path.join(deployedDir, '.worker-deps-probe.mjs');
    const source =
      `const specifiers = ${JSON.stringify([...specifiers])};\n` +
      'const results = [];\n' +
      'for (const specifier of specifiers) {\n' +
      '  try {\n' +
      '    results.push([specifier, import.meta.resolve(specifier), null]);\n' +
      '  } catch (error) {\n' +
      '    results.push([specifier, null, error.code ?? String(error.message)]);\n' +
      '  }\n' +
      '}\n' +
      'console.log(JSON.stringify(results));\n';
    await writeFile(probe, source);
    try {
      const { stdout } = await runFile(process.execPath, [probe], { cwd: deployedDir });
      for (const [specifier, , failure] of JSON.parse(stdout)) {
        if (failure) problems.push(`cannot resolve '${specifier}' from ${dir}/ (${failure})`);
      }
    } finally {
      await rm(probe, { force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  const workers = await discoverWorkers();
  if (workers.length === 0) {
    throw new Error(
      `no *${WORKER_SUFFIX} files under ${WORKER_ROOT}/ -- has the convention changed?`,
    );
  }

  const strays = await findPathLoadedModules();
  if (strays.length > 0) {
    throw new Error(
      `[worker-deps] ${strays.length} module(s) are loaded by a path literal but are not ` +
        `named *${WORKER_SUFFIX}, so they cannot be discovered and their packages would ` +
        `not ship:\n  ` +
        strays.map(({ target, from }) => `${target} (referenced from ${from})`).join('\n  ') +
        `\n  Rename each to end with ${WORKER_SUFFIX}, or load it by import instead.`,
    );
  }

  const problems = [];
  let totalPackages = 0;
  let totalBytes = 0;

  for (const workerRel of workers) {
    const graph = await buildGraph(workerRel);
    const { nodeModules, copied } = await provision(workerRel, graph.edges);
    await audit(workerRel, graph, problems);

    for (const [name, info] of [...copied].sort()) {
      totalBytes += info.bytes;
      console.log(
        `[worker-deps] ${workerRel}: ${name}@${info.version}` +
          `${info.selfBundled ? ' (self-bundled)' : ''} ${mib(info.bytes)}`,
      );
    }
    totalPackages += copied.size;
    console.log(
      `[worker-deps] ${workerRel}: ${graph.files.length} file(s), ${copied.size} package(s) -> ` +
        `${path.relative(root, nodeModules)}`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `[worker-deps] ${problems.length} unresolved import(s) in the deployment:\n  ` +
        problems.join('\n  '),
    );
  }

  console.log(
    `[worker-deps] ${workers.length} worker(s), ${totalPackages} package(s), ${mib(totalBytes)} -- ` +
      'every import resolves from the deployed copy',
  );
}

function mib(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

await main();
