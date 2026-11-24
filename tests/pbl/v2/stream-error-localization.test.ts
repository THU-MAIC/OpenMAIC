/**
 * #2400 — stream errors must keep their code so the client can localize them
 * instead of rendering whatever string the server sent.
 */
import { describe, expect, it } from 'vitest';

import {
  assertNotStreamError,
  localizeStreamError,
  PBLStreamError,
} from '@/components/scene-renderers/pbl/v2/use-instructor-stream';

const t = (key: string) => {
  const table: Record<string, string> = {
    'pbl.v2.chat.emptyOutput': 'The character has nothing to say this turn. Please try again.',
  };
  return table[key] ?? key;
};

describe('#2400 — PBL stream error localization', () => {
  it('assertNotStreamError keeps the code on the thrown error', () => {
    let caught: unknown;
    try {
      assertNotStreamError({ type: 'error', code: 'STREAM_ERROR', message: 'boom' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PBLStreamError);
    expect((caught as PBLStreamError).code).toBe('STREAM_ERROR');
    expect((caught as Error).message).toBe('STREAM_ERROR: boom');
  });

  it('maps EMPTY_LLM_OUTPUT to the localized notice', () => {
    const err = new PBLStreamError('EMPTY_LLM_OUTPUT', 'EMPTY_LLM_OUTPUT: empty');
    expect(localizeStreamError(err, t)).toBe(
      'The character has nothing to say this turn. Please try again.',
    );
  });

  it('leaves unknown codes and plain errors untouched', () => {
    expect(localizeStreamError(new PBLStreamError('LLM_ERROR', 'LLM_ERROR: bad'), t)).toBe(
      'LLM_ERROR: bad',
    );
    expect(localizeStreamError(new Error('network down'), t)).toBe('network down');
  });
});
