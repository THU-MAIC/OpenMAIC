import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';

/**
 * GET /api/courses/[id]/content
 * Fetch all scenes for a specific course (Supabase internal ID).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const courseId = params.id;

  if (!courseId) {
    return NextResponse.json({ error: 'Course ID is required' }, { status: 400 });
  }

  try {
    const supabase = createAdminClient();
    
    // Fetch course metadata first for context
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('*')
      .eq('id', courseId)
      .single();

    if (courseError || !course) {
      return NextResponse.json({ error: 'Course not found' }, { status: 404 });
    }

    // Fetch all scenes ordered by scene order
    const { data: scenes, error: scenesError } = await supabase
      .from('scenes')
      .select('*')
      .eq('course_id', courseId)
      .order('order', { ascending: true });

    if (scenesError) {
      console.error('Error fetching scenes:', scenesError);
      return NextResponse.json({ error: scenesError.message }, { status: 500 });
    }

    return NextResponse.json({ 
      success: true, 
      course,
      scenes: scenes.map(s => ({
        id: s.scene_id,
        stageId: course.stage_id,
        type: s.type,
        title: s.title,
        order: s.order,
        content: s.content,
        actions: s.actions,
        whiteboards: s.whiteboards,
        createdAt: s.created_at,
        updatedAt: s.updated_at
      }))
    });
  } catch (err) {
    console.error('Unexpected error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
