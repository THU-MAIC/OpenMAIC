// @vitest-environment jsdom
import { act, createElement, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import enUS from '@/lib/i18n/locales/en-US.json';
import { useCourseMaterialCapabilities } from '@/lib/generation-run-client/use-course-material-capabilities';
import type { CourseMaterialEntry } from '@/lib/generation-run-client/use-course-materials';
import { modelSettingsClient } from '@/lib/model-settings/client';
import { modelSettingsViewFor } from '../helpers/model-settings-view';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const text = key
        .split('.')
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)?.[part],
          enUS,
        ) as string;
      return text.replace(/{{(\w+)}}/g, (_match, name) => String(values?.[name] ?? ''));
    },
  }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  modelSettingsClient.adopt(null);
  vi.restoreAllMocks();
});

function material(name: string, type: string): CourseMaterialEntry {
  const file = new File(['data'], name, { type });
  return {
    id: name,
    file,
    name,
    type,
    size: file.size,
    lastModified: file.lastModified,
    order: 1,
    status: 'ready',
    progress: 1,
    mediaKind: 'document',
    materialId: name,
  };
}
const files = [
  material(
    'lesson.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ),
  material('notes.txt', 'text/plain'),
  material('slides.pdf', 'application/pdf'),
];
const changeProvider = (provider: string) =>
  modelSettingsClient.adopt(modelSettingsViewFor({ document: { registryId: provider } }));

async function mount(locked = false) {
  const onError = vi.fn();
  const removed = vi.fn();
  function Page({ locked }: { locked: boolean }) {
    const [materials, setMaterials] = useState(files);
    const remove = useCallback((id: string) => {
      removed(id);
      setMaterials((old) => old.filter((file) => file.id !== id));
    }, []);
    useCourseMaterialCapabilities(materials, remove, onError, locked);
    // The course-options toolbar is deliberately unmounted, as on a phone.
    return createElement('output', null, materials.map((file) => file.id).join(','));
  }
  const host = document.createElement('div');
  root = createRoot(host);
  const render = async (locked: boolean) =>
    act(async () => root!.render(createElement(Page, { locked })));
  await render(locked);
  return { host, onError, removed, render };
}

it('removes only incompatible attachments after a provider switch with no toolbar mounted', async () => {
  changeProvider('mineru-cloud');
  const page = await mount();
  expect(page.removed).not.toHaveBeenCalled();
  await act(async () => changeProvider('unpdf'));
  expect(page.removed).toHaveBeenCalledExactlyOnceWith('lesson.docx');
  expect(page.host.textContent).toBe('notes.txt,slides.pdf');
  expect(page.onError).toHaveBeenCalledExactlyOnceWith(
    "unpdf can't read this file type. Supported: PDF, TXT, MD",
  );
  await page.render(false);
  expect(page.onError).toHaveBeenCalledTimes(1);
});

it('leaves the handed-off material set frozen until generation preparation finishes', async () => {
  changeProvider('mineru-cloud');
  const page = await mount(true);
  await act(async () => changeProvider('unpdf'));
  expect(page.removed).not.toHaveBeenCalled();
  expect(page.onError).not.toHaveBeenCalled();
  await page.render(false);
  expect(page.removed).toHaveBeenCalledExactlyOnceWith('lesson.docx');
});

it('keeps plain text available alongside the current extractor', async () => {
  changeProvider('unpdf');
  const page = await mount();
  expect(page.host.textContent).toContain('notes.txt');
  expect(page.host.textContent).toContain('slides.pdf');
  expect(page.host.textContent).not.toContain('lesson.docx');
});

it('does not remove attachments before the document-provider settings are known', async () => {
  modelSettingsClient.adopt(null);
  vi.spyOn(modelSettingsClient, 'load').mockResolvedValue({ phase: 'loading', view: null });
  const page = await mount();
  expect(page.removed).not.toHaveBeenCalled();
  expect(page.host.textContent).toContain('lesson.docx');
  await act(async () => changeProvider('mineru-cloud'));
  expect(page.removed).not.toHaveBeenCalled();
  await act(async () => changeProvider('unpdf'));
  expect(page.removed).toHaveBeenCalledExactlyOnceWith('lesson.docx');
});
