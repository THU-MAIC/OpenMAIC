'use client';

import { ClassroomSurface } from '@/components/classroom/ClassroomSurface';
import { useParams } from 'next/navigation';

export default function ClassroomDetailPage() {
  const params = useParams<{ id: string }>();

  return <ClassroomSurface classroomId={params.id} variant="page" />;
}
