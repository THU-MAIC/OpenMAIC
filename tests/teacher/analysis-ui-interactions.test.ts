// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisComposer } from '@/components/teacher/AnalysisComposer';
import { AnalysisEditor } from '@/components/teacher/AnalysisEditor';
import { StudentAnalyses } from '@/components/teacher/StudentAnalyses';
import { getTeacherAnalysisCopy } from '@/lib/i18n/teacher-analysis';
import type { TeacherAnalysis } from '@/lib/teacher/analysis';

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/workbench/compose-extras', () => ({
  useComposerMaterials: () => ({
    enabled: true,
    materials: [],
    uploading: [],
    failed: [],
    busy: false,
    addFiles: vi.fn(),
    remove: vi.fn(),
    removeFailed: vi.fn(),
    clear: vi.fn(),
  }),
  AttachButton: () => null,
}));
vi.mock('@/components/teacher/analysis-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/teacher/analysis-ui')>()),
  analysisRequestHeaders: () => ({ 'x-model': 'fictional:test-model' }),
}));

const copy = getTeacherAnalysisCopy('en');
const roots: Root[] = [];
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const profileId = `teacher-student:v1:${'a'.repeat(64)}`;
const otherProfileId = `teacher-student:v1:${'b'.repeat(64)}`;
const materialId = `mat_${'0'.repeat(26)}`;

function fixture(overrides: Partial<TeacherAnalysis> = {}): TeacherAnalysis {
  const report: TeacherAnalysis['report'] = {
    readiness: 'insufficient',
    observations: [
      {
        category: 'needs_verification',
        text: 'Fictional response needs verification.',
        citations: [
          { sourceId: 'source-1', blockId: 'block-1', quote: 'Fictional response 2 + 2 = 5' },
        ],
      },
    ],
    recommendations: [{ text: 'Ask for an independent attempt.', observationIndexes: [0] }],
    limitations: ['One response does not establish a weak topic.'],
  };
  return {
    schemaVersion: 1,
    analysisId: `teacher-analysis:v1:${'c'.repeat(64)}`,
    profileId,
    request: {
      requestId: '11111111-1111-4111-8111-111111111111',
      workKind: 'homework',
      subject: 'Mathematics',
      title: 'Fictional homework',
      workDate: '2026-09-08',
      teacherNotes: '',
      materials: [{ materialId, role: 'student_work' }],
    },
    requestFingerprint: 'd'.repeat(64),
    status: 'draft',
    sources: [
      {
        sourceId: 'source-1',
        materialId,
        role: 'student_work',
        name: 'Fictional homework.txt',
        mimeType: 'text/plain',
        sha256: 'e'.repeat(64),
        extractorId: 'plain-text',
        extractorVersion: '1',
        ocr: false,
        blocks: [{ blockId: 'block-1', text: 'Fictional response 2 + 2 = 5', pageNumber: 1 }],
      },
    ],
    report,
    originalReport: structuredClone(report),
    model: { providerId: 'fictional', modelId: 'test-model' },
    createdAt: '2026-09-08T10:00:00.000Z',
    updatedAt: '2026-09-08T10:00:00.000Z',
    teacherComment: '',
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

async function mount(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(element));
  return root;
}

function button(label: string): HTMLButtonElement {
  const result = Array.from(document.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  expect(result, `Button: ${label}`).toBeDefined();
  return result!;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

async function typeInto(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  const prototype =
    input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function chooseRole(value: string) {
  const select = document.querySelector('select[aria-label^="Material role"]') as HTMLSelectElement;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function submit() {
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('teacher analysis composer', () => {
  async function prepare(fetchMock: ReturnType<typeof vi.fn>, onSaved = vi.fn()) {
    vi.stubGlobal('fetch', fetchMock);
    await mount(
      createElement(AnalysisComposer, {
        profileId,
        nickname: 'Fictional student A',
        copy,
        onClose: vi.fn(),
        onSaved,
        onSettings: vi.fn(),
      }),
    );
    await typeInto('teacher-analysis-title', 'Fictional homework');
    await typeInto('teacher-analysis-subject', 'Mathematics');
    await click(copy.library);
    await click('Fictional homework.txt');
    return onSaved;
  }

  const library = () =>
    json({
      materials: [
        { materialId, originalName: 'Fictional homework.txt', bytes: 50, mime: 'text/plain' },
      ],
    });

  it('requires an explicit student-response role and sends only selected material IDs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(library())
      .mockResolvedValueOnce(json({ analysis: fixture() }));
    const onSaved = await prepare(fetchMock);
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(copy.sourceRequired);
    await chooseRole('question_paper');
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await chooseRole('student_work');
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toContain(encodeURIComponent(profileId));
    expect(JSON.parse(init.body)).toMatchObject({
      subject: 'Mathematics',
      title: 'Fictional homework',
      materials: [{ materialId, role: 'student_work' }],
    });
    expect(JSON.parse(init.body)).not.toHaveProperty('students');
    expect(init.headers).toMatchObject({ 'x-model': 'fictional:test-model' });
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('keeps an uncertain generation payload stable across retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(library())
      .mockRejectedValueOnce(new TypeError('Lost response'))
      .mockResolvedValueOnce(json({ analysis: fixture() }));
    const onSaved = await prepare(fetchMock);
    await chooseRole('student_work');
    await submit();
    expect(document.body.textContent).toContain(copy.creationPending);
    expect(
      (document.getElementById('teacher-analysis-subject') as HTMLInputElement).closest('fieldset')
        ?.disabled,
    ).toBe(true);
    await typeInto('teacher-analysis-title', 'Fictional synthetic edit');
    await submit();
    expect(fetchMock.mock.calls[2][1].body).toBe(fetchMock.mock.calls[1][1].body);
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('aborts generation on unmount and ignores a late response', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(library()).mockReturnValueOnce(pending);
    const onSaved = await prepare(fetchMock);
    await chooseRole('student_work');
    await submit();
    expect(document.body.textContent).toContain(copy.generating);
    const signal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    act(() => roots.pop()!.unmount());
    expect(signal.aborted).toBe(true);
    await act(async () => finish(json({ analysis: fixture() })));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('cancels a pending generation without accepting a late successful result', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(library())
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
      );
    const onSaved = await prepare(fetchMock);
    await chooseRole('student_work');
    await submit();
    await click(copy.cancel);
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    await act(async () => finish(json({ analysis: fixture() })));
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('teacher analysis review', () => {
  it('preserves citations while editing and requires a saved draft before confirming', async () => {
    const saved = fixture({ updatedAt: '2026-09-08T11:00:00.000Z' });
    saved.report.observations[0].text = 'Teacher verified the response transcription.';
    const reviewed = {
      ...saved,
      status: 'reviewed' as const,
      updatedAt: '2026-09-08T12:00:00.000Z',
      reviewedAt: '2026-09-08T12:00:00.000Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ analysis: saved }))
      .mockResolvedValueOnce(json({ analysis: reviewed }));
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();
    await mount(createElement(AnalysisEditor, { analysis: fixture(), copy, onSaved }));
    await typeInto('analysis-observation-0', saved.report.observations[0].text);
    expect(button(copy.confirm).disabled).toBe(true);
    await click(copy.save);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      action: 'save_draft',
      report: {
        observations: [
          {
            text: saved.report.observations[0].text,
            citations: fixture().report.observations[0].citations,
          },
        ],
      },
    });
    expect(button(copy.confirm).disabled).toBe(false);
    await click(copy.confirm);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      action: 'confirm_review',
      expectedUpdatedAt: saved.updatedAt,
      report: saved.report,
    });
    expect(document.body.textContent).toContain(copy.reviewedNotice);
    expect(onSaved).toHaveBeenCalledTimes(2);
  });

  it('retains a conflicting local draft and requires reading and explicitly comparing latest', async () => {
    const latest = fixture({
      updatedAt: '2026-09-08T11:00:00.000Z',
      teacherComment: 'Fictional remote review.',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ errorCode: 'ANALYSIS_CONFLICT' }, 409))
      .mockResolvedValueOnce(json({ analysis: latest }));
    vi.stubGlobal('fetch', fetchMock);
    await mount(createElement(AnalysisEditor, { analysis: fixture(), copy, onSaved: vi.fn() }));
    await typeInto('analysis-observation-0', 'Fictional local draft.');
    await click(copy.save);
    expect(button(copy.save).disabled).toBe(true);
    await click(copy.readLatest);
    expect((document.getElementById('analysis-observation-0') as HTMLTextAreaElement).value).toBe(
      'Fictional local draft.',
    );
    expect(document.body.textContent).toContain('Fictional remote review.');
    expect(button(copy.save).disabled).toBe(true);
    await click(copy.resolveWithDraft);
    expect(button(copy.save).disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requires explicit withdrawal and keeps withdrawn evidence readable', async () => {
    const analysis = fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          analysis: { ...analysis, status: 'withdrawn', updatedAt: '2026-09-08T11:00:00.000Z' },
        }),
      ),
    );
    await mount(createElement(AnalysisEditor, { analysis, copy, onSaved: vi.fn() }));
    await click(copy.withdraw);
    expect(fetch).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"]')!;
    const confirm = Array.from(dialog.querySelectorAll('button')).find(
      (item) => item.textContent === copy.withdraw,
    )!;
    await act(async () => confirm.click());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="teacher-analysis-status"]')?.textContent).toBe(
      copy.withdrawn,
    );
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
    expect(document.body.textContent).toContain(analysis.sources[0].blocks[0].text);
  });

  it('renders source text as text and identifies original pages without interpreting HTML', async () => {
    const analysis = fixture();
    analysis.sources[0].blocks[0].text += '<img src=x onerror="alert(1)">';
    await mount(createElement(AnalysisEditor, { analysis, copy, onSaved: vi.fn() }));
    expect(document.body.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(document.body.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('Page 1');
    expect(document.body.textContent).toContain(copy.reviewBoundary);
  });
});

describe('analysis student isolation', () => {
  it('clears the old student context and aborts its list request on student change', async () => {
    let finish!: (response: Response) => void;
    const firstRequest = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(firstRequest)
      .mockResolvedValueOnce(json({ analyses: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const root = await mount(
      createElement(StudentAnalyses, { profileId, nickname: 'Fictional A', locale: 'en' }),
    );
    await click(copy.create);
    await typeInto('teacher-analysis-title', 'Fictional A private draft');
    await act(async () =>
      root.render(
        createElement(StudentAnalyses, {
          profileId: otherProfileId,
          nickname: 'Fictional B',
          locale: 'en',
        }),
      ),
    );
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(document.querySelector('[data-testid="teacher-analysis-composer"]')).toBeNull();
    await act(async () => finish(json({ analyses: [fixture()] })));
    expect(document.body.textContent).not.toContain('Fictional homework');
    expect(document.body.textContent).not.toContain('Fictional A private draft');
    expect(document.body.textContent).toContain(copy.empty);
  });

  it('rejects a list response containing another student record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ analyses: [fixture({ profileId: otherProfileId })] })),
    );
    await mount(
      createElement(StudentAnalyses, { profileId, nickname: 'Fictional A', locale: 'en' }),
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(copy.failed);
    expect(document.querySelector('[data-testid="teacher-analysis-detail"]')).toBeNull();
  });
});
