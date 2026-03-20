'use client';

import type { InterviewConfig, InterviewDifficulty, InterviewRole, InterviewType } from '@/lib/interview/types';

const interviewTypes: InterviewType[] = ['technical', 'hr', 'both'];
const roles: InterviewRole[] = ['software-engineer', 'data-analyst', 'product-manager', 'general'];
const difficulties: InterviewDifficulty[] = ['fresher', '2-3-years', 'senior'];

export function InterviewConfigForm({ config, onChange, onStart, loading }: { config: InterviewConfig; onChange: (config: InterviewConfig) => void; onStart: () => void; loading?: boolean }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <h2 className="text-xl font-semibold">Interview Prep Mode</h2>
      <p className="mt-2 text-sm text-muted-foreground">Practice with a natural AI interviewer using text, voice, live feedback, and a final debrief.</p>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <label className="space-y-2 text-sm">
          <span className="font-medium">Interview Type</span>
          <select className="w-full rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700 dark:bg-gray-950" value={config.interviewType} onChange={(event) => onChange({ ...config, interviewType: event.target.value as InterviewType })}>
            {interviewTypes.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="space-y-2 text-sm">
          <span className="font-medium">Role</span>
          <select className="w-full rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700 dark:bg-gray-950" value={config.role} onChange={(event) => onChange({ ...config, role: event.target.value as InterviewRole })}>
            {roles.map((item) => <option key={item} value={item}>{item.replace(/-/g, ' ')}</option>)}
          </select>
        </label>
        <label className="space-y-2 text-sm">
          <span className="font-medium">Difficulty</span>
          <select className="w-full rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700 dark:bg-gray-950" value={config.difficulty} onChange={(event) => onChange({ ...config, difficulty: event.target.value as InterviewDifficulty })}>
            {difficulties.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
      </div>
      <button onClick={onStart} disabled={loading} className="mt-6 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
        {loading ? 'Starting...' : 'Start Interview'}
      </button>
    </div>
  );
}
