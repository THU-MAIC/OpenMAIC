'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Loader2, ArrowUp, ArrowDown, GripVertical, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';

interface SceneItem {
  id: string;
  order: number;
  title: string;
  type: string;
}

interface ClassroomPayload {
  classroom: {
    id: string;
    scenes: SceneItem[];
  };
}

interface CreateScenePayload {
  scene?: {
    id: string;
  };
  error?: string;
}

export default function InstructorContentPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const classroomId = params.id;
  const { t } = useI18n();

  const [scenes, setScenes] = useState<SceneItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingOrder, setSavingOrder] = useState(false);
  const [creatingInCanvas, setCreatingInCanvas] = useState(false);

  // Delete state
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchClassroom = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`);
      if (!res.ok) throw new Error('Failed to load classroom content');
      const data = (await res.json()) as ClassroomPayload;
      const sorted = [...(data.classroom.scenes ?? [])].sort((a, b) => a.order - b.order);
      setScenes(sorted);
    } catch {
      toast.error(t('instructorClassroomContent.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [classroomId]);

  useEffect(() => {
    void fetchClassroom();
  }, [fetchClassroom]);

  const saveOrder = async (nextScenes: SceneItem[]) => {
    setSavingOrder(true);
    try {
      const res = await fetch('/api/classroom/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          classroomId,
          sceneOrder: nextScenes.map((s) => s.id),
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(payload.error ?? t('instructorClassroomContent.orderFailed'));
        await fetchClassroom();
        return;
      }
      toast.success(t('instructorClassroomContent.orderUpdated'));
    } finally {
      setSavingOrder(false);
    }
  };

  const moveScene = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= scenes.length) return;

    const next = [...scenes];
    const temp = next[index];
    next[index] = next[targetIndex];
    next[targetIndex] = temp;

    const normalized = next.map((s, i) => ({ ...s, order: i + 1 }));
    setScenes(normalized);
    void saveOrder(normalized);
  };

  const deleteScene = async (sceneId: string) => {
    setDeletingId(sceneId);
    try {
      const res = await fetch('/api/classroom/scene', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classroomId, sceneId }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(payload.error ?? t('instructorClassroomContent.deleteFailed'));
        return;
      }
      toast.success(t('instructorClassroomContent.deleted'));
      await fetchClassroom();
    } finally {
      setDeletingId(null);
    }
  };

  const addSceneInCanvas = async () => {
    setCreatingInCanvas(true);
    try {
      const defaultTitle = `New Scene ${scenes.length + 1}`;
      const res = await fetch('/api/classroom/scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classroomId, title: defaultTitle, type: 'slide' }),
      });

      const payload = (await res.json().catch(() => ({}))) as CreateScenePayload;
      if (!res.ok || !payload.scene?.id) {
        toast.error(payload.error ?? t('instructorClassroomContent.createFailed'));
        return;
      }

      router.push(
        `/classroom/${classroomId}?scene=${encodeURIComponent(payload.scene.id)}&newScenePrompt=1&from=content`,
      );
    } finally {
      setCreatingInCanvas(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">
          {t('instructorClassroomContent.title')} <span className="text-slate-400 text-sm">({scenes.length} {t('instructorClassroomContent.scenesCount')})</span>
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void addSceneInCanvas();
            }}
            disabled={creatingInCanvas}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500 transition-colors"
          >
            {creatingInCanvas ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            {t('instructorClassroomContent.addScene')}
          </button>
        </div>
      </div>

      {savingOrder && (
        <div className="flex items-center gap-2 text-xs text-indigo-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('instructorClassroomContent.savingOrder')}
        </div>
      )}

      {scenes.length === 0 ? (
        <p className="text-sm text-slate-500 py-10 text-center rounded-xl border border-white/10 bg-white/5">
          {t('instructorClassroomContent.noScenes')}
        </p>
      ) : (
        <ul className="space-y-2">
          {scenes.map((scene, idx) => (
            <li
              key={scene.id}
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 flex items-center gap-3"
            >
              <GripVertical className="w-4 h-4 text-slate-500" />
              <span className="w-7 text-center rounded bg-white/8 px-1.5 py-0.5 text-xs text-slate-400">
                {scene.order}
              </span>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{scene.title || t('instructorClassroomContent.untitled')}</p>
                <p className="text-xs text-slate-500">{scene.type}</p>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => moveScene(idx, -1)}
                  disabled={idx === 0 || savingOrder}
                  className="rounded border border-white/10 p-1 text-slate-400 hover:text-white disabled:opacity-40 transition-colors"
                  aria-label={t('instructorClassroomContent.moveUp')}
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => moveScene(idx, 1)}
                  disabled={idx === scenes.length - 1 || savingOrder}
                  className="rounded border border-white/10 p-1 text-slate-400 hover:text-white disabled:opacity-40 transition-colors"
                  aria-label={t('instructorClassroomContent.moveDown')}
                >
                  <ArrowDown className="w-3.5 h-3.5" />
                </button>

                <Link
                  href={`/classroom/${classroomId}?scene=${encodeURIComponent(scene.id)}&from=content`}
                  className="rounded border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/10 hover:text-white transition-colors"
                >
                  {t('instructorClassroomContent.edit')}
                </Link>

                <button
                  type="button"
                  onClick={() => void deleteScene(scene.id)}
                  disabled={deletingId === scene.id || savingOrder}
                  className="rounded border border-white/10 p-1 text-slate-500 hover:text-red-400 hover:border-red-400/30 disabled:opacity-40 transition-colors"
                  aria-label={t('instructorClassroomContent.deleteScene')}>
                  {deletingId === scene.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
