import { redirect } from 'next/navigation';

export default async function InstructorClassroomIndexPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/instructor/classrooms/${id}/overview`);
}
