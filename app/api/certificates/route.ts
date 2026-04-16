import { NextRequest } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { cookies } from 'next/headers';
import { apiError, apiSuccess } from '@/lib/server/api-response';

/**
 * Certificates API
 * Handles certificate creation and storage.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { 
      courseId, 
      courseName, 
      studentName, 
      grade, 
      score, 
      topics, 
      watchTimePercentage, 
      quizScoreAverage, 
      engagementCount 
    } = body;

    if (!courseId || !courseName || !studentName) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required certificate details');
    }

    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return apiError('UNAUTHORIZED', 401, 'You must be logged in to claim a certificate');
    }

    // Insert or update certificate
    const { data, error } = await supabase
      .from('certificates')
      .upsert({
        user_id: user.id,
        course_id: courseId,
        course_name: courseName,
        student_name: studentName,
        grade,
        score,
        topics: topics || [],
        watch_time_percentage: watchTimePercentage,
        quiz_score_average: quizScoreAverage,
        engagement_count: engagementCount,
        created_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,course_id'
      })
      .select('id')
      .single();

    if (error) {
      console.error('[api/certificates] DB Error:', error);
      throw error;
    }

    return apiSuccess({ id: data.id });
  } catch (error) {
    console.error('[api/certificates] Error:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to save certificate');
  }
}

/**
 * GET fetches a certificate by ID (Public)
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return apiError('MISSING_ID', 400, 'Certificate ID is required');
    }

    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const { data, error } = await supabase
      .from('certificates')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return apiError('NOT_FOUND', 404, 'Certificate not found');
      throw error;
    }

    return apiSuccess(data);
  } catch (error) {
    console.error('[api/certificates] GET Error:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to fetch certificate');
  }
}
