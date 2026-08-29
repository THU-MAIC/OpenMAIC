import { readFileSync } from 'node:fs';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { planResume } from '@/lib/server/agent-runtime/resume';
import type { Scene } from '@/lib/types/stage';
import {
  composeCourseRefsText,
  composeFollowUpText,
  composeFollowUpTextWithElementRefs,
  durableUserMessageSeq,
  planRunStart,
  resolveCourseRefsForContext,
  tagDurableUserMessage,
  terminalCoachNoticeReason,
  trustedZhongkaoTurnForRun,
} from '@/lib/server/agent-runtime/runner';
import type { CourseRef } from '@/lib/workbench/course-refs';
import type { ElementRef } from '@/lib/workbench/element-refs';

const mocks = vi.hoisted(() => ({
  probeStageAccess: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/curriculum-tools', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/agent-runtime/curriculum-tools')>();
  return { ...actual, probeStageAccess: mocks.probeStageAccess };
});

const user = (text: string) => ({ role: 'user', content: text }) as unknown as AgentMessage;
const assistant = (text: string) =>
  ({ role: 'assistant', content: [{ type: 'text', text }] }) as unknown as AgentMessage;
const toolCall = () =>
  ({
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'call-1', name: 'finish', arguments: {} }],
  }) as unknown as AgentMessage;
const toolResult = () =>
  ({
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'finish',
    content: [{ type: 'text', text: 'Done' }],
  }) as unknown as AgentMessage;
const askUserResult = () =>
  ({
    role: 'toolResult',
    toolCallId: 'ask-1',
    toolName: 'ask_user',
    content: [{ type: 'text', text: 'Question sent.' }],
  }) as unknown as AgentMessage;

describe('planRunStart', () => {
  it('uses the original prompt on a first run', () => {
    expect(
      planRunStart({
        plan: planResume(null),
        claimReason: 'queued',
        pending: [],
        prompt: 'Build a lesson',
      }),
    ).toEqual({ kind: 'prompt', text: 'Build a lesson' });
  });

  it('uses the first message for an idle existing-session attachment', () => {
    expect(
      planRunStart({
        plan: planResume(null),
        claimReason: 'queued',
        pending: [{ text: 'Shorten the second section' }],
        prompt: 'Existing lesson',
        idleAttach: true,
      }),
    ).toEqual({ kind: 'prompt', text: 'Shorten the second section' });
  });

  it('prompts a queued follow-up but continues an orphaned run', () => {
    const plan = planResume([user('Start'), assistant('Working'), toolCall(), toolResult()]);
    expect(
      planRunStart({
        plan,
        claimReason: 'queued',
        pending: [{ text: 'Add an example' }],
        prompt: 'Start',
      }),
    ).toEqual({ kind: 'prompt', text: 'Add an example' });
    expect(
      planRunStart({
        plan,
        claimReason: 'orphaned',
        pending: [{ text: 'Are you there?' }],
        prompt: 'Start',
      }),
    ).toEqual({ kind: 'continue' });
  });

  it('prompts an answer after an ask checkpoint even when the claim is orphaned', () => {
    const plan = planResume([user('Start'), askUserResult()]);
    expect(plan.kind).toBe('already-complete');
    expect(
      planRunStart({
        plan,
        claimReason: 'orphaned',
        pending: [{ text: 'Continue' }],
        prompt: 'Start',
      }),
    ).toEqual({ kind: 'prompt', text: 'Continue' });
  });
});

describe('durable user-message delivery tags', () => {
  it('round-trips the exact durable sequence on a user frame', () => {
    expect(durableUserMessageSeq(tagDurableUserMessage(user('Open'), 7))).toBe(7);
    expect(durableUserMessageSeq(assistant('Done'))).toBeNull();
  });
});

describe('frozen Zhongkao Skill runner gate', () => {
  const meta = (skillId?: string) => ({
    id: 'agent-session-alpha',
    ownerId: 'owner-alpha',
    ...(skillId ? { skillId } : {}),
  });

  it('copies and freezes the exact durable turn for the frozen Zhongkao Skill', () => {
    const source = meta('zhongkao-coach');
    const turn = trustedZhongkaoTurnForRun(source, {
      kind: 'prompt',
      text: 'Fictional question',
      durableMessageSeq: 7,
    });
    expect(turn).toEqual({
      ownerId: 'owner-alpha',
      agentSessionId: 'agent-session-alpha',
      userMessageSeq: 7,
    });
    expect(Object.isFrozen(turn)).toBe(true);
    source.id = 'mutated-session';
    expect(turn?.agentSessionId).toBe('agent-session-alpha');
  });

  it.each([
    ['ordinary Agent', meta(), { kind: 'prompt', text: '中考', durableMessageSeq: 7 }],
    [
      'other frozen Skill',
      meta('stage-design'),
      { kind: 'prompt', text: '中考', durableMessageSeq: 7 },
    ],
    ['no durable user turn', meta('zhongkao-coach'), { kind: 'prompt', text: 'synthetic' }],
    ['crash continuation', meta('zhongkao-coach'), { kind: 'continue' }],
  ] as const)('fails closed for %s', (_label, sessionMeta, start) => {
    expect(trustedZhongkaoTurnForRun(sessionMeta, start)).toBeNull();
  });

  it('binds N independently from a later N+1 run', () => {
    const frozen = meta('zhongkao-coach');
    const turnN = trustedZhongkaoTurnForRun(frozen, {
      kind: 'prompt',
      text: 'turn N',
      durableMessageSeq: 7,
    });
    const turnN1 = trustedZhongkaoTurnForRun(frozen, {
      kind: 'prompt',
      text: 'turn N+1',
      durableMessageSeq: 8,
    });
    expect(turnN?.userMessageSeq).toBe(7);
    expect(turnN1?.userMessageSeq).toBe(8);
  });

  it('binds a crash continuation only when exact durable provenance was recovered', () => {
    expect(
      trustedZhongkaoTurnForRun(meta('zhongkao-coach'), {
        kind: 'continue',
        durableMessageSeq: 7,
      }),
    ).toMatchObject({ userMessageSeq: 7 });
    expect(trustedZhongkaoTurnForRun(meta('zhongkao-coach'), { kind: 'continue' })).toBeNull();
  });

  it('maps terminal gate states only to stable server notice reasons', () => {
    expect(
      terminalCoachNoticeReason({
        status: 'blocked',
        requiredToolName: 'zhongkao_coach_action',
        signal: {
          kind: 'terminal_tool_gate',
          code: 'TERMINAL_TOOL_GATE_INVALID_REQUIRED_TOOL_ARGUMENTS',
          requiredToolName: 'zhongkao_coach_action',
        },
      }),
    ).toBe('COACH_TOOL_INPUT_INVALID');
    expect(
      terminalCoachNoticeReason({
        status: 'completed',
        requiredToolName: 'zhongkao_coach_action',
        toolCallId: 'call-private',
        isError: true,
      }),
    ).toBe('COACH_TOOL_RESULT_INVALID');
  });

  it('keeps the actual runner assembly and allowlist wired to the same gate', () => {
    const source = readFileSync('lib/server/agent-runtime/runner.ts', 'utf8');
    expect(source).toContain('const coachTools = trustedCoachTurn');
    expect(source).toContain('createZhongkaoCoachActionTool({');
    expect(source).toContain('...(coachTools.length ? [ZHONGKAO_COACH_TOOL_NAME] : [])');
    expect(source).toContain('createTerminalToolGate({');
    expect(source).toContain('terminalToolGate || questionEmitted');
  });
});

describe('composeFollowUpText', () => {
  it('leaves bare text untouched and exposes only safe attachment metadata', () => {
    expect(composeFollowUpText({ text: 'Continue' })).toBe('Continue');
    const text = composeFollowUpText({
      text: 'Use this recording',
      materials: [
        {
          materialId: 'material-1',
          originalName: 'lecture.mp4',
          mime: 'video/mp4',
          bytes: 10,
        },
      ],
    });
    expect(text).toContain('lecture.mp4');
    expect(text).toContain('video/mp4');
    expect(text).toContain('use use_material_media');
  });

  it('injects a freshly resolved slide element as turn-scoped agent context', async () => {
    const elementRef: ElementRef = {
      kind: 'slide-element',
      stageId: 'stage-1',
      sceneId: 'scene-2',
      elementId: 'title-1',
      elementType: 'text',
      label: 'Text · Old title',
      snapshotText: 'Old title',
    };
    const scene = {
      id: 'scene-2',
      stageId: 'stage-1',
      order: 2,
      title: 'Second slide',
      type: 'slide',
      content: {
        type: 'slide',
        canvas: {
          id: 'canvas-2',
          elements: [{ id: 'title-1', type: 'text', content: '<p>Current title</p>' }],
        },
      },
      actions: [],
    } as unknown as Scene;

    const text = await composeFollowUpTextWithElementRefs(
      { text: 'Shorten it', elementRefs: [elementRef] },
      'stage-1',
      async () => scene,
      'Refraction',
    );

    expect(text).toContain('Resolved target');
    expect(text).toContain('"stageId":"stage-1"');
    expect(text).toContain('"sceneId":"scene-2"');
    expect(text).toContain('"elementId":"title-1"');
    expect(text).toContain('"visibleText":"Current title"');
    expect(text).toContain('do not modify unrelated elements');
  });

  it('injects a GenUI element with verified live-DOM anchors', async () => {
    const interactiveRef: ElementRef = {
      kind: 'interactive-element',
      stageId: 'stage-1',
      sceneId: 'scene-web',
      selector: '#cta',
      outerHTML: '<button id="cta">Start experiment</button>',
      text: 'Start experiment',
      label: 'button · Start experiment',
    };
    const scene = {
      id: 'scene-web',
      stageId: 'stage-1',
      order: 3,
      title: 'Interactive experiment',
      type: 'interactive',
      content: { type: 'interactive', html: `<main>${interactiveRef.outerHTML}</main>` },
      actions: [],
    } as unknown as Scene;

    const text = await composeFollowUpTextWithElementRefs(
      { text: 'Rename this button', elementRefs: [interactiveRef] },
      'stage-1',
      async () => scene,
    );

    expect(text).toContain('Resolved interactive target');
    expect(text).toContain('"selector":"#cta"');
    expect(text).toContain('"anchorVerified":"true"');
    expect(text).toContain('"textFound":"true"');
  });
});

describe('courseRefs reach the run prompt', () => {
  const ref = (stageId: string, title: string): CourseRef => ({ kind: 'course', stageId, title });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('composes the named classrooms into a follow-up message', () => {
    const text = composeFollowUpText({
      text: 'Add an example',
      courseRefs: [ref('stage-1', '光的折射')],
    });
    expect(text).toContain('Add an example');
    expect(text).toContain('光的折射');
    expect(text).toContain('stage-1');
  });

  it('prompts a first run with the opening message plus its classrooms', () => {
    const named = [ref('stage-1', '光的折射')];
    expect(
      planRunStart({
        plan: planResume(null),
        claimReason: 'queued',
        pending: [{ text: 'Build a course', courseRefs: named }],
        prompt: 'Build a course',
      }),
    ).toEqual({ kind: 'prompt', text: composeCourseRefsText('Build a course', named) });
  });

  it('keeps the raw prompt when the opening message named no classroom', () => {
    expect(
      planRunStart({
        plan: planResume(null),
        claimReason: 'queued',
        pending: [{ text: 'Build a course' }],
        prompt: 'Build a course',
      }),
    ).toEqual({ kind: 'prompt', text: 'Build a course' });
  });

  it('resolves refs to the current name and degrades an unresolved one', async () => {
    mocks.probeStageAccess.mockImplementation(async (ownerId: string, stageId: string) =>
      stageId === 'stage-1'
        ? { kind: 'owned', stage: { stageId, name: 'Renamed classroom' } }
        : { kind: 'missing' },
    );

    const resolved = await resolveCourseRefsForContext('owner-1', [
      ref('stage-1', 'Old snapshot name'),
      ref('stage-2', 'Gone classroom'),
    ]);

    expect(resolved).toEqual([
      { kind: 'course', stageId: 'stage-1', title: 'Renamed classroom' },
      { kind: 'course', stageId: 'stage-2', title: 'Gone classroom' },
    ]);
  });
});
