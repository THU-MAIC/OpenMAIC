import { describe, expect, it, vi } from 'vitest';
import type { UserRequirements } from '@openmaic/generation';
import {
  CLASSROOM_SCOPE_LEDGER_VERSION,
  createClassroomContentCallbacks,
  matchesClassroomContentProof,
  matchesClassroomScopeLedger,
  reviewClassroomContentScoped,
  type ClassroomReviewPacket,
  type ClassroomContentCallbacks,
} from '@/lib/server/classroom-content-review';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const requirements: UserRequirements = {
  requirement: 'Read the complete supplied source and distinguish simulation from execution.',
  codeContextRequired: true,
  codemateSource: {
    title: 'Echo',
    content: 'Read one line and output that line.',
    code: 'x = input()\nprint(x)\n',
    correctedCode: 'x = input()\nprint(x)\n',
    language: 'Python',
    referenceValidation: { status: 'unknown', scope: 'not_supplied' },
  },
};
function material() {
  return {
    stage: { id: 'stage', name: 'complete context' },
    scenes: [
      {
        id: 'slide',
        type: 'slide',
        stageId: 'stage',
        title: 'Original',
        content: {
          type: 'slide',
          canvas: { elements: [{ id: 'e', type: 'text', content: '<p>Read a line.</p>' }] },
        },
        actions: [{ id: 'a', type: 'speech', text: 'old wording' }],
      },
      {
        id: 'widget',
        type: 'interactive',
        stageId: 'stage',
        title: 'Simulation',
        content: { type: 'interactive', html: '<p>Static fixture, not executed.</p>' },
        actions: [],
      },
      {
        id: 'quiz',
        type: 'quiz',
        stageId: 'stage',
        title: 'Check',
        content: {
          type: 'quiz',
          questions: [
            {
              id: 'q',
              type: 'single',
              question: 'What is echoed?',
              options: [
                { value: 'A', label: 'The line' },
                { value: 'B', label: 'Nothing' },
              ],
              answer: ['A'],
              analysis: 'The output is the input line.',
            },
          ],
        },
        actions: [],
      },
    ],
  };
}
function answer(packet: ClassroomReviewPacket, findings: unknown[] = [], extra = {}) {
  const scope = packet.reviewScope!;
  return JSON.stringify({
    review_version: packet.binding.reviewVersion,
    source_digest: packet.binding.sourceDigest,
    material_digest: packet.binding.materialDigest,
    review_snapshot_digest: packet.binding.reviewSnapshotDigest,
    scope_version: scope.version,
    scope_id: scope.id,
    scope_kind: scope.kind,
    scope_digest: scope.digest,
    reviewed_scene_ids: scope.sceneIds,
    content_pass: findings.length === 0,
    findings,
    ...extra,
  });
}
function finding(packet: ClassroomReviewPacket, sceneId: string, path: string, critical = false) {
  const field = packet.fieldPathCatalog
    .find((s) => s.sceneId === sceneId)!
    .fields.find((f) => f.path === path)!;
  return {
    field_ref: field.fieldRef,
    reason: 'A specific inconsistency.',
    required_change: 'Correct that inconsistency.',
    kind: critical ? 'code_logic' : 'text',
    affects_code: critical,
    affects_root: false,
  };
}
function run(callbacks: ClassroomContentCallbacks, options = {}) {
  return reviewClassroomContentScoped({
    requirements: copy(requirements),
    material: material(),
    callbacks,
    expectedSceneCount: 3,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
    ...options,
  });
}

describe('versioned local coverage and complete cross-scene review', () => {
  it.each([
    ['missing', undefined],
    ['non-string', 42],
    ['empty', ''],
    ['whitespace', ' \n\t '],
  ])('rejects %s interactive HTML before review or repair', async (_name, html) => {
    const invalid = material();
    const content = invalid.scenes[1].content as Record<string, unknown>;
    if (html === undefined) delete content.html;
    else content.html = html;
    const review = vi.fn(async (p: ClassroomReviewPacket) => answer(p));
    const repair = vi.fn();
    await expect(run({ review, repair }, { material: invalid })).rejects.toMatchObject({
      code: 'material_incomplete',
    });
    expect(review).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });

  it('keeps full requirements, one complete scene per local scope, full cross material, and global refs', async () => {
    const packets: ClassroomReviewPacket[] = [];
    const result = await run({
      review: async (p) => {
        packets.push(p);
        return answer(p);
      },
    });
    expect(packets).toHaveLength(4);
    const locals = packets.filter((p) => p.reviewScope!.kind === 'scene');
    const cross = packets.find((p) => p.reviewScope!.kind === 'cross_scene')!;
    expect(locals.map((p) => p.reviewScope!.sceneIds)).toEqual([['slide'], ['widget'], ['quiz']]);
    for (const p of packets) {
      expect(p.requirements).toEqual(requirements);
      expect(p.binding).toEqual(cross.binding);
      expect(Object.isFrozen(p)).toBe(true);
      expect(p.reviewScope!.version).toBe(CLASSROOM_SCOPE_LEDGER_VERSION);
    }
    expect(locals.map((p) => p.fieldPathCatalog[0].fields[0].fieldRef.slice(0, 6))).toEqual([
      'scene1',
      'scene2',
      'scene3',
    ]);
    expect(cross.material).toEqual(material());
    expect(cross.fieldPathCatalog.flatMap((s) => s.fields)).toEqual(
      locals.flatMap((p) => p.fieldPathCatalog.flatMap((s) => s.fields)),
    );
    expect(matchesClassroomScopeLedger(requirements, result.material, result.ledger)).toBe(true);
    expect(matchesClassroomContentProof(requirements, result.material, result.proof)).toBe(true);
    expect(Object.keys(result.proof).sort()).toEqual([
      'binding',
      'contentPass',
      'findings',
      'schemaVersion',
      'scope',
    ]);
  });

  it.each([
    ['missing', (p: ClassroomReviewPacket) => ({ reviewed_scene_ids: [] })],
    [
      'duplicate',
      (p: ClassroomReviewPacket) => ({
        reviewed_scene_ids: [p.reviewScope!.sceneIds[0], p.reviewScope!.sceneIds[0]],
      }),
    ],
    ['wrong', () => ({ reviewed_scene_ids: ['other'] })],
    ['old scope', () => ({ scope_version: 'old' })],
    ['wrong digest', () => ({ scope_digest: '0'.repeat(64) })],
    ['binding drift', () => ({ material_digest: '0'.repeat(64) })],
  ])('rejects %s response coverage', async (_name, change) => {
    await expect(run({ review: async (p) => answer(p, [], change(p)) })).rejects.toBeDefined();
  });

  it('rejects missing/duplicate/wrong ledger entries and mutated source/material', async () => {
    const result = await run({ review: async (p) => answer(p) });
    const malformed = [
      { ...result.ledger, entries: result.ledger.entries.slice(1) },
      {
        ...result.ledger,
        entries: [...result.ledger.entries.slice(0, -1), result.ledger.entries[0]],
      },
      { ...result.ledger, version: 'old' },
    ];
    for (const ledger of malformed)
      expect(
        matchesClassroomScopeLedger(requirements, result.material, ledger as typeof result.ledger),
      ).toBe(false);
    const changed = copy(result.material);
    changed.scenes[0].title = 'changed';
    expect(matchesClassroomScopeLedger(requirements, changed, result.ledger)).toBe(false);
    expect(
      matchesClassroomScopeLedger(
        { ...requirements, requirement: 'changed' },
        result.material,
        result.ledger,
      ),
    ).toBe(false);
  });

  it('does not accept local passes when complete cross review finds a critical contradiction', async () => {
    const repair = vi.fn();
    let calls = 0;
    await expect(
      run({
        review: async (p) => {
          calls++;
          return answer(
            p,
            p.reviewScope!.kind === 'cross_scene'
              ? [finding(p, 'quiz', '/content/questions/0/answer/0', true)]
              : [],
          );
        },
        repair,
      }),
    ).rejects.toMatchObject({ code: 'requires_regeneration' });
    expect(calls).toBe(4);
    expect(repair).not.toHaveBeenCalled();
  });

  it('retains false model findings instead of filtering them into a pass', async () => {
    await expect(
      run({
        review: async (p) =>
          answer(
            p,
            p.reviewScope!.sceneIds.includes('slide')
              ? [
                  {
                    ...finding(p, 'slide', '/title'),
                    reason: 'The statement is correct.',
                    required_change: 'Keep it unchanged.',
                  },
                ]
              : [],
          ),
      }),
    ).rejects.toMatchObject({ code: 'content_rejected' });
  });

  it('uses at most two concurrent local calls and stops queued/cross work after critical failure', async () => {
    let active = 0,
      peak = 0,
      calls = 0;
    let siblingAborted = false;
    await expect(
      run({
        review: async (p, context) => {
          calls++;
          peak = Math.max(peak, ++active);
          try {
            if (p.reviewScope!.id === 'scene:1') {
              await Promise.resolve();
              return answer(p, [finding(p, 'slide', '/title', true)]);
            }
            await new Promise<void>((resolve) =>
              context!.signal.addEventListener(
                'abort',
                () => {
                  siblingAborted = true;
                  resolve();
                },
                { once: true },
              ),
            );
            return answer(p);
          } finally {
            active--;
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'requires_regeneration' });
    expect(peak).toBe(2);
    expect(calls).toBe(2);
    expect(siblingAborted).toBe(true);
  });

  it('does not dispatch with an expired deadline or pre-aborted parent', async () => {
    const review = vi.fn();
    await expect(run({ review }, { deadlineAt: Date.now() - 1 })).rejects.toMatchObject({
      code: 'review_timeout',
    });
    const controller = new AbortController();
    controller.abort();
    await expect(run({ review }, { signal: controller.signal })).rejects.toMatchObject({
      code: 'review_timeout',
    });
    expect(review).not.toHaveBeenCalled();
  });

  it('propagates parent cancellation and rejects late/unavailable results without cross review', async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = run(
      {
        review: async (_p, context) => {
          calls++;
          await new Promise<void>((resolve) =>
            context!.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          return '{}';
        },
      },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'review_timeout' });
    expect(calls).toBe(2);
    await expect(
      run({
        review: async () => {
          throw new Error('offline');
        },
      }),
    ).rejects.toMatchObject({ code: 'review_unavailable' });
  });

  it('rejects no-op repair and never calls another review round', async () => {
    let reviews = 0;
    await expect(
      run({
        review: async (p) => {
          reviews++;
          return answer(
            p,
            p.reviewScope!.kind === 'scene' && p.reviewScope!.sceneIds[0] === 'slide'
              ? [finding(p, 'slide', '/actions/0/text')]
              : [],
          );
        },
        repair: async (p) =>
          JSON.stringify({
            review_version: p.binding.reviewVersion,
            source_digest: p.binding.sourceDigest,
            material_digest: p.binding.materialDigest,
            review_snapshot_digest: p.binding.reviewSnapshotDigest,
            patches: [{ field_ref: p.findings[0].fieldRef, new_text: 'old wording' }],
          }),
      }),
    ).rejects.toMatchObject({ code: 'repair_invalid' });
    expect(reviews).toBe(4);
  });

  it('invalidates the complete ledger after a permitted repair and rechecks all scopes (nine calls max)', async () => {
    const packets: ClassroomReviewPacket[] = [];
    let repairs = 0;
    const result = await run({
      review: async (p) => {
        packets.push(p);
        return answer(
          p,
          p.binding.reportVersion === 1 &&
            p.reviewScope!.kind === 'scene' &&
            p.reviewScope!.sceneIds[0] === 'slide'
            ? [finding(p, 'slide', '/actions/0/text')]
            : [],
        );
      },
      repair: async (p) => {
        repairs++;
        expect(p.material).toEqual(material());
        expect(p.reviewScope).toBeUndefined();
        return JSON.stringify({
          review_version: p.binding.reviewVersion,
          source_digest: p.binding.sourceDigest,
          material_digest: p.binding.materialDigest,
          review_snapshot_digest: p.binding.reviewSnapshotDigest,
          patches: [{ field_ref: p.findings[0].fieldRef, new_text: 'New accurate wording.' }],
        });
      },
    });
    expect(packets).toHaveLength(8);
    expect(repairs).toBe(1);
    expect(result.ledger.binding.reportVersion).toBe(2);
    expect(packets[0].reviewScope!.digest).not.toBe(packets[4].reviewScope!.digest);
    expect(matchesClassroomScopeLedger(requirements, result.material, result.ledger)).toBe(true);
  });

  it('preserves local and cross findings for one ref while requiring only one exact patch', async () => {
    let repairs = 0;
    const result = await run({
      review: async (p) =>
        answer(
          p,
          p.binding.reportVersion === 1 && p.reviewScope!.sceneIds.includes('slide')
            ? [finding(p, 'slide', '/actions/0/text')]
            : [],
        ),
      repair: async (p) => {
        repairs++;
        expect(p.findings).toHaveLength(2);
        expect(p.findings[0].fieldRef).toBe(p.findings[1].fieldRef);
        return JSON.stringify({
          review_version: p.binding.reviewVersion,
          source_digest: p.binding.sourceDigest,
          material_digest: p.binding.materialDigest,
          review_snapshot_digest: p.binding.reviewSnapshotDigest,
          patches: [{ field_ref: p.findings[0].fieldRef, new_text: 'One necessary correction.' }],
        });
      },
    });
    expect(repairs).toBe(1);
    expect(result.material.scenes[0].actions[0].text).toBe('One necessary correction.');
    expect(result.ledger.entries).toHaveLength(4);
  });

  it('public helper supplies scoped schema and unchanged full input to the actual structured seam', async () => {
    const calls: Array<{ system: string; packet: ClassroomReviewPacket }> = [];
    const callbacks = createClassroomContentCallbacks(
      async () => {
        throw new Error('legacy path');
      },
      {
        structuredCall: async (system, user, schema, context) => {
          const p = JSON.parse(user) as ClassroomReviewPacket;
          expect(context!.signal).toBeInstanceOf(AbortSignal);
          const raw = answer(p);
          expect((await schema.validate!(JSON.parse(raw))).success).toBe(true);
          expect(
            (await schema.validate!({ ...JSON.parse(raw), scope_digest: 'bad' })).success,
          ).toBe(false);
          calls.push({ system, packet: p });
          return raw;
        },
      },
    );
    await run(callbacks);
    expect(calls).toHaveLength(4);
    expect(
      calls.every((c) => c.system.includes('scope_version') && c.system.includes('cross_scene')),
    ).toBe(true);
  });
});
