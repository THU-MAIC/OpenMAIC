/**
 * Read authorization contract for GET /api/courses/[id].
 *
 * A `?share=1` URL is the product's internal share capability: any
 * authenticated account may read that course, but the same URL without the
 * marker remains subject to the assignment / role checks in the route.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getServerSupabaseMock, getServiceSupabaseMock } = vi.hoisted(() => ({
  getServerSupabaseMock: vi.fn(),
  getServiceSupabaseMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  getServerSupabase: getServerSupabaseMock,
  getServiceSupabase: getServiceSupabaseMock,
}));

function makeServiceClient() {
  const course = {
    id: 'course-1',
    created_by: 'teacher-a',
    data: { stage: { id: 'course-1' }, scenes: [] },
  };
  return {
    from(table: string) {
      return {
        select() {
          const query = {
            eq() {
              return query;
            },
            maybeSingle: async () => {
              if (table === 'profiles') return { data: { role: 'learner' }, error: null };
              if (table === 'course_assignments') return { data: null, error: null };
              return { data: { id: course.id, created_by: course.created_by }, error: null };
            },
            single: async () => ({ data: course, error: null }),
          };
          return query;
        },
      };
    },
  };
}

async function getCourse(url: string) {
  const { GET } = await import('@/app/api/courses/[id]/route');
  return GET(
    new Request(url) as unknown as NextRequest,
    { params: Promise.resolve({ id: 'course-1' }) },
  );
}

describe('GET /api/courses/[id] share authorization', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('allows an authenticated learner using a share link without an assignment', async () => {
    getServerSupabaseMock.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'learner-b' } } }) },
    });
    getServiceSupabaseMock.mockReturnValue(makeServiceClient());

    const res = await getCourse('http://localhost/api/courses/course-1?share=1');

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('keeps the non-share endpoint assignment-gated for that learner', async () => {
    getServerSupabaseMock.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'learner-b' } } }) },
    });
    getServiceSupabaseMock.mockReturnValue(makeServiceClient());

    const res = await getCourse('http://localhost/api/courses/course-1');

    expect(res.status).toBe(403);
  });
});
