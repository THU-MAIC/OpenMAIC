'use client';

/**
 * Unified status dot — one color vocabulary for ok / error / running /
 * suspended / idle, used by tool rows, tool groups and the rail header.
 * Ported from OpenPBL's `status-dot.tsx`; `running` is a small spinner
 * (never a breathing dot), the static kinds stay dots.
 */
import { LoaderCircle } from 'lucide-react';
import { wbStyles } from './chat-styles';

export type StatusDotKind = 'ok' | 'error' | 'running' | 'suspended' | 'idle';

export function normalizeStatusDot(status?: string): StatusDotKind {
  switch (status) {
    case 'ok':
    case 'done':
    case 'completed':
    case 'success':
    case 'succeeded':
      return 'ok';
    case 'error':
    case 'failed':
    case 'danger':
      return 'error';
    case 'running':
    case 'working':
    case 'in_progress':
    case 'active':
    case 'queued':
    case 'pending':
    case 'connecting':
      return 'running';
    case 'suspended':
    case 'cancelled':
      return 'suspended';
    default:
      return 'idle';
  }
}

export function StatusDot({ status }: { status?: string }) {
  const kind = normalizeStatusDot(status);
  if (kind === 'running') {
    return (
      <LoaderCircle
        aria-hidden="true"
        className="size-3 shrink-0 animate-spin text-[var(--wb-accent)] motion-reduce:animate-none"
      />
    );
  }
  return <span className={wbStyles.statusDot} data-kind={kind} aria-hidden="true" />;
}
