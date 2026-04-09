'use client';

import { use } from 'react';
import { CourseBuilder } from '@/components/course/course-builder';

export default function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <CourseBuilder courseId={id} />;
}
