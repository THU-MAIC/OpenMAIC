import { describe, expect, it } from 'vitest';
import {
  renderableMediaUrl,
  resolveMediaRef,
  type MediaTaskState,
} from '@/lib/media/resolve-media-ref';
import type { AssetUrlLeaseState } from '@/lib/media/use-asset-url';

const missing = { status: 'missing' } satisfies AssetUrlLeaseState;
const pendingLease = { status: 'pending' } satisfies AssetUrlLeaseState;
const pooled = { status: 'resolved', url: 'blob:pool' } satisfies AssetUrlLeaseState;

function task(overrides: Partial<MediaTaskState>): MediaTaskState {
  return { status: 'done', retryCount: 0, ...overrides };
}

describe('resolveMediaRef truth table', () => {
  it.each<{
    name: string;
    ref: string;
    task?: MediaTaskState;
    lease?: AssetUrlLeaseState;
    disabled?: boolean;
    expected: ReturnType<typeof resolveMediaRef>;
  }>([
    {
      name: 'pending task wins over last-good pool bytes',
      ref: 'ast_image',
      task: task({ status: 'pending' }),
      lease: pooled,
      expected: { kind: 'pending' },
    },
    {
      name: 'generating task is pending',
      ref: 'gen_img_one',
      task: task({ status: 'generating' }),
      lease: missing,
      expected: { kind: 'pending' },
    },
    {
      name: 'pending task is disabled when generation is off',
      ref: 'gen_img_disabled_pending',
      task: task({ status: 'pending' }),
      lease: missing,
      disabled: true,
      expected: { kind: 'disabled' },
    },
    {
      name: 'retryable failure without bytes is failed',
      ref: 'ast_image',
      task: task({ status: 'failed', errorCode: 'UPSTREAM_TIMEOUT' }),
      lease: missing,
      expected: { kind: 'failed', retryable: true },
    },
    {
      name: 'permanent failure without bytes is failed',
      ref: 'gen_img_sensitive',
      task: task({ status: 'failed', errorCode: 'CONTENT_SENSITIVE' }),
      lease: missing,
      expected: { kind: 'failed', retryable: false },
    },
    {
      name: 'failed regeneration keeps last-good pool bytes visible',
      ref: 'ast_image',
      task: task({ status: 'failed', errorCode: 'UPSTREAM_TIMEOUT' }),
      lease: pooled,
      expected: { kind: 'url', url: 'blob:pool', retryable: true },
    },
    {
      name: 'failed regeneration keeps its previous task URL visible',
      ref: 'ast_image',
      task: task({ status: 'failed', objectUrl: 'blob:last-good' }),
      lease: missing,
      expected: { kind: 'url', url: 'blob:last-good', retryable: true },
    },
    {
      name: 'settled pool bytes supersede a done compatibility URL',
      ref: 'ast_image',
      task: task({ objectUrl: 'blob:dexie' }),
      lease: pooled,
      expected: { kind: 'url', url: 'blob:pool' },
    },
    {
      name: 'done task URL renders while its lease is pending',
      ref: 'ast_image',
      task: task({ objectUrl: 'blob:dexie' }),
      lease: pendingLease,
      expected: { kind: 'url', url: 'blob:dexie' },
    },
    {
      name: 'task-tracked non-gen miss never becomes raw',
      ref: 'opaque_allocated_ref',
      task: task({ objectUrl: undefined }),
      lease: missing,
      expected: { kind: 'pending' },
    },
    {
      name: 'task-tracked miss is disabled when generation is off',
      ref: 'opaque_allocated_ref',
      task: task({ objectUrl: undefined }),
      lease: missing,
      disabled: true,
      expected: { kind: 'disabled' },
    },
    {
      name: 'untracked lookup stays pending until its lease settles',
      ref: 'logo.png',
      lease: pendingLease,
      expected: { kind: 'pending' },
    },
    {
      name: 'untracked pool hit is a URL',
      ref: 'opaque_ref',
      lease: pooled,
      expected: { kind: 'url', url: 'blob:pool' },
    },
    {
      name: 'untracked gen shape is never renderable',
      ref: 'gen_vid_missing',
      lease: missing,
      expected: { kind: 'placeholder' },
    },
    {
      name: 'generation-disabled placeholder is explicit',
      ref: 'gen_img_disabled',
      lease: missing,
      disabled: true,
      expected: { kind: 'disabled' },
    },
    {
      name: 'persisted disabled failure is explicit',
      ref: 'gen_img_disabled',
      task: task({ status: 'failed', errorCode: 'GENERATION_DISABLED' }),
      lease: missing,
      expected: { kind: 'disabled' },
    },
    {
      name: 'missing allocated ref is hidden',
      ref: 'ast_missing_ref',
      lease: missing,
      expected: { kind: 'placeholder' },
    },
    {
      name: 'unknown string with a confirmed miss is raw passthrough',
      ref: 'logo.png',
      lease: missing,
      expected: { kind: 'raw', value: 'logo.png' },
    },
    {
      name: 'concrete address is raw passthrough',
      ref: 'https://example.test/image.png',
      lease: missing,
      expected: { kind: 'raw', value: 'https://example.test/image.png' },
    },
  ])('$name', ({ ref, task: taskState, lease, disabled, expected }) => {
    expect(resolveMediaRef(ref, taskState, lease, disabled)).toEqual(expected);
  });

  it.each([
    { kind: 'url', url: 'blob:pool' } as const,
    { kind: 'raw', value: 'https://example.test/image.png' } as const,
  ])('allows concrete $kind output through the src boundary', (resolution) => {
    expect(renderableMediaUrl(resolution)).toMatch(/^(?:blob:|https:)/);
  });

  it.each(['  https://example.test/image.png', '\tdata:image/png;base64,AAAA'])(
    'trims leading whitespace from a concrete address before binding src',
    (ref) => {
      expect(renderableMediaUrl(resolveMediaRef(ref, undefined, missing))).toBe(ref.trimStart());
    },
  );

  it.each([
    { kind: 'url', url: 'ast_accidental' } as const,
    { kind: 'raw', value: 'opaque_accidental' } as const,
    { kind: 'pending' } as const,
    { kind: 'failed', retryable: true } as const,
    { kind: 'placeholder' } as const,
    { kind: 'disabled' } as const,
  ])('never emits $kind as a src when it is unresolved or opaque', (resolution) => {
    expect(renderableMediaUrl(resolution)).toBeUndefined();
  });
});
