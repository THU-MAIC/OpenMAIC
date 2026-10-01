/**
 * The bodies of `POST /api/generation-runs` and its commands, read under a
 * byte cap and checked into their typed shapes. A failure's message is
 * caller-facing.
 */
import { WIDGET_TYPES } from '@openmaic/dsl';

import { capBodyStream } from '@/lib/server/capped-stream';
import { MAX_CLASSROOM_MATERIALS } from '@/lib/server/classroom-materials';
import { isMaterialId } from '@/lib/server/materials/material-id';
import type { SceneOutline } from '@/lib/types/generation';

import type { GenerationRunInput } from './types';

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** The largest start body. */
export const MAX_START_BODY_BYTES = 64 * 1024;
/** The largest command body (an edited outline rides `confirm-outline`). */
export const MAX_COMMAND_BODY_BYTES = 1024 * 1024;

const MAX_REQUIREMENT_CHARS = 20_000;
const MAX_PROFILE_FIELD_CHARS = 2_000;
const MAX_PRESET_AGENTS = 20;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_VOICE_ID_CHARS = 256;
/** Command ids are the caller's idempotency keys. */
const COMMAND_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * An edited outline is bounded like the outline step's own output: the step
 * stops reading the model at 512 KiB of outline JSON, so a confirmed outline
 * may not be larger; nor may it plan more scenes than a course has.
 */
export const MAX_OUTLINE_SCENES = 100;
export const MAX_OUTLINE_JSON_BYTES = 512 * 1024;
const MAX_SHORT_TEXT = 500;
const MAX_LONG_TEXT = 4_000;
const MAX_LIST_ITEMS = 50;
const MAX_WIDGET_OUTLINE_BYTES = 32 * 1024;

const SCENE_TYPES = new Set(['slide', 'quiz', 'interactive', 'pbl']);

/** The request's JSON body, or a refusal (413 for a body over `maxBytes`, 400 for malformed JSON). */
export async function readJsonBody(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413; message: string }> {
  const tooLarge = {
    ok: false as const,
    status: 413 as const,
    message: `The body may be at most ${maxBytes} bytes`,
  };
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;
  if (!req.body) return { ok: false, status: 400, message: 'Invalid JSON body' };
  const capped = capBodyStream(req.body, maxBytes);
  let text: string;
  try {
    text = await new Response(capped.stream).text();
  } catch (error) {
    if (capped.exceeded()) return tooLarge;
    throw error;
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, message: 'Invalid JSON body' };
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalBoolean(value: unknown, name: string): Parsed<boolean> {
  if (value === undefined) return { ok: true, value: false };
  if (typeof value !== 'boolean') return { ok: false, message: `${name} must be a boolean` };
  return { ok: true, value };
}

function optionalText(value: unknown, name: string, max: number): Parsed<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.length > max) {
    return { ok: false, message: `${name} must be a string of at most ${max} characters` };
  }
  return { ok: true, value: value.trim() || undefined };
}

function agentIdList(value: unknown, name: string, minimum: number): Parsed<string[]> {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > MAX_PRESET_AGENTS ||
    value.some((id) => typeof id !== 'string' || !AGENT_ID_PATTERN.test(id))
  ) {
    return {
      ok: false,
      message: `${name} must name ${minimum} to ${MAX_PRESET_AGENTS} agents by id (letters, digits and ._:-, at most 128 characters)`,
    };
  }
  return { ok: true, value: [...new Set(value as string[])] };
}

export function parseRunInput(raw: unknown): Parsed<GenerationRunInput> {
  const body = record(raw);
  if (!body) return { ok: false, message: 'The body must be a JSON object' };

  const requirement = body.requirement;
  if (typeof requirement !== 'string' || !requirement.trim()) {
    return { ok: false, message: 'Missing required field: requirement' };
  }
  if (requirement.length > MAX_REQUIREMENT_CHARS) {
    return {
      ok: false,
      message: `requirement must be at most ${MAX_REQUIREMENT_CHARS} characters`,
    };
  }

  let materialIds: string[] = [];
  if (body.materialIds !== undefined) {
    const invalid = `materialIds must be an array of at most ${MAX_CLASSROOM_MATERIALS} material ids`;
    if (
      !Array.isArray(body.materialIds) ||
      body.materialIds.length > MAX_CLASSROOM_MATERIALS * 2 ||
      body.materialIds.some((id) => typeof id !== 'string' || !isMaterialId(id.trim()))
    ) {
      return { ok: false, message: invalid };
    }
    materialIds = [...new Set((body.materialIds as string[]).map((id) => id.trim()))];
    if (materialIds.length > MAX_CLASSROOM_MATERIALS) return { ok: false, message: invalid };
  }

  const interactive = optionalBoolean(body.interactive, 'interactive');
  if (!interactive.ok) return interactive;
  const taskEngine = optionalBoolean(body.taskEngine, 'taskEngine');
  if (!taskEngine.ok) return taskEngine;

  let agents: GenerationRunInput['agents'] = { mode: 'auto' };
  if (body.agents !== undefined) {
    const value = record(body.agents);
    if (value?.mode === 'auto') {
      if (value.presetAgentIds !== undefined) {
        const ids = agentIdList(value.presetAgentIds, 'agents.presetAgentIds', 0);
        if (!ids.ok) return ids;
        agents = { mode: 'auto', presetAgentIds: ids.value };
      }
    } else if (value?.mode === 'preset') {
      const ids = agentIdList(value.agentIds, 'agents.agentIds', 1);
      if (!ids.ok) return ids;
      agents = { mode: 'preset', agentIds: ids.value };
    } else {
      return {
        ok: false,
        message:
          'agents must be { "mode": "auto", "presetAgentIds"?: [...] } or { "mode": "preset", "agentIds": [...] }',
      };
    }
  }

  let learnerProfile: GenerationRunInput['learnerProfile'];
  if (body.learnerProfile !== undefined) {
    const value = record(body.learnerProfile);
    if (!value) return { ok: false, message: 'learnerProfile must be an object' };
    const nickname = optionalText(
      value.nickname,
      'learnerProfile.nickname',
      MAX_PROFILE_FIELD_CHARS,
    );
    if (!nickname.ok) return nickname;
    const bio = optionalText(value.bio, 'learnerProfile.bio', MAX_PROFILE_FIELD_CHARS);
    if (!bio.ok) return bio;
    if (nickname.value || bio.value) {
      learnerProfile = {
        ...(nickname.value ? { nickname: nickname.value } : {}),
        ...(bio.value ? { bio: bio.value } : {}),
      };
    }
  }

  const outlineReview = body.outlineReview ?? 'wait';
  if (outlineReview !== 'wait' && outlineReview !== 'auto') {
    return { ok: false, message: 'outlineReview must be "wait" or "auto"' };
  }

  let voice: GenerationRunInput['voice'];
  if (body.voice !== undefined) {
    const value = record(body.voice);
    const speed = value?.speed;
    if (
      !value ||
      typeof value.providerId !== 'string' ||
      !PROVIDER_ID_PATTERN.test(value.providerId) ||
      typeof value.voiceId !== 'string' ||
      !value.voiceId.trim() ||
      value.voiceId.length > MAX_VOICE_ID_CHARS ||
      (speed !== undefined && (typeof speed !== 'number' || !(speed > 0) || speed > 4))
    ) {
      return {
        ok: false,
        message: `voice must be { providerId, voiceId (at most ${MAX_VOICE_ID_CHARS} characters), speed? } with a speed above 0 and at most 4`,
      };
    }
    voice = {
      providerId: value.providerId,
      voiceId: value.voiceId.trim(),
      ...(speed !== undefined ? { speed: speed as number } : {}),
    };
  }

  return {
    ok: true,
    value: {
      requirement,
      materialIds,
      interactive: interactive.value,
      taskEngine: taskEngine.value,
      agents,
      ...(learnerProfile ? { learnerProfile } : {}),
      outlineReview,
      ...(voice ? { voice } : {}),
    },
  };
}

export function parseCommandId(value: unknown): Parsed<string> {
  if (typeof value !== 'string' || !COMMAND_ID_PATTERN.test(value)) {
    return {
      ok: false,
      message: 'commandId must be 1 to 128 characters of letters, digits and ._:-',
    };
  }
  return { ok: true, value };
}

export interface ConfirmOutlineCommand {
  commandId: string;
  outlineRevision: number;
  outlines?: SceneOutline[];
}

// ── The scene outline schema (the shape the outline step produces) ──

class OutlineFieldError extends Error {}

function fail(path: string, expected: string): never {
  throw new OutlineFieldError(`${path} must be ${expected}`);
}

function text(value: unknown, path: string, max: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    fail(path, `${required ? 'a non-empty' : 'a'} string of at most ${max} characters`);
  }
  return value;
}

function textList(value: unknown, path: string, required = false): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    fail(path, `an array of at most ${MAX_LIST_ITEMS} strings`);
  }
  return value.map((item, index) => text(item, `${path}[${index}]`, MAX_LONG_TEXT, true)!);
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(path, `one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function finiteNumber(value: unknown, path: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(path, `a number from ${min} to ${max}`);
  }
  return value;
}

function object(value: unknown, path: string): Record<string, unknown> {
  const result = record(value);
  if (!result) fail(path, 'an object');
  return result;
}

/** Drop the members that are undefined, so the outline stores as the step's does. */
function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function parseSceneOutline(value: unknown, path: string): SceneOutline {
  const raw = object(value, path);
  const type = raw.type;
  if (typeof type !== 'string' || !SCENE_TYPES.has(type)) {
    fail(`${path}.type`, `one of ${[...SCENE_TYPES].join(', ')}`);
  }
  const order = raw.order;
  if (typeof order !== 'number' || !Number.isInteger(order) || order < 0 || order > 10_000) {
    fail(`${path}.order`, 'an integer from 0 to 10000');
  }
  const mediaGenerations =
    raw.mediaGenerations === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(raw.mediaGenerations) || raw.mediaGenerations.length > 20) {
            fail(`${path}.mediaGenerations`, 'an array of at most 20 media requests');
          }
          return raw.mediaGenerations.map((item, index) => {
            const at = `${path}.mediaGenerations[${index}]`;
            const media = object(item, at);
            return defined({
              type: oneOf(media.type, `${at}.type`, ['image', 'video'] as const),
              prompt: text(media.prompt, `${at}.prompt`, MAX_LONG_TEXT, true)!,
              elementId: text(media.elementId, `${at}.elementId`, 128, true)!,
              aspectRatio:
                media.aspectRatio === undefined
                  ? undefined
                  : oneOf(media.aspectRatio, `${at}.aspectRatio`, [
                      '16:9',
                      '4:3',
                      '1:1',
                      '9:16',
                    ] as const),
              style: text(media.style, `${at}.style`, MAX_SHORT_TEXT),
            });
          });
        })();
  const quizConfig =
    raw.quizConfig === undefined
      ? undefined
      : (() => {
          const quiz = object(raw.quizConfig, `${path}.quizConfig`);
          if (!Array.isArray(quiz.questionTypes) || quiz.questionTypes.length > 3) {
            fail(`${path}.quizConfig.questionTypes`, 'an array of question types');
          }
          return {
            questionCount: finiteNumber(
              quiz.questionCount,
              `${path}.quizConfig.questionCount`,
              0,
              100,
            )!,
            difficulty: oneOf(quiz.difficulty, `${path}.quizConfig.difficulty`, [
              'easy',
              'medium',
              'hard',
            ] as const),
            questionTypes: quiz.questionTypes.map((item, index) =>
              oneOf(item, `${path}.quizConfig.questionTypes[${index}]`, [
                'single',
                'multiple',
                'text',
              ] as const),
            ),
          };
        })();
  const interactiveConfig =
    raw.interactiveConfig === undefined
      ? undefined
      : (() => {
          const config = object(raw.interactiveConfig, `${path}.interactiveConfig`);
          const at = `${path}.interactiveConfig`;
          return defined({
            conceptName: text(config.conceptName, `${at}.conceptName`, MAX_SHORT_TEXT, true)!,
            conceptOverview: text(config.conceptOverview, `${at}.conceptOverview`, MAX_LONG_TEXT)!,
            designIdea: text(config.designIdea, `${at}.designIdea`, MAX_LONG_TEXT)!,
            subject: text(config.subject, `${at}.subject`, MAX_SHORT_TEXT),
          });
        })();
  const pblConfig =
    raw.pblConfig === undefined
      ? undefined
      : (() => {
          const config = object(raw.pblConfig, `${path}.pblConfig`);
          const at = `${path}.pblConfig`;
          if (
            config.scenarioRoleplay !== undefined &&
            typeof config.scenarioRoleplay !== 'boolean'
          ) {
            fail(`${at}.scenarioRoleplay`, 'a boolean');
          }
          return defined({
            projectTopic: text(config.projectTopic, `${at}.projectTopic`, MAX_SHORT_TEXT, true)!,
            projectDescription: text(
              config.projectDescription,
              `${at}.projectDescription`,
              MAX_LONG_TEXT,
            )!,
            targetSkills: textList(config.targetSkills, `${at}.targetSkills`, true)!,
            issueCount: finiteNumber(config.issueCount, `${at}.issueCount`, 0, 50),
            scenarioRoleplay: config.scenarioRoleplay as boolean | undefined,
            scenarioBrief: text(config.scenarioBrief, `${at}.scenarioBrief`, MAX_LONG_TEXT),
          });
        })();
  const widgetType =
    raw.widgetType === undefined
      ? undefined
      : oneOf(raw.widgetType, `${path}.widgetType`, WIDGET_TYPES);
  const widgetOutline =
    raw.widgetOutline === undefined
      ? undefined
      : (() => {
          const widget = object(raw.widgetOutline, `${path}.widgetOutline`);
          if (Buffer.byteLength(JSON.stringify(widget), 'utf8') > MAX_WIDGET_OUTLINE_BYTES) {
            fail(`${path}.widgetOutline`, `at most ${MAX_WIDGET_OUTLINE_BYTES} bytes of JSON`);
          }
          return widget as SceneOutline['widgetOutline'];
        })();

  // Members the outline schema does not know are not carried over.
  return defined({
    id: text(raw.id, `${path}.id`, 128, true)!,
    type: type as SceneOutline['type'],
    title: text(raw.title, `${path}.title`, MAX_SHORT_TEXT, true)!,
    description: text(raw.description, `${path}.description`, MAX_LONG_TEXT) ?? '',
    keyPoints: textList(raw.keyPoints, `${path}.keyPoints`) ?? [],
    teachingObjective: text(raw.teachingObjective, `${path}.teachingObjective`, MAX_LONG_TEXT),
    estimatedDuration: finiteNumber(raw.estimatedDuration, `${path}.estimatedDuration`, 0, 86_400),
    order,
    languageNote: text(raw.languageNote, `${path}.languageNote`, MAX_LONG_TEXT),
    suggestedImageIds: textList(raw.suggestedImageIds, `${path}.suggestedImageIds`),
    mediaGenerations,
    quizConfig,
    interactiveConfig,
    pblConfig,
    widgetType,
    widgetOutline,
  }) as SceneOutline;
}

/** An edited outline: 1 to {@link MAX_OUTLINE_SCENES} valid scene outlines with unique ids and orders. */
export function parseOutlines(value: unknown): Parsed<SceneOutline[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OUTLINE_SCENES) {
    return {
      ok: false,
      message: `outlines must be an array of 1 to ${MAX_OUTLINE_SCENES} scene outlines`,
    };
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_OUTLINE_JSON_BYTES) {
    return {
      ok: false,
      message: `outlines may be at most ${MAX_OUTLINE_JSON_BYTES} bytes of JSON`,
    };
  }
  let outlines: SceneOutline[];
  try {
    outlines = value.map((item, index) => parseSceneOutline(item, `outlines[${index}]`));
  } catch (error) {
    if (error instanceof OutlineFieldError) return { ok: false, message: error.message };
    throw error;
  }
  if (new Set(outlines.map((outline) => outline.id)).size !== outlines.length) {
    return { ok: false, message: 'outlines must not repeat an id' };
  }
  if (new Set(outlines.map((outline) => outline.order)).size !== outlines.length) {
    return { ok: false, message: 'outlines must not repeat an order' };
  }
  return { ok: true, value: outlines };
}

export function parseConfirmOutline(raw: unknown): Parsed<ConfirmOutlineCommand> {
  const body = record(raw);
  if (!body) return { ok: false, message: 'The body must be a JSON object' };
  const commandId = parseCommandId(body.commandId);
  if (!commandId.ok) return commandId;
  const revision = body.outlineRevision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    return { ok: false, message: 'outlineRevision must be a positive integer' };
  }
  if (body.outlines === undefined) {
    return { ok: true, value: { commandId: commandId.value, outlineRevision: revision } };
  }
  const outlines = parseOutlines(body.outlines);
  if (!outlines.ok) return outlines;
  return {
    ok: true,
    value: { commandId: commandId.value, outlineRevision: revision, outlines: outlines.value },
  };
}
