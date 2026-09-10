/**
 * Durable session-scoped material records.
 *
 * A material is the session-visible metadata row for one persisted piece of
 * content (today: a `web` page fetched by the host's `fetch_url` tool). The
 * bytes are not kept on this row — they are stored through the package's
 * hash-addressed asset registry/byte store and the row records the returned
 * asset ids (`textAssetId` for the extracted markdown, `rawAssetId` for the
 * optional raw download). The material id (`mat_` + Crockford base32 suffix)
 * is minted by {@link createMaterialId}.
 *
 * Extraction is coordinated durably on source rows. Bytes continue to live in
 * the asset registry; the lifecycle only coordinates which worker may turn a
 * source asset into a text-bearing derivative.
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
  diagnostics?: string[];
  durationSec?: number;
  asrChunks?: number;
}

export interface MaterialExtractionState {
  status: MaterialExtractionStatus;
  attempts: number;
  error?: string;
  stats?: MaterialExtractionStats;
  extractorVersion?: string;
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
  /** Asset id (registry) of the extracted text/markdown bytes. */
  textAssetId: string | null;
  /** Optional asset id (registry) of the raw downloaded bytes. */
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
    error: string,
    retryable: boolean,
  ): Promise<MaterialExtractionFailureSettlement | null>;
}
