import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ enabled: false }));
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((href: string) => {
    throw new Error(`redirect:${href}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('not-found');
  }),
}));

vi.mock('next/navigation', () => navigation);
vi.mock('@/lib/workbench/entry-gate', () => ({
  isWorkbenchEntryEnabled: () => state.enabled,
}));
vi.mock('@/components/workbench/WorkspaceEntry', () => ({
  WorkspaceEntry: () => null,
}));
vi.mock('@/app/workbench/new/client', () => ({
  WorkbenchLaunchBridge: () => null,
}));

import WorkbenchNewCompatibilityPage from '@/app/workbench/new/page';
import WorkspacePage from '@/app/workspace/page';

describe('workbench entry routes', () => {
  beforeEach(() => {
    state.enabled = false;
    navigation.redirect.mockClear();
    navigation.notFound.mockClear();
  });

  it('redirects the workspace home instead of rendering a broken shell when disabled', () => {
    expect(() => WorkspacePage()).toThrow('redirect:/');
    expect(navigation.redirect).toHaveBeenCalledWith('/');
  });

  it('does not expose the legacy launch bridge when disabled', () => {
    expect(() => WorkbenchNewCompatibilityPage()).toThrow('not-found');
    expect(navigation.notFound).toHaveBeenCalledOnce();
  });

  it('renders both entry routes when the shared gate is enabled', () => {
    state.enabled = true;
    expect(WorkspacePage()).toBeTruthy();
    expect(WorkbenchNewCompatibilityPage()).toBeTruthy();
    expect(navigation.redirect).not.toHaveBeenCalled();
    expect(navigation.notFound).not.toHaveBeenCalled();
  });
});
