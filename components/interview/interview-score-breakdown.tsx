'use client';

export function InterviewScoreBreakdown({ communication, technical }: { communication: number; technical: number }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <h3 className="text-base font-semibold">Score Breakdown</h3>
      <div className="mt-4 space-y-3 text-sm">
        <div>
          <div className="flex items-center justify-between"><span>Communication</span><span>{communication}/10</span></div>
          <div className="mt-1 h-2 rounded-full bg-gray-100 dark:bg-gray-800"><div className="h-2 rounded-full bg-violet-500" style={{ width: `${communication * 10}%` }} /></div>
        </div>
        <div>
          <div className="flex items-center justify-between"><span>Technical Accuracy</span><span>{technical}/10</span></div>
          <div className="mt-1 h-2 rounded-full bg-gray-100 dark:bg-gray-800"><div className="h-2 rounded-full bg-emerald-500" style={{ width: `${technical * 10}%` }} /></div>
        </div>
      </div>
    </div>
  );
}
