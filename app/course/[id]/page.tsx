'use client';

import { useEffect, useState, useCallback, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'motion/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useCourseStore } from '@/lib/store/course';
import { CourseForm } from '@/components/course/course-form';
import { ChapterList } from '@/components/course/chapter-list';
import { ClassroomPickerDialog } from '@/components/course/classroom-picker-dialog';
import type { ClassroomMeta, CourseChapterContext, CourseFormData } from '@/lib/types/course';
import { COURSE_CHAPTER_CONTEXT_KEY } from '@/lib/types/course';
import { Card, CardHeader, CardTitle, CardContent, CardAction } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ArrowLeft, Pencil, BookOpen, Building2, GraduationCap, User, Globe, GlobeLock } from 'lucide-react';
import { toast } from 'sonner';

type PublishDialogMode = 'publish' | 'unpublish' | null;

function CourseDetailContent({ params }: { params: Promise<{ id: string }> }) {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isViewMode = searchParams.get('mode') === 'view';
  const { currentCourse, fetchCourse, updateCourse, addChapter, updateChapter, removeChapter, reorderChapters, publishCourse, unpublishCourse } =
    useCourseStore();
  const [editing, setEditing] = useState(false);
  const [courseId, setCourseId] = useState<string | null>(null);
  const [classroomMeta, setClassroomMeta] = useState<Record<string, ClassroomMeta>>({});
  const [bindingChapterId, setBindingChapterId] = useState<string | null>(null);
  const [publishDialog, setPublishDialog] = useState<PublishDialogMode>(null);

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
              { name: c.name || c.id, sceneCount: c.sceneCount ?? 0, ready: true },
            ]),
        ),
      );
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    const ids = boundClassroomIdsKey ? boundClassroomIdsKey.split(',') : [];
    if (ids.length > 0) loadClassroomMeta(ids);
  }, [boundClassroomIdsKey, loadClassroomMeta]);

  const usedClassroomIds = useMemo(
    () => isViewMode ? new Set<string>() : new Set(currentCourse?.chapters.map((c) => c.classroomId).filter((id): id is string => !!id) ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isViewMode, boundClassroomIdsKey],
  );

  if (!courseId || !currentCourse) {
    return (
      <div className="min-h-[100dvh] bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
        <div className="max-w-3xl mx-auto space-y-4 pt-8">
          <div className="h-8 w-32 rounded-lg bg-muted animate-pulse" />
          <div className="h-10 w-64 rounded-lg bg-muted animate-pulse" />
          <div className="h-40 rounded-xl bg-muted animate-pulse" />
          <div className="h-64 rounded-xl bg-muted animate-pulse" />
        </div>
      </div>
    );
  }

  const canPublish =
    currentCourse.chapters.length > 0 &&
    currentCourse.chapters.some((ch) => !!ch.classroomId);
  const boundCount = currentCourse.chapters.filter((ch) => !!ch.classroomId).length;
  const totalCount = currentCourse.chapters.length;
  const isPublished = currentCourse.status === 'published';

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

  const handlePublishConfirm = async () => {
    if (!courseId) return;
    try {
      if (publishDialog === 'publish') {
        await publishCourse(courseId);
        toast.success(t('course.publishSuccess'));
      } else if (publishDialog === 'unpublish') {
        await unpublishCourse(courseId);
        toast.success(t('course.unpublishSuccess'));
      }
    } catch {
      toast.error(publishDialog === 'publish' ? t('course.publishFailed') : t('course.unpublishFailed'));
    }
    setPublishDialog(null);
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

  return (
    <div className="relative min-h-[100dvh] bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      {/* Decorative blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-80 h-80 bg-purple-500/8 rounded-full blur-3xl" />
        <div className="absolute bottom-1/3 right-1/4 w-80 h-80 bg-violet-500/8 rounded-full blur-3xl" />
      </div>

      <div className="relative max-w-3xl mx-auto">
        {/* Back nav */}
        <motion.div
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-6"
        >
          <Button variant="ghost" size="sm" onClick={() => router.push(isViewMode ? '/' : '/course')}>
            <ArrowLeft />
            {isViewMode ? t('course.backToHome') : t('course.backToCourses')}
          </Button>
        </motion.div>

        {/* Course info card */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-6"
        >
          <Card className="bg-white/60 dark:bg-slate-900/60 backdrop-blur-sm border-border/40">
            <CardHeader>
              <CardTitle className="text-xl">{currentCourse.name}</CardTitle>
              <CardAction>
                <div className="flex items-center gap-2">
                  {(isViewMode || isPublished) && (
                    <Badge variant="secondary" className="gap-1 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40">
                      <Globe className="size-3" />
                      {t('course.publishedStatus')}
                    </Badge>
                  )}
                  {!isViewMode && (
                    <>
                      {isPublished ? (
                        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => setPublishDialog('unpublish')}>
                          <GlobeLock className="size-4" />
                          {t('course.unpublish')}
                        </Button>
                      ) : canPublish ? (
                        <Button variant="default" size="sm" onClick={() => setPublishDialog('publish')}>
                          <Globe className="size-4" />
                          {t('course.publish')}
                        </Button>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span tabIndex={0}>
                              <Button variant="outline" size="sm" disabled>
                                <Globe className="size-4" />
                                {t('course.publish')}
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{t('course.cannotPublish')}</TooltipContent>
                        </Tooltip>
                      )}
                      <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                        <Pencil />
                        {t('course.edit')}
                      </Button>
                    </>
                  )}
                </div>
              </CardAction>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div className="flex items-start gap-2">
                  <Building2 className="size-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
                      {t('course.college')}
                    </p>
                    <p className="text-foreground">{currentCourse.college}</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <GraduationCap className="size-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
                      {t('course.major')}
                    </p>
                    <p className="text-foreground">{currentCourse.major}</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <User className="size-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
                      {t('course.teacherName')}
                    </p>
                    <p className="text-foreground">{currentCourse.teacherName}</p>
                  </div>
                </div>
                {currentCourse.description && (
                  <div className="sm:col-span-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
                      {t('course.description')}
                    </p>
                    <p className="text-muted-foreground">{currentCourse.description}</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Chapters section */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12, duration: 0.4 }}
        >
          <Separator className="mb-6" />
          <div className="flex items-center gap-2 mb-4">
            <BookOpen className="size-4 text-muted-foreground" />
            <h2 className="text-base font-medium text-foreground">{t('course.chapters')}</h2>
            <Badge variant="secondary" className="ml-1">
              {currentCourse.chapters.length}
            </Badge>
            {!isViewMode && totalCount > 0 && (
              <Badge
                variant="outline"
                className={`ml-auto text-xs ${boundCount === totalCount ? 'text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800' : 'text-muted-foreground'}`}
              >
                {boundCount}/{totalCount} {t('course.chaptersReady')}
              </Badge>
            )}
          </div>

          <ChapterList
            courseId={courseId}
            chapters={currentCourse.chapters}
            classroomMeta={classroomMeta}
            readOnly={isViewMode}
            onOpenClassroom={handleOpenClassroom}
            {...(!isViewMode && {
              onAdd: (title, description) => addChapter(courseId, title, description),
              onEdit: (chapterId, title, description) => updateChapter(courseId, chapterId, { title, description }),
              onRemove: (chapterId) => removeChapter(courseId, chapterId),
              onMove: handleMove,
              onBind: handleBind,
              onUnbind: handleUnbind,
              onCreateAndBind: handleCreateAndBind,
            })}
          />
        </motion.div>
      </div>

      {!isViewMode && (
        <>
          {/* Edit course dialog */}
          <Dialog open={editing} onOpenChange={(open) => { if (!open) setEditing(false); }}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>{t('course.edit')}</DialogTitle>
              </DialogHeader>
              <CourseForm initialData={currentCourse} onSubmit={handleUpdate} onCancel={() => setEditing(false)} />
            </DialogContent>
          </Dialog>

          {/* Classroom picker dialog */}
          {bindingChapterId && (
            <ClassroomPickerDialog
              usedClassroomIds={usedClassroomIds}
              onSelect={handlePickerSelect}
              onClose={() => setBindingChapterId(null)}
            />
          )}

          {/* Publish / Unpublish confirmation dialog */}
          <AlertDialog open={publishDialog !== null} onOpenChange={(open) => { if (!open) setPublishDialog(null); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {publishDialog === 'publish' ? t('course.publish') : t('course.unpublish')}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {publishDialog === 'publish' ? t('course.confirmPublish') : t('course.confirmUnpublish')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('course.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={handlePublishConfirm}>
                  {publishDialog === 'publish' ? t('course.publish') : t('course.unpublish')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}

export default function CourseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense>
      <CourseDetailContent params={params} />
    </Suspense>
  );
}
