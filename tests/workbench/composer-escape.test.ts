import { describe, expect, it } from 'vitest';
import {
  DOUBLE_ESCAPE_WINDOW_MS,
  resolveEscapeStopIntent,
} from '@/components/workbench/chat/composer-escape';

const base = {
  generating: true,
  overlayOwnsEscape: false,
  armedAt: null as number | null,
  now: 1_000,
};

describe('resolveEscapeStopIntent', () => {
  it('arms on the first press while the agent is generating', () => {
    expect(resolveEscapeStopIntent(base)).toBe('arm');
  });

  it('stops on a second press inside the window', () => {
    expect(
      resolveEscapeStopIntent({ ...base, armedAt: 1_000, now: 1_000 + DOUBLE_ESCAPE_WINDOW_MS }),
    ).toBe('stop');
    expect(resolveEscapeStopIntent({ ...base, armedAt: 1_000, now: 1_200 })).toBe('stop');
  });

  it('re-arms once the window has passed', () => {
    expect(
      resolveEscapeStopIntent({ ...base, armedAt: 1_000, now: 1_001 + DOUBLE_ESCAPE_WINDOW_MS }),
    ).toBe('arm');
  });

  it('never stops when nothing is generating', () => {
    expect(resolveEscapeStopIntent({ ...base, generating: false })).toBe('ignore');
    expect(
      resolveEscapeStopIntent({ ...base, generating: false, armedAt: 1_000, now: 1_100 }),
    ).toBe('ignore');
  });

  it('yields to an overlay that owns Escape', () => {
    expect(resolveEscapeStopIntent({ ...base, overlayOwnsEscape: true })).toBe('ignore');
  });
});
