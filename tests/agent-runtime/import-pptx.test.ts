import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Slide } from '@openmaic/dsl';
import type { AgentSessionMaterial } from '@openmaic/storage';

import {
  buildCourseAllowlist,
  buildDslCourseToolset,
  DSL_TOOLS_PROMPT,
  type CourseDocument,
  type CourseStore,
} from '@/lib/server/agent-runtime/course-tools';
import {
  IMPORT_PPTX_TOOL_NAME,
  MAX_IMPORT_SLIDES,
  PPTX_MIME,
  parsePptxBuffer,
  parsePptxIsolated,
  slidesToScenes,
  titleFromSlide,
  toArrayBuffer,
  isPptxMaterial,
} from '@/lib/server/agent-runtime/import-pptx';
import { installNodeXmlHttpRequest, NodeXMLHttpRequest } from '@/lib/server/agent-runtime/node-xhr';
import { sessionMaterialsPromptBlock } from '@/lib/server/agent-runtime/session-materials';
import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import type { Scene } from '@/lib/types/stage';
import type { PPTTextElement } from '@openmaic/dsl';

function makeStore(initial: CourseDocument | null = null): CourseStore {
  let doc = initial;
  return {
    async loadDocument(_stageId?: string) {
      return doc;
    },
    async saveDocument(next: CourseDocument) {
      doc = next;
    },
    async putScene(_stageId: string, scene: Scene) {
      if (!doc) throw new Error('no document');
      const scenes = doc.scenes.filter((item) => item.id !== scene.id);
      scenes.push(scene);
      scenes.sort((a, b) => a.order - b.order);
      doc = { ...doc, scenes };
    },
  } as unknown as CourseStore;
}

/**
 * A store pre-loaded with the document `create_stage` would have minted: the
 * stage's own identity (its create_stage title), no pages, and the outline
 * envelope. `import_pptx` fills pages INTO this stage; it never replaces the
 * identity.
 */
function stageStore(scenes: Scene[] = [], outline: Partial<AppDocumentOutline> = {}): CourseStore {
  return makeStore({
    stage: {
      id: 'stage-import',
      name: '已有课堂',
      agentIds: [],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as CourseDocument['stage'],
    scenes,
    outline: {
      outlines: [],
      requirement: '已有课堂',
      generationComplete: false,
      producer: 'server-job',
      createdAt: 1,
      updatedAt: 1,
      ...outline,
    } satisfies AppDocumentOutline,
  });
}

function slideScene(id: string, order: number, title: string): Scene {
  return {
    id,
    stageId: 'stage-import',
    order,
    title,
    type: 'slide',
    // generate_scene pages carry an outline id on the stage-wide p<seq> sequence.
    outlineId: `p${order}`,
    content: { type: 'slide', canvas: textSlide(id, `<p>${title}</p>`) },
    actions: [],
  } as Scene;
}

function textSlide(id: string, html: string, script?: string): Slide {
  return {
    id,
    viewportSize: 1280,
    viewportRatio: 0.5625,
    theme: {
      backgroundColor: '#ffffff',
      themeColors: ['#2563eb'],
      fontColor: '#111827',
      fontName: 'Inter',
    },
    elements: [
      {
        id: `${id}-title`,
        type: 'text',
        left: 40,
        top: 40,
        width: 800,
        height: 80,
        rotate: 0,
        content: html,
        defaultFontName: 'Inter',
        defaultColor: '#111',
      } as PPTTextElement,
    ],
    ...(script ? { script } : {}),
  };
}

function sourceRecord(overrides: Partial<AgentSessionMaterial> = {}): AgentSessionMaterial {
  return {
    id: 'mat_ppt',
    sessionId: 'ses_1',
    kind: 'source',
    title: '细胞结构.pptx',
    sourceUrl: null,
    textAssetId: null,
    rawAssetId: 'ast_raw_ppt',
    textChars: 0,
    derivedFrom: null,
    extraction: { status: 'idle' as const, attempts: 0 },
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

/** The digest the importer derives from a deck's bytes for its idempotency key. */
function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function runImport(
  store: CourseStore,
  args: {
    params: { materialId: string; atOrder?: number };
    record?: AgentSessionMaterial | null;
    slides?: Slide[];
    signal?: AbortSignal;
    bytes?: Buffer;
    mime?: string;
  },
) {
  const checkpoints: { tool: string; detail: string }[] = [];
  const tools = buildDslCourseToolset({
    stageAccess: async () => ({ kind: 'owned' as const }),
    store,
    sessionId: 'ses_1',
    onCheckpoint: (info) => checkpoints.push({ tool: info.tool, detail: info.detail }),
    getMaterial: async () => args.record ?? null,
    readMaterialBytes: async (record) => ({
      bytes: args.bytes ?? Buffer.from(`deck-${record.id}`),
      mime: args.mime ?? PPTX_MIME,
    }),
    parsePptx: async () => args.slides ?? [textSlide('s1', '<p>封面</p>')],
  });
  const tool = tools.find((item) => item.name === IMPORT_PPTX_TOOL_NAME);
  if (!tool) throw new Error('import_pptx missing');
  const result = (await tool.execute('call-1', args.params as never, args.signal)) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
    details: Record<string, unknown>;
  };
  return { result, store, checkpoints };
}

describe('import_pptx helpers', () => {
  it('recognizes pptx by mime or filename', () => {
    expect(isPptxMaterial({ mime: PPTX_MIME })).toBe(true);
    expect(isPptxMaterial({ mime: 'application/pdf', originalName: 'deck.pptx' })).toBe(true);
    expect(isPptxMaterial({ mime: 'application/pdf', originalName: 'notes.pdf' })).toBe(false);
  });

  it('takes the first text element as the page title and maps speaker notes to speech', () => {
    const slide = textSlide('s1', '<p>减数分裂</p>', '先复习染色体。');
    expect(titleFromSlide(slide, 0)).toBe('减数分裂');
    const { scenes, outlines } = slidesToScenes([slide], 'stage-import');
    expect(scenes[0]?.title).toBe('减数分裂');
    expect(scenes[0]?.outlineId).toBe(outlines[0]?.id);
    expect(scenes[0]?.actions).toEqual([
      { id: `speech-${scenes[0]!.id}`, type: 'speech', text: '先复习染色体。' },
    ]);
  });

  it('keeps importer-produced HTML byte-exact in the slide DSL', () => {
    const html =
      '<div data-importer="raw" renderer-unknown="kept" style="line-height:1.2;white-space:pre-wrap;padding:3px;color:#aBc123;background:rgb(1, 2, 3);future-css:value"> 导入\n原样 </div>';
    const { scenes } = slidesToScenes([textSlide('s1', html)], 'stage-import');
    const content = scenes[0]?.content;
    expect(content?.type).toBe('slide');
    if (content?.type !== 'slide') throw new Error('expected imported slide');
    expect((content.canvas.elements[0] as PPTTextElement).content).toBe(html);
  });

  it('numbers appended scenes from firstOrder and keeps outline ids on the stage-wide sequence', () => {
    const { scenes, outlines } = slidesToScenes(
      [textSlide('s1', '<p>甲</p>'), textSlide('s2', '<p>乙</p>')],
      'stage-import',
      { firstOrder: 2, firstPageSeq: 4 },
    );
    expect(scenes.map((scene) => `${scene.order}:${scene.id}:${scene.outlineId}`)).toEqual([
      '2:scene-p4:p4',
      '3:scene-p5:p5',
    ]);
    expect(outlines.map((outline) => `${outline.order}:${outline.id}`)).toEqual(['2:p4', '3:p5']);
  });
});

describe('import_pptx tool', () => {
  it('is registered on the course toolset and allowlist', () => {
    expect(buildCourseAllowlist()).toContain(IMPORT_PPTX_TOOL_NAME);
    expect(DSL_TOOLS_PROMPT).toContain('import_pptx');
    expect(DSL_TOOLS_PROMPT).toContain('pptx-import');
    expect(DSL_TOOLS_PROMPT).toContain('layout-preserving import');
    const tools = buildDslCourseToolset({
      stageAccess: async () => ({ kind: 'owned' as const }),
      store: makeStore(),
      onCheckpoint: () => {},
    });
    expect(tools.some((tool) => tool.name === IMPORT_PPTX_TOOL_NAME)).toBe(true);
  });

  it('appends one slide page per imported slide into the stage and keeps the stage title', async () => {
    const store = stageStore();
    const bytes = Buffer.from('fake-pptx');
    const { result, checkpoints } = await runImport(store, {
      params: { materialId: 'mat_ppt' },
      record: sourceRecord(),
      bytes,
      slides: [textSlide('s1', '<p>封面</p>', '欢迎上课。'), textSlide('s2', '<p>目录</p>')],
    });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      pages: 2,
      notesPages: 1,
      firstOrder: 1,
      courseTitle: '已有课堂',
    });
    expect(result.details).not.toHaveProperty('reused');
    const doc = await store.loadDocument('stage-import');
    // The stage's own identity survives: create_stage owns the title, never the PPT.
    expect(doc?.stage.name).toBe('已有课堂');
    expect(doc?.scenes.map((scene) => scene.order)).toEqual([1, 2]);
    expect(doc?.scenes.map((scene) => scene.title)).toEqual(['封面', '目录']);
    expect(doc?.outline).toMatchObject({
      generationComplete: true,
      requirement: `import_pptx:sha256:${digestOf(bytes)}`,
      producer: 'server-job',
    });
    expect(
      (doc?.outline as AppDocumentOutline | undefined)?.pptxImports?.[
        `import_pptx:sha256:${digestOf(bytes)}`
      ]?.sceneIds,
    ).toEqual(['scene-p1', 'scene-p2']);
    expect(checkpoints[0]?.tool).toBe(IMPORT_PPTX_TOOL_NAME);
    const text = String(
      result.content[0] && 'text' in result.content[0] ? result.content[0].text : '',
    );
    expect(text).toContain('set_roster');
    expect(text).toContain('render_scene_preview');
    expect(text).toContain('pro-editing');
    expect(text).toContain('patch_stage');
    expect(text).toMatch(/Do not patch actions or generate_tts before inspection/);
  });

  it('is idempotent for the same material: returns the existing receipt, never appends again', async () => {
    const store = stageStore();
    const bytes = Buffer.from('fake-pptx');
    const slides = [textSlide('s1', '<p>封面</p>')];
    await runImport(store, {
      params: { materialId: 'mat_ppt' },
      record: sourceRecord(),
      bytes,
      slides,
    });
    const { result } = await runImport(store, {
      params: { materialId: 'mat_ppt' },
      record: sourceRecord(),
      bytes,
      slides: [textSlide('s1', '<p>被改过</p>'), textSlide('s2', '<p>多一页</p>')],
    });
    expect(result.details).toMatchObject({ reused: true, pages: 1, pageOrders: [1] });
    const text = String(
      result.content[0] && 'text' in result.content[0] ? result.content[0].text : '',
    );
    expect(text).toContain('already imported');
    expect(text).toContain('pro-editing');
    expect(text).toMatch(/Do not patch actions or generate_tts before inspection/);
    const doc = await store.loadDocument('stage-import');
    expect(doc?.scenes).toHaveLength(1);
    expect(doc?.scenes[0]?.title).toBe('封面');
  });

  it('treats a re-upload of the same PowerPoint (same bytes) as the same import', async () => {
    const store = stageStore();
    const bytes = Buffer.from('fake-pptx');
    await runImport(store, {
      params: { materialId: 'mat_ppt' },
      record: sourceRecord(),
      bytes,
      slides: [textSlide('s1', '<p>封面</p>')],
    });
    // Same bytes, new mat_ id: the sha256 idempotency key still matches.
    const { result } = await runImport(store, {
      params: { materialId: 'mat_ppt2' },
      record: sourceRecord({ id: 'mat_ppt2' }),
      bytes,
      slides: [textSlide('s1', '<p>被改过</p>'), textSlide('s2', '<p>多一页</p>')],
    });
    expect(result.details).toMatchObject({ reused: true, pages: 1, materialId: 'mat_ppt2' });
    const doc = await store.loadDocument('stage-import');
    expect(doc?.scenes).toHaveLength(1);
  });

  it('appends after existing pages with consecutive numbering', async () => {
    const store = stageStore([slideScene('scene-old', 1, '旧页')]);
    const { result } = await runImport(store, {
      params: { materialId: 'mat_ppt' },
      record: sourceRecord(),
      slides: [textSlide('s1', '<p>封面</p>'), textSlide('s2', '<p>目录</p>')],
    });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ pages: 2, firstOrder: 2, pageOrders: [2, 3] });
    const doc = await store.loadDocument('stage-import');
    expect(doc?.scenes.map((scene) => `${scene.order}:${scene.title}`)).toEqual([
      '1:旧页',
      '2:封面',
      '3:目录',
    ]);
    // The pre-existing page keeps its id and content — a normal premise, not a conflict.
    expect(doc?.scenes[0]?.id).toBe('scene-old');
  });

  it('inserts at atOrder and shifts pages at and beyond it back', async () => {
    const store = stageStore([
      slideScene('scene-1', 1, '第一页'),
      slideScene('scene-2', 2, '第二页'),
      slideScene('scene-3', 3, '第三页'),
    ]);
    const { result } = await runImport(store, {
      params: { materialId: 'mat_ppt', atOrder: 2 },
      record: sourceRecord(),
      slides: [textSlide('s1', '<p>插一</p>'), textSlide('s2', '<p>插二</p>')],
    });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ pages: 2, firstOrder: 2, pageOrders: [2, 3] });
    const doc = await store.loadDocument('stage-import');
    expect(doc?.scenes.map((scene) => `${scene.order}:${scene.title}`)).toEqual([
      '1:第一页',
      '2:插一',
      '3:插二',
      '4:第二页',
      '5:第三页',
    ]);
    // Imported outline ids stay on the stage-wide sequence (no p2/p3 collision).
    expect(doc?.scenes.slice(1, 3).map((scene) => scene.outlineId)).toEqual(['p4', 'p5']);
  });

  it('shifts snapshot outline entries at and beyond atOrder with the scenes', async () => {
    const store = stageStore(
      [slideScene('scene-1', 1, '第一页'), slideScene('scene-2', 2, '第二页')],
      {
        outlines: [
          {
            id: 'p1',
            order: 1,
            title: '第一页',
            type: 'slide',
            description: '第一页的brief',
            keyPoints: [],
          },
          {
            id: 'p2',
            order: 2,
            title: '第二页',
            type: 'slide',
            description: '第二页的brief',
            keyPoints: [],
          },
        ],
      },
    );
    const { result } = await runImport(store, {
      params: { materialId: 'mat_ppt', atOrder: 2 },
      record: sourceRecord(),
      slides: [textSlide('s1', '<p>插一</p>')],
    });
    expect(result.isError).toBeUndefined();
    const doc = await store.loadDocument('stage-import');
    expect(doc?.scenes.map((scene) => `${scene.order}:${scene.id}`)).toEqual([
      '1:scene-1',
      '2:scene-p3',
      '3:scene-2',
    ]);
    // The existing plan entries shifted WITH their pages (p2 moved to 3), and
    // the imported page's fresh entry lands at 2 — order-based matching never
    // points at a stale slot after an atOrder insert.
    const outlines = (doc?.outline as AppDocumentOutline).outlines;
    expect(outlines.map((entry) => `${entry.order}:${entry.id}`)).toEqual(['1:p1', '2:p3', '3:p2']);
    expect(outlines.find((entry) => entry.order === 3)).toMatchObject({
      id: 'p2',
      description: '第二页的brief',
    });
  });

  it('clamps atOrder beyond the last page to an append', async () => {
    const store = stageStore([slideScene('scene-1', 1, '第一页')]);
    const { result } = await runImport(store, {
      params: { materialId: 'mat_ppt', atOrder: 99 },
      record: sourceRecord(),
      slides: [textSlide('s1', '<p>封面</p>')],
    });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ firstOrder: 2, pageOrders: [2] });
  });

  it('never touches the stage title or description across imports', async () => {
    const store = stageStore([slideScene('scene-old', 1, '旧页')], { requirement: '生物的课' });
    const before = (await store.loadDocument('stage-import'))?.stage;
    await runImport(store, {
      params: { materialId: 'mat_ppt' },
      record: sourceRecord({ title: '细胞结构.pptx' }),
      slides: [textSlide('s1', '<p>封面</p>')],
    });
    const after = (await store.loadDocument('stage-import'))?.stage;
    expect(before?.name).toBe('已有课堂');
    expect(after?.name).toBe('已有课堂');
    expect(before?.description).toBe(after?.description);
    // The PPT's own file name never leaks into the stage identity.
    expect(after?.name).not.toBe('细胞结构');
  });

  it('drops the replace parameter and exposes atOrder as an integer >= 1', () => {
    const tools = buildDslCourseToolset({
      stageAccess: async () => ({ kind: 'owned' as const }),
      store: makeStore(),
      onCheckpoint: () => {},
    }) as unknown as {
      name: string;
      parameters: { properties: Record<string, unknown> };
    }[];
    const tool = tools.find((item) => item.name === IMPORT_PPTX_TOOL_NAME);
    const props = tool?.parameters.properties ?? {};
    expect(props.replace).toBeUndefined();
    expect(props.atOrder).toMatchObject({ type: 'integer', minimum: 1 });
    expect(props.stageId).toBeDefined();
    expect(props.materialId).toBeDefined();
  });

  it('writes only through the owner-bound store and exposes no ownership parameter', async () => {
    // A stage the run's owner-bound store cannot see reads as missing: the
    // tool reports no-document and never mints or writes a foreign stage.
    const store = makeStore();
    const { result } = await runImport(store, {
      params: { materialId: 'mat_ppt' },
      record: sourceRecord(),
      slides: [textSlide('s1', '<p>封面</p>')],
    });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ status: 'no-document' });
    expect(await store.loadDocument('stage-import')).toBeNull();
    // The model-visible schema carries no ownership parameter: the owner comes
    // from the run's bound store, never from the caller.
    const tools = buildDslCourseToolset({
      stageAccess: async () => ({ kind: 'owned' as const }),
      store: makeStore(),
      sessionId: 'ses_1',
      onCheckpoint: () => {},
    }) as unknown as {
      name: string;
      parameters: { properties: Record<string, unknown> };
    }[];
    const tool = tools.find((item) => item.name === IMPORT_PPTX_TOOL_NAME);
    expect(Object.keys(tool?.parameters.properties ?? {}).sort()).toEqual([
      'atOrder',
      'materialId',
      'stageId',
    ]);
  });

  it('requires the stage to exist first (create_stage) and never mints one', async () => {
    const store = makeStore();
    const { result } = await runImport(store, {
      params: { materialId: 'mat_ppt' },
      record: sourceRecord(),
      slides: [textSlide('s1', '<p>封面</p>')],
    });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ status: 'no-document' });
    expect(await store.loadDocument('stage-import')).toBeNull();
  });

  it('rejects missing, non-source, and non-pptx materials', async () => {
    const store = makeStore();
    const missing = await runImport(store, { params: { materialId: 'mat_none' }, record: null });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.details).toMatchObject({ status: 'not_found' });

    const derived = await runImport(store, {
      params: { materialId: 'mat_ext' },
      record: sourceRecord({ id: 'mat_ext', kind: 'extraction', title: 'extract.txt' }),
    });
    expect(derived.result.isError).toBe(true);
    expect(derived.result.details).toMatchObject({ status: 'not_source' });

    const pdf = await runImport(store, {
      params: { materialId: 'mat_pdf' },
      record: sourceRecord({ id: 'mat_pdf', title: 'lecture.pdf' }),
      mime: 'application/pdf',
    });
    expect(pdf.result.isError).toBe(true);
    expect(pdf.result.details).toMatchObject({ status: 'unsupported_type' });
  });

  it('truncates oversized decks and honors abort', async () => {
    const store = stageStore();
    const slides = Array.from({ length: MAX_IMPORT_SLIDES + 3 }, (_, index) =>
      textSlide(`s${index + 1}`, `<p>第${index + 1}页</p>`),
    );
    const truncated = await runImport(store, {
      params: { materialId: 'mat_ppt' },
      record: sourceRecord(),
      slides,
    });
    expect(truncated.result.details).toMatchObject({
      truncated: true,
      pages: MAX_IMPORT_SLIDES,
      sourceSlideCount: MAX_IMPORT_SLIDES + 3,
    });

    const abort = new AbortController();
    abort.abort();
    await expect(
      runImport(makeStore(), {
        params: { materialId: 'mat_ppt' },
        record: sourceRecord(),
        signal: abort.signal,
      }),
    ).rejects.toThrow('aborted');
  });
});

describe('session material prompt', () => {
  it('mentions import_pptx only when a pptx is attached', () => {
    const pdf = sessionMaterialsPromptBlock([
      {
        id: 'mat_1',
        sessionId: 'ses_1',
        kind: 'source',
        title: 'lecture.pdf',
        sourceUrl: null,
        textAssetId: null,
        rawAssetId: null,
        textChars: 0,
        derivedFrom: null,
        extraction: { status: 'idle' as const, attempts: 0 },
        createdAt: new Date(0).toISOString(),
      },
    ]);
    expect(pdf).not.toContain('import_pptx');

    const pptx = sessionMaterialsPromptBlock([
      {
        id: 'mat_ppt',
        sessionId: 'ses_1',
        kind: 'source',
        title: 'deck.pptx',
        sourceUrl: null,
        textAssetId: null,
        rawAssetId: 'ast_raw_ppt',
        textChars: 0,
        derivedFrom: null,
        extraction: { status: 'idle' as const, attempts: 0 },
        createdAt: new Date(0).toISOString(),
      },
    ]);
    expect(pptx).toContain('import_pptx');
    expect(pptx).toContain('layout-preserving');
  });
});

describe('Node importer host', () => {
  it('installs a constructable XMLHttpRequest', () => {
    installNodeXmlHttpRequest();
    expect(typeof XMLHttpRequest).toBe('function');
    expect(new XMLHttpRequest()).toBeInstanceOf(NodeXMLHttpRequest);
    expect(XMLHttpRequest.DONE).toBe(4);
  });

  it('does not fail worker parse with XMLHttpRequest is not a constructor', async () => {
    try {
      await parsePptxBuffer(new ArrayBuffer(8));
    } catch (error) {
      expect(String(error)).not.toMatch(/XMLHttpRequest is not a constructor/);
    }
  });

  it('does not expose window or document on the request process while parsing', async () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    try {
      await parsePptxIsolated(new ArrayBuffer(8));
    } catch {
      // Invalid bytes still go through the worker.
    }
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  it('parses a real deck in a worker without publishing document on this process', async () => {
    const PptxGenJS = (await import('pptxgenjs')).default;
    const pptx = new PptxGenJS();
    pptx.addSlide().addText('隔离解析', { x: 0.5, y: 0.5, w: 8, h: 1, fontSize: 28 });
    const written = await pptx.write({ outputType: 'nodebuffer' });
    const bytes = Buffer.isBuffer(written) ? written : Buffer.from(written as ArrayBuffer);
    expect(typeof document).toBe('undefined');
    const slides = await parsePptxIsolated(toArrayBuffer(bytes));
    expect(typeof document).toBe('undefined');
    expect(slides.length).toBeGreaterThan(0);
  });

  it('parses a real .pptx into canvas slides', async () => {
    const PptxGenJS = (await import('pptxgenjs')).default;
    const pptx = new PptxGenJS();
    pptx.addSlide().addText('细胞结构', { x: 0.5, y: 0.5, w: 8, h: 1, fontSize: 28 });
    const written = await pptx.write({ outputType: 'nodebuffer' });
    const bytes = Buffer.isBuffer(written) ? written : Buffer.from(written as ArrayBuffer);
    const slides = await parsePptxBuffer(toArrayBuffer(bytes));
    expect(slides.length).toBeGreaterThan(0);
    const text = slides
      .flatMap((slide) => slide.elements ?? [])
      .map((el) => {
        const rec = el as { content?: string; text?: { content?: string } };
        return `${rec.content ?? ''} ${rec.text?.content ?? ''}`;
      })
      .join(' ');
    expect(text).toContain('细胞结构');
  });
});

describe('legacy receipt migration on first pptxImports write', () => {
  it('legacy A → import B → retry A reports instead of appending duplicates', async () => {
    // A pre-append importer document: material A's import is recorded ONLY as
    // outline.requirement, with no pptxImports map.
    const materialA = sourceRecord({ id: 'mat_a', title: 'A.pptx' });
    const materialB = sourceRecord({ id: 'mat_b', title: 'B.pptx' });
    const store = stageStore(
      [slideScene('scene-a1', 1, 'A 第一页'), slideScene('scene-a2', 2, 'A 第二页')],
      { requirement: 'import_pptx:mat_a' },
    );

    // Import B: the first pptxImports map is minted here and must carry A's
    // migrated receipt, not just B's.
    const b = await runImport(store, {
      params: { materialId: 'mat_b' },
      record: materialB,
      slides: [textSlide('sB', '<p>B 封面</p>')],
    });
    expect(b.result.isError).toBeFalsy();
    const afterB = await store.loadDocument('stage-import');
    expect(afterB?.scenes).toHaveLength(3);
    expect(
      (afterB?.outline as AppDocumentOutline | undefined)?.pptxImports?.['import_pptx:mat_a']
        ?.sceneIds,
    ).toEqual(['scene-a1', 'scene-a2']);

    // Retry A: the migrated receipt makes this a report, never a re-append.
    const a = await runImport(store, {
      params: { materialId: 'mat_a' },
      record: materialA,
      slides: [textSlide('sA', '<p>A 封面</p>')],
    });
    expect(a.result.isError).toBeFalsy();
    expect(JSON.stringify(a.result.details)).toContain('reused');
    const afterA = await store.loadDocument('stage-import');
    expect(afterA?.scenes).toHaveLength(3);
  });

  it('retry A hits the legacy material-id receipt even when both materials carry a digest', async () => {
    // The digest variant the no-digest case above cannot see: A's legacy import
    // is migrated onto the map under `import_pptx:mat_a`, but a material WITH a
    // content digest resolves to `import_pptx:sha256:<digest>` — so once the map
    // exists the SHA-key lookup alone misses A and would re-append. The legacy
    // material-id key must still be consulted inside the map.
    const materialA = sourceRecord({ id: 'mat_a', title: 'A.pptx' });
    const materialB = sourceRecord({ id: 'mat_b', title: 'B.pptx' });
    const digestB = digestOf(Buffer.from('deck-mat_b'));
    const store = stageStore(
      [slideScene('scene-a1', 1, 'A 第一页'), slideScene('scene-a2', 2, 'A 第二页')],
      { requirement: 'import_pptx:mat_a' },
    );

    // Import B: mints the map, migrating A's receipt under `import_pptx:mat_a`
    // and writing B's under its SHA key.
    const b = await runImport(store, {
      params: { materialId: 'mat_b' },
      record: materialB,
      slides: [textSlide('sB', '<p>B 封面</p>')],
    });
    expect(b.result.isError).toBeFalsy();
    const afterB = await store.loadDocument('stage-import');
    expect(afterB?.scenes).toHaveLength(3);
    const imports = (afterB?.outline as AppDocumentOutline | undefined)?.pptxImports;
    expect(imports?.['import_pptx:mat_a']?.sceneIds).toEqual(['scene-a1', 'scene-a2']);
    // B's pages ride the stage-wide p<seq> sequence, past A's p1/p2.
    expect(imports?.[`import_pptx:sha256:${digestB}`]?.sceneIds).toEqual(['scene-p3']);

    // Retry A: its CURRENT key is the SHA key (digest present), which misses —
    // the legacy material-id key inside the map must answer instead.
    const a = await runImport(store, {
      params: { materialId: 'mat_a' },
      record: materialA,
      slides: [textSlide('sA', '<p>A 封面</p>')],
    });
    expect(a.result.isError).toBeFalsy();
    expect(JSON.stringify(a.result.details)).toContain('reused');
    expect(a.result.details).toMatchObject({ reused: true, pages: 2, pageOrders: [1, 2] });
    const afterA = await store.loadDocument('stage-import');
    expect(afterA?.scenes).toHaveLength(3);
  });
});
