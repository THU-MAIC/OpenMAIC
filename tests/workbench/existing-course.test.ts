import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createWorkbenchSession, postWorkbenchMessage } = vi.hoisted(() => ({
  createWorkbenchSession: vi.fn(),
  postWorkbenchMessage: vi.fn(),
}));

vi.mock('@/lib/workbench/session-store', () => ({
  createWorkbenchSession,
  postWorkbenchMessage,
}));

import { openWorkbenchForExistingCourse } from '@/lib/workbench/existing-course';
import { startConversationWithFirstMessage } from '@/lib/workbench/first-message-session';

describe('openWorkbenchForExistingCourse', () => {
  beforeEach(() => {
    createWorkbenchSession.mockReset();
  });

  it('mints an idle session named by what the caller asked, not by the course', async () => {
    createWorkbenchSession.mockResolvedValue({
      id: 'session-1',
      stageId: 'stage-1',
      status: 'succeeded',
    });

    await expect(
      openWorkbenchForExistingCourse({ stageId: 'stage-1', prompt: '把第三页换个例子' }),
    ).resolves.toMatchObject({ id: 'session-1' });

    expect(createWorkbenchSession).toHaveBeenCalledWith({
      prompt: '把第三页换个例子',
      stageId: 'stage-1',
      // Load-bearing: it is what keeps the row idle and skips run admission, so
      // acquiring a conversation is never billed as a generation.
      existingCourse: true,
    });
  });
});

describe('startConversationWithFirstMessage', () => {
  beforeEach(() => {
    createWorkbenchSession.mockReset();
    postWorkbenchMessage.mockReset();
  });

  it('mints the session, then delivers the message through the ordinary path', async () => {
    const create = vi.fn(async () => ({
      id: 'session-1',
      stageId: 'stage-1',
      status: 'succeeded' as const,
      prompt: '把第三页换个例子',
    }));
    const post = vi.fn(async () => ({ elementRefsAccepted: true, courseRefsAccepted: true }));
    const material = { materialId: 'mat-1', name: 'a.pdf', bytes: 1 };
    const elementRef = {
      kind: 'slide-element' as const,
      stageId: 'stage-1',
      sceneId: 'scene-1',
      elementId: 'title-1',
      elementType: 'text',
      label: '文本',
    };
    const courseRef = { kind: 'course' as const, stageId: 'stage-1', title: '光的折射' };

    const result = await startConversationWithFirstMessage(
      {
        stageId: 'stage-1',
        text: '把第三页换个例子',
        materials: [material],
        elementRefs: [elementRef],
        courseRefs: [courseRef],
      },
      { create, post },
    );

    expect(create).toHaveBeenCalledWith({ stageId: 'stage-1', prompt: '把第三页换个例子' });
    // The refs and the materials go on the MESSAGE: the creation endpoint carries
    // neither, which is why the first message is an ordinary message.
    expect(post).toHaveBeenCalledWith(
      'session-1',
      '把第三页换个例子',
      [material],
      [elementRef],
      [courseRef],
    );
    expect(result).toEqual({
      sessionId: 'session-1',
      elementRefsAccepted: true,
      courseRefsAccepted: true,
    });
  });

  it('names the conversation after the first message, so nothing is titled by its course', async () => {
    const create = vi.fn(async () => ({
      id: 'session-1',
      stageId: 'stage-1',
      status: 'succeeded' as const,
      prompt: '',
    }));
    const post = vi.fn(async () => ({ elementRefsAccepted: false, courseRefsAccepted: false }));

    await startConversationWithFirstMessage(
      { stageId: 'stage-1', text: '帮我把结尾改得更短' },
      { create, post },
    );

    expect(create).toHaveBeenCalledWith({ stageId: 'stage-1', prompt: '帮我把结尾改得更短' });
    expect(post).toHaveBeenCalledWith('session-1', '帮我把结尾改得更短', [], [], []);
  });

  it('does not post when the session could not be created', async () => {
    const create = vi.fn(async () => {
      throw new Error('nope');
    });
    const post = vi.fn();

    await expect(
      startConversationWithFirstMessage({ stageId: 'stage-1', text: 'hi' }, { create, post }),
    ).rejects.toThrow('nope');
    expect(post).not.toHaveBeenCalled();
  });
});
