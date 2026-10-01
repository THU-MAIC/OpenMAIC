/**
 * The shape of a custom agent as it is stored and sent: the browser checks an
 * agent with it before saving, and the server checks every create, update and
 * import with the same schema. Metadata (`createdAt`, `updatedAt`,
 * `isDefault`) is the server's, and generated agents (`isGenerated`,
 * `boundStageId`) belong to a course's roster, never to the registry, so none
 * of them is part of it.
 */
import { z } from 'zod';

import type { AgentConfig } from './types';
import { isBuiltInAgentId } from './built-in';

/** Most custom agents one owner keeps. */
export const MAX_CUSTOM_AGENTS = 100;

const voiceConfigSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    modelId: z.string().min(1).max(128).optional(),
    voiceId: z.string().min(1).max(256),
  })
  .strict();

const voiceDesignSchema = z
  .object({
    identity: z.string().max(500),
    texture: z.string().max(500),
    delivery: z.string().max(500),
  })
  .strict();

/** Everything of a custom agent but its id. */
export const customAgentFieldsSchema = z
  .object({
    name: z.string().min(1).max(200),
    role: z.string().min(1).max(64),
    persona: z.string().max(32_000),
    avatar: z.string().max(2_048),
    color: z.string().max(64),
    allowedActions: z.array(z.string().min(1).max(64)).max(64),
    priority: z.number().finite(),
    voiceConfig: voiceConfigSchema.optional(),
    voiceDesign: voiceDesignSchema.optional(),
  })
  .strict();

export const customAgentIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, 'an agent id is 1-128 letters, digits, "_" or "-"')
  .refine((id) => !isBuiltInAgentId(id), 'ids starting with "default-" are for built-in agents');

export const customAgentSchema = customAgentFieldsSchema
  .extend({ id: customAgentIdSchema })
  .strict();

export type CustomAgentFields = z.infer<typeof customAgentFieldsSchema>;
export type CustomAgent = z.infer<typeof customAgentSchema>;

const FIELDS = [
  'id',
  'name',
  'role',
  'persona',
  'avatar',
  'color',
  'allowedActions',
  'priority',
] as const;

/**
 * The stored fields of an agent (an `AgentConfig`, or a record an earlier
 * build persisted), with everything else left out. Not validated: parse the
 * result with {@link customAgentSchema}.
 */
export function customAgentFields(agent: Partial<AgentConfig> | Record<string, unknown>) {
  const source = agent as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of FIELDS) if (source[key] !== undefined) picked[key] = source[key];
  const voiceConfig = source.voiceConfig as Record<string, unknown> | undefined;
  if (voiceConfig && typeof voiceConfig === 'object') {
    picked.voiceConfig = {
      providerId: voiceConfig.providerId,
      ...(voiceConfig.modelId !== undefined ? { modelId: voiceConfig.modelId } : {}),
      voiceId: voiceConfig.voiceId,
    };
  }
  const voiceDesign = source.voiceDesign as Record<string, unknown> | undefined;
  if (voiceDesign && typeof voiceDesign === 'object') {
    picked.voiceDesign = {
      identity: voiceDesign.identity,
      texture: voiceDesign.texture,
      delivery: voiceDesign.delivery,
    };
  }
  return picked;
}

/** The first issue of a failed parse, as one line. */
export function describeAgentIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid agent';
  return issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}
