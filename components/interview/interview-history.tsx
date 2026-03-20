'use client';

import type { InterviewHistoryItem } from '@/lib/interview/types';

export function InterviewHistory({ items }: { items: InterviewHistoryItem[] }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <h3 className="text-base font-semibold">Past Sessions</h3>
      <div className="mt-4 space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No interview sessions yet.</p>
        ) : (
          items.map((item) => (
            <div key={item.id} className="rounded-xl border border-gray-100 p-4 dark:border-gray-800">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">{item.config.role.replace(/-/g, ' ')}</span>
                <span>{item.summary?.overallScore ?? '—'}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
