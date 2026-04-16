import { NextRequest } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { cookies } from 'next/headers';
import { apiError, apiSuccess } from '@/lib/server/api-response';

/** UTC calendar day as YYYY-MM-DD (matches streak RPC). */
function utcTodayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Previous UTC calendar day. */
function utcYesterdayYmd(): string {
  const [y, m, d] = utcTodayYmd().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * If the user missed a UTC day, the stored current_streak is stale until the next activity;
 * show 0 for "current" until they study again.
 */
function effectiveCurrentStreak(
  lastActivityDate: string | null | undefined,
  storedStreak: number,
): number {
  if (!lastActivityDate) return 0;
  const last = lastActivityDate.slice(0, 10);
  if (last < utcYesterdayYmd()) return 0;
  return storedStreak;
}

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
      
    // 4. Streaks (UTC day); current reflects whether the streak is still alive
    const storedCurrent = scoreData?.current_streak || 0;
    const currentStreak = effectiveCurrentStreak(scoreData?.last_activity_date, storedCurrent);
    const highestStreak = scoreData?.highest_streak || 0;

    // 5. Completed courses = claimed certificates (one per course)
    const { data: certificatesRows } = await supabase
      .from('certificates')
      .select('id, course_id, course_name, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    const certificates = (certificatesRows || []).map((row) => ({
      id: row.id,
      courseId: row.course_id,
      courseName: row.course_name,
      createdAt: row.created_at,
    }));

    return apiSuccess({
      stats: {
        totalScore: scoreData?.total_score || 0,
        quizzesCompleted: scoreData?.quizzes_completed || 0,
        coursesCompleted: certificates.length,
        certificates,
        coursesStarted,
        totalWatchTime, // in seconds
        totalSlidesViewed,
        globalRank: (globalRank || 0) + 1,
        country: scoreData?.country_name || 'Unknown',
        countryCode: scoreData?.country_code || 'XX',
        currentStreak,
        highestStreak
      }
    });
  } catch (error) {
    console.error('[api/analytics/user-stats] Error:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to fetch user stats');
  }
}
