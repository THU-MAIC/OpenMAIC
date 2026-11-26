import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { spokenHandoffClosing } from '@/lib/server/pbl-v3/review-question';
import { withTeachingTurnBoundary } from '@/lib/server/pbl-v3/runner-tools';

vi.mock('server-only', () => ({}));

function frame(timestamp: number, words: string, tool: string, args = {}): AssistantMessage {
  return {
    role: 'assistant',
    stopReason: 'toolUse',
    timestamp,
    content: [
      ...(words ? [{ type: 'text' as const, text: words }] : []),
      { type: 'toolCall', name: tool, id: String(timestamp), arguments: args },
    ],
  } as AssistantMessage;
}

function stop(timestamp: number, words: string): AssistantMessage {
  return {
    role: 'assistant',
    stopReason: 'stop',
    timestamp,
    content: [{ type: 'text', text: words }],
  } as AssistantMessage;
}

async function recoverMessage(given: string, message: AssistantMessage) {
  const boundary = withTeachingTurnBoundary(
    () => {
      const response = createAssistantMessageEventStream();
      response.push({
        type: 'done',
        reason: message.stopReason === 'stop' ? 'stop' : 'toolUse',
        message,
      });
      return response;
    },
    () => false,
    { stageKey: 'intro:0', studentTurns: 1, spokenReview: true, recoverySpeech: [given] },
  );
  const stream = await boundary({} as Parameters<StreamFn>[0], { messages: [] });
  return stream.result();
}

it.each([
  ['The value is 4', 'The value is 42.', 'The value is 42.'],
  ['Save', 'Saved automatically.', 'Saved automatically.'],
  ['看这里。', '看这里。最后看返回值。', '最后看返回值。'],
  ['Open the files.', 'Open the files. Check the second file.', 'Check the second file.'],
  [
    'Shared heading\n\nOld details.',
    'Shared heading\n\nNew details.',
    'Shared heading\n\nNew details.',
  ],
  [
    'Which file are you editing?\n\nThat was an example of a diagnostic question.',
    'Which file are you editing?',
    'Which file are you editing?',
  ],
])(
  'preserves new words in a missing clarification or another prose stop (%s)',
  async (given, next, expected) => {
    for (const message of [
      stop(2, next),
      frame(2, next, 'respond_to_learner'),
      frame(2, next, 'respond_to_learner', { deliverMissing: true }),
    ]) {
      expect((await recoverMessage(given, message)).content).toEqual([
        { type: 'text', text: expected },
        ...message.content.filter((part) => part.type === 'toolCall'),
      ]);
    }
  },
);

it.each(['respond_to_learner', 'request_learner_help'])(
  'publishes missing words once in the normal speech channel when recovering %s',
  async (tool) => {
    const original = 'Open the files.';
    const hint = 'Inspect the second file for the return value.';
    for (const [prose, remainingSpeech, expected] of [
      ['', '', ''],
      ['', original, ''],
      ['', hint, hint],
      [hint, hint, hint],
      [original, hint, hint],
      [hint, '', hint],
      [hint, original + ' ' + hint, hint],
      [original + ' ' + hint, hint, hint],
      [original + ' ' + hint, original + ' ' + hint, hint],
    ] as const) {
      const { content } = await recoverMessage(
        original,
        frame(2, prose, tool, { remainingSpeech }),
      );
      expect(content).toEqual([
        ...(expected ? [{ type: 'text', text: expected }] : []),
        { type: 'toolCall', id: '2', name: tool, arguments: {} },
      ]);
    }
  },
);

describe.each(['request_skill_review', 'respond_to_learner', 'request_learner_help'])(
  '%s',
  (tool) => {
    it.each([
      'wb_draw_text',
      'wb_close',
      'point_at_code',
      'point_at_preview',
      'set_response_language',
    ])('keeps the source across %s', (action) => {
      const speech = spokenHandoffClosing();
      speech.observe(frame(10, 'Look at the return value.', 'wb_open'));
      speech.observe(frame(11, 'Include the first error and its filename.', action));
      speech.observe(frame(12, '', tool));
      expect(speech.forCall('12')).toEqual({
        question: 'Include the first error and its filename.',
        spokenAt: 11,
      });
    });

    it('keeps the whole last speech block for help and only the final question for review', () => {
      const speech = spokenHandoffClosing();
      const question = 'Which error was reported?';
      const block = 'Look in the build output.\n\n' + question;
      speech.observe(frame(10, 'First, check the status.', 'wb_open'));
      speech.observe(frame(11, block, 'wb_close'));
      speech.observe(frame(12, '', tool));
      expect(speech.forCall('12')).toEqual({
        question: tool === 'request_skill_review' ? question : block,
        spokenAt: 11,
      });
    });

    it('registers the spoken text when a language preference is saved in the same reply', () => {
      const speech = spokenHandoffClosing();
      const reply = frame(11, 'Open the project files.', tool);
      reply.content.unshift({
        type: 'toolCall',
        name: 'set_response_language',
        id: 'language',
        arguments: { locale: 'en' },
      });
      speech.observe(reply);
      expect(speech.forCall('11')).toEqual({ question: 'Open the project files.', spokenAt: 11 });
    });

    it.each(['read_file', 'write_file'])(
      'registers current speech alongside %s without carrying it across the result',
      (action) => {
        const speech = spokenHandoffClosing();
        speech.observe(stop(10, 'An earlier question.'));
        const reply = frame(11, 'Please check the return value.', tool);
        reply.content.splice(1, 0, {
          type: 'toolCall',
          name: action,
          id: 'file',
          arguments: { path: 'PLAN.md' },
        });
        speech.observe(reply);
        speech.observe({
          role: 'toolResult',
          toolName: action,
          toolCallId: 'file',
          timestamp: 12,
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        });
        expect(speech.forCall('11')).toEqual({
          question: 'Please check the return value.',
          spokenAt: 11,
        });
        expect(speech.recoverySpeech()).toBeUndefined();
        speech.observe(frame(13, '', tool));
        expect(speech.forCall('13')).toBeUndefined();
      },
    );

    it('pairs an exact recovery replay with its original delivery even when the same message reads a file', async () => {
      const given = 'Check the return value.';
      const mixed = (words: string) => {
        const reply = frame(12, words, tool);
        reply.content.unshift({
          type: 'toolCall',
          name: 'read_file',
          id: 'file',
          arguments: { path: 'PLAN.md' },
        });
        return reply;
      };
      const replay = await recoverMessage(given, mixed(given));
      expect(replay.content.filter((part) => part.type === 'text')).toEqual([]);
      const speech = spokenHandoffClosing();
      speech.observe(stop(11, given));
      speech.observe(JSON.parse(JSON.stringify(replay)));
      expect(speech.forCall('12')).toEqual({ question: given, spokenAt: 11 });
      speech.observe(frame(13, '', tool));
      expect(speech.forCall('13')).toBeUndefined();

      speech.observe(stop(11, given));
      speech.observe(await recoverMessage(given, mixed('')));
      expect(speech.forCall('12')).toBeUndefined();
      speech.observe(stop(11, given));
      speech.observe(frame(12, '', 'read_file'));
      speech.observe(replay);
      expect(speech.forCall('12')).toBeUndefined();
      speech.observe(stop(11, given));
      speech.observe({ role: 'user', content: 'A different request.', timestamp: 12 });
      speech.observe(replay);
      expect(speech.forCall('12')).toBeUndefined();
    });

    it('does not register words alongside a change of teaching section', () => {
      const speech = spokenHandoffClosing();
      const reply = frame(11, 'What do you think?', tool);
      reply.content.unshift({
        type: 'toolCall',
        name: 'read_next_skill',
        id: 'section',
        arguments: {},
      });
      speech.observe(reply);
      expect(speech.forCall('11')).toBeUndefined();
    });

    it('requires new speech after inspecting files or receiving a learner message', () => {
      const speech = spokenHandoffClosing();
      speech.observe(frame(11, 'Let me check.', 'read_file'));
      speech.observe(frame(12, '', tool));
      expect(speech.forCall('12')).toBeUndefined();
      speech.observe(frame(13, 'Please include its filename.', 'cue_user'));
      speech.observe({ role: 'user', content: 'Which file?', timestamp: 14 });
      speech.observe(frame(15, '', tool));
      expect(speech.forCall('15')).toBeUndefined();
    });

    it('rejects an empty call that claims to supply missing words', () => {
      const speech = spokenHandoffClosing();
      speech.observe(stop(10, 'Open the files.'));
      const flag = tool === 'request_skill_review' ? 'askNewQuestion' : 'deliverMissing';
      speech.observe(frame(11, '', tool, { [flag]: true }));
      expect(() => speech.forCall('11')).toThrow('Speak the missing');
    });
  },
);

describe('old assistance calls with a response parameter', () => {
  const first = 'Open the project files.';
  const last = 'Allowed edits save automatically.';
  const answer = first + '\n\n' + last;
  const respond = 'respond_to_learner';

  it.each(['paragraphs', 'blocks', 'messages'])(
    'accepts an exact copy of already delivered %s and keeps the original speaking position',
    (shape) => {
      const speech = spokenHandoffClosing();
      const reply = frame(12, shape === 'paragraphs' ? answer : last, 'wb_close');
      if (shape === 'blocks') reply.content.unshift({ type: 'text', text: first + '\n' });
      if (shape === 'messages') speech.observe(frame(11, first, 'wb_open'));
      speech.observe(reply);
      speech.observe(frame(13, '', respond, { response: answer }));
      expect(speech.forCall('13')).toEqual({
        question: shape === 'paragraphs' ? answer : last,
        spokenAt: 12,
      });
    },
  );

  it('rejects an unsaid instruction even when the supplied answer ends with the same words', () => {
    const speech = spokenHandoffClosing();
    speech.observe(frame(12, answer, 'wb_close'));
    speech.observe(
      frame(13, '', respond, { response: first + '\n\nCheck the preview.\n\n' + last }),
    );
    expect(() => speech.forCall('13')).toThrow('differs from the spoken closing');
    speech.observe(frame(14, '', respond, {}));
    expect(speech.forCall('14')).toEqual({ question: answer, spokenAt: 12 });
  });
});

it('tracks only the unfinished reply across display actions, with the same boundaries as registration', () => {
  const speech = spokenHandoffClosing();
  speech.observe(frame(10, 'Earlier explanation.', 'wb_open'));
  expect(speech.recoverySpeech()).toBeUndefined();

  speech.observe(stop(11, 'Open the project files.'));
  speech.observe(frame(12, 'Check the return line.', 'point_at_code'));
  speech.observe(stop(13, 'Keep the preview open.'));
  speech.observe(frame(14, '', 'set_response_language'));
  expect(speech.recoverySpeech()).toEqual([
    'Earlier explanation.',
    'Open the project files.',
    'Check the return line.',
    'Keep the preview open.',
  ]);

  speech.observe(frame(15, 'I will inspect it.', 'read_file'));
  expect(speech.recoverySpeech()).toBeUndefined();
  speech.observe(stop(16, 'Check the new result.'));
  speech.observe({ role: 'user', content: 'A new question', timestamp: 17 });
  expect(speech.recoverySpeech()).toBeUndefined();
});
