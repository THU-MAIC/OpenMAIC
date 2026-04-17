import { cn } from '@/lib/utils';

interface SectionCardProps {
  title?: string;
  description?: string;
  className?: string;
  children: React.ReactNode;
}

export function SectionCard({ title, description, className, children }: SectionCardProps) {
  return (
    <section className={cn('rounded-xl border border-white/10 bg-white/5 p-4', className)}>
      {(title || description) && (
        <div className="mb-4">
          {title && <h2 className="text-base font-semibold text-white">{title}</h2>}
          {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}
