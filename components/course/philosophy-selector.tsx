'use client';

import { BUILT_IN_PHILOSOPHIES } from '@/lib/course/philosophies';
import { cn } from '@/lib/utils';

interface PhilosophySelectorProps {
  selectedId: string | null;
  onChange: (philosophyId: string) => void;
}

export function PhilosophySelector({ selectedId, onChange }: PhilosophySelectorProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {BUILT_IN_PHILOSOPHIES.map((p) => {
        const isSelected = selectedId === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            className={cn(
              'text-left p-4 rounded-xl border-2 transition-all',
              'hover:shadow-md cursor-pointer',
              isSelected
                ? 'border-violet-500 bg-violet-50 dark:bg-violet-900/20 shadow-md'
                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600',
            )}
          >
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 mb-1">{p.name}</h3>
            <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">{p.description}</p>
            <ul className="text-[11px] text-gray-500 dark:text-gray-500 space-y-0.5">
              {p.generationGuidelines.slice(0, 2).map((g, i) => (
                <li key={i} className="flex items-start gap-1">
                  <span>•</span>
                  <span>{g}</span>
                </li>
              ))}
            </ul>
          </button>
        );
      })}
    </div>
  );
}
