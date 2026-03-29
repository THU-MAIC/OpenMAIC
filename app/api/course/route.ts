import { NextRequest, NextResponse } from 'next/server';
import { listCourses, readCourse, persistCourse, deleteCourse } from '@/lib/server/course-storage';
import type { Course } from '@/lib/types/course';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (id) {
      const course = await readCourse(id);
      if (!course) {
        return NextResponse.json({ error: 'Course not found' }, { status: 404 });
      }
      return NextResponse.json(course);
    }

    const courses = await listCourses();
    const statusFilter = searchParams.get('status');
    const filtered = statusFilter ? courses.filter((c) => c.status === statusFilter) : courses;
    return NextResponse.json(filtered);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Course;
    if (!body.id || !body.name) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (body.status === 'published') {
      if (!body.chapters || body.chapters.length === 0) {
        return NextResponse.json({ error: 'Course must have at least one chapter to publish' }, { status: 400 });
      }
      const unbound = body.chapters.filter((ch) => !ch.classroomId);
      if (unbound.length > 0) {
        return NextResponse.json({ error: 'All chapters must have a bound classroom to publish' }, { status: 400 });
      }
    }
    await persistCourse(body);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }
    await deleteCourse(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
