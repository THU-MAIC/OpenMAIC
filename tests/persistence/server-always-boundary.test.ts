/**
 * Server-backed persistence is the only persistence.
 *
 * These guards pin the shape that makes that true, over the real source tree:
 *
 * 1. Nothing reads the removed build-time switch (`NEXT_PUBLIC_PERSISTENCE`,
 *    or its `_TOKEN` remnant). A read would reintroduce a second mode.
 * 2. Durable user data never touches browser storage outside the read-only
 *    legacy module (`lib/legacy-browser-storage/`) and the one-way importer
 *    that will consume it (`lib/legacy-browser-import/`):
 *    - only those modules construct the package's browser stores or open
 *      IndexedDB directly;
 *    - only those modules (and the device cache's one-time voice-profile
 *      carry-over) import the legacy module for anything but types;
 *    - Dexie itself is imported only there and by the device-local cache,
 *      whose schema holds no durable table.
 * 3. The legacy module has no write path: no table or store write outside
 *    the verbatim schema upgrade steps Dexie runs on open.
 *
 * Each rule is a function over `{ path, source }` pairs, exercised first on
 * synthetic sources (so a rule that stops matching fails here) and then on the
 * repository.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

interface SourceFile {
  readonly path: string;
  readonly source: string;
}

const ROOT = process.cwd();
const CODE_ROOTS = ['app', 'components', 'lib', 'packages', 'scripts', 'e2e', 'skills'];
const CODE_FILES = [
  'instrumentation.ts',
  'middleware.ts',
  'next.config.ts',
  'playwright.config.ts',
];
const CONFIG_FILES = [
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.db.yml',
  'docker-compose.defaults.env',
  '.env.example',
  'vercel.json',
  'package.json',
  '.github/workflows/ci.yml',
];
const CODE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.next', 'test', 'tests', 'out']);

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...walk(path));
    } else if (CODE_EXTENSION.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function read(paths: readonly string[]): SourceFile[] {
  return paths.map((path) => ({
    path: relative(ROOT, path).split(sep).join('/'),
    source: readFileSync(path, 'utf8'),
  }));
}

const codeFiles = read([
  ...CODE_ROOTS.flatMap((root) => walk(join(ROOT, root))),
  ...CODE_FILES.map((file) => join(ROOT, file)),
]);
const configFiles = read(
  CONFIG_FILES.map((file) => join(ROOT, file)).filter((path) => statSync(path).isFile()),
);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const LEGACY_MODULE = 'lib/legacy-browser-storage/';
/** The one-way importer (a later change) is the legacy module's only consumer. */
const IMPORTER_MODULE = 'lib/legacy-browser-import/';
/** Copies browser-local voice profiles (a device preference) once; reads only. */
const VOICE_PROFILE_CARRY_OVER = 'lib/device-storage/database.ts';

/** Device-local IndexedDB (see lib/device-storage/database.ts for what it holds). */
const DEVICE_DEXIE_USERS = new Set([
  'lib/device-storage/database.ts',
  // Invalidates an export preview when the device media cache changes.
  'lib/video-export-app/observe-export-changes.ts',
  // Type-only: the undo history's key type.
  'lib/store/snapshot.ts',
]);

const DURABLE_TABLES = [
  'stages',
  'scenes',
  'stageOutlines',
  'chatSessions',
  'chatRestoreStaging',
  'playbackState',
  'generatedAgents',
  'agentEditSessions',
  'folders',
  'stageFolders',
];

function inLegacyOrImporter(path: string): boolean {
  return path.startsWith(LEGACY_MODULE) || path.startsWith(IMPORTER_MODULE);
}

export function persistenceSwitchReads(files: readonly SourceFile[]): string[] {
  return files
    .filter(({ source }) => /NEXT_PUBLIC_PERSISTENCE(?:_TOKEN)?\b/.test(source))
    .map(({ path }) => path);
}

export function browserStoreConstructions(files: readonly SourceFile[]): string[] {
  const pattern =
    /\bnew\s+Browser(?:Document|Runtime|Asset)Store\b|\bindexedDB\s*\.\s*(?:open|deleteDatabase)\s*\(/;
  return files
    .filter(({ path, source }) => !inLegacyOrImporter(path) && pattern.test(source))
    .map(({ path }) => path);
}

export function legacyModuleValueImports(files: readonly SourceFile[]): string[] {
  // `import type` and `export type` are erased; anything else loads the module.
  const valueImport =
    /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s*['"](?:@\/lib\/legacy-browser-storage|(?:\.\.?\/)+legacy-browser-storage)[^'"]*['"]|import\(\s*['"]@\/lib\/legacy-browser-storage[^'"]*['"]\s*\)/m;
  return files
    .filter(
      ({ path, source }) =>
        !inLegacyOrImporter(path) && path !== VOICE_PROFILE_CARRY_OVER && valueImport.test(source),
    )
    .map(({ path }) => path);
}

export function dexieImports(files: readonly SourceFile[]): string[] {
  const pattern =
    /from\s*['"]dexie['"]|import\(\s*['"]dexie['"]\s*\)|require\(\s*['"]dexie['"]\s*\)/;
  return files
    .filter(
      ({ path, source }) =>
        !inLegacyOrImporter(path) && !DEVICE_DEXIE_USERS.has(path) && pattern.test(source),
    )
    .map(({ path }) => path);
}

/** Durable tables declared in a Dexie `stores({...})` schema. */
export function durableTablesDeclared(source: string): string[] {
  return DURABLE_TABLES.filter((table) => new RegExp(`\\b${table}\\s*:\\s*['"]`).test(source));
}

/** Remove Dexie `.upgrade(...)` callbacks: those steps run on open and are kept verbatim. */
function withoutUpgradeSteps(source: string): string {
  let result = source;
  for (;;) {
    const start = result.indexOf('.upgrade(');
    if (start < 0) return result;
    let depth = 0;
    let index = start + '.upgrade'.length;
    for (; index < result.length; index += 1) {
      if (result[index] === '(') depth += 1;
      else if (result[index] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    result = result.slice(0, start) + result.slice(index + 1);
  }
}

export function legacyWrites(files: readonly SourceFile[]): string[] {
  const write =
    /\.(?:put|add|bulkPut|bulkAdd|delete|bulkDelete|clear|update|modify|saveDocument|putStage|putScene|deleteDocument|deleteScene|createSession|appendRecord|setSessionStatus|deleteSession|deleteStageRuntime|deleteAllRuntime|replace|remove|release|invalidate)\s*\(|transaction\(\s*['"]rw|deleteDatabase|\.set\s*\(/;
  return files
    .filter(({ path }) => path.startsWith(LEGACY_MODULE))
    .filter(({ source }) =>
      write.test(withoutUpgradeSteps(source).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
    )
    .map(({ path }) => path);
}

// ---------------------------------------------------------------------------
// The rules bite
// ---------------------------------------------------------------------------

const file = (path: string, source: string): SourceFile => ({ path, source });

describe('the guards bite on synthetic sources', () => {
  it('flags a read of the removed build-time switch', () => {
    expect(
      persistenceSwitchReads([
        file('lib/a.ts', "if (process.env.NEXT_PUBLIC_PERSISTENCE === '1') {}"),
        file('lib/b.ts', 'const token = process.env.NEXT_PUBLIC_PERSISTENCE_TOKEN;'),
        file('lib/c.ts', 'const ok = true;'),
      ]),
    ).toEqual(['lib/a.ts', 'lib/b.ts']);
  });

  it('flags a browser store or raw IndexedDB outside the legacy module', () => {
    expect(
      browserStoreConstructions([
        file('lib/document-store/store.ts', 'return new BrowserDocumentStore({ dbName });'),
        file('lib/media/x.ts', 'indexedDB.deleteDatabase("maic-asset-pool")'),
        file('lib/legacy-browser-storage/index.ts', 'new BrowserRuntimeStore({})'),
        file('lib/legacy-browser-import/run.ts', 'indexedDB.open("MAIC-Database")'),
      ]),
    ).toEqual(['lib/document-store/store.ts', 'lib/media/x.ts']);
  });

  it('flags a value import of the legacy module and admits type-only ones', () => {
    expect(
      legacyModuleValueImports([
        file('lib/a.ts', "import { readLegacyFolders } from '@/lib/legacy-browser-storage';"),
        file('lib/b.ts', "const m = await import('@/lib/legacy-browser-storage');"),
        file('lib/c.ts', "import type { StageRecord } from '@/lib/legacy-browser-storage/schema';"),
        file(
          'lib/legacy-browser-import/run.ts',
          "import { x } from '@/lib/legacy-browser-storage';",
        ),
      ]),
    ).toEqual(['lib/a.ts', 'lib/b.ts']);
  });

  it('flags Dexie outside the legacy module and the device cache', () => {
    expect(
      dexieImports([
        file('lib/utils/database.ts', "import Dexie from 'dexie';"),
        file('lib/device-storage/database.ts', "import Dexie from 'dexie';"),
        file('lib/legacy-browser-storage/schema.ts', "import Dexie from 'dexie';"),
      ]),
    ).toEqual(['lib/utils/database.ts']);
  });

  it('flags a durable table in a device schema', () => {
    expect(
      durableTablesDeclared("this.version(1).stores({ stages: 'id', audioFiles: 'id' })"),
    ).toEqual(['stages']);
  });

  it('flags a write in the legacy module, but not a verbatim upgrade step', () => {
    expect(
      legacyWrites([
        file('lib/legacy-browser-storage/index.ts', 'await database.stages.delete(stageId);'),
        file('lib/legacy-browser-storage/a.ts', "database.transaction('rw', [t], work)"),
        file(
          'lib/legacy-browser-storage/schema.ts',
          'this.version(9).stores({}).upgrade(async (tx) => { await tx.table("s").toCollection().modify((x) => x); });',
        ),
      ]),
    ).toEqual(['lib/legacy-browser-storage/index.ts', 'lib/legacy-browser-storage/a.ts']);
  });
});

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

describe('server-backed persistence is the only persistence', () => {
  it('reads the removed build-time switch nowhere in code or deployment config', () => {
    expect(codeFiles.length).toBeGreaterThan(500);
    expect(persistenceSwitchReads([...codeFiles, ...configFiles])).toEqual([]);
  });

  it('keeps browser stores and raw IndexedDB inside the legacy module', () => {
    expect(browserStoreConstructions(codeFiles)).toEqual([]);
  });

  it('loads the legacy module only from itself, the importer and the voice-profile carry-over', () => {
    expect(legacyModuleValueImports(codeFiles)).toEqual([]);
  });

  it('imports Dexie only for the legacy module and the device-local cache', () => {
    expect(dexieImports(codeFiles)).toEqual([]);
  });

  it('declares no durable table in the device-local database', () => {
    const device = codeFiles.find(({ path }) => path === 'lib/device-storage/database.ts');
    expect(device).toBeDefined();
    expect(durableTablesDeclared(device!.source)).toEqual([]);
    // And the legacy schema still declares every durable table the importer reads.
    const legacy = codeFiles.find(({ path }) => path === 'lib/legacy-browser-storage/schema.ts');
    expect(durableTablesDeclared(legacy!.source)).toEqual(DURABLE_TABLES);
  });

  it('has no write path in the legacy module', () => {
    const legacyFiles = codeFiles.filter(({ path }) => path.startsWith(LEGACY_MODULE));
    expect(legacyFiles.map(({ path }) => path).sort()).toEqual([
      'lib/legacy-browser-storage/index.ts',
      'lib/legacy-browser-storage/schema.ts',
    ]);
    expect(legacyWrites(legacyFiles)).toEqual([]);
    for (const { source } of legacyFiles) {
      expect(source).toContain('READ-ONLY. Used only by the one-way importer');
    }
  });
});
