/**
 * The skill button's seed (P1 fix, behaviour locked): wherever the caret
 * sits, `slashQuery(draft, caret)` must be non-empty after seeding — the menu
 * is guaranteed to open, and repeat clicks never stack a second `/`.
 */
import { describe, expect, it } from 'vitest';

import { seedSlashQuery, slashQuery } from '@/lib/workbench/composer-skills';

describe('seedSlashQuery', () => {
  it('seeds a live query from an empty draft', () => {
    const next = seedSlashQuery('', 0);
    expect(next).toEqual({ draft: '/', caret: 1 });
    expect(slashQuery(next!.draft, next!.caret)).not.toBeNull();
  });

  it('seeds after a word-end caret with a lead space (the P1 case)', () => {
    // The most common state: a sentence typed, caret at its end. The naive
    // splice produced `course/` — a dead token no query matches.
    const draft = 'help me design a course';
    const next = seedSlashQuery(draft, draft.length);
    expect(next!.draft).toBe('help me design a course /');
    expect(slashQuery(next!.draft, next!.caret)).not.toBeNull();
  });

  it('moves a mid-word caret to the word end instead of sawing the word', () => {
    const next = seedSlashQuery('hello', 3);
    expect(next!.draft).toBe('hello /');
    expect(next!.caret).toBe(7);
    expect(slashQuery(next!.draft, next!.caret)).not.toBeNull();
  });

  it('adds no space when the caret already sits on whitespace', () => {
    const next = seedSlashQuery('foo ', 4);
    expect(next!.draft).toBe('foo /');
    expect(slashQuery(next!.draft, next!.caret)).not.toBeNull();
  });

  it('returns null when a query is already live — repeat clicks never stack', () => {
    const first = seedSlashQuery('hi', 2)!;
    expect(slashQuery(first.draft, first.caret)).not.toBeNull();
    // The second click runs against the seeded draft at the seeded caret.
    expect(seedSlashQuery(first.draft, first.caret)).toBeNull();
  });

  it('every seed result leaves a live query (property check over caret sweep)', () => {
    const draft = 'one two three';
    for (let caret = 0; caret <= draft.length; caret += 1) {
      const next = seedSlashQuery(draft, caret);
      if (next === null) continue;
      expect(
        slashQuery(next.draft, next.caret),
        `caret ${caret} seeded a dead token: ${JSON.stringify(next)}`,
      ).not.toBeNull();
    }
  });
});
