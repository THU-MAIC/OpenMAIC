import { describe, it, expect } from 'vitest';
import {
  isEditApplied,
  isEditRefused,
  deriveEditFailed,
} from '@/components/edit/AgentPanel/edit-tool-state';

describe('isEditApplied', () => {
  it('is true when details.html is a string (edits landed)', () => {
    expect(isEditApplied({ details: { html: '<html></html>', editCount: 2 } })).toBe(true);
  });
  it('is false when details.html is null (refusal / unappliable edit)', () => {
    expect(isEditApplied({ details: { html: null, editCount: 0 } })).toBe(false);
  });
  it('is false when there is no result', () => {
    expect(isEditApplied(null)).toBe(false);
    expect(isEditApplied(undefined)).toBe(false);
  });
});

describe('isEditRefused', () => {
  it('is true only when details.html is explicitly null', () => {
    expect(isEditRefused({ details: { html: null } })).toBe(true);
    expect(isEditRefused({ details: { html: '<html/>' } })).toBe(false);
    expect(isEditRefused({ details: { sceneId: 's1' } })).toBe(false); // html absent
    expect(isEditRefused(null)).toBe(false);
  });
});

describe('deriveEditFailed', () => {
  // Bug #3: a successful edit must NOT render as failed just because the
  // assistant message ended with status `incomplete` (reasoning model leaves
  // the wrap-up turn incomplete, but the edit itself applied).
  it('is NOT failed when html applied', () => {
    expect(
      deriveEditFailed({
        running: false,
        stopped: false,
        isError: false,
        result: { details: { html: '<html>fixed</html>', editCount: 2 } },
      }),
    ).toBe(false);
  });

  it('is failed when the tool explicitly refused (html === null)', () => {
    expect(
      deriveEditFailed({
        running: false,
        stopped: false,
        isError: false,
        result: {
          details: { html: null, editCount: 0 },
          content: [{ type: 'text', text: 'could not anchor' }],
        },
      }),
    ).toBe(true);
  });

  it('is failed when isError is set', () => {
    expect(deriveEditFailed({ running: false, stopped: false, isError: true, result: null })).toBe(
      true,
    );
  });

  // Bias to success: a missing/unpropagated result (no explicit failure signal)
  // is NOT a failure — it wrongly showed ✕ on edits that actually applied.
  it('is NOT failed when the result is missing / unpropagated', () => {
    expect(deriveEditFailed({ running: false, stopped: false, isError: false, result: null })).toBe(
      false,
    );
  });

  it('is NOT failed when a result is present but carries no html marker (slimmed)', () => {
    expect(
      deriveEditFailed({
        running: false,
        stopped: false,
        isError: false,
        result: { details: { sceneId: 's1' } },
      }),
    ).toBe(false);
  });

  it('is not failed while running', () => {
    expect(deriveEditFailed({ running: true, stopped: false, isError: false, result: null })).toBe(
      false,
    );
  });

  it('is not failed when stopped (cancelled) — stopped is its own state', () => {
    expect(deriveEditFailed({ running: false, stopped: true, isError: true, result: null })).toBe(
      false,
    );
  });
});
