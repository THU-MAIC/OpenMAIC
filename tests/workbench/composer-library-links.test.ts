// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchMaterial } from '@/lib/workbench/session-store';
const mocks = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    locale: 'en-US',
    t: (key: string, values?: unknown) => `${key}${values ? JSON.stringify(values) : ''}`,
  }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/workbench/session-store', async (actual) => ({
  ...(await actual<object>()),
  uploadWorkbenchMaterial: mocks.upload,
}));
import {
  StoredMaterialNotice,
  useComposerMaterials,
  type ComposerMaterials,
} from '@/components/workbench/compose-extras';
let root: Root;
let host: HTMLDivElement;
let materials: ComposerMaterials;
const onView = vi.fn();
function Composer() {
  const current = useComposerMaterials();
  useEffect(() => {
    materials = current;
  });
  return createElement(StoredMaterialNotice, {
    materialIds: current.uploadedMaterialIds,
    onView,
  });
}
const stored = (id: string): WorkbenchMaterial => ({ materialId: id, name: `${id}.pdf`, bytes: 1 });
const file = (id: string) => new File(['x'], `${id}.pdf`, { type: 'application/pdf' });
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ enabled: true })),
  );
  mocks.upload.mockReset();
  onView.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Composer)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('stored upload receipt (#1924)', () => {
  it('counts only successful uploads, can view before parsing, and shrinks with removals', async () => {
    mocks.upload.mockImplementation(async (f: File) => {
      if (f.name === 'bad.pdf') throw new Error('unsupported');
      return stored(f.name);
    });
    await act(async () => {
      materials.addFiles([file('a'), file('bad'), file('b')]);
    });
    expect(materials.failed).toHaveLength(1);
    expect(materials.uploadedMaterialIds).toEqual(['a.pdf', 'b.pdf']);
    expect(host.textContent).toContain('"count":2');
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(onView).toHaveBeenCalledExactlyOnceWith({
      kind: 'materials',
      materialIds: ['a.pdf', 'b.pdf'],
    });
    await act(async () => materials.remove('a.pdf'));
    expect(host.textContent).toContain('"count":1');
    await act(async () => materials.removeSent(materials.materials));
    expect(host.textContent).toBe('');
  });
  it('does not claim library picks or failures as uploads', async () => {
    mocks.upload.mockRejectedValue(new Error('unsupported'));
    await act(async () => {
      materials.addExisting(stored('picked'));
      materials.addFiles([file('bad')]);
    });
    expect(materials.materials).toHaveLength(1);
    expect(materials.failed).toHaveLength(1);
    expect(host.textContent).toBe('');
  });
  it('does not count a late success in a different draft', async () => {
    const upload = deferred<WorkbenchMaterial>();
    mocks.upload.mockReturnValue(upload.promise);
    await act(async () => materials.addFiles([file('old')]));
    await act(async () => materials.startOver());
    await act(async () => upload.resolve(stored('old')));
    expect(materials.uploadedMaterialIds).toEqual([]);
    expect(host.textContent).toBe('');
  });
  it('clears uploaded provenance so a later library selection is not a new upload', async () => {
    mocks.upload.mockResolvedValue(stored('a'));
    await act(async () => materials.addFiles([file('a')]));
    await act(async () => materials.clear());
    await act(async () => materials.addExisting(stored('a')));
    expect(materials.uploadedMaterialIds).toEqual([]);
    expect(host.textContent).toBe('');
  });
});
