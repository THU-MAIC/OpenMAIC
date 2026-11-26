import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { spokenHandoffClosing } from '@/lib/server/pbl-v3/review-question';

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

describe.each(['request_skill_review', 'respond_to_learner', 'request_learner_help'])(
  '%s',
  (tool) => {
    it.each(['wb_draw_text', 'wb_close', 'point_at_code', 'point_at_preview'])(
      'keeps the source across %s',
      (action) => {
        const speech = spokenHandoffClosing();
        speech.observe(frame(10, 'Look at the return value.', 'wb_open'));
        speech.observe(frame(11, 'Include the first error and its filename.', action));
        speech.observe(frame(12, '', tool));
        expect(speech.forCall('12')).toEqual({
          question: 'Include the first error and its filename.',
          spokenAt: 11,
        });
      },
    );

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
  },
);
