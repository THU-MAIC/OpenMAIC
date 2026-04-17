'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Plus, Loader2, Trash2, Edit2, Download, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/admin/common/EmptyState';
import { toast } from 'sonner';

interface PromptRow {
  id: string;
  key: string;
  displayName: string;
  description: string | null;
  category: string;
  isActive: boolean;
  version: number;
}

interface PromptListProps {
  categoryFilter?: string;
  canCreate?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canExport?: boolean;
  canImport?: boolean;
}

export function PromptList({
  categoryFilter,
  canCreate = false,
  canEdit = false,
  canDelete = false,
  canExport = false,
  canImport = false,
}: PromptListProps) {
  const [prompts, setPrompts] = useState<PromptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(categoryFilter ?? '');
  const [selectedStatus, setSelectedStatus] = useState<'all' | 'active' | 'draft'>('all');
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchPrompts = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch('/api/admin/system-config/prompts');
      if (!res.ok) {
        setPrompts([]);
        setFetchError(res.status === 403 ? 'You do not have permission to view prompts.' : 'Failed to load prompts.');
        return;
      }
      const data = await res.json();
      setPrompts(data.prompts ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPrompts();
  }, [fetchPrompts]);

  async function deletePrompt(id: string) {
    if (!confirm('Delete this prompt? This action cannot be undone.')) return;
    setDeleting(id);
    const res = await fetch(`/api/admin/system-config/prompts/${id}`, { method: 'DELETE' });
    setDeleting(null);
    if (res.ok) {
      void fetchPrompts();
    }
  }

  async function exportPrompts() {
    setExporting(true);
    try {
      const res = await fetch('/api/admin/system-config/prompts/bulk');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to export prompts');
        return;
      }

      const payload = {
        exportedAt: new Date().toISOString(),
        prompts: data.prompts ?? [],
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `openmaic-prompts-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Prompt export downloaded');
    } catch {
      toast.error('Failed to export prompts');
    } finally {
      setExporting(false);
    }
  }

  async function importPromptsFromFile(file: File | null) {
    if (!file) return;

    setImporting(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { prompts?: unknown[] };
      const prompts = parsed.prompts;

      if (!Array.isArray(prompts) || prompts.length === 0) {
        toast.error('Import file has no prompts array');
        return;
      }

      const previewRes = await fetch('/api/admin/system-config/prompts/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompts, dryRun: true }),
      });

      const previewData = await previewRes.json();
      if (!previewRes.ok) {
        toast.error(previewData.error || 'Failed to preview import');
        return;
      }

      const previewSummary = previewData.summary || {};
      const confirmApply = window.confirm(
        [
          'Import Preview',
          `Total: ${previewSummary.total ?? 0}`,
          `Create: ${previewSummary.created ?? 0}`,
          `Update: ${previewSummary.updated ?? 0}`,
          `Unchanged: ${previewSummary.unchanged ?? 0}`,
          '',
          'Apply these changes?',
        ].join('\n'),
      );

      if (!confirmApply) {
        toast('Import canceled');
        return;
      }

      const res = await fetch('/api/admin/system-config/prompts/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompts }),
      });

      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Prompt import failed');
        return;
      }

      const created = data.summary?.created ?? 0;
      const updated = data.summary?.updated ?? 0;
      const unchanged = data.summary?.unchanged ?? 0;
      toast.success(`Import complete (${created} created, ${updated} updated, ${unchanged} unchanged)`);
      void fetchPrompts();
    } catch {
      toast.error('Invalid JSON file');
    } finally {
      setImporting(false);
    }
  }

  const categories = ['SYSTEM', 'GENERATION', 'GRADING', 'ANALYSIS', 'CHAT'];
  const categoryLabels: Record<string, string> = {
    SYSTEM: 'System',
    GENERATION: 'Generation',
    GRADING: 'Grading',
    ANALYSIS: 'Analysis',
    CHAT: 'Chat',
  };

  const promptsByCategory = selectedCategory
    ? prompts.filter((p) => p.category === selectedCategory)
    : prompts;
  const activeCount = promptsByCategory.filter((p) => p.isActive).length;
  const draftCount = promptsByCategory.filter((p) => !p.isActive).length;
  const visiblePrompts = selectedStatus === 'active'
    ? promptsByCategory.filter((p) => p.isActive)
    : selectedStatus === 'draft'
      ? promptsByCategory.filter((p) => !p.isActive)
      : promptsByCategory;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Prompt Studio</h1>
          <p className="mt-1 text-sm text-slate-400">
            Create and manage AI prompt templates
          </p>
        </div>
        {canCreate && (
          <Button asChild className="gap-2 bg-purple-600 hover:bg-purple-700 text-white">
            <Link href="/admin/system-config/prompts/new">
              <Plus className="h-4 w-4" />
              New prompt
            </Link>
          </Button>
        )}
        <div className="flex items-center gap-2">
          {canExport && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void exportPrompts()}
              disabled={exporting || importing}
              className="gap-2 border-white/10 text-slate-300"
            >
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Export
            </Button>
          )}

          {canImport && (
            <label className="inline-flex">
              <input
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  void importPromptsFromFile(file);
                  e.currentTarget.value = '';
                }}
                disabled={exporting || importing}
              />
              <span className="inline-flex h-9 items-center gap-2 rounded-md border border-white/10 px-4 text-sm text-slate-300 hover:bg-white/5 cursor-pointer">
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Import
              </span>
            </label>
          )}
        </div>
      </div>

      {/* Category + Status filter row */}
      <div className="mb-6 flex items-center gap-2 overflow-x-auto pb-2">
        <span className="shrink-0 text-sm text-slate-400">Category:</span>
        <button
          onClick={() => setSelectedCategory('')}
          className={`px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
            selectedCategory === ''
              ? 'bg-purple-600 text-white'
              : 'bg-white/10 text-slate-300 hover:bg-white/20'
          }`}
        >
          All
        </button>
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
              selectedCategory === cat
                ? 'bg-purple-600 text-white'
                : 'bg-white/10 text-slate-300 hover:bg-white/20'
            }`}
          >
            {categoryLabels[cat]}
          </button>
        ))}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="shrink-0 text-sm text-slate-400">Status:</span>
          <button
            onClick={() => setSelectedStatus('all')}
            className={`px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
              selectedStatus === 'all'
                ? 'bg-purple-600 text-white'
                : 'bg-white/10 text-slate-300 hover:bg-white/20'
            }`}
          >
            All ({promptsByCategory.length})
          </button>
          <button
            onClick={() => setSelectedStatus('active')}
            className={`px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
              selectedStatus === 'active'
                ? 'bg-green-600 text-white'
                : 'bg-white/10 text-slate-300 hover:bg-white/20'
            }`}
          >
            Active ({activeCount})
          </button>
          <button
            onClick={() => setSelectedStatus('draft')}
            className={`px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
              selectedStatus === 'draft'
                ? 'bg-slate-600 text-white'
                : 'bg-white/10 text-slate-300 hover:bg-white/20'
            }`}
          >
            Draft ({draftCount})
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-purple-400" />
        </div>
      ) : fetchError ? (
        <EmptyState title="Access denied" description={fetchError} />
      ) : visiblePrompts.length === 0 ? (
        <EmptyState
          title={selectedStatus === 'draft' ? 'No draft prompts found' : 'No prompts found'}
          description={
            selectedStatus === 'draft'
              ? 'All prompts are currently active. Create a new prompt or deactivate one to see drafts here.'
              : 'Create a new prompt template to get started.'
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/10 bg-white/5">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10">
                {['Key', 'Display Name', 'Category', 'Version', 'Status', ''].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {visiblePrompts.map((prompt) => (
                <tr key={prompt.id} className="hover:bg-white/5">
                  <td className="px-4 py-3 font-mono text-xs text-slate-200">{prompt.key}</td>
                  <td className="px-4 py-3 text-white">{prompt.displayName}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/15 text-blue-300">
                      {categoryLabels[prompt.category] || prompt.category}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-400">v{prompt.version}</td>
                  <td className="px-4 py-3">
                    {prompt.isActive ? (
                      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/15 text-green-300">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-slate-500/15 text-slate-300">
                        Draft
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {canEdit && (
                        <Link
                          href={`/admin/system-config/prompts/${prompt.id}`}
                          className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
                          title="Edit prompt"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </Link>
                      )}
                      {canDelete && (
                        <button
                          onClick={() => deletePrompt(prompt.id)}
                          disabled={deleting === prompt.id}
                          className="p-1.5 rounded-lg hover:bg-red-500/10 text-slate-400 hover:text-red-400 transition-colors disabled:opacity-50"
                          title="Delete prompt"
                        >
                          {deleting === prompt.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
