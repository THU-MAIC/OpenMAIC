import { DraftBadge } from '@/components/admin/wizard/DraftBadge';

interface AdminPageHeaderProps {
  title: string;
  subtitle?: string;
  hasUnsavedChanges?: boolean;
  actions?: React.ReactNode;
}

export function AdminPageHeader({ title, subtitle, hasUnsavedChanges, actions }: AdminPageHeaderProps) {
  return (
    <header className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
        {typeof hasUnsavedChanges === 'boolean' && (
          <div className="mt-2">
            <DraftBadge hasUnsavedChanges={hasUnsavedChanges} />
          </div>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
