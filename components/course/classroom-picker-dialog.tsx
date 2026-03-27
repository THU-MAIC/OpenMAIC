'use client';

import { useEffect, useState } from 'react';

interface PublishedClassroom {
  id: string;
  name: string;
  sceneCount: number;
}

interface ClassroomPickerDialogProps {
  /** Chapter IDs already bound in the course — exclude from picker */
  usedClassroomIds: Set<string>;
  onSelect: (classroomId: string) => Promise<void>;
  onClose: () => void;
}

export function ClassroomPickerDialog({ usedClassroomIds, onSelect, onClose }: ClassroomPickerDialogProps) {
  const [classrooms, setClassrooms] = useState<PublishedClassroom[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch('/api/classroom')
      .then((r) => r.json())
      .then(({ classrooms }: { classrooms: Array<{ id: string; name?: string; sceneCount: number }> }) => {
        const items: PublishedClassroom[] = classrooms
          .filter((c) => !usedClassroomIds.has(c.id))
          .map((c) => ({
            id: c.id,
            name: c.name || c.id,
            sceneCount: c.sceneCount ?? 0,
          }));
        setClassrooms(items);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [usedClassroomIds]);

  const handleSelect = async (id: string) => {
    setSubmitting(true);
    try {
      await onSelect(id);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md max-h-[70vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="text-base font-semibold">选择已发布课堂</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">
            ×
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-3 py-2">
          {loading ? (
            <p className="text-center text-gray-500 py-8 text-sm">加载中…</p>
          ) : classrooms.length === 0 ? (
            <p className="text-center text-gray-500 py-8 text-sm">暂无可绑定的已发布课堂</p>
          ) : (
            <ul className="space-y-1.5">
              {classrooms.map((c) => (
                <li key={c.id}>
                  <button
                    disabled={submitting}
                    onClick={() => handleSelect(c.id)}
                    className="w-full text-left px-4 py-3 rounded-lg border hover:border-blue-400 hover:bg-blue-50 transition-colors disabled:opacity-50"
                  >
                    <div className="font-medium text-sm">{c.name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{c.sceneCount} 个场景</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
