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
import {
  getSlot,
  isSlotId,
  slotRefusesThinkingEffort,
  type SlotId,
} from '@/lib/config/model-slots';
import { getProviderPreset } from '@/lib/config/provider-presets';
import { VALID_EFFORTS, VALID_LEVELS, VALID_MODES } from '@/lib/server/model-routes';

export const DEFAULT_MODEL_CONFIG_FILE = 'openmaic.yml';

/** The environment variables `${VAR}` references are read from. */
export type ConfigEnv = Readonly<Record<string, string | undefined>>;

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/**
 * `providerId:modelId`, or `providerId` alone for the provider's default model
 * (search and document providers mostly have no model to pick). The model id
 * may itself contain colons.
 */
const MODEL_REF = /^([a-z0-9][a-z0-9-]{0,62})(?::(.+))?$/;
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

const modelRef = z
  .string()
  .regex(MODEL_REF, 'expected "providerId:modelId" (or "providerId" for its default model)');

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

/**
 * A provider's non-secret options: short names, scalar values. They are shown
 * in the settings view, so a name that sounds like a credential is refused:
 * credentials belong in `apiKey` or `credentials`.
 */
export const providerOptionsSchema = z.record(
  z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'invalid option name')
    .refine(
      (name) => !/key|secret|token|password/i.test(name),
      'options are shown in the settings; put credentials in apiKey or credentials',
    ),
  z.union([z.string().max(1024), z.number().finite(), z.boolean()]),
);

export type ProviderOptions = z.infer<typeof providerOptionsSchema>;

export const providerSchema = z
  .object({
    preset: z.string().min(1),
    apiKey: z.string().min(1).optional(),
    baseUrl: z.url().optional(),
    models: z.array(z.string().min(1)).min(1).optional(),
    /** HTTP proxy for this provider's requests. */
    proxy: z.url().optional(),
    /** Multi-part credentials for vendors that do not use a single key. */
    credentials: z.record(z.string().min(1), z.string().min(1)).optional(),
    /**
     * Provider-specific settings that are not secret (a VoxCPM `backend`, for
     * example): passed to the provider's adapter as its options. Shown in the
     * settings view, so never a place for a key.
     */
    options: providerOptionsSchema.optional(),
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
  secretPaths: Set<string>,
  ancestors: Set<object> = new Set(),
): unknown {
  if (typeof value === 'string') {
    if (value.includes('${')) secretPaths.add(formatPath(at));
    if (UNCLOSED_ENV_REF.test(value)) {
      issues.push(`${formatPath(at)}: "\${" has no closing "}"`);
    }
    return value.replace(ENV_REF, (_match, name: string) => {
      if (!ENV_NAME.test(name)) {
        issues.push(`${formatPath(at)}: "\${${name}}" is not a valid environment variable name`);
        return '';
      }
      // Own, non-empty string values only: `${constructor}` is not a variable.
      const resolved = Object.hasOwn(env, name) ? env[name] : undefined;
      if (typeof resolved !== 'string' || resolved === '') {
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
    ? value.map((item, index) =>
        interpolate(item, env, [...at, index], issues, secretPaths, ancestors),
      )
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          interpolate(item, env, [...at, key], issues, secretPaths, ancestors),
        ]),
      );
  ancestors.delete(value);
  return result;
}

/** Splits a validated `providerId:modelId` reference; the model id may contain colons. */
export function parseModelRef(ref: string): { providerId: string; modelId?: string } {
  const match = MODEL_REF.exec(ref);
  // The value is not echoed: a misplaced key is a common reason it is malformed.
  if (!match) throw new Error('Invalid model reference: expected "providerId:modelId"');
  return match[2] === undefined
    ? { providerId: match[1] }
    : { providerId: match[1], modelId: match[2] };
}

/**
 * The problem with an assignment that sets a thinking effort on a slot that
 * may not carry one (the agent: its tool calls cannot be combined with a
 * reasoning effort on every transport), else undefined. Checked for
 * openmaic.yml at load and for a workspace change when it is saved.
 */
export function thinkingEffortIssue(slot: SlotId, assignment: SlotAssignment): string | undefined {
  if (!assignment || typeof assignment === 'string') return undefined;
  if (assignment.thinking?.effort === undefined || !slotRefusesThinkingEffort(slot)) {
    return undefined;
  }
  return (
    `slots.${slot}.thinking.effort: the ${slot} slot cannot set a thinking effort, because its ` +
    'tool calls cannot be combined with a reasoning effort; set thinking.mode instead'
  );
}

/**
 * Checks that need the whole file: presets and provider references. They run
 * only on a file that passed the schema, so they never see a half-valid value.
 * Values that came from `${VAR}` are never printed.
 */
function crossCheck(
  config: ModelConfigFile,
  secretPaths: ReadonlySet<string>,
  issues: string[],
): void {
  const providers = config.providers ?? {};
  const shown = (value: string, at: string) =>
    secretPaths.has(at) ? '(value from an environment variable)' : `"${value}"`;

  for (const [id, provider] of Object.entries(providers)) {
    const at = `providers.${id}.preset`;
    const preset = getProviderPreset(provider.preset);
    if (!preset) {
      issues.push(`${at}: unknown preset ${shown(provider.preset, at)}`);
      continue;
    }
    if (preset.requiresBaseUrl && !provider.baseUrl) {
      issues.push(`providers.${id}.baseUrl: preset "${preset.id}" needs a baseUrl`);
    }
  }

  const covers = (ref: string, slot: SlotId, at: string) => {
    const { providerId, modelId } = parseModelRef(ref);
    if (modelId === undefined && getSlot(slot).capability === 'chat') {
      issues.push(`${at}: a chat model needs "providerId:modelId"`);
    }
    // Own keys only: `constructor` and friends are not declared providers.
    const provider = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
    if (!provider) {
      issues.push(`${at}: provider ${shown(providerId, at)} is not declared under providers`);
      return;
    }
    const preset = getProviderPreset(provider.preset);
    const capability = getSlot(slot).capability;
    if (preset && !preset.capabilities[capability]) {
      issues.push(
        `${at}: provider ${shown(providerId, at)} (preset "${preset.id}") does not offer ${capability}`,
      );
    }
  };

  for (const [slot, assignment] of Object.entries(config.slots ?? {})) {
    if (!isSlotId(slot) || assignment === null) continue;
    const at = `slots.${slot}`;
    if (typeof assignment === 'string') {
      covers(assignment, slot, at);
      continue;
    }
    covers(assignment.model, slot, `${at}.model`);
    if (assignment.fallback) {
      // Only language-model calls retry on a fallback (resolve-slot.ts).
      if (getSlot(slot).capability !== 'chat') {
        issues.push(`${at}.fallback: only language model slots use a fallback`);
      } else {
        covers(assignment.fallback, slot, `${at}.fallback`);
      }
    }
    if (
      (assignment.api !== undefined || assignment.contextWindow !== undefined) &&
      slot !== 'agent'
    ) {
      issues.push(`${at}: api and contextWindow only apply to the agent slot`);
    }
    const effortIssue = thinkingEffortIssue(slot, assignment);
    if (effortIssue) issues.push(effortIssue);
  }
}

/**
 * Key checks on the document as written, before the schema: the schema's
 * record type silently drops a `__proto__` key, and it does not know slot ids.
 */
function checkKeys(document: Record<string, unknown>, issues: string[]): void {
  if (isPlainMapping(document.providers) && Object.hasOwn(document.providers, '__proto__')) {
    issues.push('providers.__proto__: invalid provider id');
  }
  if (isPlainMapping(document.slots)) {
    for (const slot of Object.keys(document.slots)) {
      if (!isSlotId(slot)) issues.push(`slots.${slot}: unknown slot`);
    }
  }
}

/**
 * The schema checks alone, on a value that is already an object: for stores
 * that hold the same shape as the file (the workspace configuration), where
 * there are no placeholders and references may point at another layer.
 */
export function checkModelConfigShape(value: unknown): {
  config?: ModelConfigFile;
  issues: string[];
} {
  if (!isPlainMapping(value)) return { issues: ['(root): expected a mapping'] };
  const issues: string[] = [];
  checkKeys(value, issues);
  const parsed = fileSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      issues.push(`${formatPath(issue.path)}: ${issue.message}`);
  }
  return parsed.success && !issues.length ? { config: parsed.data, issues } : { issues };
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
    // Position only: js-yaml's message and reason can quote source text,
    // which may be a literal key.
    const mark = (error as { mark?: { line: number; column: number } }).mark;
    const where = mark ? ` at line ${mark.line + 1}, column ${mark.column + 1}` : '';
    throw new ModelConfigError(file, [`not valid YAML${where}`]);
  }
  if (raw === undefined || raw === null) return {};

  // Phase 1: the document itself (placeholders, keys, schema). Any problem here
  // stops before the cross-checks, which only ever see a fully valid file.
  const issues: string[] = [];
  const secretPaths = new Set<string>();
  const interpolated = interpolate(raw, env, [], issues, secretPaths);
  if (interpolated === undefined) throw new ModelConfigError(file, issues);
  if (isPlainMapping(interpolated)) checkKeys(interpolated, issues);
  const parsed = fileSchema.safeParse(interpolated);
  if (!parsed.success) {
    // A value whose placeholder already failed is reported once, not again
    // for being empty after substitution.
    const reported = new Set(issues.map((issue) => issue.slice(0, issue.indexOf(': '))));
    for (const issue of parsed.error.issues) {
      const at = formatPath(issue.path);
      if (!reported.has(at)) issues.push(`${at}: ${issue.message}`);
    }
  }
  if (issues.length || !parsed.success) throw new ModelConfigError(file, issues);

  // Phase 2: references between entries.
  crossCheck(parsed.data, secretPaths, issues);
  if (issues.length) throw new ModelConfigError(file, issues);
  return parsed.data;
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
