/**
 * The bodies of `POST /api/generation-runs` and its commands, read under a
 * byte cap and checked into their typed shapes. A failure's message is
 * caller-facing.
 */
import { capBodyStream } from '@/lib/server/capped-stream';
import { normalizeSceneOutlines } from '@/lib/server/generation/outline-schema';
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

export { MAX_OUTLINE_JSON_BYTES, MAX_OUTLINE_SCENES } from '@/lib/server/generation/outline-schema';

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
      const ids = agentIdList(value.agentIds, 'agents.agentIds', 0);
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

  const releaseMaterials = optionalBoolean(body.releaseMaterials, 'releaseMaterials');
  if (!releaseMaterials.ok) return releaseMaterials;

  const outlineReview = body.outlineReview ?? 'wait';
  if (outlineReview !== 'wait' && outlineReview !== 'countdown' && outlineReview !== 'auto') {
    return { ok: false, message: 'outlineReview must be "wait", "countdown" or "auto"' };
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
      ...(releaseMaterials.value && materialIds.length > 0 ? { releaseMaterials: true } : {}),
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

/** An edited outline, in the outline normalizer's normal form (the one the outline step's output takes). */
export function parseOutlines(value: unknown): Parsed<SceneOutline[]> {
  return normalizeSceneOutlines(value);
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
  // Orders follow the list, as the browser's outline editor numbers them
  // after every edit (position 1, 2, 3, ...).
  const outlines = parseOutlines(
    Array.isArray(body.outlines)
      ? body.outlines.map((outline, index) => {
          const item = record(outline);
          return item ? { ...item, order: index + 1 } : outline;
        })
      : body.outlines,
  );
  if (!outlines.ok) return outlines;
  return {
    ok: true,
    value: { commandId: commandId.value, outlineRevision: revision, outlines: outlines.value },
  };
}

export function parseHoldOutline(raw: unknown): Parsed<{ commandId: string }> {
  const body = record(raw);
  if (!body) return { ok: false, message: 'The body must be a JSON object' };
  const commandId = parseCommandId(body.commandId);
  if (!commandId.ok) return commandId;
  return { ok: true, value: { commandId: commandId.value } };
}

export interface RetryCommand {
  commandId: string;
  /** Retry this failed media element only. */
  media?: { elementId: string };
}

const MAX_ELEMENT_ID_CHARS = 128;

export function parseRetry(raw: unknown): Parsed<RetryCommand> {
  const body = record(raw);
  if (!body) return { ok: false, message: 'The body must be a JSON object' };
  const commandId = parseCommandId(body.commandId);
  if (!commandId.ok) return commandId;
  if (body.media === undefined) return { ok: true, value: { commandId: commandId.value } };
  const elementId = record(body.media)?.elementId;
  if (typeof elementId !== 'string' || !elementId || elementId.length > MAX_ELEMENT_ID_CHARS) {
    return {
      ok: false,
      message: `media must be { elementId } with an element id of 1 to ${MAX_ELEMENT_ID_CHARS} characters`,
    };
  }
  return { ok: true, value: { commandId: commandId.value, media: { elementId } } };
}
