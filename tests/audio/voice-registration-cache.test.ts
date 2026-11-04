import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { waitForVoiceRegistration } from '@/lib/audio/voice-registration-cache';

describe('voice registration caller waits', () => {
  it('observes a later operation failure even when its only caller was already aborted', () => {
    // A separate Node event loop observes real rejection lifecycle events without
    // Vitest's own unhandled-rejection listener intercepting the expected regression.
    const moduleUrl = pathToFileURL(resolve('lib/audio/voice-registration-cache.ts')).href;
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `
          import registration from ${JSON.stringify(moduleUrl)};
          const { waitForVoiceRegistration } = registration;
          const unhandled = [];
          process.on('unhandledRejection', error => unhandled.push(error.message));
          let fail;
          const operation = new Promise((_, reject) => { fail = reject; });
          const signal = AbortSignal.abort(new Error('caller cancelled'));
          const caller = await waitForVoiceRegistration(operation, signal).catch(error => error.message);
          fail(new Error('transport failed later'));
          await new Promise(resolve => setImmediate(resolve));
          await new Promise(resolve => setImmediate(resolve));
          console.log(JSON.stringify({ caller, unhandled }));
        `,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ caller: 'caller cancelled', unhandled: [] });
  });

  it('preserves the operation error for an active caller alongside an aborted caller', async () => {
    let fail!: (error: Error) => void;
    const operation = new Promise<string>((_, reject) => {
      fail = reject;
    });
    const cancelled = new Error('cancelled');
    const transport = new Error('transport');
    const first = waitForVoiceRegistration(operation, AbortSignal.abort(cancelled));
    const second = waitForVoiceRegistration(operation, new AbortController().signal);
    const firstResult = expect(first).rejects.toBe(cancelled);
    const secondResult = expect(second).rejects.toBe(transport);
    fail(transport);
    await Promise.all([firstResult, secondResult]);
  });
});
