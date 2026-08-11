import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import type { CorpusCase, CorpusManifest } from './types.js';

function zipEpoch(): Date {
  // ZIP stores local DOS date fields, so construct local midnight instead of
  // converting one UTC instant differently in each runtime timezone.
  return new Date(1980, 0, 1, 0, 0, 0, 0);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) return walkFiles(root, absolute);
      if (!entry.isFile()) return [];
      return [relative(root, absolute).split(sep).join('/')];
    }),
  );
  return paths.flat().sort();
}

function assertArchivePath(path: string): void {
  if (!path || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`Unsafe benchmark archive path: ${path}`);
  }
}

export async function loadCorpusManifest(path: string): Promise<CorpusManifest> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as CorpusManifest;
  if (parsed.schemaVersion !== 1 || !parsed.corpusVersion || !Array.isArray(parsed.cases)) {
    throw new Error(`Invalid benchmark corpus manifest: ${path}`);
  }
  const ids = new Set<string>();
  for (const entry of parsed.cases) {
    if (ids.has(entry.id)) throw new Error(`Duplicate benchmark case id: ${entry.id}`);
    ids.add(entry.id);
    if (entry.representativeFrameFractions.some((value) => value <= 0 || value >= 1)) {
      throw new Error(`Representative frame fractions must be between 0 and 1: ${entry.id}`);
    }
  }
  return parsed;
}

export async function collectCaseFiles(input: {
  benchmarkCase: CorpusCase;
  manifest: CorpusManifest;
  corpusRoot: string;
  repositoryRoot: string;
}): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const projectRoot = resolve(input.corpusRoot, input.benchmarkCase.projectDir);
  for (const path of await walkFiles(projectRoot)) {
    assertArchivePath(path);
    files.set(path, await readFile(join(projectRoot, path)));
  }
  for (const mapping of [...input.manifest.sharedFiles, ...(input.benchmarkCase.files ?? [])]) {
    assertArchivePath(mapping.archivePath);
    if (files.has(mapping.archivePath)) {
      throw new Error(`Duplicate benchmark archive path: ${mapping.archivePath}`);
    }
    files.set(mapping.archivePath, await readFile(resolve(input.repositoryRoot, mapping.source)));
  }
  return new Map([...files.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function hashProjectFiles(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash('sha256');
  for (const [path, bytes] of [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const pathBytes = Buffer.from(path, 'utf8');
    const sizes = Buffer.allocUnsafe(8);
    sizes.writeUInt32BE(pathBytes.length, 0);
    sizes.writeUInt32BE(bytes.length, 4);
    hash.update(sizes).update(pathBytes).update(bytes);
  }
  return hash.digest('hex');
}

export function createDeterministicArchive(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const input: Zippable = {};
  for (const [path, bytes] of [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    input[path] = [bytes, { mtime: zipEpoch() }];
  }
  return zipSync(input, { level: 9 });
}

export function computeCaseHashes(files: ReadonlyMap<string, Uint8Array>): {
  inputManifestSha256: string;
  projectHashSha256: string;
  archiveHashSha256: string;
} {
  const inputManifest = files.get('benchmark-input.json');
  if (!inputManifest) throw new Error('Benchmark project is missing benchmark-input.json');
  const archive = createDeterministicArchive(files);
  return {
    inputManifestSha256: sha256(inputManifest),
    projectHashSha256: hashProjectFiles(files),
    archiveHashSha256: sha256(archive),
  };
}

export function verifyCaseHashes(
  benchmarkCase: CorpusCase,
  actual: ReturnType<typeof computeCaseHashes>,
): void {
  for (const key of ['inputManifestSha256', 'projectHashSha256', 'archiveHashSha256'] as const) {
    if (benchmarkCase[key] !== actual[key]) {
      throw new Error(
        `Benchmark corpus hash mismatch for ${benchmarkCase.id} (${key}): ` +
          `expected ${benchmarkCase[key]}, got ${actual[key]}`,
      );
    }
  }
}

export async function materializeArchive(archive: Uint8Array, outputDir: string): Promise<void> {
  const entries = unzipSync(archive);
  for (const [path, bytes] of Object.entries(entries)) {
    assertArchivePath(path);
    const outputPath = join(outputDir, path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, bytes);
  }
}
