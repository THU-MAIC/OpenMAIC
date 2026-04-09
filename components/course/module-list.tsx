'use client';

import { useState } from 'react';
import type { CourseModule } from '@/lib/types/course';
import { cn } from '@/lib/utils';
import { GripVertical, Trash2, BookOpen, Pencil, Check, X } from 'lucide-react';

interface ModuleListProps {
  modules: CourseModule[];
  onRemove: (moduleId: string) => void;
  onUpdate?: (moduleId: string, updates: Partial<CourseModule>) => void;
  onSelect?: (moduleId: string) => void;
  selectedId?: string | null;
}

export function ModuleList({ modules, onRemove, onUpdate, onSelect, selectedId }: ModuleListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');

  const startEdit = (m: CourseModule) => {
    setEditingId(m.id);
    setDraftTitle(m.title);
    setDraftDescription(m.description ?? '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraftTitle('');
    setDraftDescription('');
  };

  const commitEdit = (moduleId: string) => {
    if (!onUpdate) return cancelEdit();
    const title = draftTitle.trim() || 'Sin título';
    onUpdate(moduleId, { title, description: draftDescription.trim() || undefined });
    cancelEdit();
  };

  if (modules.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-gray-500 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl">
        Aún no hay módulos. Agrega el primero.
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {modules
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((m) => {
          const isEditing = editingId === m.id;
          return (
            <li
              key={m.id}
              className={cn(
                'flex items-start gap-3 p-3 rounded-lg border transition-colors',
                isEditing ? 'cursor-default' : 'cursor-pointer',
                selectedId === m.id
                  ? 'border-violet-500 bg-violet-50 dark:bg-violet-900/20'
                  : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50',
              )}
              onClick={() => !isEditing && onSelect?.(m.id)}
            >
              <GripVertical className="w-4 h-4 text-gray-400 shrink-0 mt-1" />
              <div className="flex-1 min-w-0">
                {isEditing ? (
                  <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      autoFocus
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitEdit(m.id);
                        if (e.key === 'Escape') cancelEdit();
                      }}
                      placeholder="Título del módulo"
                      className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900"
                    />
                    <textarea
                      value={draftDescription}
                      onChange={(e) => setDraftDescription(e.target.value)}
                      placeholder="Descripción (opcional)"
                      rows={2}
                      className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900"
                    />
                  </div>
                ) : (
                  <>
                    <div className="font-medium text-gray-900 dark:text-gray-100 truncate">
                      {m.title}
                    </div>
                    {m.description && (
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {m.description}
                      </div>
                    )}
                    <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1">
                      <BookOpen className="w-3 h-3" />
                      {m.stageIds.length}{' '}
                      {m.stageIds.length === 1 ? 'capítulo' : 'capítulos'}
                    </div>
                  </>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {isEditing ? (
                  <>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        commitEdit(m.id);
                      }}
                      className="p-1.5 text-green-600 hover:text-green-700"
                      aria-label="Guardar"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        cancelEdit();
                      }}
                      className="p-1.5 text-gray-400 hover:text-gray-600"
                      aria-label="Cancelar"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </>
                ) : (
                  <>
                    {onUpdate && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEdit(m);
                        }}
                        className="p-1.5 text-gray-400 hover:text-violet-500 transition-colors"
                        aria-label="Editar módulo"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`¿Eliminar el módulo "${m.title}"?`)) onRemove(m.id);
                      }}
                      className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                      aria-label="Eliminar módulo"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
    </ul>
  );
}
