import { createAdminClient } from '@/utils/supabase/admin';
import { createLogger } from '@/lib/logger';
import type { Scene, Stage } from '@/lib/types/stage';

const log = createLogger('IncrementalCourseDbSync');

function isSupabaseAdminConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function formatSceneRow(courseId: string, s: Scene) {
  return {
    course_id: courseId,
    scene_id: s.id,
    type: s.type,
    title: s.title,
    order: s.order,
    content: s.content,
    actions: s.actions,
    whiteboards: s.whiteboards,
  };
}

/**
 * Upserts the course row and appends one scene (replacing any prior row with the same scene_id).
 * Uploads cumulative content.json for progressive cloud availability during server-side generation.
 */
export async function pushLatestGeneratedSceneToSupabase(params: {
  stage: Stage;
  scenes: Scene[];
  courseDescription?: string | null;
}): Promise<void> {
  const { stage, scenes } = params;
  if (!isSupabaseAdminConfigured()) {
    return;
  }
  const latest = scenes[scenes.length - 1];
  if (!latest) return;

  try {
    const supabase = createAdminClient();
    const courseId = stage.id;

    const { error: courseError } = await supabase.from('courses').upsert(
      {
        id: courseId,
        stage_id: courseId,
        name: stage.name,
        title: stage.name,
        description: stage.description ?? params.courseDescription ?? undefined,
        slide_count: scenes.length,
        language: stage.language || 'en-US',
        style: stage.style,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );

    if (courseError) {
      log.error('Incremental course upsert failed:', courseError);
      return;
    }

    await supabase.from('scenes').delete().eq('course_id', courseId).eq('scene_id', latest.id);

    const { error: sceneError } = await supabase.from('scenes').insert(formatSceneRow(courseId, latest));

    if (sceneError) {
      log.error('Incremental scene insert failed:', sceneError);
      return;
    }

    const storageContent = JSON.stringify({ stage, scenes });
    const { error: storageError } = await supabase.storage
      .from('courses')
      .upload(`${courseId}/content.json`, storageContent, {
        contentType: 'application/json',
        upsert: true,
      });

    if (storageError) {
      log.warn('Incremental storage upload failed:', storageError.message);
    }
  } catch (e) {
    log.warn('Incremental Supabase sync skipped or failed:', e);
  }
}

/**
 * Replaces all scene rows and content.json with the final in-memory course (e.g. after media/TTS).
 * Matches POST /api/courses behaviour for the scenes table and storage blob.
 */
export async function replaceAllCourseScenesInSupabase(params: {
  stage: Stage;
  scenes: Scene[];
  courseDescription?: string | null;
}): Promise<void> {
  const { stage, scenes } = params;
  if (!isSupabaseAdminConfigured()) {
    return;
  }
  if (scenes.length === 0) return;

  try {
    const supabase = createAdminClient();
    const courseId = stage.id;

    const { error: courseError } = await supabase.from('courses').upsert(
      {
        id: courseId,
        stage_id: courseId,
        name: stage.name,
        title: stage.name,
        description: stage.description ?? params.courseDescription ?? undefined,
        slide_count: scenes.length,
        language: stage.language || 'en-US',
        style: stage.style,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );

    if (courseError) {
      log.error('Final course upsert failed:', courseError);
      return;
    }

    await supabase.from('scenes').delete().eq('course_id', courseId);

    const formatted = scenes.map((s) => formatSceneRow(courseId, s));
    const { error: scenesError } = await supabase.from('scenes').insert(formatted);

    if (scenesError) {
      log.error('Final scenes bulk insert failed:', scenesError);
      return;
    }

    const storageContent = JSON.stringify({ stage, scenes });
    const { error: storageError } = await supabase.storage
      .from('courses')
      .upload(`${courseId}/content.json`, storageContent, {
        contentType: 'application/json',
        upsert: true,
      });

    if (storageError) {
      log.warn('Final storage upload failed:', storageError.message);
    }
  } catch (e) {
    log.warn('Final Supabase sync skipped or failed:', e);
  }
}
