import {
  assertValidation,
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIsoDateTime,
  validateNonEmptyString,
  type DomainValidationIssue,
  type DomainValidationResult,
  type DomainValueValidator,
} from './validation';

export type FieldStatus = 'unknown' | 'inferred' | 'confirmed';

export type EvidenceType =
  | 'project_setup'
  | 'user_input'
  | 'guardian_input'
  | 'uploaded_material'
  | 'study_attempt'
  | 'diagnostic';

export interface EvidenceRef {
  type: EvidenceType;
  sourceId?: string;
  description?: string;
  createdAt: string;
}

interface ObservedFieldBase {
  evidence: readonly EvidenceRef[];
  updatedAt: string;
}

export type ObservedField<T> =
  | (ObservedFieldBase & {
      value: null;
      status: 'unknown';
      confidence: null;
    })
  | (ObservedFieldBase & {
      value: T;
      status: 'inferred';
      confidence: number;
      evidence: readonly [EvidenceRef, ...EvidenceRef[]];
    })
  | (ObservedFieldBase & {
      value: T;
      status: 'confirmed';
      confidence: 1;
      evidence: readonly [EvidenceRef, ...EvidenceRef[]];
    });

const EVIDENCE_KEYS = new Set(['type', 'sourceId', 'description', 'createdAt']);
const OBSERVED_FIELD_KEYS = new Set(['value', 'status', 'confidence', 'evidence', 'updatedAt']);

function isEvidenceType(value: unknown): value is EvidenceType {
  return (
    value === 'project_setup' ||
    value === 'user_input' ||
    value === 'guardian_input' ||
    value === 'uploaded_material' ||
    value === 'study_attempt' ||
    value === 'diagnostic'
  );
}

function validateEvidenceRefInto(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): void {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected evidence object');
    return;
  }
  rejectUnknownKeys(value, EVIDENCE_KEYS, path, errors);
  if (!isEvidenceType(value.type)) {
    pushIssue(errors, `${path}/type`, 'unknown evidence type');
  }
  validateIsoDateTime(value.createdAt, `${path}/createdAt`, errors);
  if (Object.hasOwn(value, 'sourceId')) {
    validateNonEmptyString(value.sourceId, `${path}/sourceId`, errors);
  }
  if (Object.hasOwn(value, 'description')) {
    validateNonEmptyString(value.description, `${path}/description`, errors);
  }
}

export function validateEvidenceRef(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  validateEvidenceRefInto(value, '', errors);
  return finishValidation(errors);
}

export function validateObservedField(
  value: unknown,
  valueValidator: DomainValueValidator,
  path = '',
): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    return {
      valid: false,
      errors: [{ path: path || '/', message: 'expected observed field object' }],
    };
  }

  rejectUnknownKeys(value, OBSERVED_FIELD_KEYS, path, errors);

  validateIsoDateTime(value.updatedAt, `${path}/updatedAt`, errors);
  if (!Array.isArray(value.evidence)) {
    pushIssue(errors, `${path}/evidence`, 'expected evidence array');
  } else {
    value.evidence.forEach((evidence, index) =>
      validateEvidenceRefInto(evidence, `${path}/evidence/${index}`, errors),
    );
  }

  if (value.status === 'unknown') {
    if (value.value !== null) pushIssue(errors, `${path}/value`, 'unknown value must be null');
    if (value.confidence !== null) {
      pushIssue(errors, `${path}/confidence`, 'unknown confidence must be null');
    }
  } else if (value.status === 'inferred') {
    if (value.value === null || value.value === undefined) {
      pushIssue(errors, `${path}/value`, 'inferred value must be present');
    } else {
      valueValidator(value.value, `${path}/value`, errors);
    }
    if (
      typeof value.confidence !== 'number' ||
      !Number.isFinite(value.confidence) ||
      value.confidence <= 0 ||
      value.confidence > 1
    ) {
      pushIssue(errors, `${path}/confidence`, 'inferred confidence must be in (0, 1]');
    }
    if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
      pushIssue(errors, `${path}/evidence`, 'inferred field requires evidence');
    }
  } else if (value.status === 'confirmed') {
    if (value.value === null || value.value === undefined) {
      pushIssue(errors, `${path}/value`, 'confirmed value must be present');
    } else {
      valueValidator(value.value, `${path}/value`, errors);
    }
    if (value.confidence !== 1) {
      pushIssue(errors, `${path}/confidence`, 'confirmed confidence must equal 1');
    }
    if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
      pushIssue(errors, `${path}/evidence`, 'confirmed field requires evidence');
    } else if (
      !value.evidence.some(
        (evidence) =>
          isPlainRecord(evidence) &&
          (evidence.type === 'project_setup' ||
            evidence.type === 'user_input' ||
            evidence.type === 'guardian_input'),
      )
    ) {
      pushIssue(
        errors,
        `${path}/evidence`,
        'confirmed field requires project setup or explicit user/guardian evidence',
      );
    }
  } else {
    pushIssue(errors, `${path}/status`, 'unknown field status');
  }

  return finishValidation(errors);
}

function assertTimestamp(timestamp: string): void {
  const errors: DomainValidationIssue[] = [];
  validateIsoDateTime(timestamp, '/updatedAt', errors);
  assertValidation(finishValidation(errors), 'ZHONGKAO_OBSERVED_FIELD_INVALID');
}

function assertEvidence(evidence: readonly EvidenceRef[]): void {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error('ZHONGKAO_OBSERVED_FIELD_INVALID');
  }
  const errors: DomainValidationIssue[] = [];
  evidence.forEach((item, index) => validateEvidenceRefInto(item, `/evidence/${index}`, errors));
  assertValidation(finishValidation(errors), 'ZHONGKAO_OBSERVED_FIELD_INVALID');
}

export function createUnknownField<T>(updatedAt: string): ObservedField<T> {
  assertTimestamp(updatedAt);
  return { value: null, status: 'unknown', confidence: null, evidence: [], updatedAt };
}

export function createInferredField<T>(
  value: T,
  confidence: number,
  evidence: readonly [EvidenceRef, ...EvidenceRef[]],
  updatedAt: string,
): ObservedField<T> {
  assertTimestamp(updatedAt);
  assertEvidence(evidence);
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(confidence) ||
    confidence <= 0 ||
    confidence > 1
  ) {
    throw new Error('ZHONGKAO_OBSERVED_FIELD_INVALID');
  }
  return { value, status: 'inferred', confidence, evidence: [...evidence], updatedAt };
}

function createExplicitlyConfirmedField<T>(
  value: T,
  evidence: readonly [EvidenceRef, ...EvidenceRef[]],
  updatedAt: string,
): ObservedField<T> {
  assertTimestamp(updatedAt);
  assertEvidence(evidence);
  if (value === null || value === undefined) {
    throw new Error('ZHONGKAO_OBSERVED_FIELD_INVALID');
  }
  if (!evidence.some((item) => item.type === 'user_input' || item.type === 'guardian_input')) {
    throw new Error('ZHONGKAO_CONFIRMATION_EVIDENCE_REQUIRED');
  }
  return { value, status: 'confirmed', confidence: 1, evidence: [...evidence], updatedAt };
}

export function applyInference<T>(
  current: ObservedField<T>,
  value: T,
  confidence: number,
  evidence: EvidenceRef,
  updatedAt: string,
): ObservedField<T> {
  if (current.status === 'confirmed') return current;
  return createInferredField(value, confidence, [evidence, ...current.evidence], updatedAt);
}

export function confirmObservedField<T>(
  current: ObservedField<T>,
  value: T,
  evidence: EvidenceRef,
  updatedAt: string,
): ObservedField<T> {
  if (evidence.type !== 'user_input' && evidence.type !== 'guardian_input') {
    throw new Error('ZHONGKAO_CONFIRMATION_EVIDENCE_REQUIRED');
  }
  return createExplicitlyConfirmedField(value, [evidence, ...current.evidence], updatedAt);
}

export function isConfirmedField<T>(
  field: ObservedField<T>,
): field is Extract<ObservedField<T>, { status: 'confirmed' }> {
  return field.status === 'confirmed';
}
