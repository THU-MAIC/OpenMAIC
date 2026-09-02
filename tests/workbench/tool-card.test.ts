// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatNode } from '@/lib/workbench/session-store';

vi.mock('@/lib/workbench/agent-skills', () => ({
  useAgentSkills: () => ({ skills: [], loading: false, error: null, reload: async () => {} }),
  skillLabelForId: (id: string) => id,
}));

import { ToolCard } from '@/components/workbench/chat/tool-card';

const roots: Root[] = [];
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function mount(node: ChatNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(ToolCard, { node })));
  return host;
}

describe('create_skill tool card', () => {
  it('expands a replayed receipt and loads the complete saved body', async () => {
    const content = '# 量化投资\n\n'.concat('不截断。'.repeat(4_000));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ content }) })),
    );
    const host = mount({
      key: 'skill-1',
      kind: 'tool',
      text: '',
      toolName: 'create_skill',
      toolState: 'done',
      toolDetails: {
        skillId: 'usk_1',
        name: 'my-quant-book-to-k12',
        title: '量化投资书 → 小学生数学素养课',
      },
    });
    const button = host.querySelector('button')!;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');

    await act(async () => button.click());
    await act(async () => {});

    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain(content);
    expect(fetch).toHaveBeenCalledWith('/api/agent/skills/usk_1');
  });

  it('uses durable result details without another request', async () => {
    const content = '# 已落盘正文\n\n完整内容';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const host = mount({
      key: 'skill-2',
      kind: 'tool',
      text: '',
      toolName: 'create_skill',
      toolState: 'done',
      toolDetails: { skillId: 'usk_2', name: 'my-review', content },
    });

    await act(async () => host.querySelector('button')!.click());

    expect(host.textContent).toContain(content);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the durable receipt visible when historical content cannot load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503 })),
    );
    const host = mount({
      key: 'skill-3',
      kind: 'tool',
      text: '',
      toolName: 'create_skill',
      toolState: 'done',
      toolResultText: '已保存 Skill「复盘方法」',
      toolDetails: { skillId: 'usk_3', name: 'my-review' },
    });

    await act(async () => host.querySelector('button')!.click());
    await act(async () => {});

    expect(host.textContent).toContain('已保存 Skill「复盘方法」');
    expect(host.textContent).toContain('Skill 正文加载失败');
    expect(host.textContent).not.toContain('Skill 列表加载失败');
  });

  it('keeps the durable receipt visible while historical content is still loading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const host = mount({
      key: 'skill-4',
      kind: 'tool',
      text: '',
      toolName: 'create_skill',
      toolState: 'done',
      toolResultText: '已保存 Skill「慢请求」',
      toolDetails: { skillId: 'usk_4', name: 'my-slow-skill' },
    });

    await act(async () => host.querySelector('button')!.click());

    expect(host.textContent).toContain('已保存 Skill「慢请求」');
    expect(host.textContent).toContain('加载中');
  });
});

/**
 * Untrusted content discipline at the card level: tool output — fetched web
 * bodies, material extractions — renders as DATA inside the fenced result
 * section, never as markup and never as assistant speech.
 */
describe('tool output renders fenced, as data', () => {
  it('shows fetched content as text in the result section, never as injected HTML', async () => {
    const host = mount({
      key: 't-untrusted',
      kind: 'tool',
      text: '',
      toolName: 'fetch_url',
      toolState: 'done',
      toolArgs: { url: 'https://untrusted.example/page' },
      toolResultText: '<script>alert("pwned")</script>\nraw fetched body',
    });

    await act(async () => host.querySelector('button')!.click());

    // The raw payload is present as TEXT — the same bytes, in a text node.
    expect(host.textContent).toContain('<script>alert("pwned")</script>');
    expect(host.textContent).toContain('raw fetched body');
    // ...and it was never parsed into DOM: no script element was created.
    expect(host.querySelector('script')).toBeNull();
  });

  it('keeps the fetched source out of the one-line summary — data is not speech', async () => {
    const host = mount({
      key: 't-fetch-label',
      kind: 'tool',
      text: '',
      toolName: 'fetch_url',
      toolState: 'done',
      toolArgs: { url: 'https://untrusted.example/page' },
      toolDetails: { trusted: { status: 'url_not_in_session' } },
      toolResultText: 'fetched body must stay fenced',
    });
    // The collapsed row shows the labelled form: the source is named as outside
    // the session, and the fetched body is not echoed in the summary.
    expect(host.textContent).toContain('来源不在本会话内');
    expect(host.textContent).not.toContain('fetched body must stay fenced');
  });
});
