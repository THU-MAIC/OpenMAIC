/**
 * GET /api/instructor/classrooms/[id]/grades/export
 * Returns a CSV file containing the full gradebook matrix for the classroom.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/auth/prisma';
import { userOwnsClassroom } from '@/lib/auth/helpers';
import { isValidClassroomId } from '@/lib/server/classroom-storage';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { id: classroomId } = await params;
  if (!isValidClassroomId(classroomId)) {
    return new NextResponse('Invalid classroom id', { status: 400 });
  }

  const isAdmin = session.user.role === 'ADMIN';
  if (!isAdmin) {
    const owns = await userOwnsClassroom(session.user.id, classroomId);
    if (!owns) return new NextResponse('Forbidden', { status: 403 });
  }

  const results = await prisma.quizResult.findMany({
    where: { classroomId },
    select: {
      studentDbUserId: true,
      studentLabel: true,
      sceneId: true,
      sceneTitle: true,
      score: true,
      maxScore: true,
    },
    orderBy: { gradedAt: 'desc' },
  });

  // Build unique student keys and scene columns
  const studentMap = new Map<string, string>(); // key → label
  const sceneMap = new Map<string, string>(); // sceneId → title
  for (const r of results) {
    const key = r.studentDbUserId ?? `local:${r.studentLabel}`;
    studentMap.set(key, r.studentLabel);
    sceneMap.set(r.sceneId, r.sceneTitle);
  }

  const students = Array.from(studentMap.entries());
  const scenes = Array.from(sceneMap.entries());

  // Index: studentKey → sceneId → { score, maxScore }
  const index = new Map<string, Map<string, { score: number; maxScore: number }>>();
  for (const r of results) {
    const key = r.studentDbUserId ?? `local:${r.studentLabel}`;
    if (!index.has(key)) index.set(key, new Map());
    if (!index.get(key)!.has(r.sceneId)) {
      index.get(key)!.set(r.sceneId, { score: r.score, maxScore: r.maxScore });
    }
  }

  // CSV header row — values are safely escaped
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;

  const header = ['Student', ...scenes.map(([, title]) => escape(title)), 'Total', 'Max'].join(',');

  const rows: string[] = [header];
  for (const [key, label] of students) {
    const studentScores = index.get(key) ?? new Map<string, { score: number; maxScore: number }>();
    const cells = scenes.map(([sceneId]) => {
      const cell = studentScores.get(sceneId);
      return cell ? `${cell.score}/${cell.maxScore}` : '';
    });
    const totalScore = Array.from(studentScores.values()).reduce((s, r) => s + r.score, 0);
    const totalMax = Array.from(studentScores.values()).reduce((s, r) => s + r.maxScore, 0);
    rows.push([escape(label), ...cells, String(totalScore), String(totalMax)].join(','));
  }

  const csv = rows.join('\n');

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="grades-${classroomId}.csv"`,
    },
  });
}
