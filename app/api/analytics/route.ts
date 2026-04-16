import { NextRequest } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { cookies } from 'next/headers';
import { apiError, apiSuccess } from '@/lib/server/api-response';

/**
 * Analytics API
 * Handles course views, slide views, and heartbeat (duration) tracking.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { type, courseId, courseName, slideIndex, totalSlides, durationSeconds } = body;

    if (!courseId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'courseId is required');
    }

    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      // Silently ignore analytics for unauthenticated users 
      // as policies would block them anyway.
      return apiSuccess({ ignored: true });
    }

    const userId = user.id;

    if (type === 'course_view') {
      // Record initial view
      const { error } = await supabase
        .from('user_analytics')
        .upsert({
          user_id: userId,
          course_id: courseId,
          course_name: courseName,
          total_slides: totalSlides,
          last_viewed_at: new Date().toISOString(),
        }, { 
          onConflict: 'user_id,course_id' 
        });

      if (error) throw error;
    } else if (type === 'slide_view') {
      // Update last slide viewed and viewed slide count
      const { error } = await supabase.rpc('increment_slide_view', {
        u_id: userId,
        c_id: courseId,
        s_idx: slideIndex
      });

      if (error) throw error;
    } else if (type === 'heartbeat') {
      // Increment watch duration
      const { error } = await supabase.rpc('increment_watch_duration', {
        u_id: userId,
        c_id: courseId,
        dur: durationSeconds || 0
      });

      if (error) throw error;
    } else if (type === 'engagement') {
      // Increment engagement count (AI interactions)
      const { error } = await supabase.rpc('increment_engagement_count', {
        u_id: userId,
        c_id: courseId
      });

      if (error) throw error;
    }

    return apiSuccess({ status: 'tracked' });
  } catch (error) {
    console.error('[api/analytics] Error:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to record analytics');
  }
}
