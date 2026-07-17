import { describe, expect, it } from 'vitest';
import { StreamBuffer } from '@/lib/buffer/stream-buffer';

describe('StreamBuffer Pi wrap-up ordering', () => {
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
