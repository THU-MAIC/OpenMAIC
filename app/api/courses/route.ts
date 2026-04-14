import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { generateCatalogMetadataForCourse } from '@/lib/server/course-catalog';

/**
 * GET /api/courses?userId=xxx
 * List metadata for all courses of a user.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('userId');
  const stageId = searchParams.get('stageId');

  if (!userId && !stageId) {
    return NextResponse.json({ error: 'User ID or Stage ID is required' }, { status: 400 });
  }

  try {
    const supabase = createAdminClient();
    let query = supabase.from('courses').select('id, stage_id, name, thumbnail, slide_count, created_at, updated_at');
    
    if (userId) {
      query = query.eq('user_id', userId).order('updated_at', { ascending: false });
    } else if (stageId) {
      // Query by both id and stage_id column so the lookup works regardless of whether
      // the stage_id column migration has been applied (courses.id = stage_id in our schema).
      query = query.or(`id.eq.${stageId},stage_id.eq.${stageId}`);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching courses:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, courses: data });
  } catch (err) {
    console.error('Unexpected error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * POST /api/courses
 * Atomic creation of course metadata and its scenes.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createAdminClient();
    const body = await req.json();
    
    const { 
      user_id,
      creation_prompt_id,
      stage_id,
      name,
      description,
      thumbnail,
      slide_count,
      language,
      style,
      scenes,
      stage: fullStage,  // full Stage object for complete storage serialisation
    } = body;

    if (!user_id || !stage_id || !name) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // 1. Create Course Metadata (upsert so re-syncs and catalog pre-inserts don't conflict)
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .upsert({
        id: stage_id,
        user_id,
        creation_prompt_id,
        stage_id,
        name,
        // Backward-compat: old schema has `title TEXT NOT NULL` before the fix migration drops it
        title: name,
        description,
        thumbnail,
        slide_count,
        language,
        style,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' })
      .select()
      .single();

    if (courseError) {
      console.error('Error creating course:', courseError);
      return NextResponse.json({ error: courseError.message }, { status: 500 });
    }

    // 2. Insert Scenes in bulk if provided (delete existing first for idempotent re-syncs)
    if (scenes && scenes.length > 0) {
      await supabase.from('scenes').delete().eq('course_id', course.id);

      const formattedScenes = scenes.map((s: any) => ({
        course_id: course.id,
        scene_id: s.id,
        type: s.type,
        title: s.title,
        order: s.order,
        content: s.content,
        actions: s.actions,
        whiteboards: s.whiteboards
      }));

      const { error: scenesError } = await supabase
        .from('scenes')
        .insert(formattedScenes);

      if (scenesError) {
        console.error('Error creating scenes:', scenesError);
        return NextResponse.json({ 
          error: 'Course created but scenes failed', 
          details: scenesError.message,
          courseId: course.id 
        }, { status: 500 });
      }
    }

    // 3. Upload full course content JSON to Storage for fast client-side retrieval.
    //    Path: courses/{stage_id}/content.json  (public bucket, no auth needed to read)
    //    Use the full Stage object when provided so agentIds / whiteboard / generatedAgentConfigs
    //    are preserved and can be restored when the classroom is reopened on another device.
    const stageForStorage = fullStage ?? {
      id: stage_id,
      name,
      description,
      language,
      style,
      createdAt: new Date(course.created_at).getTime(),
      updatedAt: new Date(course.updated_at).getTime(),
    };

    const storageContent = JSON.stringify({
      stage: stageForStorage,
      scenes: scenes || [],
    });

    const { error: storageError } = await supabase.storage
      .from('courses')
      .upload(`${stage_id}/content.json`, storageContent, {
        contentType: 'application/json',
        upsert: true,
      });

    if (storageError) {
      // Non-fatal: the DB row is the authoritative source; storage is an optimistic cache
      console.error('Storage upload failed (non-fatal):', storageError.message);
    }

    // 4. Update the original prompt to link back to this course
    if (creation_prompt_id) {
      await supabase
        .from('prompts')
        .update({ course_id: course.id })
        .eq('id', creation_prompt_id);
    }

    // 5. Background: generate AI catalog title + tags from scene titles
    const sceneTitles = (scenes ?? []).map((s: any) => s.title).filter(Boolean);
    if (name && sceneTitles.length > 0) {
      void generateCatalogMetadataForCourse({
        courseId: course.id,
        courseName: name,
        language: language || 'en-US',
        sceneTitles,
      });
    }

    return NextResponse.json({ success: true, course });
  } catch (err) {
    console.error('Unexpected error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
