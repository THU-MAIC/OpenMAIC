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
 * 4. The importer reads legacy data only through that module: it never opens
 *    the legacy database itself, and never deletes or clears a database or a
 *    localStorage key (the legacy copy stays as it is after an import).
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
/** The one-way importer is the legacy module's only consumer. */
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

/**
 * A module specifier that names the legacy module: the `@/` alias, or a
 * relative path of any depth (`./`, `../`, `../../lib/`, ...).
 */
// Comments allowed inside `import(` / `require(`, such as a webpackIgnore hint.
const CALL_COMMENTS = String.raw`(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*`;

const LEGACY_SPECIFIER = String.raw`(?:@\/lib\/|(?:\.\.?\/)+(?:[\w.-]+\/)*)legacy-browser-storage(?:\/[^'"]*)?`;

export function legacyModuleValueImports(files: readonly SourceFile[]): string[] {
  // `import type` and `export type` are erased; anything else loads the module:
  // a static value import or re-export, a side-effect import, a dynamic
  // `import()` or a `require()`.
  const valueImport = new RegExp(
    [
      String.raw`^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s*['"]${LEGACY_SPECIFIER}['"]`,
      String.raw`^\s*import\s*['"]${LEGACY_SPECIFIER}['"]`,
      String.raw`\b(?:import|require)\s*\(\s*${CALL_COMMENTS}['"\`]${LEGACY_SPECIFIER}['"\`]\s*\)`,
    ].join('|'),
    'm',
  );
  return files
    .filter(
      ({ path, source }) =>
        !inLegacyOrImporter(path) && path !== VOICE_PROFILE_CARRY_OVER && valueImport.test(source),
    )
    .map(({ path }) => path);
}

/**
 * Name-based by nature: it cannot follow a store threaded through other
 * functions (for example a caller that stops forwarding `learnerKey` so a
 * default store arrives as `injectedKv`). The behavioural test
 * tests/pbl/v2/server-learner-key.test.ts is the guard for that.
 *
 * The runtime learner key must come from runtime configuration (the
 * server-derived key). `getLearnerKey(kv)` with a KV store the caller made up
 * itself reads or MINTS a device key instead, which the server refuses and
 * which pollutes the storage slot the importer reads. The only accepted
 * argument is an explicitly injected store passed straight through.
 */
export function learnerKeyFromLocalStore(files: readonly SourceFile[]): string[] {
  const call = /\bgetLearnerKey\s*\(\s*([^)]*?)\s*\)/g;
  const injected = /^(?:(?:args|options|deps)\.kv|injectedKv)?$/;
  // A name alone is not enough: the injected name must not itself be bound to
  // a default local store (`const injectedKv = args.kv ?? getDefaultKv()`).
  const defaultedBinding = (name: string) =>
    new RegExp(
      String.raw`\b${name.replace('.', '\\.')}\s*(?::[^=;]+)?(?:\?\?)?=\s*[^;]*?(?:getDefaultKv\s*\(|new\s+BrowserKVStore\s*\()`,
    );
  return files
    .filter(({ path }) => path !== 'lib/runtime/learner-key.ts')
    .filter(({ source }) =>
      [...source.matchAll(call)].some((match) => {
        const argument = match[1] ?? '';
        if (!injected.test(argument)) return true;
        return argument !== '' && defaultedBinding(argument).test(source);
      }),
    )
    .map(({ path }) => path);
}

export function dexieImports(files: readonly SourceFile[]): string[] {
  const pattern = new RegExp(
    String.raw`from\s*['"]dexie['"]|\b(?:import|require)\s*\(\s*${CALL_COMMENTS}['"\`]dexie['"\`]\s*\)`,
  );
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

/**
 * The importer writes to the server, the device cache and its own ledger, and
 * to nothing a legacy store holds. Statically: no Dexie (so no handle of its
 * own on a legacy database), no construction of the legacy schema, no
 * database deletion, no localStorage removal or clear, and none of the quiz
 * helpers that delete legacy keys. The behavioural proof is
 * tests/legacy-browser-import/import.test.ts, which compares every legacy
 * database byte for byte before and after an import.
 */
export function importerLegacyWrites(files: readonly SourceFile[]): string[] {
  const forbidden = new RegExp(
    [
      String.raw`from\s*['"]dexie['"]`,
      String.raw`\b(?:import|require)\s*\(\s*${CALL_COMMENTS}['"\`]dexie['"\`]`,
      String.raw`\bnew\s+LegacyBrowserDatabase\b`,
      String.raw`\bDexie\s*\.\s*delete\b`,
      String.raw`\bdeleteDatabase\b`,
      // The model settings import removes only its own keys: the proposal once
      // the server has answered it, and what it kept once the user discards it.
      String.raw`\.removeItem\s*\((?!\s*(?:MODEL_SETTINGS_IMPORT_KEY|MODEL_SETTINGS_UNIMPORTED_KEY)\s*\))`,
      String.raw`\blocalStorage\s*\.\s*clear\s*\(`,
      String.raw`\bstorage\s*\.\s*clear\s*\(`,
      String.raw`\bclearLegacyQuizStateSnapshot\b`,
      String.raw`\bclearAllForScene\b`,
    ].join('|'),
  );
  return files
    .filter(({ path }) => path.startsWith(IMPORTER_MODULE))
    .filter(({ source }) => forbidden.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
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
        file('lib/utils/d.ts', "export const y = () => import('../legacy-browser-storage/index');"),
        file('lib/utils/e.ts', "import { readLegacyFolders } from '../legacy-browser-storage';"),
        file(
          'lib/utils/j.ts',
          "const m = await import(/* webpackIgnore: true */ '@/lib/legacy-browser-storage');",
        ),
        file('app/f.tsx', "import { x } from '../../lib/legacy-browser-storage/index';"),
        file('lib/g.ts', "import './legacy-browser-storage';"),
        file('lib/h.ts', "const m = require('../lib/legacy-browser-storage');"),
        file('lib/i.ts', "export type { StageRecord } from '../legacy-browser-storage/schema';"),
        file(
          'lib/legacy-browser-import/run.ts',
          "import { x } from '@/lib/legacy-browser-storage';",
        ),
      ]),
    ).toEqual([
      'lib/a.ts',
      'lib/b.ts',
      'lib/utils/d.ts',
      'lib/utils/e.ts',
      'lib/utils/j.ts',
      'app/f.tsx',
      'lib/g.ts',
      'lib/h.ts',
    ]);
  });

  it('flags a learner key read from a store the caller made up', () => {
    expect(
      learnerKeyFromLocalStore([
        file('lib/a.ts', 'const key = await getLearnerKey(kv);'),
        file('lib/b.ts', 'const key = await getLearnerKey(getDefaultKv());'),
        file('lib/c.ts', 'const key = await getLearnerKey();'),
        file('lib/d.ts', 'const key = args.learnerKey ?? (await getLearnerKey(args.kv));'),
        file('lib/e.ts', 'const key = await getLearnerKey(options.kv);'),
        file('lib/f.ts', 'resolveLearnerKey: getLearnerKey,'),
        file(
          'lib/g.ts',
          'const injectedKv = args.kv ?? getDefaultKv();\nawait getLearnerKey(injectedKv);',
        ),
        file('lib/h.ts', 'args.kv ??= new BrowserKVStore();\nawait getLearnerKey(args.kv);'),
        file('lib/runtime/learner-key.ts', 'if (kv) return readOrMint(kv); getLearnerKey(kv)'),
      ]),
    ).toEqual(['lib/a.ts', 'lib/b.ts', 'lib/g.ts', 'lib/h.ts']);
  });

  it('flags Dexie outside the legacy module and the device cache', () => {
    expect(
      dexieImports([
        file('lib/utils/database.ts', "import Dexie from 'dexie';"),
        file('lib/device-storage/database.ts', "import Dexie from 'dexie';"),
        file('lib/legacy-browser-storage/schema.ts', "import Dexie from 'dexie';"),
        file('lib/x.ts', "const { default: D } = await import(/* webpackIgnore: true */ 'dexie');"),
      ]),
    ).toEqual(['lib/utils/database.ts', 'lib/x.ts']);
  });

  it('flags a durable table in a device schema', () => {
    expect(
      durableTablesDeclared("this.version(1).stores({ stages: 'id', audioFiles: 'id' })"),
    ).toEqual(['stages']);
  });

  it('flags an importer that opens, deletes or clears legacy data itself', () => {
    expect(
      importerLegacyWrites([
        file('lib/legacy-browser-import/a.ts', "import Dexie from 'dexie';"),
        file('lib/legacy-browser-import/b.ts', 'const legacy = new LegacyBrowserDatabase();'),
        file('lib/legacy-browser-import/c.ts', "await Dexie.delete('MAIC-Database');"),
        file('lib/legacy-browser-import/d.ts', "storage.removeItem('quizDraft:s');"),
        file('lib/legacy-browser-import/e.ts', 'clearLegacyQuizStateSnapshot(sceneId, snapshot);'),
        file('lib/legacy-browser-import/f.ts', 'localStorage.clear();'),
        file('lib/legacy-browser-import/g.ts', 'await db.mediaFiles.put(row); // Dexie.delete'),
        file('lib/legacy-browser-import/h.ts', 'storage.removeItem(MODEL_SETTINGS_IMPORT_KEY);'),
        file('lib/legacy-browser-import/i.ts', "storage.removeItem('settings-storage');"),
        file('lib/other.ts', "await Dexie.delete('MAIC-Database');"),
      ]),
    ).toEqual([
      'lib/legacy-browser-import/a.ts',
      'lib/legacy-browser-import/b.ts',
      'lib/legacy-browser-import/c.ts',
      'lib/legacy-browser-import/d.ts',
      'lib/legacy-browser-import/e.ts',
      'lib/legacy-browser-import/f.ts',
      'lib/legacy-browser-import/i.ts',
    ]);
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

  it('takes the runtime learner key from runtime configuration everywhere', () => {
    expect(learnerKeyFromLocalStore(codeFiles)).toEqual([]);
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

  it('keeps the importer read-only on legacy data', () => {
    const importerFiles = codeFiles.filter(({ path }) => path.startsWith(IMPORTER_MODULE));
    expect(importerFiles.length).toBeGreaterThan(5);
    expect(importerLegacyWrites(importerFiles)).toEqual([]);
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
