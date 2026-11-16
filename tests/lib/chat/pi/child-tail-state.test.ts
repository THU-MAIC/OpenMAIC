import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { PPTElement } from '@openmaic/dsl';
import type { WhiteboardRuntimeService } from '@/lib/whiteboard/runtime/store';
import {
  CHILD_STATE_PREFIX,
  createChildTailStateTransform,
  summarizeChildElement,
} from '@/lib/chat/pi/child-tail-state';

const decode = (messages: AgentMessage[]) =>
  JSON.parse((messages.at(-1) as { content: string }).content.slice(CHILD_STATE_PREFIX.length))
    .whiteboard;
const service = (read: unknown) => ({ read }) as WhiteboardRuntimeService;

describe('Native child board projection', () => {
  it('uses drawing-tool coordinates, markers, plain text and visual properties without direction labels', () => {
    expect(
      summarizeChildElement({
        id: 'arrow',
        type: 'line',
        left: 100,
        top: 200,
        start: [80, 10],
        end: [-20, 30],
        width: 3,
        points: ['', 'arrow'],
        color: '#ff0000',
        style: 'solid',
      } as PPTElement),
    ).toEqual({
      id: 'arrow',
      type: 'line',
      text: '',
      x: 80,
      y: 210,
      height: 20,
      startX: 180,
      startY: 210,
      endX: 80,
      endY: 230,
      points: ['', 'arrow'],
      width: 3,
      color: '#ff0000',
      style: 'solid',
    });
    expect(
      summarizeChildElement({
        id: 'label',
        type: 'text',
        left: 10,
        top: 20,
        width: 100,
        height: 30,
        rotate: 0,
        content: '<p>A &amp; B<br>月球</p>',
        defaultColor: '#123456',
      } as PPTElement),
    ).toEqual({
      id: 'label',
      type: 'text',
      x: 10,
      y: 20,
      width: 100,
      height: 30,
      rotate: 0,
      content: 'A & B\n月球',
      color: '#123456',
    });
    expect(
      summarizeChildElement({
        id: 'half',
        type: 'shape',
        left: 20,
        top: 40,
        width: 30,
        height: 30,
        rotate: 90,
        fill: '#ffff00',
        outline: { color: '#000', width: 2, style: 'solid' },
        path: 'M1 0 A1 1 0 0 0 1 2 Z',
        viewBox: [2, 2],
      } as PPTElement),
    ).toMatchObject({
      fillColor: '#ffff00',
      stroke: { color: '#000', width: 2, style: 'solid' },
      path: 'M1 0 A1 1 0 0 0 1 2 Z',
      viewBox: [2, 2],
      rotate: 90,
    });
  });

  it('preserves chart facts and code line identities needed by existing tools', () => {
    const chart = {
      id: 'chart',
      type: 'chart',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      chartType: 'bar',
      data: { labels: ['A'], legends: ['Series'], series: [[2]] },
      themeColors: ['#3366ff'],
    } as PPTElement;
    expect(summarizeChildElement(chart)).toMatchObject({
      chartType: 'bar',
      data: { labels: ['A'], series: [[2]] },
      themeColors: ['#3366ff'],
    });
    const code = {
      id: 'code',
      type: 'code',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      language: 'javascript',
      lines: [{ id: 'line-1', content: 'const x = 2;' }],
      fontSize: 16,
    } as PPTElement;
    const codeSummary = summarizeChildElement(code);
    expect(codeSummary).toMatchObject({
      id: 'code',
      language: 'javascript',
      lines: [{ id: 'line-1', content: 'const x = 2;' }],
      fontSize: 16,
    });
    expect(codeSummary).not.toHaveProperty('text');
  });

  it('reads the bound stage afresh without accumulating snapshots in history', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: null, whiteboard: null, lastSeq: null })
      .mockResolvedValueOnce({
        sessionId: 'learner-a-session',
        lastSeq: 2,
        whiteboard: { id: 'board-a', viewportSize: 800, viewportRatio: 0.75, elements: [] },
      });
    const transform = createChildTailStateTransform({ service: service(read), stageId: 'stage-a' });
    const history: AgentMessage[] = [{ role: 'user', content: 'Draw', timestamp: 0 }];
    const original = structuredClone(history);
    expect(decode(await transform(history))).toMatchObject({
      status: 'ok',
      lastSeq: null,
      exists: false,
      elements: [],
    });
    const next = await transform(history);
    expect(next).toHaveLength(2);
    expect(decode(next)).toMatchObject({
      stageId: 'stage-a',
      sessionId: 'learner-a-session',
      lastSeq: 2,
      canvas: { width: 800, height: 600 },
    });
    expect(read.mock.calls).toEqual([['stage-a'], ['stage-a']]);
    expect(history).toEqual(original);
    expect(next).not.toBe(history);
  });

  it('distinguishes unavailable and failed reads from an empty board', async () => {
    expect(decode(await createChildTailStateTransform({})([]))).toEqual({
      status: 'unavailable',
      stageId: null,
    });
    const read = vi.fn().mockRejectedValue(new Error('private backend detail'));
    const result = decode(
      await createChildTailStateTransform({ service: service(read), stageId: 'stage-b' })([]),
    );
    expect(result).toEqual({
      status: 'read_failed',
      stageId: 'stage-b',
      code: 'WHITEBOARD_READ_FAILED',
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation before and after the read', async () => {
    const before = new AbortController();
    before.abort();
    const read = vi.fn();
    const transform = createChildTailStateTransform({ service: service(read), stageId: 'stage-a' });
    await expect(transform([], before.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
    const during = new AbortController();
    read.mockImplementation(async () => {
      during.abort();
      return { sessionId: null, whiteboard: null, lastSeq: null };
    });
    await expect(transform([], during.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
