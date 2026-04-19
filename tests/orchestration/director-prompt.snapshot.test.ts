import { describe, test, expect } from 'vitest';
import { buildDirectorPrompt } from '@/lib/orchestration/director-prompt';
import { teacherAgent, studentAgent, whiteboardLedger, peerResponses } from './fixtures';

describe('buildDirectorPrompt — baseline snapshots', () => {
  test('Q&A mode / no responses / closed whiteboard', () => {
    const out = buildDirectorPrompt([teacherAgent, studentAgent], 'No history', [], 0);
    expect(out).toMatchSnapshot();
  });

  test('Q&A mode / one response / open whiteboard / ledger', () => {
    const out = buildDirectorPrompt(
      [teacherAgent, studentAgent],
      '[User] hi',
      peerResponses,
      1,
      null,
      null,
      whiteboardLedger,
      undefined,
      true,
    );
    expect(out).toMatchSnapshot();
  });

  test('Discussion mode / with initiator + topic', () => {
    const out = buildDirectorPrompt(
      [teacherAgent, studentAgent],
      'No history',
      [],
      0,
      { topic: '力的合成', prompt: '想想生活中的例子' },
      'student_1',
    );
    expect(out).toMatchSnapshot();
  });

  test('with user profile', () => {
    const out = buildDirectorPrompt([teacherAgent], 'No history', [], 0, null, null, undefined, {
      nickname: 'Alice',
      bio: 'loves physics',
    });
    expect(out).toMatchSnapshot();
  });
});
