'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Copy, Loader2 } from 'lucide-react';

interface PromptPreviewProps {
  displayName: string;
  original: string;
  category: string;
}

export function PromptPreview({ displayName, original, category }: PromptPreviewProps) {
  const [variables, setVariables] = useState<Record<string, string>>({
    context: 'Unit 3: Ancient Civilizations',
    language: 'en',
    'user.name': 'John Smith',
    'user.role': 'INSTRUCTOR',
    topic: 'Climate Change',
    grade_level: '10',
    media_type: 'video',
  });

  const [rendered, setRendered] = useState('');
  const [loading, setLoading] = useState(false);

  async function handlePreview() {
    setLoading(true);
    try {
      // Extract actual prompt ID if available - for now just do client-side substitution
      let output = original;
      Object.entries(variables).forEach(([key, value]) => {
        output = output.replace(new RegExp(`{{${key}}}`, 'g'), value);
      });
      output = output.replace(/{{[^}]+}}/g, '');
      setRendered(output);
    } finally {
      setLoading(false);
    }
  }

  function copyToClipboard() {
    navigator.clipboard.writeText(rendered).catch(console.error);
  }

  return (
    <div className="space-y-4 rounded-lg border border-white/10 bg-white/5 p-4">
      <div className="grid grid-cols-1 gap-4">
        <div>
          <label className="text-xs uppercase tracking-wider text-slate-400">Test Variables</label>
          <div className="mt-2 space-y-2">
            {Object.entries(variables).map(([key, value]) => (
              <input
                key={key}
                type="text"
                value={value}
                onChange={(e) => setVariables((v) => ({ ...v, [key]: e.target.value }))}
                placeholder={key}
                className="w-full px-2 py-1 bg-white/5 border border-white/5 rounded text-xs text-slate-300 placeholder:text-slate-600"
              />
            ))}
          </div>
        </div>

        <Button
          type="button"
          onClick={handlePreview}
          disabled={loading}
          className="w-full bg-purple-600 hover:bg-purple-700 text-sm gap-2"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          Generate Preview
        </Button>

        {rendered && (
          <div>
            <label className="text-xs uppercase tracking-wider text-slate-400">Rendered Output</label>
            <div className="mt-2 relative">
              <pre className="p-3 rounded-lg bg-black/50 border border-white/10 text-xs text-slate-200 overflow-auto max-h-48 whitespace-pre-wrap break-words">
                {rendered}
              </pre>
              <button
                type="button"
                onClick={copyToClipboard}
                className="absolute top-2 right-2 p-1 rounded bg-white/10 hover:bg-white/20 text-slate-400"
                title="Copy to clipboard"
              >
                <Copy className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
