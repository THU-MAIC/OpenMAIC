import { redirect } from 'next/navigation';

export default async function AdminClassroomIndexPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/admin/classrooms/${id}/overview`);
}
