'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ClassroomMeta, CourseChapter } from '@/lib/types/course';
import { ChapterForm } from './chapter-form';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
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
import {
  ChevronUp,
  ChevronDown,
  Pencil,
  Link,
  Unlink,
  Trash2,
  Plus,
  ExternalLink,
  MoreHorizontal,
  Sparkles,
  BookOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface ChapterListProps {
  courseId: string;
  chapters: CourseChapter[];
  classroomMeta: Record<string, ClassroomMeta>;
  readOnly?: boolean;
  onAdd?: (title: string, description: string | null) => Promise<void>;
  onEdit?: (chapterId: string, title: string, description: string | null) => Promise<void>;
  onRemove?: (chapterId: string) => Promise<void>;
  onMove?: (chapterId: string, direction: 'up' | 'down') => Promise<void>;
  onBind?: (chapterId: string) => void;
  onUnbind?: (chapterId: string) => Promise<void>;
  onCreateAndBind?: (chapterId: string) => void;
  onOpenClassroom: (classroomId: string) => void;
}

export function ChapterList({
  courseId: _courseId,
  chapters,
  classroomMeta,
  readOnly = false,
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
  const [removingChapterId, setRemovingChapterId] = useState<string | null>(null);

  const handleAdd = async (title: string, description: string | null) => {
    await onAdd!(title, description);
    setShowAddForm(false);
  };

  const handleEdit = async (chapterId: string, title: string, description: string | null) => {
    await onEdit!(chapterId, title, description);
    setEditingId(null);
  };

  const handleConfirmRemove = async () => {
    if (!removingChapterId) return;
    await onRemove!(removingChapterId);
    setRemovingChapterId(null);
  };

  if (chapters.length === 0 && !showAddForm) {
    return (
      <div className="text-center py-16">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-muted mb-4">
          <BookOpen className="size-7 text-muted-foreground" />
        </div>
        <p className="text-muted-foreground text-sm mb-5">
          {readOnly ? t('course.noChaptersPublic') : t('course.noChapters')}
        </p>
        {!readOnly && (
          <Button onClick={() => setShowAddForm(true)}>
            <Plus />
            {t('course.addChapter')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <AnimatePresence mode="popLayout">
        {chapters.map((chapter, idx) => {
          const meta = chapter.classroomId ? classroomMeta[chapter.classroomId] : undefined;
          const isReady = !!chapter.classroomId && (meta?.ready ?? true);
          const isEditing = editingId === chapter.id;

          return (
            <motion.div
              key={chapter.id}
              layout
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
            >
              <Card className="bg-white/60 dark:bg-slate-900/60 backdrop-blur-sm border-border/40 hover:shadow-md hover:shadow-violet-500/[0.04] transition-all duration-200">
                <CardContent className="py-4">
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
                      <span className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-sm font-medium text-primary">
                        {idx + 1}
                      </span>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-foreground">{chapter.title}</span>
                          <Badge
                            variant="secondary"
                            className={cn(
                              isReady
                                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                                : 'text-muted-foreground',
                            )}
                          >
                            {isReady ? t('course.published') : readOnly ? t('course.comingSoon') : t('course.unpublished')}
                          </Badge>
                        </div>
                        {chapter.description && (
                          <p className="text-sm text-muted-foreground mt-0.5">{chapter.description}</p>
                        )}
                        {chapter.classroomId && meta && (
                          <Button
                            variant="link"
                            size="sm"
                            className="h-auto p-0 mt-1 text-xs"
                            onClick={() => onOpenClassroom(chapter.classroomId!)}
                          >
                            <ExternalLink className="size-3" />
                            {meta.name} · {meta.sceneCount} {t('course.scenes')}
                          </Button>
                        )}
                      </div>

                      {/* Actions — editor only */}
                      {!readOnly && (
                      <div className="flex items-center gap-0.5 flex-shrink-0">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={idx === 0}
                          onClick={() => onMove!(chapter.id, 'up')}
                          title={t('course.moveUp')}
                        >
                          <ChevronUp />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={idx === chapters.length - 1}
                          onClick={() => onMove!(chapter.id, 'down')}
                          title={t('course.moveDown')}
                        >
                          <ChevronDown />
                        </Button>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-xs">
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setEditingId(chapter.id)}>
                              <Pencil />
                              {t('course.editChapter')}
                            </DropdownMenuItem>
                            {chapter.classroomId ? (
                              <>
                                <DropdownMenuItem onClick={() => onOpenClassroom(chapter.classroomId!)}>
                                  <ExternalLink />
                                  {t('course.openClassroom')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onUnbind!(chapter.id)}>
                                  <Unlink />
                                  {t('course.unbindClassroom')}
                                </DropdownMenuItem>
                              </>
                            ) : (
                              <>
                                <DropdownMenuItem onClick={() => onBind!(chapter.id)}>
                                  <Link />
                                  {t('course.bindClassroom')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onCreateAndBind!(chapter.id)}>
                                  <Sparkles />
                                  {t('course.createAndBindClassroom')}
                                </DropdownMenuItem>
                              </>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setRemovingChapterId(chapter.id)}
                            >
                              <Trash2 />
                              {t('course.removeChapter')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </AnimatePresence>

      {/* Add form — editor only */}
      {!readOnly && (
      <AnimatePresence mode="wait">
        {showAddForm ? (
          <motion.div
            key="add-form"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
          >
            <Card className="bg-white/60 dark:bg-slate-900/60 backdrop-blur-sm border-border/40">
              <CardContent className="py-4">
                <ChapterForm onSubmit={handleAdd} onCancel={() => setShowAddForm(false)} />
              </CardContent>
            </Card>
          </motion.div>
        ) : (
          <motion.button
            key="add-btn"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setShowAddForm(true)}
            className="w-full py-3.5 border-2 border-dashed border-border/50 rounded-xl text-sm text-muted-foreground hover:border-primary/40 hover:text-primary hover:bg-primary/5 transition-all duration-200 flex items-center justify-center gap-2"
          >
            <Plus className="size-4" />
            {t('course.addChapter')}
          </motion.button>
        )}
      </AnimatePresence>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!removingChapterId} onOpenChange={(open) => { if (!open) setRemovingChapterId(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('course.confirmDeleteChapterTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('course.confirmRemoveChapter')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('course.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleConfirmRemove}>
              {t('course.removeChapter')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
