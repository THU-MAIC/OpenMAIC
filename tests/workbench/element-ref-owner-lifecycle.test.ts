// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import {
  useElementRefsForSession,
  useElementRefsOwnerLifecycle,
  useElementRefsStore,
} from '@/lib/store/element-refs';
import type { ElementRef } from '@/lib/workbench/element-refs';

const elementRef: ElementRef = {
  kind: 'slide-element',
  stageId: 'stage-1',
  sceneId: 'scene-1',
  elementId: 'title-1',
  elementType: 'text',
  label: '会话 A 的标题',
};

function ChatOwner({ sessionId }: { sessionId: string | null }) {
  useElementRefsOwnerLifecycle(sessionId);
  const refs = useElementRefsForSession(sessionId);
  return createElement('div', { 'data-testid': 'chat', 'data-ref-count': refs.length });
}

function AuxiliaryConsumer({ sessionId }: { sessionId: string | null }) {
  const refs = useElementRefsForSession(sessionId);
  return createElement('div', { 'data-testid': 'aux', 'data-ref-count': refs.length });
}

let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  useElementRefsStore.setState({
    ownerSessionId: null,
    refs: [],
    hovered: null,
    nextGeneration: 1,
  });
  document.body.innerHTML = '';
});

describe('element ref chat owner lifecycle', () => {
  it('keeps the draft across auxiliary consumer mount lifecycles and StrictMode probes', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () =>
      root?.render(
        createElement(
          'div',
          null,
          createElement(ChatOwner, { key: 'chat', sessionId: 'session-a' }),
        ),
      ),
    );
    await act(async () => useElementRefsStore.getState().add(elementRef));
    const draftCounts = [useElementRefsStore.getState().refs.length];

    await act(async () =>
      root?.render(
        createElement('div', null, [
          createElement(ChatOwner, { key: 'chat', sessionId: 'session-a' }),
          createElement(AuxiliaryConsumer, { key: 'aux', sessionId: 'session-a' }),
        ]),
      ),
    );
    draftCounts.push(useElementRefsStore.getState().refs.length);

    await act(async () =>
      root?.render(
        createElement(
          'div',
          null,
          createElement(ChatOwner, { key: 'chat', sessionId: 'session-a' }),
        ),
      ),
    );
    draftCounts.push(useElementRefsStore.getState().refs.length);

    await act(async () =>
      root?.render(
        createElement('div', null, [
          createElement(ChatOwner, { key: 'chat', sessionId: 'session-a' }),
          createElement(
            StrictMode,
            { key: 'strict-aux' },
            createElement(AuxiliaryConsumer, { sessionId: 'session-a' }),
          ),
        ]),
      ),
    );
    draftCounts.push(useElementRefsStore.getState().refs.length);

    expect(draftCounts).toEqual([1, 1, 1, 1]);
    expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-ref-count')).toBe('1');
    expect(host.querySelector('[data-testid="aux"]')?.getAttribute('data-ref-count')).toBe('1');
  });

  it('clears the draft across A -> empty -> A so it cannot revive', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => root?.render(createElement(ChatOwner, { sessionId: 'session-a' })));
    await act(async () => useElementRefsStore.getState().add(elementRef));
    expect(useElementRefsStore.getState().refs).toHaveLength(1);

    await act(async () => root?.render(createElement(ChatOwner, { sessionId: null })));
    expect(useElementRefsStore.getState()).toMatchObject({ ownerSessionId: null, refs: [] });

    await act(async () => root?.render(createElement(ChatOwner, { sessionId: 'session-a' })));
    expect(useElementRefsStore.getState()).toMatchObject({
      ownerSessionId: 'session-a',
      refs: [],
    });
    expect(host.firstElementChild?.getAttribute('data-ref-count')).toBe('0');
  });
});
