/**
 * Durable session-scoped material records.
 *
 * A material is the session-visible metadata row for one persisted piece of
 * content (today: a `web` page fetched by the host's `fetch_url` tool). The
 * bytes are not kept on this row — they are stored through the host's neutral
 * byte store and the row records server-only canonical object keys. The
 * `textAssetId` / `rawAssetId` names are legacy compatibility columns, not
 * public asset identifiers. The logical material id (`mat_` + Crockford
 * base32 suffix) is minted by {@link createMaterialId}.
 *
 * Extraction is coordinated durably on source rows. Bytes continue to live in
 * the asset registry; the lifecycle only coordinates which worker may turn a
 * source object into a text-bearing derivative.
 */
import { randomBytes } from 'node:crypto';

const CROCKFORD_BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

/** Allocate a private material id from 128 random bits. */
export function createMaterialId(): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let encoded = '';

  for (const byte of bytes) {
    value = value * 256 + byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += CROCKFORD_BASE32[(value / 2 ** bits) & 31];
      value %= 2 ** bits;
    }
  }
  if (bits > 0) encoded += CROCKFORD_BASE32[(value * 2 ** (5 - bits)) & 31];
  return `mat_${encoded}`;
}

/** Allocate an opaque token for one durable material byte-write claim. */
export function createMaterialWriteClaimId(): string {
  return createMaterialId().replace(/^mat_/, 'mwc_');
}

/**
 * The material kind vocabulary covers source uploads and their
 * extraction/transcript/media derivatives without a schema migration.
 */
export const AGENT_SESSION_MATERIAL_KINDS = [
  'source',
  'extraction',
  'transcript',
  'audio-track',
  'image',
  'web',
] as const;

export type AgentSessionMaterialKind = (typeof AGENT_SESSION_MATERIAL_KINDS)[number];

export const MATERIAL_EXTRACTION_STATUSES = [
  'idle',
  'pending',
  'running',
  'done',
  'failed',
] as const;

export type MaterialExtractionStatus = (typeof MATERIAL_EXTRACTION_STATUSES)[number];

export interface MaterialExtractionStats {
  chars: number;
  pages: number;
  imageCount: number;
  truncated?: boolean;
  durationSec?: number;
  asrChunks?: number;
}

export const MATERIAL_EXTRACTION_ERROR_CODES = [
  'MATERIAL_EXTRACTION_FAILED',
  'MATERIAL_EXTRACTION_UNSUPPORTED',
  'MATERIAL_EXTRACTION_PROVIDER_UNAVAILABLE',
  'MATERIAL_EXTRACTION_CANCELLED',
] as const;

export type MaterialExtractionErrorCode = (typeof MATERIAL_EXTRACTION_ERROR_CODES)[number];

export function isMaterialExtractionErrorCode(
  value: unknown,
): value is MaterialExtractionErrorCode {
  return (
    typeof value === 'string' &&
    (MATERIAL_EXTRACTION_ERROR_CODES as readonly string[]).includes(value)
  );
}

export interface MaterialExtractionState {
  status: MaterialExtractionStatus;
  attempts: number;
  error?: MaterialExtractionErrorCode;
  stats?: MaterialExtractionStats;
  extractorVersion?: string;
}

export const AGENT_SESSION_MATERIAL_WRITE_STATES = ['claimed', 'staged'] as const;

export type AgentSessionMaterialWriteState = (typeof AGENT_SESSION_MATERIAL_WRITE_STATES)[number];

export type AgentSessionMaterialObjectSlot = 'text' | 'raw';

/** Durable provenance for one byte-store write that has not yet become a material row. */
export interface AgentSessionMaterialWriteClaim {
  id: string;
  sessionId: string;
  materialId: string;
  materialKind: AgentSessionMaterialKind;
  derivedFrom: string | null;
  objectSlot: AgentSessionMaterialObjectSlot;
  objectKey: string;
  state: AgentSessionMaterialWriteState;
  createdAt: string;
}

export interface CreateAgentSessionMaterialWriteClaimInput {
  materialId: string;
  materialKind: AgentSessionMaterialKind;
  derivedFrom?: string;
  objectSlot: AgentSessionMaterialObjectSlot;
  objectKey: string;
}

export function isAgentSessionMaterialKind(value: unknown): value is AgentSessionMaterialKind {
  return (
    typeof value === 'string' && (AGENT_SESSION_MATERIAL_KINDS as readonly string[]).includes(value)
  );
}

/** One durable session-scoped material row. */
export interface AgentSessionMaterial {
  id: string;
  sessionId: string;
  kind: AgentSessionMaterialKind;
  title: string | null;
  /** The fetch's source URL; never a model-invented target. */
  sourceUrl: string | null;
  /** Server-only canonical object key for the extracted text/markdown bytes. */
  textAssetId: string | null;
  /** Optional server-only canonical object key for the raw bytes. */
  rawAssetId: string | null;
  /** Character count of the extracted text, for preview/paging decisions. */
  textChars: number;
  /** Source id for an extraction-produced derivative. */
  derivedFrom: string | null;
  extraction: MaterialExtractionState;
  /** ISO-8601 timestamp of the row. */
  createdAt: string;
}

export interface CreateAgentSessionMaterialInput {
  /** Caller-minted stable id; defaults to a fresh `mat_` id. */
  id?: string;
  kind: AgentSessionMaterialKind;
  title?: string;
  sourceUrl?: string;
  textAssetId?: string;
  rawAssetId?: string;
  textChars?: number;
  /** Source id for an extraction-produced derivative. */
  derivedFrom?: string;
}

export interface ClaimedMaterialExtraction {
  material: AgentSessionMaterial;
  workerId: string;
  heartbeatAt: number;
}

export interface ClaimMaterialExtractionOptions {
  leaseTtlMs: number;
}

export interface CompleteMaterialExtractionInput {
  sourceId: string;
  workerId: string;
  extractorVersion: string;
  stats: MaterialExtractionStats;
  derived:
    | (CreateAgentSessionMaterialInput & {
        id: string;
        kind: 'extraction' | 'transcript' | 'audio-track' | 'image';
      })
    | Array<
        CreateAgentSessionMaterialInput & {
          id: string;
          kind: 'extraction' | 'transcript' | 'audio-track' | 'image';
        }
      >;
}

export interface MaterialExtractionFailureSettlement {
  status: 'pending' | 'failed';
  attempts: number;
}

export const MAX_MATERIAL_EXTRACTION_RETRIES = 2;

export interface ListAgentSessionMaterialsOptions {
  /** Maximum rows returned (default 50, capped at 200). */
  limit?: number;
  /** Keyset cursor: a material id from the previous page; returns older rows. */
  before?: string;
}

/** A material operation failed for a reason the caller can act on. */
export class AgentSessionMaterialError extends Error {
  override readonly name = 'AgentSessionMaterialError';

  constructor(
    readonly code: 'invalid_input' | 'session_missing',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Session-scoped material store: create / list (keyset paged) / read.
 * Every read is scoped by `sessionId`; a foreign or nonexistent id reads as
 * absent, never as another session's row.
 */
export interface AgentSessionMaterialStore {
  createMaterial(
    sessionId: string,
    input: CreateAgentSessionMaterialInput,
  ): Promise<AgentSessionMaterial>;
  listMaterials(
    sessionId: string,
    options?: ListAgentSessionMaterialsOptions,
  ): Promise<AgentSessionMaterial[]>;
  getMaterial(sessionId: string, materialId: string): Promise<AgentSessionMaterial | null>;
  /** Delete one active-session row for host-side byte-write compensation. */
  deleteMaterial(sessionId: string, materialId: string): Promise<AgentSessionMaterial | null>;
  /** Return null unless this exact owner owns a tombstoned session. */
  getDeletedSessionMaterialsForCleanup(
    sessionId: string,
    ownerId: string,
  ): Promise<AgentSessionMaterial[] | null>;
  /** Purge rows only after the host confirms every recorded byte object is absent. */
  purgeDeletedSessionMaterials(sessionId: string, ownerId: string): Promise<boolean>;
  claimMaterialWrite(
    sessionId: string,
    input: CreateAgentSessionMaterialWriteClaimInput,
  ): Promise<AgentSessionMaterialWriteClaim>;
  /**
   * Execute the byte-store publish while holding the session tombstone fence.
   * A thrown callback rolls the claim back to `claimed` for deterministic cleanup.
   */
  executeClaimedMaterialWrite(claimId: string, write: () => Promise<void>): Promise<boolean>;
  /** Remove a staged claim only when its active-session material row records the same key. */
  finalizeMaterialWrite(sessionId: string, claimId: string): Promise<boolean>;
  /** Remove a claim after the host has confirmed that its object is absent. */
  discardMaterialWrite(sessionId: string, claimId: string): Promise<boolean>;
  getDeletedSessionMaterialWriteClaimsForCleanup(
    sessionId: string,
    ownerId: string,
  ): Promise<AgentSessionMaterialWriteClaim[] | null>;
  purgeDeletedSessionMaterialWriteClaims(sessionId: string, ownerId: string): Promise<boolean>;
  enqueueExtraction(sessionId: string, materialId: string): Promise<boolean>;
  claimNextExtraction(
    workerId: string,
    options: ClaimMaterialExtractionOptions,
  ): Promise<ClaimedMaterialExtraction | null>;
  heartbeatExtraction(materialId: string, workerId: string): Promise<boolean>;
  completeExtraction(input: CompleteMaterialExtractionInput): Promise<boolean>;
  settleExtractionFailure(
    materialId: string,
    workerId: string,
    error: MaterialExtractionErrorCode,
    retryable: boolean,
  ): Promise<MaterialExtractionFailureSettlement | null>;
}
