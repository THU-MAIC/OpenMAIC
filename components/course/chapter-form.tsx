'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';

interface ChapterFormProps {
  initialTitle?: string;
  initialDescription?: string;
  onSubmit: (title: string, description: string | null) => void;
  onCancel: () => void;
}

export function ChapterForm({ initialTitle = '', initialDescription = '', onSubmit, onCancel }: ChapterFormProps) {
  const { t } = useI18n();
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit(title.trim(), description.trim() || null);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-sm font-medium mb-1">{t('course.chapterTitle')}</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full px-3 py-2 border rounded text-sm"
          autoFocus
          required
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">{t('course.chapterDescription')}</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full px-3 py-2 border rounded text-sm"
          placeholder="（可选）"
        />
      </div>
      <div className="flex gap-2">
        <button type="submit" className="px-3 py-1.5 bg-blue-500 text-white text-sm rounded hover:bg-blue-600">
          {t('common.confirm')}
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 border text-sm rounded hover:bg-gray-50">
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
