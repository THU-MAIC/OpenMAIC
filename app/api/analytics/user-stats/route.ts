import { NextRequest } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { cookies } from 'next/headers';
import { apiError, apiSuccess } from '@/lib/server/api-response';

/**
 * User Stats API
 * Returns a summary of the authenticated user's engagement and rankings.
 */
export async function GET(req: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return apiError('UNAUTHORIZED', 401, 'Not authenticated');
    }

    const userId = user.id;

    // 1. Get aggregated score and base rank info
    const { data: scoreData } = await supabase
      .from('user_scores')
      .select('*')
      .eq('user_id', userId)
      .single();

    // 2. Get course engagement summary
    const { data: analyticsData } = await supabase
      .from('user_analytics')
      .select('course_id, watch_duration_seconds, slides_viewed, total_slides')
      .eq('user_id', userId);

    const totalWatchTime = (analyticsData || []).reduce((sum, item) => sum + (item.watch_duration_seconds || 0), 0);
    const totalSlidesViewed = (analyticsData || []).reduce((sum, item) => sum + (item.slides_viewed || 0), 0);
    const coursesStarted = (analyticsData || []).length;

    // 3. Simple rank calculation (roughly count users with higher score)
    const { count: globalRank } = await supabase
      .from('user_scores')
      .select('*', { count: 'exact', head: true })
      .gt('total_score', scoreData?.total_score || 0);

    return apiSuccess({
      stats: {
        totalScore: scoreData?.total_score || 0,
        quizzesCompleted: scoreData?.quizzes_completed || 0,
        coursesStarted,
        totalWatchTime, // in seconds
        totalSlidesViewed,
        globalRank: (globalRank || 0) + 1,
        country: scoreData?.country_name || 'Unknown',
        countryCode: scoreData?.country_code || 'XX'
      }
    });
  } catch (error) {
    console.error('[api/analytics/user-stats] Error:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to fetch user stats');
  }
}
