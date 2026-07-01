/**
 * Pure, dependency-free structural validators for the slide DSL contract.
 *
 * This is the contract's authoritative, zero-dependency validation boundary for
 * in-process (TS / JS) producers and consumers — generators, importers, the
 * runtime engine. It checks object shape, required fields (including each action
 * variant's), known discriminants, and the scene `type` <-> `content` binding
 * that the public {@link Scene} type enforces. Producers can rely on it without
 * shipping a schema validator, because it adds no runtime dependency.
 *
 * The shipped JSON Schema (`@openmaic/dsl/schema/*`) is the cross-language
 * mirror of the same contract — reach for it from non-TS consumers, or when you
 * want exhaustive value-level (type / format) checking. These validators are a
 * structural subset (presence + discriminants); the schema additionally checks
 * each field's value shape. Both describe the same contract. No runtime
 * dependencies.
 */
import { isActionType } from './action.js';
import type { ActionType } from './action.js';

export interface ValidationIssue {
  /** JSON-pointer-ish path to the offending value, e.g. `/actions/0/elementId`. */
  path: string;
  message: string;
}

export type ValidationResult = { valid: true } | { valid: false; errors: ValidationIssue[] };

/** Runtime kind of a required field, checked with `typeof` / `Array.isArray`. */
type FieldKind = 'string' | 'number' | 'boolean' | 'object' | 'array';

/**
 * Required fields beyond `ActionBase` (`id`) for each action variant, with the
 * runtime kind each must have. Checked for presence AND shape. Kept in lockstep
 * (both directions, names + kinds) with the generated `action.schema.json` by a
 * test — the schema, derived from the TS types, is the source of truth.
 */
const ACTION_REQUIRED_FIELDS: Record<ActionType, Readonly<Record<string, FieldKind>>> = {
  spotlight: { elementId: 'string' },
  laser: { elementId: 'string' },
  play_video: { elementId: 'string' },
  speech: { text: 'string' },
  wb_open: {},
  wb_draw_text: { content: 'string', x: 'number', y: 'number' },
  wb_draw_shape: { shape: 'string', x: 'number', y: 'number', width: 'number', height: 'number' },
  wb_draw_chart: {
    chartType: 'string',
    x: 'number',
    y: 'number',
    width: 'number',
    height: 'number',
    data: 'object',
  },
  wb_draw_latex: { latex: 'string', x: 'number', y: 'number' },
  wb_draw_table: { x: 'number', y: 'number', width: 'number', height: 'number', data: 'array' },
  wb_draw_line: { startX: 'number', startY: 'number', endX: 'number', endY: 'number' },
  wb_draw_code: { language: 'string', code: 'string', x: 'number', y: 'number' },
  wb_edit_code: { elementId: 'string', operation: 'string' },
  wb_clear: {},
  wb_delete: { elementId: 'string' },
  wb_close: {},
  discussion: { topic: 'string' },
  widget_highlight: { target: 'string' },
  widget_setState: { state: 'object' },
  widget_annotation: { target: 'string' },
  widget_reveal: { target: 'string' },
};

function matchesKind(value: unknown, kind: FieldKind): boolean {
  if (kind === 'array') return Array.isArray(value);
  if (kind === 'object') return isObject(value);
  return typeof value === kind;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqString(
  o: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationIssue[],
): void {
  if (typeof o[key] !== 'string')
    errors.push({ path: `${path}/${key}`, message: `expected string \`${key}\`` });
}

function reqNumber(
  o: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationIssue[],
): void {
  if (typeof o[key] !== 'number')
    errors.push({ path: `${path}/${key}`, message: `expected number \`${key}\`` });
}

function done(errors: ValidationIssue[]): ValidationResult {
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function checkAction(doc: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isObject(doc)) {
    errors.push({ path: path || '/', message: 'action must be an object' });
    return;
  }
  reqString(doc, 'id', path, errors);
  if (!isActionType(doc.type)) {
    errors.push({
      path: `${path}/type`,
      message: `unknown action type: ${JSON.stringify(doc.type)}`,
    });
    return; // can't check variant fields without a known type
  }
  for (const [field, kind] of Object.entries(ACTION_REQUIRED_FIELDS[doc.type])) {
    const value = doc[field];
    if (value === undefined) {
      errors.push({
        path: `${path}/${field}`,
        message: `${doc.type} action requires \`${field}\``,
      });
    } else if (!matchesKind(value, kind)) {
      errors.push({
        path: `${path}/${field}`,
        message: `${doc.type} action field \`${field}\` must be ${kind}`,
      });
    }
  }
}

function checkScene(doc: unknown, path: string, errors: ValidationIssue[]): void {
  if (!isObject(doc)) {
    errors.push({ path: path || '/', message: 'scene must be an object' });
    return;
  }
  reqString(doc, 'id', path, errors);
  reqString(doc, 'stageId', path, errors);
  reqString(doc, 'title', path, errors);
  reqNumber(doc, 'order', path, errors);

  // The scene `type` is bound to its `content` (see `Scene`): a slide scene
  // carries slide content, a quiz scene quiz content. The contract owns the
  // slide/quiz kinds; app-widened kinds validate their own scenes.
  const t = doc.type;
  if (t !== 'slide' && t !== 'quiz') {
    errors.push({
      path: `${path}/type`,
      message: `unknown scene type: ${JSON.stringify(t)} (the contract owns 'slide' and 'quiz')`,
    });
  }

  const content = doc.content;
  if (!isObject(content)) {
    errors.push({ path: `${path}/content`, message: 'scene `content` must be an object' });
  } else if (t === 'slide' || t === 'quiz') {
    if (content.type !== t) {
      errors.push({
        path: `${path}/content/type`,
        message: `content type ${JSON.stringify(content.type)} does not match scene type ${JSON.stringify(t)}`,
      });
    } else if (t === 'slide' && !isObject(content.canvas)) {
      errors.push({
        path: `${path}/content/canvas`,
        message: 'slide content requires an object `canvas`',
      });
    } else if (t === 'quiz' && !Array.isArray(content.questions)) {
      errors.push({
        path: `${path}/content/questions`,
        message: 'quiz content requires a `questions` array',
      });
    }
  }

  if (doc.actions !== undefined) {
    if (!Array.isArray(doc.actions)) {
      errors.push({ path: `${path}/actions`, message: '`actions` must be an array' });
    } else {
      doc.actions.forEach((a, i) => checkAction(a, `${path}/actions/${i}`, errors));
    }
  }
}

/** Validate a {@link Stage} aggregate (course metadata; scenes are separate). */
export function validateStage(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  if (!isObject(doc))
    return { valid: false, errors: [{ path: '/', message: 'stage must be an object' }] };
  reqString(doc, 'id', '', errors);
  reqString(doc, 'name', '', errors);
  reqNumber(doc, 'createdAt', '', errors);
  reqNumber(doc, 'updatedAt', '', errors);
  return done(errors);
}

/** Validate a {@link Scene} aggregate, including its nested content + actions. */
export function validateScene(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  checkScene(doc, '', errors);
  return done(errors);
}

/** Validate a single {@link Action}, including its variant-required fields. */
export function validateAction(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  checkAction(doc, '', errors);
  return done(errors);
}
