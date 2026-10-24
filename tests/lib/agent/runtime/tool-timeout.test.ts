/**
 * Unit pins for the global tool-call execution bound.
 *
 * The wrapper races every tool call against a hard time budget and against the
 * caller's AbortSignal. These tests exercise the wrapper directly: a tool that
 * never settles must reject with the timeout error at the configured budget
 * while still delivering the abort to the tool's in-flight work, a caller
 * abort must settle the race promptly even when the tool ignores the signal,
 * and normal completion must pass through untouched with no timer left behind.
 */
import type { AgentTool, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_TOOL_TIMEOUT_ENV,
  AGENT_TOOL_TIMEOUT_OVERRIDES,
  AgentToolAbortedError,
  AgentToolTimeoutError,
  CALL_AGENT_TIMEOUT_MARGIN_MS,
  DEFAULT_AGENT_TOOL_TIMEOUT_MS,
  resolveAgentToolTimeoutMs,
  withAgentToolTimeout,
} from '@/lib/agent/runtime/tool-timeout';
import { runStageMutation } from '@/lib/server/agent-runtime/mutation-fence';

const Params = Type.Object({});

type DemoTool = AgentTool<typeof Params>;

function makeTool(execute: DemoTool['execute'], name = 'demo_tool'): DemoTool {
  return {
    name,
    label: 'Demo',
    description: 'Test tool',
    parameters: Params,
    execute,
  };
}

/** A tool whose execution never settles on its own, recording the signal it got. */
function hungTool(captured: AbortSignal[], started?: () => void): DemoTool {
  return makeTool((_id, _args, signal) => {
    if (signal) captured.push(signal);
    started?.();
    return new Promise(() => {});
  });
}

function hungCallAgentTool(
  captured: AbortSignal[],
  childRuntimeMode: 'legacy' | 'native',
): DemoTool & { childRuntimeMode: 'legacy' | 'native' } {
  return { ...hungTool(captured), name: 'call_agent', childRuntimeMode };
}

const result = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  details: { source: 'tool' },
});

const setEnv = (value: string | undefined): void => {
  if (value === undefined) delete process.env[AGENT_TOOL_TIMEOUT_ENV];
  else process.env[AGENT_TOOL_TIMEOUT_ENV] = value;
};

const PI_NATIVE_CHILD_TIMEOUT_ENV = 'OPENMAIC_PI_NATIVE_CHILD_TIMEOUT_MS';
const PI_NATIVE_CHILD_RUNTIME_ENV = 'OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME';

const setNativeChildTimeout = (value: string | undefined): void => {
  if (value === undefined) delete process.env[PI_NATIVE_CHILD_TIMEOUT_ENV];
  else process.env[PI_NATIVE_CHILD_TIMEOUT_ENV] = value;
};

const setNativeChildRuntime = (value: string | undefined): void => {
  if (value === undefined) delete process.env[PI_NATIVE_CHILD_RUNTIME_ENV];
  else process.env[PI_NATIVE_CHILD_RUNTIME_ENV] = value;
};

describe('resolveAgentToolTimeoutMs', () => {
  afterEach(() => {
    setEnv(undefined);
    setNativeChildTimeout(undefined);
    setNativeChildRuntime(undefined);
  });

  it('uses the generous default when the env var is absent or invalid', () => {
    expect(resolveAgentToolTimeoutMs('any_tool')).toBe(DEFAULT_AGENT_TOOL_TIMEOUT_MS);
    setEnv('not-a-number');
    expect(resolveAgentToolTimeoutMs('any_tool')).toBe(DEFAULT_AGENT_TOOL_TIMEOUT_MS);
    setEnv('0');
    expect(resolveAgentToolTimeoutMs('any_tool')).toBe(DEFAULT_AGENT_TOOL_TIMEOUT_MS);
  });

  it('reads the env-tunable default', () => {
    setEnv('7000');
    expect(resolveAgentToolTimeoutMs('any_tool')).toBe(7000);
  });

  it('prefers the per-tool override map over the env default', () => {
    setEnv('7000');
    expect(AGENT_TOOL_TIMEOUT_OVERRIDES['generate_scene']).toBeGreaterThan(7000);
    expect(resolveAgentToolTimeoutMs('generate_scene')).toBe(
      AGENT_TOOL_TIMEOUT_OVERRIDES['generate_scene'],
    );
  });

  it('keeps explicit legacy call_agent at the global timeout when the Native Child flag is enabled', () => {
    setEnv('5000');
    setNativeChildTimeout('20000');
    setNativeChildRuntime('true');

    expect(resolveAgentToolTimeoutMs('call_agent', process.env, 'legacy')).toBe(5000);
  });

  it('extends only native call_agent past the Native Child timeout, independently of the feature flag', () => {
    setEnv('5000');
    setNativeChildTimeout('20000');
    setNativeChildRuntime(undefined);

    expect(resolveAgentToolTimeoutMs('call_agent', process.env, 'native')).toBe(
      Math.max(5000, 20000 + CALL_AGENT_TIMEOUT_MARGIN_MS),
    );
    expect(resolveAgentToolTimeoutMs('any_tool', process.env, 'native')).toBe(5000);

    setEnv('90000');
    expect(resolveAgentToolTimeoutMs('call_agent', process.env, 'native')).toBe(90000);
  });
});

describe('withAgentToolTimeout', () => {
  beforeEach(() => {
    setEnv('5000');
  });

  afterEach(() => {
    setEnv(undefined);
    setNativeChildTimeout(undefined);
    setNativeChildRuntime(undefined);
    vi.useRealTimers();
  });

  it('does not abort native call_agent at the global budget while its Native Child budget is still running', async () => {
    vi.useFakeTimers();
    setEnv('5000');
    setNativeChildTimeout('20000');
    setNativeChildRuntime(undefined);
    const captured: AbortSignal[] = [];
    const tool = withAgentToolTimeout(hungCallAgentTool(captured, 'native'));
    const budget = resolveAgentToolTimeoutMs('call_agent', process.env, 'native');

    const promise = tool.execute('call-1', {}, undefined);
    const settled = expect(promise).rejects.toBeInstanceOf(AgentToolTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(captured[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(captured[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(budget - 20_000);
    await settled;

    expect(captured[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a hung legacy call_agent at the global budget when the Native Child flag is enabled', async () => {
    vi.useFakeTimers();
    setEnv('5000');
    setNativeChildTimeout('20000');
    setNativeChildRuntime('true');
    const captured: AbortSignal[] = [];
    const tool = withAgentToolTimeout(hungCallAgentTool(captured, 'legacy'));

    const promise = tool.execute('call-1', {}, undefined);
    const settled = expect(promise).rejects.toBeInstanceOf(AgentToolTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;

    expect(captured[0]?.aborted).toBe(true);
    expect(captured[0]?.reason).toBeInstanceOf(AgentToolTimeoutError);
    expect(captured[0]?.reason).toMatchObject({ timeoutMs: 5_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a never-settling tool at the configured budget and aborts its signal', async () => {
    vi.useFakeTimers();
    const captured: AbortSignal[] = [];
    const tool = withAgentToolTimeout(hungTool(captured));

    // Attach the rejection handlers before the timer fires so the rejection is
    // never observed as unhandled.
    const promise = tool.execute('call-1', {}, undefined);
    const isTimeout = expect(promise).rejects.toBeInstanceOf(AgentToolTimeoutError);
    const namesTool = expect(promise).rejects.toThrow(/demo_tool/);
    const namesBudget = expect(promise).rejects.toThrow(/5000ms/);
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([isTimeout, namesTool, namesBudget]);

    // The abort was actually delivered to the tool's in-flight work, with the
    // timeout error as the signal reason.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.aborted).toBe(true);
    expect(captured[0]?.reason).toBeInstanceOf(AgentToolTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles promptly when the caller signal aborts a never-settling tool', async () => {
    vi.useFakeTimers();
    const captured: AbortSignal[] = [];
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const tool = withAgentToolTimeout(hungTool(captured, started));
    const controller = new AbortController();

    const promise = tool.execute('call-1', {}, controller.signal);
    await gate;
    expect(captured[0]?.aborted).toBe(false);
    const settled = expect(promise).rejects.toBeInstanceOf(AgentToolAbortedError);
    controller.abort();
    // The cancel settles the race immediately, long before the 5s budget.
    await vi.advanceTimersByTimeAsync(0);
    await settled;

    expect(captured[0]?.aborted).toBe(true);
    // No timer is left behind once the race settled via cancellation.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never starts a tool whose caller signal already fired', async () => {
    const captured: AbortSignal[] = [];
    const tool = withAgentToolTimeout(hungTool(captured));
    const controller = new AbortController();
    controller.abort();

    await expect(tool.execute('call-1', {}, controller.signal)).rejects.toBeInstanceOf(
      AgentToolAbortedError,
    );
    expect(captured).toHaveLength(0);
  });

  it('passes normal completion through unchanged and clears the timer', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => result('ok'));
    const tool = withAgentToolTimeout(makeTool(execute));

    await expect(tool.execute('call-1', {}, undefined)).resolves.toEqual(result('ok'));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards in-flight updates but drops updates and results from a timed-out tool', async () => {
    vi.useFakeTimers();
    const emit = vi.fn<AgentToolUpdateCallback>();
    const tool = withAgentToolTimeout(
      makeTool((_id, _args, _signal, onUpdate) => {
        onUpdate?.(result('progress'));
        return new Promise((resolve) => {
          setTimeout(() => {
            onUpdate?.(result('late-progress'));
            resolve(result('late-result'));
          }, 6_000);
        });
      }),
    );

    const promise = tool.execute('call-1', {}, undefined, emit);
    const settled = expect(promise).rejects.toBeInstanceOf(AgentToolTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
    // Only the update emitted while the call was still in flight reached the
    // agent loop; the timed-out tool's post-settlement update is dropped.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(result('progress'));

    // The late timer and result are both ignored after the race settled.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a delayed durable mutation after the tool times out', async () => {
    vi.useFakeTimers();
    const durable: string[] = [];
    const tool = withAgentToolTimeout(
      makeTool(async (_id, _args, signal) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 6_000));
        await runStageMutation(signal, async () => {
          durable.push('committed');
        });
        return result('late-result');
      }),
    );

    const promise = tool.execute('call-1', {}, undefined);
    const settled = expect(promise).rejects.toBeInstanceOf(AgentToolTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(durable).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
