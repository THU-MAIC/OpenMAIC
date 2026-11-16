/**
 * A save the server refuses (a course the viewer does not own) is said out
 * loud, once per course, instead of looking as if the edit landed.
 */
import { HttpDocumentStoreError } from '@openmaic/storage';
import { describe, expect, it, vi } from 'vitest';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));
vi.mock('@/lib/i18n/config', () => ({ default: { t: (key: string) => key } }));

import { isRefusedSave, noticeRefusedSave } from '@/lib/store/save-refusal-notice';

describe('a refused save', () => {
  it('is a 401 or 403 from the document store, and nothing else', () => {
    expect(isRefusedSave(new HttpDocumentStoreError(403, 'FORBIDDEN', 'no'))).toBe(true);
    expect(isRefusedSave(new HttpDocumentStoreError(401, 'UNAUTHENTICATED', 'no'))).toBe(true);
    expect(isRefusedSave(new HttpDocumentStoreError(503, 'UNAVAILABLE', 'down'))).toBe(false);
    expect(isRefusedSave(new Error('offline'))).toBe(false);
  });

  it('is said once per course', () => {
    const refused = new HttpDocumentStoreError(403, 'FORBIDDEN', 'no');
    noticeRefusedSave('stage-a', refused);
    noticeRefusedSave('stage-a', refused);
    noticeRefusedSave('stage-b', new Error('offline'));
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('classroom.saveRefused');
    noticeRefusedSave('stage-b', refused);
    expect(toastError).toHaveBeenCalledTimes(2);
  });
});
