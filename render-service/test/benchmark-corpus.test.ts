import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectCaseFiles,
  computeCaseHashes,
  createDeterministicArchive,
} from '../src/benchmark/corpus.js';
import type { CorpusManifest } from '../src/benchmark/types.js';

describe('benchmark corpus archives', () => {
  it('is byte-identical across source mtimes and directory enumeration order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-corpus-'));
    const corpusRoot = join(root, 'corpus');
    const projectDir = join(corpusRoot, 'project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'z.txt'), 'last');
    await writeFile(join(projectDir, 'benchmark-input.json'), '{"id":"fixture"}\n');
    await writeFile(join(root, 'shared.js'), 'shared');

    const manifest: CorpusManifest = {
      schemaVersion: 1,
      corpusVersion: '1',
      description: 'fixture',
      sharedFiles: [{ source: 'shared.js', archivePath: 'assets/shared.js' }],
      cases: [],
    };
    const benchmarkCase = {
      id: 'fixture',
      category: 'static-slides',
      description: 'fixture',
      durationSeconds: 2,
      sceneCount: 1,
      complexity: 'low',
      projectDir: 'project',
      inputManifestSha256: '',
      projectHashSha256: '',
      archiveHashSha256: '',
      representativeFrameFractions: [0.5],
    } as const;

    const first = await collectCaseFiles({
      benchmarkCase,
      manifest,
      corpusRoot,
      repositoryRoot: root,
    });
    const firstArchive = createDeterministicArchive(first);
    await utimes(
      join(projectDir, 'z.txt'),
      new Date(1_900_000_000_000),
      new Date(1_900_000_000_000),
    );
    const second = await collectCaseFiles({
      benchmarkCase,
      manifest,
      corpusRoot,
      repositoryRoot: root,
    });
    expect(createDeterministicArchive(second)).toEqual(firstArchive);
    expect(computeCaseHashes(second)).toEqual(computeCaseHashes(first));
  });

  it('is byte-identical across runtime timezones', () => {
    const previousTimezone = process.env.TZ;
    const files = new Map<string, Uint8Array>([
      ['benchmark-input.json', Buffer.from('{"id":"timezone"}\n')],
    ]);
    try {
      process.env.TZ = 'UTC';
      const utc = createDeterministicArchive(files);
      process.env.TZ = 'Asia/Shanghai';
      expect(createDeterministicArchive(files)).toEqual(utc);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
});
