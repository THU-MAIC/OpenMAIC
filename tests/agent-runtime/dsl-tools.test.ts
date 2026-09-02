import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Check } from 'typebox/value';
import { PGlite } from '@electric-sql/pglite';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { PPTTextElement } from '@openmaic/dsl';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import {
  buildCourseAllowlist,
  buildDslCourseToolset,
  DSL_TOOLS_PROMPT,
  type CourseDocument,
  type CourseStore,
} from '@/lib/server/agent-runtime/course-tools';
import {
  buildDslCourseTools,
  foldNfkcCaseWithOffsets,
  GREP_COURSE_SCHEMA,
  PATCH_COURSE_SCHEMA,
  READ_COURSE_SCHEMA,
} from '@/lib/server/agent-runtime/dsl-tools';
import {
  buildCurriculumTools,
  probeStageAccess,
  type StageAccess,
} from '@/lib/server/agent-runtime/curriculum-tools';
import { buildRunnerCoursePrompt } from '@/lib/server/agent-runtime/runner-contract';
import { withPlainJsonDocumentWrites } from '@/lib/document-store/plain-json-store';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type {
  InteractiveContent,
  PBLContent,
  QuizContent,
  Scene,
  SlideContent,
} from '@/lib/types/stage';

function slideScene(order = 1, id = 'scene_slide'): Scene {
  return {
    id,
    stageId: 'stage-test',
    order,
    title: 'ＡＩ 开场',
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#2563eb'],
          fontColor: '#111',
          fontName: 'Inter',
        },
        elements: [
          {
            id: 'el-title',
            type: 'text',
            left: 10,
            top: 10,
            width: 400,
            height: 80,
            rotate: 0,
            content: '<p>Hello AI</p>',
            defaultFontName: 'Inter',
            defaultColor: '#111',
            fill: '#fff',
          } as PPTTextElement,
        ],
      },
    },
    actions: [{ id: 'act-1', type: 'speech', text: 'Welcome', audioId: 'asset-old' }],
  } as Scene;
}

function quizScene(): Scene {
  return {
    id: 'scene_quiz',
    stageId: 'stage-test',
    order: 2,
    title: 'Quiz',
    type: 'quiz',
    content: {
      type: 'quiz',
      questions: [
        {
          id: 'q1',
          type: 'single',
          question: 'Which answer?',
          options: [
            { label: 'Alpha', value: 'A' },
            { label: 'Beta', value: 'B' },
          ],
          answer: ['A'],
          analysis: 'Because Alpha.',
        },
      ],
    },
    actions: [],
  } as Scene;
}

function interactiveScene(): Scene {
  return {
    id: 'scene_widget',
    stageId: 'stage-test',
    order: 3,
    title: 'Widget',
    type: 'interactive',
    content: {
      type: 'interactive',
      html: '<html><style>.hidden{}</style><body>Visible widget words</body></html>',
      widgetType: 'simulation',
      widgetConfig: {
        type: 'simulation',
        concept: 'gravity',
        description: 'Change the mass',
        variables: [{ name: 'mass', label: 'Mass', min: 1, max: 10, default: 2 }],
      },
    },
    actions: [],
  } as Scene;
}

function pblScene(): Scene {
  return {
    id: 'scene_pbl',
    stageId: 'stage-test',
    order: 4,
    title: 'Project',
    type: 'pbl',
    content: {
      type: 'pbl',
      projectV2: {
        uiPhase: 'hero',
        title: 'Build a bridge',
        description: 'Make a model',
        proficiency: '',
        language: 'en',
        tags: [],
        status: 'designing',
        roles: [{ id: 'role-1', type: 'instructor', name: 'Instructor' }],
        milestones: [
          {
            id: 'ms-1',
            title: 'Plan',
            status: 'locked',
            order: 1,
            microtasks: [
              {
                id: 'mt-1',
                title: 'Sketch',
                status: 'todo',
                assignee: 'user',
                hints: ['Use triangles'],
                order: 1,
              },
            ],
          },
        ],
        submissions: [],
        evaluations: [],
        threads: [{ agentId: 'role-1', messages: [] }],
        engagementEvents: [],
        createdAt: '2026-08-22T00:00:00.000Z',
        updatedAt: '2026-08-22T00:00:00.000Z',
      },
    },
    actions: [],
  } as Scene;
}

function course(scenes: Scene[] = [slideScene(), quizScene(), interactiveScene(), pblScene()]) {
  return {
    stage: {
      id: 'stage-test',
      name: 'Test course',
      description: 'Course description',
      createdAt: 1,
      updatedAt: 1,
    },
    outline: {
      outlines: scenes.map((scene) => ({
        id: `outline-${scene.id}`,
        order: scene.order,
        type: scene.type,
        title: scene.title,
        description: `Outline ${scene.title}`,
        keyPoints: [],
      })),
    },
    scenes,
  } as unknown as CourseDocument;
}

function state(initial = course()) {
  let doc = structuredClone(initial);
  const putScene = vi.fn(async (_stageId: string, scene: Scene) => {
    doc = {
      ...doc,
      scenes: doc.scenes.map((item) => (item.id === scene.id ? scene : item)),
    };
  });
  const loadDocument = vi.fn(async (stageId: string) => (stageId === doc.stage.id ? doc : null));
  return {
    store: { loadDocument, putScene } as unknown as CourseStore,
    get: () => doc,
    putScene,
    loadDocument,
  };
}

const OWNED: StageAccess = { kind: 'owned', stage: { stageId: 'stage-test', name: 'Test course' } };

function dslTools(store: CourseStore) {
  return buildDslCourseTools({
    store,
    stageAccess: async () => OWNED,
    onCheckpoint: () => undefined,
  });
}

function tool(tools: AgentTool<never, never>[], name: string) {
  const found = tools.find((item) => item.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return {
    ...found,
    execute(callId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return found.execute(callId, { stageId: 'stage-test', ...params } as never, signal);
    },
  };
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

describe('read_stage', () => {
  it('reads tree/source/text and resolves both order and scene id', async () => {
    const current = state();
    const read = tool(dslTools(current.store), 'read_stage');

    const tree = await read.execute('tree', {} as never);
    const parsedTree = JSON.parse(textOf(tree));
    expect(parsedTree.stage).toMatchObject({ id: 'stage-test' });
    expect(parsedTree.scenes[0]).toMatchObject({
      id: 'scene_slide',
      elements: { total: 1, types: { text: 1 } },
      actions: { total: 1 },
    });

    const byOrder = await read.execute('source-order', {
      path: '/scenes/2',
      detail: 'source',
    } as never);
    expect(JSON.parse(textOf(byOrder))).toMatchObject({ id: 'scene_quiz', type: 'quiz' });

    const byId = await read.execute('source-id', {
      path: '/scenes/scene_widget',
      detail: 'source',
    } as never);
    expect(JSON.parse(textOf(byId))).toMatchObject({
      id: 'scene_widget',
      content: { widgetType: 'simulation' },
    });

    const text = await read.execute('text', {
      path: '/scenes/scene_slide',
      detail: 'text',
    } as never);
    expect(JSON.parse(textOf(text)).combinedText).toContain('Hello AI');
    expect(JSON.parse(textOf(text)).combinedText).toContain('Welcome');
  });

  it('returns an error with legal forms for bad paths and inaccessible explicit stages', async () => {
    const current = state();
    const read = tool(dslTools(current.store), 'read_stage');
    const missing = await read.execute('missing', {
      path: '/scenes/99',
      detail: 'source',
    } as never);
    expect(missing).toMatchObject({ isError: true });
    expect(textOf(missing)).toContain('Legal paths');

    const foreign = await read.execute('foreign', { stageId: 'stage-foreign' } as never);
    expect(foreign).toMatchObject({ isError: true });
    expect(textOf(foreign)).toContain('not accessible');
    expect(current.loadDocument).toHaveBeenLastCalledWith('stage-foreign');
  });

  it('omits large media bytes and paginates source/text at 12000 characters', async () => {
    const scene = slideScene();
    const imageBytes = Buffer.alloc(5_000, 0x61).toString('base64');
    (scene.content as SlideContent).canvas.elements.unshift({
      id: 'image-1',
      type: 'image',
      left: 0,
      top: 100,
      width: 100,
      height: 100,
      rotate: 0,
      fixedRatio: true,
      src: `data:image/png;base64,${imageBytes}`,
    });
    ((scene.content as SlideContent).canvas.elements[1] as PPTTextElement).content =
      `<p>${'x'.repeat(25_000)}</p>`;
    const current = state(course([scene]));
    const read = tool(dslTools(current.store), 'read_stage');
    const first = await read.execute('first', {
      path: '/scenes/1',
      detail: 'source',
    } as never);
    expect(textOf(first)).toContain('bytes omitted');
    expect(textOf(first)).not.toContain(imageBytes);
    expect(textOf(first)).toContain('grep_stage');
    expect(textOf(first)).toContain('Output truncated at 12000 chars');
    expect(textOf(first)).toContain('offset=12000');
    expect(first.details).toMatchObject({ totalChars: expect.any(Number), nextOffset: 12_000 });
    const nextOffset = (first.details as { nextOffset: number }).nextOffset;
    const second = await read.execute('second', {
      path: '/scenes/1',
      detail: 'source',
      offset: nextOffset,
    } as never);
    expect((second.details as { totalChars: number }).totalChars).toBe(
      (first.details as { totalChars: number }).totalChars,
    );
    const textPage = await read.execute('text-page', {
      path: '/scenes/1',
      detail: 'text',
    } as never);
    expect(textPage.details).toMatchObject({ nextOffset: 12_000 });
    expect(textOf(textPage)).toContain('grep_stage');
    expect((current.get().scenes[0]!.content as SlideContent).canvas.elements[0]).toMatchObject({
      src: `data:image/png;base64,${imageBytes}`,
    });
  });

  it('leaves untruncated results free of the pagination hint', async () => {
    const current = state();
    const read = tool(dslTools(current.store), 'read_stage');
    const source = await read.execute('source-small', {
      path: '/scenes/1',
      detail: 'source',
    } as never);
    expect(textOf(source)).not.toContain('Output truncated');
    const text = await read.execute('text-small', {
      path: '/scenes/1',
      detail: 'text',
    } as never);
    expect(textOf(text)).not.toContain('Output truncated');
    const tree = await read.execute('tree-small', {} as never);
    expect(textOf(tree)).not.toContain('Output truncated');
  });
});

describe('patch_stage', () => {
  it.each(['scene_widget', 'scene_pbl'] as const)(
    'rejects set /actions to a non-array on %s and never persists (R5-P2-2)',
    async (target) => {
      const current = state();
      const patch = tool(dslTools(current.store), 'patch_stage');
      const result = await patch.execute('bad-actions', {
        target: `/scenes/${target}`,
        intent: 'Set actions to garbage',
        ops: [{ op: 'set', path: '/actions', value: 'not-an-action-array' }],
      } as never);
      expect(result).toMatchObject({ isError: true });
      expect(textOf(result)).toContain('structure validation');
      // The corrupted actions value never reaches the store.
      expect(current.putScene).not.toHaveBeenCalled();
      const scene = current.get().scenes.find((item) => item.id === target);
      expect(scene?.actions).toEqual([]);
    },
  );

  it.each(['scene_widget', 'scene_pbl'] as const)(
    'accepts a valid actions array on %s (R5-P2-2)',
    async (target) => {
      const current = state();
      const patch = tool(dslTools(current.store), 'patch_stage');
      const actions = [{ id: 'a1', type: 'speech', text: '说明' }];
      const result = await patch.execute('good-actions', {
        target: `/scenes/${target}`,
        intent: 'Set narration',
        ops: [{ op: 'set', path: '/actions', value: actions }],
      } as never);
      expect(result).not.toHaveProperty('isError');
      expect(current.putScene).toHaveBeenCalledTimes(1);
      expect(current.get().scenes.find((item) => item.id === target)?.actions).toEqual(actions);
    },
  );

  it('applies set/remove atomically and clears stale speech audio', async () => {
    const current = state();
    const patch = tool(dslTools(current.store), 'patch_stage');
    const result = await patch.execute('patch', {
      target: '/scenes/scene_slide',
      intent: 'Update title color and narration',
      ops: [
        { op: 'set', path: '/content/canvas/elements/0/defaultColor', value: '#f00' },
        { op: 'set', path: '/actions/0/text', value: 'New narration' },
        { op: 'remove', path: '/content/canvas/elements/0/fill' },
      ],
    } as never);
    expect(result).not.toHaveProperty('isError');
    const scene = current.get().scenes[0]!;
    expect(
      ((scene.content as SlideContent).canvas.elements[0] as PPTTextElement).defaultColor,
    ).toBe('#f00');
    expect((scene.content as SlideContent).canvas.elements[0]).not.toHaveProperty('fill');
    expect(scene.actions?.[0]).toMatchObject({ text: 'New narration' });
    expect(scene.actions?.[0]).not.toHaveProperty('audioId');
    expect(result.details).toMatchObject({
      intent: 'Update title color and narration',
      updated: { ops: 3 },
      tree: { id: 'scene_slide' },
    });
  });

  it('a later patch_stage call keeps an earlier long HTML element change (no sibling loss)', async () => {
    const current = state();
    const patch = tool(dslTools(current.store), 'patch_stage');
    // >2KiB HTML, larger than the read-side media-byte-omission cutoff — the
    // value the next call must not drop.
    const longHtml = `<p>${'深'.repeat(2400)}</p>`;

    const first = await patch.execute('patch', {
      target: '/scenes/scene_slide',
      intent: 'Set a long opening line',
      ops: [{ op: 'set', path: '/content/canvas/elements/0/content', value: longHtml }],
    } as never);
    expect(first).not.toHaveProperty('isError');

    // A second, independent call patches a DIFFERENT sibling (the narration).
    const second = await patch.execute('patch', {
      target: '/scenes/1',
      intent: 'Fix the narration',
      ops: [{ op: 'set', path: '/actions/0/text', value: 'New narration' }],
    } as never);
    expect(second).not.toHaveProperty('isError');

    const scene = current.get().scenes[0]!;
    expect((scene.content as SlideContent).canvas.elements[0]).toMatchObject({
      content: longHtml,
    });
    expect(scene.actions?.[0]).toMatchObject({ text: 'New narration' });
  });

  it('emits the resolved course stageId on the patch_stage checkpoint', async () => {
    const current = state();
    const checkpoints: { tool: string; stageId?: string; sceneId?: string }[] = [];
    const tools = buildDslCourseTools({
      store: current.store,
      stageAccess: async () => OWNED,
      onCheckpoint: (info) => checkpoints.push(info),
    });
    const patch = tool(tools, 'patch_stage');
    const result = await patch.execute('patch', {
      target: '/scenes/scene_slide',
      intent: 'Update title color',
      ops: [{ op: 'set', path: '/content/canvas/elements/0/defaultColor', value: '#f00' }],
    } as never);
    expect(result).not.toHaveProperty('isError');
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      tool: 'patch_stage',
      stageId: 'stage-test',
      sceneId: 'scene_slide',
    });
  });

  it('rolls back the entire batch when a middle op fails', async () => {
    const current = state();
    const before = JSON.stringify(current.get());
    const patch = tool(dslTools(current.store), 'patch_stage');
    const result = await patch.execute('patch', {
      target: '/scenes/1',
      intent: 'Try an atomic batch',
      ops: [
        { op: 'set', path: '/content/canvas/elements/0/defaultColor', value: '#f00' },
        { op: 'remove', path: '/content/canvas/nope' },
        { op: 'set', path: '/content/canvas/elements/0/content', value: '<p>Never</p>' },
      ],
    } as never);
    expect(result).toMatchObject({ isError: true, details: { failedOp: 2 } });
    expect(current.putScene).not.toHaveBeenCalled();
    expect(JSON.stringify(current.get())).toBe(before);
  });

  it('loud-fails unknown fields and rejects media omission placeholders', async () => {
    const current = state();
    const patch = tool(dslTools(current.store), 'patch_stage');
    const unknown = await patch.execute('unknown', {
      target: '/scenes/1',
      intent: 'Misspell a field',
      ops: [{ op: 'set', path: '/content/canvas/elements/0/defaultColour', value: '#f00' }],
    } as never);
    expect(unknown).toMatchObject({ isError: true });
    expect(textOf(unknown)).toContain('additional properties');

    const placeholder =
      '<image bytes omitted: image/png, 5000 bytes; read-only placeholder; to replace it, write a new media src/URL at this path>';
    const rejected = await patch.execute('placeholder', {
      target: '/scenes/1',
      intent: 'Copy a read placeholder',
      ops: [
        {
          op: 'set',
          path: '/content/canvas/elements/0/content',
          value: `<p><img src="${placeholder}"></p>`,
        },
      ],
    } as never);
    expect(rejected).toMatchObject({ isError: true });
    expect(textOf(rejected)).toContain('read-time placeholder');
    expect(current.putScene).not.toHaveBeenCalled();
  });

  it('rejects wrong optional quiz field types at the final validation barrier', async () => {
    const current = state();
    const patch = tool(dslTools(current.store), 'patch_stage');
    const result = await patch.execute('wrong-quiz-type', {
      target: '/scenes/2',
      intent: 'Try an invalid quiz score',
      ops: [{ op: 'set', path: '/content/questions/0/points', value: 'one' }],
    } as never);
    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain('/content/questions/0/points: expected number');
    expect(current.putScene).not.toHaveBeenCalled();
  });

  it('keeps add_element/delete_element semantics aligned with edit_slide', async () => {
    const current = state();
    const patch = tool(dslTools(current.store), 'patch_stage');
    const add = await patch.execute('add', {
      target: '/scenes/1',
      intent: 'Add a supporting label',
      ops: [
        {
          op: 'add_element',
          afterId: 'el-title',
          element: {
            type: 'text',
            left: 20,
            top: 120,
            width: 300,
            height: 60,
            rotate: 0,
            content: '<p>Added</p>',
            defaultFontName: 'Inter',
            defaultColor: '#111',
          },
        },
      ],
    } as never);
    expect(add).not.toHaveProperty('isError');
    const added = (current.get().scenes[0]!.content as SlideContent).canvas.elements[1]!;
    expect(added).toMatchObject({ type: 'text', content: '<p>Added</p>' });
    expect(added.id).toMatch(/^el-/);

    const remove = await patch.execute('remove', {
      target: '/scenes/1',
      intent: 'Remove the supporting label',
      ops: [{ op: 'delete_element', elementId: added.id }],
    } as never);
    expect(remove).not.toHaveProperty('isError');
    expect((current.get().scenes[0]!.content as SlideContent).canvas.elements).toHaveLength(1);
  });

  it('patches quiz, widget and PBL through the same scene-root pointers', async () => {
    const current = state();
    const patch = tool(dslTools(current.store), 'patch_stage');
    for (const call of [
      {
        target: '/scenes/2',
        intent: 'Update quiz wording',
        ops: [{ op: 'set', path: '/content/questions/0/question', value: 'Updated quiz?' }],
      },
      {
        target: '/scenes/scene_widget',
        intent: 'Update widget guidance',
        ops: [{ op: 'set', path: '/content/widgetConfig/description', value: 'Move the slider' }],
      },
      {
        target: '/scenes/4',
        intent: 'Update project milestone',
        ops: [{ op: 'set', path: '/content/projectV2/milestones/0/title', value: 'Research' }],
      },
    ]) {
      const result = await patch.execute('generic', call as never);
      expect(result).not.toHaveProperty('isError');
    }
    expect((current.get().scenes[1]!.content as QuizContent).questions[0]!.question).toBe(
      'Updated quiz?',
    );
    expect((current.get().scenes[2]!.content as InteractiveContent).widgetConfig).toMatchObject({
      description: 'Move the slider',
    });
    expect((current.get().scenes[3]!.content as PBLContent).projectV2?.milestones[0]!.title).toBe(
      'Research',
    );
  });

  it('adds a quiz question by setting the complete /content/questions array (caller-owned ids)', async () => {
    const current = state();
    const patch = tool(dslTools(current.store), 'patch_stage');
    const result = await patch.execute('add-question', {
      target: '/scenes/2',
      intent: 'Add a second question',
      ops: [
        {
          op: 'set',
          path: '/content/questions',
          value: [
            {
              id: 'q1',
              type: 'single',
              question: 'Which answer?',
              options: [
                { label: 'Alpha', value: 'A' },
                { label: 'Beta', value: 'B' },
              ],
              answer: ['A'],
              analysis: 'Because Alpha.',
            },
            {
              id: 'q2',
              type: 'single',
              question: 'Which is larger?',
              options: [
                { label: '1', value: 'A' },
                { label: '2', value: 'B' },
              ],
              answer: ['B'],
            },
          ],
        },
      ],
    } as never);
    expect(result).not.toHaveProperty('isError');
    expect(current.putScene).toHaveBeenCalledTimes(1);
    const questions = (current.get().scenes[1]!.content as QuizContent).questions;
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({ id: 'q1', answer: ['A'] });
    expect(questions[1]).toMatchObject({
      id: 'q2',
      type: 'single',
      question: 'Which is larger?',
      answer: ['B'],
    });
  });

  it('adds an option by setting /content/questions/0/options and re-points answer atomically', async () => {
    const current = state();
    const patch = tool(dslTools(current.store), 'patch_stage');
    const result = await patch.execute('add-option', {
      target: '/scenes/2',
      intent: 'Add a third option and make it the correct one',
      ops: [
        {
          op: 'set',
          path: '/content/questions/0/options',
          value: [
            { label: 'Alpha', value: 'A' },
            { label: 'Beta', value: 'B' },
            { label: 'Gamma', value: 'C' },
          ],
        },
        { op: 'set', path: '/content/questions/0/answer', value: ['C'] },
      ],
    } as never);
    expect(result).not.toHaveProperty('isError');
    expect(current.putScene).toHaveBeenCalledTimes(1);
    const question = (current.get().scenes[1]!.content as QuizContent).questions[0]!;
    expect(question.options).toEqual([
      { label: 'Alpha', value: 'A' },
      { label: 'Beta', value: 'B' },
      { label: 'Gamma', value: 'C' },
    ]);
    // value/answer stay coupled: the answer points at a value that exists.
    expect(question.answer).toEqual(['C']);
    expect(question.options?.some((option) => option.value === question.answer?.[0])).toBe(true);
  });

  it('adds a milestone and microtask by setting the complete /content/projectV2/milestones array (caller-owned order)', async () => {
    const current = state();
    const patch = tool(dslTools(current.store), 'patch_stage');
    const result = await patch.execute('add-milestone', {
      target: '/scenes/4',
      intent: 'Add a test milestone and a second microtask',
      ops: [
        {
          op: 'set',
          path: '/content/projectV2/milestones',
          value: [
            {
              id: 'ms-1',
              title: 'Plan',
              status: 'locked',
              order: 1,
              microtasks: [
                {
                  id: 'mt-1',
                  title: 'Sketch',
                  status: 'todo',
                  assignee: 'user',
                  hints: ['Use triangles'],
                  order: 1,
                },
                {
                  id: 'mt-2',
                  title: 'Prototype',
                  status: 'todo',
                  assignee: 'user',
                  hints: ['Build the model'],
                  order: 2,
                },
              ],
            },
            {
              id: 'ms-2',
              title: 'Test',
              status: 'locked',
              order: 2,
              microtasks: [
                {
                  id: 'mt-3',
                  title: 'Verify',
                  status: 'todo',
                  assignee: 'user',
                  hints: [],
                  order: 1,
                },
              ],
            },
          ],
        },
      ],
    } as never);
    expect(result).not.toHaveProperty('isError');
    expect(current.putScene).toHaveBeenCalledTimes(1);
    const milestones = (current.get().scenes[3]!.content as PBLContent).projectV2!.milestones;
    expect(milestones).toHaveLength(2);
    // Order is caller-managed: exactly what was written is persisted, with no
    // server-side renumbering.
    expect(milestones.map((milestone) => milestone.order)).toEqual([1, 2]);
    expect(milestones[0]!.microtasks.map((microtask) => microtask.order)).toEqual([1, 2]);
    expect(milestones[1]).toMatchObject({ id: 'ms-2', title: 'Test', status: 'locked' });
    expect(milestones[0]!.microtasks[1]).toMatchObject({ id: 'mt-2', title: 'Prototype' });
  });

  it('str_replace swaps one exact anchor inside a long HTML field and leaves siblings byte-identical', async () => {
    const scene = interactiveScene();
    const head =
      '<!doctype html><html><head><style>/*' +
      'x'.repeat(24_000) +
      '*/</style></head><body><script>';
    const tail = '</script><p>Visible widget words</p></body></html>';
    (scene.content as InteractiveContent).html = head + 'const speed = 0.015 * dt' + tail;
    const current = state(course([scene]));
    const patch = tool(dslTools(current.store), 'patch_stage');
    const result = await patch.execute('patch', {
      target: '/scenes/scene_widget',
      intent: 'Slow the gravity simulation',
      ops: [
        {
          op: 'str_replace',
          path: '/content/html',
          oldText: 'const speed = 0.015 * dt',
          newText: 'const speed = 0.006 * dt',
        },
      ],
    } as never);
    expect(result).not.toHaveProperty('isError');
    const html = (current.get().scenes[0]!.content as InteractiveContent).html!;
    expect(html).toBe(head + 'const speed = 0.006 * dt' + tail);
    expect(html).not.toContain('0.015 * dt');
    expect(result.details).toMatchObject({
      ops: [{ op: 'str_replace', path: '/content/html', occurrences: 1 }],
    });
  });

  it('str_replace loud-fails with a 0-occurrence count when the anchor is absent', async () => {
    const current = state();
    const patch = tool(dslTools(current.store), 'patch_stage');
    const result = await patch.execute('patch', {
      target: '/scenes/scene_widget',
      intent: 'Edit a missing anchor',
      ops: [
        {
          op: 'str_replace',
          path: '/content/html',
          oldText: 'const speed = 0.015 * dt',
          newText: 'const speed = 0.006 * dt',
        },
      ],
    } as never);
    expect(result).toMatchObject({ isError: true, details: { failedOp: 1 } });
    expect(textOf(result)).toContain('anchor text not found in /content/html (0 occurrences)');
    expect(current.putScene).not.toHaveBeenCalled();
  });

  it('str_replace rejects a repeated anchor with its count, then replaceAll swaps every occurrence', async () => {
    const scene = interactiveScene();
    (scene.content as InteractiveContent).html =
      '<script>a(0.015); b(0.015); c(0.015);</script><p>Visible widget words</p>';
    const current = state(course([scene]));
    const patch = tool(dslTools(current.store), 'patch_stage');
    const ambiguous = await patch.execute('ambiguous', {
      target: '/scenes/scene_widget',
      intent: 'Edit a repeated anchor',
      ops: [{ op: 'str_replace', path: '/content/html', oldText: '0.015', newText: '0.006' }],
    } as never);
    expect(ambiguous).toMatchObject({ isError: true, details: { failedOp: 1 } });
    expect(textOf(ambiguous)).toContain(
      'anchor text occurs 3 times; extend the anchor or set replaceAll',
    );
    expect(current.putScene).not.toHaveBeenCalled();

    const all = await patch.execute('all', {
      target: '/scenes/scene_widget',
      intent: 'Replace every occurrence',
      ops: [
        {
          op: 'str_replace',
          path: '/content/html',
          oldText: '0.015',
          newText: '0.006',
          replaceAll: true,
        },
      ],
    } as never);
    expect(all).not.toHaveProperty('isError');
    expect((current.get().scenes[0]!.content as InteractiveContent).html).toBe(
      '<script>a(0.006); b(0.006); c(0.006);</script><p>Visible widget words</p>',
    );
    expect(all.details).toMatchObject({
      ops: [{ op: 'str_replace', path: '/content/html', occurrences: 3 }],
    });
  });

  it('str_replace rejects omitted-bytes placeholder fragments in oldText and newText', async () => {
    const current = state();
    const patch = tool(dslTools(current.store), 'patch_stage');
    const placeholder =
      '<image bytes omitted: image/png, 5000 bytes; read-only placeholder; to replace it, write a new media src/URL at this path>';
    const anchored = await patch.execute('anchor', {
      target: '/scenes/scene_widget',
      intent: 'Anchor on an omitted region',
      ops: [
        {
          op: 'str_replace',
          path: '/content/html',
          oldText: `src="${placeholder}"`,
          newText: 'src="https://example.com/new.png"',
        },
      ],
    } as never);
    expect(anchored).toMatchObject({ isError: true });
    expect(textOf(anchored)).toContain(
      'anchor contains an omitted-bytes placeholder from read_stage; it does not exist in the stored value',
    );
    expect(current.putScene).not.toHaveBeenCalled();

    const written = await patch.execute('write', {
      target: '/scenes/scene_widget',
      intent: 'Write a placeholder back',
      ops: [
        {
          op: 'str_replace',
          path: '/content/html',
          oldText: 'Visible widget words',
          newText: `<p><img src="${placeholder}"></p>`,
        },
      ],
    } as never);
    expect(written).toMatchObject({ isError: true });
    expect(textOf(written)).toContain('read-time placeholder');
    expect(current.putScene).not.toHaveBeenCalled();
  });

  it('str_replace requires a string field and reports the resolved type', async () => {
    const current = state();
    const patch = tool(dslTools(current.store), 'patch_stage');
    const number = await patch.execute('number', {
      target: '/scenes/scene_widget',
      intent: 'Replace inside a number field',
      ops: [
        {
          op: 'str_replace',
          path: '/content/widgetConfig/variables/0/max',
          oldText: '10',
          newText: '20',
        },
      ],
    } as never);
    expect(number).toMatchObject({ isError: true });
    expect(textOf(number)).toContain(
      'str_replace requires a string field; /content/widgetConfig/variables/0/max is number',
    );

    const missing = await patch.execute('missing', {
      target: '/scenes/scene_widget',
      intent: 'Replace inside a missing field',
      ops: [{ op: 'str_replace', path: '/content/html/typo', oldText: 'a', newText: 'b' }],
    } as never);
    expect(missing).toMatchObject({ isError: true });
    expect(textOf(missing)).toContain(
      'str_replace requires a string field; /content/html/typo is missing',
    );
    expect(current.putScene).not.toHaveBeenCalled();
  });

  it('rolls back the whole batch when a str_replace op fails mid-way', async () => {
    const current = state();
    const before = JSON.stringify(current.get());
    const patch = tool(dslTools(current.store), 'patch_stage');
    const result = await patch.execute('patch', {
      target: '/scenes/scene_widget',
      intent: 'Atomic batch with a failing str_replace',
      ops: [
        { op: 'set', path: '/content/widgetConfig/description', value: 'Changed first' },
        { op: 'str_replace', path: '/content/html', oldText: 'nope-nope', newText: 'x' },
      ],
    } as never);
    expect(result).toMatchObject({ isError: true, details: { failedOp: 2 } });
    expect(current.putScene).not.toHaveBeenCalled();
    expect(JSON.stringify(current.get())).toBe(before);
  });

  it('str_replace with an empty newText deletes the anchor', async () => {
    const current = state();
    const patch = tool(dslTools(current.store), 'patch_stage');
    const result = await patch.execute('patch', {
      target: '/scenes/scene_widget',
      intent: 'Drop the unused style block',
      ops: [
        {
          op: 'str_replace',
          path: '/content/html',
          oldText: '<style>.hidden{}</style>',
          newText: '',
        },
      ],
    } as never);
    expect(result).not.toHaveProperty('isError');
    expect((current.get().scenes[2]!.content as InteractiveContent).html).toBe(
      '<html><body>Visible widget words</body></html>',
    );
  });

  it('rejects a full read-only placeholder ASSEMBLED ACROSS str_replace ops (final-state guard)', async () => {
    const scene = slideScene();
    (scene.content as SlideContent).canvas.elements.unshift({
      id: 'image-1',
      type: 'image',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      fixedRatio: true,
      src: 'https://cdn.example.com/real.png',
    } as unknown as SlideContent['canvas']['elements'][number]);
    const current = state(course([scene]));
    const before = JSON.stringify(current.get());
    const patch = tool(dslTools(current.store), 'patch_stage');
    const result = await patch.execute('patch', {
      target: '/scenes/1',
      intent: 'Assemble a placeholder across two ops',
      ops: [
        {
          op: 'str_replace',
          path: '/content/canvas/elements/0/src',
          oldText: 'https://cdn.example.com/real.png',
          newText: '<image bytes omitted:',
        },
        {
          op: 'str_replace',
          path: '/content/canvas/elements/0/src',
          oldText: 'omitted:',
          newText:
            'omitted: image/png, 9999 bytes; read-only placeholder; to replace it, write a new media src/URL at this path>',
        },
      ],
    } as never);
    expect(result).toMatchObject({ isError: true, details: { failedOp: 2 } });
    expect(textOf(result)).toContain('read-only media placeholder');
    // Nothing persisted: the real src survives byte-for-byte.
    expect(current.putScene).not.toHaveBeenCalled();
    expect(JSON.stringify(current.get())).toBe(before);
    expect((current.get().scenes[0]!.content as SlideContent).canvas.elements[0]).toMatchObject({
      src: 'https://cdn.example.com/real.png',
    });
  });

  it('requires intent and at least one op at the schema layer', () => {
    expect(Check(PATCH_COURSE_SCHEMA, { target: '/scenes/1', ops: [{ op: 'remove' }] })).toBe(
      false,
    );
    expect(Check(PATCH_COURSE_SCHEMA, { target: '/scenes/1', intent: 'Change', ops: [] })).toBe(
      false,
    );
    expect(Check(READ_COURSE_SCHEMA, { detail: 'source', offset: -1 })).toBe(false);
    expect(
      Check(PATCH_COURSE_SCHEMA, {
        target: '/scenes/1',
        intent: 'Change',
        ops: [{ op: 'str_replace', path: '/content/html', oldText: '', newText: 'y' }],
      }),
    ).toBe(false);
  });
});

describe('grep_stage', () => {
  it('matches case-insensitively and maps NFKC-expanded matches to original offsets', async () => {
    const scene = slideScene();
    scene.title = 'prefix ＡＩ suffix';
    const current = state(course([scene]));
    const grep = tool(dslTools(current.store), 'grep_stage');
    const result = await grep.execute('grep', { query: 'ai', scope: 'text' } as never);
    const details = result.details as {
      hits: Array<{ start: number; end: number; snippet: string }>;
    };
    expect(details.hits.length).toBeGreaterThanOrEqual(2);
    const fullWidth = details.hits.find((hit) => hit.snippet.includes('ＡＩ'))!;
    const source = 'prefix ＡＩ suffix\nHello AI\nWelcome';
    expect(source.slice(fullWidth.start, fullWidth.end)).toBe('ＡＩ');
  });

  it('folds per grapheme cluster: a decomposed e+combining-acute matches a precomposed é query', async () => {
    const scene = slideScene();
    ((scene.content as SlideContent).canvas.elements[0] as PPTTextElement).content =
      '<p>cafe\u0301</p>';
    const current = state(course([scene]));
    const grep = tool(dslTools(current.store), 'grep_stage');
    const result = await grep.execute('grep', { query: 'é', scope: 'text' } as never);
    const details = result.details as {
      hits: Array<{ start: number; end: number; snippet: string }>;
    };
    expect(details.hits.length).toBeGreaterThanOrEqual(1);
    // The scene's combined visible text: title, the slide element, the action.
    const source = 'ＡＩ 开场\ncafe\u0301\nWelcome';
    const hit = details.hits.find((h) => h.snippet.includes('cafe'))!;
    // The hit's span covers the whole original cluster (e + combining accent).
    expect(source.slice(hit.start, hit.end)).toBe('e\u0301');
  });

  it('foldNfkcCaseWithOffsets composes combining sequences and keeps cluster-boundary spans', () => {
    // Direct probe of the exported fold: decomposed and precomposed forms fold
    // to the same value, and every folded code unit maps to the WHOLE original
    // cluster (so a match always slices valid original text).
    const decomposed = foldNfkcCaseWithOffsets('cafe\u0301');
    expect(decomposed.value).toBe('café');
    expect('cafe\u0301'.normalize('NFKC')).toBe('café');
    expect(decomposed.value.indexOf('é')).toBe(3);
    expect('cafe\u0301'.slice(decomposed.originalStarts[3]!, decomposed.originalEnds[3]!)).toBe(
      'e\u0301',
    );

    // A cluster that EXPANDS under NFKC maps both folded units to the same
    // original cluster span (ligature ﬁ → fi: 'o'+'ﬁ'+'ce' folds to 'ofice').
    const ligature = foldNfkcCaseWithOffsets('oﬁce');
    expect(ligature.value).toBe('ofice');
    expect(ligature.originalStarts[1]).toBe(1);
    expect(ligature.originalStarts[2]).toBe(1);
    expect(ligature.originalEnds[1]).toBe(2);
    expect(ligature.originalEnds[2]).toBe(2);
  });

  it('foldNfkcCaseWithOffsets folds Greek Σ/ς/σ to the same σ (R2-P2-2)', () => {
    // Unicode case folding: an uppercase ΟΣ, a word-final ς and a medial σ
    // must all search as σ, regardless of the word context a per-grapheme
    // lowercase can never see.
    expect(foldNfkcCaseWithOffsets('ΟΣ').value).toBe('οσ');
    expect(foldNfkcCaseWithOffsets('ος').value).toBe('οσ');
    expect(foldNfkcCaseWithOffsets('λόγος').value).toBe('λόγοσ');
    expect(foldNfkcCaseWithOffsets('σ').value).toBe('σ');
  });

  it('matches an uppercase Greek ΟΣ against a lowercase ος query with correct offsets (R2-P2-2)', async () => {
    const scene = slideScene();
    scene.title = 'ΟΣ 开场';
    const current = state(course([scene]));
    const grep = tool(dslTools(current.store), 'grep_stage');
    const result = await grep.execute('grep', { query: 'ος', scope: 'text' } as never);
    const details = result.details as {
      hits: Array<{ start: number; end: number; snippet: string }>;
    };
    expect(details.hits.length).toBeGreaterThanOrEqual(1);
    const source = 'ΟΣ 开场\nHello AI\nWelcome';
    const hit = details.hits.find((h) => h.snippet.includes('ΟΣ'))!;
    expect(source.slice(hit.start, hit.end)).toBe('ΟΣ');
  });

  it('matches a word-final ς source against a medial σ query (R2-P2-2)', async () => {
    const scene = slideScene();
    scene.title = 'λόγος 开场';
    const current = state(course([scene]));
    const grep = tool(dslTools(current.store), 'grep_stage');
    const result = await grep.execute('grep', { query: 'σ', scope: 'text' } as never);
    const details = result.details as {
      hits: Array<{ start: number; end: number; snippet: string }>;
    };
    expect(details.hits.length).toBeGreaterThanOrEqual(1);
    const source = 'λόγος 开场\nHello AI\nWelcome';
    const hit = details.hits.find((h) => h.snippet.includes('ς'))!;
    expect(source.slice(hit.start, hit.end)).toBe('ς');
  });

  it('returns a cursor on truncation and continuation concatenates to the full scan', async () => {
    const scenes = Array.from({ length: 35 }, (_, index) => {
      const scene = slideScene(index + 1, `scene_${index + 1}`);
      scene.title = `needle page ${index + 1}`;
      ((scene.content as SlideContent).canvas.elements[0] as PPTTextElement).content =
        '<p>plain</p>';
      scene.actions = [];
      return scene;
    });
    const current = state(course(scenes));
    const grep = tool(dslTools(current.store), 'grep_stage');
    const first = await grep.execute('first', { query: 'needle' } as never);
    expect(first.details).toMatchObject({ truncated: true, cursor: expect.any(String) });
    const firstDetails = first.details as { hits: unknown[]; cursor: string };
    expect(firstDetails.hits).toHaveLength(30);
    const second = await grep.execute('second', {
      query: 'needle',
      cursor: firstDetails.cursor,
    } as never);
    const secondDetails = second.details as { hits: unknown[]; truncated: boolean };
    expect(secondDetails.hits).toHaveLength(5);
    expect(secondDetails.truncated).toBe(false);
    expect([...firstDetails.hits, ...secondDetails.hits]).toHaveLength(35);
  });

  it('declares query bounds and rejects a cursor used with another query', async () => {
    expect(Check(GREP_COURSE_SCHEMA, { query: '' })).toBe(false);
    expect(Check(GREP_COURSE_SCHEMA, { query: 'x'.repeat(201) })).toBe(false);
    const current = state(
      course(Array.from({ length: 35 }, (_, i) => slideScene(i + 1, `scene_${i}`))),
    );
    const grep = tool(dslTools(current.store), 'grep_stage');
    const first = await grep.execute('first', { query: 'hello' } as never);
    const cursor = (first.details as { cursor: string }).cursor;
    const mismatch = await grep.execute('mismatch', { query: 'other', cursor } as never);
    expect(mismatch).toMatchObject({ isError: true });
  });
});

describe('DSL course-tool wiring', () => {
  const deps = (store: CourseStore) => ({
    store,
    stageAccess: async () => OWNED,
    onCheckpoint: () => undefined,
  });

  it('registers generation and DSL tools while excluding legacy editors', () => {
    const current = state();
    const tools = buildDslCourseToolset(deps(current.store));
    const names = tools.map((item) => item.name);
    for (const name of ['read_stage', 'patch_stage', 'grep_stage']) {
      expect(names).toContain(name);
      expect(buildCourseAllowlist()).toContain(name);
    }
    // The stage-level CRUD is a separate curriculum toolset the runner
    // registers beside the DSL tools; both feed the one allowlist.
    for (const name of ['create_stage', 'read_stage_outline']) {
      expect(buildCourseAllowlist()).toContain(name);
    }
    for (const name of [
      'generate_scene',
      'list_scenes',
      'generate_actions',
      'duplicate_scene',
      'import_pptx',
      'generate_image',
      'generate_tts',
      'edit_deck',
    ]) {
      expect(names).toContain(name);
      expect(buildCourseAllowlist()).toContain(name);
    }
    for (const name of [
      'read_scene',
      'edit_slide',
      'edit_quiz',
      'edit_widget',
      'edit_actions',
      'edit_pbl',
      'set_roster',
    ]) {
      expect(names).not.toContain(name);
      expect(buildCourseAllowlist()).not.toContain(name);
    }
    expect(tool(tools, 'patch_stage')).toMatchObject({ executionMode: 'sequential' });
    expect(tool(tools, 'read_stage')).not.toHaveProperty('executionMode');
    expect(tool(tools, 'grep_stage')).not.toHaveProperty('executionMode');
    expect(new Set(names)).toEqual(
      new Set([
        'generate_scene',
        'list_scenes',
        'generate_actions',
        'duplicate_scene',
        'import_pptx',
        'generate_image',
        'generate_tts',
        'edit_deck',
        'read_stage',
        'patch_stage',
        'grep_stage',
      ]),
    );
  });

  it('injects generic DSL compatibility guidance into every runner prompt', () => {
    expect(buildRunnerCoursePrompt({}).includes(DSL_TOOLS_PROMPT)).toBe(true);
    expect(DSL_TOOLS_PROMPT).toContain('stage-dsl');
    expect(DSL_TOOLS_PROMPT).toContain('/scenes/<1-based order|sceneId>');
    expect(DSL_TOOLS_PROMPT).toContain('Start with detail:"tree" to see structure');
    expect(DSL_TOOLS_PROMPT).toContain('prefer grep_stage over paging with offset');
  });
});

describe('grep_stage source scope searches the bounded projection (R6-P2-6)', () => {
  it('large inline media bytes never enter the searched source', async () => {
    const bigBytes = `UNIQUE-MEDIA-NEEDLE-${'A'.repeat(120_000)}`;
    const scene = slideScene();
    (
      scene.content as unknown as {
        canvas: { elements: { type: string; id: string; src?: string }[] };
      }
    ).canvas.elements.push({
      type: 'image',
      id: 'img-big',
      src: `data:image/png;base64,${bigBytes}`,
    });
    const s = state(course([scene]));
    const grep = tool(dslTools(s.store), 'grep_stage');

    // A needle that only exists inside the omitted media bytes: unreachable,
    // because the projection replaced those bytes before serialization.
    const insideMedia = (await grep.execute('c1', {
      stageId: 'stage-test',
      query: 'UNIQUE-MEDIA-NEEDLE',
      scope: 'source',
    } as never)) as { details: { hits: unknown[] } };
    expect(insideMedia.details.hits).toHaveLength(0);

    // The placeholder marker IS findable — proof the projection (the same
    // source read_stage serves) is what got searched.
    const placeholder = (await grep.execute('c2', {
      stageId: 'stage-test',
      query: 'bytes omitted',
      scope: 'source',
    } as never)) as { details: { hits: unknown[] } };
    expect(placeholder.details.hits.length).toBeGreaterThan(0);

    // Non-media source content stays searchable.
    const normal = (await grep.execute('c3', {
      stageId: 'stage-test',
      query: 'canvas-1',
      scope: 'source',
    } as never)) as { details: { hits: unknown[] } };
    expect(normal.details.hits.length).toBeGreaterThan(0);
  });
});

/**
 * Cross-owner isolation through the run's OWNER-BOUND store and the
 * three-state owner probe.
 *
 * These tests drive the reference's tool-layer contract over PGlite through
 * the actual tool entry points: every stageId-bearing course/DSL tool is
 * owner-gated by `withOwnerStageAuthorization` before it touches the store, so
 * a FOREIGN stage is refused with the not-yours message on read, patch, AND
 * grep — the reference treats the whole open-domain course toolset as
 * owner-scoped, and only the owner's own tools read it.
 */
describe('cross-owner isolation (owner-scoped store)', () => {
  let db: PGlite;

  class PGlitePool {
    constructor(readonly database: PGlite) {}

    query(text: string, params?: unknown[]) {
      return this.database.query(text, params);
    }

    async connect() {
      return {
        query: (text: string, params?: unknown[]) => this.database.query(text, params),
        release() {},
      };
    }
  }

  function ownerStore(ownerId: string): CourseStore {
    // The same seam the runner uses: the owner-bound document store claims
    // `stage_meta` inside its create transaction, so a stage minted through
    // `create_stage` is immediately visible to `probeStageAccess`.
    return withPlainJsonDocumentWrites(
      createOwnerBoundDocumentStore({
        pool: new PGlitePool(db),
        ownerId,
        validateScene: validateAppScene,
        validateStage: validateAppStage,
      }),
    ) as unknown as CourseStore;
  }

  function toolsFor(ownerId: string, sessionId: string) {
    const store = ownerStore(ownerId);
    const stageAccess = (stageId: string) => probeStageAccess(ownerId, stageId, db);
    const dsl = buildDslCourseToolset({
      store,
      stageAccess,
      onCheckpoint: () => undefined,
      sessionId,
    });
    const curriculum = buildCurriculumTools({
      store,
      ownerId,
      sessionId,
      stageAccess,
    });
    const run = (toolList: AgentTool<never, never>[], name: string) => {
      const found = toolList.find((item) => item.name === name);
      if (!found) throw new Error(`missing tool ${name}`);
      return found;
    };
    return {
      store,
      readStage: run(dsl, 'read_stage'),
      patchStage: run(dsl, 'patch_stage'),
      grepStage: run(dsl, 'grep_stage'),
      createStage: run(curriculum, 'create_stage'),
    };
  }

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureDocumentSchema(db);
    await ensureStageMetaSchema(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('refuses a foreign stage on read, patch, and grep; the owner still reads it', async () => {
    const alice = toolsFor('anon:alice', 'session-alice');
    const bob = toolsFor('anon:bob', 'session-bob');

    const created = (await alice.createStage.execute('call-1', {
      title: 'Alice stage',
      brief: 'mine',
    } as never)) as { details: { stageId: string }; isError?: boolean };
    expect(created.isError).toBeUndefined();
    const stageId = created.details.stageId;

    // Holding the id does NOT grant tool access: every course/DSL tool is
    // owner-gated, so Bob's read of Alice's stage is refused with the single
    // not-yours message the reference uses, and the store is never touched.
    const refusalShape = {
      isError: true,
      details: { refused: true, stageId },
      content: [
        {
          type: 'text',
          text: 'The stage was not found, or does not belong to this session user. Use list_folder_stages to see the stages you can work on.',
        },
      ],
    };
    const foreignRead = (await bob.readStage.execute('read-1', { stageId } as never)) as {
      isError?: boolean;
      content: { type: string; text: string }[];
      details?: Record<string, unknown>;
    };
    expect(foreignRead).toMatchObject(refusalShape);

    const foreignPatch = (await bob.patchStage.execute('patch-1', {
      stageId,
      target: '/scenes/1',
      intent: 'Tamper with a foreign stage',
      ops: [{ op: 'set', path: '/actions', value: [] }],
    } as never)) as { isError?: boolean };
    expect(foreignPatch).toMatchObject(refusalShape);

    const foreignGrep = (await bob.grepStage.execute('grep-1', {
      stageId,
      query: 'Alice',
    } as never)) as { isError?: boolean };
    expect(foreignGrep).toMatchObject(refusalShape);

    // The document is untouched — the refusal happened before any IO.
    await expect(alice.store.loadDocument(stageId)).resolves.toMatchObject({
      stage: { id: stageId, name: 'Alice stage' },
    });

    // Alice's own tools read the stage through the same probe.
    const ownRead = (await alice.readStage.execute('read-2', { stageId } as never)) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(ownRead.isError).toBeUndefined();
    expect(JSON.parse(ownRead.content[0]!.text)).toMatchObject({
      stage: { id: stageId, name: 'Alice stage' },
    });
  });

  it('each owner list contains only that owner’s stage', async () => {
    const alice = toolsFor('anon:alice', 'session-alice');
    const bob = toolsFor('anon:bob', 'session-bob');

    const created = (await alice.createStage.execute('call-1', {
      title: 'Shared? No.',
    } as never)) as { details: { stageId: string } };
    const stageId = created.details.stageId;

    // Bob mints his OWN stage with the same tool; ids derive from
    // (sessionId, callId), so a different session never collides.
    const bobCreated = (await bob.createStage.execute('call-1', {
      title: 'Bob stage',
    } as never)) as { details: { stageId: string }; isError?: boolean };
    expect(bobCreated.isError).toBeUndefined();
    expect(bobCreated.details.stageId).not.toBe(stageId);

    // Direct reads resolve by id; library listings remain owner-filtered.
    const bobList = await bob.store.loadDocument(bobCreated.details.stageId);
    expect(bobList?.stage.name).toBe('Bob stage');
    expect(bobList?.stage.id).not.toBe(stageId);
    const aliceList = await alice.store.loadDocument(stageId);
    expect(aliceList?.stage.name).toBe('Shared? No.');
    expect(await bob.store.listDocuments()).toHaveLength(1);
    expect(await alice.store.listDocuments()).toHaveLength(1);
  });
});
