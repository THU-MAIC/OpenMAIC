import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { recordUsage, readUsageRecords, type UsageRecordInput } from '@/lib/server/usage-storage';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const baseInput: UsageRecordInput = {
  source: 'scene-content',
  providerId: 'openai',
  modelId: 'claude-sonnet-4-6',
  modelString: 'openai:claude-sonnet-4-6',
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
  },
};

describe('recordUsage', () => {
  it('appends a self-describing jsonl line with computed cost', async () => {
    await recordUsage(baseInput, { baseDir: tmpDir });
    const records = await readUsageRecords({ baseDir: tmpDir });
    expect(records).toHaveLength(1);
    expect(records[0].modelId).toBe('claude-sonnet-4-6');
    expect(records[0].inputTokens).toBe(100);
    // claude-sonnet-4-6 is in DEFAULT_PRICING → cost computed
    expect(records[0].totalCostUsd).toBeGreaterThan(0);
    expect(records[0].costNull).toBeFalsy();
    expect(records[0].id).toBeTruthy();
    expect(records[0].createdAt).toBeGreaterThan(0);
  });

  it('records tokens with costNull when model is not in the pricing table', async () => {
    await recordUsage(
      { ...baseInput, modelId: 'some-unknown-model', modelString: 'x:some-unknown-model' },
      { baseDir: tmpDir },
    );
    const records = await readUsageRecords({ baseDir: tmpDir });
    expect(records[0].costNull).toBe(true);
    expect(records[0].totalCostUsd).toBe(0);
    expect(records[0].inputTokens).toBe(100);
  });

  it('skips writing when there are no billable tokens', async () => {
    await recordUsage(
      {
        ...baseInput,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        },
      },
      { baseDir: tmpDir },
    );
    const records = await readUsageRecords({ baseDir: tmpDir });
    expect(records).toHaveLength(0);
  });

  it('appends multiple records across calls', async () => {
    await recordUsage(baseInput, { baseDir: tmpDir });
    await recordUsage(baseInput, { baseDir: tmpDir });
    const records = await readUsageRecords({ baseDir: tmpDir });
    expect(records).toHaveLength(2);
  });

  it('never throws on a write failure (fire-and-forget)', async () => {
    // Point at a path that cannot be created (a file used as a dir).
    const filePath = path.join(tmpDir, 'not-a-dir');
    await fs.writeFile(filePath, 'x');
    await expect(recordUsage(baseInput, { baseDir: filePath })).resolves.toBeUndefined();
  });
});

describe('readUsageRecords', () => {
  it('returns empty array when no usage dir exists', async () => {
    const records = await readUsageRecords({ baseDir: path.join(tmpDir, 'nonexistent') });
    expect(records).toEqual([]);
  });
});
