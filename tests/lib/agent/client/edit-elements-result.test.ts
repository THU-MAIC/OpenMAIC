import { describe, expect, it } from 'vitest';
import {
  editElementsApplyCorrectionKey,
  editElementsOutcome,
  editElementsRefuseReason,
} from '@/lib/agent/client/edit-elements-result';

describe('edit-elements result protocol', () => {
  it('derives applied and refused outcomes from structured details', () => {
    expect(editElementsOutcome({ intents: [{ type: 'element.update' }] })).toBe('applied');
    expect(editElementsOutcome({ intents: null })).toBe('refused');
    expect(editElementsOutcome({ intents: [] })).toBe('pending');
    expect(editElementsOutcome(undefined)).toBe('pending');
  });

  it('prefers the structured refusal reason', () => {
    expect(
      editElementsRefuseReason({
        content: [{ type: 'text', text: 'Could not apply the edit: fallback.' }],
        details: { intents: null, refuseReason: 'element "a" is locked' },
      }),
    ).toBe('element "a" is locked');
  });

  it('parses the legacy text fallback in one shared place', () => {
    expect(
      editElementsRefuseReason({
        content: [
          {
            type: 'text',
            text: 'Could not apply the edit: no open edit session. Nothing was changed.',
          },
        ],
        details: { intents: null },
      }),
    ).toBe('no open edit session');
  });

  it('distinguishes complete refusal from a mixed-result turn', () => {
    expect(editElementsApplyCorrectionKey({ applied: false, failed: false })).toBeNull();
    expect(editElementsApplyCorrectionKey({ applied: false, failed: true })).toBe(
      'edit.editElements.applyFailed',
    );
    expect(editElementsApplyCorrectionKey({ applied: true, failed: true })).toBe(
      'edit.editElements.applyPartiallyFailed',
    );
  });
});
