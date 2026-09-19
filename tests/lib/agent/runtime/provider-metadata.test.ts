import { describe, it, expect } from 'vitest';
import {
  captureToolCallMetadata,
  emitToolCallProviderOptions,
} from '@/lib/agent/runtime/provider-metadata';

describe('provider-metadata seam', () => {
  it('captures google thoughtSignature from a fullStream tool-call part', () => {
    const part = {
      type: 'tool-call',
      toolCallId: 't1',
      toolName: 'x',
      input: {},
      providerMetadata: { google: { thoughtSignature: 'sig-abc' } },
    };
    expect(captureToolCallMetadata(part)).toEqual({ google: { thoughtSignature: 'sig-abc' } });
  });
  it('returns undefined when no provider metadata present', () => {
    expect(
      captureToolCallMetadata({ type: 'tool-call', toolCallId: 't1', toolName: 'x', input: {} }),
    ).toBeUndefined();
  });
  it('re-emits captured metadata as providerOptions for the next turn', () => {
    expect(emitToolCallProviderOptions({ google: { thoughtSignature: 'sig-abc' } })).toEqual({
      google: { thoughtSignature: 'sig-abc' },
    });
  });
  it('round-trips: capture then emit is identity', () => {
    const meta = { google: { thoughtSignature: 's' } };
    expect(
      emitToolCallProviderOptions(captureToolCallMetadata({ providerMetadata: meta })),
    ).toEqual(meta);
  });
});
