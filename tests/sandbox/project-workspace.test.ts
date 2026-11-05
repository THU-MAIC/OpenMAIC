import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '@/lib/i18n/locales/en-US.json';
import zh from '@/lib/i18n/locales/zh-CN.json';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

vi.mock('@/components/sandbox/project-terminal', () => ({ ProjectTerminal: () => null }));
import { ProjectWorkspace } from '@/components/sandbox/project-workspace';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en-US',
    resources: {
      'en-US': { translation: en },
      'zh-CN': { translation: zh },
    },
    interpolation: { escapeValue: false },
  });
});
const workspace = () =>
  createElement(
    I18nextProvider,
    { i18n },
    createElement(ProjectWorkspace, { workspaceId: 'project' }),
  );
let root: Root | undefined;
let host: HTMLElement;
let lifetimeMs = 60_000;
const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
const environment = {
  id: '12345678-1234-1234-1234-123456789012',
  workspaceId: 'project',
  state: 'running',
  workspaceReady: true,
};

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  const dom = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  // React detects native input-event support while loading react-dom.
  Object.defineProperty(dom.document, 'oninput', { value: null, configurable: true });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('navigator', { userAgent: 'test' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : {};
      requests.push({ url, method, body });
      let data: unknown;
      if (url.endsWith('/capabilities'))
        data = { storage: { available: true }, preview: { browser: false }, lifetimeMs };
      else if (url === '/api/sandbox/environments') data = [environment];
      else if (url.endsWith('/workspace')) data = { checkpoint: null, files: [] };
      else if (url.endsWith('/commands') && method === 'POST')
        data = {
          id: body.requestId,
          state: 'exited',
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          truncated: false,
        };
      else if (url.endsWith('/commands') || url.endsWith('/terminals')) data = [];
      else throw new Error(`Unexpected request ${method} ${url}`);
      return Response.json({ success: true, data });
    }),
  );
  const { createRoot } = await import('react-dom/client');
  host = document.getElementById('root')!;
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('workspace command limits', () => {
  it.each([
    [60_000, 60_000],
    [300_000, 240_000],
    [3_600_000, 240_000],
  ])(
    'uses an accepted command timeout with a %i ms deployment lifetime',
    async (lifetime, expected) => {
      lifetimeMs = lifetime;
      await act(async () => root!.render(workspace()));
      const input = host.querySelector<HTMLInputElement>('[aria-label="Shell command"]')!;
      input.type = 'text'; // linkedom does not supply the browser's default input type.
      await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(
          input,
          'echo ok',
        );
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      const run = [...host.querySelectorAll('button')].find(
        (b) => b.textContent === 'Run command',
      )!;
      expect(run.hasAttribute('disabled')).toBe(false);
      await act(async () => run.click());
      expect(
        requests.find((r) => r.url.endsWith('/commands') && r.method === 'POST')?.body,
      ).toMatchObject({ command: 'echo ok', timeoutMs: expected });
    },
  );
});

it('uses the existing locale for labels, state and unavailable capability messages', async () => {
  await i18n.changeLanguage('zh-CN');
  await act(async () => root!.render(workspace()));
  expect(host.textContent).toContain('项目工作区');
  expect(host.textContent).toContain('运行中');
  expect(host.textContent).toContain('当前部署未启用应用预览。');
  expect(host.querySelector('[aria-label="文件编辑器"]')).not.toBeNull();
  expect(host.textContent).not.toContain('sandbox.');
  await act(async () => {
    await i18n.changeLanguage('en-US');
  });
  expect(host.textContent).toContain('Project workspace');
  expect(host.querySelector('[aria-label="File editor"]')).not.toBeNull();
});

it.each(['not-found', 'timeout', 'unknown', 'other-404', 'destroyed'])(
  'handles cached creation UUID after %s',
  async (kind) => {
    const key = 'openmaic.workspace.operation:project';
    const cache = new Map([[key, environment.id]]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => cache.get(k) ?? null,
      setItem: (k: string, v: string) => cache.set(k, v),
      removeItem: (k: string) => cache.delete(k),
    });
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (init.method === 'POST') {
          attempts++;
          if (attempts === 1) {
            if (kind === 'timeout') throw new Error('network timeout');
            if (kind === 'not-found' || kind === 'other-404')
              return Response.json(
                {
                  success: false,
                  error: {
                    code: kind === 'not-found' ? 'SANDBOX_NOT_FOUND' : 'OTHER',
                    message: 'Not found',
                  },
                },
                { status: 404 },
              );
            return Response.json({
              success: true,
              data: { ...environment, state: kind === 'destroyed' ? 'destroyed' : 'unknown' },
            });
          }
          expect(JSON.parse(String(init.body)).requestId).not.toBe(environment.id);
          return Response.json({ success: true, data: environment });
        }
        return Response.json({
          success: true,
          data: url.endsWith('/capabilities')
            ? { storage: { available: true }, preview: { browser: false }, lifetimeMs }
            : [],
        });
      }),
    );
    await act(async () => root!.render(workspace()));
    const open = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Open / restore project',
    )!;
    await act(async () => open.click());
    if (kind === 'not-found') {
      expect(cache.has(key)).toBe(false);
      await act(async () => open.click());
      expect(attempts).toBe(2);
    } else if (kind === 'destroyed') {
      expect(attempts).toBe(2);
      expect(cache.get(key)).not.toBe(environment.id);
    } else expect(cache.get(key)).toBe(environment.id);
  },
);

it('keeps an unresolved terminal reachable after refresh so it can be closed', async () => {
  const originalFetch = fetch;
  let closed = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/terminals'))
        return Response.json({
          success: true,
          data: closed ? [] : [{ id: 'terminal-id', state: 'unknown' }],
        });
      if (url.endsWith('/terminals/terminal-id') && init.method === 'DELETE') {
        closed = true;
        return Response.json({ success: true, data: { id: 'terminal-id', state: 'closed' } });
      }
      return originalFetch(url, init);
    }),
  );
  await act(async () => root!.render(workspace()));
  const close = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Close shell');
  expect(close).toBeDefined();
  await act(async () => close!.click());
  expect(closed).toBe(true);
  expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Open terminal')).toBe(
    true,
  );
});

it.each(['save', 'save-and-release', 'cancel', 'failure', 'uncertain', 'refresh-failure'])(
  'discards the editor only after confirmed release (%s)',
  async (outcome) => {
    const cache = new Map([['openmaic.workspace.operation:project', environment.id]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => cache.get(key) ?? null,
      setItem: (key: string, value: string) => cache.set(key, value),
      removeItem: (key: string) => cache.delete(key),
    });
    window.confirm = vi.fn(() => outcome !== 'cancel');
    const originalFetch = fetch;
    let active = true;
    let deleted = false;
    let deleteCalls = 0;
    const writes: string[] = [];
    const checkpoints: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const method = init.method ?? 'GET';
        const reply = (data: unknown) => Response.json({ success: true, data });
        if (url === `/api/sandbox/environments/${environment.id}` && method === 'DELETE') {
          deleteCalls++;
          if (outcome === 'failure') throw new Error('release failed');
          if (outcome === 'uncertain') return reply({ ...environment, state: 'destroying' });
          active = false;
          deleted = true;
          return reply({ ...environment, state: 'destroyed' });
        }
        if (url === '/api/sandbox/environments') {
          if (outcome === 'refresh-failure' && deleted) throw new Error('refresh failed');
          if (method === 'POST') {
            active = true;
            return reply(environment);
          }
          return reply(active ? [environment] : []);
        }
        if (url === '/api/sandbox/workspaces') return reply([]);
        if (url.endsWith('/files') && method === 'PUT') {
          writes.push(JSON.parse(String(init.body)).text);
          return reply({});
        }
        if (url.endsWith('/workspace') && method === 'POST') {
          const action = JSON.parse(String(init.body)).action;
          checkpoints.push(action);
          return reply({
            checkpoint: { revision: 1, bytes: 0 },
            released: action === 'save-and-release',
          });
        }
        return originalFetch(url, init);
      }),
    );
    await act(async () => root!.render(workspace()));
    const editor = host.querySelector<HTMLTextAreaElement>('[aria-label="File editor"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')!.set!.call(
        editor,
        'discard this buffer',
      );
      editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const click = async (label: string) => {
      const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
      expect(button).toBeDefined();
      expect(button.hasAttribute('disabled')).toBe(false);
      await act(async () => button.click());
    };
    expect(host.textContent).toContain('Write file *');
    await click('Release environment');
    expect(deleteCalls).toBe(outcome === 'cancel' ? 0 : 1);
    const confirmed = !['cancel', 'failure', 'uncertain'].includes(outcome);
    expect(editor.value).toBe(confirmed ? '' : 'discard this buffer');
    expect(cache.size).toBe(confirmed ? 0 : 1);
    expect(host.textContent?.includes('Write file *')).toBe(!confirmed);
    if (outcome === 'save' || outcome === 'save-and-release') {
      await click('Open / restore project');
      await click(outcome === 'save' ? 'Save checkpoint' : 'Save and release');
      expect(checkpoints).toEqual([outcome]);
      expect(writes).toEqual([]);
    }
  },
);
