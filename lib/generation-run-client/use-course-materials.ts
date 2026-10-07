'use client';

/**
 * The composer's course materials: each file is uploaded as soon as it is
 * attached, then extracted by the server in the background, so Generate
 * starts a run from materials that are ready (and the preview shows no
 * analysis). A material goes uploading (with the share of its bytes sent) →
 * extracting (parsing a document, transcribing audio or video) → ready, or
 * failed with its reason (Retry uploads or extracts it again).
 *
 * Removing a material deletes it on the server, which drops an extraction in
 * progress. Materials a run was started from are handed off to it (the run
 * releases them when it is over); the rest are deleted when the composer goes
 * away (a navigation, a reload or a closed tab), as nothing restores them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nanoid } from 'nanoid';

import { buildDocumentBundle } from '@/lib/document/bundle';
import {
  courseMaterialFingerprint,
  dedupeCourseMaterialFiles,
} from '@/lib/document/course-materials';
import { MAX_VISION_IMAGES } from '@/lib/constants/generation';
import type { SelectedCourseMaterial } from '@/lib/types/generation';

import {
  deleteMaterial,
  fetchMaterialPolicy,
  fetchOwnerMaterial,
  materialMime,
  retryMaterialExtraction,
  RunApiError,
  uploadMaterial,
  type MaterialExtractionView,
  type MaterialPolicy,
  type OwnerMaterialView,
} from './api';

export type CourseMaterialStatus = 'uploading' | 'extracting' | 'ready' | 'failed';

/** A translatable message: a key with its values, or the server's own text. */
export interface CourseMaterialMessage {
  key?: string;
  values?: Record<string, string | number>;
  text?: string;
}

export interface CourseMaterialEntry extends SelectedCourseMaterial {
  status: CourseMaterialStatus;
  /** The share of the bytes sent, while uploading (0 to 1). */
  progress: number;
  /** The server's id, once uploaded. */
  materialId?: string;
  /** The MIME type the server stored it as. */
  mime?: string;
  /** Audio and video are transcribed; everything else is parsed. */
  mediaKind: 'document' | 'media';
  /** The extraction as the server last reported it. */
  extraction?: MaterialExtractionView;
  /** Why it failed, and where: a failed upload is uploaded again on Retry. */
  failure?: CourseMaterialMessage & { stage: 'upload' | 'extraction' };
}

/** How often an extracting material is polled. */
const POLL_MS = 1500;
/** Uploads at once. */
const MAX_CONCURRENT_UPLOADS = 3;
/**
 * How often an open, visible composer reads its materials back: each read
 * keeps the upload from the server's unused-upload sweep (24 hours by
 * default) and shows one that went meanwhile as removed.
 */
const KEEPALIVE_MS = 10 * 60 * 1000;

function kindOfFile(file: File): 'document' | 'media' {
  const mime = materialMime(file);
  return mime.startsWith('audio/') || mime.startsWith('video/') ? 'media' : 'document';
}

function uploadFailure(error: unknown): CourseMaterialMessage {
  if (error instanceof RunApiError) {
    return error.serverMessage
      ? { text: error.serverMessage }
      : { key: error.fallbackKey, values: error.fallbackValues };
  }
  return { text: error instanceof Error ? error.message : String(error) };
}

/** The entry as the server reports its material. */
function fromServer(entry: CourseMaterialEntry, view: OwnerMaterialView): CourseMaterialEntry {
  const extraction = view.extraction;
  const status: CourseMaterialStatus =
    extraction?.status === 'ready'
      ? 'ready'
      : extraction?.status === 'failed'
        ? 'failed'
        : 'extracting';
  return {
    ...entry,
    status,
    progress: 1,
    materialId: view.materialId,
    ...(view.mime ? { mime: view.mime } : {}),
    mediaKind: view.mediaKind,
    ...(extraction ? { extraction } : {}),
    failure:
      status === 'failed'
        ? {
            stage: 'extraction',
            ...(extraction?.error ? { text: extraction.error } : { key: 'toolbar.materialFailed' }),
          }
        : undefined,
  };
}

/**
 * What the ready materials leave out together, in the order given, when it is
 * more than any one of them leaves out alone: the bundle the run builds, from
 * what each extraction reported (its text length, pages and images).
 */
export function combinedTruncation(
  entries: readonly CourseMaterialEntry[],
): MaterialExtractionView['truncated'] | null {
  const ready = entries.filter((entry) => entry.status === 'ready' && entry.extraction);
  if (ready.length < 2) return null;
  const bundle = buildDocumentBundle(
    ready.map((entry, order) => ({
      source: {
        id: entry.id,
        name: entry.name,
        size: entry.size,
        ...(entry.mime ? { mimeType: entry.mime } : {}),
        order,
      },
      // Only the lengths count: the text itself stays on the server.
      text: '',
      rawTextLength: entry.extraction!.textChars ?? 0,
      ...(entry.extraction!.pageCount !== undefined
        ? { pageCount: entry.extraction!.pageCount }
        : {}),
      images: [],
    })),
  );
  const imageTotal = ready.reduce((sum, entry) => sum + (entry.extraction!.imageCount ?? 0), 0);
  const truncated = {
    ...(bundle.totalRawTextLength > bundle.textContentBudget &&
    !ready.some((entry) => entry.extraction!.truncated?.textChars !== undefined)
      ? { textChars: bundle.textContentBudget }
      : {}),
    ...(imageTotal > MAX_VISION_IMAGES &&
    !ready.some((entry) => entry.extraction!.truncated?.images)
      ? { images: { total: imageTotal, max: MAX_VISION_IMAGES } }
      : {}),
  };
  return Object.keys(truncated).length > 0 ? truncated : null;
}

/** Check new files against the server's material policy; the refusal, if any. */
export function policyRefusal(
  policy: MaterialPolicy,
  current: readonly Pick<SelectedCourseMaterial, 'size'>[],
  files: readonly File[],
): CourseMaterialMessage | null {
  const supported = new Set(policy.formats.map((format) => format.mime));
  if (files.some((file) => !supported.has(materialMime(file)))) {
    return { key: 'upload.unsupportedMaterialFormat' };
  }
  const tooLarge = files.find(
    (file) =>
      file.size > (kindOfFile(file) === 'media' ? policy.maxMediaBytes : policy.maxDocumentBytes),
  );
  if (tooLarge) {
    const max = kindOfFile(tooLarge) === 'media' ? policy.maxMediaBytes : policy.maxDocumentBytes;
    return {
      key: 'upload.materialTooLarge',
      values: { name: tooLarge.name, size: `${Math.floor(max / 1024 / 1024)}MB` },
    };
  }
  if (current.length + files.length > policy.maxCount) {
    return { key: 'upload.courseMaterialCountLimit', values: { n: policy.maxCount } };
  }
  const total =
    current.reduce((sum, item) => sum + item.size, 0) +
    files.reduce((sum, file) => sum + file.size, 0);
  if (total > policy.maxTotalBytes) {
    return {
      key: 'upload.courseMaterialTotalSizeLimit',
      values: { n: Math.floor(policy.maxTotalBytes / 1024 / 1024) },
    };
  }
  return null;
}

export interface CourseMaterials {
  materials: CourseMaterialEntry[];
  /** Attach files: checked against the server's policy, then uploaded. The refusal, if any. */
  add(files: File[]): Promise<CourseMaterialMessage | null>;
  /** Detach one, deleting it on the server (and stopping its upload). */
  remove(id: string): void;
  /** Upload or extract a failed one again. */
  retry(id: string): void;
  /** Whether every attached material is ready (true when there are none). */
  allReady: boolean;
  /** Hand the ready materials to a run (it releases them); their server ids, in order. */
  handOff(): string[];
  /** Take back what {@link handOff} handed, when the run did not start. */
  takeBack(materialIds: readonly string[]): void;
  /**
   * Read the attached materials back from the server (which keeps them in
   * use); false when one has gone, which its chip then shows as removed.
   */
  verify(): Promise<boolean>;
}

export function useCourseMaterials(): CourseMaterials {
  const [materials, setMaterials] = useState<CourseMaterialEntry[]>([]);
  const latest = useRef(materials);
  latest.current = materials;
  const uploads = useRef(new Map<string, AbortController>());
  const queue = useRef<string[]>([]);
  const files = useRef(new Map<string, File>());
  const handedOff = useRef(new Set<string>());
  const policy = useRef<Promise<MaterialPolicy> | null>(null);

  const update = useCallback(
    (id: string, change: (entry: CourseMaterialEntry) => CourseMaterialEntry) => {
      setMaterials((prev) => prev.map((entry) => (entry.id === id ? change(entry) : entry)));
    },
    [],
  );

  // Uploads run a few at a time, in attach order.
  const pump = useCallback(() => {
    while (uploads.current.size < MAX_CONCURRENT_UPLOADS && queue.current.length > 0) {
      const id = queue.current.shift()!;
      const file = files.current.get(id);
      if (!file) continue;
      const abort = new AbortController();
      uploads.current.set(id, abort);
      void uploadMaterial(file, {
        signal: abort.signal,
        onProgress: (sent) => update(id, (entry) => ({ ...entry, progress: sent })),
      })
        .then((view) => {
          if (abort.signal.aborted || !files.current.has(id)) {
            // Removed while its answer was on the way.
            void deleteMaterial(view.materialId).catch(() => undefined);
            return;
          }
          update(id, (entry) => fromServer(entry, view));
        })
        .catch((error: unknown) => {
          if (abort.signal.aborted) return;
          update(id, (entry) => ({
            ...entry,
            status: 'failed',
            failure: { stage: 'upload', ...uploadFailure(error) },
          }));
        })
        .finally(() => {
          uploads.current.delete(id);
          pump();
        });
    }
  }, [update]);

  const add = useCallback(
    async (incoming: File[]): Promise<CourseMaterialMessage | null> => {
      const fresh = dedupeCourseMaterialFiles(latest.current, incoming);
      if (fresh.length === 0) return null;
      // The chips appear at once (Generate waits for them) while the policy
      // is read; a refusal takes them away again.
      const additions: CourseMaterialEntry[] = fresh.map((file) => ({
        id: nanoid(8),
        file,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        type: file.type,
        order: 0,
        status: 'uploading',
        progress: 0,
        mediaKind: kindOfFile(file),
      }));
      const before = latest.current;
      const added = new Set<string>();
      setMaterials((prev) => {
        // Two attaches in one batch dedupe against the same stale list: drop
        // what the latest state already carries.
        const missing = additions.filter(
          (addition) =>
            !prev.some(
              (item) => courseMaterialFingerprint(item) === courseMaterialFingerprint(addition),
            ),
        );
        for (const addition of missing) added.add(addition.id);
        return [...prev, ...missing].map((entry, index) => ({ ...entry, order: index + 1 }));
      });
      const withdraw = () =>
        setMaterials((prev) =>
          prev
            .filter((entry) => !added.has(entry.id))
            .map((entry, index) => ({ ...entry, order: index + 1 })),
        );
      policy.current ??= fetchMaterialPolicy().catch((error) => {
        policy.current = null;
        throw error;
      });
      let refusal: CourseMaterialMessage | null;
      try {
        refusal = policyRefusal(await policy.current, before, fresh);
      } catch (error) {
        withdraw();
        return uploadFailure(error);
      }
      if (refusal) {
        withdraw();
        return refusal;
      }
      for (const addition of additions) {
        if (!added.has(addition.id)) continue;
        files.current.set(addition.id, addition.file);
        queue.current.push(addition.id);
      }
      pump();
      return null;
    },
    [pump],
  );

  const remove = useCallback((id: string) => {
    const entry = latest.current.find((item) => item.id === id);
    files.current.delete(id);
    queue.current = queue.current.filter((queued) => queued !== id);
    uploads.current.get(id)?.abort();
    if (entry?.materialId) void deleteMaterial(entry.materialId).catch(() => undefined);
    setMaterials((prev) =>
      prev.filter((item) => item.id !== id).map((item, index) => ({ ...item, order: index + 1 })),
    );
  }, []);

  const retry = useCallback(
    (id: string) => {
      const entry = latest.current.find((item) => item.id === id);
      if (!entry || entry.status !== 'failed') return;
      if (entry.failure?.stage === 'upload' || !entry.materialId) {
        update(id, (item) => ({ ...item, status: 'uploading', progress: 0, failure: undefined }));
        queue.current.push(id);
        pump();
        return;
      }
      update(id, (item) => ({ ...item, status: 'extracting', failure: undefined }));
      void retryMaterialExtraction(entry.materialId)
        .then((view) => update(id, (item) => fromServer(item, view)))
        .catch((error: unknown) => {
          // Already restarted (another tab, a run's Retry): the poll follows it.
          if (error instanceof RunApiError && error.status === 409) return;
          update(id, (item) => ({
            ...item,
            status: 'failed',
            failure: { stage: 'extraction', ...uploadFailure(error) },
          }));
        });
    },
    [pump, update],
  );

  // Extracting materials are polled until they settle.
  const extractingIds = materials
    .filter((entry) => entry.status === 'extracting' && entry.materialId)
    .map((entry) => `${entry.id}:${entry.materialId}`)
    .join(',');
  useEffect(() => {
    if (!extractingIds) return;
    let stopped = false;
    const timer = setInterval(() => {
      for (const entry of latest.current) {
        if (entry.status !== 'extracting' || !entry.materialId) continue;
        const materialId = entry.materialId;
        void fetchOwnerMaterial(materialId)
          .then((view) => {
            if (stopped) return;
            update(entry.id, (item) =>
              item.materialId !== materialId || item.status !== 'extracting'
                ? item
                : view
                  ? fromServer(item, view)
                  : {
                      ...item,
                      status: 'failed',
                      failure: { stage: 'upload', key: 'toolbar.materialUnavailable' },
                    },
            );
          })
          // A failed poll is tried again at the next tick.
          .catch(() => undefined);
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [extractingIds, update]);

  /** Read the materials back (keeping them in use); false when one has gone. */
  const reconcile = useCallback(
    async ({ handedOffToo = false }: { handedOffToo?: boolean } = {}): Promise<boolean> => {
      const checks = latest.current.flatMap((entry) => {
        const materialId = entry.materialId;
        if (!materialId || (!handedOffToo && handedOff.current.has(materialId))) return [];
        return [
          fetchOwnerMaterial(materialId).then((view) => {
            update(entry.id, (item) =>
              item.materialId !== materialId
                ? item
                : view
                  ? fromServer(item, view)
                  : {
                      ...item,
                      status: 'failed',
                      failure: { stage: 'upload', key: 'toolbar.materialUnavailable' },
                    },
            );
            return view !== null;
          }),
        ];
      });
      const present = await Promise.all(checks);
      return present.every(Boolean);
    },
    [update],
  );

  // An open composer keeps its materials in use while it is visible.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reconcile().catch(() => undefined);
    }, KEEPALIVE_MS);
    return () => clearInterval(timer);
  }, [reconcile]);

  // What was not handed to a run is deleted when the composer goes away. A
  // page kept in the back/forward cache keeps its materials (it may come back
  // as it was); the server sweeps them if it never does.
  useEffect(() => {
    const releaseAll = () => {
      for (const abort of uploads.current.values()) abort.abort();
      for (const entry of latest.current) {
        if (!entry.materialId || handedOff.current.has(entry.materialId)) continue;
        handedOff.current.add(entry.materialId);
        void deleteMaterial(entry.materialId, { keepalive: true }).catch(() => undefined);
      }
    };
    const onPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) releaseAll();
    };
    // Back from the cache: the materials may have changed (or gone) meanwhile.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void reconcile().catch(() => undefined);
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      releaseAll();
    };
  }, [reconcile]);

  const handOff = useCallback(() => {
    const ids = [...latest.current]
      .sort((a, b) => a.order - b.order)
      .flatMap((entry) => (entry.status === 'ready' && entry.materialId ? [entry.materialId] : []));
    for (const id of ids) handedOff.current.add(id);
    return ids;
  }, []);

  const takeBack = useCallback((materialIds: readonly string[]) => {
    for (const id of materialIds) handedOff.current.delete(id);
  }, []);

  const allReady = useMemo(() => materials.every((entry) => entry.status === 'ready'), [materials]);

  return {
    materials,
    add,
    remove,
    retry,
    allReady,
    handOff,
    takeBack,
    verify: () => reconcile({ handedOffToo: true }),
  };
}
