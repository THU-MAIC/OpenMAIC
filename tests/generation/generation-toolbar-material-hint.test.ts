// @vitest-environment jsdom
/**
 * The home attach popover tells the user which formats the selected document
 * extractor accepts — in the dropzone hint and in the "unsupported file"
 * error — instead of a static claim that every format works.
 */
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18next, { type i18n as I18n } from 'i18next';

import enUS from '@/lib/i18n/locales/en-US.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';

const i18nState = vi.hoisted(() => ({ locale: 'en-US' as 'en-US' | 'zh-CN' }));
let i18n: I18n;

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      i18n.getFixedT(i18nState.locale)(key, options ?? {}),
    locale: i18nState.locale,
  }),
}));

// Render the popover's content inline so the dropzone is reachable without
// driving Radix's open state.
vi.mock('@/components/ui/popover', () => {
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children);
  return { Popover: Passthrough, PopoverTrigger: Passthrough, PopoverContent: Passthrough };
});

import {
  GenerationToolbar,
  type GenerationToolbarProps,
} from '@/components/generation/generation-toolbar';
import { modelSettingsClient, type ModelSettingsView } from '@/lib/model-settings/client';

import { modelSettingsViewFor } from '../helpers/model-settings-view';

beforeAll(async () => {
  i18n = i18next.createInstance();
  await i18n.init({
    lng: 'en-US',
    fallbackLng: 'en-US',
    resources: { 'en-US': { translation: enUS }, 'zh-CN': { translation: zhCN } },
    interpolation: { escapeValue: false },
  });
});

afterEach(() => {
  modelSettingsClient.adopt(null);
  i18nState.locale = 'en-US';
  document.body.innerHTML = '';
});

function viewWithExtractor(registryId: string): ModelSettingsView {
  return modelSettingsViewFor({ document: { registryId, providerId: registryId } });
}

function props(overrides: Partial<GenerationToolbarProps> = {}): GenerationToolbarProps {
  return {
    courseMaterials: [],
    onCourseMaterialsAdd: () => {},
    onCourseMaterialRemove: () => {},
    onPdfError: () => {},
    ...overrides,
  };
}

function render(registryId: string): string {
  modelSettingsClient.adopt(viewWithExtractor(registryId));
  return renderToStaticMarkup(createElement(GenerationToolbar, props()));
}

describe('the course-material dropzone hint', () => {
  it('lists only PDF and plain text with unpdf', () => {
    const markup = render('unpdf');
    expect(markup).toContain('Supports PDF, TXT, MD — up to 50MB per file');
    expect(markup).not.toContain('DOCX');
    expect(markup).not.toContain('PNG');
  });

  it('localizes the hint', () => {
    i18nState.locale = 'zh-CN';
    expect(render('unpdf')).toContain('支持 PDF、TXT、MD，单个最大 50MB');
  });

  it('lists every format a broader extractor accepts', () => {
    const markup = render('mineru-cloud');
    for (const label of ['PDF', 'DOC', 'DOCX', 'PPT', 'PPTX', 'XLS', 'XLSX', 'PNG', 'TXT', 'MD']) {
      expect(markup).toMatch(new RegExp(`Supports [^<]*\\b${label}\\b`));
    }
  });

  it('keeps the file-count limit line', () => {
    expect(render('unpdf')).toContain('You can upload up to 5 course material files');
  });
});

describe('the unsupported course-material error', () => {
  async function dropOnto(registryId: string, file: File) {
    const { createRoot } = await import('react-dom/client');
    const { act } = await import('react');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    modelSettingsClient.adopt(viewWithExtractor(registryId));
    const onPdfError = vi.fn();
    const onCourseMaterialsAdd = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(GenerationToolbar, props({ onPdfError, onCourseMaterialsAdd })));
    });
    const dropzone = container.querySelector('.border-dashed');
    expect(dropzone).not.toBeNull();
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
    await act(async () => {
      dropzone!.dispatchEvent(event);
    });
    await act(async () => root.unmount());
    return { onPdfError, onCourseMaterialsAdd };
  }

  const docx = () =>
    new File(['x'], 'lesson.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

  it('names the extractor and the formats it supports when a dropped file is rejected', async () => {
    const { onPdfError, onCourseMaterialsAdd } = await dropOnto('unpdf', docx());
    expect(onCourseMaterialsAdd).not.toHaveBeenCalled();
    expect(onPdfError).toHaveBeenCalledWith(
      "unpdf can't read this file type. Supported: PDF, TXT, MD",
    );
  });

  it('localizes the error', async () => {
    i18nState.locale = 'zh-CN';
    const { onPdfError } = await dropOnto('unpdf', docx());
    expect(onPdfError).toHaveBeenCalledWith('unpdf 不支持该文件类型，当前支持：PDF、TXT、MD');
  });

  it('accepts the same file once the extractor supports it', async () => {
    const { onPdfError, onCourseMaterialsAdd } = await dropOnto('mineru-cloud', docx());
    expect(onCourseMaterialsAdd).toHaveBeenCalledTimes(1);
    expect(onPdfError).toHaveBeenLastCalledWith(null);
  });
});
