import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ChatTimeline,
  collapseAdjacentThinking,
  groupChat,
  rowsForRender,
} from '@/components/workbench/chat/chat-timeline';
import { I18nProvider } from '@/lib/hooks/use-i18n';
import type { ChatNode } from '@/lib/workbench/session-store';

function tool(name: string, key = name): ChatNode {
  return { key, kind: 'tool', text: '', toolName: name, toolState: 'done' };
}

function skillRead(id: string, key = id): ChatNode {
  return {
    key,
    kind: 'tool',
    text: '',
    toolName: 'read',
    toolState: 'done',
    toolArgs: { path: `/app/skills/agent-runtime/${id}/SKILL.md` },
  };
}

function thinking(key: string, text = '先想一步'): ChatNode {
  return { key, kind: 'thinking', text };
}

function kindsOf(rows: ReturnType<typeof groupChat>) {
  return rows.flatMap((r) =>
    r.group
      ? r.group.map((n) => (n.kind === 'tool' ? n.toolName : n.kind))
      : r.node?.kind === 'tool'
        ? [r.node.toolName]
        : [r.node?.kind],
  );
}

describe('groupChat', () => {
  it('does not render the retired finish tool card', () => {
    const rows = groupChat([
      { key: 'u', kind: 'user', text: '开始' },
      tool('generate_scene', 'g1'),
      tool('finish', 'f1'),
      { key: 'a', kind: 'assistant', text: '写完了' },
    ]);
    expect(kindsOf(rows)).toEqual(['user', 'generate_scene', 'assistant']);
  });

  it('renders material-workflow tool calls again', () => {
    const rows = groupChat([
      { key: 'u', kind: 'user', text: '读这份 PDF' },
      tool('list_materials', 'l1'),
      tool('read_material', 'r1'),
      tool('search_material', 's1'),
      tool('use_material_media', 'u1'),
      { key: 'a', kind: 'assistant', text: '读完了' },
    ]);
    expect(kindsOf(rows)).toEqual([
      'user',
      'list_materials',
      'read_material',
      'search_material',
      'use_material_media',
      'assistant',
    ]);
  });

  it('clusters consecutive thinking and tool bars into one stack', () => {
    const rows = groupChat([
      { key: 'u', kind: 'user', text: '开始' },
      thinking('th1'),
      tool('generate_outline', 'g0'),
      thinking('th2', '再写第一页'),
      tool('generate_scene', 'g1'),
      { key: 'w', kind: 'waiting', text: '' },
      { key: 'a', kind: 'assistant', text: '写完了' },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.node?.kind).toBe('user');
    expect(kindsOf([rows[1]!])).toEqual([
      'thinking',
      'generate_outline',
      'thinking',
      'generate_scene',
      'waiting',
    ]);
    expect(rows[2]?.node?.kind).toBe('assistant');
  });

  it('keeps a visible material call in its action cluster', () => {
    const rows = groupChat([
      thinking('th1'),
      tool('generate_scene', 'g1'),
      tool('search_material', 's1'),
      tool('generate_scene', 'g2'),
    ]);
    expect(rows).toHaveLength(1);
    expect(kindsOf(rows)).toEqual([
      'thinking',
      'generate_scene',
      'search_material',
      'generate_scene',
    ]);
  });

  it('keeps user and assistant prose outside the action cluster', () => {
    const rows = groupChat([
      { key: 'u', kind: 'user', text: '改一下' },
      thinking('th1'),
      tool('generate_scene', 'g1'),
      { key: 'a', kind: 'assistant', text: '好了' },
      thinking('th2'),
      tool('generate_scene', 'g2'),
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[0]?.node?.kind).toBe('user');
    expect(rows[1]?.group?.map((n) => n.kind)).toEqual(['thinking', 'tool']);
    expect(rows[2]?.node?.kind).toBe('assistant');
    expect(rows[3]?.group?.map((n) => n.kind)).toEqual(['thinking', 'tool']);
  });

  it('merges consecutive thinking bars left by hidden tool calls', () => {
    // The retired `finish` tool leaves the thinking bars around it adjacent,
    // and those collapse into one, spanning the whole stretch.
    const rows = rowsForRender([
      thinking('t1', '先找 HTML'),
      tool('finish', 'f1'),
      thinking('t2', '再看一眼结构'),
      tool('finish', 'f2'),
      thinking('t3', '可以改了'),
    ]);
    expect(kindsOf(rows)).toEqual(['thinking']);
    const nodes = rows[0]?.group ?? (rows[0]?.node ? [rows[0].node] : []);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'thinking', text: '可以改了' });
  });

  it('paints the trailing waiting bar after a send, then drops it once thinking starts', () => {
    const afterSend = rowsForRender([
      { key: 'u', kind: 'user', text: '改一下' },
      { key: 'w', kind: 'waiting', text: '' },
    ]);
    expect(kindsOf(afterSend)).toEqual(['user', 'waiting']);
    const afterThink = rowsForRender([
      { key: 'u', kind: 'user', text: '改一下' },
      thinking('th1'),
      tool('generate_scene', 'g1'),
      { key: 'w2', kind: 'waiting', text: '' },
    ]);
    expect(kindsOf(afterThink)).toEqual(['user', 'thinking', 'generate_scene', 'waiting']);
  });
});

describe('rowsForRender tool-run aggregation', () => {
  it('keeps the tool-run aggregate when a thinking bar follows the tools', () => {
    // Regression: tools + a trailing thinking bar used to land in one mixed
    // cluster, where ActionCluster aggregated only when EVERY bar was a tool
    // — so the "2 tool calls" head dissolved into three loose cards.
    const rows = rowsForRender([
      tool('read_scene', 'r1'),
      tool('read_scene', 'r2'),
      thinking('th1', '再想一步'),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.group?.map((n) => n.kind)).toEqual(['tool', 'tool']);
    expect(rows[1]?.node).toMatchObject({ kind: 'thinking', key: 'th1' });
  });

  it('keeps the tool-run aggregate when a thinking bar precedes the tools', () => {
    const rows = rowsForRender([
      thinking('th1', '先看一眼'),
      tool('read_scene', 'r1'),
      tool('read_scene', 'r2'),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.node?.kind).toBe('thinking');
    expect(rows[1]?.group?.map((n) => n.kind)).toEqual(['tool', 'tool']);
  });

  it('splits a cluster when thinking sits between two tool calls — no aggregate across the bar', () => {
    // The two tools are not consecutive, so they are not one run: each renders
    // on its own with the thinking bar between them.
    const rows = rowsForRender([
      tool('read_scene', 'r1'),
      thinking('th1'),
      tool('read_scene', 'r2'),
    ]);
    expect(rows).toHaveLength(3);
    expect(kindsOf(rows)).toEqual(['read_scene', 'thinking', 'read_scene']);
    expect(rows[0]?.group).toBeUndefined();
    expect(rows[2]?.group).toBeUndefined();
  });

  it('keeps a SKILL.md read out of the ordinary tool-call aggregate', () => {
    const rows = rowsForRender([
      skillRead('pptx-import', 's1'),
      tool('edit_deck', 'i1'),
      tool('list_scenes', 'g1'),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.node).toMatchObject({ toolName: 'read', key: 's1' });
    expect(rows[1]?.group?.map((node) => node.toolName)).toEqual(['edit_deck', 'list_scenes']);
  });

  it('aggregates consecutive skill loads separately from tools', () => {
    const rows = rowsForRender([
      skillRead('pptx-import', 's1'),
      skillRead('pro-editing', 's2'),
      tool('patch_stage', 'e1'),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.group?.map((node) => node.key)).toEqual(['s1', 's2']);
    expect(rows[1]?.node?.toolName).toBe('patch_stage');
  });

  it('renders a skill load as its own bar, not folded into N 个工具调用', () => {
    const html = renderToStaticMarkup(
      createElement(ChatTimeline, {
        chat: [skillRead('pptx-import', 's1'), tool('edit_deck', 'i1'), tool('list_scenes', 'g1')],
        plan: [],
      }),
    );
    expect(html).toContain('workbench-skill-card');
    expect(html).toContain('加载 skill');
    expect(html).toContain('pptx-import');
    expect(html).toContain('data-kind="skill"');
    expect(html).toContain('2 个工具调用');
    expect(html).toContain('workbench-tool-group');
    expect(html).not.toContain('3 个工具调用');
    expect(html).not.toContain('workbench-skill-group');
  });

  it('renders consecutive skill loads as a skill group, not a tool group', () => {
    const html = renderToStaticMarkup(
      createElement(ChatTimeline, {
        chat: [skillRead('pptx-import', 's1'), skillRead('pro-editing', 's2')],
        plan: [],
      }),
    );
    expect(html).toContain('workbench-skill-group');
    expect(html).toContain('2 个 skill');
    expect(html).not.toContain('2 个工具调用');
    expect(html).not.toContain('workbench-tool-group');
  });

  it('renders the aggregate head plus the thinking bar when thinking follows the tools', () => {
    const html = renderToStaticMarkup(
      createElement(ChatTimeline, {
        chat: [tool('read_scene', 'r1'), tool('read_scene', 'r2'), thinking('th1', '再想一步')],
        plan: [],
      }),
    );
    expect(html).toContain('workbench-tool-group');
    expect(html).toContain('2 个工具调用');
    expect(html).toContain('已完成');
    expect(html).toContain('workbench-thinking-bar');
  });

  it('mounts a settled group folded, with its cards clipped rather than unmounted', () => {
    const html = renderToStaticMarkup(
      createElement(ChatTimeline, {
        chat: [tool('read_scene', 'r1'), tool('read_scene', 'r2')],
        plan: [],
      }),
    );
    // A replayed timeline is folded on its first frame (nothing animates at
    // mount), but the cards stay in the DOM behind a clipped `0fr` row — that
    // row is what the collapse/expand transition animates — and the folded
    // subtree is inert so it keeps no tab stops.
    expect(html).toContain('data-open="false"');
    expect(html).toContain('grid-rows-[0fr]');
    expect(html).toContain('workbench-tool-card');
    expect(html).toContain('inert');
  });

  it('renders quiet material states without leaking internal payloads', () => {
    const running = tool('list_materials', 'list-running');
    running.toolState = 'running';
    running.toolArgs = { materialId: 'mat_private_running' };
    running.toolTraces = ['list_materials mat_private_running'];
    const failed = tool('read_material', 'read-failed');
    failed.toolDetails = {
      materials: [{ materialId: 'mat_private_failed', status: 'failed' }],
    };
    failed.toolResultText = '{"materialId":"mat_private_failed","status":"failed"}';

    const html = renderToStaticMarkup(
      createElement(ChatTimeline, { chat: [running, failed], plan: [] }),
    );
    expect(html).toContain('检查材料');
    expect(html).toContain('读取材料');
    expect(html).toContain('材料解析失败');
    expect(html).toContain('data-status="running"');
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('data-status="error"');
    expect(html).not.toContain('list_materials');
    expect(html).not.toContain('read_material');
    expect(html).not.toContain('mat_private');
    expect(html).not.toContain('结果原文');
  });

  it('marks a settled material-tool group as failed when extraction failed semantically', () => {
    const failed = tool('read_material', 'read-failed');
    failed.toolDetails = { materials: [{ status: 'failed' }] };
    const html = renderToStaticMarkup(
      createElement(ChatTimeline, {
        chat: [failed, tool('search_material', 'search-done')],
        plan: [],
      }),
    );
    expect(html).toContain('有错误');
  });
});

describe('collapseAdjacentThinking timing bound', () => {
  it('merges frozen bars and streaming bars separately, never across the line', () => {
    const frozen: ChatNode = {
      key: 't1',
      kind: 'thinking',
      text: '想完了',
      streaming: false,
      startedAt: 1000,
      endedAt: 4000,
    };
    const live: ChatNode = { key: 't2', kind: 'thinking', text: '还在想', streaming: true };
    // A frozen bar followed by a streaming one: merging would inherit 4000 as
    // endedAt and then keep growing it when the live bar settles — a finished
    // bar whose duration changes after the fact. Keep them apart.
    expect(collapseAdjacentThinking([frozen, live])).toHaveLength(2);
    expect(collapseAdjacentThinking([live, frozen])).toHaveLength(2);
    // Same state on both sides merges as before.
    expect(collapseAdjacentThinking([frozen, { ...frozen, key: 't3' }])).toHaveLength(1);
    expect(
      collapseAdjacentThinking([live, { ...live, key: 't4', text: '还在想更多' }]),
    ).toHaveLength(1);
  });
});

describe('course rows', () => {
  it('renders a card for every classroom the turn carried', () => {
    // The fold hands the row a turn's own ordered set. Rendering must open THOSE
    // courses — not the session's birth stage (which is null here and would
    // render nothing), and not whatever store metadata the workspace happens to
    // hold. Without a navigation provider each link falls back to the course id
    // itself, which is exactly what the assertion reads.
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(ChatTimeline, {
          chat: [
            { key: 'e42', kind: 'course', text: '', stageIds: ['stage-edit', 'stage-second'] },
          ],
          plan: [],
        }),
      ),
    );
    expect(markup).toContain('stage-edit');
    expect(markup).toContain('stage-second');
  });
});
