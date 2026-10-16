import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

import {
  listChangedFiles,
  parseGiteaPushWebhook,
  verifyGiteaSignature,
} from '@/lib/pbl/v2/git-bridge/webhook';
import { splitFullName } from '@/lib/pbl/v2/git-bridge/config';
import {
  runLightweightStaticCheck,
  sortStaticFindings,
  staticFindingsState,
  summarizeStaticFindings,
} from '@/lib/pbl/v2/git-bridge/static-checks';
import type { GiteaPushWebhook } from '@/lib/pbl/v2/git-bridge/types';

describe('verifyGiteaSignature', () => {
  const secret = 'top-secret';
  const body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc123' });

  it('accepts a valid HMAC-SHA256 hex signature', () => {
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(verifyGiteaSignature(secret, body, sig)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(verifyGiteaSignature(secret, body + 'x', sig)).toBe(false);
  });

  it('rejects a missing signature when a secret is configured', () => {
    expect(verifyGiteaSignature(secret, body, undefined)).toBe(false);
    expect(verifyGiteaSignature(secret, body, null)).toBe(false);
  });

  it('skips verification when no secret is configured', () => {
    expect(verifyGiteaSignature('', body, undefined)).toBe(true);
    expect(verifyGiteaSignature('', body, 'garbage')).toBe(true);
  });
});

describe('parseGiteaPushWebhook', () => {
  it('parses a push payload and its changed files', () => {
    const payload = {
      ref: 'refs/heads/main',
      before: '0000000000000000000000000000000000000000',
      after: 'abcdef1234567890',
      commits: [
        {
          id: 'abcdef1234567890',
          message: 'Add home page',
          added: ['entry/src/main/ets/pages/Index.ets'],
          modified: ['build-profile.json5'],
          removed: ['old.txt'],
        },
        {
          id: 'deadbeef',
          modified: ['entry/src/main/ets/pages/Index.ets'],
        },
      ],
      repository: { full_name: 'goking/arkts-pbl-1', owner: { login: 'goking' } },
      pusher: { login: 'goking' },
    };

    const parsed = parseGiteaPushWebhook(payload);
    expect(parsed).toBeDefined();
    expect(parsed!.after).toBe('abcdef1234567890');
    expect(parsed!.ref).toBe('refs/heads/main');
    expect(parsed!.repository?.full_name).toBe('goking/arkts-pbl-1');
    expect(parsed!.pusher?.login).toBe('goking');
    expect(listChangedFiles(parsed!)).toEqual([
      'build-profile.json5',
      'entry/src/main/ets/pages/Index.ets',
      'old.txt',
    ]);
  });

  it('ignores non-branch refs (tags)', () => {
    expect(parseGiteaPushWebhook({ ref: 'refs/tags/v1.0', after: 'abc' })).toBeUndefined();
  });

  it('ignores payloads missing ref or after', () => {
    expect(parseGiteaPushWebhook({ after: 'abc' })).toBeUndefined();
    expect(parseGiteaPushWebhook({ ref: 'refs/heads/main' })).toBeUndefined();
    expect(parseGiteaPushWebhook(null)).toBeUndefined();
    expect(parseGiteaPushWebhook('not-an-object')).toBeUndefined();
  });

  it('handles absent commits/repository/pusher', () => {
    const parsed = parseGiteaPushWebhook({ ref: 'refs/heads/dev', before: '0', after: 'xyz' });
    expect(parsed).toBeDefined();
    expect(parsed!.commits).toBeUndefined();
    expect(listChangedFiles(parsed!)).toEqual([]);
  });
});

describe('splitFullName', () => {
  it('splits owner/repo and trims whitespace', () => {
    expect(splitFullName('goking/arkts-pbl-template')).toEqual({
      owner: 'goking',
      repo: 'arkts-pbl-template',
    });
    expect(splitFullName('  org/nested/repo  ')).toEqual({ owner: 'org', repo: 'nested/repo' });
  });

  it('rejects empty or owner-less values', () => {
    expect(splitFullName(undefined)).toBeNull();
    expect(splitFullName('')).toBeNull();
    expect(splitFullName('  ')).toBeNull();
    expect(splitFullName('repo-only')).toBeNull();
  });
});

describe('listChangedFiles', () => {
  it('de-duplicates and sorts across commits', () => {
    const webhook: GiteaPushWebhook = {
      ref: 'refs/heads/main',
      before: '',
      after: 'sha',
      commits: [
        { id: 'a', added: ['b.ets', 'a.ets'] },
        { id: 'b', modified: ['b.ets'], removed: ['c.ets'] },
      ],
    };
    expect(listChangedFiles(webhook)).toEqual(['a.ets', 'b.ets', 'c.ets']);
  });
});

describe('runLightweightStaticCheck', () => {
  it('reports ArkTS source changes and unknown extensions', () => {
    const findings = runLightweightStaticCheck({
      added: ['entry/src/main/ets/pages/Index.ets'],
      modified: ['entry/src/main/ets/pages/Detail.ets', 'weird.bin'],
      removed: [],
    });
    expect(findings.some((f) => f.level === 'warn' && f.file === 'weird.bin')).toBe(true);
    expect(
      findings.some((f) => f.level === 'info' && f.message.includes('2 个 ArkTS/TS 源文件')),
    ).toBe(true);
  });

  it('flags assets misplaced under the ets source dir', () => {
    const findings = runLightweightStaticCheck({
      added: ['entry/src/main/ets/assets/logo.png'],
      modified: [],
      removed: [],
    });
    expect(findings.some((f) => f.level === 'warn' && f.file?.includes('logo.png'))).toBe(true);
  });

  it('notes empty pushes and removal', () => {
    expect(runLightweightStaticCheck({ added: [], modified: [], removed: [] })).toEqual([
      { level: 'info', message: 'Push 未包含文件改动。' },
    ]);
    const removed = runLightweightStaticCheck({ added: [], modified: [], removed: ['a.ets'] });
    expect(removed.some((f) => f.message.includes('删除了 1 个文件'))).toBe(true);
  });
});

describe('staticFindingsState / summarizeStaticFindings', () => {
  it('maps findings to commit-status state', () => {
    expect(staticFindingsState([])).toBe('success');
    expect(staticFindingsState([{ level: 'info', message: 'x' }])).toBe('success');
    expect(staticFindingsState([{ level: 'warn', message: 'x' }])).toBe('warning');
    expect(staticFindingsState([{ level: 'error', message: 'x' }])).toBe('error');
  });

  it('summarizes the most-severe finding first', () => {
    expect(summarizeStaticFindings([])).toBe('无改动。');
    expect(
      summarizeStaticFindings([
        { level: 'warn', message: '未知文件类型' },
        { level: 'info', message: '改动 1 个源文件' },
      ]),
    ).toBe('未知文件类型（另 1 项）');
  });
});

describe('sortStaticFindings', () => {
  it('orders error → warn → info without mutating the input', () => {
    const input = [
      { level: 'info' as const, message: 'a' },
      { level: 'error' as const, message: 'b' },
      { level: 'warn' as const, message: 'c' },
    ];
    const sorted = sortStaticFindings(input);
    expect(sorted.map((f) => f.level)).toEqual(['error', 'warn', 'info']);
    expect(input.map((f) => f.level)).toEqual(['info', 'error', 'warn']);
  });
});
