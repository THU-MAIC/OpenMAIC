// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudentEditor } from '@/components/teacher/StudentEditor';
import { TeacherIdentityDialog } from '@/components/teacher/TeacherIdentityDialog';
import { getTeacherCopy } from '@/lib/i18n/teacher';
import type { TeacherStudent } from '@/lib/teacher/students';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { createUnknownField } from '@/lib/zhongkao/observed-field';

const roots: Root[] = [];
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const copy = getTeacherCopy('en-US');
const createdAt = '2026-09-08T10:00:00.000Z';

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(element);
  });
}

async function typeInto(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('teacher workspace interactions', () => {
  it('creates a nickname-only profile with null unknowns', async () => {
    const onSaved = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ student: { profile: { profileId: 'fictional' }, archived: false } }),
          { status: 201 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    await mount(
      createElement(StudentEditor, { copy, onClose: vi.fn(), onSaved, refreshStudents: vi.fn() }),
    );
    expect((document.getElementById('teacher-student-grade') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('teacher-student-exam-year') as HTMLInputElement).value).toBe(
      '',
    );
    await typeInto('teacher-student-nickname', 'Fictional student');
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toMatchObject({
      nickname: 'Fictional student',
      grade: null,
      examYear: null,
      region: null,
    });
    expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it.each(['network', '503'])(
    'retries an uncertain %s creation with the same request and payload',
    async (failure) => {
      const fetchMock = vi.fn();
      if (failure === 'network') fetchMock.mockRejectedValueOnce(new TypeError('Response lost'));
      else
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify({ errorCode: 'TEACHER_STUDENT_UNAVAILABLE' }), {
            status: 503,
          }),
        );
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ student: { profile: { profileId: 'fictional' }, archived: false } }),
          { status: 200 },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const onSaved = vi.fn();
      await mount(
        createElement(StudentEditor, { copy, onClose: vi.fn(), onSaved, refreshStudents: vi.fn() }),
      );
      await typeInto('teacher-student-nickname', 'Fictional saved student');
      await submit();
      expect(document.querySelector('[role="alert"]')?.textContent).toBe(copy.createPending);
      for (const input of document.querySelectorAll('input')) expect(input.disabled).toBe(true);
      expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
        false,
      );
      expect(document.querySelector('button[type="submit"]')?.textContent).toContain(copy.retry);
      // Even a synthetic change that bypasses the disabled UI cannot change the in-flight request.
      await typeInto('teacher-student-nickname', 'Fictional attempted change');
      await submit();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).nickname).toBe('Fictional saved student');
      expect(onSaved).toHaveBeenCalledOnce();
    },
  );

  it('allows corrections after a creation was explicitly rejected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errorCode: 'TEACHER_STUDENT_INPUT_INVALID' }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ student: { profile: { profileId: 'fictional' }, archived: false } }),
          { status: 201 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    await mount(
      createElement(StudentEditor, {
        copy,
        onClose: vi.fn(),
        onSaved: vi.fn(),
        refreshStudents: vi.fn(),
      }),
    );
    await typeInto('teacher-student-nickname', 'Fictional rejected student');
    await submit();
    expect((document.getElementById('teacher-student-nickname') as HTMLInputElement).disabled).toBe(
      false,
    );
    await typeInto('teacher-student-nickname', 'Fictional corrected student');
    await submit();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      nickname: 'Fictional corrected student',
      requestId: JSON.parse(fetchMock.mock.calls[0][1].body).requestId,
    });
  });

  it('allows closing after an uncertain creation even when refreshing the list fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Service unavailable')));
    const refreshStudents = vi.fn().mockRejectedValue(new Error('List unavailable'));
    const onClose = vi.fn();
    await mount(createElement(StudentEditor, { copy, onClose, onSaved: vi.fn(), refreshStudents }));
    await typeInto('teacher-student-nickname', 'Fictional saved student');
    await submit();
    const close = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(copy.closeAndRefresh),
    )!;
    expect(close.disabled).toBe(false);
    await act(async () => {
      close.click();
    });
    expect(refreshStudents).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ['different fields', 'Fictional original'],
    ['the same nickname field', 'Fictional remote nickname'],
  ])(
    'merges changes to %s without losing the local draft or remote region',
    async (_scenario, remoteNickname) => {
      const profile = createInitialStudentProfile({ profileId: 'fictional-student', createdAt });
      profile.grade = createUnknownField(createdAt);
      profile.examYear = createUnknownField(createdAt);
      profile.displayName = {
        value: 'Fictional original',
        status: 'confirmed',
        confidence: 1,
        evidence: [{ type: 'user_input', createdAt }],
        updatedAt: createdAt,
      };
      const student: TeacherStudent = { profile, archived: false };
      const latest: TeacherStudent = {
        ...student,
        profile: {
          ...profile,
          displayName: { ...profile.displayName, value: remoteNickname },
          region: {
            value: 'Fictional remote region',
            status: 'confirmed',
            confidence: 1,
            evidence: [{ type: 'user_input', createdAt }],
            updatedAt: '2026-09-08T11:00:00.000Z',
          },
          updatedAt: '2026-09-08T11:00:00.000Z',
        },
      };
      const refreshStudents = vi.fn().mockResolvedValue([latest]);
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ errorCode: 'TEACHER_STUDENT_CONFLICT' }), { status: 409 }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ student: latest }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const onSaved = vi.fn();
      await mount(
        createElement(StudentEditor, { student, copy, onClose: vi.fn(), onSaved, refreshStudents }),
      );
      await typeInto('teacher-student-nickname', 'Fictional draft');
      await submit();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'Your draft is retained',
      );
      expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
        true,
      );
      const refresh = Array.from(document.querySelectorAll('button')).find((button) =>
        button.textContent?.includes(copy.refreshDraft),
      )!;
      await act(async () => {
        refresh.click();
      });
      expect((document.getElementById('teacher-student-nickname') as HTMLInputElement).value).toBe(
        'Fictional draft',
      );
      expect((document.getElementById('teacher-student-region') as HTMLInputElement).value).toBe(
        'Fictional remote region',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onSaved).not.toHaveBeenCalled();
      await submit();
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
        nickname: 'Fictional draft',
        region: 'Fictional remote region',
        expectedUpdatedAt: latest.profile.updatedAt,
      });
      expect(onSaved).toHaveBeenCalledOnce();
    },
  );

  it('masks the recovery code and does not restore without explicit confirmation', async () => {
    const recoveryCode = 'openmaic-teacher-v1:11111111-1111-4111-8111-111111111111';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ recoveryCode }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await mount(createElement(TeacherIdentityDialog, { copy, onClose: vi.fn() }));
    const input = document.getElementById('teacher-recovery-code') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe(recoveryCode);
    expect(document.body.textContent).not.toContain(recoveryCode);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
  });
});
