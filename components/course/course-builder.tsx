'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCourseStore } from '@/lib/store/course';
import { PhilosophySelector } from './philosophy-selector';
import { ModuleList } from './module-list';
import { CollaboratorPanel } from './collaborator-panel';
import { ChapterPanel } from './chapter-panel';
import { ScormExportButton } from './scorm-export-button';
import type { CourseModule } from '@/lib/types/course';
import { Trash2, Pencil } from 'lucide-react';

interface CourseBuilderProps {
  courseId: string;
}

export function CourseBuilder({ courseId }: CourseBuilderProps) {
  const router = useRouter();
  const {
    currentCourse,
    currentModuleId,
    loadCourse,
    saveCourse,
    setPhilosophy,
    addModule,
    updateModule,
    removeModule,
    setCurrentModule,
    addCollaborator,
    removeCollaborator,
  } = useCourseStore();

  const [isEditingMeta, setIsEditingMeta] = useState(false);
  const [metaTitle, setMetaTitle] = useState('');
  const [metaDescription, setMetaDescription] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadCourse(courseId);
  }, [courseId, loadCourse]);

  useEffect(() => {
    if (currentCourse) {
      setMetaTitle(currentCourse.title);
      setMetaDescription(currentCourse.description ?? '');
    }
  }, [currentCourse?.id]);

  const handleDeleteCourse = async () => {
    if (!currentCourse) return;
    if (!confirm(`¿Eliminar el curso "${currentCourse.title}"? Esta acción no se puede deshacer.`))
      return;
    setDeleting(true);
    const res = await fetch(`/api/courses/${currentCourse.id}`, { method: 'DELETE' });
    if (res.ok) {
      router.push('/courses');
    } else {
      setDeleting(false);
      alert('No se pudo eliminar el curso.');
    }
  };

  const commitMetaEdit = () => {
    if (!currentCourse) return;
    const title = metaTitle.trim() || currentCourse.title;
    useCourseStore.setState({
      currentCourse: {
        ...currentCourse,
        title,
        description: metaDescription.trim() || undefined,
        updatedAt: Date.now(),
      },
    });
    setIsEditingMeta(false);
  };

  if (!currentCourse) {
    return <div className="p-8 text-center text-gray-500">Cargando curso...</div>;
  }

  const handleAddModule = () => {
    const newModule: CourseModule = {
      id: `mod_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      courseId: currentCourse.id,
      title: 'Nuevo módulo',
      order: currentCourse.modules.length,
      stageIds: [],
    };
    addModule(newModule);
  };

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {isEditingMeta ? (
            <div className="space-y-2">
              <input
                value={metaTitle}
                onChange={(e) => setMetaTitle(e.target.value)}
                className="w-full px-3 py-2 text-2xl font-bold border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900"
              />
              <textarea
                value={metaDescription}
                onChange={(e) => setMetaDescription(e.target.value)}
                rows={2}
                placeholder="Descripción del curso"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900"
              />
              <div className="flex gap-2">
                <button
                  onClick={commitMetaEdit}
                  className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-700 text-white rounded-md"
                >
                  Aceptar
                </button>
                <button
                  onClick={() => {
                    setIsEditingMeta(false);
                    setMetaTitle(currentCourse.title);
                    setMetaDescription(currentCourse.description ?? '');
                  }}
                  className="px-3 py-1.5 text-xs bg-gray-200 dark:bg-gray-700 rounded-md"
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
                  {currentCourse.title}
                </h1>
                {currentCourse.description && (
                  <p className="text-gray-600 dark:text-gray-400 mt-1">
                    {currentCourse.description}
                  </p>
                )}
              </div>
              <button
                onClick={() => setIsEditingMeta(true)}
                className="p-2 text-gray-400 hover:text-violet-500"
                aria-label="Editar curso"
              >
                <Pencil className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <ScormExportButton courseId={currentCourse.id} />
          <button
            onClick={saveCourse}
            className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-md text-sm font-medium"
          >
            Guardar
          </button>
          <button
            onClick={handleDeleteCourse}
            disabled={deleting}
            className="px-3 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-md text-sm font-medium flex items-center gap-1"
          >
            <Trash2 className="w-4 h-4" />
            Eliminar
          </button>
        </div>
      </header>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
          Filosofía pedagógica
        </h2>
        <PhilosophySelector
          selectedId={currentCourse.philosophyId}
          onChange={setPhilosophy}
        />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Módulos</h2>
            <button
              onClick={handleAddModule}
              className="px-3 py-1.5 text-xs bg-violet-600 hover:bg-violet-700 text-white rounded-md"
            >
              + Agregar módulo
            </button>
          </div>
          <ModuleList
            modules={currentCourse.modules}
            onRemove={removeModule}
            onUpdate={updateModule}
            onSelect={(id) => setCurrentModule(id === currentModuleId ? null : id)}
            selectedId={currentModuleId}
          />
          {currentModuleId &&
            (() => {
              const selectedModule = currentCourse.modules.find((m) => m.id === currentModuleId);
              return selectedModule ? (
                <ChapterPanel module={selectedModule} onUpdate={updateModule} />
              ) : null;
            })()}
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
            Colaboradores
          </h2>
          <CollaboratorPanel
            collaborators={currentCourse.collaborators}
            onAdd={addCollaborator}
            onRemove={removeCollaborator}
          />
        </section>
      </div>
    </div>
  );
}
