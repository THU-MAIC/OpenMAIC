import { describe, expect, it, vi } from 'vitest';
import { buildAskUserTool } from '@/lib/server/agent-runtime/ask-user';

async function ask(question: string) {
  const onUserQuestion = vi.fn();
  const tool = buildAskUserTool({ onUserQuestion });
  const result = (await tool.execute('call-1', { question }, undefined)) as {
    isError?: boolean;
    details: unknown;
    content: { text: string }[];
  };
  return { result, onUserQuestion };
}

describe('ask_user line breaks', () => {
  it('rejects a question whose line breaks arrived JSON-escaped, without converting it', async () => {
    // The shape a model sent: paragraphs joined by the two characters backslash+n.
    const { result, onUserQuestion } = await ask(
      'Which format and depth should it have?\\n\\n**A. Full walkthrough**: nine pages.\\n\\n**B. Short walkthrough**: five pages.',
    );
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({ error: 'escaped-newlines' });
    expect(result.content[0].text).toContain('literal backslash+n');
    // The model is told how to keep a backslash+n the user should read.
    expect(result.content[0].text).toContain('backtick code spans');
    expect(onUserQuestion).not.toHaveBeenCalled();
  });

  it('accepts the same question with actual newlines', async () => {
    const question =
      'Which format and depth should it have?\n\n**A. Full walkthrough**: nine pages.';
    const { result, onUserQuestion } = await ask(question);
    expect(result.isError).toBeUndefined();
    expect(onUserQuestion).toHaveBeenCalledWith({ question });
  });

  it('leaves a backslash+n the user is meant to read alone', async () => {
    for (const question of [
      'Should the slide explain `\\n` in Python strings?',
      'Use $a \\neq b$ or $a \\ne b$ in the proof?',
      'Show the gradient as \\nabla f?',
    ]) {
      const { result, onUserQuestion } = await ask(question);
      expect(result.isError, question).toBeUndefined();
      expect(onUserQuestion).toHaveBeenCalledWith({ question });
    }
  });

  it('does not second-guess a question that already has actual newlines', async () => {
    const question = 'Pick one:\n\nA. split on `\\n`\nB. split on \\n literally';
    const { result } = await ask(question);
    expect(result.isError).toBeUndefined();
  });

  it('rejects at most once per run, then shows a repeated question as written', async () => {
    const onUserQuestion = vi.fn();
    const tool = buildAskUserTool({ onUserQuestion });
    const question = 'Compare these?\\n\\nA. Line 1';
    const first = (await tool.execute('call-1', { question }, undefined)) as { isError?: boolean };
    expect(first.isError).toBe(true);
    expect(onUserQuestion).not.toHaveBeenCalled();

    const second = (await tool.execute('call-2', { question }, undefined)) as {
      isError?: boolean;
    };
    expect(second.isError).toBeUndefined();
    expect(onUserQuestion).toHaveBeenCalledWith({ question });

    // A different escaped question later in the same run is not rejected again.
    const other = 'Another one?\\n\\nA. yes';
    const third = (await tool.execute('call-3', { question: other }, undefined)) as {
      isError?: boolean;
    };
    expect(third.isError).toBeUndefined();
    expect(onUserQuestion).toHaveBeenLastCalledWith({ question: other });
  });

  it('a new run (new tool instance) checks again', async () => {
    const question = 'Pick one?\\n\\nA. yes';
    expect((await ask(question)).result.isError).toBe(true);
    expect((await ask(question)).result.isError).toBe(true);
  });
});
