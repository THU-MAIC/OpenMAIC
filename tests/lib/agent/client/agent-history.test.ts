import { describe, expect, it } from 'vitest';
import { messageTextForHistory, toAgentHistory } from '@/lib/agent/client/agent-history';

describe('agent-history', () => {
  it('includes edit_elements apply refusal in assistant history text', () => {
    const text = messageTextForHistory([
      { type: 'text', text: 'I updated the title.' },
      {
        type: 'tool-call',
        toolName: 'edit_elements',
        isError: true,
        result: {
          details: { intents: null, updateCount: 0, refuseReason: 'element "a" is locked' },
        },
      },
    ]);
    expect(text).toContain('I updated the title.');
    expect(text).toContain('[edit_elements: not applied — element "a" is locked]');
  });

  it('includes edit_elements applied marker', () => {
    const text = messageTextForHistory([
      {
        type: 'tool-call',
        toolName: 'edit_elements',
        result: {
          details: { intents: [{ type: 'element.update' }], updateCount: 1 },
        },
      },
      { type: 'text', text: 'Done.' },
    ]);
    expect(text).toContain('[edit_elements: applied 1 update(s)]');
    expect(text).toContain('Done.');
  });

  it('projects a thread into history turns', () => {
    const turns = toAgentHistory([
      { role: 'user', content: [{ type: 'text', text: 'make it blue' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolName: 'edit_elements',
            isError: true,
            result: { details: { intents: null, refuseReason: 'no open edit session' } },
          },
          { type: 'text', text: 'Updated!' },
        ],
      },
    ]);
    expect(turns).toEqual([
      { role: 'user', text: 'make it blue' },
      {
        role: 'assistant',
        text: '[edit_elements: not applied — no open edit session]\nUpdated!',
      },
    ]);
  });
});
