import { describe, expect, it } from 'vitest';
import { GuidedSkillReview } from '@/lib/server/pbl-v3/guided-review';
import { isPBLV3Reference } from '@/lib/pbl/v3/types';

const protocol = {
  digest: 'protocol-v1',
  progression: ['SKILL.md', 'A-teach.md', 'B-review.md'],
  final: 'B-review.md',
};
const artifact = 'a'.repeat(64);

describe('guided review boundaries', () => {
  it('rolls back local progression and terminal flags only when a tool transaction fails', async () => {
    const review = new GuidedSkillReview(protocol);
    review.beginRun('code:3', [{ seq: 1, text: 'Start' }], false);
    const before = structuredClone(review.state);
    await expect(
      review.withRollback(async () => {
        review.advance('A-teach.md', undefined, artifact);
        review.handoff('Which build requirement?');
        throw new Error('write failed');
      }),
    ).rejects.toThrow('write failed');
    expect(review.state).toEqual(before);
    review.advance('A-teach.md', undefined, artifact);
    const active = structuredClone(review.state);
    await expect(
      review.withRollback(async () => {
        review.handoff('Which build requirement?');
        throw new Error('write failed again');
      }),
    ).rejects.toThrow('write failed again');
    expect(review.state).toEqual(active);
    expect(() => review.assertWritable()).not.toThrow();
    await review.withRollback(async () => review.handoff('Which build requirement?'));
    expect(() => review.assertWritable()).toThrow();
    expect(review.state.handoff?.question).toBe('Which build requirement?');
  });

  it('persists a meaningful help handoff without crediting its reply as Skill review', () => {
    const review = new GuidedSkillReview(protocol);
    review.beginRun('code:3', [{ seq: 1, text: 'Start' }], false);
    review.advance('A-teach.md', undefined, artifact);
    expect(() => review.handoff('   ')).toThrow('concrete learner question');
    review.handoff('Which build requirement needs clarification?');
    const resumed = new GuidedSkillReview(protocol, review.state);
    resumed.beginRun('code:3', [{ seq: 1, text: 'Start' }], false);
    expect(() => resumed.assertWritable()).toThrow();
    resumed.beginRun('code:3', [{ seq: 2, text: 'Here is the build requirement.' }], true);
    expect(() => resumed.advance('B-review.md', 'The learner helped.', artifact)).toThrow();
    resumed.checkpoint('Review the repaired artifact.', artifact);
    resumed.beginRun('code:3', [{ seq: 3, text: 'I reviewed the repaired artifact.' }], true);
    expect(() =>
      resumed.advance('B-review.md', 'The artifact was reviewed.', artifact),
    ).not.toThrow();
  });

  it('requires a later real reply and refuses changed artifacts and fabricated feedback without a reply', () => {
    const review = new GuidedSkillReview(protocol);
    const start = { seq: 1, text: 'Start' };
    review.beginRun('intro:0', [start], false);
    review.advance('A-teach.md', undefined, artifact);
    const receipt = review.checkpoint('Explain the return value.', artifact);
    const restored = new GuidedSkillReview(protocol, receipt);
    restored.beginRun('intro:0', [start], true);
    expect(() => restored.assertWritable()).toThrow();
    expect(() => restored.checkpoint('Ask again', artifact)).toThrow();
    expect(() => restored.advance('B-review.md', 'Start', artifact)).toThrow();
    restored.beginRun('intro:0', [start, { seq: 3, text: ' ' }], true);
    expect(() => restored.advance('B-review.md', 'The learner approves.', artifact)).toThrow();
    restored.beginRun('intro:0', [start, { seq: 5, text: 'It returns the greeting.' }], true);
    expect(() => restored.assertWritable()).not.toThrow();
    expect(() => restored.advance('B-review.md', ' ', artifact)).toThrow();
    expect(() => restored.advance('B-review.md', 'returns the greeting', 'b'.repeat(64))).toThrow();
    restored.advance('B-review.md', 'returns the greeting', artifact);
    expect(() => restored.complete('returns the greeting', artifact)).toThrow();
    restored.checkpoint('Confirm the example.', artifact);
    restored.beginRun('intro:0', [{ seq: 7, text: 'The example is correct.' }], true);
    expect(() =>
      restored.complete('Student reply: "The example is correct."', artifact),
    ).not.toThrow();
  });

  it('cannot skip sections or reuse receipts after a protocol change', () => {
    const review = new GuidedSkillReview(protocol);
    review.beginRun('intro:0', [{ seq: 1, text: 'Start' }], false);
    expect(() => review.advance('B-review.md', undefined, artifact)).toThrow();
    review.advance('A-teach.md', undefined, artifact);
    const receipt = review.checkpoint('Explain.', artifact);
    const changed = new GuidedSkillReview({ ...protocol, digest: 'protocol-v2' }, receipt);
    expect(changed.state.activeFile).toBe('');
    expect(changed.state.pending).toBeUndefined();
  });

  it.each([
    'Student reply: "It returns a string."',
    'The learner explains that the result is returned as a string.',
  ])('accepts decorated or summarized feedback: %s', (feedback) => {
    const review = new GuidedSkillReview(protocol);
    review.beginRun('intro:0', [{ seq: 1, text: 'Start' }], false);
    review.advance('A-teach.md', undefined, artifact);
    review.checkpoint('Explain the return value.', artifact);
    review.beginRun('intro:0', [{ seq: 5, text: 'It returns a string.' }], true);
    expect(() => review.advance('B-review.md', feedback, artifact)).not.toThrow();
  });

  it('binds multiple responses to the pending question and does not reuse them for the next one', () => {
    const review = new GuidedSkillReview(protocol);
    const messages = [
      { seq: 1, text: 'An older answer.' },
      { seq: 3, text: 'Start this review.' },
    ];
    review.beginRun('intro:0', messages, false);
    review.advance('A-teach.md', undefined, artifact);
    const pending = review.checkpoint('Compare return and print.', artifact);
    const restored = new GuidedSkillReview(protocol, pending);
    const replies = [
      { seq: 6, text: 'Return gives a value to the caller.' },
      { seq: 9, text: 'Print displays it and returns None.' },
    ];
    restored.beginRun('intro:0', [...messages, ...replies], true);
    expect(restored.studentResponses()).toEqual(replies);
    restored.advance('B-review.md', 'The two answers distinguish return from print.', artifact);
    restored.checkpoint('Confirm the current example.', artifact);
    restored.beginRun('intro:0', [...messages, ...replies], true);
    expect(restored.studentResponses()).toEqual([]);
    expect(() => restored.complete('The earlier answers confirm it.', artifact)).toThrow();
    restored.beginRun('intro:0', [...messages, ...replies, { seq: 12, text: '确认' }], true);
    expect(() => restored.complete('The learner confirms the example.', artifact)).not.toThrow();
  });

  it('rejects a receipt from another stage even when newer messages exist', () => {
    const review = new GuidedSkillReview(protocol);
    review.beginRun('milestone:1', [{ seq: 1, text: 'Start' }], false);
    review.advance('A-teach.md', undefined, artifact);
    review.checkpoint('Explain.', artifact);
    review.beginRun('milestone:2', [{ seq: 5, text: 'A response for a different stage.' }], true);
    expect(review.studentResponses()).toEqual([]);
    expect(() => review.advance('B-review.md', 'The learner answered.', artifact)).toThrow();
  });

  it.each([true, false])(
    'keeps welcome inside A and requires real readiness (read first: %s)',
    (readFirst) => {
      const review = new GuidedSkillReview(protocol, undefined, true);
      review.beginRun('first:0', [], false, 1);
      if (readFirst) review.advance('A-teach.md', undefined, artifact);
      review.checkpoint('Any process questions? Ready to continue?', artifact);
      expect(review.state.activeFile).toBe('A-teach.md');
      expect(review.state.reviewedFiles).toEqual([]);
      expect(() => review.startTeaching('Ready', artifact)).toThrow();
      const resumed = new GuidedSkillReview(protocol, review.state, true);
      resumed.beginRun('first:0', [{ seq: 3, text: 'Will the Agent write code with me?' }], true);
      resumed.checkpoint('Yes, you review it together. Ready to begin?', artifact);
      resumed.beginRun('first:0', [{ seq: 3, text: 'Will the Agent write code with me?' }], true);
      expect(() => resumed.startTeaching('Ready', artifact)).toThrow();
      resumed.beginRun(
        'first:0',
        [
          { seq: 3, text: 'Will the Agent write code with me?' },
          { seq: 5, text: 'Ready, please begin.' },
        ],
        true,
      );
      resumed.startTeaching('The learner explicitly asks to begin.', artifact);
      expect(resumed.state.activeFile).toBe('A-teach.md');
      expect(resumed.state.reviewedFiles).toEqual([]);
      expect(resumed.state.welcome).toBe('ready');
      expect(() =>
        resumed.advance('B-review.md', 'Readiness means understanding.', artifact, true),
      ).toThrow();
      resumed.checkpoint('Explain the new concept.', artifact);
    },
  );

  it('still requires a section read for lessons and rejects invalid or repeated welcome receipts', () => {
    const lesson = new GuidedSkillReview(protocol);
    lesson.beginRun('later:0', [], false, 1);
    expect(() => lesson.checkpoint('Explain.', artifact)).toThrow();
    const welcome = new GuidedSkillReview(protocol, undefined, true);
    welcome.beginRun('first:0', [], false, 1);
    expect(() => welcome.checkpoint(' ', artifact)).toThrow();
    expect(welcome.state.activeFile).toBe('');
    welcome.checkpoint('Ready?', artifact);
    expect(() => welcome.checkpoint('Ready again?', artifact)).toThrow();
    expect(() => welcome.complete('No student reply.', artifact)).toThrow();
  });

  it('requires the project welcome when a saved protocol is no longer valid', () => {
    const legacy = new GuidedSkillReview(protocol);
    legacy.beginRun('first:0', [], false, 1);
    legacy.advance('A-teach.md', undefined, artifact);
    const restored = new GuidedSkillReview({ ...protocol, digest: 'updated' }, legacy.state, true);
    expect(restored.state.welcome).toBe('pending');
    expect(restored.state.activeFile).toBe('');
    expect(new GuidedSkillReview(protocol).state.welcome).toBeUndefined();
  });

  it('credits an answer that anticipated later sections without another question or learner turn', () => {
    const larger = { ...protocol, progression: ['SKILL.md', 'A', 'B', 'C', 'D'], final: 'D' };
    const review = new GuidedSkillReview(larger);
    review.beginRun('code:3', [], false, 1);
    review.advance('A', undefined, artifact);
    review.checkpoint('Explain the path.', artifact);
    const answer = {
      seq: 3,
      text: 'The input reaches the output; I checked empty input and approve this exact version for testing.',
    };
    review.beginRun('code:3', [answer], true);
    review.advance(
      'B',
      'The learner explains the path and already covers the risk and approval.',
      artifact,
    );
    review.advance('C', 'The same actual reply covers the empty-input risk.', artifact, true);
    review.advance('D', 'The learner has approved this unchanged version.', artifact, true);
    const resumed = new GuidedSkillReview(larger, review.state);
    resumed.beginRun('code:3', [answer], true);
    expect(() =>
      resumed.complete('The same real approval survives reload.', artifact, true),
    ).not.toThrow();
    expect(() =>
      review.complete('Reuse that explicit current-version approval.', artifact, true),
    ).not.toThrow();
  });

  it('does not turn understanding into artifact approval, and recovers with a real approval reply', () => {
    const review = new GuidedSkillReview(protocol, undefined, false, true);
    review.beginRun('plan:2', [], false, 1);
    review.advance('A-teach.md', undefined, artifact);
    review.checkpoint('Explain the plan.', artifact);
    review.beginRun('plan:2', [{ seq: 3, text: 'I understand the plan.' }], true);
    review.advance('B-review.md', 'The learner understands.', artifact);
    expect(() => review.complete('Reuse understanding.', artifact, true)).toThrow(
      'understanding feedback',
    );
    review.checkpoint('Do you approve this current plan?', artifact, true);
    expect(() => review.complete('The assistant approves.', artifact)).toThrow();
    review.beginRun('plan:2', [{ seq: 3, text: 'I understand the plan.' }], true);
    expect(() => review.complete('An older reply.', artifact)).toThrow();
    review.beginRun('plan:2', [{ seq: 5, text: 'I approve this version.' }], true);
    expect(() => review.complete('Actual approval.', 'b'.repeat(64))).toThrow();
    expect(() => review.complete('Actual current-version approval.', artifact)).not.toThrow();
  });

  it('reuses explicit approval across sections and reload without another question', () => {
    const review = new GuidedSkillReview(protocol, undefined, false, true);
    review.beginRun('code:3', [], false, 1);
    review.advance('A-teach.md', undefined, artifact);
    review.checkpoint('Review and approve this code version for testing.', artifact, true);
    const replies = [{ seq: 3, text: 'I understand it and approve it for testing.' }];
    review.beginRun('code:3', replies, true);
    review.advance('B-review.md', 'Actual approval.', artifact);
    const restored = new GuidedSkillReview(protocol, review.state, false, true);
    restored.beginRun('code:3', replies, true);
    expect(() =>
      restored.complete('Reuse unchanged approved version.', artifact, true),
    ).not.toThrow();
  });

  it('retains current-version approval after a later answered understanding question', () => {
    const extended = { ...protocol, progression: ['SKILL.md', 'A', 'B', 'C'], final: 'C' };
    const review = new GuidedSkillReview(extended, undefined, false, true);
    review.beginRun('code:3', [], false, 1);
    review.advance('A', undefined, artifact);
    review.checkpoint('Approve this version?', artifact, true);
    const approval = { seq: 3, text: 'I approve this version.' };
    review.beginRun('code:3', [approval], true);
    review.advance('B', 'Approved.', artifact);
    review.checkpoint('You asked about one risk. Is it clear now?', artifact);
    const clarification = { seq: 5, text: 'Yes, the explanation resolved my question.' };
    review.beginRun('code:3', [approval, clarification], true);
    review.advance('C', 'The new question is answered.', artifact);
    expect(() => review.complete('Reuse unchanged approval.', artifact, true)).not.toThrow();
    expect(() => review.complete('Changed version.', 'b'.repeat(64), true)).toThrow();
  });

  it('rejects reused feedback from an opening, another stage, changed artifact or an unanswered new question', () => {
    const review = new GuidedSkillReview(protocol);
    review.beginRun('code:3', [], false, 1);
    review.advance('A-teach.md', undefined, artifact);
    expect(() =>
      review.advance('B-review.md', 'Fabricated understanding.', artifact, true),
    ).toThrow();
    review.checkpoint('Explain.', artifact);
    review.beginRun('code:3', [{ seq: 3, text: 'I understand and approve.' }], true);
    review.advance('B-review.md', 'The learner confirms understanding.', artifact);
    expect(() => review.complete('Old version.', 'b'.repeat(64), true)).toThrow();
    review.beginRun('code:4', [{ seq: 3, text: 'An answer in another stage.' }], true);
    expect(() => review.complete('Other stage.', artifact, true)).toThrow();
    review.beginRun('code:3', [{ seq: 3, text: 'I understand and approve.' }], true);
    review.checkpoint('A newly discovered real issue needs an answer.', artifact);
    review.beginRun('code:3', [{ seq: 3, text: 'I understand and approve.' }], true);
    expect(() => review.complete('Ignore the new issue.', artifact, true)).toThrow();
  });

  it('accepts only bounded installed-project references', () => {
    expect(isPBLV3Reference({ id: 'greeting-python', version: '1.0.0' })).toBe(true);
    for (const value of [
      null,
      [],
      { id: '../project', version: '1' },
      { id: 'project', version: 1 },
      { id: 'p'.repeat(81), version: '1' },
    ])
      expect(isPBLV3Reference(value)).toBe(false);
  });
});
