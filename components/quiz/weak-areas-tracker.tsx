'use client';

import type { WeakAreaSummary } from '@/lib/quiz/types';

export function WeakAreasTracker({ items }: { items: WeakAreaSummary[] }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <h3 className="text-base font-semibold">Weak Areas</h3>
      <div className="mt-4 space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Start with a quiz to see weak areas.</p>
        ) : (
          items.map((item) => (
            <div key={item.area}>
              <div className="flex items-center justify-between text-sm">
                <span className="capitalize">{item.area.replace(/-/g, ' ')}</span>
                <span className="text-muted-foreground">{item.misses} misses</span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-gray-100 dark:bg-gray-800">
                <div
                  className="h-2 rounded-full bg-rose-500"
                  style={{ width: `${Math.min(100, item.misses * 20)}%` }}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
