/**
 * `ask_user`'s optional `recommended` option flag and `details` field: both
 * pass through to the envelope, both are absent from an envelope that did not
 * use them (so older consumers see exactly what they saw before), and a
 * recommendation is single and never the free-text option.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildAskUserTool } from '@/lib/server/agent-runtime/ask-user';
import { foldEvent, createInitialSessionState } from '@/lib/workbench/session-store';

async function ask(params: Record<string, unknown>) {
  const onUserQuestion = vi.fn();
  const tool = buildAskUserTool({ onUserQuestion });
  const result = (await tool.execute('call-1', params as never, undefined)) as {
    isError?: boolean;
    details: unknown;
    content: { text: string }[];
  };
  return { result, onUserQuestion };
}

describe('ask_user recommended option and details', () => {
  it('keeps an envelope without either field exactly as before', async () => {
    const { result, onUserQuestion } = await ask({
      question: 'Which version?',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(onUserQuestion).toHaveBeenCalledWith({
      question: 'Which version?',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    });
  });

  it('passes one recommended option and trimmed details through', async () => {
    const { result, onUserQuestion } = await ask({
      question: 'Build this plan?',
      details: '  1. Intro\n2. Quiz  ',
      options: [
        { id: 'go', label: 'Go ahead', recommended: true },
        { id: 'change', label: 'Change it', recommended: false },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(onUserQuestion).toHaveBeenCalledWith({
      question: 'Build this plan?',
      details: '1. Intro\n2. Quiz',
      options: [
        { id: 'go', label: 'Go ahead', recommended: true },
        { id: 'change', label: 'Change it' },
      ],
    });
  });

  it('drops blank details', async () => {
    const { onUserQuestion } = await ask({ question: 'Ready?', details: '   ' });
    expect(onUserQuestion).toHaveBeenCalledWith({ question: 'Ready?' });
  });

  it('rejects more than one recommendation, and a recommended free-text option', async () => {
    for (const options of [
      [
        { id: 'a', label: 'A', recommended: true },
        { id: 'b', label: 'B', recommended: true },
      ],
      [
        { id: 'a', label: 'A' },
        { id: 'other', label: 'Something else', recommended: true },
      ],
    ]) {
      const { result, onUserQuestion } = await ask({ question: 'Which?', options });
      expect(result.isError).toBe(true);
      expect(result.details).toEqual({ error: 'invalid-recommended-option' });
      expect(onUserQuestion).not.toHaveBeenCalled();
    }
  });

  it('tells the agent when to recommend and when not to', () => {
    const tool = buildAskUserTool({ onUserQuestion: () => {} });
    expect(tool.description).toContain('recommended');
    expect(tool.description).toContain('Do not mark one when you lack information');
  });
});

describe('the chat fold reads the new fields defensively', () => {
  const fold = (data: unknown) =>
    foldEvent(createInitialSessionState(), {
      id: 1,
      ts: 1,
      attempt: 0,
      type: 'user_question',
      data,
    }).chat[0];

  it('carries a recommended flag and details onto the card', () => {
    const node = fold({
      question: 'Build it?',
      details: 'The plan',
      options: [
        { id: 'go', label: 'Go', recommended: true },
        { id: 'no', label: 'No', recommended: 'yes' },
      ],
    });
    expect(node.questionDetails).toBe('The plan');
    expect(node.questionOptions).toEqual([
      { id: 'go', label: 'Go', recommended: true },
      { id: 'no', label: 'No' },
    ]);
  });

  it('folds an old envelope with neither field', () => {
    const node = fold({ question: 'Which?', options: [{ id: 'a', label: 'A' }] });
    expect(node.questionDetails).toBeUndefined();
    expect(node.questionOptions).toEqual([{ id: 'a', label: 'A' }]);
  });
});
