import { describe, test, expect } from 'vitest';
import {
  buildStructuredPrompt,
  convertMessagesToOpenAI,
  summarizeConversation,
} from '@/lib/orchestration/prompt-builder';
import type { StatelessChatRequest } from '@/lib/types/chat';
import {
  teacherAgent,
  studentAgent,
  slideStoreState,
  whiteboardLedger,
  peerResponses,
} from './fixtures';

describe('buildStructuredPrompt — baseline snapshots', () => {
  test('teacher / slide scene / no peers / no ledger', () => {
    const out = buildStructuredPrompt(teacherAgent, slideStoreState);
    expect(out).toMatchSnapshot();
  });

  test('teacher / slide scene / with peer responses', () => {
    const out = buildStructuredPrompt(
      teacherAgent,
      slideStoreState,
      undefined,
      undefined,
      undefined,
      peerResponses,
    );
    expect(out).toMatchSnapshot();
  });

  test('teacher / slide scene / with whiteboard ledger', () => {
    const out = buildStructuredPrompt(teacherAgent, slideStoreState, undefined, whiteboardLedger);
    expect(out).toMatchSnapshot();
  });

  test('teacher / slide scene / with discussion context', () => {
    const out = buildStructuredPrompt(teacherAgent, slideStoreState, {
      topic: '力的合成',
      prompt: '想想生活中的例子',
    });
    expect(out).toMatchSnapshot();
  });

  test('teacher / slide scene / with user profile', () => {
    const out = buildStructuredPrompt(teacherAgent, slideStoreState, undefined, undefined, {
      nickname: 'Alice',
      bio: 'loves physics',
    });
    expect(out).toMatchSnapshot();
  });

  test('student / slide scene', () => {
    const out = buildStructuredPrompt(studentAgent, slideStoreState);
    expect(out).toMatchSnapshot();
  });

  test('teacher / whiteboard-open scene (no spotlight/laser variants)', () => {
    const wbState: StatelessChatRequest['storeState'] = {
      ...slideStoreState,
      whiteboardOpen: true,
    };
    const out = buildStructuredPrompt(teacherAgent, wbState);
    expect(out).toMatchSnapshot();
  });
});

describe('convertMessagesToOpenAI', () => {
  test('mixed user + assistant + cross-agent messages', () => {
    const messages: StatelessChatRequest['messages'] = [
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
        metadata: { createdAt: 1 },
      },
      {
        id: 'msg-2',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'hello!' },
          {
            type: 'action-spotlight' as 'text',
            // Cast via unknown to inject action-part shape that convertMessagesToOpenAI reads dynamically
            ...({
              type: 'action-spotlight',
              state: 'result',
              actionName: 'spotlight',
              output: { success: true, data: { elementId: 'x' } },
            } as unknown as { text: string }),
          },
        ],
        metadata: { agentId: 'teacher_1', senderName: 'Mr. Chen' },
      },
    ];
    expect(convertMessagesToOpenAI(messages, 'teacher_1')).toMatchSnapshot();
  });
});

describe('summarizeConversation', () => {
  test('truncates long messages', () => {
    const msgs: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: 'a'.repeat(500) },
      { role: 'assistant', content: 'short reply' },
    ];
    expect(summarizeConversation(msgs)).toMatchSnapshot();
  });
});
