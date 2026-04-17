'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';

interface ActivePrompt {
  id: string;
  key: string;
  displayName: string;
  category: string;
  version: number;
  isActive: boolean;
}

export function ActivePromptsPanel() {
  const [prompts, setPrompts] = useState<ActivePrompt[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchActivePrompts();
  }, []);

  async function fetchActivePrompts() {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/system-config/prompts');
      const data = await res.json();
      const activePrompts = (data.prompts ?? [])
        .filter((p: any) => p.isActive)
        .sort((a: any, b: any) => a.category.localeCompare(b.category));
      setPrompts(activePrompts);
    } catch (err) {
      console.error('Failed to fetch prompts:', err);
    } finally {
      setLoading(false);
    }
  }

  const categoryLabels: Record<string, string> = {
    SYSTEM: 'System',
    GENERATION: 'Generation',
    GRADING: 'Grading',
    ANALYSIS: 'Analysis',
    CHAT: 'Chat',
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Active Prompts</h3>
        <Link
          href="/admin/system-config/prompts"
          className="text-xs px-3 py-1.5 rounded-lg bg-purple-600/20 text-purple-300 hover:bg-purple-600/30"
        >
          Manage Prompts
        </Link>
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
        </div>
      ) : prompts.length === 0 ? (
        <div className="flex items-start gap-3 p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
          <AlertCircle className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-blue-300 font-medium">No active prompts</p>
            <p className="text-xs text-blue-200 mt-1">
              System is using default prompts. Create and activate prompts in the Prompt Studio.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {prompts.map((prompt) => (
            <div
              key={prompt.key}
              className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
                  <p className="text-sm font-medium text-white">{prompt.displayName}</p>
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
                  <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10">
                    {categoryLabels[prompt.category] || prompt.category}
                  </span>
                  <span>v{prompt.version}</span>
                  <code className="font-mono text-slate-500">{prompt.key}</code>
                </div>
              </div>
              <Link
                href={`/admin/system-config/prompts/${prompt.id}`}
                className="text-xs px-2 py-1 rounded bg-white/10 text-slate-300 hover:bg-white/20 whitespace-nowrap"
              >
                Edit
              </Link>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 pt-4 border-t border-white/10">
        <p className="text-xs text-slate-400">
          Active prompts are injected into generation, chat, and grading workflows automatically.
          <br />
          Update prompts in the Prompt Studio to change system behavior without redeploying.
        </p>
      </div>
    </div>
  );
}
