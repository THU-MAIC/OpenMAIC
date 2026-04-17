import { ScrollText } from 'lucide-react';

interface AuditContextPanelProps {
  heading?: string;
  actions: string[];
}

export function AuditContextPanel({ heading = 'Audit entries that will be written', actions }: AuditContextPanelProps) {
  return (
    <aside className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
        <ScrollText className="h-4 w-4 text-slate-400" />
        {heading}
      </div>
      <ul className="space-y-2">
        {actions.map((action) => (
          <li key={action} className="rounded-md border border-white/10 bg-black/20 px-2 py-1 font-mono text-xs text-slate-200">
            {action}
          </li>
        ))}
      </ul>
    </aside>
  );
}
