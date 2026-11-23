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

// Any of the three context-budget copy keys that show the button.
const blocked: ChatNode = {
  key: 'e1',
  kind: 'system',
  tone: 'error',
  text: "This conversation is too long for the model's context limit",
  copyKey: 'workbench.system.contextStillTooLarge',
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
    expect(button).not.toBeNull();
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

  it('offers nothing on notices that are not a context-budget limit', async () => {
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

  it('offers the action for all three context-budget limit copy keys', async () => {
    const keys = [
      'workbench.system.contextSummaryFailed',
      'workbench.system.contextStillTooLarge',
      'workbench.system.contextNoBoundary',
    ] as const;
    for (const copyKey of keys) {
      useNewChatHost.getState().setStart(() => {});
      const container = await renderNode({
        key: 'e3',
        kind: 'system',
        tone: 'error',
        text: 'limit reached',
        copyKey,
      });
      expect(
        container.querySelector('[data-testid="workbench-system-new-chat"]'),
        `button missing for ${copyKey}`,
      ).not.toBeNull();
      if (dispose) {
        await dispose();
        dispose = null;
      }
    }
  });

  it('does not offer the action for the budget-invalid notice', async () => {
    useNewChatHost.getState().setStart(() => {});
    const container = await renderNode({
      key: 'e4',
      kind: 'system',
      tone: 'error',
      text: 'misconfigured budget',
      copyKey: 'workbench.system.contextBudgetInvalid',
    });

    expect(container.querySelector('[data-testid="workbench-system-new-chat"]')).toBeNull();
  });
});
