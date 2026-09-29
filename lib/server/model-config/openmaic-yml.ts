/**
 * `openmaic.yml`: the operator's model configuration (RFC #1701, tracked in
 * #1725).
 *
 * The file declares providers, slot assignments and policy. Anything it sets
 * is locked for the web UI; anything it leaves out is left to the UI. Secrets
 * stay in the environment and are referenced as `${VAR}`.
 *
 * This module only reads and validates the file. Nothing resolves models
 * through it yet, so a deployment without the file behaves exactly as before,
 * and a deployment with an invalid file refuses to start (see
 * `validateModelConfiguration`, called from instrumentation).
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { getSlot, isSlotId, type SlotId } from '@/lib/config/model-slots';
import { getProviderPreset } from '@/lib/config/provider-presets';
import { VALID_EFFORTS, VALID_LEVELS, VALID_MODES } from '@/lib/server/model-routes';

export const DEFAULT_MODEL_CONFIG_FILE = 'openmaic.yml';

/** The environment variables `${VAR}` references are read from. */
export type ConfigEnv = Readonly<Record<string, string | undefined>>;

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** `providerId:modelId`; the model id may itself contain colons. */
const MODEL_REF = /^([a-z0-9][a-z0-9-]{0,62}):(.+)$/;
const ENV_REF = /\$\{([^}]*)\}/g;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A `${` with no closing brace, checked on the text as written. */
const UNCLOSED_ENV_REF = /\$\{[^}]*$/;

const thinkingSchema = z
  .object({
    mode: z.enum(VALID_MODES as [string, ...string[]]).optional(),
    effort: z.enum(VALID_EFFORTS as [string, ...string[]]).optional(),
    level: z.enum(VALID_LEVELS as [string, ...string[]]).optional(),
    enabled: z.boolean().optional(),
    budgetTokens: z.number().int().positive().optional(),
    excludeReasoningOutput: z.boolean().optional(),
  })
  .strict();

const modelRef = z.string().regex(MODEL_REF, 'expected "providerId:modelId"');

const assignmentObjectSchema = z
  .object({
    model: modelRef,
    thinking: thinkingSchema.optional(),
    fallback: modelRef.optional(),
    /** Agent driver only: transport dialect (for example openai-completions). */
    api: z.string().min(1).optional(),
    /** Agent driver only: context window to assume for compaction. */
    contextWindow: z.number().int().positive().optional(),
  })
  .strict();

export type SlotAssignment = null | string | z.infer<typeof assignmentObjectSchema>;

/**
 * An assignment is `null`, a model reference, or an object. The shape is
 * chosen from the value's type before validating, rather than with a union, so
 * a mistake inside the object is reported at its own path (for example
 * `slots.llm.thinking.mode`) instead of as "invalid input" on the slot.
 */
const assignmentSchema = z.unknown().transform((value, ctx): SlotAssignment => {
  if (value !== null && typeof value !== 'string' && !isPlainMapping(value)) {
    ctx.addIssue({ code: 'custom', message: 'expected null, "providerId:modelId" or a mapping' });
    return z.NEVER;
  }
  const schema =
    value === null ? z.null() : typeof value === 'string' ? modelRef : assignmentObjectSchema;
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  }
  return z.NEVER;
});

const providerSchema = z
  .object({
    preset: z.string().min(1),
    apiKey: z.string().min(1).optional(),
    baseUrl: z.url().optional(),
    models: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

const fileSchema = z
  .object({
    providers: z
      .record(z.string().regex(PROVIDER_ID, 'invalid provider id'), providerSchema)
      .optional(),
    slots: z.record(z.string(), assignmentSchema).optional(),
    policy: z.object({ allowWorkspaceProviders: z.boolean().optional() }).strict().optional(),
  })
  .strict();

export type ModelConfigFile = z.infer<typeof fileSchema>;

export class ModelConfigError extends Error {
  constructor(
    readonly file: string,
    readonly issues: readonly string[],
  ) {
    super(
      `Invalid model configuration in ${file}:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'ModelConfigError';
  }
}

function formatPath(segments: readonly PropertyKey[]): string {
  return segments.length ? segments.map(String).join('.') : '(root)';
}

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Replaces `${VAR}` in every string value; unset or empty variables are errors.
 * Only plain mappings and arrays are walked. Any other object YAML can produce
 * (an unquoted timestamp becomes a Date) is refused here: the schema would
 * otherwise accept it as an empty object. The placeholder syntax is checked
 * on the text as written, never on substituted secrets.
 */
function interpolate(
  value: unknown,
  env: ConfigEnv,
  at: PropertyKey[],
  issues: string[],
  ancestors: Set<object> = new Set(),
): unknown {
  if (typeof value === 'string') {
    if (UNCLOSED_ENV_REF.test(value)) {
      issues.push(`${formatPath(at)}: "\${" has no closing "}"`);
    }
    return value.replace(ENV_REF, (_match, name: string) => {
      if (!ENV_NAME.test(name)) {
        issues.push(`${formatPath(at)}: "\${${name}}" is not a valid environment variable name`);
        return '';
      }
      const resolved = env[name];
      if (!resolved) {
        issues.push(`${formatPath(at)}: environment variable ${name} is not set`);
        return '';
      }
      return resolved;
    });
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isPlainMapping(value)
  ) {
    // YAML turns an unquoted timestamp into a Date; nothing in the file is one.
    issues.push(`${formatPath(at)}: unsupported YAML value; quote it to use it as text`);
    return undefined;
  }
  if (!Array.isArray(value) && !isPlainMapping(value)) return value;
  if (ancestors.has(value)) {
    issues.push(`${formatPath(at)}: a YAML alias refers back to itself`);
    return undefined;
  }
  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map((item, index) => interpolate(item, env, [...at, index], issues, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          interpolate(item, env, [...at, key], issues, ancestors),
        ]),
      );
  ancestors.delete(value);
  return result;
}

function modelRefProvider(ref: string): string {
  return MODEL_REF.exec(ref)![1];
}

type Providers = Record<string, z.infer<typeof providerSchema>>;
type Slots = Record<string, SlotAssignment>;

/**
 * Checks that need the whole file: presets, slot ids, provider references.
 * Runs on every entry that is valid on its own, so a schema error elsewhere in
 * the file does not hide these problems.
 */
function crossCheck(
  providers: Providers,
  slots: Slots,
  issues: string[],
  declaredProviderIds: ReadonlySet<string> = new Set(Object.keys(providers)),
): void {
  for (const [id, provider] of Object.entries(providers)) {
    const preset = getProviderPreset(provider.preset);
    if (!preset) {
      issues.push(`providers.${id}.preset: unknown preset "${provider.preset}"`);
      continue;
    }
    if (preset.requiresBaseUrl && !provider.baseUrl) {
      issues.push(`providers.${id}.baseUrl: preset "${preset.id}" needs a baseUrl`);
    }
  }

  const covers = (ref: string, slot: SlotId, at: string) => {
    const providerId = modelRefProvider(ref);
    // Own keys only: `constructor` and friends are not declared providers.
    const provider = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
    if (!provider) {
      // A provider that is declared but invalid has its own error already.
      if (!declaredProviderIds.has(providerId)) {
        issues.push(`${at}: provider "${providerId}" is not declared under providers`);
      }
      return;
    }
    const preset = getProviderPreset(provider.preset);
    const capability = getSlot(slot).capability;
    if (preset && !preset.capabilities[capability]) {
      issues.push(
        `${at}: provider "${providerId}" (preset "${preset.id}") does not offer ${capability}`,
      );
    }
  };

  for (const [slot, assignment] of Object.entries(slots)) {
    const at = `slots.${slot}`;
    if (!isSlotId(slot)) {
      issues.push(`${at}: unknown slot`);
      continue;
    }
    if (assignment === null) continue;
    if (typeof assignment === 'string') {
      covers(assignment, slot, at);
      continue;
    }
    covers(assignment.model, slot, `${at}.model`);
    if (assignment.fallback) covers(assignment.fallback, slot, `${at}.fallback`);
    if (
      (assignment.api !== undefined || assignment.contextWindow !== undefined) &&
      slot !== 'agent'
    ) {
      issues.push(`${at}: api and contextWindow only apply to the agent slot`);
    }
  }
}

/** The entries of a section that are valid on their own, for cross-checking. */
function validEntries<T>(section: unknown, schema: z.ZodType<T>): Record<string, T> {
  if (!isPlainMapping(section)) return {};
  const entries: Record<string, T> = {};
  for (const [key, value] of Object.entries(section)) {
    const result = schema.safeParse(value);
    if (result.success) entries[key] = result.data;
  }
  return entries;
}

/** Parses and validates the text of a model configuration file. */
export function parseModelConfig(
  text: string,
  { file = DEFAULT_MODEL_CONFIG_FILE, env = process.env }: { file?: string; env?: ConfigEnv } = {},
): ModelConfigFile {
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (error) {
    throw new ModelConfigError(file, [`not valid YAML: ${(error as Error).message}`]);
  }
  if (raw === undefined || raw === null) return {};

  const issues: string[] = [];
  const interpolated = interpolate(raw, env, [], issues);
  // The whole document was refused (for example a bare timestamp).
  if (interpolated === undefined) throw new ModelConfigError(file, issues);
  const parsed = fileSchema.safeParse(interpolated);
  if (parsed.success) {
    crossCheck(parsed.data.providers ?? {}, parsed.data.slots ?? {}, issues);
  } else {
    for (const issue of parsed.error.issues) {
      issues.push(`${formatPath(issue.path)}: ${issue.message}`);
    }
    if (isPlainMapping(interpolated)) {
      crossCheck(
        validEntries(interpolated.providers, providerSchema),
        validEntries(interpolated.slots, assignmentSchema),
        issues,
        new Set(isPlainMapping(interpolated.providers) ? Object.keys(interpolated.providers) : []),
      );
    }
  }
  if (issues.length) throw new ModelConfigError(file, issues);
  return parsed.data!;
}

/**
 * Reads the operator's model configuration. `OPENMAIC_CONFIG` names the file
 * explicitly and must then exist; otherwise `openmaic.yml` in the working
 * directory is used when present. Returns null when there is no file.
 */
export function loadModelConfigFile(
  env: ConfigEnv = process.env,
  cwd: string = process.cwd(),
): ModelConfigFile | null {
  const explicit = env.OPENMAIC_CONFIG?.trim();
  const file = path.resolve(cwd, explicit || DEFAULT_MODEL_CONFIG_FILE);
  if (!fs.existsSync(file)) {
    if (explicit)
      throw new ModelConfigError(file, ['OPENMAIC_CONFIG points at a file that does not exist']);
    return null;
  }
  return parseModelConfig(fs.readFileSync(file, 'utf-8'), { file, env });
}

/** Boot check: an invalid configuration file stops the server. */
export function validateModelConfiguration(): void {
  loadModelConfigFile();
}
