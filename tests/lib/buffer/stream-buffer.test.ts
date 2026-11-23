import { describe, expect, it } from 'vitest';
import { StreamBuffer } from '@/lib/buffer/stream-buffer';

describe('StreamBuffer Pi wrap-up ordering', () => {
  it.each(['drain', 'flush'] as const)(
    'propagates cue prompt/options after the last visible turn via %s',
    async (mode) => {
      const lifecycle: string[] = [];
      const cues: unknown[] = [];
      const prompt = 'Which example should we try?';
      const options = ['Show an example', 'Let me practice', 'Back to the lesson'];
      const buffer = new StreamBuffer(
        {
          onAgentStart() {},
          onAgentEnd() {},
          onTextReveal(_messageId, _partId, text, complete) {
            if (complete) lifecycle.push(text);
          },
          onActionReady() {},
          onLiveSpeech() {},
          onSpeechProgress() {},
          onThinking() {},
          onCueUser(...cue) {
            cues.push(cue);
            lifecycle.push('cue');
          },
          onDone() {
            lifecycle.push('done');
          },
          onError(message) {
            throw new Error(message);
          },
        },
        { tickMs: 1, charsPerTick: 100 },
      );
      buffer.pushAgentStart({ messageId: 'answer', agentId: 'teacher-1', agentName: 'Teacher' });
      buffer.pushText('answer', prompt);
      buffer.pushAgentEnd({ messageId: 'answer', agentId: 'teacher-1' });
      buffer.pushCueUser({ fromAgentId: 'teacher-1', prompt, options });
      buffer.pushDone({ totalAgents: 1, totalActions: 0, cueUserReceived: true });
      if (mode === 'flush') await buffer.flush();
      else {
        buffer.start();
        await buffer.waitUntilDrained();
      }
      expect(cues).toEqual([['teacher-1', prompt, options]]);
      expect(lifecycle).toEqual([prompt, 'cue', 'done']);
      buffer.shutdown();
    },
  );

  it('resolves immediately when done was processed before the drain waiter was registered', async () => {
    const lifecycle: string[] = [];
    const buffer = new StreamBuffer({
      onAgentStart() {},
      onAgentEnd() {},
      onTextReveal() {},
      onActionReady() {},
      onLiveSpeech() {},
      onSpeechProgress() {},
      onThinking() {},
      onCueUser() {},
      onDone() {
        lifecycle.push('done');
      },
      onError(message) {
        throw new Error(message);
      },
    });

    buffer.pushDone({ totalActions: 0, totalAgents: 0 });
    buffer.flush();

    await expect(buffer.waitUntilDrained()).resolves.toBeUndefined();
    expect(lifecycle).toEqual(['done']);
  });

  it('reveals teacher wrap-up text before done can trigger soft-closing', async () => {
    const visibleTexts: string[] = [];
    const lifecycle: string[] = [];
    const donePayloads: unknown[] = [];
    const buffer = new StreamBuffer(
      {
        onAgentStart(data) {
          lifecycle.push(`start:${data.agentId}`);
        },
        onAgentEnd(data) {
          lifecycle.push(`end:${data.agentId}`);
        },
        onTextReveal(_messageId, _partId, revealedText, isComplete) {
          if (isComplete) visibleTexts.push(revealedText);
        },
        onActionReady() {},
        onLiveSpeech() {},
        onSpeechProgress() {},
        onThinking() {},
        onCueUser() {},
        onDone(data) {
          lifecycle.push('done');
          donePayloads.push(data);
        },
        onError(message) {
          throw new Error(message);
        },
      },
      { tickMs: 1, charsPerTick: 100 },
    );

    buffer.pushAgentStart({
      messageId: 'wrap-up-message',
      agentId: 'teacher-1',
      agentName: 'AI teacher',
    });
    buffer.pushText('wrap-up-message', '总结一下：树荫通过减少直射辐射，让地面少吸热。');
    buffer.pushAgentEnd({ messageId: 'wrap-up-message', agentId: 'teacher-1' });
    buffer.pushDone({
      totalActions: 0,
      totalAgents: 1,
      agentHadContent: true,
      cueUserReceived: false,
      sessionClosed: true,
      endReason: 'user_done',
    });

    buffer.start();
    await buffer.waitUntilDrained();

    expect(visibleTexts).toEqual(['总结一下：树荫通过减少直射辐射，让地面少吸热。']);
    expect(lifecycle).toEqual(['start:teacher-1', 'end:teacher-1', 'done']);
    expect(donePayloads).toEqual([
      expect.objectContaining({ sessionClosed: true, endReason: 'user_done' }),
    ]);
  });

  it('waits for each action to complete before starting the next queued action', async () => {
    const lifecycle: string[] = [];
    let resolveClear: (() => void) | undefined;
    const clearCompleted = new Promise<void>((resolve) => {
      resolveClear = resolve;
    });
    const buffer = new StreamBuffer(
      {
        onAgentStart() {},
        onAgentEnd() {},
        onTextReveal() {},
        onActionReady(_messageId, action) {
          lifecycle.push(`start:${action.actionName}`);
          if (action.actionName === 'wb_clear') {
            return clearCompleted.then(() => {
              lifecycle.push('finish:wb_clear');
            });
          }
          lifecycle.push(`finish:${action.actionName}`);
        },
        onLiveSpeech() {},
        onSpeechProgress() {},
        onThinking() {},
        onCueUser() {},
        onDone() {
          lifecycle.push('done');
        },
        onError(message) {
          throw new Error(message);
        },
      },
      { tickMs: 1, actionDelayMs: 0 },
    );

    buffer.pushAction({
      messageId: 'message-1',
      actionId: 'clear-1',
      actionName: 'wb_clear',
      params: {},
      agentId: 'teacher-1',
    });
    buffer.pushAction({
      messageId: 'message-1',
      actionId: 'draw-1',
      actionName: 'wb_draw_text',
      params: { content: 'new content' },
      agentId: 'teacher-1',
    });
    buffer.pushDone({ totalActions: 2, totalAgents: 1 });
    buffer.start();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lifecycle).toEqual(['start:wb_clear']);

    resolveClear?.();
    await buffer.waitUntilDrained();

    expect(lifecycle).toEqual([
      'start:wb_clear',
      'finish:wb_clear',
      'start:wb_draw_text',
      'finish:wb_draw_text',
      'done',
    ]);
  });

  it('waits for an in-flight action before flushing later actions and done', async () => {
    const lifecycle: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstCompleted = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const buffer = new StreamBuffer(
      {
        onAgentStart() {},
        onAgentEnd() {},
        onTextReveal() {},
        onActionReady(_messageId, action) {
          lifecycle.push(`start:${action.actionId}`);
          if (action.actionId === 'first') {
            return firstCompleted.then(() => {
              lifecycle.push('finish:first');
            });
          }
          lifecycle.push(`finish:${action.actionId}`);
        },
        onLiveSpeech() {},
        onSpeechProgress() {},
        onThinking() {},
        onCueUser() {},
        onDone() {
          lifecycle.push('done');
        },
        onError(message) {
          throw new Error(message);
        },
      },
      { tickMs: 1, actionDelayMs: 0 },
    );

    buffer.pushAction({
      messageId: 'message-1',
      actionId: 'first',
      actionName: 'wb_clear',
      params: {},
      agentId: 'teacher-1',
    });
    buffer.pushAction({
      messageId: 'message-1',
      actionId: 'second',
      actionName: 'wb_draw_text',
      params: { content: 'new content' },
      agentId: 'teacher-1',
    });
    buffer.pushDone({ totalActions: 2, totalAgents: 1 });
    buffer.start();

    await new Promise((resolve) => setTimeout(resolve, 10));
    const flushing = buffer.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lifecycle).toEqual(['start:first']);

    resolveFirst?.();
    await flushing;
    await buffer.waitUntilDrained();

    expect(lifecycle).toEqual([
      'start:first',
      'finish:first',
      'start:second',
      'finish:second',
      'done',
    ]);
  });

  it('coalesces concurrent flush calls so each action executes once', async () => {
    const lifecycle: string[] = [];
    let resolveAction: (() => void) | undefined;
    const actionCompleted = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    const buffer = new StreamBuffer({
      onAgentStart() {},
      onAgentEnd() {},
      onTextReveal() {},
      onActionReady() {
        lifecycle.push('action');
        return actionCompleted;
      },
      onLiveSpeech() {},
      onSpeechProgress() {},
      onThinking() {},
      onCueUser() {},
      onDone() {
        lifecycle.push('done');
      },
      onError(message) {
        throw new Error(message);
      },
    });
    buffer.pushAction({
      messageId: 'message-1',
      actionId: 'action-1',
      actionName: 'wb_clear',
      params: {},
      agentId: 'teacher-1',
    });
    buffer.pushDone({ totalActions: 1, totalAgents: 1 });

    const firstFlush = buffer.flush();
    const secondFlush = buffer.flush();
    expect(secondFlush).toBe(firstFlush);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lifecycle).toEqual(['action']);

    let actionSettled = false;
    const actionSettlement = buffer.waitForCurrentAction().then(() => {
      actionSettled = true;
    });
    await Promise.resolve();
    expect(actionSettled).toBe(false);

    resolveAction?.();
    await Promise.all([firstFlush, secondFlush, actionSettlement]);
    expect(actionSettled).toBe(true);
    expect(lifecycle).toEqual(['action', 'done']);
  });

  it('stops flush callbacks after shutdown during an awaited action', async () => {
    const lifecycle: string[] = [];
    let resolveAction: (() => void) | undefined;
    const actionCompleted = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    const buffer = new StreamBuffer({
      onAgentStart() {},
      onAgentEnd() {},
      onTextReveal() {},
      onActionReady() {
        lifecycle.push('action');
        return actionCompleted;
      },
      onLiveSpeech() {
        lifecycle.push('speech');
      },
      onSpeechProgress() {},
      onThinking() {},
      onCueUser() {},
      onDone() {
        lifecycle.push('done');
      },
      onError(message) {
        throw new Error(message);
      },
    });
    buffer.pushAction({
      messageId: 'message-1',
      actionId: 'action-1',
      actionName: 'wb_clear',
      params: {},
      agentId: 'teacher-1',
    });
    buffer.pushDone({ totalActions: 1, totalAgents: 1 });

    const flushing = buffer.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    let actionSettled = false;
    const actionSettlement = buffer.waitForCurrentAction().then(() => {
      actionSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actionSettled).toBe(false);
    buffer.shutdown();
    resolveAction?.();
    await Promise.all([flushing, actionSettlement]);

    expect(lifecycle).toEqual(['action']);
  });

  it('aborts background action work when the buffer shuts down', async () => {
    let actionSignal: AbortSignal | undefined;
    const buffer = new StreamBuffer(
      {
        onAgentStart() {},
        onAgentEnd() {},
        onTextReveal() {},
        onActionReady(_messageId, _action, signal) {
          actionSignal = signal;
        },
        onLiveSpeech() {},
        onSpeechProgress() {},
        onThinking() {},
        onCueUser() {},
        onDone() {},
        onError(message) {
          throw new Error(message);
        },
      },
      { tickMs: 1 },
    );
    buffer.pushAction({
      messageId: 'message-1',
      actionId: 'video-1',
      actionName: 'play_video',
      params: { elementId: 'video-element-1' },
      agentId: 'teacher-1',
    });
    buffer.start();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(actionSignal?.aborted).toBe(false);
    buffer.shutdown();
    expect(actionSignal?.aborted).toBe(true);
  });
});

describe('StreamBuffer speech segments', () => {
  type Sealed = { messageId: string; partId: string; text: string; agentId: string | null };

  function createBuffer(sealed: Sealed[], speakers: Array<string | null> = []) {
    return new StreamBuffer(
      {
        onAgentStart() {},
        onAgentEnd() {},
        onTextReveal() {},
        onActionReady() {},
        onLiveSpeech(text, agentId) {
          if (text) speakers.push(agentId);
        },
        onSpeechProgress() {},
        onThinking() {},
        onCueUser() {},
        onDone() {},
        onError(message) {
          throw new Error(message);
        },
        onSegmentSealed(messageId, partId, text, agentId) {
          sealed.push({ messageId, partId, text, agentId });
        },
      },
      { tickMs: 1, charsPerTick: 100 },
    );
  }

  it('ends a segment at sealSegment and starts a new part for the same message', () => {
    const sealed: Sealed[] = [];
    const buffer = createBuffer(sealed);
    buffer.pushAgentStart({ messageId: 'm1', agentId: 'teacher', agentName: 'Teacher' });
    buffer.pushText('m1', 'First we draw the axes.');
    buffer.sealSegment();
    buffer.sealSegment();
    buffer.pushText('m1', 'Then the curve.');
    buffer.pushAgentEnd({ messageId: 'm1', agentId: 'teacher' });

    expect(sealed).toEqual([
      { messageId: 'm1', partId: 'p0', text: 'First we draw the axes.', agentId: 'teacher' },
      { messageId: 'm1', partId: 'p1', text: 'Then the curve.', agentId: 'teacher' },
    ]);
    buffer.shutdown();
  });

  it('does nothing after shutdown', () => {
    const sealed: Sealed[] = [];
    const buffer = createBuffer(sealed);
    buffer.pushAgentStart({ messageId: 'm1', agentId: 'teacher', agentName: 'Teacher' });
    buffer.pushText('m1', 'Unfinished');
    buffer.shutdown();
    buffer.sealSegment();
    expect(sealed).toEqual([]);
  });

  it('seals each segment with the speaker who said it while the playhead lags behind', async () => {
    const sealed: Sealed[] = [];
    const speakers: Array<string | null> = [];
    const buffer = createBuffer(sealed, speakers);
    // Both agents stream before the playhead has processed anything.
    buffer.pushAgentStart({ messageId: 'a', agentId: 'teacher', agentName: 'Teacher' });
    buffer.pushText('a', 'Teacher line.');
    buffer.pushAgentEnd({ messageId: 'a', agentId: 'teacher' });
    buffer.pushAgentStart({ messageId: 'b', agentId: 'student', agentName: 'Student' });
    buffer.pushText('b', 'Student line before a drawing.');
    buffer.sealSegment();
    buffer.pushText('b', 'Student line after it.');
    buffer.pushAgentEnd({ messageId: 'b', agentId: 'student' });

    expect(sealed.map((s) => [s.text, s.agentId])).toEqual([
      ['Teacher line.', 'teacher'],
      ['Student line before a drawing.', 'student'],
      ['Student line after it.', 'student'],
    ]);

    // The bubble still follows the playhead.
    await buffer.flush();
    expect(speakers[0]).toBe('teacher');
    expect(speakers.at(-1)).toBe('student');
  });
});
