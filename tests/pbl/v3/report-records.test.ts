// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectReport } from '@/components/scene-renderers/pbl/v3/project-report';
import type { LearningReport } from '@/lib/pbl/v3/report';

vi.mock('@/lib/hooks/use-i18n', async () => {
  const { default: zh } = await import('@/lib/i18n/locales/zh-CN.json');
  const t = (key: string) => {
    let value: unknown = zh;
    for (const part of key.split('.')) value = (value as Record<string, unknown>)?.[part];
    return typeof value === 'string' ? value : key;
  };
  return { useI18n: () => ({ t, locale: 'zh-CN' }) };
});
vi.mock('@/components/workbench/chat/text-block', () => ({
  TextBlock: ({ text }: { text: string }) => createElement('p', null, text),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const report: LearningReport = {
  studyId: 'records-test',
  project: { id: 'test', version: '1', title: '我的待办清单' },
  revision: 1,
  requiredComplete: true,
  milestones: [{ id: 'one', title: '待办清单', status: 'completed', optional: false, stages: [] }],
  counts: {},
  truncated: false,
  evidence: [
    { sequence: 3, at: 1, milestoneId: 'one', kind: 'decision.recorded', detail: '新任务放最前。' },
  ],
  conversations: [
    {
      role: 'discussion',
      milestone: 'one',
      truncated: false,
      messages: [{ sequence: 4, at: 2, role: 'user', text: '已有事项的相对顺序应该保留。' }],
    },
  ],
  analysis: {
    status: 'ready',
    omitted: false,
    canRetry: false,
    findings: [
      {
        category: 'journey',
        title: '你确定了清单规则',
        detail: '你讨论了添加位置和顺序。',
        evidence: ['event:3', 'turn:0:4'],
      },
    ],
  },
};
let host: HTMLDivElement, root: Root;
const scroll = vi.fn();
const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scroll,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(report))),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (previousScroll)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  scroll.mockClear();
  vi.unstubAllGlobals();
});
async function render(open = true) {
  await act(async () =>
    root.render(
      createElement(ProjectReport, {
        studyId: report.studyId,
        title: report.project.title,
        open,
        onClose: () => {},
        onWorkbench: () => {},
      }),
    ),
  );
}
function records() {
  return host.querySelector<HTMLDetailsElement>('[data-testid="pbl-report-records"]')!;
}
function source(id: string) {
  return document.getElementById(`report-source-records-test-${id}`) as HTMLDetailsElement;
}

it('keeps the long source lists collapsed behind one learning-records entry', async () => {
  await render();
  expect(records().open).toBe(false);
  expect(records().querySelector('summary')?.textContent).toContain('查看学习记录');
  expect(source('event-3').open).toBe(false);
  expect(source('turn-0-4').open).toBe(false);
  expect(host.textContent).toContain('你确定了清单规则');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  ['event-3', 0],
  ['turn-0-4', 1],
] as const)(
  'reveals, focuses and locates the retained %s citation without generating another report',
  async (id, index) => {
    await render();
    const citations = [...host.querySelectorAll('button')].filter((b) =>
      b.textContent?.includes('依据'),
    );
    await act(async () => citations[index].click());
    expect(records().open).toBe(true);
    expect(source(id).open).toBe(true);
    expect(document.activeElement).toBe(source(id).querySelector('summary'));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('starts with records collapsed again when the report is reopened', async () => {
  await render();
  records().open = true;
  await render(false);
  await render();
  expect(records().open).toBe(false);
});
