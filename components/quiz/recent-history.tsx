'use client';

import type { QuizHistoryItem } from '@/lib/quiz/types';

export function RecentHistory({ items }: { items: QuizHistoryItem[] }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <h3 className="text-base font-semibold">Recent Quiz History</h3>
      <div className="mt-4 space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No attempts yet.</p>
        ) : (
          items.map((item) => (
            <div key={item.id} className="rounded-xl border border-gray-100 p-3 dark:border-gray-800">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">{item.title}</span>
                <span>{item.score}/{item.total}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
