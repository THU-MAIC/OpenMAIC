'use client';

/**
 * The guide course: a short OpenMAIC course about OpenMAIC, put into every
 * owner's library the first time their library loads, as an ordinary course
 * of theirs. From then on it is just their course: they can learn it, edit it,
 * ask the agent to change it, or delete it.
 *
 * The document ships under `public/guide-course/` (`<locale>.json`, in the
 * persisted document format, with its images and narration beside it under
 * the same prefix); the seed copies the document for the interface language
 * (Chinese for any `zh` locale, English otherwise and as the fallback).
 *
 * Once per owner. The course's id is derived from the owner's server-issued
 * learner key, so every tab and every device of one owner aims at the same
 * id: a course already there is left alone, and a deleted one stays deleted,
 * because the server permanently retires a deleted id and refuses to write it
 * again. Two tabs racing write the same document to the same id. A browser
 * remembers when its owner is settled, so later loads ask nothing.
 *
 * One per library. A library that already holds a guide course of the current
 * seed generation under another id (an anonymous copy a sign-in brought into
 * the account) is not given a second, and the server refuses one that a stale
 * list would let through (`lib/persistence/guide-courses.ts`). A claim
 * retires nothing: a visitor and an account that each had a copy keep both. A copy of an older generation does not
 * count: it is an ordinary course, and a new generation is seeded beside it
 * (`lib/persistence/guide-course-id.ts`).
 *
 * A deployment turns it off or seeds its own documents through
 * `WorkbenchShellExtensions.guideCourse` (see `shell-extensions.tsx`).
 */

import { HttpDocumentStoreError } from '@openmaic/storage';
import i18n from '@/lib/i18n/config';
import { mutateDocument, type AppDocument } from '@/lib/document-store';
import { getPersistenceLearnerKey } from '@/lib/persistence/bootstrap';
import type { Scene, Stage } from '@/lib/types/stage';
import {
  GUIDE_COURSE_EXISTS,
  guideCourseIdFor,
  isCurrentGuideCourseId,
} from '@/lib/persistence/guide-course-id';

export {
  GUIDE_COURSE_PREFIX,
  guideCourseIdFor,
  isCurrentGuideCourseId as isGuideCourseId,
} from '@/lib/persistence/guide-course-id';

/**
 * This owner's guide course among the courses they can list, if it is there:
 * a copy of the current seed generation (an older generation's copy is an
 * ordinary course, see `lib/persistence/guide-course-id.ts`).
 */
export function findGuideCourse(courses: readonly { readonly id: string }[]): string | null {
  return courses.find((course) => isCurrentGuideCourseId(course.id))?.id ?? null;
}

export type GuideCourseLocale = 'zh' | 'en';

/** Where the documents come from: `{locale}` is replaced by `zh` or `en`. */
export const DEFAULT_GUIDE_COURSE_SRC = '/guide-course/{locale}.json';

export function guideCourseLocale(language: string | undefined): GuideCourseLocale {
  return language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * Accept a persisted document (or the `{ document }` envelope the persistence
 * route answers with) and re-key it onto `id`. Anything without a stage and a
 * scene list is not a course.
 */
export function toGuideCourseDocument(raw: unknown, id: string, now: number): AppDocument | null {
  const body =
    raw && typeof raw === 'object' && 'document' in raw
      ? (raw as { document: unknown }).document
      : raw;
  if (!body || typeof body !== 'object') return null;
  const { stage, scenes } = body as { stage?: unknown; scenes?: unknown };
  if (!stage || typeof stage !== 'object' || !Array.isArray(scenes)) return null;
  return {
    stage: { ...(stage as Stage), id, createdAt: now, updatedAt: now },
    scenes: (scenes as Scene[]).map((scene) => ({
      ...scene,
      // Scene ids carry the course's, so two owners' copies never share one.
      id: `${id}-${scene.id}`,
      stageId: id,
      createdAt: now,
      updatedAt: now,
    })),
    outline: { outlines: [], generationComplete: true, createdAt: now, updatedAt: now },
  };
}

const SETTLED_KEY = 'openmaic:workspace:guide-course-seeded';
const LOCK = 'openmaic:guide-course-seed';
let inFlight: Promise<SeedOutcome> | null = null;

export type SeedOutcome = 'created' | 'present' | 'settled' | 'off' | 'retry';

/**
 * Put the guide course into this owner's library if it was never there.
 * `created` means the library has a new course; `present` means the server
 * holds a guide course the list did not show (a sign-in claim brought one in
 * after the list loaded), so the list is stale; `retry` means a transient
 * failure, to be tried on a later load. Reload the list on `created` and
 * `present`.
 */
export function seedGuideCourse(
  option: false | { readonly src: string } | undefined,
  courses: readonly { readonly id: string }[],
): Promise<SeedOutcome> {
  if (option === false) return Promise.resolve('off');
  inFlight ??= seed(option?.src ?? DEFAULT_GUIDE_COURSE_SRC, courses).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function seed(
  src: string,
  courses: readonly { readonly id: string }[],
): Promise<SeedOutcome> {
  let learnerKey: string;
  try {
    learnerKey = await getPersistenceLearnerKey();
  } catch {
    return 'retry';
  }
  const id = guideCourseIdFor(learnerKey);
  if (readSettled().includes(id)) return 'settled';
  // Another copy of the current generation (a claimed anonymous one) is this
  // library's guide course. Only the current generation counts, so a copy of
  // an older one neither stops the new seed nor marks it settled.
  if (findGuideCourse(courses)) {
    rememberSettled(id);
    return 'settled';
  }
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const run = () => write(src, id);
  return locks ? locks.request(LOCK, run) : run();
}

async function write(src: string, id: string): Promise<SeedOutcome> {
  // Another tab of this browser may have settled it while this one waited.
  if (readSettled().includes(id)) return 'settled';
  let document: AppDocument | null = null;
  try {
    const locale = guideCourseLocale(i18n.language);
    let response = await fetch(src.replace('{locale}', locale), { cache: 'no-cache' });
    if (response.status === 404 && locale !== 'en') {
      response = await fetch(src.replace('{locale}', 'en'), { cache: 'no-cache' });
    }
    if (!response.ok) return response.status === 404 ? 'off' : 'retry';
    document = toGuideCourseDocument(await response.json(), id, Date.now());
  } catch {
    return 'retry';
  }
  if (!document) return 'off';
  let wrote = false;
  try {
    await mutateDocument(
      id,
      async (_unread, store) => {
        // Already there (another tab, another device): leave it as it is.
        if (await store.loadDocument(id)) return;
        await store.saveDocument(document);
        wrote = true;
      },
      {},
      { mode: 'replace' },
    );
  } catch (error) {
    // A refusal is permanent (the owner deleted it, and its id is retired);
    // anything else is worth another try on a later load.
    const status = error instanceof HttpDocumentStoreError ? error.status : 0;
    if (error instanceof HttpDocumentStoreError && error.code === GUIDE_COURSE_EXISTS) {
      // The library has a guide course of this generation the list did not
      // show (a claim landed after it loaded): settled, and the list is stale.
      rememberSettled(id);
      return 'present';
    }
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      rememberSettled(id);
      return 'settled';
    }
    return 'retry';
  }
  rememberSettled(id);
  return wrote ? 'created' : 'settled';
}

function readSettled(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SETTLED_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rememberSettled(id: string): void {
  try {
    const all = readSettled().filter((value) => value !== id);
    localStorage.setItem(SETTLED_KEY, JSON.stringify([...all, id].slice(-20)));
  } catch {
    // Storage denied: the next load asks the server again, which is harmless.
  }
}
