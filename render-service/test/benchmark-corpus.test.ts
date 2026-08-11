import { access, mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertCorpusPrivacy,
  collectCaseFiles,
  computeCaseHashes,
  createDeterministicArchive,
  materializeArchive,
} from '../src/benchmark/corpus.js';
import type { CorpusManifest } from '../src/benchmark/types.js';

describe('benchmark corpus archives', () => {
  it('rejects recognizable personal or source metadata markers', () => {
    expect(() =>
      assertCorpusPrivacy(
        new Map([['asset.txt', Buffer.from('created for classroom/lesson at 192.168.1.10')]]),
      ),
    ).toThrow(/privacy check failed/);

    const metadata = Buffer.from('Author\0fixture-user', 'latin1');
    const png = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.from([0, 0, 0, metadata.length]),
      Buffer.from('tEXt'),
      metadata,
      Buffer.alloc(4),
    ]);
    expect(() => assertCorpusPrivacy(new Map([['asset.png', png]]))).toThrow(
      /privacy check failed/,
    );
  });

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
      expectedAudio: false,
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

  it('removes stale files before materializing an archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-materialize-'));
    const outputDir = join(root, 'project');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'stale.txt'), 'stale');
    await materializeArchive(
      createDeterministicArchive(
        new Map([['benchmark-input.json', Buffer.from('{"id":"clean"}\n')]]),
      ),
      outputDir,
    );
    await expect(access(join(outputDir, 'stale.txt'))).rejects.toThrow();
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
