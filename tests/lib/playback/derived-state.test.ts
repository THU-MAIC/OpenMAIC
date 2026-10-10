import { describe, expect, it } from 'vitest';
import { computePlaybackView, type PlaybackRawState } from '@/lib/playback/derived-state';

const parked: PlaybackRawState = {
  engineMode: 'idle',
  lectureSpeech: 'Old lecture text',
  liveSpeech: null,
  speakingAgentId: null,
  thinkingState: null,
  isCueUser: true,
  isTopicPending: false,
  chatIsStreaming: false,
  discussionTrigger: null,
  playbackCompleted: false,
  idleText: 'Lecture introduction',
  speakingStudent: false,
  sessionType: 'qa',
};

describe('parked learner playback view', () => {
  it.each(['qa', 'discussion', null])('owns the user bubble after reload (%s)', (sessionType) => {
    expect(computePlaybackView({ ...parked, sessionType })).toMatchObject({
      phase: 'cueUser',
      bubbleRole: 'user',
      activeRole: 'user',
      sourceText: '',
      buttonState: 'none',
      isTopicActive: true,
    });
  });

  it('lets the last visible agent finish before switching ownership', () => {
    expect(
      computePlaybackView({ ...parked, liveSpeech: 'Which example?', speakingAgentId: 'teacher' }),
    ).toMatchObject({ bubbleRole: 'teacher', sourceText: 'Which example?' });
  });
});
