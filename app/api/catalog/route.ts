import { type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { apiSuccess, apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('CatalogAPI');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const subject = searchParams.get('subject');
    const topic = searchParams.get('topic');
    const age = searchParams.get('age');
    const query = searchParams.get('q');
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '12');
    const offset = (page - 1) * limit;

    let supabaseQuery = supabase
      .from('courses')
      .select('*, course_tags(*)', { count: 'exact' });

    // 1. Full-text search / Filter by title/description
    if (query) {
      supabaseQuery = supabaseQuery.or(`title.ilike.%${query}%,description.ilike.%${query}%`);
    }

    // 2. Fetch all matching courses first (if we have many filters, this might need refinement)
    // Supabase filtering on joined tables can be tricky for "has tag with value".
    // A cleaner way is to use subqueries or filtered joins but let's stick to a robust approach.
    
    const { data: courses, count, error } = await supabaseQuery
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      log.error('Supabase query error:', error);
      return apiError('INTERNAL_ERROR', 500, 'Failed to fetch catalog');
    }

    // 3. Post-filtering for tags (JS side for simplicity with age ranges)
    let filteredCourses = courses || [];

    if (subject || topic || age) {
      filteredCourses = filteredCourses.filter(course => {
        const tags = course.course_tags || [];
        
        let matchesSubject = !subject || tags.some((t: any) => t.tag_type === 'subject' && t.tag_value === subject);
        let matchesTopic = !topic || tags.some((t: any) => t.tag_type === 'topic' && t.tag_value === topic);
        
        let matchesAge = true;
        if (age) {
          const ageNum = parseInt(age);
          matchesAge = tags.some((t: any) => {
            if (t.tag_type === 'age_range') {
              const [min, max] = t.tag_value.split('-').map(Number);
              return !isNaN(min) && !isNaN(max) && ageNum >= min && ageNum <= max;
            }
            return false;
          });
        }
        
        return matchesSubject && matchesTopic && matchesAge;
      });
    }

    // Map to a clean response (hide internals)
    const result = filteredCourses.map(c => ({
      id: c.id,
      title: c.title,
      description: c.description,
      slideCount: c.slide_count,
      language: c.language,
      createdAt: c.created_at,
      tags: (c.course_tags || []).reduce((acc: any, t: any) => {
        acc[t.tag_type] = t.tag_value;
        return acc;
      }, {})
    }));

    return apiSuccess({
      courses: result,
      total: count,
      page,
      limit
    });
  } catch (error) {
    log.error('Catalog processing error:', error);
    return apiError('INTERNAL_ERROR', 500, 'An unexpected error occurred');
  }
}
