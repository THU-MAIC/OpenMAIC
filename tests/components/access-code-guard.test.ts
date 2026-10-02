// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const modal = vi.hoisted(() => ({ onSuccess: null as null | (() => void) }));
vi.mock('@/components/access-code-modal', () => ({
  AccessCodeModal: ({ onSuccess }: { onSuccess: () => void }) => {
    modal.onSuccess = onSuccess;
    return null;
  },
}));
vi.mock('@/components/model-settings-init', () => ({ importLegacyModelSettings: vi.fn() }));
vi.mock('@/lib/model-settings/client', () => ({ modelSettingsClient: { load: vi.fn() } }));
vi.mock('@/lib/orchestration/registry/store', () => ({ reloadAgentRegistry: vi.fn() }));

import { AccessCodeGuard } from '@/components/access-code-guard';

let host: HTMLDivElement;
beforeEach(() => {
  modal.onSuccess = null;
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  host.remove();
  vi.unstubAllGlobals();
});

function stubStatus(body: { enabled: boolean; authenticated: boolean }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body))),
  );
}

/** Counts mounts: each mount is one round of the page's on-mount requests. */
function renderGuardedPage() {
  const mounts = { count: 0 };
  function Page() {
    useEffect(() => {
      mounts.count += 1;
    }, []);
    return null;
  }
  const root = createRoot(host);
  return {
    root,
    mounts,
    render: () => root.render(createElement(AccessCodeGuard, null, createElement(Page))),
  };
}

it('mounts the page again once the access code is accepted, so its requests are resent', async () => {
  stubStatus({ enabled: true, authenticated: false });
  const { root, mounts, render } = renderGuardedPage();
  await act(async () => render());
  expect(mounts.count).toBe(1);
  expect(modal.onSuccess).not.toBeNull();

  await act(async () => modal.onSuccess!());
  expect(mounts.count).toBe(2);
  await act(async () => root.unmount());
});

it('mounts the page once when no access code is required', async () => {
  stubStatus({ enabled: false, authenticated: false });
  const { root, mounts, render } = renderGuardedPage();
  await act(async () => render());
  expect(mounts.count).toBe(1);
  expect(modal.onSuccess).toBeNull();
  await act(async () => root.unmount());
});
