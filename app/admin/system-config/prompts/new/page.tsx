import { requirePermissions } from '@/lib/auth/helpers';
import { redirect } from 'next/navigation';
import { PromptForm } from '@/components/admin/system-config/PromptForm';

export default async function NewPromptPage() {
  try {
    await requirePermissions('create_prompts');
  } catch {
    redirect('/');
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-white">Create new prompt</h1>
        <p className="mt-1 text-sm text-slate-400">Define a new AI prompt template</p>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 p-6">
        <PromptForm />
      </div>
    </div>
  );
}
