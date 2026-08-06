'use client';

import type { MediaTask } from '@/lib/store/media-generation';
import { useAssetUrlLease, type AssetUrlLeaseState } from './use-asset-url';
import { isGeneratedMediaPlaceholder } from './media-ref';

export type MediaResolution =
  | { readonly kind: 'url'; readonly url: string; readonly retryable?: boolean }
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'failed';
      readonly retryable: boolean;
      readonly lastUrl?: string;
    }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'placeholder' }
  | { readonly kind: 'raw'; readonly value: string };

export type MediaTaskState = Pick<MediaTask, 'status' | 'objectUrl' | 'errorCode' | 'retryCount'>;

export const MISSING_ASSET_LEASE: AssetUrlLeaseState = Object.freeze({ status: 'missing' });

export function isConcreteMediaAddress(value: string | undefined): boolean {
  const candidate = value?.trimStart();
  if (!candidate || /\s/.test(candidate)) return false;
  if (/^(https?:|data:|blob:|\/|\.\.?\/)/i.test(candidate)) return true;
  // User-inserted browser-relative media is concrete too. Keep this narrow
  // enough that allocated ids and other opaque document refs do not become a
  // network request merely because their pool entry is missing.
  return (
    /^(?:[^:?#]+\/)+[^?#]*(?:[?#].*)?$/.test(candidate) ||
    /^[^:?#]+[?#].*$/.test(candidate) ||
    /^(?:[^:?#]+\/)?[^/:?#]+\.[a-z0-9]{1,12}(?:[?#].*)?$/i.test(candidate)
  );
}

function isRetryableFailure(task: MediaTaskState): boolean {
  return task.errorCode !== 'CONTENT_SENSITIVE' && task.errorCode !== 'GENERATION_DISABLED';
}

/**
 * The only media-reference decision table. Callers supply task state and the
 * current pool/Dexie lease result; this function decides whether bytes are
 * renderable, still pending, failed, a generation placeholder, or a raw source.
 */
export function resolveMediaRef(
  ref: string | undefined,
  task: MediaTaskState | undefined,
  lease: AssetUrlLeaseState = MISSING_ASSET_LEASE,
  mediaGenerationDisabled = false,
): MediaResolution {
  const value = ref ?? '';
  const leaseUrl = lease.status === 'resolved' ? lease.url : undefined;

  if (task?.status === 'pending' || task?.status === 'generating') {
    return mediaGenerationDisabled ? { kind: 'disabled' } : { kind: 'pending' };
  }

  if (task?.status === 'failed') {
    const lastUrl = leaseUrl ?? task.objectUrl;
    if (lastUrl) return { kind: 'url', url: lastUrl, retryable: isRetryableFailure(task) };
    if (task.errorCode === 'GENERATION_DISABLED') return { kind: 'disabled' };
    return { kind: 'failed', retryable: isRetryableFailure(task) };
  }

  // Prefer the shared-pool/Dexie lease once it settles. A freshly completed
  // task can still render its compatibility object URL while that lookup is in
  // flight, but a later pool replacement must win when both exist.
  if (leaseUrl) return { kind: 'url', url: leaseUrl };
  if (task?.status === 'done' && task.objectUrl) return { kind: 'url', url: task.objectUrl };

  // A known task whose durable bytes have not resolved must never be handed to
  // the DOM as a concrete address, even when its key is not gen_-shaped.
  if (task) return mediaGenerationDisabled ? { kind: 'disabled' } : { kind: 'pending' };
  if (lease.status === 'pending') return { kind: 'pending' };
  if (isGeneratedMediaPlaceholder(value)) {
    return mediaGenerationDisabled ? { kind: 'disabled' } : { kind: 'placeholder' };
  }
  return isConcreteMediaAddress(value) ? { kind: 'raw', value } : { kind: 'placeholder' };
}

/** React wrapper that owns the pool lease and feeds the same pure state machine. */
export function useResolvedMediaRef(
  ref: string | undefined,
  task: MediaTaskState | undefined,
  mediaGenerationDisabled = false,
): MediaResolution {
  const lease = useAssetUrlLease(ref && !isConcreteMediaAddress(ref) ? ref : undefined);
  return resolveMediaRef(
    ref,
    task,
    ref && !isConcreteMediaAddress(ref) ? lease : MISSING_ASSET_LEASE,
    mediaGenerationDisabled,
  );
}

export function renderableMediaUrl(state: MediaResolution): string | undefined {
  const candidate =
    state.kind === 'url' ? state.url : state.kind === 'raw' ? state.value : undefined;
  return isConcreteMediaAddress(candidate) ? candidate?.trimStart() : undefined;
}

export function mediaResolutionCanRetry(state: MediaResolution | undefined): boolean {
  return !!state && 'retryable' in state && state.retryable === true;
}
