'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useCourseStore } from '@/lib/store/course';
import { CourseForm } from '@/components/course/course-form';
import { ChapterList } from '@/components/course/chapter-list';
import { ClassroomPickerDialog } from '@/components/course/classroom-picker-dialog';
import type { ClassroomMeta, CourseChapterContext, CourseFormData } from '@/lib/types/course';
import { COURSE_CHAPTER_CONTEXT_KEY } from '@/lib/types/course';

export default function CourseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { t } = useI18n();
  const router = useRouter();
  const { currentCourse, fetchCourse, updateCourse, addChapter, updateChapter, removeChapter, reorderChapters } =
    useCourseStore();
  const [editing, setEditing] = useState(false);
  const [courseId, setCourseId] = useState<string | null>(null);
  const [classroomMeta, setClassroomMeta] = useState<Record<string, ClassroomMeta>>({});
  const [bindingChapterId, setBindingChapterId] = useState<string | null>(null);

  useEffect(() => {
    params.then(({ id }) => {
      setCourseId(id);
      fetchCourse(id);
    });
  }, [params, fetchCourse]);

  // Stable dep: comma-joined sorted classroomIds — only refetch when bound classrooms change
  const boundClassroomIdsKey = currentCourse?.chapters
    .map((c) => c.classroomId)
    .filter((id): id is string => !!id)
    .sort()
    .join(',') ?? '';

  const loadClassroomMeta = useCallback(async (classroomIds: string[]) => {
    try {
      // Single batch fetch instead of N per-classroom requests
      const res = await fetch('/api/classroom');
      if (!res.ok) return;
      const { classrooms } = await res.json() as { classrooms: Array<{ id: string; name?: string; sceneCount: number }> };
      const idSet = new Set(classroomIds);
      setClassroomMeta(
        Object.fromEntries(
          classrooms
            .filter((c) => idSet.has(c.id))
            .map((c): [string, ClassroomMeta] => [
              c.id,
              { name: c.name || c.id, sceneCount: c.sceneCount ?? 0, published: true },
            ]),
        ),
      );
    } catch {
      // non-fatal, metadata stays empty
    }
  }, []);

  useEffect(() => {
    const ids = boundClassroomIdsKey ? boundClassroomIdsKey.split(',') : [];
    if (ids.length > 0) loadClassroomMeta(ids);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundClassroomIdsKey, loadClassroomMeta]);

  // Stable set for dialog — only recomputes when bound IDs change
  const usedClassroomIds = useMemo(
    () => new Set(currentCourse?.chapters.map((c) => c.classroomId).filter((id): id is string => !!id) ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boundClassroomIdsKey],
  );

  if (!courseId || !currentCourse) return <div className="p-8">{t('common.loading')}</div>;

  const handleUpdate = async (data: CourseFormData) => {
    await updateCourse(courseId, data);
    setEditing(false);
  };

  const handleMove = async (chapterId: string, direction: 'up' | 'down') => {
    const chapters = currentCourse.chapters;
    const idx = chapters.findIndex((c) => c.id === chapterId);
    if (idx === -1) return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= chapters.length) return;
    const ids = chapters.map((c) => c.id);
    [ids[idx], ids[newIdx]] = [ids[newIdx], ids[idx]];
    await reorderChapters(courseId, ids);
  };

  const handleUnbind = async (chapterId: string) => {
    await updateChapter(courseId, chapterId, { classroomId: null });
  };

  const handleBind = (chapterId: string) => {
    setBindingChapterId(chapterId);
  };

  const handlePickerSelect = async (classroomId: string) => {
    if (!bindingChapterId) return;
    await updateChapter(courseId, bindingChapterId, { classroomId });
    setBindingChapterId(null);
  };

  const handleCreateAndBind = (chapterId: string) => {
    sessionStorage.setItem(
      COURSE_CHAPTER_CONTEXT_KEY,
      JSON.stringify({ courseId, chapterId, stageId: null, createdAt: Date.now() } satisfies CourseChapterContext),
    );
    router.push('/');
  };

  const handleOpenClassroom = (classroomId: string) => {
    router.push(`/classroom/${classroomId}`);
  };

  if (editing) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <h1 className="text-2xl mb-4">{t('course.edit')}</h1>
        <CourseForm initialData={currentCourse} onSubmit={handleUpdate} onCancel={() => setEditing(false)} />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <button onClick={() => router.push('/course')} className="text-sm text-gray-500 hover:text-gray-700 mb-2 block">
            ← {t('course.myCourses')}
          </button>
          <h1 className="text-2xl">{currentCourse.name}</h1>
        </div>
        <button onClick={() => setEditing(true)} className="px-4 py-2 border rounded">
          {t('course.edit')}
        </button>
      </div>

      <div className="mb-8 space-y-1.5 text-sm">
        <p>
          <span className="text-gray-500">{t('course.college')}:</span> {currentCourse.college}
        </p>
        <p>
          <span className="text-gray-500">{t('course.major')}:</span> {currentCourse.major}
        </p>
        <p>
          <span className="text-gray-500">{t('course.teacherName')}:</span> {currentCourse.teacherName}
        </p>
        <p>
          <span className="text-gray-500">{t('course.description')}:</span> {currentCourse.description}
        </p>
      </div>

      <div>
        <h2 className="text-lg font-medium mb-3">
          {t('course.chapter')} ({currentCourse.chapters.length})
        </h2>
        <ChapterList
          courseId={courseId}
          chapters={currentCourse.chapters}
          classroomMeta={classroomMeta}
          onAdd={(title, description) => addChapter(courseId, title, description)}
          onEdit={(chapterId, title, description) => updateChapter(courseId, chapterId, { title, description })}
          onRemove={(chapterId) => removeChapter(courseId, chapterId)}
          onMove={handleMove}
          onBind={handleBind}
          onUnbind={handleUnbind}
          onCreateAndBind={handleCreateAndBind}
          onOpenClassroom={handleOpenClassroom}
        />
      </div>

      {bindingChapterId && (
        <ClassroomPickerDialog
          usedClassroomIds={usedClassroomIds}
          onSelect={handlePickerSelect}
          onClose={() => setBindingChapterId(null)}
        />
      )}
    </div>
  );
}
