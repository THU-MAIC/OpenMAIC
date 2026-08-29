import type { AICallFn } from '@openmaic/generation';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  recordFullSolutionRevealed,
  requestCoachFullSolution,
  requestCoachHint,
  startCoachProblem,
  submitCoachAttempt,
  type CoachServiceDeps,
} from '@/lib/server/zhongkao/coach-service';
import {
  completeOriginalFullSolutionRequest,
  completeOriginalHintRequest,
  type CoachPresentationDependencies,
} from '@/lib/server/zhongkao/coach-presentation';
import type { ZhongkaoMaterialSourceAdapter } from '@/lib/server/agent-runtime/zhongkao-material-source';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import type { CoachEvent } from '@/lib/zhongkao/coach-event';
import type { CurriculumSourceRef } from '@/lib/zhongkao/curriculum';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { saveStudentProfile } from '@/lib/zhongkao/runtime';

const NOW = Date.parse('2026-08-29T08:00:00.000Z');

beforeAll(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

interface Harness {
  store: RuntimeStore;
  deps: CoachServiceDeps;
}

function harness(): Harness {
  const store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `coach-presentation-${Math.random()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  let clock = 0;
  return {
    store,
    deps: {
      store,
      ownerId: 'owner-fictional-alpha',
      agentSessionId: 'agent-fictional-alpha',
      now: () => new Date(NOW + clock++ * 1000).toISOString(),
    },
  };
}

async function seedProfile(h: Harness): Promise<void> {
  await saveStudentProfile(
    createInitialStudentProfile({
      profileId: 'student-alpha',
      createdAt: new Date(NOW).toISOString(),
    }),
    {
      store: h.store,
      learnerKey: resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
      now: () => new Date(NOW).toISOString(),
      mintRecordId: () => 'profile-record-alpha',
    },
  );
}

describe('deterministic Coach hint presentation', () => {
  it('persists each ordinal template and replays the accepted event text without calling an LLM', async () => {
    const h = harness();
    await seedProfile(h);
    const started = await startCoachProblem(h.deps, {
      profileId: 'student-alpha',
      subjectId: 'math',
      knowledgePointIds: ['linear-equations'],
      questionSource: { type: 'typed' },
      message: { seq: 1, text: '虚构题目：解方程 2x = 8。' },
    });
    const generationCall = vi.fn<AICallFn>(async () => {
      throw new Error('deterministic hint path must not call a provider');
    });
    const deps: CoachPresentationDependencies = { ...h.deps, generationCall };
    const expected = [
      '先把题目中的已知条件和要解决的问题分别列出来。',
      '回到这个知识点最基本的定义、公式或关系，先写出你认为相关的一条。',
      '把你当前卡住的那一步单独写出来，只尝试推进下一步，不要直接追求最终结果。',
    ];

    let snapshot = started.snapshot;
    let finalRequestSeq = 0;
    for (const [index, hintText] of expected.entries()) {
      finalRequestSeq = index + 2;
      await requestCoachHint(h.deps, {
        profileId: 'student-alpha',
        coachSessionId: snapshot.state.coachSessionId,
        expectedRevision: snapshot.state.revision,
        message: { seq: finalRequestSeq, text: `请给第 ${index + 1} 个提示。` },
      });
      const completed = await completeOriginalHintRequest(deps, {
        profileId: 'student-alpha',
        coachSessionId: snapshot.state.coachSessionId,
        userMessageSeq: finalRequestSeq,
      });
      expect(completed).toMatchObject({
        presentation: { kind: 'hint', text: hintText },
        replayed: false,
        eventAppended: true,
      });
      snapshot = completed!.snapshot;
    }

    expect(generationCall).not.toHaveBeenCalled();
    const recordsBeforeReplay = snapshot.records.length;
    const replay = await completeOriginalHintRequest(deps, {
      profileId: 'student-alpha',
      coachSessionId: snapshot.state.coachSessionId,
      userMessageSeq: finalRequestSeq,
    });
    expect(replay).toMatchObject({
      presentation: { kind: 'hint', text: expected[2] },
      replayed: true,
      eventAppended: false,
    });
    expect(replay!.snapshot.records).toHaveLength(recordsBeforeReplay);

    const issued = replay!.snapshot.records
      .map((record) => record.payload as CoachEvent)
      .filter((event) => event.eventType === 'hint_issued');
    expect(issued.map((event) => event.hintText)).toEqual(expected);
  });

  it('does not read untrusted material content when creating a hint', async () => {
    const h = harness();
    await seedProfile(h);
    const started = await startCoachProblem(h.deps, {
      profileId: 'student-alpha',
      subjectId: 'math',
      knowledgePointIds: ['linear-equations'],
      questionSource: { type: 'material', materialId: 'material-fictional-alpha' },
      message: { seq: 1, text: '请处理已上传的虚构题目。' },
    });
    const requested = await requestCoachHint(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: started.snapshot.state.revision,
      message: { seq: 2, text: '请给一个提示。' },
    });
    const generationCall = vi.fn<AICallFn>();
    const result = await completeOriginalHintRequest(
      { ...h.deps, generationCall },
      {
        profileId: 'student-alpha',
        coachSessionId: requested.snapshot.state.coachSessionId,
        userMessageSeq: 2,
      },
    );

    expect(result?.presentation).toEqual({
      kind: 'hint',
      text: '先把题目中的已知条件和要解决的问题分别列出来。',
    });
    expect(generationCall).not.toHaveBeenCalled();
  });
});

describe('Coach full-solution abort boundary', () => {
  it('stops after a late material lookup when the execution was aborted', async () => {
    const h = harness();
    await seedProfile(h);
    const started = await startCoachProblem(h.deps, {
      profileId: 'student-alpha',
      subjectId: 'math',
      knowledgePointIds: ['linear-equations'],
      questionSource: { type: 'material', materialId: 'material-fictional-alpha' },
      message: { seq: 1, text: '虚构题目：解方程 2x = 8。' },
    });
    const firstAttempt = await submitCoachAttempt(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: started.snapshot.state.revision,
      message: { seq: 2, text: 'x = 3' },
    });
    const secondAttempt = await submitCoachAttempt(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: firstAttempt.snapshot.state.revision,
      message: { seq: 3, text: 'x = 4' },
    });
    await requestCoachFullSolution(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: secondAttempt.snapshot.state.revision,
      message: { seq: 4, text: '请给出完整解析。' },
    });

    let releaseMaterial!: () => void;
    const materialPending = new Promise<void>((resolve) => {
      releaseMaterial = resolve;
    });
    const materialSource = {
      resolve: vi.fn(async (materialId: string) => {
        await materialPending;
        return {
          materialId,
          displayName: '虚构家庭材料',
          source: { type: 'uploaded_material' as const, sourceId: materialId },
          verifier: (candidate: CurriculumSourceRef) =>
            candidate.type === 'uploaded_material' && candidate.sourceId === materialId,
        };
      }),
    } satisfies ZhongkaoMaterialSourceAdapter;
    const generationCall = vi.fn<AICallFn>(async () =>
      JSON.stringify({
        schemaVersion: 1,
        explanation: 'This must not run.',
        claims: [],
      }),
    );
    const controller = new AbortController();
    const completion = completeOriginalFullSolutionRequest(
      {
        ...h.deps,
        abortSignal: controller.signal,
        generationCall,
        materialSource,
      },
      {
        profileId: 'student-alpha',
        coachSessionId: started.snapshot.state.coachSessionId,
        userMessageSeq: 4,
      },
    );
    const rejected = expect(completion).rejects.toThrowError('aborted');
    await vi.waitFor(() => expect(materialSource.resolve).toHaveBeenCalledTimes(1));

    controller.abort(new Error('tool timeout'));
    releaseMaterial();

    await rejected;
    expect(generationCall).not.toHaveBeenCalled();
    const sessions = await h.store.listSessions(
      'zhongkao-profile:student-alpha',
      resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
    );
    const coach = sessions.find((candidate) => candidate.kind === 'zhongkaoCoachEvent')!;
    const records = await h.store.listRecords(coach.id);
    expect(
      records.map((record) => (record.payload as { eventType: string }).eventType),
    ).not.toContain('full_solution_revealed');
  });
});

describe('Coach full-solution resolution lifecycle', () => {
  async function ready(h: Harness) {
    await seedProfile(h);
    const started = await startCoachProblem(h.deps, {
      profileId: 'student-alpha',
      subjectId: 'math',
      knowledgePointIds: ['linear-equations'],
      questionSource: { type: 'typed' },
      message: { seq: 1, text: '虚构题目：解方程 2x = 8。' },
    });
    const first = await submitCoachAttempt(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: started.snapshot.state.revision,
      message: { seq: 2, text: 'x = 3' },
    });
    const second = await submitCoachAttempt(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: first.snapshot.state.revision,
      message: { seq: 3, text: 'x = 5' },
    });
    const requested = await requestCoachFullSolution(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: second.snapshot.state.revision,
      message: { seq: 4, text: '请给出完整解析。' },
    });
    const request = requested.snapshot.records.at(-1)!.payload as CoachEvent;
    if (request.eventType !== 'full_solution_requested') throw new Error('invalid fixture');
    return { started, requested, request };
  }

  function generationCall(): AICallFn {
    return vi.fn(async () =>
      JSON.stringify({
        schemaVersion: 1,
        explanation: '先将等式两边同时除以 2。',
        finalAnswer: 'x = 4',
        claims: [],
      }),
    );
  }

  it('persists the reveal before a causal resolution with no invented outcome', async () => {
    const h = harness();
    const seeded = await ready(h);
    const completed = await completeOriginalFullSolutionRequest(
      { ...h.deps, generationCall: generationCall() },
      {
        profileId: 'student-alpha',
        coachSessionId: seeded.started.snapshot.state.coachSessionId,
        userMessageSeq: 4,
      },
    );
    const events = completed.snapshot.records.map((record) => record.payload as CoachEvent);
    expect(events.slice(-2).map((event) => event.eventType)).toEqual([
      'full_solution_revealed',
      'original_resolved',
    ]);
    const reveal = events.at(-2)!;
    const resolution = events.at(-1)!;
    expect(resolution).toMatchObject({
      eventType: 'original_resolved',
      fullSolutionEventId: reveal.eventId,
    });
    expect(resolution).not.toHaveProperty('outcome');
    expect(completed.snapshot.state.original).toMatchObject({
      viewedFullAnswer: true,
      resolved: true,
    });
    expect(completed.snapshot.state.original).not.toHaveProperty('outcome');
  });

  it('repairs a persisted reveal whose causal resolution response was interrupted', async () => {
    const h = harness();
    const seeded = await ready(h);
    const revealed = await recordFullSolutionRevealed(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: seeded.started.snapshot.state.coachSessionId,
      expectedRevision: seeded.requested.snapshot.state.revision,
      requestEventId: seeded.request.eventId,
      explanation: '已持久化的虚构完整解析。',
      finalAnswer: 'x = 4',
    });
    expect(revealed.snapshot.state.original).toMatchObject({
      viewedFullAnswer: true,
      resolved: false,
    });
    const provider = vi.fn<AICallFn>();
    const repaired = await completeOriginalFullSolutionRequest(
      { ...h.deps, generationCall: provider },
      {
        profileId: 'student-alpha',
        coachSessionId: seeded.started.snapshot.state.coachSessionId,
        userMessageSeq: 4,
      },
    );
    expect(provider).not.toHaveBeenCalled();
    expect(repaired).toMatchObject({
      presentation: {
        kind: 'full_solution',
        explanation: '已持久化的虚构完整解析。',
        finalAnswer: 'x = 4',
      },
      replayed: false,
      eventAppended: true,
      snapshot: { state: { original: { resolved: true } } },
    });
    expect(
      repaired.snapshot.records.map((record) => (record.payload as CoachEvent).eventType).slice(-2),
    ).toEqual(['full_solution_revealed', 'original_resolved']);
  });
});
