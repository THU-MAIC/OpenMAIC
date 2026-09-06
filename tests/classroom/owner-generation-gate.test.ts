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

  it('keeps a 404 distinct from a silent sidecar', () => {
    expect(classroomGenerationOwnership({ outcome: 'absent' })).toBe('ownerless');
    expect(classroomGenerationOwnership({ outcome: 'unavailable' })).toBe('unresolved');
  });
});

describe('classroom generation owner gate', () => {
  it.each(OWNERSHIPS)('is inert in browser-only mode: %s', (ownership) => {
    expect(mayStartOwnerGeneration(false, ownership)).toBe(true);
  });

  it.each([
    ['owner', true],
    ['not-owner', false],
    // A 404 is not a licence to spend. The client cannot tell "this course has
    // no owner" from "this deployment told me nothing", and a visitor who
    // guesses a shared course URL must never bill the operator.
    ['ownerless', false],
    ['unresolved', false],
  ] as const)('under server-backed persistence, %s => %s', (ownership, allowed) => {
    expect(mayStartOwnerGeneration(true, ownership)).toBe(allowed);
  });

  it('admits exactly one state, so a new one cannot be silently permitted', () => {
    const permitted = OWNERSHIPS.filter((ownership) => mayStartOwnerGeneration(true, ownership));
    expect(permitted).toEqual(['owner']);
  });
});

// There is no component-render harness in this suite, so the wiring itself is
// checked statically: a surface that forgot to feed the sidecar's answer into
// the shared permission store would keep every unit test above green while
// spending the operator's budget for any visitor.
describe('classroom surfaces feed the sidecar into the gate', () => {
  it.each(['app/classroom/[id]/page.tsx', 'components/classroom/ClassroomSurface.tsx'])(
    '%s asks the sidecar and gates on the shared permission',
    (path) => {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      expect(source).toContain('fetchStageMeta');
      expect(source).toContain('classroomGenerationOwnership(result)');
      expect(source).toContain('noteStageGenerationOwnership');
      // Reset on course switch, so a previous course's answer never carries over.
      expect(source).toContain("noteStageGenerationOwnership(classroomId, 'unresolved')");
      // The resume effect re-runs when the answer lands.
      expect(source).toMatch(/\}, \[loading, error, mayGenerate, generateRemaining\]\);/);
      // The outline-retry affordance is withheld, not merely refused.
      expect(source).toMatch(/onRetryOutline=\{mayGenerate \? retrySingleOutline : undefined\}/);
    },
  );

  it('does not ask the sidecar from the pane in browser-only mode', () => {
    const source = readFileSync(
      join(process.cwd(), 'components/classroom/ClassroomSurface.tsx'),
      'utf8',
    );
    const fetchIndex = source.indexOf('void fetchStageMeta(');
    expect(fetchIndex).toBeGreaterThan(0);
    const guardIndex = source.lastIndexOf('if (isServerBackedMediaPersistence()) {', fetchIndex);
    expect(guardIndex).toBeGreaterThan(0);
  });
});
