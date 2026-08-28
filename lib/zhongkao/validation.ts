import { isIsoTimestamp } from '@openmaic/dsl';

export interface DomainValidationIssue {
  path: string;
  message: string;
}

export type DomainValidationResult =
  | { valid: true }
  | { valid: false; errors: DomainValidationIssue[] };

export type DomainValueValidator = (
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
) => void;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

export function finishValidation(errors: DomainValidationIssue[]): DomainValidationResult {
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

export function pushIssue(errors: DomainValidationIssue[], path: string, message: string): void {
  errors.push({ path, message });
}

export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  errors: DomainValidationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      pushIssue(errors, `${path}/${escapedPointerSegment(key)}`, 'unknown field');
  }
}

export function validateNonEmptyString(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    pushIssue(errors, path, 'expected non-empty string');
    return false;
  }
  return true;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

export function validateIdentifier(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is string {
  if (!validateNonEmptyString(value, path, errors)) return false;
  if (value !== value.trim() || value.length > 128) {
    pushIssue(errors, path, 'identifier must be trimmed and at most 128 characters');
    return false;
  }
  if (CONTROL_CHARACTER.test(value) || UNPAIRED_SURROGATE.test(value)) {
    pushIssue(errors, path, 'identifier contains an unsafe character');
    return false;
  }
  return true;
}

export function validateIsoDateTime(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is string {
  if (typeof value !== 'string' || !isIsoTimestamp(value)) {
    pushIssue(errors, path, 'expected ISO 8601 timestamp');
    return false;
  }
  return true;
}

export function assertValidation(
  result: DomainValidationResult,
  code: string,
): asserts result is { valid: true } {
  if (result.valid) return;
  const detail = result.errors.map((error) => `${error.path}: ${error.message}`).join('; ');
  throw new Error(`${code}: ${detail}`);
}

export function escapedPointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
