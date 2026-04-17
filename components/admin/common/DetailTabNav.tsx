'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface TabLink {
  label: ReactNode;
  href: string;
}

interface DetailTabNavProps {
  tabs: TabLink[];
}

/**
 * Horizontal tab nav for admin detail workspace layouts.
 * Uses usePathname() to highlight the currently active tab.
 */
export function DetailTabNav({ tabs }: DetailTabNavProps) {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 p-1.5 text-sm">
      {tabs.map((tab) => {
        // Match: exact or has trailing sub-path (for index redirects)
        const isActive = pathname === tab.href || pathname.startsWith(tab.href + '/');
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              'rounded-lg px-3 py-1.5 transition-colors',
              isActive
                ? 'bg-white/10 text-white font-medium'
                : 'text-slate-400 hover:bg-white/6 hover:text-white',
            )}
            aria-current={isActive ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
