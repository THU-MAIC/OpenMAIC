import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatTimeline, groupChat } from '@/components/workbench/chat/chat-timeline';
import {
  isSameNotice,
  presentSystemNotice,
  repeatLabel,
} from '@/components/workbench/chat/system-notice';
import type { ChatNode } from '@/lib/workbench/session-store';

function failure(key: string, detail = 'MODEL_ROUTES must configure stage "x"'): ChatNode {
  return {
    key,
    kind: 'system',
    tone: 'error',
    text: '本轮生成失败',
    hint: '可以再说一句让它重试',
    detail,
  };
}

const render = (chat: ChatNode[]) =>
  renderToStaticMarkup(createElement(ChatTimeline, { chat, plan: [] }));

describe('presentSystemNotice', () => {
  it('splits the summary, the hint and the raw cause', () => {
    expect(presentSystemNotice(failure('e1', 'provider 502'))).toEqual({
      tone: 'error',
      summary: '本轮生成失败',
      hint: '可以再说一句让它重试',
      detail: 'provider 502',
    });
  });

  it('defaults an untoned system node to info and a boundary to stopped', () => {
    expect(presentSystemNotice({ key: 'a', kind: 'system', text: '继续' }).tone).toBe('info');
    expect(presentSystemNotice({ key: 'b', kind: 'boundary', text: '本轮生成已停止' }).tone).toBe(
      'stopped',
    );
  });

  it('strips sentence-final punctuation, including the 「.。」 concatenation seam', () => {
    const notice = presentSystemNotice({
      key: 'x',
      kind: 'system',
      tone: 'error',
      text: '本轮生成失败.。',
      hint: '可以再说一句让它重试。',
    });
    expect(notice.summary).toBe('本轮生成失败');
    expect(notice.hint).toBe('可以再说一句让它重试');
  });

  it('flattens whitespace in the summary but keeps the cause readable', () => {
    const notice = presentSystemNotice({
      key: 'x',
      kind: 'system',
      tone: 'error',
      text: '  本轮\n生成失败  ',
      detail: '  Error: boom\n    at run()  \n',
    });
    expect(notice.summary).toBe('本轮 生成失败');
    expect(notice.detail).toBe('Error: boom\n    at run()');
  });

  it('drops a dangling separator on the cause instead of showing 「gateway 524: 」', () => {
    expect(presentSystemNotice(failure('e', 'gateway 524: ')).detail).toBe('gateway 524');
  });

  it('omits an empty hint and an empty cause rather than rendering blank rows', () => {
    const notice = presentSystemNotice({
      key: 'x',
      kind: 'system',
      tone: 'info',
      text: '已从中断处继续生成',
      hint: '   ',
      detail: '  ',
    });
    expect(notice.hint).toBeUndefined();
    expect(notice.detail).toBeUndefined();
  });
});

describe('isSameNotice', () => {
  it('matches two markers only when everything they show matches', () => {
    expect(isSameNotice(failure('e1'), failure('e2'))).toBe(true);
    expect(isSameNotice(failure('e1', 'provider 502'), failure('e2', 'provider 503'))).toBe(false);
  });

  it('never matches across kinds or tones', () => {
    const info: ChatNode = { key: 'i', kind: 'system', tone: 'info', text: '同一句' };
    const error: ChatNode = { key: 'e', kind: 'system', tone: 'error', text: '同一句' };
    const boundary: ChatNode = { key: 'b', kind: 'boundary', text: '同一句' };
    expect(isSameNotice(info, error)).toBe(false);
    expect(isSameNotice(info, boundary)).toBe(false);
  });

  it('is not a rule about speech: identical user or assistant text never merges', () => {
    const said: ChatNode = { key: 'u1', kind: 'user', text: '再来一次' };
    const again: ChatNode = { key: 'u2', kind: 'user', text: '再来一次' };
    expect(isSameNotice(said, again)).toBe(false);
  });
});

describe('repeated notices collapse on render', () => {
  it('five identical failures are one row carrying the count', () => {
    const rows = groupChat([
      { key: 'u', kind: 'user', text: '开始' },
      failure('e1'),
      failure('e2'),
      failure('e3'),
      failure('e4'),
      failure('e5'),
    ]);
    expect(rows).toHaveLength(2);
    // The surviving row keeps the FIRST marker's key, so the row identity is
    // stable as later retries land.
    expect(rows[1].key).toBe('e1');
    expect(rows[1].repeat).toBe(5);
  });

  it('different causes stay separate rows — that is different news', () => {
    const rows = groupChat([failure('e1', 'provider 502'), failure('e2', 'provider 503')]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.repeat)).toEqual([undefined, undefined]);
  });

  it('collapses only back-to-back markers', () => {
    const rows = groupChat([
      failure('e1'),
      { key: 'a', kind: 'assistant', text: '我再试一次' },
      failure('e2'),
    ]);
    expect(rows.map((r) => r.node?.key)).toEqual(['e1', 'a', 'e2']);
  });

  it('collapses repeated stop captions too', () => {
    const stop = (key: string): ChatNode => ({ key, kind: 'boundary', text: '本轮生成已停止' });
    const rows = groupChat([stop('s1'), stop('s2')]);
    expect(rows).toHaveLength(1);
    expect(rows[0].repeat).toBe(2);
  });
});

describe('system notice markup', () => {
  it('prints the summary once, with a count, for a run of identical failures', () => {
    const html = render([failure('e1'), failure('e2'), failure('e3')]);
    expect(html.split('本轮生成失败').length - 1).toBe(1);
    expect(html).toContain(repeatLabel(3));
    expect(html).toContain('相同提示连续出现 3 次');
  });

  it('keeps the raw provider error out of the transcript until it is asked for', () => {
    const html = render([failure('e1', 'MODEL_ROUTES must explicitly configure stage')]);
    expect(html).not.toContain('MODEL_ROUTES');
    // …and offers the disclosure that holds it.
    expect(html).toContain('技术详情');
    expect(html).toContain('可以再说一句让它重试');
  });

  it('gives an error notice a tinted frame and a quiet info notice none', () => {
    expect(render([failure('e1')])).toContain('data-tone="error"');
    const info = render([{ key: 'i', kind: 'system', tone: 'info', text: '已从中断处继续生成' }]);
    expect(info).toContain('data-tone="info"');
    expect(info).not.toContain('技术详情');
  });

  it('renders the stop caption as a caption, not as a notice card', () => {
    const html = render([{ key: 'b', kind: 'boundary', text: '本轮生成已停止' }]);
    expect(html).toContain('workbench-run-boundary');
    expect(html).toContain('本轮生成已停止');
    expect(html).not.toContain('workbench-system-node');
  });
});
