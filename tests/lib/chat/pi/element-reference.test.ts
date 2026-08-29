import { describe, expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import type { StatelessChatRequest } from '@/lib/types/chat';
import {
  ElementReferenceValidationError,
  classifyMediaReference,
  normalizeElementHtml,
  resolveSlideElementReference,
} from '@/lib/chat/pi/element-reference';

const base = {
  id: 'element-1',
  left: 10,
  top: 20,
  width: 300,
  height: 120,
  rotate: 5,
};

function makeBody(element: PPTElement): StatelessChatRequest {
  return {
    messages: [],
    storeState: {
      stage: null,
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          title: 'Evidence page',
          order: 2,
          type: 'slide',
          content: {
            type: 'slide',
            canvas: { elements: [element] },
          },
        },
      ],
      currentSceneId: 'scene-1',
      mode: 'playback',
      whiteboardOpen: false,
    },
    config: { agentIds: ['default-1'] },
    apiKey: '',
    elementReference: {
      kind: 'slide_element',
      sceneId: 'scene-1',
      elementId: 'element-1',
    },
  } as unknown as StatelessChatRequest;
}

function resolve(element: PPTElement) {
  const result = resolveSlideElementReference(makeBody(element));
  expect(result).toBeDefined();
  return result!;
}

describe('slide element reference projector', () => {
  it('projects all 10 canonical element types without inventing line geometry', () => {
    const elements: PPTElement[] = [
      {
        ...base,
        type: 'text',
        content: '<p>Hello <b>world</b></p>',
        defaultFontName: 'Arial',
        defaultColor: '#000',
        textType: 'content',
      },
      { ...base, type: 'latex', latex: 'x^2+y^2', align: 'center' },
      {
        ...base,
        type: 'table',
        outline: {},
        colWidths: [0.5, 0.5],
        rowHeights: [30],
        cellMinHeight: 20,
        data: [[{ id: 'cell-1', text: '<b>A</b>', colspan: 1, rowspan: 1 }]],
        theme: {
          color: '#fff',
          rowHeader: true,
          rowFooter: false,
          colHeader: false,
          colFooter: false,
        },
      },
      {
        ...base,
        type: 'chart',
        chartType: 'bar',
        data: { labels: ['A'], legends: ['Series'], series: [[1]] },
        themeColors: ['#000'],
        options: { stack: true },
      },
      {
        ...base,
        type: 'code',
        language: 'ts',
        fileName: 'main.ts',
        lines: [{ id: 'L1', content: 'let x = 1' }],
      },
      {
        ...base,
        type: 'shape',
        viewBox: [100, 100],
        path: 'SECRET_PATH',
        fixedRatio: false,
        fill: '#fff',
        text: {
          content: '<p>shape label</p>',
          defaultFontName: 'Arial',
          defaultColor: '#000',
          align: 'middle',
        },
        pathFormula: 'triangle',
      },
      {
        id: base.id,
        left: base.left,
        top: base.top,
        width: base.width,
        type: 'line',
        start: [0, 0],
        end: [10, 10],
        style: 'dotted',
        color: '#000',
        points: ['', 'arrow'],
      },
      {
        ...base,
        type: 'image',
        src: 'https://secret.test/image.png',
        fixedRatio: true,
        imageType: 'pageFigure',
      },
      {
        ...base,
        type: 'video',
        src: 'blob:secret-video',
        mediaRef: 'video-ref-secret',
        poster: 'data:image/png;base64,SECRET',
        autoplay: true,
        ext: 'mp4',
      },
      {
        ...base,
        type: 'audio',
        src: 'audio-ref-secret',
        fixedRatio: true,
        color: '#000',
        loop: true,
        autoplay: false,
        ext: 'mp3',
      },
    ] as PPTElement[];

    const packets = elements.map((element) => resolve(element).evidence);
    expect(packets.map((packet) => packet.elementType)).toEqual([
      'text',
      'latex',
      'table',
      'chart',
      'code',
      'shape',
      'line',
      'image',
      'video',
      'audio',
    ]);
    expect(packets[0]).toMatchObject({ content: { text: 'Hello world', textType: 'content' } });
    expect(packets[2]).toMatchObject({ content: { rows: [[{ id: 'cell-1', text: 'A' }]] } });
    expect(packets[5]).not.toHaveProperty('content.path');
    expect(packets[6].geometry).toEqual({ left: 10, top: 20, width: 300 });
  });

  it('uses deterministic Unicode and item bounds with truthful metadata', () => {
    const text = resolve({
      ...base,
      type: 'text',
      content: `<p>${'😀'.repeat(12_001)}</p>`,
      defaultFontName: 'Arial',
      defaultColor: '#000',
      name: '名'.repeat(257),
    });
    expect(
      Array.from(
        (text.evidence as Extract<typeof text.evidence, { elementType: 'text' }>).content.text,
      ),
    ).toHaveLength(12_000);
    expect(text.evidence.truncatedFields).toEqual(
      expect.arrayContaining(['elementName', 'content.text']),
    );

    const chart = resolve({
      ...base,
      type: 'chart',
      chartType: 'line',
      data: {
        labels: Array.from({ length: 101 }, (_, index) => `label-${index}`),
        legends: Array.from({ length: 21 }, (_, index) => `legend-${index}`),
        series: Array.from({ length: 21 }, () => Array.from({ length: 101 }, (_, index) => index)),
      },
      themeColors: [],
    });
    expect(chart.evidence.omittedItems).toMatchObject({
      'content.labels': 1,
      'content.legends': 1,
      'content.series': 1,
      'content.series[0]': 1,
    });

    const code = resolve({
      ...base,
      type: 'code',
      language: 'ts',
      lines: Array.from({ length: 201 }, (_, index) => ({
        id: `L${index}`,
        content: 'x'.repeat(512),
      })),
    });
    const codeEvidence = code.evidence as Extract<typeof code.evidence, { elementType: 'code' }>;
    expect(codeEvidence.content.lines).toHaveLength(24);
    expect(codeEvidence.omittedItems['content.lines']).toBe(177);
    expect(
      codeEvidence.content.lines.reduce((sum, line) => sum + Array.from(line.content).length, 0),
    ).toBe(12_000);
  });

  it('classifies media without exposing raw references or substrings', () => {
    expect(classifyMediaReference(undefined)).toEqual({ kind: 'absent' });
    expect(classifyMediaReference('data:secret-marker')).toEqual({ kind: 'embedded' });
    expect(classifyMediaReference('blob:secret-marker')).toEqual({ kind: 'local' });
    expect(classifyMediaReference('https://secret-marker.test')).toEqual({ kind: 'external' });
    expect(classifyMediaReference('opaque-secret-marker')).toEqual({ kind: 'reference' });

    const packet = resolve({
      ...base,
      type: 'video',
      src: 'https://src-secret-marker.test/video',
      mediaRef: 'opaque-media-secret-marker',
      poster: 'data:image/png;base64,poster-secret-marker',
      autoplay: false,
    });
    const serialized = JSON.stringify(packet.evidence);
    expect(serialized).not.toContain('src-secret-marker');
    expect(serialized).not.toContain('media-secret-marker');
    expect(serialized).not.toContain('poster-secret-marker');
  });

  it('projects renderer-tolerated legacy Charts with missing data arrays as empty evidence', () => {
    const chart = {
      ...base,
      type: 'chart',
      chartType: 'line',
      themeColors: [],
    };

    const missingData = resolve(chart as unknown as PPTElement).evidence as Extract<
      ReturnType<typeof resolve>['evidence'],
      { elementType: 'chart' }
    >;
    expect(missingData.content).toMatchObject({ labels: [], legends: [], series: [] });

    const missingLabels = resolve({
      ...chart,
      data: { legends: ['Series'], series: [[180, 88]] },
    } as unknown as PPTElement).evidence as typeof missingData;
    expect(missingLabels.content).toMatchObject({
      labels: [],
      legends: ['Series'],
      series: [[180, 88]],
    });

    const missingSeries = resolve({
      ...chart,
      data: { labels: ['First'], legends: ['Series'] },
    } as unknown as PPTElement).evidence as typeof missingData;
    expect(missingSeries.content).toMatchObject({
      labels: ['First'],
      legends: ['Series'],
      series: [],
    });
  });

  it('strictly rejects malformed, stale, duplicate, non-slide, and unsupported references', () => {
    const element = {
      ...base,
      type: 'text',
      content: 'hello',
      defaultFontName: 'Arial',
      defaultColor: '#000',
    } as PPTElement;
    const extraKey = makeBody(element) as StatelessChatRequest & {
      elementReference: Record<string, unknown>;
    };
    extraKey.elementReference.extra = 'browser-content';
    expect(() => resolveSlideElementReference(extraKey)).toThrow(ElementReferenceValidationError);

    const stale = makeBody(element);
    stale.elementReference!.elementId = 'missing';
    expect(() => resolveSlideElementReference(stale)).toThrow(/exactly one element/);

    const duplicate = makeBody(element);
    duplicate.storeState.scenes.push(duplicate.storeState.scenes[0]);
    expect(() => resolveSlideElementReference(duplicate)).toThrow(/exactly one Scene/);

    const nonSlide = makeBody(element);
    nonSlide.storeState.scenes[0] = {
      ...nonSlide.storeState.scenes[0],
      type: 'quiz',
      content: { type: 'quiz', questions: [] },
    } as never;
    expect(() => resolveSlideElementReference(nonSlide)).toThrow(/slide Scene/);

    const unsupported = makeBody({ ...element, type: 'future-element' } as never);
    expect(() => resolveSlideElementReference(unsupported)).toThrow(/unsupported element type/);
  });

  it('normalizes HTML by replacing tag boundaries and collapsing whitespace', () => {
    expect(normalizeElementHtml('<p>A</p><p> B <b>C</b></p>')).toBe('A B C');
  });

  it('omits script and style blocks instead of exposing their source as visible text', () => {
    expect(
      normalizeElementHtml(
        '<p>Visible</p><style media="screen">.secret { color: red; }</style><SCRIPT>alert(1)</SCRIPT><p>After</p>',
      ),
    ).toBe('Visible After');
  });
});
