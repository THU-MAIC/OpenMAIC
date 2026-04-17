import { redirect } from 'next/navigation';

export default async function LegacyEditRolePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/admin/roles/${id}`);
}
