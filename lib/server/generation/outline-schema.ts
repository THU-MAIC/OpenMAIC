/**
 * One normalizer for scene outlines, applied to what the outline step
 * produced and to an outline a caller edits and confirms, so an outline the
 * step generated is always confirmable unchanged.
 *
 * It is lenient where a model is loose and strict only where the pipeline
 * depends on it: the number of scenes, the size, each scene's id and order,
 * and that a scene has a type. The type is not checked against the known
 * ones: as in the browser, a scene of a type no content path supports fails
 * at its own content step, not the outline. A `null` member is treated as absent; an optional member of the wrong
 * shape is dropped (and so are the items of a list that are not what the
 * list holds); members the schema does not know are not carried over.
 * Normalizing a normalized outline changes nothing.
 */
import { WIDGET_TYPES } from '@openmaic/dsl';

import type { SceneOutline } from '@/lib/types/generation';

/** The most scenes an outline may plan (the outline step stops reading the model there). */
export const MAX_OUTLINE_SCENES = 100;
/**
 * The most an outline may be, in UTF-8 bytes of JSON: the outline step's own
 * read cap on the model's output, in the same unit.
 */
export const MAX_OUTLINE_JSON_BYTES = 512 * 1024;
/** The bounds a confirmed outline keeps its scenes within. */
const MAX_TYPE_CHARS = 64;
const MAX_ORDER = 10_000;
const MAX_QUESTION_COUNT = 100;
const MAX_MEDIA_GENERATIONS = 20;

const QUESTION_TYPES = ['single', 'multiple', 'text'] as const;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export type NormalizedOutlines =
  | { ok: true; value: SceneOutline[] }
  | { ok: false; message: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function texts(value: unknown, { nonEmpty }: { nonEmpty: boolean }): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (item): item is string => typeof item === 'string' && (!nonEmpty || item.trim() !== ''),
  );
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Drop the members that are undefined (or empty objects of optional configs). */
function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** A JSON value with every `null` member and item removed. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => item !== null).map(withoutNulls);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([key, v]) => [key, withoutNulls(v)]),
  );
}

function mediaGenerations(value: unknown): SceneOutline['mediaGenerations'] {
  if (!Array.isArray(value)) return undefined;
  // At most so many requests; the rest go the way invalid items go.
  return value.slice(0, MAX_MEDIA_GENERATIONS).flatMap((item) => {
    const media = record(item);
    const type = oneOf(media?.type, ['image', 'video'] as const);
    const prompt = text(media?.prompt);
    const elementId = text(media?.elementId);
    if (!media || !type || prompt === undefined || !elementId) return [];
    return [
      defined({
        type,
        prompt,
        elementId,
        aspectRatio: oneOf(media.aspectRatio, ['16:9', '4:3', '1:1', '9:16'] as const),
        style: text(media.style),
      }),
    ];
  });
}

/**
 * A quiz configuration the content generator can use as it is, or none at
 * all (the generator then applies its defaults): every member present and
 * recognised, a question count within bounds, at least one question type.
 */
function quizConfig(value: unknown): SceneOutline['quizConfig'] {
  const quiz = record(value);
  if (!quiz) return undefined;
  const questionCount = finite(quiz.questionCount);
  const difficulty = oneOf(quiz.difficulty, ['easy', 'medium', 'hard'] as const);
  const questionTypes = Array.isArray(quiz.questionTypes)
    ? quiz.questionTypes.flatMap((type) => {
        const known = oneOf(type, QUESTION_TYPES);
        return known ? [known] : [];
      })
    : [];
  if (
    questionCount === undefined ||
    !Number.isInteger(questionCount) ||
    questionCount < 1 ||
    questionCount > MAX_QUESTION_COUNT ||
    !difficulty ||
    questionTypes.length === 0
  ) {
    return undefined;
  }
  return { questionCount, difficulty, questionTypes };
}

function interactiveConfig(value: unknown): SceneOutline['interactiveConfig'] {
  const config = record(value);
  if (!config) return undefined;
  return defined({
    conceptName: text(config.conceptName),
    conceptOverview: text(config.conceptOverview),
    designIdea: text(config.designIdea),
    subject: text(config.subject),
  }) as SceneOutline['interactiveConfig'];
}

function pblConfig(value: unknown): SceneOutline['pblConfig'] {
  const config = record(value);
  if (!config) return undefined;
  return defined({
    projectTopic: text(config.projectTopic),
    projectDescription: text(config.projectDescription),
    targetSkills: texts(config.targetSkills, { nonEmpty: true }),
    issueCount: finite(config.issueCount),
    scenarioRoleplay:
      typeof config.scenarioRoleplay === 'boolean' ? config.scenarioRoleplay : undefined,
    scenarioBrief: text(config.scenarioBrief),
  }) as SceneOutline['pblConfig'];
}

class OutlineRefused extends Error {}

function sceneOutline(value: unknown, index: number): SceneOutline {
  const at = `outlines[${index}]`;
  const raw = record(value);
  if (!raw) throw new OutlineRefused(`${at} must be an object`);
  const id = text(raw.id);
  if (!id || !id.trim()) throw new OutlineRefused(`${at}.id must be a non-empty string`);
  const type = text(raw.type);
  if (!type || !type.trim() || type.length > MAX_TYPE_CHARS) {
    throw new OutlineRefused(
      `${at}.type must be a non-empty string of at most ${MAX_TYPE_CHARS} characters`,
    );
  }
  const order = raw.order;
  if (typeof order !== 'number' || !Number.isInteger(order) || order < 0 || order > MAX_ORDER) {
    throw new OutlineRefused(`${at}.order must be an integer from 0 to ${MAX_ORDER}`);
  }
  const widgetOutline = record(raw.widgetOutline);
  return defined({
    id,
    type: type as SceneOutline['type'],
    title: text(raw.title) ?? '',
    description: text(raw.description) ?? '',
    keyPoints: texts(raw.keyPoints, { nonEmpty: true }) ?? [],
    teachingObjective: text(raw.teachingObjective),
    estimatedDuration: finite(raw.estimatedDuration),
    order,
    languageNote: text(raw.languageNote),
    suggestedImageIds: texts(raw.suggestedImageIds, { nonEmpty: true }),
    mediaGenerations: mediaGenerations(raw.mediaGenerations),
    quizConfig: quizConfig(raw.quizConfig),
    interactiveConfig: interactiveConfig(raw.interactiveConfig),
    pblConfig: pblConfig(raw.pblConfig),
    widgetType: oneOf(raw.widgetType, WIDGET_TYPES),
    widgetOutline: widgetOutline
      ? (withoutNulls(widgetOutline) as SceneOutline['widgetOutline'])
      : undefined,
  }) as SceneOutline;
}

/**
 * The outline in its normal form, or why it cannot be one: not 1 to
 * {@link MAX_OUTLINE_SCENES} scenes, over {@link MAX_OUTLINE_JSON_BYTES},
 * or a scene without a usable id, type or order (ids and orders unique).
 */
export function normalizeSceneOutlines(value: unknown): NormalizedOutlines {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OUTLINE_SCENES) {
    return {
      ok: false,
      message: `outlines must be an array of 1 to ${MAX_OUTLINE_SCENES} scene outlines`,
    };
  }
  const tooLarge = {
    ok: false as const,
    message: `outlines may be at most ${MAX_OUTLINE_JSON_BYTES} bytes of JSON`,
  };
  if (jsonBytes(value) > MAX_OUTLINE_JSON_BYTES) return tooLarge;
  let outlines: SceneOutline[];
  try {
    outlines = value.map(sceneOutline);
  } catch (error) {
    if (error instanceof OutlineRefused) return { ok: false, message: error.message };
    throw error;
  }
  if (new Set(outlines.map((outline) => outline.id)).size !== outlines.length) {
    return { ok: false, message: 'outlines must not repeat an id' };
  }
  if (new Set(outlines.map((outline) => outline.order)).size !== outlines.length) {
    return { ok: false, message: 'outlines must not repeat an order' };
  }
  // The normal form is measured too, so what normalizing yields always
  // normalizes again.
  if (jsonBytes(outlines) > MAX_OUTLINE_JSON_BYTES) return tooLarge;
  return { ok: true, value: outlines };
}
