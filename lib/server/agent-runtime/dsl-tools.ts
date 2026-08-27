import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Action } from '@/lib/types/action';
import type { Scene, SlideContent } from '@/lib/types/stage';
import { validateAppScene } from '@/lib/document-store/validators';
import type { CourseDocument, CourseToolDeps } from './course-tools';
import { runStageMutation } from './mutation-fence';
import {
  applyJsonPointerEdit,
  applySlideEdit,
  applyStrReplace,
  inventoryScene,
  textSlide,
  type SlideEditOp,
} from './course-edit/apply';
import {
  containsReadSceneMediaPlaceholder,
  omitReadSceneMediaBytes,
} from './course-edit/media-byte-omission';
import { COURSE_STAGE_ID_DESCRIPTION } from './course-stage';

const READ_PAGE_CHARS = 12_000;
const SEARCH_CONTEXT_CHARS = 200;
const MAX_SEARCH_SNIPPET_CHARS = SEARCH_CONTEXT_CHARS * 2;
const MAX_SEARCH_HITS_PER_SCENE = 10;
const MAX_SEARCH_HITS_TOTAL = 30;
const MAX_SEARCH_CHARS_PER_EXEC = 1_000_000;
const SEARCH_TIME_BUDGET_MS = 100;
const LEGAL_PATHS =
  'Legal paths: "" (whole stage), /outline, /scenes/<1-based order|scene_id>, /scenes/<...>/actions.';

export const READ_COURSE_SCHEMA = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  path: Type.Optional(
    Type.String({
      description:
        'Stage path: "", /outline, /scenes/<1-based order|scene id>, or /scenes/<...>/actions.',
    }),
  ),
  detail: Type.Optional(
    Type.Union([Type.Literal('tree'), Type.Literal('source'), Type.Literal('text')], {
      description:
        "'tree' (default) is a compact structure inventory; 'source' is exact JSON; 'text' is a visible-text projection.",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({ minimum: 0, description: 'Character offset for source/text pagination.' }),
  ),
});

const PATCH_OP_SCHEMA = Type.Object({
  op: Type.Union([
    Type.Literal('set'),
    Type.Literal('remove'),
    Type.Literal('add_element'),
    Type.Literal('delete_element'),
    Type.Literal('str_replace'),
  ]),
  path: Type.Optional(
    Type.String({
      description:
        'For set/remove/str_replace: JSON Pointer rooted at the exact scene source returned by read_stage.',
    }),
  ),
  value: Type.Optional(Type.Unknown({ description: 'For set only: exact JSON value to store.' })),
  oldText: Type.Optional(
    Type.String({
      minLength: 1,
      description: 'For str_replace: exact text to find within the string field value at path.',
    }),
  ),
  newText: Type.Optional(
    Type.String({
      description: 'For str_replace: replacement text (empty string deletes the anchor).',
    }),
  ),
  replaceAll: Type.Optional(
    Type.Boolean({
      description:
        'For str_replace: replace every occurrence (default false, which requires exactly one).',
    }),
  ),
  element: Type.Optional(
    Type.Unknown({ description: 'For add_element: complete id-less slide element JSON.' }),
  ),
  elementId: Type.Optional(
    Type.String({ description: 'For delete_element: persisted element id.' }),
  ),
  afterId: Type.Optional(Type.String()),
  index: Type.Optional(Type.Integer({ minimum: 0 })),
});

export const PATCH_COURSE_SCHEMA = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  target: Type.String({
    minLength: 1,
    description:
      'Scene target /scenes/<1-based order|scene id>. Stage/deck writes remain on edit_deck.',
  }),
  intent: Type.String({
    minLength: 1,
    description: 'One-sentence human summary of the intended change, shown in the UI.',
  }),
  ops: Type.Array(PATCH_OP_SCHEMA, {
    minItems: 1,
    description: 'Atomic operations: every op succeeds or the scene is not persisted.',
  }),
});

export const GREP_COURSE_SCHEMA = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 200,
    description: 'Case-insensitive NFKC-normalized literal text. Not a regular expression.',
  }),
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  scope: Type.Optional(
    Type.Union([Type.Literal('text'), Type.Literal('source')], {
      description:
        "'text' (default) searches visible text; 'source' searches serialized scene JSON.",
    }),
  ),
  cursor: Type.Optional(
    Type.String({ description: 'Opaque continuation cursor returned by a truncated search.' }),
  ),
});

type ReadParams = Static<typeof READ_COURSE_SCHEMA>;
type PatchParams = Static<typeof PATCH_COURSE_SCHEMA>;
type GrepParams = Static<typeof GREP_COURSE_SCHEMA>;

function toolResult(text: string, details: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

async function loadCourse(
  deps: CourseToolDeps,
  stageId: string,
): Promise<{ stageId: string; doc: CourseDocument } | { error: string }> {
  try {
    const doc = await deps.store.loadDocument(stageId);
    if (!doc)
      return { error: `Stage ${JSON.stringify(stageId)} was not found or is not accessible.` };
    return { stageId, doc };
  } catch (error) {
    return {
      error: `Stage is not accessible: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

type ResolvedPath =
  | { kind: 'course'; path: '' }
  | { kind: 'outline'; path: '/outline' }
  | { kind: 'scene'; path: string; scene: Scene }
  | { kind: 'actions'; path: string; scene: Scene };

function decodePathToken(token: string): string | null {
  if (/~(?:[^01]|$)/.test(token)) return null;
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveCoursePath(doc: CourseDocument, rawPath?: string): ResolvedPath | string {
  const path = rawPath ?? '';
  if (path === '') return { kind: 'course', path: '' };
  if (path === '/outline') return { kind: 'outline', path };
  const match = /^\/scenes\/([^/]+)(\/actions)?$/.exec(path);
  if (!match) return `Invalid stage path ${JSON.stringify(path)}. ${LEGAL_PATHS}`;
  const token = decodePathToken(match[1]!);
  if (!token) return `Invalid JSON Pointer escape in ${JSON.stringify(path)}. ${LEGAL_PATHS}`;
  let scene: Scene | undefined;
  if (/^[1-9]\d*$/.test(token)) {
    scene = doc.scenes.find((item) => item.order === Number(token));
  } else if (/^scene[-_]/.test(token)) {
    scene = doc.scenes.find((item) => item.id === token);
  } else {
    return `Scene selector ${JSON.stringify(token)} must be a 1-based order or scene_/scene- id. ${LEGAL_PATHS}`;
  }
  if (!scene) return `Scene ${JSON.stringify(token)} was not found. ${LEGAL_PATHS}`;
  return match[2] ? { kind: 'actions', path, scene } : { kind: 'scene', path, scene };
}

function actionTypeCounts(actions: readonly Action[]) {
  const counts: Record<string, number> = {};
  for (const action of actions) counts[action.type] = (counts[action.type] ?? 0) + 1;
  return counts;
}

function sceneTree(scene: Scene) {
  const inventory = inventoryScene(scene) as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    id: scene.id,
    order: scene.order,
    type: scene.type,
    title: scene.title,
  };
  if (scene.content.type === 'slide') {
    const counts: Record<string, number> = {};
    for (const element of scene.content.canvas.elements) {
      counts[element.type] = (counts[element.type] ?? 0) + 1;
    }
    summary.elements = { total: scene.content.canvas.elements.length, types: counts };
  } else if (scene.content.type === 'quiz') {
    summary.questions = scene.content.questions.length;
  } else if (scene.content.type === 'interactive') {
    summary.widgetType = scene.content.widgetConfig?.type ?? scene.content.widgetType ?? null;
    summary.htmlChars = typeof scene.content.html === 'string' ? scene.content.html.length : 0;
  } else if (scene.content.type === 'pbl') {
    const project = scene.content.projectV2;
    summary.project = project
      ? {
          roles: project.roles.length,
          milestones: project.milestones.length,
          microtasks: project.milestones.reduce((sum, item) => sum + item.microtasks.length, 0),
        }
      : null;
  } else {
    Object.assign(summary, inventory);
  }
  const actions = (scene.actions ?? []) as Action[];
  summary.actions = { total: actions.length, types: actionTypeCounts(actions) };
  return summary;
}

function treeAt(doc: CourseDocument, resolved: ResolvedPath): unknown {
  if (resolved.kind === 'course') {
    return {
      stage: {
        id: doc.stage.id,
        name: doc.stage.name,
        description: doc.stage.description,
      },
      outline: doc.outline
        ? {
            present: true,
            entries: Array.isArray((doc.outline as { outlines?: unknown[] }).outlines)
              ? ((doc.outline as { outlines: unknown[] }).outlines.length ?? 0)
              : undefined,
          }
        : { present: false },
      scenes: [...doc.scenes].sort((a, b) => a.order - b.order).map(sceneTree),
    };
  }
  if (resolved.kind === 'outline') {
    const outline = doc.outline as { outlines?: Array<Record<string, unknown>> } | undefined;
    return {
      entries: (outline?.outlines ?? []).map((item) => ({
        id: item.id,
        order: item.order,
        type: item.type,
        title: item.title,
      })),
    };
  }
  if (resolved.kind === 'actions') {
    const actions = (resolved.scene.actions ?? []) as Action[];
    return { sceneId: resolved.scene.id, total: actions.length, types: actionTypeCounts(actions) };
  }
  return sceneTree(resolved.scene);
}

function sourceAt(doc: CourseDocument, resolved: ResolvedPath): unknown {
  if (resolved.kind === 'course') return doc;
  if (resolved.kind === 'outline') return doc.outline ?? null;
  if (resolved.kind === 'actions') return resolved.scene.actions ?? [];
  return resolved.scene;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function visibleActionText(action: Action): string[] {
  const common = [action.title, action.description].filter(
    (value): value is string => typeof value === 'string',
  );
  switch (action.type) {
    case 'speech':
      return [...common, action.text];
    case 'discussion':
      return [...common, action.topic, ...(action.prompt ? [action.prompt] : [])];
    case 'wb_draw_text':
      return [...common, action.content];
    case 'wb_draw_code':
      return [...common, action.code, ...(action.fileName ? [action.fileName] : [])];
    case 'widget_highlight':
    case 'widget_annotation':
    case 'widget_reveal':
      return [...common, action.target, ...(action.content ? [action.content] : [])];
    case 'widget_setState':
      return [...common, ...(action.content ? [action.content] : [])];
    default:
      return common;
  }
}

function textScene(scene: Scene) {
  const entries: Array<{ path: string; text: string }> = [];
  const add = (path: string, value: unknown) => {
    if (typeof value === 'string' && value.trim()) entries.push({ path, text: value });
  };
  add('/title', scene.title);
  if (scene.content.type === 'slide') {
    for (const entry of textSlide(scene.content as SlideContent).elements) {
      add(`/content${entry.path}`, entry.text);
    }
  } else if (scene.content.type === 'quiz') {
    scene.content.questions.forEach((question, questionIndex) => {
      const base = `/content/questions/${questionIndex}`;
      add(`${base}/question`, question.question);
      question.options?.forEach((option, optionIndex) =>
        add(`${base}/options/${optionIndex}/label`, option.label),
      );
      add(`${base}/analysis`, question.analysis);
      add(`${base}/commentPrompt`, question.commentPrompt);
    });
  } else if (scene.content.type === 'interactive') {
    add('/content/html', scene.content.html ? stripHtml(scene.content.html) : undefined);
    const config = scene.content.widgetConfig as Record<string, unknown> | undefined;
    if (config) {
      for (const field of ['title', 'label', 'description', 'concept', 'task'] as const) {
        add(`/content/widgetConfig/${field}`, config[field]);
      }
      for (const field of ['hints', 'successCriteria'] as const) {
        const values = config[field];
        if (Array.isArray(values)) {
          values.forEach((value, index) => add(`/content/widgetConfig/${field}/${index}`, value));
        }
      }
    }
  } else if (scene.content.type === 'pbl' && scene.content.projectV2) {
    const project = scene.content.projectV2;
    for (const field of ['title', 'description', 'learningObjective'] as const) {
      add(`/content/projectV2/${field}`, project[field]);
    }
    project.gains?.forEach((value, index) => add(`/content/projectV2/gains/${index}`, value));
    project.roles.forEach((role, index) => {
      add(`/content/projectV2/roles/${index}/name`, role.name);
      add(`/content/projectV2/roles/${index}/description`, role.description);
    });
    project.milestones.forEach((milestone, milestoneIndex) => {
      const base = `/content/projectV2/milestones/${milestoneIndex}`;
      for (const field of ['title', 'description', 'briefing', 'debrief'] as const) {
        add(`${base}/${field}`, milestone[field]);
      }
      milestone.microtasks.forEach((task, taskIndex) => {
        const taskBase = `${base}/microtasks/${taskIndex}`;
        for (const field of ['title', 'description', 'learnerBrief'] as const) {
          add(`${taskBase}/${field}`, task[field]);
        }
        task.hints.forEach((hint, hintIndex) => add(`${taskBase}/hints/${hintIndex}`, hint));
      });
    });
  }
  ((scene.actions ?? []) as Action[]).forEach((action, index) => {
    visibleActionText(action).forEach((value, valueIndex) =>
      add(`/actions/${index}/visible/${valueIndex}`, value),
    );
  });
  return { entries, combinedText: entries.map((entry) => entry.text).join('\n') };
}

function textAt(doc: CourseDocument, resolved: ResolvedPath): unknown {
  if (resolved.kind === 'scene') return textScene(resolved.scene);
  if (resolved.kind === 'actions') {
    const entries = ((resolved.scene.actions ?? []) as Action[]).flatMap((action, index) =>
      visibleActionText(action).map((text, part) => ({ path: `/${index}/visible/${part}`, text })),
    );
    return { entries, combinedText: entries.map((entry) => entry.text).join('\n') };
  }
  if (resolved.kind === 'outline') {
    const outlines =
      (doc.outline as { outlines?: Array<Record<string, unknown>> } | undefined)?.outlines ?? [];
    const entries = outlines.flatMap((item, index) =>
      ['title', 'description', 'teachingObjective'].flatMap((field) =>
        typeof item[field] === 'string'
          ? [{ path: `/outlines/${index}/${field}`, text: item[field] as string }]
          : [],
      ),
    );
    return { entries, combinedText: entries.map((entry) => entry.text).join('\n') };
  }
  const scenes = [...doc.scenes]
    .sort((a, b) => a.order - b.order)
    .map((scene) => ({
      scenePath: `/scenes/${scene.id}`,
      order: scene.order,
      ...textScene(scene),
    }));
  return { scenes, combinedText: scenes.map((scene) => scene.combinedText).join('\n') };
}

function pagedResult(value: unknown, path: string, detail: 'tree' | 'source' | 'text', offset = 0) {
  const projected = detail === 'source' ? omitReadSceneMediaBytes(value).value : value;
  const serialized = JSON.stringify(projected, null, 2);
  if (detail === 'tree') {
    return toolResult(serialized, { path, detail, totalChars: serialized.length });
  }
  if (offset > serialized.length) {
    return toolResult(
      `offset ${offset} is beyond totalChars ${serialized.length}`,
      { path, detail, totalChars: serialized.length },
      true,
    );
  }
  const text = serialized.slice(offset, offset + READ_PAGE_CHARS);
  const nextOffset = offset + text.length < serialized.length ? offset + text.length : undefined;
  const truncatedText =
    nextOffset === undefined
      ? text
      : `${text}\n\nOutput truncated at ${READ_PAGE_CHARS} chars (${serialized.length} total). Continue with offset=${nextOffset}, jump to a specific string with grep_stage, or narrow the path (e.g. /scenes/3/actions).`;
  return toolResult(truncatedText, {
    path,
    detail,
    totalChars: serialized.length,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  });
}

function validationError(scene: Scene): string | null {
  const validation = validateAppScene(scene);
  if (!validation.valid) {
    return validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
  }
  if (scene.content.type === 'quiz') {
    const content = scene.content as unknown as Record<string, unknown>;
    const unknownContent = Object.keys(content).filter(
      (key) => !['type', 'questions'].includes(key),
    );
    if (unknownContent.length) return `/content: unknown field(s) ${unknownContent.join(', ')}`;
    for (let index = 0; index < scene.content.questions.length; index += 1) {
      const question = scene.content.questions[index] as unknown as Record<string, unknown>;
      const allowed = [
        'id',
        'type',
        'question',
        'options',
        'answer',
        'analysis',
        'commentPrompt',
        'hasAnswer',
        'points',
      ];
      const unknown = Object.keys(question).filter((key) => !allowed.includes(key));
      if (unknown.length)
        return `/content/questions/${index}: unknown field(s) ${unknown.join(', ')}`;
      if (!['single', 'multiple', 'short_answer'].includes(String(question.type))) {
        return `/content/questions/${index}/type: unknown quiz question type`;
      }
      if (typeof question.id !== 'string' || typeof question.question !== 'string') {
        return `/content/questions/${index}: id and question must be strings`;
      }
      if (question.options !== undefined) {
        if (!Array.isArray(question.options))
          return `/content/questions/${index}/options: expected array`;
        for (let optionIndex = 0; optionIndex < question.options.length; optionIndex += 1) {
          const option = question.options[optionIndex];
          if (option === null || typeof option !== 'object' || Array.isArray(option)) {
            return `/content/questions/${index}/options/${optionIndex}: expected object`;
          }
          const record = option as Record<string, unknown>;
          const unknownOption = Object.keys(record).filter(
            (key) => !['label', 'value'].includes(key),
          );
          if (unknownOption.length) {
            return `/content/questions/${index}/options/${optionIndex}: unknown field(s) ${unknownOption.join(', ')}`;
          }
          if (typeof record.label !== 'string' || typeof record.value !== 'string') {
            return `/content/questions/${index}/options/${optionIndex}: label and value must be strings`;
          }
        }
      }
      if (
        question.answer !== undefined &&
        (!Array.isArray(question.answer) ||
          question.answer.some((answer) => typeof answer !== 'string'))
      ) {
        return `/content/questions/${index}/answer: expected string array`;
      }
      for (const field of ['analysis', 'commentPrompt'] as const) {
        if (question[field] !== undefined && typeof question[field] !== 'string') {
          return `/content/questions/${index}/${field}: expected string`;
        }
      }
      if (question.hasAnswer !== undefined && typeof question.hasAnswer !== 'boolean') {
        return `/content/questions/${index}/hasAnswer: expected boolean`;
      }
      if (question.points !== undefined && typeof question.points !== 'number') {
        return `/content/questions/${index}/points: expected number`;
      }
    }
  }
  if (scene.content.type === 'interactive') {
    const unknown = Object.keys(scene.content).filter(
      (key) => !['type', 'url', 'html', 'widgetType', 'widgetConfig'].includes(key),
    );
    if (unknown.length) return `/content: unknown field(s) ${unknown.join(', ')}`;
  }
  if (scene.content.type === 'pbl') {
    const unknown = Object.keys(scene.content).filter(
      (key) => !['type', 'projectConfig', 'projectV2'].includes(key),
    );
    if (unknown.length) return `/content: unknown field(s) ${unknown.join(', ')}`;
  }
  return null;
}

function clearStaleSpeechAudio(before: Scene, after: Scene): void {
  const beforeById = new Map(
    ((before.actions ?? []) as Action[])
      .filter((action): action is Extract<Action, { type: 'speech' }> => action.type === 'speech')
      .map((action) => [action.id, action]),
  );
  for (const action of (after.actions ?? []) as Action[]) {
    if (action.type !== 'speech') continue;
    const previous = beforeById.get(action.id);
    if (!previous || previous.text === action.text) continue;
    const legacy = action as typeof action & { audioUrl?: string };
    delete legacy.audioId;
    delete legacy.audioUrl;
  }
}

function slideOperation(op: PatchParams['ops'][number], _scene: Scene): SlideEditOp | string {
  if (op.op === 'add_element') {
    if (op.element === undefined) return 'add_element needs element';
    if (containsReadSceneMediaPlaceholder(op.element))
      return 'add_element rejected: media placeholder cannot be written back';
    return {
      op: 'add_element',
      element: op.element as Record<string, unknown>,
      afterId: op.afterId,
      index: op.index,
    };
  }
  if (op.op === 'delete_element') {
    return op.elementId
      ? { op: 'delete_element', elementId: op.elementId }
      : 'delete_element needs elementId';
  }
  if (op.op === 'str_replace') {
    return 'str_replace is a generic string-field op; it is not routed through the slide canvas';
  }
  if (!op.path) return `${op.op} needs path`;
  if (!op.path.startsWith('/content/canvas/')) {
    return `slide content pointer must start /content/canvas/ (actions use /actions/...)`;
  }
  return {
    op: 'patch',
    action: op.op,
    path: op.path.slice('/content'.length),
    value: op.value,
  };
}

type PatchOpResult =
  | { ok: true; value: Scene; details?: { op: string; path?: string; occurrences?: number } }
  | { ok: false; error: string };

function applyPatchOp(scene: Scene, op: PatchParams['ops'][number]): PatchOpResult {
  if (op.op === 'add_element' || op.op === 'delete_element') {
    if (scene.content.type !== 'slide')
      return { ok: false as const, error: `${op.op} is only valid for slide scenes` };
    const parsed = slideOperation(op, scene);
    if (typeof parsed === 'string') return { ok: false as const, error: parsed };
    const applied = applySlideEdit(scene.content, parsed);
    return applied.ok
      ? { ok: true as const, value: { ...scene, content: applied.value } as Scene }
      : applied;
  }
  if (op.op === 'str_replace') {
    if (!op.path) return { ok: false as const, error: 'str_replace needs path' };
    if (!op.oldText) return { ok: false as const, error: 'str_replace needs oldText' };
    if (op.newText === undefined) return { ok: false as const, error: 'str_replace needs newText' };
    if (
      !op.path.startsWith('/content/') &&
      op.path !== '/actions' &&
      !op.path.startsWith('/actions/')
    ) {
      return {
        ok: false as const,
        error:
          'str_replace path must start /content/ or /actions/; use edit_deck for scene metadata',
      };
    }
    const applied = applyStrReplace(scene, {
      path: op.path,
      oldText: op.oldText,
      newText: op.newText,
      replaceAll: op.replaceAll ?? false,
    });
    if (!applied.ok) return applied;
    const next = applied.value as Scene;
    clearStaleSpeechAudio(scene, next);
    return {
      ok: true as const,
      value: next,
      details: { op: 'str_replace', path: op.path, occurrences: applied.occurrences },
    };
  }
  if (!op.path) return { ok: false as const, error: `${op.op} needs path` };
  if (
    !op.path.startsWith('/content/') &&
    op.path !== '/actions' &&
    !op.path.startsWith('/actions/')
  ) {
    return {
      ok: false as const,
      error: 'set/remove path must start /content/ or /actions/; use edit_deck for scene metadata',
    };
  }
  if (scene.content.type === 'slide' && op.path.startsWith('/content/')) {
    const parsed = slideOperation(op, scene);
    if (typeof parsed === 'string') return { ok: false as const, error: parsed };
    const applied = applySlideEdit(scene.content, parsed);
    return applied.ok
      ? { ok: true as const, value: { ...scene, content: applied.value } as Scene }
      : applied;
  }
  const applied = applyJsonPointerEdit(scene, { action: op.op, path: op.path, value: op.value });
  if (!applied.ok) return applied;
  clearStaleSpeechAudio(scene, applied.value as Scene);
  return { ok: true as const, value: applied.value as Scene };
}

interface FoldedText {
  value: string;
  originalStarts: number[];
  originalEnds: number[];
}

/**
 * Grapheme segmentation is what makes NFKC folding compose: normalization and
 * case folding apply to a whole user-perceived character, so splitting the
 * input by code point first would break a combining sequence (e.g. decomposed
 * `e\u0301` never becomes precomposed `é`) and canonically-equivalent text
 * would not search. `'und'` = language-neutral segmentation.
 */
const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

/**
 * Case-fold a cluster to the SEARCH-CANONICAL form (Unicode case folding
 * semantics): Σ (U+03A3), ς (U+03C2) and σ (U+03C3) must all fold to σ, so
 * `"ΟΣ"` and `"ος"` search as the same literal. Per-cluster `toLowerCase()`
 * alone cannot do this — Greek final sigma ς is only produced by lowercasing
 * a whole word, and a single grapheme never sees its word-final context, so
 * the per-cluster fold keeps the ς of an uppercase input as-is and the query's
 * ς never matches. Normalizing ς → σ after the per-cluster lowercase folds
 * both sides identically, independent of word context.
 */
function caseFoldCluster(cluster: string): string {
  return cluster
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u03c2/g, '\u03c3');
}

/**
 * NFKC + case fold with a source UTF-16 span for every resulting code unit.
 *
 * Folding is per GRAPHEME CLUSTER, not per code point: a cluster is
 * normalized as a whole, so decomposed and precomposed forms fold to the same
 * value. When a cluster expands or contracts under folding, every folded code
 * unit maps to the span of the WHOLE original cluster, so an offset-based hit
 * in `value` always slices the original text at cluster boundaries.
 */
export function foldNfkcCaseWithOffsets(text: string): FoldedText {
  let value = '';
  const originalStarts: number[] = [];
  const originalEnds: number[] = [];
  let originalIndex = 0;
  for (const segment of graphemeSegmenter.segment(text)) {
    const cluster = segment.segment;
    const originalEnd = originalIndex + cluster.length;
    const folded = caseFoldCluster(cluster);
    value += folded;
    for (let index = 0; index < folded.length; index += 1) {
      originalStarts.push(originalIndex);
      originalEnds.push(originalEnd);
    }
    originalIndex = originalEnd;
  }
  return { value, originalStarts, originalEnds };
}

function boundedSnippet(text: string, start: number, end: number) {
  const desiredStart = Math.max(0, start - SEARCH_CONTEXT_CHARS);
  const desiredEnd = Math.min(text.length, end + SEARCH_CONTEXT_CHARS);
  if (desiredEnd - desiredStart <= MAX_SEARCH_SNIPPET_CHARS) {
    return { snippetStart: desiredStart, snippetEnd: desiredEnd };
  }
  const midpoint = start + (end - start) / 2;
  const snippetStart = Math.min(
    Math.max(0, text.length - MAX_SEARCH_SNIPPET_CHARS),
    Math.max(0, Math.floor(midpoint - MAX_SEARCH_SNIPPET_CHARS / 2)),
  );
  return { snippetStart, snippetEnd: snippetStart + MAX_SEARCH_SNIPPET_CHARS };
}

interface SearchCursor {
  v: 1;
  stageId: string;
  query: string;
  scope: 'text' | 'source';
  sceneIndex: number;
  offset: number;
}

function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): SearchCursor | null {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as SearchCursor;
    return value.v === 1 && Number.isInteger(value.sceneIndex) && Number.isInteger(value.offset)
      ? value
      : null;
  } catch {
    return null;
  }
}

function grepText(scene: Scene, scope: 'text' | 'source'): string {
  // Source searches run over the SAME bounded projection `read_stage
  // detail:"source"` serves — large inline media bytes replaced by their
  // placeholder BEFORE serialization. Serializing the raw scene first would
  // materialize every inline data-URL (historical/imported pages carry tens
  // of MB) before any time/char budget could apply, blocking the event loop
  // on a string the budget then throws away (cr#6 R6-P2-6). Searching the
  // projection also matches what the model actually reads back.
  return scope === 'source'
    ? JSON.stringify(omitReadSceneMediaBytes(scene).value)
    : textScene(scene).combinedText;
}

export function buildDslCourseTools(deps: CourseToolDeps): AgentTool<never, never>[] {
  const readCourse: AgentTool<typeof READ_COURSE_SCHEMA, unknown> = {
    name: 'read_stage',
    label: 'Read stage',
    description:
      'Read a stage or one addressable subtree. Prefer tree first; paths are "", /outline, /scenes/<order|sceneId>, and /scenes/<...>/actions. tree is compact; source is exact JSON with large media bytes omitted; text is visible text. Source/text paginate after 12000 characters with nextOffset.',
    parameters: READ_COURSE_SCHEMA,
    async execute(_id, params: ReadParams) {
      const loaded = await loadCourse(deps, params.stageId);
      if ('error' in loaded) return toolResult(loaded.error, {}, true);
      const resolved = resolveCoursePath(loaded.doc, params.path);
      if (typeof resolved === 'string') return toolResult(resolved, {}, true);
      const detail = params.detail ?? 'tree';
      const value =
        detail === 'tree'
          ? treeAt(loaded.doc, resolved)
          : detail === 'source'
            ? sourceAt(loaded.doc, resolved)
            : textAt(loaded.doc, resolved);
      return pagedResult(value, resolved.path, detail, params.offset ?? 0);
    },
  };

  const patchCourse: AgentTool<typeof PATCH_COURSE_SCHEMA, unknown> = {
    name: 'patch_stage',
    label: 'Patch stage',
    description:
      'Atomically patch ONE scene at /scenes/<order|sceneId>. Read source first. set/remove use JSON Pointers rooted at that exact scene source (/content/... or /actions/...); str_replace swaps one exact occurrence of oldText inside a string field at a pointer (all occurrences with replaceAll); add_element/delete_element preserve server-owned slide element identity. Any failed op or resulting validation error rejects the whole batch. Stage/page-list operations remain on edit_deck.',
    parameters: PATCH_COURSE_SCHEMA,
    async execute(_id, params: PatchParams, signal) {
      if (!params.intent.trim()) return toolResult('intent must not be blank', {}, true);
      const loaded = await loadCourse(deps, params.stageId);
      if ('error' in loaded) return toolResult(loaded.error, {}, true);
      const resolved = resolveCoursePath(loaded.doc, params.target);
      if (typeof resolved === 'string')
        return toolResult(resolved, { intent: params.intent }, true);
      if (resolved.kind !== 'scene') {
        return toolResult(
          `patch_stage target must be /scenes/<order|sceneId>. ${LEGAL_PATHS}`,
          { intent: params.intent },
          true,
        );
      }
      let next = structuredClone(resolved.scene);
      const opDetails: unknown[] = [];
      for (let index = 0; index < params.ops.length; index += 1) {
        const applied = applyPatchOp(next, params.ops[index]!);
        if (!applied.ok) {
          return toolResult(
            `patch_stage rejected at op ${index + 1}: ${applied.error}`,
            { intent: params.intent, failedOp: index + 1 },
            true,
          );
        }
        next = applied.value;
        const op = params.ops[index]!;
        opDetails.push(
          applied.details ?? {
            op: op.op,
            ...(typeof op.path === 'string' ? { path: op.path } : {}),
          },
        );
      }
      // Final-state placeholder guard. The per-op checks above are the friendly
      // errors for a model that copies a placeholder verbatim, but they inspect
      // each op's payload in ISOLATION — a batch can assemble a complete
      // read-only placeholder across several ops (e.g. two str_replace calls
      // that each carry only a fragment). That bypasses every per-op check, so
      // the whole batch is re-checked HERE, against the SERIALIZED final scene,
      // before anything is persisted. This is the primary guard: a hit rejects
      // the entire batch and never reaches putScene.
      const finalSerialized = JSON.stringify(next);
      if (containsReadSceneMediaPlaceholder(finalSerialized)) {
        return toolResult(
          `patch_stage rejected: the resulting scene still contains a read-only media placeholder (it was assembled across ops); write a real media src/URL instead`,
          { intent: params.intent, failedOp: params.ops.length },
          true,
        );
      }
      const issue = validationError(next);
      if (issue) {
        return toolResult(
          `patch_stage rejected after op ${params.ops.length}: resulting scene fails structure validation (${issue})`,
          { intent: params.intent, failedOp: params.ops.length },
          true,
        );
      }
      try {
        await runStageMutation(signal, () => deps.store.putScene(loaded.stageId, next));
      } catch (error) {
        return toolResult(
          `patch_stage could not persist the scene: ${error instanceof Error ? error.message : String(error)}`,
          { intent: params.intent },
          true,
        );
      }
      deps.onCheckpoint({
        tool: 'patch_stage',
        stageId: loaded.stageId,
        sceneId: next.id,
        order: next.order,
        title: next.title,
        sceneType: next.type,
        detail: params.intent,
      });
      return toolResult(`Updated scene "${next.title}": ${params.intent}`, {
        intent: params.intent,
        updated: { sceneId: next.id, order: next.order, type: next.type, ops: params.ops.length },
        ops: opDetails,
        tree: sceneTree(next),
      });
    },
  };

  const grepCourse: AgentTool<typeof GREP_COURSE_SCHEMA, unknown> = {
    name: 'grep_stage',
    label: 'Search stage',
    description:
      'Search case-insensitive, NFKC-normalized literal text across stage scenes. text searches the visible-text projection; source searches serialized scene JSON. Returns at most 10 hits per scene and 30 total; truncated results always include a continuation cursor.',
    parameters: GREP_COURSE_SCHEMA,
    async execute(_id, params: GrepParams) {
      const loaded = await loadCourse(deps, params.stageId);
      if ('error' in loaded) return toolResult(loaded.error, {}, true);
      const scope = params.scope ?? 'text';
      const scenes = [...loaded.doc.scenes].sort((a, b) => a.order - b.order);
      let sceneIndex = 0;
      let offset = 0;
      if (params.cursor) {
        const cursor = decodeCursor(params.cursor);
        if (
          !cursor ||
          cursor.stageId !== loaded.stageId ||
          cursor.query !== params.query ||
          cursor.scope !== scope ||
          cursor.sceneIndex < 0 ||
          cursor.sceneIndex > scenes.length ||
          cursor.offset < 0
        ) {
          return toolResult('Invalid or mismatched grep_stage cursor.', {}, true);
        }
        sceneIndex = cursor.sceneIndex;
        offset = cursor.offset;
      }
      const needle = foldNfkcCaseWithOffsets(params.query).value;
      const deadline = performance.now() + SEARCH_TIME_BUDGET_MS;
      let scannedChars = 0;
      const hits: Array<{
        scenePath: string;
        order: number;
        start: number;
        end: number;
        snippet: string;
      }> = [];
      let continuation: SearchCursor | undefined;

      for (; sceneIndex < scenes.length; sceneIndex += 1, offset = 0) {
        const scene = scenes[sceneIndex]!;
        const source = grepText(scene, scope);
        if (offset > source.length)
          return toolResult('grep_stage cursor offset is out of range.', {}, true);
        if (performance.now() >= deadline || scannedChars >= MAX_SEARCH_CHARS_PER_EXEC) {
          continuation = {
            v: 1,
            stageId: loaded.stageId,
            query: params.query,
            scope,
            sceneIndex,
            offset,
          };
          break;
        }
        const remaining = MAX_SEARCH_CHARS_PER_EXEC - scannedChars;
        const bodyEnd = Math.min(source.length, offset + remaining);
        const overlapEnd = Math.min(source.length, bodyEnd + params.query.length * 4);
        const folded = foldNfkcCaseWithOffsets(source.slice(offset, overlapEnd));
        let fromIndex = 0;
        let sceneHits = 0;
        let resumeOffset = offset;
        for (;;) {
          const local = folded.value.indexOf(needle, fromIndex);
          if (local < 0) break;
          const start = offset + folded.originalStarts[local]!;
          if (start >= bodyEnd) break;
          const endFolded = local + needle.length - 1;
          const end = offset + folded.originalEnds[endFolded]!;
          const { snippetStart, snippetEnd } = boundedSnippet(source, start, end);
          hits.push({
            scenePath: `/scenes/${scene.id}`,
            order: scene.order,
            start,
            end,
            snippet: source.slice(snippetStart, snippetEnd),
          });
          sceneHits += 1;
          resumeOffset = Math.max(end, start + 1);
          fromIndex = local + Math.max(needle.length, 1);
          if (
            sceneHits >= MAX_SEARCH_HITS_PER_SCENE ||
            hits.length >= MAX_SEARCH_HITS_TOTAL ||
            performance.now() >= deadline
          ) {
            continuation = {
              v: 1,
              stageId: loaded.stageId,
              query: params.query,
              scope,
              sceneIndex,
              offset: resumeOffset,
            };
            break;
          }
        }
        scannedChars += bodyEnd - offset;
        if (continuation) break;
        if (bodyEnd < source.length) {
          continuation = {
            v: 1,
            stageId: loaded.stageId,
            query: params.query,
            scope,
            sceneIndex,
            offset: bodyEnd,
          };
          break;
        }
      }
      const truncated = continuation !== undefined;
      const cursor = continuation ? encodeCursor(continuation) : undefined;
      const details = {
        query: params.query,
        scope,
        hits,
        scannedChars,
        truncated,
        ...(cursor ? { cursor } : {}),
      };
      return toolResult(JSON.stringify(details, null, 2), details);
    },
  };

  return [readCourse, patchCourse, grepCourse] as unknown as AgentTool<never, never>[];
}

export const DSL_COURSE_TOOL_NAMES = ['read_stage', 'patch_stage', 'grep_stage'] as const;
export const DSL_COURSE_WRITE_TOOLS = ['patch_stage'] as const;
