import { NextRequest } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { cookies } from 'next/headers';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getGeoInfo } from '@/lib/analytics/geo';

/**
 * Leaderboard API
 * Fetches rankings based on total score.
 * Supports ?type=global and ?type=local (filtered by geography)
 */
export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const type = searchParams.get('type') || 'global';
    let countryCode = searchParams.get('country');
    const limit = parseInt(searchParams.get('limit') || '100', 10);

    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    let query = supabase
      .from('user_scores')
      .select('*')
      .order('total_score', { ascending: false })
      .limit(limit);

    // If local, filter by country
    if (type === 'local') {
      if (!countryCode) {
        // Auto-detect country from headers if not specified
        const geo = getGeoInfo(req.headers);
        countryCode = geo.countryCode;
      }

      if (countryCode && countryCode !== 'XX') {
        query = query.eq('country_code', countryCode);
      }
    }

    const { data, error } = await query;
    if (error) throw error;

    // Add rank index manually
    const rankedData = (data || []).map((user, index) => ({
      ...user,
      rank: index + 1,
    }));

    return apiSuccess({ 
      leaderboard: rankedData,
      meta: {
        type,
        countryCode: countryCode || 'XX',
        count: rankedData.length
      }
    });
  } catch (error) {
    console.error('[api/leaderboard] Error:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to fetch leaderboard');
  }
}
