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

/**
 * Upload a course and its scenes to Supabase
 */
export async function uploadCourseToSupabase(params: {
  userId: string;
  creationPromptId?: string;
  stage: Stage;
  scenes: Scene[];
  thumbnail?: string;
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
      }),
    });

    if (!res.ok) throw new Error('Failed to upload course');
    const data = await res.json();
    return data.course.id as string;
  } catch (err) {
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
 * Download full course content and sync to local IndexedDB
 */
export async function downloadCourseFromSupabase(supabaseCourseId: string) {
  try {
    const res = await fetch(`/api/courses/${supabaseCourseId}/content`);
    if (!res.ok) throw new Error('Failed to download course content');
    const data = await res.json();
    
    const { course, scenes } = data;
    
    // Convert Supabase metadata back to local Stage type
    const stage: Stage = {
      id: course.stage_id,
      name: course.name,
      description: course.description,
      language: course.language,
      style: course.style,
      createdAt: new Date(course.created_at).getTime(),
      updatedAt: new Date(course.updated_at).getTime(),
    };

    // Save to local IndexedDB via stage-storage helper
    await saveStageData(stage.id, {
      stage,
      scenes,
      currentSceneId: scenes[0]?.id || null,
      chats: [], // Chats are not yet synced to Supabase in this version
    });

    log.info(`Course ${stage.id} synced from cloud to local.`);
    return stage.id;
  } catch (err) {
    log.error('Error downloading course from Supabase:', err);
    return null;
  }
}

/**
 * Download full course by stage_id (nanoid)
 */
export async function downloadCourseByStageId(stageId: string) {
  try {
    // 1. Resolve stageId to internal supabase ID
    const res = await fetch(`/api/courses?stageId=${encodeURIComponent(stageId)}`);
    if (!res.ok) throw new Error('Course not found in cloud');
    const data = await res.json();
    return await downloadCourseFromSupabase(data.courses.id);
  } catch (err) {
    log.error('Error downloading course by stageId:', err);
    return null;
  }
}
