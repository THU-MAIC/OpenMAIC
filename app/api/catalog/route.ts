import { type NextRequest } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createClient } from '@/utils/supabase/server';
import { apiSuccess, apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('CatalogAPI');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const anonSupabase = createSupabaseClient(supabaseUrl, supabaseKey);

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const subject = searchParams.get('subject');
    const topic = searchParams.get('topic');
    const age = searchParams.get('age');
    const query = searchParams.get('q');
    const filter = searchParams.get('filter') || 'public'; // 'public' | 'my'
    const limit = Math.min(parseInt(searchParams.get('limit') || '12'), 50);
    const offset = parseInt(searchParams.get('offset') || '0');

    // For "my courses" we need the authenticated user
    let currentUserId: string | null = null;
    if (filter === 'my') {
      try {
        const cookieStore = await cookies();
        const supabase = createClient(cookieStore);
        const { data: { user } } = await supabase.auth.getUser();
        currentUserId = user?.id ?? null;
      } catch { /* ignore */ }

      if (!currentUserId) {
        return apiSuccess({ courses: [], total: 0, offset, limit, hasMore: false });
      }
    }

    let supabaseQuery = anonSupabase
      .from('courses')
      .select('*, course_tags(*)', { count: 'exact' });

    // ── Filter by ownership or public visibility ──────────────────────────────
    if (filter === 'my' && currentUserId) {
      supabaseQuery = supabaseQuery.eq('user_id', currentUserId);
    } else {
      // Public: only courses from users marked is_public=true in user_plans
      // We join via a sub-select using the user_id on courses
      supabaseQuery = supabaseQuery.not('user_id', 'is', null);
      // We'll filter by public users after fetching (Supabase anon client can't
      // do server-side JOINs across RLS-protected tables from the catalog query)
    }

    // ── Full-text search ──────────────────────────────────────────────────────
    if (query) {
      supabaseQuery = supabaseQuery.or(`name.ilike.%${query}%,description.ilike.%${query}%`);
    }

    const { data: courses, count, error } = await supabaseQuery
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      log.error('Supabase query error:', error);
      return apiError('INTERNAL_ERROR', 500, 'Failed to fetch catalog');
    }

    let filteredCourses = courses || [];

    // ── For public filter: restrict to public users ───────────────────────────
    if (filter !== 'my' && filteredCourses.length > 0) {
      const userIds = [...new Set(filteredCourses.map((c) => c.user_id).filter(Boolean))];
      if (userIds.length > 0) {
        const { data: publicUsers } = await anonSupabase
          .from('user_plans')
          .select('user_id')
          .eq('is_public', true)
          .in('user_id', userIds);

        const publicUserSet = new Set((publicUsers ?? []).map((u) => u.user_id));
        filteredCourses = filteredCourses.filter(
          (c) => !c.user_id || publicUserSet.has(c.user_id),
        );
      } else {
        filteredCourses = [];
      }
    }

    // ── Post-filter for subject / topic / age ─────────────────────────────────
    if (subject || topic || age) {
      filteredCourses = filteredCourses.filter((course) => {
        const matchesSubject = !subject || course.subject === subject;
        const matchesTopic = !topic || course.topic === topic;

        let matchesAge = true;
        if (age) {
          const ageNum = parseInt(age);
          if (course.age_range) {
            const [min, max] = course.age_range.split('-').map(Number);
            matchesAge = !isNaN(min) && !isNaN(max) && ageNum >= min && ageNum <= max;
          } else {
            const tags = course.course_tags || [];
            matchesAge = tags.some((t: { tag_type: string; tag_value: string }) => {
              if (t.tag_type === 'age_range') {
                const [min, max] = t.tag_value.split('-').map(Number);
                return !isNaN(min) && !isNaN(max) && ageNum >= min && ageNum <= max;
              }
              return false;
            });
          }
        }

        return matchesSubject && matchesTopic && matchesAge;
      });
    }

    const result = filteredCourses.map((c) => ({
      id: c.id,
      title: c.name || c.title,
      headline: c.headline,
      description: c.description,
      slideCount: c.slide_count,
      language: c.language,
      createdAt: c.created_at,
      tags: {
        subject: c.subject,
        age_range: c.age_range,
        topic: c.topic,
        sub_topic: c.sub_topic,
        ...(c.course_tags || []).reduce((acc: Record<string, string>, t: { tag_type: string; tag_value: string }) => {
          acc[t.tag_type] = t.tag_value;
          return acc;
        }, {}),
      },
    }));

    return apiSuccess({
      courses: result,
      total: count,
      offset,
      limit,
      hasMore: result.length === limit,
    });
  } catch (error) {
    log.error('Catalog processing error:', error);
    return apiError('INTERNAL_ERROR', 500, 'An unexpected error occurred');
  }
}
