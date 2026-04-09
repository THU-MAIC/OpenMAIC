'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { BUILT_IN_PHILOSOPHIES } from '@/lib/course/philosophies';
import type { CompleteCourse } from '@/lib/types/course';
import { UserNav } from '@/components/auth/user-nav';

export default function CoursesPage() {
  const router = useRouter();
  const [courses, setCourses] = useState<CompleteCourse[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [philosophyId, setPhilosophyId] = useState(BUILT_IN_PHILOSOPHIES[0].id);

  useEffect(() => {
    fetch('/api/courses')
      .then((r) => r.json())
      .then((data) => setCourses(data.courses || []))
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = async (courseId: string, courseTitle: string) => {
    if (!confirm(`¿Eliminar el curso "${courseTitle}"? Esta acción no se puede deshacer.`)) return;
    const res = await fetch(`/api/courses/${courseId}`, { method: 'DELETE' });
    if (res.ok) {
      setCourses((prev) => prev.filter((c) => c.id !== courseId));
    } else {
      alert('No se pudo eliminar el curso.');
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, philosophyId, language: 'es-MX' }),
    });
    if (res.ok) {
      const data = await res.json();
      router.push(`/courses/${data.course.id}`);
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6">
      <header className="flex items-center justify-between mb-6 gap-4">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Cursos completos</h1>
        <div className="flex items-center gap-4">
          <UserNav />
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-md text-sm font-medium"
          >
            {showCreate ? 'Cancelar' : '+ Nuevo curso'}
          </button>
        </div>
      </header>

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="mb-8 p-6 bg-white dark:bg-gray-800 rounded-xl shadow-sm space-y-4"
        >
          <div>
            <label className="block text-sm font-medium mb-1">Título</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Descripción</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900"
              rows={2}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Filosofía pedagógica</label>
            <select
              value={philosophyId}
              onChange={(e) => setPhilosophyId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900"
            >
              {BUILT_IN_PHILOSOPHIES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.description}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-md text-sm font-medium"
          >
            Crear curso
          </button>
        </form>
      )}

      {loading ? (
        <div className="text-gray-500">Cargando...</div>
      ) : courses.length === 0 ? (
        <div className="p-12 text-center text-gray-500 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl">
          Sin cursos todavía. Crea el primero.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {courses.map((c) => (
            <div
              key={c.id}
              className="relative group p-5 bg-white dark:bg-gray-800 rounded-xl shadow-sm hover:shadow-md transition-shadow"
            >
              <button
                type="button"
                onClick={() => handleDelete(c.id, c.title)}
                className="absolute top-2 right-2 p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label="Eliminar curso"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <Link href={`/courses/${c.id}`} className="block pr-6">
                <h3 className="font-semibold text-gray-900 dark:text-gray-100 mb-1">{c.title}</h3>
                {c.description && (
                  <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                    {c.description}
                  </p>
                )}
                <div className="mt-3 flex items-center gap-2 text-xs text-gray-500">
                  <span>{c.modules.length} módulos</span>
                  <span>·</span>
                  <span>{c.collaborators.length} colaboradores</span>
                </div>
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
