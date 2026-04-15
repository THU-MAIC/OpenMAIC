import { Stage, Scene } from '../types/stage';
import { UserRequirements } from '../types/generation';
import { CourseListItem } from '../types/supabase';
import { saveStageData } from '../utils/stage-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('CourseSync');

/**
 * Save a generation prompt to Supabase
 */
export async function savePromptToSupabase(params: {
  userId: string;
  requirements: UserRequirements;
  pdfFileName?: string;
}) {
  try {
    const res = await fetch('/api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: params.userId,
        requirement: params.requirements.requirement,
        language: params.requirements.language,
        pdf_file_name: params.pdfFileName,
        web_search: params.requirements.webSearch,
        aspect_ratio: params.requirements.aspectRatio,
        user_nickname: params.requirements.userNickname,
        user_bio: params.requirements.userBio,
      }),
    });

    if (!res.ok) throw new Error('Failed to save prompt');
    const data = await res.json();
    return data.prompt.id as string;
  } catch (err) {
    log.error('Error saving prompt to Supabase:', err);
    return null;
  }
}

/** Thrown when the user has exhausted their course credits (HTTP 402). */
export class CourseCreditsExhaustedError extends Error {
  reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = 'CourseCreditsExhaustedError';
    this.reason = reason;
  }
}

/**
 * Upload a course and its scenes to Supabase.
 * Throws `CourseCreditsExhaustedError` if the user has no remaining credits.
 *
 * Pass `creditsPreConsumed: true` when the calling code already consumed a
 * credit via POST /api/user/credits/check at the start of generation, so
 * the courses API skips the double-check.
 */
export async function uploadCourseToSupabase(params: {
  userId: string;
  creationPromptId?: string;
  stage: Stage;
  scenes: Scene[];
  thumbnail?: string;
  creditsPreConsumed?: boolean;
}) {
  try {
    const res = await fetch('/api/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: params.userId,
        creation_prompt_id: params.creationPromptId,
        stage_id: params.stage.id,
        name: params.stage.name,
        description: params.stage.description,
        thumbnail: params.thumbnail,
        slide_count: params.scenes.length,
        language: params.stage.language,
        style: params.stage.style,
        scenes: params.scenes,
        // Send the full Stage object so the API can preserve agentIds, whiteboard,
        // generatedAgentConfigs etc. in the Storage content.json blob.
        stage: params.stage,
        credits_pre_consumed: params.creditsPreConsumed ?? false,
      }),
    });

    if (res.status === 402) {
      const data = await res.json();
      throw new CourseCreditsExhaustedError(
        data.error || 'Course credits exhausted',
        data.reason || 'free_limit_reached',
      );
    }

    if (!res.ok) throw new Error('Failed to upload course');
    const data = await res.json();
    return data.course.id as string;
  } catch (err) {
    if (err instanceof CourseCreditsExhaustedError) throw err;
    log.error('Error uploading course to Supabase:', err);
    return null;
  }
}

/**
 * Fetch all courses for a user from Supabase (metadata only)
 */
export async function fetchUserCoursesFromSupabase(userId: string): Promise<CourseListItem[]> {
  try {
    const res = await fetch(`/api/courses?userId=${encodeURIComponent(userId)}`);
    if (!res.ok) throw new Error('Failed to fetch courses');
    const data = await res.json();
    return (data.courses || []).map((c: any) => ({
      ...c,
      is_cloud: true
    }));
  } catch (err) {
    log.error('Error fetching courses from Supabase:', err);
    return [];
  }
}

/**
 * Save course content fetched from storage/DB into local IndexedDB.
 */
async function persistCourseLocally(stage: Stage, scenes: Scene[]) {
  await saveStageData(stage.id, {
    stage,
    scenes,
    currentSceneId: scenes[0]?.id || null,
    chats: [],
  });
  log.info(`Course ${stage.id} synced to local IndexedDB.`);
}

/**
 * Download full course content by stage_id (nanoid).
 *
 * Strategy:
 *  1. Fetch directly from Supabase Storage public URL — fast, no DB round-trip.
 *  2. Fall back to DB lookup via /api/courses?stageId= → /api/courses/[id]/content.
 */
export async function downloadCourseByStageId(stageId: string): Promise<string | null> {
  // 1. Try Storage first (public bucket, direct URL construction — most reliable)
  try {
    const storageUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/courses/${stageId}/content.json`;
    const res = await fetch(storageUrl);
    if (res.ok) {
      const { stage, scenes } = await res.json() as { stage: Stage; scenes: Scene[] };
      if (stage?.id) {
        await persistCourseLocally(stage, scenes ?? []);
        log.info(`Course ${stageId} downloaded from Storage.`);
        return stage.id;
      }
    }
  } catch (err) {
    log.warn('Storage fetch failed, falling back to DB lookup:', err);
  }

  // 2. Fall back: since courses.id = stage_id in our schema, call the content API directly.
  //    This skips the fragile two-step stageId→courseId resolution entirely.
  try {
    return await downloadCourseFromSupabase(stageId);
  } catch (err) {
    log.error('Error downloading course by stageId:', err);
    return null;
  }
}

/**
 * Download full course content by Supabase internal course ID and sync to local IndexedDB.
 * Used when navigating to a cloud-only course card from the home page.
 *
 * Strategy:
 *  1. Fetch course metadata from DB to get stage_id, then try Storage.
 *  2. Fall back to reconstructing Stage from the DB content API response.
 */
export async function downloadCourseFromSupabase(supabaseCourseId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/courses/${supabaseCourseId}/content`);
    if (!res.ok) throw new Error('Failed to download course content');
    const data = await res.json();
    const { course, scenes } = data;

    // If we have a stage_id, try Storage first for the canonical full content
    if (course.stage_id) {
      try {
        const storageUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/courses/${course.stage_id}/content.json`;
        const storageRes = await fetch(storageUrl);
        if (storageRes.ok) {
          const { stage: storedStage, scenes: storedScenes } = await storageRes.json() as { stage: Stage; scenes: Scene[] };
          if (storedStage?.id) {
            await persistCourseLocally(storedStage, storedScenes ?? []);
            log.info(`Course ${course.stage_id} loaded from Storage via downloadCourseFromSupabase.`);
            return storedStage.id;
          }
        }
      } catch {
        // Storage unavailable — fall through to DB data below
      }
    }

    // Fall back: reconstruct Stage from the DB content API response
    const stage: Stage = {
      id: course.stage_id || supabaseCourseId,
      name: course.name,
      description: course.description,
      language: course.language,
      style: course.style,
      createdAt: new Date(course.created_at).getTime(),
      updatedAt: new Date(course.updated_at).getTime(),
    };

    await persistCourseLocally(stage, scenes ?? []);
    return stage.id;
  } catch (err) {
    log.error('Error downloading course from Supabase:', err);
    return null;
  }
}
