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
  assistantAgent,
  slideStoreState,
  quizStoreState,
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

  test('teacher / slide scene with whiteboard open (mutual-exclusion warning)', () => {
    const wbState: StatelessChatRequest['storeState'] = {
      ...slideStoreState,
      whiteboardOpen: true,
    };
    const out = buildStructuredPrompt(teacherAgent, wbState);
    expect(out).toMatchSnapshot();
  });

  test('teacher / quiz scene (spotlight/laser stripped)', () => {
    const out = buildStructuredPrompt(teacherAgent, quizStoreState);
    expect(out).toMatchSnapshot();
  });

  test('assistant / slide scene', () => {
    const out = buildStructuredPrompt(assistantAgent, slideStoreState);
    expect(out).toMatchSnapshot();
  });
});

describe('convertMessagesToOpenAI', () => {
  const baseMessages: StatelessChatRequest['messages'] = [
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

  test('same-agent assistant message stays as assistant role', () => {
    // currentAgentId matches message's agentId — cross-agent branch is NOT taken
    expect(convertMessagesToOpenAI(baseMessages, 'teacher_1')).toMatchSnapshot();
  });

  test('cross-agent assistant message converts to user role with name prefix', () => {
    // currentAgentId differs from message's agentId — triggers role conversion
    expect(convertMessagesToOpenAI(baseMessages, 'student_1')).toMatchSnapshot();
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
