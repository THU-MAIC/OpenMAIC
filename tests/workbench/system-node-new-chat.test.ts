// @vitest-environment jsdom
/**
 * The blocked conversation's exit button. A static render cannot see it (the
 * host store's server snapshot holds no publisher), so this is the client
 * render: the button appears exactly while the workspace published a path,
 * and clicking it calls that path.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SystemNode } from '@/components/workbench/chat/system-node';
import { useNewChatHost } from '@/lib/workbench/new-chat-host';
import type { ChatNode } from '@/lib/workbench/session-store';

const blocked: ChatNode = {
  key: 'e1',
  kind: 'system',
  tone: 'error',
  text: '您已达到此会话的长度上限，可以开始新聊天以继续对话。',
  copyKey: 'workbench.system.contextLengthLimit',
};

let dispose: (() => Promise<void>) | null = null;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  useNewChatHost.getState().setStart(null);
  if (dispose) await dispose();
  dispose = null;
  vi.unstubAllGlobals();
});

async function renderNode(node: ChatNode): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  dispose = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await act(async () => {
    root.render(createElement(SystemNode, { node }));
  });
  return container;
}

describe('the context-limit notice offers the new chat', () => {
  it('renders the action and routes the click through the published path', async () => {
    const start = vi.fn();
    useNewChatHost.getState().setStart(start);
    const container = await renderNode(blocked);

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="workbench-system-new-chat"]',
    )!;
    expect(button.textContent).toContain('开始新聊天');
    await act(async () => {
      button.click();
    });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('renders no action while no conversation hosts the path', async () => {
    useNewChatHost.getState().setStart(null);
    const container = await renderNode(blocked);

    expect(container.querySelector('[data-testid="workbench-system-new-chat"]')).toBeNull();
    // The explanation itself is not hostage to the action.
    expect(container.querySelector('[data-testid="workbench-system-node"]')).not.toBeNull();
  });

  it('offers nothing on notices that are not the conversation-length limit', async () => {
    useNewChatHost.getState().setStart(() => {});
    const container = await renderNode({
      key: 'e2',
      kind: 'system',
      tone: 'error',
      text: '本轮生成失败',
      hint: '可以再说一句让它重试',
    });

    expect(container.querySelector('[data-testid="workbench-system-new-chat"]')).toBeNull();
  });
});
