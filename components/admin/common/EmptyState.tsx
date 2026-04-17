import { Inbox } from 'lucide-react';

interface EmptyStateProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
}

export function EmptyState({ title, description, icon }: EmptyStateProps) {
  return (
    <div className="rounded-xl border border-dashed border-white/15 bg-white/5 px-6 py-10 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/8 text-slate-300">
        {icon ?? <Inbox className="h-5 w-5" />}
      </div>
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
    </div>
  );
}
