'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ClassroomMeta, CourseChapter } from '@/lib/types/course';
import { ChapterForm } from './chapter-form';

interface ChapterListProps {
  courseId: string;
  chapters: CourseChapter[];
  classroomMeta: Record<string, ClassroomMeta>;
  onAdd: (title: string, description: string | null) => Promise<void>;
  onEdit: (chapterId: string, title: string, description: string | null) => Promise<void>;
  onRemove: (chapterId: string) => Promise<void>;
  onMove: (chapterId: string, direction: 'up' | 'down') => Promise<void>;
  onBind: (chapterId: string) => void;
  onUnbind: (chapterId: string) => Promise<void>;
  onCreateAndBind: (chapterId: string) => void;
  onOpenClassroom: (classroomId: string) => void;
}

export function ChapterList({
  courseId: _courseId,
  chapters,
  classroomMeta,
  onAdd,
  onEdit,
  onRemove,
  onMove,
  onBind,
  onUnbind,
  onCreateAndBind,
  onOpenClassroom,
}: ChapterListProps) {
  const { t } = useI18n();
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleAdd = async (title: string, description: string | null) => {
    await onAdd(title, description);
    setShowAddForm(false);
  };

  const handleEdit = async (chapterId: string, title: string, description: string | null) => {
    await onEdit(chapterId, title, description);
    setEditingId(null);
  };

  const handleRemove = async (chapterId: string) => {
    if (!confirm(t('course.confirmRemoveChapter'))) return;
    await onRemove(chapterId);
  };

  if (chapters.length === 0 && !showAddForm) {
    return (
      <div className="text-center py-12 text-gray-500">
        <p className="mb-4">{t('course.noChapters')}</p>
        <button
          onClick={() => setShowAddForm(true)}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm"
        >
          {t('course.addChapter')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {chapters.map((chapter, idx) => {
        const meta = chapter.classroomId ? classroomMeta[chapter.classroomId] : undefined;
        const isEditing = editingId === chapter.id;

        return (
          <div key={chapter.id} className="border rounded-lg p-4">
            {isEditing ? (
              <ChapterForm
                initialTitle={chapter.title}
                initialDescription={chapter.description}
                onSubmit={(title, description) => handleEdit(chapter.id, title, description)}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <div className="flex items-start gap-3">
                {/* Order number */}
                <span className="flex-shrink-0 w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-sm font-medium text-gray-600">
                  {idx + 1}
                </span>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{chapter.title}</span>
                    {chapter.classroomId && (
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded-full ${
                          meta?.published
                            ? 'bg-green-100 text-green-700'
                            : 'bg-gray-100 text-gray-500'
                        }`}
                      >
                        {meta?.published ? t('course.published') : t('course.unpublished')}
                      </span>
                    )}
                  </div>
                  {chapter.description && (
                    <p className="text-sm text-gray-500 mt-0.5">{chapter.description}</p>
                  )}
                  {chapter.classroomId && meta && (
                    <button
                      onClick={() => onOpenClassroom(chapter.classroomId!)}
                      className="text-sm text-blue-600 hover:underline mt-1"
                    >
                      {meta.name} · {meta.sceneCount} 个场景
                    </button>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => onMove(chapter.id, 'up')}
                    disabled={idx === 0}
                    className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed text-xs"
                    title={t('course.moveUp')}
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => onMove(chapter.id, 'down')}
                    disabled={idx === chapters.length - 1}
                    className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed text-xs"
                    title={t('course.moveDown')}
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => setEditingId(chapter.id)}
                    className="px-2 py-1 text-xs border rounded hover:bg-gray-50"
                  >
                    {t('course.editChapter')}
                  </button>
                  {chapter.classroomId ? (
                    <button
                      onClick={() => onUnbind(chapter.id)}
                      className="px-2 py-1 text-xs border rounded hover:bg-gray-50"
                    >
                      {t('course.unbindClassroom')}
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => onBind(chapter.id)}
                        className="px-2 py-1 text-xs border rounded hover:bg-gray-50"
                      >
                        {t('course.bindClassroom')}
                      </button>
                      <button
                        onClick={() => onCreateAndBind(chapter.id)}
                        className="px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600"
                      >
                        {t('course.createAndBindClassroom')}
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => handleRemove(chapter.id)}
                    className="px-2 py-1 text-xs text-red-500 border border-red-200 rounded hover:bg-red-50"
                  >
                    {t('course.removeChapter')}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Add form */}
      {showAddForm ? (
        <div className="border rounded-lg p-4">
          <ChapterForm onSubmit={handleAdd} onCancel={() => setShowAddForm(false)} />
        </div>
      ) : (
        <button
          onClick={() => setShowAddForm(true)}
          className="w-full py-2 border border-dashed rounded-lg text-sm text-gray-500 hover:border-blue-400 hover:text-blue-500 transition-colors"
        >
          + {t('course.addChapter')}
        </button>
      )}
    </div>
  );
}
