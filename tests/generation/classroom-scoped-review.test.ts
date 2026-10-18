import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserRequirements } from '@openmaic/generation';
import {
  CLASSROOM_SCOPE_LEDGER_VERSION,
  createClassroomContentCallbacks,
  matchesClassroomContentProof,
  matchesClassroomScopeLedger,
  reviewClassroomContentScoped,
  type ClassroomReviewPacket,
  type ClassroomContentCallbacks,
  type ClassroomReviewCallContext,
} from '@/lib/server/classroom-content-review';

afterEach(() => vi.useRealTimers());

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
    expect(packets.length + repairs).toBe(9);
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

function cancelledCallback(context: ClassroomReviewCallContext): Promise<string> {
  return new Promise((_resolve, reject) => {
    context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
  });
}
const longDeadline = () => ({ deadlineAt: Date.now() + 720_000 });

describe('bounded retries only after an actual request timeout', () => {
  it('retries one settled cancellation with identical packet/schema and retains a complete ledger', async () => {
    vi.useFakeTimers();
    const calls: Array<{
      id: string;
      system: string;
      user: string;
      schema: string;
      signal: AbortSignal;
    }> = [];
    let firstSettled = false;
    let active = 0,
      peak = 0;
    const callbacks = createClassroomContentCallbacks(
      async () => {
        throw new Error('legacy');
      },
      {
        structuredCall: async (system, user, schema, context) => {
          const packet = JSON.parse(user) as ClassroomReviewPacket;
          const id = packet.reviewScope!.id;
          calls.push({
            id,
            system,
            user,
            schema: JSON.stringify(schema.jsonSchema),
            signal: context!.signal,
          });
          peak = Math.max(peak, ++active);
          try {
            if (id === 'scene:1' && calls.filter((c) => c.id === id).length === 1) {
              try {
                return await cancelledCallback(context!);
              } finally {
                firstSettled = true;
              }
            }
            if (id === 'scene:1') expect(firstSettled).toBe(true);
            return answer(packet);
          } finally {
            active--;
          }
        },
      },
    );
    const pending = run(callbacks, longDeadline());
    const completion = expect(pending).resolves.toMatchObject({
      ledger: { entries: expect.any(Array) },
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await completion;
    const result = await pending;
    const attempts = calls.filter((c) => c.id === 'scene:1');
    expect(attempts).toHaveLength(2);
    expect(attempts[1].system).toBe(attempts[0].system);
    expect(attempts[1].user).toBe(attempts[0].user);
    expect(attempts[1].schema).toBe(attempts[0].schema);
    expect(attempts[0].signal.aborted).toBe(true);
    expect(attempts[1].signal).not.toBe(attempts[0].signal);
    expect(calls).toHaveLength(5);
    expect(peak).toBe(2);
    expect(result.ledger.entries).toHaveLength(4);
    expect(matchesClassroomScopeLedger(requirements, result.material, result.ledger)).toBe(true);
  });

  it('stops after a second request timeout of the same bound scope', async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    const pending = run(
      {
        review: async (p, context) => {
          ids.push(p.reviewScope!.id);
          return p.reviewScope!.id === 'scene:1' ? cancelledCallback(context!) : answer(p);
        },
      },
      longDeadline(),
    );
    const completion = expect(pending).rejects.toMatchObject({ code: 'review_timeout' });
    await vi.advanceTimersByTimeAsync(240_000);
    await completion;
    expect(ids.filter((id) => id === 'scene:1')).toHaveLength(2);
    expect(ids).toHaveLength(4);
    expect(ids).not.toContain('cross:complete');
  });

  it('does not retry when the remaining job cannot contain another request and cancellation cleanup', async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    const pending = run(
      {
        review: async (p, context) => {
          ids.push(p.reviewScope!.id);
          return p.reviewScope!.id === 'scene:1' ? cancelledCallback(context!) : answer(p);
        },
      },
      { deadlineAt: Date.now() + 200_000 },
    );
    const completion = expect(pending).rejects.toMatchObject({ code: 'review_timeout' });
    await vi.advanceTimersByTimeAsync(120_000);
    await completion;
    expect(ids.filter((id) => id === 'scene:1')).toHaveLength(1);
    expect(ids).toHaveLength(3);
  });

  it('does not retry parent cancellation even though the callback settles with AbortError', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const review = vi.fn(async (_p: ClassroomReviewPacket, context?: ClassroomReviewCallContext) =>
      cancelledCallback(context!),
    );
    const pending = run({ review }, { ...longDeadline(), signal: parent.signal });
    const completion = expect(pending).rejects.toMatchObject({ code: 'review_timeout' });
    parent.abort(new DOMException('parent stopped', 'AbortError'));
    await completion;
    await vi.advanceTimersByTimeAsync(250_000);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it('does not retry a sibling cancelled by a critical finding', async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    await expect(
      run(
        {
          review: async (p, context) => {
            ids.push(p.reviewScope!.id);
            if (p.reviewScope!.id === 'scene:1') return cancelledCallback(context!);
            return answer(p, [finding(p, 'widget', '/title', true)]);
          },
        },
        longDeadline(),
      ),
    ).rejects.toMatchObject({ code: 'requires_regeneration' });
    await vi.advanceTimersByTimeAsync(250_000);
    expect(ids).toEqual(['scene:1', 'scene:2']);
  });

  it('does not retry a callback that ignores cancellation and reaches the 130 second guard', async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    const pending = run(
      {
        review: async (p) => {
          ids.push(p.reviewScope!.id);
          return p.reviewScope!.id === 'scene:1' ? new Promise<string>(() => {}) : answer(p);
        },
      },
      longDeadline(),
    );
    const completion = expect(pending).rejects.toMatchObject({ code: 'review_timeout' });
    await vi.advanceTimersByTimeAsync(130_000);
    await completion;
    expect(ids.filter((id) => id === 'scene:1')).toHaveLength(1);
    expect(ids).toHaveLength(3);
  });

  it('does not trust an arbitrary TimeoutError before its own request deadline', async () => {
    const ids: string[] = [];
    await expect(
      run(
        {
          review: async (p) => {
            ids.push(p.reviewScope!.id);
            if (p.reviewScope!.id === 'scene:1')
              throw new DOMException('untrusted', 'TimeoutError');
            return answer(p);
          },
        },
        longDeadline(),
      ),
    ).rejects.toMatchObject({ code: 'review_unavailable' });
    expect(ids.filter((id) => id === 'scene:1')).toHaveLength(1);
  });

  it.each(['schema', 'binding', 'critical'] as const)(
    'never retries a %s response',
    async (kind) => {
      const ids: string[] = [];
      const repair = vi.fn();
      await expect(
        run(
          {
            review: async (p) => {
              ids.push(p.reviewScope!.id);
              if (p.reviewScope!.id !== 'scene:1') return answer(p);
              if (kind === 'schema') return '{}';
              if (kind === 'binding') return answer(p, [], { material_digest: '0'.repeat(64) });
              return answer(p, [finding(p, 'slide', '/title', true)]);
            },
            repair,
          },
          longDeadline(),
        ),
      ).rejects.toBeDefined();
      expect(ids.filter((id) => id === 'scene:1')).toHaveLength(1);
      expect(repair).not.toHaveBeenCalled();
    },
  );

  it('does not spend a repair when a prior retry leaves fewer than five complete-round callbacks', async () => {
    vi.useFakeTimers();
    let slideCalls = 0;
    const ids: string[] = [];
    const repair = vi.fn();
    const pending = run(
      {
        review: async (p, context) => {
          ids.push(p.reviewScope!.id);
          if (p.reviewScope!.id === 'scene:1' && ++slideCalls === 1)
            return cancelledCallback(context!);
          return answer(
            p,
            p.reviewScope!.id === 'scene:1' ? [finding(p, 'slide', '/actions/0/text')] : [],
          );
        },
        repair,
      },
      longDeadline(),
    );
    const completion = expect(pending).rejects.toMatchObject({ code: 'content_unresolved' });
    await vi.advanceTimersByTimeAsync(120_000);
    await completion;
    expect(ids).toHaveLength(5);
    expect(repair).not.toHaveBeenCalled();
  });

  it('counts repair and both rounds together and does not spend the reserved cross call on a retry', async () => {
    vi.useFakeTimers();
    const packets: ClassroomReviewPacket[] = [];
    let repairs = 0;
    const pending = run(
      {
        review: async (p, context) => {
          packets.push(p);
          if (p.binding.reportVersion === 2 && p.reviewScope!.id === 'scene:1')
            return cancelledCallback(context!);
          return answer(
            p,
            p.binding.reportVersion === 1 && p.reviewScope!.id === 'scene:1'
              ? [finding(p, 'slide', '/actions/0/text')]
              : [],
          );
        },
        repair: async (p) => {
          repairs++;
          return JSON.stringify({
            review_version: p.binding.reviewVersion,
            source_digest: p.binding.sourceDigest,
            material_digest: p.binding.materialDigest,
            review_snapshot_digest: p.binding.reviewSnapshotDigest,
            patches: [{ field_ref: p.findings[0].fieldRef, new_text: 'New accurate wording.' }],
          });
        },
      },
      longDeadline(),
    );
    const completion = expect(pending).rejects.toMatchObject({ code: 'review_timeout' });
    await vi.advanceTimersByTimeAsync(120_000);
    await completion;
    expect(repairs).toBe(1);
    expect(
      packets.filter((p) => p.binding.reportVersion === 2 && p.reviewScope!.id === 'scene:1'),
    ).toHaveLength(1);
    expect(packets.length + repairs).toBe(8);
    expect(packets.length + repairs).toBeLessThanOrEqual(9);
    expect(
      packets.filter((p) => p.binding.reportVersion === 2 && p.reviewScope!.kind === 'cross_scene'),
    ).toHaveLength(0);
  });

  it('rejects source drift before spending a retry after the original request settles', async () => {
    vi.useFakeTimers();
    const external = copy(requirements);
    const ids: string[] = [];
    const pending = run(
      {
        review: async (p, context) => {
          ids.push(p.reviewScope!.id);
          if (p.reviewScope!.id !== 'scene:1') return answer(p);
          return new Promise<string>((_resolve, reject) => {
            context!.signal.addEventListener(
              'abort',
              () => {
                external.requirement = 'changed while the request was pending';
                reject(context!.signal.reason);
              },
              { once: true },
            );
          });
        },
      },
      { ...longDeadline(), requirements: external },
    );
    const completion = expect(pending).rejects.toMatchObject({ code: 'binding_mismatch' });
    await vi.advanceTimersByTimeAsync(120_000);
    await completion;
    expect(ids.filter((id) => id === 'scene:1')).toHaveLength(1);
    expect(ids).toHaveLength(3);
  });

  it('does not reinterpret a schema error near its own cancellation as a transient timeout', async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    const pending = run(
      {
        review: async (p, context) => {
          ids.push(p.reviewScope!.id);
          if (p.reviewScope!.id !== 'scene:1') return answer(p);
          return new Promise<string>((_resolve, reject) => {
            context!.signal.addEventListener(
              'abort',
              () => {
                const error = new Error('invalid output schema');
                error.name = 'AI_NoObjectGeneratedError';
                reject(error);
              },
              { once: true },
            );
          });
        },
      },
      longDeadline(),
    );
    const completion = expect(pending).rejects.toMatchObject({ code: 'review_unavailable' });
    await vi.advanceTimersByTimeAsync(120_000);
    await completion;
    expect(ids.filter((id) => id === 'scene:1')).toHaveLength(1);
  });

  it('can retry the original complete cross packet without accepting only local passes', async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    const pending = run(
      {
        review: async (p, context) => {
          const id = p.reviewScope!.id;
          ids.push(id);
          if (id === 'cross:complete' && ids.filter((value) => value === id).length === 1)
            return cancelledCallback(context!);
          return answer(p);
        },
      },
      longDeadline(),
    );
    const completion = expect(pending).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(120_000);
    await completion;
    const result = await pending;
    expect(ids.filter((id) => id === 'cross:complete')).toHaveLength(2);
    expect(ids).toHaveLength(5);
    expect(result.ledger.entries).toHaveLength(4);
    expect(matchesClassroomScopeLedger(requirements, result.material, result.ledger)).toBe(true);
  });

  it('keeps all four per-scope retries inside the shared callback ceiling and full ledger', async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    const pending = run(
      {
        review: async (p, context) => {
          const id = p.reviewScope!.id;
          ids.push(id);
          if (ids.filter((value) => value === id).length === 1) return cancelledCallback(context!);
          return answer(p);
        },
      },
      longDeadline(),
    );
    const completion = expect(pending).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(360_000);
    await completion;
    const result = await pending;
    expect(ids).toHaveLength(8);
    for (const id of ['scene:1', 'scene:2', 'scene:3', 'cross:complete'])
      expect(ids.filter((value) => value === id)).toHaveLength(2);
    expect(result.ledger.entries).toHaveLength(4);
    expect(matchesClassroomScopeLedger(requirements, result.material, result.ledger)).toBe(true);
  });
});
