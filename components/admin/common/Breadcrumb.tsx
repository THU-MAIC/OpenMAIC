'use client';

interface BreadcrumbProps {
  items: Array<{
    label: string;
    href?: string;
  }>;
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav className="flex items-center gap-2 text-sm text-slate-400">
      {items.map((item, index) => (
        <div key={index} className="flex items-center gap-2">
          {item.href ? (
            <a href={item.href} className="hover:text-white">
              {item.label}
            </a>
          ) : (
            <span>{item.label}</span>
          )}
          {index < items.length - 1 && <span>/</span>}
        </div>
      ))}
    </nav>
  );
}
