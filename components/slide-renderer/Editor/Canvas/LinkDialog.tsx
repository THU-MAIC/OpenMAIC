'use client';

import { useEffect, useState } from 'react';
import type { PPTElementLink } from '@/lib/types/slides';

interface LinkDialogProps {
  currentLink?: PPTElementLink;
  onConfirm: (link: PPTElementLink) => void;
  onClose: () => void;
}

export function LinkDialog({ currentLink, onConfirm, onClose }: LinkDialogProps) {
  const [url, setUrl] = useState(currentLink?.target || '');

  useEffect(() => {
    setUrl(currentLink?.target || '');
  }, [currentLink]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    onConfirm({ type: 'web', target: trimmed });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <form
        className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-5 w-[380px] space-y-4"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {currentLink ? 'Edit Link' : 'Add Link'}
        </h3>
        <input
          type="url"
          placeholder="https://example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="w-full rounded border border-gray-300 dark:border-gray-600 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!url.trim()}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Confirm
          </button>
        </div>
      </form>
    </div>
  );
}
