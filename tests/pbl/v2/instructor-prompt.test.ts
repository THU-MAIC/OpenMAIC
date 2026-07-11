import { describe, expect, it } from 'vitest';

import { loadPBLV2Prompt } from '@/lib/pbl/v2/prompts/loader';

describe('instructor base rules — concept_unlocked examples carry a label', () => {
  // Why: `label` is optional in the schema, so the model copies the prompt
  // examples. If any concept_unlocked example shows `signature=` without
  // `label=`, the model omits the human-readable concept name and the
  // end-of-project report falls back to a machine slug (the reviewer's finding).
  it('no concept_unlocked example shows signature= without label=', () => {
    const md = loadPBLV2Prompt('instructor-base-rules');
    const offenders = md
      .split('\n')
      .filter(
        (line) =>
          line.includes('concept_unlocked') &&
          line.includes('signature=') &&
          !line.includes('label='),
      );
    expect(offenders).toEqual([]);
  });
});
