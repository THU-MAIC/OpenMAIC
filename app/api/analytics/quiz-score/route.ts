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

    // 1. Check for the user's previous best score on this exact quiz scene
    const { data: previousBest } = await supabase
      .from('quiz_scores')
      .select('score')
      .eq('user_id', userId)
      .eq('scene_id', sceneId)
      .order('score', { ascending: false })
      .limit(1)
      .maybeSingle();

    const previousBestScore = previousBest?.score ?? 0;
    // Only the improvement over previous best counts toward the leaderboard
    const scoreDelta = Math.max(0, score - previousBestScore);
    const isFirstAttempt = !previousBest;

    // 2. Record individual quiz attempt (always, for full history)
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

    // 3. Increment user engagement stats in user_analytics (only on first attempt)
    if (isFirstAttempt) {
      try {
        const { error: incrementError } = await supabase.rpc('increment_quiz_count', {
          u_id: userId,
          c_id: courseId,
        });
        if (incrementError) {
          console.warn('Failed to increment quiz count:', incrementError);
        }
      } catch (err) {
        console.warn('Failed to increment quiz count:', err);
      }
    }

    // 4. Update global and local ranking (user_scores table)
    // Only apply a delta if this attempt beats the previous best score
    const geo = getGeoInfo(req.headers);

    const { data: currentScore } = await supabase
      .from('user_scores')
      .select('total_score, quizzes_completed')
      .eq('user_id', userId)
      .single();

    const newTotalScore = (currentScore?.total_score || 0) + scoreDelta;
    const newQuizzesCompleted = (currentScore?.quizzes_completed || 0) + (isFirstAttempt ? 1 : 0);

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
        onConflict: 'user_id',
      });

    if (scoreError) throw scoreError;

    const { error: streakError } = await supabase.rpc('record_learning_day', { u_id: userId });
    if (streakError) console.warn('[api/analytics/quiz-score] record_learning_day:', streakError.message);

    return apiSuccess({
      status: 'saved',
      score,
      scoreDelta,
      totalPoints,
      percentage,
      isFirstAttempt,
      country: geo.countryName,
    });
  } catch (error) {
    console.error('[api/analytics/quiz-score] Error:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to save quiz score');
  }
}
