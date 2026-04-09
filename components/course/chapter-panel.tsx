'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BookOpen, Plus, Trash2, ExternalLink } from 'lucide-react';
import { listStages, type StageListItem } from '@/lib/utils/stage-storage';
import type { CourseModule } from '@/lib/types/course';

interface ChapterPanelProps {
  module: CourseModule;
  onUpdate: (moduleId: string, updates: Partial<CourseModule>) => void;
}

/**
 * Lists "chapters" (stages) linked to a module. A module can have 1..N
 * chapters generated via OpenMAIC core. Chapters are stored client-side in
 * IndexedDB via stage-storage.
 */
export function ChapterPanel({ module, onUpdate }: ChapterPanelProps) {
  const [stages, setStages] = useState<StageListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    listStages()
      .then(setStages)
      .catch(() => setStages([]))
      .finally(() => setLoading(false));
  }, []);

  const linkedStages = stages.filter((s) => module.stageIds.includes(s.id));
  const availableStages = stages.filter((s) => !module.stageIds.includes(s.id));

  const linkChapter = (stageId: string) => {
    onUpdate(module.id, { stageIds: [...module.stageIds, stageId] });
    setShowPicker(false);
  };

  const unlinkChapter = (stageId: string) => {
    onUpdate(module.id, { stageIds: module.stageIds.filter((id) => id !== stageId) });
  };

  return (
    <div className="mt-4 p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm text-gray-900 dark:text-gray-100">
          Capítulos del módulo: {module.title}
        </h3>
        <div className="flex gap-2">
          <button
            onClick={() => setShowPicker((v) => !v)}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-violet-600 hover:bg-violet-700 text-white rounded"
          >
            <Plus className="w-3 h-3" />
            Vincular existente
          </button>
          <Link
            href="/"
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-green-600 hover:bg-green-700 text-white rounded"
            title="Crear un nuevo capítulo con el núcleo de OpenMAIC"
          >
            <ExternalLink className="w-3 h-3" />
            Crear nuevo
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="text-xs text-gray-500">Cargando capítulos...</div>
      ) : linkedStages.length === 0 && !showPicker ? (
        <div className="text-xs text-gray-500 py-4 text-center border border-dashed border-gray-300 dark:border-gray-600 rounded">
          Este módulo aún no tiene capítulos. Vincula uno existente o crea uno nuevo.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {linkedStages.map((s) => (
            <li
              key={s.id}
              className="flex items-center gap-2 p-2 bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700"
            >
              <BookOpen className="w-4 h-4 text-violet-500 shrink-0" />
              <Link
                href={`/classroom/${s.id}`}
                className="flex-1 min-w-0 text-sm text-gray-900 dark:text-gray-100 truncate hover:text-violet-600"
              >
                {s.name}
              </Link>
              <span className="text-xs text-gray-500">
                {s.sceneCount} {s.sceneCount === 1 ? 'escena' : 'escenas'}
              </span>
              <button
                onClick={() => unlinkChapter(s.id)}
                className="p-1 text-gray-400 hover:text-red-500"
                aria-label="Desvincular capítulo"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
          {module.stageIds
            .filter((id) => !stages.find((s) => s.id === id))
            .map((orphanId) => (
              <li
                key={orphanId}
                className="flex items-center gap-2 p-2 bg-amber-50 dark:bg-amber-900/20 rounded border border-amber-200 dark:border-amber-800"
              >
                <span className="text-xs text-amber-700 dark:text-amber-300 flex-1 truncate">
                  Capítulo no encontrado localmente: {orphanId}
                </span>
                <button
                  onClick={() => unlinkChapter(orphanId)}
                  className="p-1 text-amber-500 hover:text-red-500"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
        </ul>
      )}

      {showPicker && (
        <div className="mt-3 p-3 bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">
          <div className="text-xs font-medium mb-2 text-gray-700 dark:text-gray-300">
            Selecciona un capítulo existente:
          </div>
          {availableStages.length === 0 ? (
            <div className="text-xs text-gray-500 py-2">
              No hay capítulos disponibles. Crea uno nuevo desde el núcleo de OpenMAIC.
            </div>
          ) : (
            <ul className="space-y-1 max-h-60 overflow-y-auto">
              {availableStages.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => linkChapter(s.id)}
                    className="w-full text-left p-2 text-sm rounded hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                  >
                    <BookOpen className="w-3.5 h-3.5 text-gray-400" />
                    <span className="flex-1 truncate">{s.name}</span>
                    <span className="text-xs text-gray-500">
                      {s.sceneCount} {s.sceneCount === 1 ? 'escena' : 'escenas'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
