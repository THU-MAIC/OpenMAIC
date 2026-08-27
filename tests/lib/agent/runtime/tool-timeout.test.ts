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
  DEFAULT_AGENT_TOOL_TIMEOUT_MS,
  resolveAgentToolTimeoutMs,
  withAgentToolTimeout,
} from '@/lib/agent/runtime/tool-timeout';

const Params = Type.Object({});

type DemoTool = AgentTool<typeof Params>;

function makeTool(execute: DemoTool['execute']): DemoTool {
  return {
    name: 'demo_tool',
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

const result = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  details: { source: 'tool' },
});

const setEnv = (value: string | undefined): void => {
  if (value === undefined) delete process.env[AGENT_TOOL_TIMEOUT_ENV];
  else process.env[AGENT_TOOL_TIMEOUT_ENV] = value;
};

describe('resolveAgentToolTimeoutMs', () => {
  afterEach(() => {
    setEnv(undefined);
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
});

describe('withAgentToolTimeout', () => {
  beforeEach(() => {
    setEnv('5000');
  });

  afterEach(() => {
    setEnv(undefined);
    vi.useRealTimers();
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

  it('forwards in-flight updates but drops updates and results from a zombie tool', async () => {
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
    // agent loop; the zombie tool's post-settlement update is dropped.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(result('progress'));

    // The zombie's timer and result are both ignored after the race settled.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
