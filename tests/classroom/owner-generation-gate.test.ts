import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The gate is inert in browser-only mode, where one viewer is by construction
// the author. These cases are about the server-backed reading.
vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: () => true,
}));

import {
  classroomGenerationOwnership,
  mayStartOwnerGeneration,
  retryWhileOwnershipUnresolved,
  type ClassroomGenerationOwnership,
} from '@/lib/classroom/stage-ownership-signal';
import {
  mayGenerateForStage,
  noteStageGenerationOwnership,
  resetGenerationPermissionsForTests,
} from '@/lib/classroom/generation-permission';
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
/**
 * One transient 5xx from the sidecar must not cost the owner the whole load.
 *
 * Every non-answer fails closed, which is right, and it means the answer has to
 * be asked for until it arrives: a single blip otherwise leaves the genuine
 * author with no resume, no Retry affordance and no legacy narration converted,
 * with nothing to change it short of a full reload.
 */
describe('asking the sidecar until it answers', () => {
  const stageId = 'retry-course';

  beforeEach(() => resetGenerationPermissionsForTests());
  afterEach(() => resetGenerationPermissionsForTests());

  /** Run without waiting: the policy under test is what it retries, not when. */
  const immediately = (run: () => void) => run();

  it('re-asks after a transient failure, and the owner generates once it lands', async () => {
    const answers: StageMetaResult[] = [{ outcome: 'unavailable' }, found(true)];
    const seen: boolean[] = [];
    const ask = async () => {
      const result = answers.shift() ?? found(true);
      const ownership = classroomGenerationOwnership(result);
      noteStageGenerationOwnership(stageId, ownership);
      seen.push(mayStartOwnerGeneration(true, ownership));
      return ownership;
    };

    await retryWhileOwnershipUnresolved(ask, {
      isCurrent: () => true,
      schedule: immediately,
    });

    // Blocked on the first answer, allowed on the second, and asked exactly
    // twice: the gate is never opened by the absence of an answer.
    expect(seen).toEqual([false, true]);
    expect(mayGenerateForStage(stageId)).toBe(true);
  });

  it('stops at the first real answer, however unwelcome', async () => {
    const ask = vi.fn(async () => {
      noteStageGenerationOwnership(stageId, 'not-owner');
      return 'not-owner' as const;
    });

    await retryWhileOwnershipUnresolved(ask, { isCurrent: () => true, schedule: immediately });

    // A visitor is an answer. Asking again would not change it, and the gate
    // stays shut throughout.
    expect(ask).toHaveBeenCalledTimes(1);
    expect(mayGenerateForStage(stageId)).toBe(false);
  });

  it('gives up rather than asking for ever, and leaves the gate shut', async () => {
    const ask = vi.fn(async () => {
      noteStageGenerationOwnership(stageId, 'unresolved');
      return 'unresolved' as const;
    });

    await retryWhileOwnershipUnresolved(ask, { isCurrent: () => true, schedule: immediately });

    expect(ask.mock.calls.length).toBeGreaterThan(1);
    expect(ask.mock.calls.length).toBeLessThan(10);
    expect(mayGenerateForStage(stageId)).toBe(false);
  });

  it('stops asking about a course this browser has moved away from', async () => {
    const ask = vi.fn(async () => 'unresolved' as const);

    await retryWhileOwnershipUnresolved(ask, { isCurrent: () => false, schedule: immediately });

    expect(ask).not.toHaveBeenCalled();
  });

  it('treats an unexpected throw as the fail-closed answer and asks again', async () => {
    let asked = 0;
    const ask = async () => {
      asked += 1;
      if (asked === 1) throw new Error('network down');
      noteStageGenerationOwnership(stageId, 'owner');
      return 'owner' as const;
    };

    await retryWhileOwnershipUnresolved(ask, { isCurrent: () => true, schedule: immediately });

    expect(asked).toBe(2);
    expect(mayGenerateForStage(stageId)).toBe(true);
  });
});

describe('classroom surfaces feed the sidecar into the gate', () => {
  it('the shared session owns the sidecar and generation gate', () => {
    const session = readFileSync(
      join(process.cwd(), 'lib/classroom/use-classroom-session.ts'),
      'utf8',
    );
    const surface = readFileSync(
      join(process.cwd(), 'components/classroom/ClassroomSurface.tsx'),
      'utf8',
    );
    expect(session).toContain('fetchStageMeta');
    expect(session).toContain('classroomGenerationOwnership(result)');
    expect(session).toContain('noteStageGenerationOwnership');
    expect(session).toContain('useMayGenerateForStage(classroomId)');
    // Reset on course switch, so a previous course's answer never carries over.
    expect(session).toContain("noteStageGenerationOwnership(classroomId, 'unresolved')");
    // The resume effect re-runs when the answer lands.
    expect(surface).toMatch(/\}, \[loading, error, mayGenerate, generateRemaining\]\);/);
    // An unresolved answer is asked again rather than accepted for the load.
    expect(session).toContain('retryWhileOwnershipUnresolved');
    // The outline-retry affordance is withheld, not merely refused.
    expect(surface).toMatch(/onRetryOutline=\{mayGenerate \? retrySingleOutline : undefined\}/);
  });

  it('the standalone route mounts the shared page variant', () => {
    const source = readFileSync(join(process.cwd(), 'app/classroom/[id]/page.tsx'), 'utf8');
    expect(source).toContain('import { ClassroomSurface }');
    expect(source).toContain('variant="page"');
  });

  it('the workspace mounts the same session-owning surface', () => {
    const pane = readFileSync(
      join(process.cwd(), 'components/workbench/workspace/WorkspaceClassroomPane.tsx'),
      'utf8',
    );
    const surface = readFileSync(
      join(process.cwd(), 'components/classroom/ClassroomSurface.tsx'),
      'utf8',
    );
    expect(pane).toContain('<ClassroomSurface');
    expect(pane).toContain('variant="pane"');
    expect(surface).toContain('useClassroomSession({');
  });

  it('does not ask the sidecar from the shared surface in browser-only mode', () => {
    const source = readFileSync(
      join(process.cwd(), 'lib/classroom/use-classroom-session.ts'),
      'utf8',
    );
    const refreshStart = source.indexOf('const refreshOwnership = useCallback(');
    const refresh = source.slice(refreshStart);
    expect(refreshStart).toBeGreaterThan(0);
    expect(refresh).toContain('!isServerBackedMediaPersistence()');
    expect(refresh).toContain('retryWhileOwnershipUnresolved');
  });

  // The load is what brings a course into the server store the first time it is
  // opened, so asking beforehand asks about a course whose ownership row does
  // not exist yet - and a 404 locks its genuine author out for the mount.
  // Asserted as a property of where the call sites are, not of how the file is
  // laid out: no renderer harness exists to drive the effect itself.
  it('asks the sidecar only after an initial or manual load succeeds', () => {
    const source = readFileSync(
      join(process.cwd(), 'components/classroom/ClassroomSurface.tsx'),
      'utf8',
    );
    const retryStart = source.indexOf('const retryClassroom = useCallback(');
    const effectStart = source.indexOf('useEffect(() => {', retryStart);
    const loadStart = source.indexOf('const loadUntilAvailable = async () => {');
    const loadEnd = source.indexOf('void loadUntilAvailable();', loadStart);
    expect(retryStart).toBeGreaterThan(0);
    expect(effectStart).toBeGreaterThan(retryStart);
    expect(loadStart).toBeGreaterThan(retryStart);

    const retry = source.slice(retryStart, effectStart);
    const initialLoad = source.slice(loadStart, loadEnd);
    for (const loadPath of [retry, initialLoad]) {
      expect(loadPath).toMatch(/if \(outcome === 'loaded'\) \{\s*refreshOwnership\(isCurrent\);/);
    }

    const callSites = [...source.matchAll(/\brefreshOwnership\(isCurrent\)/g)].map(
      (match) => match.index ?? -1,
    );
    expect(callSites).toHaveLength(2);
    expect(callSites.some((at) => at > retryStart && at < effectStart)).toBe(true);
    expect(callSites.some((at) => at > loadStart && at < loadEnd)).toBe(true);
    // No longer conditional on an availability retry having happened.
    expect(source).not.toContain('availabilityAttempt > 0');
  });

  it('permanently invalidates stale ownership refreshes across A-B-A navigation', () => {
    const source = readFileSync(
      join(process.cwd(), 'components/classroom/ClassroomSurface.tsx'),
      'utf8',
    );
    const retryStart = source.indexOf('const retryClassroom = useCallback(');
    const effectStart = source.indexOf('useEffect(() => {', retryStart);
    const cleanupStart = source.indexOf('return () => {', effectStart);
    const cleanupEnd = source.indexOf('};', cleanupStart);
    const retry = source.slice(retryStart, effectStart);
    const effect = source.slice(effectStart, cleanupStart);
    const cleanup = source.slice(cleanupStart, cleanupEnd);

    expect(source).toContain('const loadEpochRef = useRef(0)');
    for (const loadPath of [retry, effect]) {
      expect(loadPath).toContain('loadEpochRef.current = loadEpoch');
      expect(loadPath).toContain('loadEpochRef.current === loadEpoch');
    }
    expect(cleanup).toContain('loadEpochRef.current += 1');
  });

  it('clears parked media allocations when a course is (re)opened', () => {
    const source = readFileSync(
      join(process.cwd(), 'lib/classroom/use-classroom-session.ts'),
      'utf8',
    );
    expect(source).toContain('clearPendingMediaAllocations(classroomId)');
    expect(source).toContain('clearNarrationAllocations(classroomId)');
    expect(source).toContain('return () => stopGeneration()');
  });

  // Listening back to narration and seeing whether a line has any spend nothing,
  // so the gate belongs on regeneration alone. The refusal half is behavioural
  // (tests/audio/regenerate-speech-tts.test.ts); this guards the render half,
  // which has no harness — as a property of what the flag is derived from.
  it('keeps narration status and preview off the ownership gate', () => {
    const bar = readFileSync(
      join(process.cwd(), 'components/edit/ActionsBar/ActionsBar.tsx'),
      'utf8',
    );
    const assignment = /const ttsActive =([\s\S]*?);\n/.exec(bar);
    expect(assignment).not.toBeNull();
    // The flag that shows status and preview answers to managed TTS alone.
    expect(assignment?.[1]).not.toMatch(/mayGenerate|mayRegenerate/);
    // Both regenerate affordances are withheld rather than merely refused.
    expect(bar).toMatch(/\{mayRegenerate \?/);
    expect(bar).toMatch(/ttsActive && mayGenerate &&/);
  });

  // A pass that is superseded must stop, or it goes on calling providers and
  // storing assets for a course the user has left. What happens once it stops
  // is covered behaviourally in the orchestrator suite ("picks up every element
  // an aborted pass never reached"); this guards only that the surface does
  // stop it, which no harness here can drive.
  it('aborts the previous media pass before starting another', () => {
    const source = readFileSync(join(process.cwd(), 'lib/hooks/use-scene-generator.ts'), 'utf8');
    const abortAt = source.indexOf('mediaAbortRef.current?.abort()');
    const installAt = source.indexOf('mediaAbortRef.current = new AbortController()');
    expect(abortAt).toBeGreaterThan(0);
    expect(installAt).toBeGreaterThan(abortAt);
  });
});
