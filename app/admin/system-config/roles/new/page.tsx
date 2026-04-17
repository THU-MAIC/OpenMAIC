import { redirect } from 'next/navigation';

export default function LegacyNewRolePage() {
  redirect('/admin/roles/new');
}
