import { NextRequest } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { cookies } from 'next/headers';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getGeoInfo } from '@/lib/analytics/geo';

/**
 * Quiz Score API
 * Handles saving quiz results and updating the geography-based leaderboard.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { courseId, sceneId, score, totalPoints, displayName, avatarUrl } = body;

    if (!courseId || !sceneId || score === undefined || !totalPoints) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Required fields missing');
    }

    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return apiError('UNAUTHORIZED', 401, 'Please sign in to save your score');
    }

    const userId = user.id;
    const percentage = Math.round((score / totalPoints) * 100);

    // 1. Record individual quiz attempt
    const { error: quizError } = await supabase
      .from('quiz_scores')
      .insert({
        user_id: userId,
        course_id: courseId,
        scene_id: sceneId,
        score,
        total_points: totalPoints,
        percentage,
      });

    if (quizError) throw quizError;

    // 2. Increment user engagement stats in user_analytics
    await supabase.rpc('increment_quiz_count', { 
      u_id: userId, 
      c_id: courseId 
    }).catch(err => console.warn('Failed to increment quiz count:', err));

    // 3. Update global and local ranking (user_scores table)
    // We get geo info from request headers
    const geo = getGeoInfo(req.headers);

    // Get current score to increment
    const { data: currentScore } = await supabase
      .from('user_scores')
      .select('total_score, quizzes_completed')
      .eq('user_id', userId)
      .single();

    const newTotalScore = (currentScore?.total_score || 0) + score;
    const newQuizzesCompleted = (currentScore?.quizzes_completed || 0) + 1;

    const { error: scoreError } = await supabase
      .from('user_scores')
      .upsert({
        user_id: userId,
        display_name: displayName || user.user_metadata?.full_name || 'Student',
        avatar_url: avatarUrl || user.user_metadata?.avatar_url || user.user_metadata?.picture,
        total_score: newTotalScore,
        quizzes_completed: newQuizzesCompleted,
        country_code: geo.countryCode,
        country_name: geo.countryName,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id'
      });

    if (scoreError) throw scoreError;

    return apiSuccess({ 
      status: 'saved',
      score,
      totalPoints,
      percentage,
      country: geo.countryName
    });
  } catch (error) {
    console.error('[api/analytics/quiz-score] Error:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to save quiz score');
  }
}
