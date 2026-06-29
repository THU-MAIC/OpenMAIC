/**
 * Tests for the messages + evaluations timeline merge in chat.tsx.
 *
 * The merge is the single place chat rendering depends on for
 * "what shows up in what order" — easy to get wrong, hard to spot
 * in manual testing (a one-second timestamp drift can flip the
 * narrative + card sequence in ways that read as "the evaluator
 * fired before the assistant spoke"). Locking this in saves us.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  displayAgentName,
  handoverForMilestoneEvaluation,
  shouldShowStreamingDraft,
  stripLeakedToolJsonPreview,
  streamingEvaluationPreview,
  streamingMessagePreview,
} from '@/components/scene-renderers/pbl/v2/chat';
import { stripEmbeddedDividerMarkers } from '@/components/scene-renderers/pbl/v2/protocol-markers';
import type { PBLChatMessage, PBLEvaluation, PBLHandover } from '@/lib/pbl/v2/types';

function msg(id: string, ts: string, content = 'x'): PBLChatMessage {
  return {
    id,
    roleType: 'instructor',
    content,
    ts,
  };
}

function ev(id: string, createdAt: string, kind: PBLEvaluation['kind'] = 'task'): PBLEvaluation {
  return {
    id,
    kind,
    feedback: 'fb',
    strengths: [],
    improvements: [],
    createdAt,
  };
}

describe('buildTimeline', () => {
  it('returns empty when both inputs empty', () => {
    expect(buildTimeline([], [])).toEqual([]);
  });

  it('preserves message-only order by ts', () => {
    const items = buildTimeline(
      [msg('m2', '2026-01-01T00:00:02Z'), msg('m1', '2026-01-01T00:00:01Z')],
      [],
    );
    expect(items.map((i) => i.kind === 'message' && i.message.id)).toEqual(['m1', 'm2']);
  });

  it('preserves evaluation-only order by createdAt', () => {
    const items = buildTimeline(
      [],
      [ev('e2', '2026-01-01T00:00:02Z'), ev('e1', '2026-01-01T00:00:01Z')],
    );
    expect(items.map((i) => i.kind === 'evaluation' && i.evaluation.id)).toEqual(['e1', 'e2']);
  });

  it('interleaves by timestamp', () => {
    const items = buildTimeline(
      [msg('m1', '2026-01-01T00:00:01Z'), msg('m2', '2026-01-01T00:00:05Z')],
      [ev('e1', '2026-01-01T00:00:03Z')],
    );
    const ids = items.map((i) =>
      i.kind === 'message'
        ? i.message.id
        : i.kind === 'evaluation'
          ? i.evaluation.id
          : 'roleplay-history',
    );
    expect(ids).toEqual(['m1', 'e1', 'm2']);
  });

  it('puts message before evaluation when timestamps tie', () => {
    const ts = '2026-01-01T00:00:05Z';
    const items = buildTimeline([msg('m', ts)], [ev('e', ts)]);
    expect(items.map((i) => i.kind)).toEqual(['message', 'evaluation']);
  });

  it('folds roleplay history into ONE collapsible item, slotted between prep and wrapup by its first ts', () => {
    // Instructor thread = prep message (early) + wrapup message (late); the
    // roleplay conversation happened in between (its own thread).
    const prep = msg('prep', '2026-01-01T00:00:01Z');
    const wrapup = msg('wrap', '2026-01-01T00:00:09Z');
    const roleplay = [msg('rp1', '2026-01-01T00:00:04Z'), msg('rp2', '2026-01-01T00:00:06Z')];
    const items = buildTimeline([prep, wrapup], [], roleplay);
    expect(items.map((i) => i.kind)).toEqual(['message', 'roleplay-history', 'message']);
    const block = items.find((i) => i.kind === 'roleplay-history');
    expect(block && block.kind === 'roleplay-history' && block.messages).toHaveLength(2);
  });

  it('adds NO roleplay-history item when there is none (ordinary projects / during prep or roleplay)', () => {
    const items = buildTimeline([msg('m', '2026-01-01T00:00:01Z')], []);
    expect(items.some((i) => i.kind === 'roleplay-history')).toBe(false);
  });

  it('puts the task-complete prompt immediately after the evaluation card when its timestamp is after the evaluation', () => {
    const items = buildTimeline(
      [
        msg('before', '2026-01-01T00:00:01.000Z', 'I submitted my work.'),
        msg(
          'ready',
          '2026-01-01T00:00:05.001Z',
          '这个任务已经完成了。如果你准备好了，也没有其他问题了，请点击左侧当前任务里的「完成」按钮进入下一步。',
        ),
      ],
      [ev('task-eval', '2026-01-01T00:00:05.000Z', 'task')],
    );

    const ids = items.map((i) =>
      i.kind === 'message'
        ? i.message.id
        : i.kind === 'evaluation'
          ? i.evaluation.id
          : 'roleplay-history',
    );
    expect(ids).toEqual(['before', 'task-eval', 'ready']);
  });

  it('keeps each evaluation kind distinct (task/milestone/final preserved in order)', () => {
    const items = buildTimeline(
      [],
      [
        ev('task1', '2026-01-01T00:00:01Z', 'task'),
        ev('ms1', '2026-01-01T00:00:02Z', 'milestone'),
        ev('final1', '2026-01-01T00:00:03Z', 'final'),
      ],
    );
    const kinds = items.map((i) => i.kind === 'evaluation' && i.evaluation.kind);
    expect(kinds).toEqual(['task', 'milestone', 'final']);
  });
});

describe('displayAgentName', () => {
  it('falls back when the agent name is missing or blank', () => {
    expect(displayAgentName(undefined, 'Instructor')).toBe('Instructor');
    expect(displayAgentName('', 'Instructor')).toBe('Instructor');
    expect(displayAgentName('   ', 'Instructor')).toBe('Instructor');
    expect(displayAgentName(' 数据项目导师 ', 'Instructor')).toBe('数据项目导师');
  });
});

describe('PBL v2 — divider marker display guard', () => {
  it('strips embedded task divider protocol text from normal instructor prose', () => {
    expect(
      stripEmbeddedDividerMarkers(
        '思路已经到位了：你准备了可手算的测试样例。[TASK_DIVIDER]任务完成：准备手算测试样例 ｜ 开始下一任务：确定双指针起点',
      ),
    ).toBe('思路已经到位了：你准备了可手算的测试样例。');
  });

  it('keeps text after a later newline while removing only the marker line', () => {
    expect(
      stripEmbeddedDividerMarkers(
        '上一句收尾。\n[TASK_DIVIDER]任务完成：A ｜ 开始下一任务：B\n下一句仍然保留。',
      ),
    ).toBe('上一句收尾。\n\n下一句仍然保留。');
  });
});

describe('PBL v2 — streaming preview guards', () => {
  it('removes fenced evaluator JSON tail while streaming card prose', () => {
    expect(
      streamingEvaluationPreview(
        '这次做得很好，已经完成核心目标。\n\n```json\n{"strengths":["a"],"score":90}\n',
      ),
    ).toBe('这次做得很好，已经完成核心目标。');
  });

  it('removes partial fenced evaluator JSON tail while streaming card prose', () => {
    expect(streamingEvaluationPreview('这次做得很好。\n\n```j')).toBe('这次做得很好。');
  });

  it('removes naked evaluator JSON tail while streaming card prose', () => {
    expect(
      streamingEvaluationPreview('阶段反馈正文。\n{"learned":["a"],"performance":"ok","stars":4'),
    ).toBe('阶段反馈正文。');
  });

  it('removes embedded divider markers from streaming instructor text', () => {
    expect(
      streamingMessagePreview('任务已经完成。[TASK_DIVIDER]任务完成：A ｜ 开始下一任务：B'),
    ).toBe('任务已经完成。');
  });

  it('removes leaked tool JSON from streaming instructor text', () => {
    expect(
      streamingMessagePreview(
        '{"kind":"concept_unlocked","note":"学习者提交了 print(left_money)","signature":"print_left_money_output"}可以，这一步已经能把剩余金额显示出来了。',
      ),
    ).toBe('可以，这一步已经能把剩余金额显示出来了。');
  });

  it('hides partial leaked tool JSON while a stream is still incomplete', () => {
    expect(stripLeakedToolJsonPreview('{"kind":"concept_unlocked","note":"学习者提交了')).toBe('');
  });
});

describe('shouldShowStreamingDraft', () => {
  it('shows the initial waiting bubble before the first token arrives', () => {
    expect(
      shouldShowStreamingDraft({
        streaming: true,
        instructorStreaming: true,
        draftAssistant: '',
        streamCommittedOutput: false,
        submissionEvaluationActive: false,
      }),
    ).toBe(true);
  });

  it('keeps showing while live draft tokens are present', () => {
    expect(
      shouldShowStreamingDraft({
        streaming: true,
        instructorStreaming: true,
        draftAssistant: '正在讲解',
        streamCommittedOutput: false,
        submissionEvaluationActive: false,
      }),
    ).toBe(true);
  });

  it('hides the empty draft after the committed message has landed', () => {
    expect(
      shouldShowStreamingDraft({
        streaming: true,
        instructorStreaming: true,
        draftAssistant: '',
        streamCommittedOutput: true,
        submissionEvaluationActive: false,
      }),
    ).toBe(false);
  });

  it('hides the parent-count tail after this stream has committed output', () => {
    expect(
      shouldShowStreamingDraft({
        streaming: false,
        instructorStreaming: true,
        draftAssistant: '',
        streamCommittedOutput: true,
        submissionEvaluationActive: false,
      }),
    ).toBe(false);
  });

  it('still shows a background stream indicator when remounted mid-stream', () => {
    expect(
      shouldShowStreamingDraft({
        streaming: false,
        instructorStreaming: true,
        draftAssistant: '',
        streamCommittedOutput: false,
        submissionEvaluationActive: false,
      }),
    ).toBe(true);
  });

  it('shows a workspace-owned stream with live draft tokens', () => {
    expect(
      shouldShowStreamingDraft({
        streaming: false,
        instructorStreaming: true,
        draftAssistant: '阶段点评正在生成',
        streamCommittedOutput: false,
        hasExternalDraft: true,
        submissionEvaluationActive: false,
      }),
    ).toBe(true);
  });

  it('hides a workspace-owned stream after its committed card lands', () => {
    expect(
      shouldShowStreamingDraft({
        streaming: false,
        instructorStreaming: true,
        draftAssistant: '',
        streamCommittedOutput: true,
        hasExternalDraft: true,
        submissionEvaluationActive: false,
      }),
    ).toBe(false);
  });

  it('suppresses the instructor draft while submission evaluation owns the status UI', () => {
    expect(
      shouldShowStreamingDraft({
        streaming: true,
        instructorStreaming: true,
        draftAssistant: 'x',
        streamCommittedOutput: false,
        submissionEvaluationActive: true,
      }),
    ).toBe(false);
  });
});

describe('PBL v2 — milestone handover binding', () => {
  const consumedHandover: PBLHandover = {
    completedMilestoneId: 'ms-1',
    completedMilestoneTitle: '阶段一',
    nextMilestoneId: 'ms-2',
    nextMilestoneTitle: '阶段二',
    consumed: true,
  };

  it('binds a handover only to the milestone evaluation that created it', () => {
    const ev = {
      id: 'eval-ms-1',
      kind: 'milestone',
      milestoneId: 'ms-1',
      feedback: '阶段一完成。',
      strengths: [],
      improvements: [],
      createdAt: '2026-05-29T00:00:01.000Z',
    } as PBLEvaluation;

    expect(handoverForMilestoneEvaluation(ev, consumedHandover)).toBe(consumedHandover);
  });

  it('does not show a stale consumed handover on the final milestone card', () => {
    const finalMilestoneEval = {
      id: 'eval-ms-3',
      kind: 'milestone',
      milestoneId: 'ms-3',
      feedback: '最后阶段完成。',
      strengths: [],
      improvements: [],
      createdAt: '2026-05-29T00:00:02.000Z',
    } as PBLEvaluation;

    expect(handoverForMilestoneEvaluation(finalMilestoneEval, consumedHandover)).toBeUndefined();
  });
});
