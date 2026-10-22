import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import en from '@/lib/i18n/locales/en-US.json';
import zh from '@/lib/i18n/locales/zh-CN.json';
vi.mock('server-only', () => ({}));
const translation = vi.hoisted(() => ({ t: (key: string): string => key }));
vi.mock('@/lib/i18n', () => ({ getClientTranslation: (key: string) => translation.t(key) }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: vi.fn() }));
vi.mock('@/lib/store/stage', () => ({ useStageStore: vi.fn() }));
vi.mock('@/components/scene-renderers/pbl/v2/markdown-text', () => ({ MarkdownText: vi.fn() }));
vi.mock('@/lib/server/identity/with-owner', () => ({
  withRequestOwner: async (
    _request: Request,
    handle: (p: unknown, h: Headers) => Promise<Response>,
  ) => handle({ ownerId: 'owner' }, new Headers()),
}));
import { sandboxPrincipalResponse } from '@/lib/server/sandbox/http';
import { SandboxError, sandboxConflict, sandboxInvalid } from '@/lib/sandbox/errors';
import { SandboxRequestError, sandboxRequest } from '@/components/sandbox/client';
import { pblRequest } from '@/components/scene-renderers/pbl/v3/workspace';
import { sandboxErrorMessage } from '@/lib/sandbox/error-message';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en-US',
    fallbackLng: 'en-US',
    resources: {
      'en-US': { translation: en },
      'zh-CN': { translation: zh },
    },
  });
  translation.t = (key) => i18n.t(key);
});
afterEach(() => vi.unstubAllGlobals());

const cases = [
  [sandboxConflict('server diagnostic', 'ENVIRONMENT_UNAVAILABLE'), 'environmentUnavailable'],
  [new SandboxError('SANDBOX_UNAVAILABLE', 503, 'server diagnostic'), 'unavailable'],
  [sandboxConflict('server diagnostic', 'ENVIRONMENT_BUSY'), 'environmentBusy'],
  [sandboxConflict('server diagnostic', 'ENVIRONMENT_CHANGED'), 'environmentChanged'],
  [sandboxConflict('server diagnostic', 'PROGRESS_CHANGED'), 'progressChanged'],
  [sandboxConflict('server diagnostic', 'WORKBENCH_ACCESS_DENIED'), 'workbenchAccessDenied'],
  [sandboxConflict('server diagnostic', 'WORKSPACE_FILE_CONFLICT'), 'fileConflict'],
  [sandboxConflict('server diagnostic', 'WORKSPACE_STOPPED'), 'stopped'],
  [sandboxInvalid('server diagnostic'), 'invalidRequest'],
  [new SandboxError('SANDBOX_UNSUPPORTED', 422, 'server diagnostic'), 'unsupported'],
  [new SandboxError('PBL_WORKSPACE_MANAGED', 409, 'server diagnostic'), 'learningManaged'],
  [sandboxInvalid('server diagnostic', 'PBL_SOURCE_PATH'), 'sourcePath'],
  [sandboxInvalid('server diagnostic', 'PBL_SOURCE_COUNT'), 'sourceCount'],
  [sandboxInvalid('server diagnostic', 'PBL_SOURCE_SIZE'), 'sourceSize'],
  [sandboxConflict('server diagnostic', 'WORKSPACE_COMMAND_ACTIVE'), 'commandActive'],
  [sandboxConflict('server diagnostic', 'WORKSPACE_TERMINAL_ACTIVE'), 'terminalActive'],
] as const;
describe.each(['en-US', 'zh-CN'] as const)('workspace errors in %s', (locale) => {
  it.each(cases)(
    'localizes %s through both HTTP clients without changing status or code',
    async (error, key) => {
      await i18n.changeLanguage(locale);
      const request = new Request('http://localhost/api/pbl/v3', {
        headers: { 'x-openmaic-sandbox': '1' },
      });
      const response = await sandboxPrincipalResponse(request, async () => {
        throw error;
      });
      const body = await response.json();
      expect(body.error).toEqual({
        code: error.code,
        message: error.message,
        ...(error.reason ? { reason: error.reason } : {}),
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(body, { status: response.status })),
      );
      for (const client of [sandboxRequest, pblRequest]) {
        await expect(client('/api/test')).rejects.toBeInstanceOf(SandboxRequestError);
        await expect(client('/api/test')).rejects.toMatchObject({
          status: error.status,
          code: error.code,
          message: (locale === 'en-US' ? en : zh).sandbox.errors[key],
        });
      }
    },
  );
});
it('uses a localized fallback for unknown reasons and preserves legacy errors and success shapes', async () => {
  await i18n.changeLanguage('zh-CN');
  expect(sandboxErrorMessage({ reason: 'future-reason', message: 'unrecognized detail' })).toBe(
    zh.sandbox.requestFailed,
  );
  expect(sandboxErrorMessage()).toBe(zh.sandbox.requestFailed);
  expect(
    sandboxErrorMessage({ code: 'SANDBOX_CONFLICT', message: 'Existing fixed diagnostic' }),
  ).toBe('Existing fixed diagnostic');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { error: { code: 'SANDBOX_NOT_FOUND', message: 'Sandbox environment not found.' } },
        { status: 404 },
      ),
    ),
  );
  await expect(sandboxRequest('/api/test')).rejects.toMatchObject({
    code: 'SANDBOX_NOT_FOUND',
    status: 404,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ success: true, data: { id: 'env' } })),
  );
  await expect(sandboxRequest('/api/test')).resolves.toEqual({ id: 'env' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ studyId: 'study' })),
  );
  await expect(pblRequest('/api/test')).resolves.toEqual({ studyId: 'study' });
});
