import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configureGenerationRunHooks,
  getGenerationRunHooks,
  resetGenerationRunHooksForTests,
} from '@/lib/server/generation-run-hooks/registry';
import {
  authorizeGenerationStart,
  classifyHostFailure,
  GenerationStartRefusedError,
  reportGenerationRunEvent,
  resetRunEventQueueForTests,
  runGenerationExecution,
} from '@/lib/server/generation-run-hooks/runtime';
import type {
  GenerationExecutionContext,
  GenerationStartContext,
} from '@/lib/server/generation-run-hooks/types';
import { shouldFallbackFor } from '@/lib/server/llm-fallback';
import { mediaFailure } from '@/lib/server/generation/run/media';
import { failedExtraction } from '@/lib/server/materials/extraction';

beforeEach(() => {
  resetGenerationRunHooksForTests();
  resetRunEventQueueForTests();
});
afterEach(() => {
  resetGenerationRunHooksForTests();
  resetRunEventQueueForTests();
  vi.restoreAllMocks();
});

/** A host error, as a host's model middleware or fetch might throw it. */
class QuotaError extends Error {
  constructor() {
    super('The quota is used up');
    this.name = 'QuotaError';
  }
}
const classifyFailure = (error: unknown) =>
  error instanceof QuotaError ? { errorCode: 'QUOTA_EXHAUSTED', retryable: false } : undefined;

const startContext = {
  runId: 'run-AAAAAAAAAAAAAAAA',
  principal: { ownerId: 'owner-1' },
  ownerId: 'owner-1',
  input: {},
  request: new Request('http://localhost/api/generation-runs'),
  origin: 'generation-runs',
  tx: {},
} as unknown as GenerationStartContext;

const runContext: GenerationExecutionContext = {
  kind: 'generation-run',
  runId: 'run-AAAAAAAAAAAAAAAA',
  ownerId: 'owner-1',
  currentOwnerId: 'owner-1',
  attributes: {},
  takeover: false,
};

describe('configureGenerationRunHooks', () => {
  it('has no hooks by default', () => {
    const hooks = getGenerationRunHooks();
    expect(hooks.authorizeStart).toBeUndefined();
    expect(hooks.wrapExecution).toBeUndefined();
    expect(hooks.classifyFailure).toBeUndefined();
    expect(hooks.onRunEvent).toBeUndefined();
  });

  it('registers once, binds class hooks to their instance, and is sealed by the first read', async () => {
    class Host {
      readonly name = 'class-host';
      readonly #code = 'FROM_CLASS';
      classifyFailure() {
        return { errorCode: this.#code, retryable: true };
      }
    }
    configureGenerationRunHooks(new Host());
    expect(getGenerationRunHooks().classifyFailure!(new Error())).toEqual({
      errorCode: 'FROM_CLASS',
      retryable: true,
    });
    expect(() => configureGenerationRunHooks({ name: 'again' })).toThrow(/already configured/);

    resetGenerationRunHooksForTests();
    getGenerationRunHooks();
    expect(() => configureGenerationRunHooks({ name: 'late' })).toThrow(/after generation started/);
  });

  it('refuses a misspelled hook, with the suggestion, and a malformed registration', () => {
    expect(() =>
      configureGenerationRunHooks({ name: 'h', wrapExecutoin: async () => {} } as never),
    ).toThrow(/did you mean "wrapExecution"/);
    expect(() => configureGenerationRunHooks({ name: '' })).toThrow(/non-empty name/);
    expect(() => configureGenerationRunHooks({ name: 'h', onRunEvent: 'x' } as never)).toThrow(
      /onRunEvent to be a function/,
    );
  });
});

describe('authorizeGenerationStart', () => {
  it('answers no attributes without the hook, and the attributes of an admission', async () => {
    expect(await authorizeGenerationStart(startContext)).toBeUndefined();
    resetGenerationRunHooksForTests();
    const authorizeStart = vi.fn(async () => ({
      allow: true as const,
      attributes: { plan: 'pro' },
    }));
    configureGenerationRunHooks({ name: 'h', authorizeStart });
    expect(await authorizeGenerationStart(startContext)).toEqual({ plan: 'pro' });
    expect(authorizeStart).toHaveBeenCalledWith(startContext);
  });

  it('turns a refusal into the error the route answers with', async () => {
    configureGenerationRunHooks({
      name: 'h',
      authorizeStart: async () => ({
        allow: false,
        status: 402,
        code: 'QUOTA_EXHAUSTED',
        message: 'No quota left',
        headers: { 'retry-after': '60' },
      }),
    });
    const refused = await authorizeGenerationStart(startContext).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(GenerationStartRefusedError);
    expect(refused).toMatchObject({
      status: 402,
      code: 'QUOTA_EXHAUSTED',
      message: 'No quota left',
    });
    expect((refused as GenerationStartRefusedError).headers.get('retry-after')).toBe('60');
  });

  it.each([
    ['no decision', undefined],
    ['a status outside 400-599', { allow: false, status: 302, code: 'X', message: 'm' }],
    ['a lower-case code', { allow: false, status: 403, code: 'nope', message: 'm' }],
    ['no message', { allow: false, status: 403, code: 'NOPE', message: '' }],
    ['non-string attributes', { allow: true, attributes: { n: 1 } }],
    ['oversized attributes', { allow: true, attributes: { big: 'x'.repeat(9000) } }],
  ])('treats %s as a fault, not a refusal', async (_label, decision) => {
    configureGenerationRunHooks({ name: 'h', authorizeStart: async () => decision as never });
    const error = await authorizeGenerationStart(startContext).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GenerationStartRefusedError);
  });
});

describe('runGenerationExecution', () => {
  it('runs the execution directly without the hook', async () => {
    expect(await runGenerationExecution(runContext, async () => 'done')).toEqual({
      ran: true,
      value: 'done',
    });
  });

  it('runs it inside the wrapper, with the context', async () => {
    const seen: unknown[] = [];
    configureGenerationRunHooks({
      name: 'h',
      wrapExecution: async (context, execute) => {
        seen.push(context);
        return execute();
      },
    });
    expect(await runGenerationExecution(runContext, async () => 'done')).toEqual({
      ran: true,
      value: 'done',
    });
    expect(seen).toEqual([runContext]);
  });

  it('answers ran: false for a wrapper that refuses or never runs the execution', async () => {
    const refusal = new QuotaError();
    const execute = vi.fn(async () => 'done');
    let wrap: (execute: () => Promise<unknown>) => Promise<unknown> = async () => {
      throw refusal;
    };
    configureGenerationRunHooks({
      name: 'h',
      wrapExecution: ((_context: unknown, run: () => Promise<unknown>) => wrap(run)) as never,
    });
    expect(await runGenerationExecution(runContext, execute)).toEqual({
      ran: false,
      error: refusal,
    });
    wrap = async () => 'skipped';
    const skipped = await runGenerationExecution(runContext, execute);
    expect(skipped.ran).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps the execution's own outcome whatever the wrapper does around it", async () => {
    configureGenerationRunHooks({
      name: 'h',
      wrapExecution: async (_context, execute) => {
        await execute();
        throw new Error('the wrapper failed afterwards');
      },
    });
    expect(await runGenerationExecution(runContext, async () => 'done')).toEqual({
      ran: true,
      value: 'done',
    });
    await expect(
      runGenerationExecution(runContext, async () => {
        throw new QuotaError();
      }),
    ).rejects.toBeInstanceOf(QuotaError);
  });
});

describe('classifyHostFailure', () => {
  it('is undefined without the hook, and for errors the host does not know', () => {
    expect(classifyHostFailure(new QuotaError())).toBeUndefined();
    resetGenerationRunHooksForTests();
    configureGenerationRunHooks({ name: 'h', classifyFailure });
    expect(classifyHostFailure(new Error('provider down'))).toBeUndefined();
  });

  it('finds a host error wrapped by a provider SDK', () => {
    configureGenerationRunHooks({ name: 'h', classifyFailure });
    const expected = { errorCode: 'QUOTA_EXHAUSTED', retryable: false };
    expect(classifyHostFailure(new Error('call failed', { cause: new QuotaError() }))).toEqual(
      expected,
    );
    expect(classifyHostFailure({ lastError: new QuotaError() })).toEqual(expected);
    expect(classifyHostFailure({ errors: [new Error('a'), new QuotaError()] })).toEqual(expected);
  });

  it('ignores a classifier that throws or answers malformed', () => {
    let answer: () => unknown = () => {
      throw new Error('classifier bug');
    };
    configureGenerationRunHooks({ name: 'h', classifyFailure: () => answer() as never });
    expect(classifyHostFailure(new QuotaError())).toBeUndefined();
    answer = () => ({ errorCode: 'X' });
    expect(classifyHostFailure(new QuotaError())).toBeUndefined();
  });

  it('is what the model fallback, a media failure and an extraction failure report', () => {
    const rateLimited = Object.assign(new QuotaError(), { statusCode: 429 });
    expect(shouldFallbackFor(rateLimited, undefined)).toBe(true);
    expect(mediaFailure(new QuotaError(), 'image')).toEqual({
      message: 'Image generation failed',
    });
    expect(failedExtraction(new QuotaError())).toMatchObject({ errorCode: 'EXTRACTION_FAILED' });

    resetGenerationRunHooksForTests();
    configureGenerationRunHooks({ name: 'h', classifyFailure });
    expect(shouldFallbackFor(rateLimited, undefined)).toBe(false);
    expect(mediaFailure(new QuotaError(), 'image')).toEqual({
      message: 'The quota is used up',
      errorCode: 'QUOTA_EXHAUSTED',
    });
    expect(failedExtraction(new QuotaError())).toEqual({
      status: 'failed',
      error: 'The quota is used up',
      errorCode: 'QUOTA_EXHAUSTED',
      retryable: false,
    });
  });
});

describe('reportGenerationRunEvent', () => {
  const event = (runId: string) => ({
    type: 'started' as const,
    runId,
    ownerId: 'anon:stored',
    attributes: {},
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('resolves nothing without a listener', () => {
    const resolve = vi.fn(async () => 'account');
    reportGenerationRunEvent(event('run-1'), resolve);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('reports the current owner, in order, even when an earlier one resolves slower', async () => {
    const seen: Array<{ runId: string; ownerId: string; currentOwnerId: string }> = [];
    configureGenerationRunHooks({
      name: 'h',
      onRunEvent: ({ runId, ownerId, currentOwnerId }) =>
        void seen.push({ runId, ownerId, currentOwnerId }),
    });
    reportGenerationRunEvent(event('run-1'), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'account';
    });
    reportGenerationRunEvent(event('run-2'), async () => {
      throw new Error('the database is gone');
    });
    await settle();
    expect(seen).toEqual([
      { runId: 'run-1', ownerId: 'anon:stored', currentOwnerId: 'account' },
      // Unresolvable: the stored owner.
      { runId: 'run-2', ownerId: 'anon:stored', currentOwnerId: 'anon:stored' },
    ]);
  });

  it('reports the stored owner when the lookup stalls, and goes on with the next', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resetRunEventQueueForTests({ lookupTimeoutMs: 20 });
    const seen: string[] = [];
    configureGenerationRunHooks({
      name: 'h',
      onRunEvent: ({ runId, currentOwnerId }) => void seen.push(`${runId}:${currentOwnerId}`),
    });
    reportGenerationRunEvent(event('run-1'), () => new Promise<string>(() => undefined));
    reportGenerationRunEvent(event('run-2'), async () => 'account');
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual(['run-1:anon:stored', 'run-2:account']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('took over 20 ms'));
  });

  it('drops a notification that finds the queue full, and counts the drops', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resetRunEventQueueForTests({ maxPending: 2, lookupTimeoutMs: 30 });
    const seen: string[] = [];
    configureGenerationRunHooks({
      name: 'h',
      onRunEvent: ({ runId }) => void seen.push(runId),
    });
    const stalled = () => new Promise<string>(() => undefined);
    for (const runId of ['run-1', 'run-2', 'run-3', 'run-4']) {
      reportGenerationRunEvent(event(runId), stalled);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(2 dropped so far)'));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    // The queued ones are delivered in order; room frees up as they are.
    expect(seen).toEqual(['run-1', 'run-2']);
    reportGenerationRunEvent(event('run-5'), async () => 'account');
    await vi.waitFor(() => expect(seen).toEqual(['run-1', 'run-2', 'run-5']));
  });

  it('never throws, for a listener that throws or rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls = 0;
    configureGenerationRunHooks({
      name: 'h',
      onRunEvent: () => {
        calls += 1;
        if (calls === 1) throw new Error('listener bug');
        return Promise.reject(new Error('async listener bug'));
      },
    });
    const owner = async () => 'anon:stored';
    expect(() => reportGenerationRunEvent(event('run-1'), owner)).not.toThrow();
    expect(() => reportGenerationRunEvent(event('run-2'), owner)).not.toThrow();
    await settle();
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('client boundary', () => {
  const ROOT = join(__dirname, '..', '..', '..');

  function clientModules(dir: string): string[] {
    const found: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) found.push(...clientModules(path));
      else if (/\.(ts|tsx)$/.test(name)) {
        const text = readFileSync(path, 'utf8');
        if (/^\s*['"]use client['"]/.test(text)) found.push(path);
      }
    }
    return found;
  }

  it('keeps the generation run hooks out of client modules', () => {
    const modules = ['app', 'components', 'lib'].flatMap((dir) => clientModules(join(ROOT, dir)));
    expect(modules.length).toBeGreaterThan(10);
    const offenders = modules
      .filter((path) =>
        /from\s+['"]@\/lib\/server\/generation-run-hooks(?:\/[^'"]*)?['"]/.test(
          readFileSync(path, 'utf8'),
        ),
      )
      .map((path) => relative(ROOT, path));
    expect(offenders).toEqual([]);
  });
});
