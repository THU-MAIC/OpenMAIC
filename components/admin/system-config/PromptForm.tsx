'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { VariableReference } from './VariableReference';
import { PromptPreview } from './PromptPreview';

interface PromptFormProps {
  initialPrompt?: {
    id: string;
    key: string;
    displayName: string;
    description: string | null;
    content: string;
    category: string;
    variables: string[];
    isActive: boolean;
    version: number;
  };
}

export function PromptForm({ initialPrompt }: PromptFormProps) {
  const router = useRouter();
  const contentRef = useRef<HTMLTextAreaElement>(null);
  
  const [form, setForm] = useState({
    key: initialPrompt?.key ?? '',
    displayName: initialPrompt?.displayName ?? '',
    description: initialPrompt?.description ?? '',
    content: initialPrompt?.content ?? '',
    category: initialPrompt?.category ?? 'SYSTEM',
    variables: initialPrompt?.variables ?? [],
    isActive: initialPrompt?.isActive ?? false,
  });

  const [categories, setCategories] = useState<Array<{ value: string; label: string }>>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // Fetch categories on mount
  useEffect(() => {
    fetch('/api/admin/system-config/prompts/categories')
      .then((res) => res.json())
      .then((data) => setCategories(data.categories))
      .catch(console.error);
  }, []);

  function insertVariable(varName: string) {
    if (contentRef.current) {
      const textarea = contentRef.current;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newContent =
        form.content.substring(0, start) +
        `{{${varName}}}` +
        form.content.substring(end);
      setForm((f) => ({ ...f, content: newContent }));
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(start + varName.length + 4, start + varName.length + 4);
      }, 0);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});

    const errs: Record<string, string> = {};
    if (!form.key.trim()) errs.key = 'Key is required';
    if (!form.displayName.trim()) errs.displayName = 'Display name is required';
    if (!form.content.trim()) errs.content = 'Content is required';
    if (!form.category) errs.category = 'Category is required';

    if (Object.keys(errs).length) {
      setErrors(errs);
      return;
    }

    setSubmitting(true);

    try {
      const method = initialPrompt ? 'PATCH' : 'POST';
      const url = initialPrompt
        ? `/api/admin/system-config/prompts/${initialPrompt.id}`
        : '/api/admin/system-config/prompts';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: form.key.trim(),
          displayName: form.displayName.trim(),
          description: form.description.trim(),
          content: form.content.trim(),
          category: form.category,
          variables: form.variables,
          isActive: form.isActive,
        }),
      });

      const data = await res.json();
      setSubmitting(false);

      if (!res.ok) {
        setErrors({ submit: data.error ?? 'Failed to save prompt' });
      } else {
        router.push('/admin/system-config/prompts');
        router.refresh();
      }
    } catch (err) {
      setSubmitting(false);
      setErrors({ submit: 'An error occurred' });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {errors.submit && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-red-400 text-sm">
          {errors.submit}
        </div>
      )}

      {/* Identity section */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-white">Prompt Details</h3>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">
            Key (unique identifier)
          </label>
          <input
            type="text"
            value={form.key}
            onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
            disabled={!!initialPrompt}
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
            placeholder="scene_outline_v1"
          />
          {errors.key && <p className="text-red-400 text-xs mt-1">{errors.key}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">Display name</label>
          <input
            type="text"
            value={form.displayName}
            onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            placeholder="Scene Outline Generator"
          />
          {errors.displayName && <p className="text-red-400 text-xs mt-1">{errors.displayName}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">Category</label>
          <select
            value={form.category}
            onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
          >
            {categories.map((cat) => (
              <option key={cat.value} value={cat.value}>
                {cat.label}
              </option>
            ))}
          </select>
          {errors.category && <p className="text-red-400 text-xs mt-1">{errors.category}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">Description</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
            rows={2}
            placeholder="Optional description of this prompt template"
          />
        </div>
      </div>

      {/* Content editor section */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-white">Prompt Content</h3>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">Prompt text</label>
          <textarea
            ref={contentRef}
            value={form.content}
            onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 resize-y font-mono"
            rows={10}
            placeholder="You are a helpful assistant. Context: {{context}}..."
          />
          {errors.content && <p className="text-red-400 text-xs mt-1">{errors.content}</p>}
        </div>

        <VariableReference onVariableClick={insertVariable} />
      </div>

      {/* Preview section */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-white">Preview</h3>
        <PromptPreview
          displayName={form.displayName}
          original={form.content}
          category={form.category}
        />
      </div>

      {/* Status section */}
      {initialPrompt && (
        <div className="space-y-4 rounded-lg border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-white">Active (deployed)</p>
              <p className="text-xs text-slate-400">This is the version currently in use</p>
            </div>
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              className="w-4 h-4 accent-purple-500"
            />
          </div>
          <p className="text-xs text-slate-500">Version {initialPrompt.version}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3 pt-4">
        <Button
          type="submit"
          disabled={submitting}
          className="bg-purple-600 hover:bg-purple-700 text-white gap-2"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {initialPrompt ? 'Update prompt' : 'Create prompt'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push('/admin/system-config/prompts')}
          className="border-white/10 text-slate-300"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
