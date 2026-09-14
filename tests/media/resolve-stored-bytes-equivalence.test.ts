/**
 * Frozen-base differential harness for the shared stored-bytes resolver.
 *
 * The three export paths this branch collapses into `resolveStoredBytes` are
 * reproduced below **verbatim** from their pre-#1116 implementations as of
 * commit `e1578083`. They are preserved as the differential evidence for the
 * shared resolver. This branch now sits on post-#1116 main at `1a151c4a`:
 *
 * - `pooledBytesForRef`            — `lib/export/classroom-zip-utils.ts`
 * - `resolveStoredMediaBlob` + `fetchBlob`
 *                                  — `lib/export/use-export-pptx.ts`
 * - `resolveMediaBytesWithFallback` + `resolveBytes` + `mediaRefFromRecordId`
 *                                  — `lib/video-export-app/collect.ts`
 *
 * Each frozen implementation is driven side by side with the current helper
 * under the option set its call site now passes, over the matrix declared at
 * the bottom of this file. For every combination the harness compares:
 *
 * - the outcome — returned bytes, `null`, or a thrown error and its type;
 * - **blob identity** — whether the answer is the caller's own row blob by
 *   reference, or freshly fetched bytes;
 * - the ordered sequence of lease acquisitions, Dexie reads, and fetches,
 *   **including their arguments**.
 *
 * Absolute microtask offsets are deliberately NOT compared. Extracting the
 * pool level into its own async function moves later operations one or two
 * ticks, which the PR description states; the harness asserts that the
 * sequence, the arguments, and the results are unchanged, which is what a
 * caller can observe.
 *
 * Two precisely counted divergence classes are permitted:
 *
 * - ZIP now passes its preloaded metadata row into the helper, moving the
 *   compatibility-blob fallback that the historical caller performed after
 *   `pooledBytesForRef` into the shared resolver. Thus, at this helper
 *   boundary, a usable supplied row answers after a pool miss. This is a
 *   relocation, not an archive behavior change; failed and empty rows are
 *   deliberately excluded by the new call site.
 * - A PPTX compatibility row whose `blob` is missing threw a `TypeError` out
 *   of the frozen implementation and falls through to the next byte source in
 *   the current one.
 *
 * Scope, so this file is not mistaken for total coverage: it drives the
 * current option sets of the three real call sites and only those. Call-site
 * behavior is additionally covered by the targeted export, video-export, and
 * resolver suites; no separate caller-level differential machinery is
 * duplicated here. ZIP's section includes the preloaded row
 * matrix because that caller now passes `record`; it deliberately omits
 * `stageId`, gating, CDN fallback, and task fallback because ZIP passes none of
 * them. Option combinations no call site uses -- `taskUrlFallback` without
 * `resolutionGating`, most obviously -- are outside it by construction and
 * are covered by the targeted cases in `resolve-stored-bytes.test.ts`. A
 * change that is unobservable under all three call sites' options (leaking the
 * task into the gate, for instance) does not red this file, and should not: it
 * is unobservable in production too. Nor does this file cover state that
 * mutates mid-await; the supplied row's `error` verdict timing is pinned by
 * its own tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mediaGet: vi.fn(),
  withAssetUrl: vi.fn(),
  getState: vi.fn(),
  calls: [] as string[],
}));

vi.mock('@/lib/utils/database', () => ({
  db: { mediaFiles: { get: mocks.mediaGet } },
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
}));

vi.mock('@/lib/media/use-asset-url', () => ({ withAssetUrl: mocks.withAssetUrl }));

vi.mock('@/lib/store/media-generation', () => ({
  useMediaGenerationStore: { getState: mocks.getState },
}));

import { resolveStoredBytes } from '@/lib/media/resolve-stored-bytes';
import { db, mediaFileKey, type MediaFileRecord } from '@/lib/utils/database';
import { withAssetUrl } from '@/lib/media/use-asset-url';
import type { AssetUrlLeaseState } from '@/lib/media/use-asset-url';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import {
  MISSING_ASSET_LEASE,
  isConcreteMediaAddress,
  renderableMediaUrl,
  resolveMediaRef,
  type MediaTaskState,
} from '@/lib/media/resolve-media-ref';

// ─── Frozen @ e1578083 — lib/export/classroom-zip-utils.ts ──────────────────

async function frozenZip(ref: string): Promise<Blob | null> {
  if (isConcreteMediaAddress(ref)) return null;
  try {
    return await withAssetUrl(ref, async (url) => {
      if (!url) return null;
      const blob = await fetch(url).then((response) => response.blob());
      return blob.size > 0 ? blob : null;
    });
  } catch {
    return null;
  }
}

// ─── Frozen @ e1578083 — lib/export/use-export-pptx.ts ──────────────────────

async function frozenFetchBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url);
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

async function frozenPptx(ref: string, stageId?: string): Promise<Blob | null> {
  const tasks = useMediaGenerationStore.getState().tasks;
  const task =
    tasks[ref] ??
    Object.values(tasks).find(
      (candidate) =>
        candidate.placeholderRef === ref && (!stageId || candidate.stageId === stageId),
    );
  const effectiveTask = task && (!stageId || task.stageId === stageId) ? task : undefined;
  if (!isConcreteMediaAddress(ref)) {
    try {
      const pooled = await withAssetUrl(ref, async (url) => {
        if (!url) return null;
        const state = resolveMediaRef(ref, effectiveTask, { status: 'resolved', url });
        const resolved = renderableMediaUrl(state);
        return resolved ? frozenFetchBlob(resolved) : null;
      });
      if (pooled) return pooled;
    } catch {
      // The compatibility row remains the fallback when pool access fails.
    }
  }
  if (stageId) {
    const record = await db.mediaFiles.get(mediaFileKey(stageId, ref)).catch(() => undefined);
    if (record && !record.error && record.blob.size > 0) {
      const state = resolveMediaRef(ref, effectiveTask, {
        status: 'resolved',
        url: 'dexie:media',
      });
      if (state.kind === 'url') return record.blob;
    }
  }
  const state = resolveMediaRef(ref, effectiveTask, MISSING_ASSET_LEASE);
  const resolved = renderableMediaUrl(state);
  return resolved ? frozenFetchBlob(resolved) : null;
}

// NOT part of the frozen set: this is `frozenPptx` plus exactly the documented
// blob-presence guard, used to pin the current behavior at that divergence.
async function frozenPptxRepaired(ref: string, stageId?: string): Promise<Blob | null> {
  const tasks = useMediaGenerationStore.getState().tasks;
  const task =
    tasks[ref] ??
    Object.values(tasks).find(
      (candidate) =>
        candidate.placeholderRef === ref && (!stageId || candidate.stageId === stageId),
    );
  const effectiveTask = task && (!stageId || task.stageId === stageId) ? task : undefined;
  if (!isConcreteMediaAddress(ref)) {
    try {
      const pooled = await withAssetUrl(ref, async (url) => {
        if (!url) return null;
        const state = resolveMediaRef(ref, effectiveTask, { status: 'resolved', url });
        const resolved = renderableMediaUrl(state);
        return resolved ? frozenFetchBlob(resolved) : null;
      });
      if (pooled) return pooled;
    } catch {
      // The compatibility row remains the fallback when pool access fails.
    }
  }
  if (stageId) {
    const record = await db.mediaFiles.get(mediaFileKey(stageId, ref)).catch(() => undefined);
    if (record && !record.error && record.blob && record.blob.size > 0) {
      const state = resolveMediaRef(ref, effectiveTask, {
        status: 'resolved',
        url: 'dexie:media',
      });
      if (state.kind === 'url') return record.blob;
    }
  }
  const state = resolveMediaRef(ref, effectiveTask, MISSING_ASSET_LEASE);
  const resolved = renderableMediaUrl(state);
  return resolved ? frozenFetchBlob(resolved) : null;
}

// ─── Frozen @ e1578083 — lib/video-export-app/collect.ts ────────────────────

async function frozenResolveBytes(
  blob: Blob | undefined,
  ossKey: string | undefined,
): Promise<Blob | null> {
  if (blob && blob.size > 0) return blob;
  if (!ossKey) return null;
  try {
    const res = await fetch(ossKey);
    if (!res.ok) return null;
    const fetched = await res.blob();
    return fetched.size > 0 ? fetched : null;
  } catch {
    return null;
  }
}

function frozenMediaRefFromRecordId(recordId: string): string {
  return recordId.includes(':') ? recordId.split(':').slice(1).join(':') : recordId;
}

function frozenBinding(
  ref: string | undefined,
  task: MediaTaskState | undefined,
  lease: AssetUrlLeaseState = MISSING_ASSET_LEASE,
) {
  const resolution = resolveMediaRef(ref, task, lease);
  return { resolution, src: renderableMediaUrl(resolution) ?? '' };
}

async function frozenVideo(
  assetId: string,
  record: MediaFileRecord | undefined,
  stageId?: string,
): Promise<Blob | null> {
  const usableRecord = record && !record.error ? record : undefined;
  const ref = record ? frozenMediaRefFromRecordId(record.id) : assetId;
  const tasks = useMediaGenerationStore.getState().tasks;
  const task =
    tasks[ref] ??
    Object.values(tasks).find(
      (candidate) =>
        candidate.placeholderRef === ref && (!stageId || candidate.stageId === stageId),
    );
  const effectiveTask = task && (!stageId || task.stageId === stageId) ? task : undefined;
  if (!isConcreteMediaAddress(ref)) {
    try {
      const pooled = await withAssetUrl(ref, async (url) => {
        if (!url) return null;
        const binding = frozenBinding(ref, effectiveTask, { status: 'resolved', url });
        return binding.src ? frozenResolveBytes(undefined, binding.src) : null;
      });
      if (pooled) return pooled;
    } catch {
      // The compatibility record remains the fallback when pool access fails.
    }
  }
  const stored = await frozenResolveBytes(usableRecord?.blob, usableRecord?.ossKey);
  if (stored) {
    const state = frozenBinding(ref, effectiveTask, {
      status: 'resolved',
      url: 'dexie:media',
    }).resolution;
    if (state.kind === 'url') return stored;
  }
  const resolved = frozenBinding(ref, effectiveTask).src;
  return resolved ? frozenResolveBytes(undefined, resolved) : null;
}

// ─── Matrix ─────────────────────────────────────────────────────────────────

const REFS = [
  'ast_opaque_1',
  'ast_opaque_1:variant',
  // A generation placeholder still belongs in the matrix — it exercises the
  // task and compatibility-row levels — but it is deliberately paired with a
  // pool MISS in every case (see `arm`). The pool allocates every id it
  // holds, so it cannot be holding one of these; the current resolver skips the
  // lease for exactly that reason, while the frozen implementation still asks.
  // Driving a placeholder against a pool hit would compare the two on a state
  // that cannot occur.
  'gen_img_1',
  'https://cdn.example.com/remote.png',
  'blob:local-object',
  'data:image/png;base64,AAAA',
  'nested/path/file.png',
] as const;

/**
 * Whether this matrix ref could ever name a pool asset.
 *
 * The same rule the application applies: every id the pool allocated carries
 * the `ast_` prefix, so nothing else can be in it. Note that the ref reaching
 * a lease is not always the matrix ref — a compatibility row's id is split on
 * `:` — so this is applied to whatever is actually asked for.
 */
function leasable(ref: string): boolean {
  return ref.startsWith('ast_');
}

type TaskCase = { name: string; tasks: Record<string, Record<string, unknown>> };

const taskCases = (ref: string): TaskCase[] => [
  { name: 'no-task', tasks: {} },
  {
    name: 'done-with-url',
    tasks: {
      [ref]: { status: 'done', objectUrl: 'https://cdn.example.com/task.png', stageId: 'stage-1' },
    },
  },
  { name: 'done-no-url', tasks: { [ref]: { status: 'done', stageId: 'stage-1' } } },
  { name: 'generating', tasks: { [ref]: { status: 'generating', stageId: 'stage-1' } } },
  { name: 'pending', tasks: { [ref]: { status: 'pending', stageId: 'stage-1' } } },
  {
    name: 'failed-retryable',
    tasks: {
      [ref]: {
        status: 'failed',
        errorCode: 'TRANSIENT',
        objectUrl: 'https://cdn.example.com/last.png',
        stageId: 'stage-1',
      },
    },
  },
  {
    name: 'failed-sensitive',
    tasks: { [ref]: { status: 'failed', errorCode: 'CONTENT_SENSITIVE', stageId: 'stage-1' } },
  },
  {
    name: 'other-stage',
    tasks: {
      [ref]: { status: 'done', objectUrl: 'https://cdn.example.com/other.png', stageId: 'stage-9' },
    },
  },
  {
    name: 'placeholder-ref-match',
    tasks: {
      unrelated_key: {
        status: 'done',
        objectUrl: 'https://cdn.example.com/ph.png',
        placeholderRef: ref,
        stageId: 'stage-1',
      },
    },
  },
];

const POOL_CASES = ['url', 'miss', 'throw'] as const;
const FETCH_CASES = ['ok', 'not-ok', 'empty', 'throw'] as const;

type RecordCase = { name: string; make: (ref: string) => MediaFileRecord | undefined };

const recordCases: RecordCase[] = [
  { name: 'absent', make: () => undefined },
  {
    name: 'ok',
    make: (ref) =>
      ({ id: `stage-1:${ref}`, blob: new Blob(['row']) }) as unknown as MediaFileRecord,
  },
  {
    name: 'errored',
    make: (ref) =>
      ({
        id: `stage-1:${ref}`,
        blob: new Blob(['row']),
        error: 'FAILED',
      }) as unknown as MediaFileRecord,
  },
  {
    name: 'empty-blob',
    make: (ref) => ({ id: `stage-1:${ref}`, blob: new Blob([]) }) as unknown as MediaFileRecord,
  },
  {
    name: 'empty-blob-with-oss',
    make: (ref) =>
      ({
        id: `stage-1:${ref}`,
        blob: new Blob([]),
        ossKey: 'https://cdn.example.com/oss.png',
      }) as unknown as MediaFileRecord,
  },
  {
    name: 'blobless-with-oss',
    make: (ref) =>
      ({
        id: `stage-1:${ref}`,
        ossKey: 'https://cdn.example.com/oss.png',
      }) as unknown as MediaFileRecord,
  },
  {
    name: 'non-compound-id',
    make: (ref) => ({ id: ref, blob: new Blob(['row']) }) as unknown as MediaFileRecord,
  },
];

// ZIP loads by mediaFileKey(stageId, ref), so unlike the generic resolver and
// video sections it cannot supply a non-compound compatibility-row id.
const zipRecordCases = recordCases.filter((row) => row.name !== 'non-compound-id');

const STAGES = ['stage-1', undefined] as const;

// ─── Recording rig ──────────────────────────────────────────────────────────

interface Outcome {
  kind: 'bytes' | 'null' | 'throw';
  text?: string;
  thrown?: string;
  /** Whether the answer is the caller's own row blob by reference. */
  identity?: 'row-blob' | 'fresh';
  calls: string[];
}

/**
 * The one intended divergence from the frozen behaviour.
 *
 * A ref the pool never allocated cannot be in it, so the current resolver does
 * not lease it; the frozen implementations still ask and are told no. Both
 * therefore reach the same answer through the same later levels, and the only
 * difference in the trace is the lease that no longer happens. It is removed
 * from the frozen side so everything else is still compared exactly.
 */
const LEASE_CALL = 'lease:';

/**
 * Drop the lease calls the current implementation is right to skip.
 *
 * The frozen implementations ask the pool about every reference; the current
 * one asks only about references the pool could be holding. Both are answered
 * the same way (see `arm`), so the outcomes stay comparable — but the frozen
 * call log carries requests the current one never makes, and comparing those
 * would only re-assert the skip this normalisation exists to allow.
 *
 * Filtered by the reference actually asked for, which is not always the matrix
 * reference: a compatibility row's id is split on `:` before it is leased.
 */
function withoutSkippedLease(observed: Outcome): Outcome {
  return {
    ...observed,
    calls: observed.calls.filter(
      (call) => !call.startsWith(LEASE_CALL) || leasable(call.slice(LEASE_CALL.length)),
    ),
  };
}

function arm(pool: string, fetchMode: string, tasks: Record<string, unknown>) {
  mocks.calls.length = 0;
  mocks.getState.mockReturnValue({ tasks });
  mocks.withAssetUrl.mockImplementation(
    async (ref: string, use: (url: string | null) => Promise<Blob | null>) => {
      mocks.calls.push(`lease:${ref}`);
      // The pool cannot hold a ref it never allocated, so a placeholder is a
      // miss whatever the case says — modelled here rather than by dropping the
      // ref from the matrix, which would lose its coverage of the task and
      // compatibility-row levels. The current resolver skips the lease for such
      // a ref; the frozen implementation still asks and is answered the same
      // way, so the two remain comparable on every state that can occur.
      if (!leasable(ref)) return use(null);
      if (pool === 'throw') throw new Error('pool unavailable');
      return use(pool === 'url' ? `blob:pool-${ref}` : null);
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      mocks.calls.push(`fetch:${url}`);
      if (fetchMode === 'throw') throw new Error('network');
      if (fetchMode === 'empty') return new Response(new Blob([]));
      if (fetchMode === 'not-ok') return new Response(new Blob(['err']), { status: 404 });
      return new Response(new Blob(['bytes']));
    }),
  );
}

async function capture(run: () => Promise<Blob | null>, row?: MediaFileRecord): Promise<Outcome> {
  try {
    const result = await run();
    if (!result) return { kind: 'null', calls: [...mocks.calls] };
    return {
      kind: 'bytes',
      text: await result.text(),
      identity: row && result === row.blob ? 'row-blob' : 'fresh',
      calls: [...mocks.calls],
    };
  } catch (error) {
    return { kind: 'throw', thrown: (error as Error).constructor.name, calls: [...mocks.calls] };
  }
}

describe('frozen-base differential harness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mediaGet.mockResolvedValue(undefined);
  });

  it('classroom ZIP: the shared resolver reproduces the frozen implementation', async () => {
    const divergences: string[] = [];
    let compared = 0;
    for (const ref of REFS)
      for (const task of taskCases(ref))
        for (const pool of POOL_CASES)
          for (const fetchMode of FETCH_CASES)
            for (const row of zipRecordCases) {
              const label = `ZIP ${ref} ${task.name} pool=${pool} fetch=${fetchMode} row=${row.name}`;
              const supplied = row.make(ref);
              arm(pool, fetchMode, task.tasks);
              const before = withoutSkippedLease(await capture(() => frozenZip(ref), supplied));
              arm(pool, fetchMode, task.tasks);
              const after = await capture(
                () =>
                  resolveStoredBytes(ref, {
                    record: supplied,
                    fetchPolicy: { requireOk: false, requireNonEmpty: true },
                  }),
                supplied,
              );
              compared++;
              if (before.kind === 'null' && after.kind === 'bytes') {
                // The compatibility fallback moved from the ZIP caller into
                // the resolver. Only a usable, non-empty row may account for
                // this helper-boundary divergence.
                divergences.push(label);
                expect(row.name, label).toBe('ok');
                expect(after.identity, label).toBe('row-blob');
                expect(after.calls, label).toEqual(before.calls);
                continue;
              }
              expect(after, label).toEqual(before);
            }
    expect(compared).toBe(
      REFS.length * 9 * POOL_CASES.length * FETCH_CASES.length * zipRecordCases.length,
    );
    // Every concrete ref bypasses the pool and reaches the supplied row. For
    // each opaque ref, the row is reached on pool miss/throw (8 fetch-mode
    // combinations), plus pool URL with the two rejected fetch outcomes
    // (empty/throw). A ref the pool cannot hold reaches the row in EVERY pool
    // case, because there is no pool answer to consume — the same arithmetic as
    // a concrete ref. Exactly one ZIP row case carries usable non-empty bytes.
    const concreteRefs = REFS.filter(isConcreteMediaAddress).length;
    const unleasableRefs = REFS.filter(
      (ref) => !isConcreteMediaAddress(ref) && !leasable(ref),
    ).length;
    const opaqueRefs = REFS.length - concreteRefs - unleasableRefs;
    const rowReachingOpaqueCases =
      (POOL_CASES.length - 1) * FETCH_CASES.length + 1 * (FETCH_CASES.length - 2);
    expect(divergences.length).toBe(
      ((concreteRefs + unleasableRefs) * POOL_CASES.length * FETCH_CASES.length +
        opaqueRefs * rowReachingOpaqueCases) *
        9,
    );
  });

  it('PPTX: the shared resolver reproduces the frozen implementation', async () => {
    const divergences: string[] = [];
    let compared = 0;
    for (const ref of REFS)
      for (const task of taskCases(ref))
        for (const pool of POOL_CASES)
          for (const fetchMode of FETCH_CASES)
            for (const row of recordCases)
              for (const stageId of STAGES) {
                const label = `PPTX ${ref} ${task.name} pool=${pool} fetch=${fetchMode} row=${row.name} stage=${stageId}`;
                const loaded = row.make(ref);
                arm(pool, fetchMode, task.tasks);
                mocks.mediaGet.mockImplementation(async (key: string) => {
                  mocks.calls.push(`dexie:${key}`);
                  return loaded;
                });
                const before = withoutSkippedLease(
                  await capture(() => frozenPptx(ref, stageId), loaded),
                );
                arm(pool, fetchMode, task.tasks);
                mocks.mediaGet.mockImplementation(async (key: string) => {
                  mocks.calls.push(`dexie:${key}`);
                  return loaded;
                });
                const after = await capture(
                  () =>
                    resolveStoredBytes(ref, {
                      stageId,
                      resolutionGating: true,
                      loadCompatRow: true,
                      taskUrlFallback: true,
                      fetchPolicy: { requireOk: true, requireNonEmpty: false },
                    }),
                  loaded,
                );
                compared++;
                if (before.kind === 'throw') {
                  // The single documented divergence.
                  divergences.push(label);
                  expect(before.thrown, label).toBe('TypeError');
                  expect(row.name, label).toBe('blobless-with-oss');
                  expect(stageId, label).toBe('stage-1');
                  arm(pool, fetchMode, task.tasks);
                  mocks.mediaGet.mockImplementation(async (key: string) => {
                    mocks.calls.push(`dexie:${key}`);
                    return loaded;
                  });
                  const repaired = withoutSkippedLease(
                    await capture(() => frozenPptxRepaired(ref, stageId), loaded),
                  );
                  expect(after, label).toEqual(repaired);
                  expect(after.kind, label).not.toBe('throw');
                  continue;
                }
                expect(after, label).toEqual(before);
              }
    expect(compared).toBe(
      REFS.length * 9 * POOL_CASES.length * FETCH_CASES.length * recordCases.length * STAGES.length,
    );
    // Divergences occur only for the blob-less row with a stage -- and for
    // every such combination that actually reaches the row. The frozen PPTX
    // path returns pooled bytes before it ever reads the row, so those
    // combinations never touch the unguarded `record.blob.size`: pool `url`,
    // one of the three non-concrete refs, a fetch outcome the frozen `fetchBlob`
    // accepts (`ok` and `empty` alike -- it checks only `response.ok`), and any
    // task state that still resolves to a URL, which is all of them except
    // `generating` and `pending`. Two non-concrete refs qualify: the opaque base
    // ref and the opaque ref carrying an additional colon. The generation
    // placeholder no longer does — the pool cannot hold it, so there are no
    // pooled bytes to return before the row is read.
    const bloblessStaged = REFS.length * 9 * POOL_CASES.length * FETCH_CASES.length;
    const pooledBeforeRow = 2 * 1 * 2 * 7;
    expect(divergences.length).toBe(bloblessStaged - pooledBeforeRow);
  });

  it('video export: the shared resolver reproduces the frozen implementation', async () => {
    let compared = 0;
    for (const ref of REFS)
      for (const task of taskCases(ref))
        for (const pool of POOL_CASES)
          for (const fetchMode of FETCH_CASES)
            for (const row of recordCases)
              for (const stageId of STAGES) {
                const label = `VIDEO ${ref} ${task.name} pool=${pool} fetch=${fetchMode} row=${row.name} stage=${stageId}`;
                const supplied = row.make(ref);
                arm(pool, fetchMode, task.tasks);
                const before = withoutSkippedLease(
                  await capture(() => frozenVideo(ref, supplied, stageId), supplied),
                );
                arm(pool, fetchMode, task.tasks);
                const after = await capture(
                  () =>
                    resolveStoredBytes(ref, {
                      stageId,
                      record: supplied,
                      resolutionGating: true,
                      compatRowCdnFallback: true,
                      taskUrlFallback: true,
                      fetchPolicy: { requireOk: true, requireNonEmpty: true },
                    }),
                  supplied,
                );
                expect(after, label).toEqual(before);
                compared++;
              }
    expect(compared).toBe(
      REFS.length * 9 * POOL_CASES.length * FETCH_CASES.length * recordCases.length * STAGES.length,
    );
  });
});
