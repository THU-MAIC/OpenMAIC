import { redirect } from 'next/navigation';
import { prisma } from '@/lib/auth/prisma';
import { notFound } from 'next/navigation';
import { PromptForm } from '@/components/admin/system-config/PromptForm';
import { requirePermissions } from '@/lib/auth/helpers';

export default async function EditPromptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  try {
    await requirePermissions('edit_prompts');
  } catch {
    redirect('/');
  }

  const prompt = await prisma.promptTemplate.findUnique({
    where: { id },
  });

  if (!prompt) {
    notFound();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{prompt.displayName}</h1>
          <p className="mt-1 text-sm text-slate-400">{prompt.description}</p>
          <div className="mt-3 flex gap-4 text-xs text-slate-400">
            <span>Key: <code className="font-mono text-slate-300">{prompt.key}</code></span>
            <span>Version: v{prompt.version}</span>
            <span>Category: {prompt.category}</span>
            {prompt.isActive && (
              <span className="px-2 py-0.5 rounded-full bg-green-500/15 text-green-300">
                Active
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 p-6">
        <PromptForm
          initialPrompt={{
            id: prompt.id,
            key: prompt.key,
            displayName: prompt.displayName,
            description: prompt.description,
            content: prompt.content,
            category: prompt.category,
            variables: prompt.variables,
            isActive: prompt.isActive,
            version: prompt.version,
          }}
        />
      </div>

      {/* Version history section */}
      <div className="rounded-xl border border-white/10 bg-white/5 p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Version History</h3>
        <div className="space-y-2 text-sm text-slate-400">
          <p>
            Current version: <strong className="text-white">v{prompt.version}</strong>
          </p>
          <p>Created: {prompt.createdAt.toLocaleDateString()}</p>
          <p>Last updated: {prompt.updatedAt.toLocaleDateString()}</p>
        </div>
        <p className="mt-4 text-xs text-slate-500">
          Version history tracking and rollback coming soon
        </p>
      </div>
    </div>
  );
}
