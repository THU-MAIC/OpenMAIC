import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  classroomGenerationOwnership,
  mayStartOwnerGeneration,
  type ClassroomGenerationOwnership,
} from '@/lib/classroom/stage-ownership-signal';
import type { StageMetaResult } from '@/lib/classroom/stage-meta-client';

const OWNERSHIPS: readonly ClassroomGenerationOwnership[] = [
  'owner',
  'not-owner',
  'ownerless',
  'unresolved',
];

function found(isOwner: boolean): StageMetaResult {
  return {
    outcome: 'found',
    meta: { isOwner, isPublic: false, publishedAt: null, generationComplete: false },
  };
}

describe('sidecar outcome to generation ownership', () => {
  it('splits a definite answer into owner and not-owner', () => {
    expect(classroomGenerationOwnership(found(true))).toBe('owner');
    expect(classroomGenerationOwnership(found(false))).toBe('not-owner');
  });

  it('treats an absent record as the answer that no ownership fact exists', () => {
    expect(classroomGenerationOwnership({ outcome: 'absent' })).toBe('ownerless');
  });

  it('treats a silent sidecar as no answer at all', () => {
    expect(classroomGenerationOwnership({ outcome: 'unavailable' })).toBe('unresolved');
  });
});

describe('classroom generation owner gate', () => {
  it.each(OWNERSHIPS)('is inert in browser-only mode: %s', (ownership) => {
    expect(mayStartOwnerGeneration(false, ownership)).toBe(true);
  });

  it.each([
    ['owner', true],
    ['ownerless', true],
    ['not-owner', false],
    ['unresolved', false],
  ] as const)('under server-backed persistence, %s => %s', (ownership, allowed) => {
    expect(mayStartOwnerGeneration(true, ownership)).toBe(allowed);
  });

  it('covers every ownership state, so a new one cannot be silently permitted', () => {
    const decided = OWNERSHIPS.map((ownership) => mayStartOwnerGeneration(true, ownership));
    expect(decided).toEqual([true, false, true, false]);
  });
});

// There is no component-render harness in this suite, so the wiring itself is
// checked statically: a surface that forgot to feed the sidecar's answer into
// the gate would keep every unit test above green while spending the
// operator's budget for any visitor.
describe('classroom surfaces feed the sidecar into the gate', () => {
  it.each(['app/classroom/[id]/page.tsx', 'components/classroom/ClassroomSurface.tsx'])(
    '%s asks the sidecar and gates the resume effect on its answer',
    (path) => {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      expect(source).toContain('fetchStageMeta');
      expect(source).toContain('classroomGenerationOwnership(result)');
      expect(source).toContain('isServerBackedMediaPersistence()');
      // Reset on course switch, so a previous course's answer never carries over.
      expect(source).toContain("setOwnership('unresolved')");
      // The resume effect re-runs when the answer lands.
      expect(source).toMatch(/\}, \[loading, error, ownership, generateRemaining\]\);/);
    },
  );
});
