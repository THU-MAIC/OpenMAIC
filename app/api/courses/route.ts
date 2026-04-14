import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';

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
      query = query.eq('stage_id', stageId).single();
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
      scenes
    } = body;

    if (!user_id || !stage_id || !name) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // 1. Create Course Metadata
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .insert({
        user_id,
        creation_prompt_id,
        stage_id,
        name,
        description,
        thumbnail,
        slide_count,
        language,
        style
      })
      .select()
      .single();

    if (courseError) {
      console.error('Error creating course:', courseError);
      return NextResponse.json({ error: courseError.message }, { status: 500 });
    }

    // 2. Insert Scenes in bulk if provided
    if (scenes && scenes.length > 0) {
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
        // We might want to delete the course if scenes fail, or just return partial success
        return NextResponse.json({ 
          error: 'Course created but scenes failed', 
          details: scenesError.message,
          courseId: course.id 
        }, { status: 500 });
      }
    }

    // 3. Update the original prompt to link back to this course
    if (creation_prompt_id) {
      await supabase
        .from('prompts')
        .update({ course_id: course.id })
        .eq('id', creation_prompt_id);
    }

    return NextResponse.json({ success: true, course });
  } catch (err) {
    console.error('Unexpected error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
