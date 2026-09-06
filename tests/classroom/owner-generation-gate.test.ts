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
    const guardIndex = source.lastIndexOf('!isServerBackedMediaPersistence()) return;', fetchIndex);
    expect(guardIndex).toBeGreaterThan(0);
  });

  // The load is what brings a course into the server store the first time it is
  // opened, so asking beforehand asks about a course whose ownership row does
  // not exist yet - and a 404 locks its genuine author out for the mount.
  it('asks the sidecar only after a document load succeeds, and after every later one', () => {
    const source = readFileSync(
      join(process.cwd(), 'components/classroom/ClassroomSurface.tsx'),
      'utf8',
    );
    expect(source).toContain('const refreshOwnership = () => {');
    // Called on the success branch, and no longer only after a retry.
    expect(source).toMatch(/answered[\s\S]*?refreshOwnership\(\);/);
    expect(source).not.toContain('availabilityAttempt > 0');
    // Nothing calls it before the load starts.
    const definition = source.indexOf('const refreshOwnership = () => {');
    const loadStart = source.indexOf('const loadUntilAvailable = async () => {');
    expect(source.slice(definition, loadStart)).not.toMatch(/^\s*refreshOwnership\(\);$/m);
  });

  it('clears parked media allocations when a course is (re)opened', () => {
    for (const path of [
      'app/classroom/[id]/page.tsx',
      'components/classroom/ClassroomSurface.tsx',
    ]) {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      expect(source).toContain('clearPendingMediaAllocations(classroomId)');
    }
  });

  // Listening back to narration and seeing whether a line has any spend nothing,
  // so the gate belongs on regeneration alone.
  it('withholds narration regeneration from a viewer, and nothing else', () => {
    const bar = readFileSync(
      join(process.cwd(), 'components/edit/ActionsBar/ActionsBar.tsx'),
      'utf8',
    );
    expect(bar).not.toContain('managedTts && mayGenerate');
    // Both regenerate affordances are withheld...
    expect(bar).toContain('{mayRegenerate ? (');
    expect(bar).toContain('{!lineMode && ttsActive && mayGenerate && (');
    // ...while status and preview keep answering to managed TTS alone.
    expect(bar).toMatch(/const ttsActive = useSettingsStore\(/);
    const tts = readFileSync(join(process.cwd(), 'lib/audio/regenerate-speech-tts.ts'), 'utf8');
    expect(tts).toContain('if (!mayGenerateForStage(stageId)) return null;');
  });

  // Replacing the controller without aborting it orphans a media loop that goes
  // on calling providers and storing assets for a course the user has left.
  it('aborts the previous media pass before starting another', () => {
    const source = readFileSync(join(process.cwd(), 'lib/hooks/use-scene-generator.ts'), 'utf8');
    expect(source).toMatch(
      /mediaAbortRef\.current\?\.abort\(\);\s*\n\s*mediaAbortRef\.current = new AbortController\(\);/,
    );
  });
});
