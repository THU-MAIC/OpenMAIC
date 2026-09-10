import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { buildNativeSpotlightTool } from '@/lib/chat/pi/tools/native-spotlight';

const teacher: AgentConfig = {
  id: 'teacher-1',
  name: 'Teacher',
  role: 'teacher',
  persona: 'Teach clearly.',
  avatar: '',
  color: '#3366ff',
  allowedActions: ['spotlight'],
  priority: 10,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  isDefault: true,
};

describe('Native Spotlight', () => {
  it('dispatches the existing action SSE only for an exact authorized target', async () => {
    const send = vi.fn(async () => {});
    const tool = buildNativeSpotlightTool({
      agent: teacher,
      messageId: 'message-1',
      send,
      authorizedElementIds: new Set(['exact-element']),
    });

    const result = await tool.execute('call-1', {
      elementId: 'exact-element',
      dimOpacity: 0.4,
    });

    expect(send).toHaveBeenCalledWith({
      type: 'action',
      data: {
        actionId: expect.any(String),
        actionName: 'spotlight',
        params: { elementId: 'exact-element', dimOpacity: 0.4 },
        agentId: teacher.id,
        messageId: 'message-1',
      },
    });
    expect(result.details).toMatchObject({
      actionName: 'spotlight',
      dispatchedAction: true,
    });
  });

  it('rejects other-scene or guessed IDs in preflight and at the handler boundary', async () => {
    const send = vi.fn(async () => {});
    const tool = buildNativeSpotlightTool({
      agent: teacher,
      messageId: 'message-1',
      send,
      authorizedElementIds: new Set(['exact-element']),
    });

    expect(() => tool.prepareArguments?.({ elementId: 'other-element' })).toThrow('not authorized');
    await expect(tool.execute('call-1', { elementId: 'other-element' })).rejects.toThrow(
      'not authorized',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('does not report dispatch success after rejection or abort', async () => {
    const rejected = buildNativeSpotlightTool({
      agent: teacher,
      messageId: 'message-1',
      send: vi.fn(async () => {
        throw new Error('writer closed');
      }),
      authorizedElementIds: new Set(['exact-element']),
    });
    await expect(rejected.execute('call-1', { elementId: 'exact-element' })).rejects.toThrow(
      'writer closed',
    );

    let resolveSend!: () => void;
    const pendingSend = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const controller = new AbortController();
    const pending = buildNativeSpotlightTool({
      agent: teacher,
      messageId: 'message-1',
      send: () => pendingSend,
      authorizedElementIds: new Set(['exact-element']),
    }).execute('call-2', { elementId: 'exact-element' }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    resolveSend();
    await Promise.resolve();
  });
});
