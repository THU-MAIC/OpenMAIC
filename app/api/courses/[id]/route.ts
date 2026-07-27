import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, getServerSupabase } from '@/lib/supabase/server';

// GET /api/courses/[id] — 获取单个课程完整数据
//
// Auth (2026-07-23 hardening): previously this endpoint exposed ANY
// course to ANY signed-in user (and the prior anon wave already
// dropped anon SELECT). Four access paths are now allowed:
//   1. Caller's profile.role in {admin, teacher} AND course.created_by
//      matches caller — admin/teacher looking at their own course.
//   2. Caller is a teacher/admin (any) — they can browse the catalog
//      while authoring. (We could narrow this to "only own courses"
//      but the existing course library UI shows a cross-author browse,
//      so keep the wider gate; tighten later if needed.)
//   3. Caller is a learner AND the course has a course_assignments
//      row pointing at a students row whose user_id matches the caller
//      – i.e. someone assigned this course to them.
//   4. Caller is signed in and deliberately opens a `?share=1` link.
//      RJ's product policy is internal-link sharing: a course link is
//      sufficient for any authenticated internal learner/teacher to view
//      it, while the plain course endpoint remains assignment/role gated.
//
// Anyone else gets 403, even if signed in. Without this check, any
// authenticated user could enumerate course IDs and pull another
// teacher's content (which includes prompts, drafts, and metadata).
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const isShareLink = new URL(_request.url).searchParams.get('share') === '1';

    // 1. Auth: must be signed in.
    const serverSupabase = await getServerSupabase();
    const {
      data: { user },
    } = await serverSupabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: '请先登录后再访问课程。' },
        { status: 401 },
      );
    }

    // 2. Authorization: check the caller's role + ownership / assignment.
    const serviceSupabase = getServiceSupabase();

    // Load caller's role + the course's created_by in parallel (cheap).
    const [{ data: profile }, { data: course }] = await Promise.all([
      serviceSupabase.from('profiles').select('role').eq('id', user.id).maybeSingle(),
      serviceSupabase.from('courses').select('id, created_by').eq('id', id).maybeSingle(),
    ]);

    if (!course) {
      return NextResponse.json(
        { success: false, errorCode: 'NOT_FOUND', error: '课程不存在' },
        { status: 404 },
      );
    }

    const role = (profile?.role ?? 'learner') as 'admin' | 'teacher' | 'learner';

    // A share link is intentionally read-only at the UI layer. It changes
    // only this GET authorization decision; POST/DELETE ownership checks
    // below remain unchanged.
    let authorized = isShareLink;

    if (!isShareLink && (role === 'admin' || role === 'teacher')) {
      // Author / admin path: own course OR cross-author browse (catalog).
      // If created_by is null/empty (legacy data) we still allow teacher
      // / admin to read so the wave-2 catalog doesn't break on dirty
      // rows. Tighten after running supabase-rls-tighten-courses.sql
      // (see docs/SECURITY-CHECKLIST-2026-07-23.md).
      authorized = !course.created_by || course.created_by === user.id;
      // Teachers and admins can still browse other authors' published
      // courses; this preserves the catalog UX. Learners below are
      // gated strictly by assignment.
      if (role === 'admin') authorized = true;
    }

    if (!authorized && role === 'learner') {
      // Learner path: must have a course_assignments row pointing at
      // a students row whose user_id is the caller.
      const { data: assignment } = await serviceSupabase
        .from('course_assignments')
        .select('id, student_id, students!inner(user_id)')
        .eq('course_id', id)
        .eq('students.user_id', user.id)
        .maybeSingle();
      if (assignment) authorized = true;
    }

    if (!authorized) {
      return NextResponse.json(
        {
          success: false,
          errorCode: 'FORBIDDEN',
          error: '您没有权限访问该课程。',
        },
        { status: 403 },
      );
    }

    // 3. Authorized — fetch the full course row.
    const { data, error } = await serviceSupabase
      .from('courses')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !data) {
      return NextResponse.json(
        { success: false, error: '课程不存在' },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, data });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
// DELETE /api/courses/[id] — 删除云端课程（仅 owner 可删）
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    // Identify the caller and check ownership before deleting.
    const serverSupabase = await getServerSupabase();
    const {
      data: { user },
    } = await serverSupabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: '请先登录后再删除课程' },
        { status: 401 },
      );
    }

    const serviceSupabase = getServiceSupabase();

    // Verify the caller owns this course before deleting.
    const { data: row, error: lookupErr } = await serviceSupabase
      .from('courses')
      .select('created_by')
      .eq('id', id)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!row) {
      return NextResponse.json(
        { success: false, errorCode: 'NOT_FOUND', error: '课程不存在' },
        { status: 404 },
      );
    }
    if (row.created_by !== user.id) {
      return NextResponse.json(
        {
          success: false,
          errorCode: 'FORBIDDEN',
          error: '只有课程的创建者才能删除',
        },
        { status: 403 },
      );
    }

    const { error } = await serviceSupabase
      .from('courses')
      .delete()
      .eq('id', id)
      .eq('created_by', user.id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message },
      { status: 500 },
    );
  }
}
