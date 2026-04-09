'use client';

import { useEffect, useState } from 'react';

interface GradeRow {
  id: string;
  user: { id: string; name: string | null; email: string | null };
  score: number;
  maxScore: number;
  feedback: string | null;
  gradedAt: string;
  synced: boolean;
}

export function Gradebook({ lessonId }: { lessonId: string }) {
  const [grades, setGrades] = useState<GradeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/grades/${lessonId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setGrades(data.grades || []);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [lessonId]);

  if (loading) return <div className="p-4 text-sm text-gray-500">Cargando calificaciones...</div>;
  if (error) return <div className="p-4 text-sm text-red-500">{error}</div>;
  if (grades.length === 0)
    return <div className="p-4 text-sm text-gray-500">Sin calificaciones aún.</div>;

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">Estudiante</th>
            <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">Calificación</th>
            <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">Fecha</th>
            <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">Sincronizado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {grades.map((g) => (
            <tr key={g.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
              <td className="px-4 py-2 text-gray-900 dark:text-gray-100">
                {g.user.name || g.user.email || g.user.id}
              </td>
              <td className="px-4 py-2 tabular-nums text-gray-900 dark:text-gray-100">
                {g.score.toFixed(1)} / {g.maxScore.toFixed(1)}
              </td>
              <td className="px-4 py-2 text-gray-500 dark:text-gray-400">
                {new Date(g.gradedAt).toLocaleString()}
              </td>
              <td className="px-4 py-2">
                {g.synced ? (
                  <span className="text-green-600 dark:text-green-400">✓</span>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
