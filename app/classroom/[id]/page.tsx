'use client';

import { useParams } from 'next/navigation';
import { ClassroomSurface } from '@/components/classroom/ClassroomSurface';

export default function ClassroomDetailPage() {
  const params = useParams();
  const classroomId = params?.id as string;

  return <ClassroomSurface classroomId={classroomId} variant="page" />;
}
