/**
 * The body of `POST /api/generation-runs` and of `confirm-outline`, checked
 * into their typed shapes. A failure's message is caller-facing.
 */
import { MAX_CLASSROOM_MATERIALS } from '@/lib/server/classroom-materials';
import { isMaterialId } from '@/lib/server/materials/material-id';
import type { SceneOutline } from '@/lib/types/generation';

import type { GenerationRunInput } from './types';

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const MAX_REQUIREMENT_CHARS = 20_000;
const MAX_PROFILE_FIELD_CHARS = 2_000;
const MAX_PRESET_AGENTS = 20;
/** Command ids are the caller's idempotency keys. */
const COMMAND_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

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
      agents = { mode: 'auto' };
    } else if (value?.mode === 'preset') {
      const ids = value.agentIds;
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > MAX_PRESET_AGENTS ||
        ids.some((id) => typeof id !== 'string' || !id.trim())
      ) {
        return {
          ok: false,
          message: `agents.agentIds must name 1 to ${MAX_PRESET_AGENTS} agents`,
        };
      }
      agents = { mode: 'preset', agentIds: [...new Set((ids as string[]).map((id) => id.trim()))] };
    } else {
      return {
        ok: false,
        message: 'agents must be { "mode": "auto" } or { "mode": "preset", "agentIds": [...] }',
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
      !value.providerId ||
      typeof value.voiceId !== 'string' ||
      !value.voiceId.trim() ||
      (speed !== undefined && (typeof speed !== 'number' || !(speed > 0) || speed > 4))
    ) {
      return {
        ok: false,
        message: 'voice must be { providerId, voiceId, speed? } with a speed above 0 and at most 4',
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

/** A scene outline as far as the run relies on it: an id, a title, a type and an order. */
function isSceneOutline(value: unknown): value is SceneOutline {
  const outline = record(value);
  return (
    !!outline &&
    typeof outline.id === 'string' &&
    !!outline.id &&
    typeof outline.title === 'string' &&
    typeof outline.type === 'string' &&
    typeof outline.order === 'number' &&
    Number.isFinite(outline.order)
  );
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
  if (
    !Array.isArray(body.outlines) ||
    body.outlines.length === 0 ||
    !body.outlines.every(isSceneOutline)
  ) {
    return {
      ok: false,
      message: 'outlines must be a non-empty array of scene outlines (id, title, type, order)',
    };
  }
  const ids = new Set(body.outlines.map((outline) => outline.id));
  if (ids.size !== body.outlines.length) {
    return { ok: false, message: 'outlines must not repeat an id' };
  }
  return {
    ok: true,
    value: {
      commandId: commandId.value,
      outlineRevision: revision,
      outlines: body.outlines as SceneOutline[],
    },
  };
}
