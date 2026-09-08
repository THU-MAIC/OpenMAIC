'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  Database,
  FilePenLine,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/hooks/use-i18n';
import { getTeacherCopy, type TeacherCopy } from '@/lib/i18n/teacher';
import type { TeacherStudent } from '@/lib/teacher/students';
import type { ObservedField } from '@/lib/zhongkao/observed-field';
import { cn } from '@/lib/utils';
import { StudentEditor } from './StudentEditor';
import { TeacherIdentityDialog } from './TeacherIdentityDialog';
import { StudentAnalyses } from './StudentAnalyses';
import {
  createStudentDraft,
  filterStudents,
  studentDraftPayload,
  teacherRequest,
  TeacherRequestError,
} from './student-ui';

function IconAction({
  label,
  children,
  onClick,
  disabled,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ProfileField<T>({
  label,
  field,
  copy,
  format = String,
}: {
  label: string;
  field: ObservedField<T>;
  copy: TeacherCopy;
  format?: (value: T) => string;
}) {
  return (
    <div className="min-w-0 py-4">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="break-words [overflow-wrap:anywhere]">
          {field.value === null ? copy.unknown : format(field.value)}
        </span>
        {field.status !== 'unknown' && (
          <span
            className={cn(
              'text-xs',
              field.status === 'inferred'
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-muted-foreground',
            )}
          >
            {copy[field.status]}
          </span>
        )}
      </dd>
    </div>
  );
}

export function StudentProfilePanel({
  student,
  copy,
  locale,
  onEdit,
  onArchive,
  busy,
}: {
  student: TeacherStudent;
  copy: TeacherCopy;
  locale: string;
  onEdit: () => void;
  onArchive: () => void;
  busy: boolean;
}) {
  const { profile } = student;
  const textbooks = Object.entries(profile.textbookVersions);
  const dateFormat = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return (
    <article className="min-w-0 px-4 py-6 sm:px-7 lg:px-9" aria-label={copy.profile}>
      <div className="flex min-w-0 items-start justify-between gap-3 border-b pb-5">
        <div className="min-w-0">
          <p className="text-muted-foreground mb-2 text-xs">{copy.profile}</p>
          <h2 className="break-words text-xl font-semibold [overflow-wrap:anywhere]">
            {profile.displayName.value ?? copy.unknown}
          </h2>
          <p className="text-muted-foreground mt-2 text-xs">
            {student.archived ? copy.archived : copy.active}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <IconAction label={copy.editStudent} onClick={onEdit} disabled={busy}>
            <FilePenLine />
          </IconAction>
          <IconAction
            label={student.archived ? copy.restore : copy.archive}
            onClick={onArchive}
            disabled={busy}
          >
            {busy ? (
              <LoaderCircle className="animate-spin" />
            ) : student.archived ? (
              <ArchiveRestore />
            ) : (
              <Archive />
            )}
          </IconAction>
        </div>
      </div>
      <section className="py-6" aria-label={copy.basicInfo}>
        <h3 className="text-sm font-semibold">{copy.basicInfo}</h3>
        <dl className="grid grid-cols-1 divide-y sm:grid-cols-2 sm:gap-x-8">
          <ProfileField
            label={copy.grade}
            field={profile.grade}
            copy={copy}
            format={copy.gradeValue}
          />
          <ProfileField label={copy.examYear} field={profile.examYear} copy={copy} />
          <ProfileField label={copy.region} field={profile.region} copy={copy} />
        </dl>
      </section>
      <StudentAnalyses
        profileId={profile.profileId}
        nickname={profile.displayName.value ?? copy.unknown}
        locale={locale}
        archived={student.archived}
      />
      <section className="border-t py-6" aria-label={copy.textbooks}>
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h3 className="text-sm font-semibold">{copy.textbooks}</h3>
          {!textbooks.some(([, value]) => value.status === 'confirmed') && (
            <span className="text-muted-foreground text-xs">{copy.generic}</span>
          )}
        </div>
        {textbooks.length ? (
          <dl className="divide-y">
            {textbooks.map(([subject, field]) => (
              <ProfileField
                key={subject}
                label={subject}
                field={field}
                copy={copy}
                format={(value) =>
                  [value.publisher, value.title, value.volume].filter(Boolean).join(' · ')
                }
              />
            ))}
          </dl>
        ) : (
          <p className="text-muted-foreground text-sm">{copy.unknown}</p>
        )}
      </section>
      <section className="border-t py-6" aria-label={copy.exploration}>
        <h3 className="text-sm font-semibold">{copy.exploration}</h3>
        <div className="mt-4 border-l-2 border-emerald-600 pl-4 dark:border-emerald-400">
          <p className="text-sm">{copy.awaitingEvidence}</p>
          <p className="text-muted-foreground mt-2 text-sm leading-6">{copy.evidenceNeeded}</p>
        </div>
      </section>
      <dl className="text-muted-foreground flex flex-wrap gap-x-8 gap-y-3 border-t pt-5 text-xs">
        <div>
          <dt className="mb-1">{copy.created}</dt>
          <dd>{dateFormat.format(new Date(profile.createdAt))}</dd>
        </div>
        <div>
          <dt className="mb-1">{copy.updated}</dt>
          <dd>{dateFormat.format(new Date(profile.updatedAt))}</dd>
        </div>
      </dl>
    </article>
  );
}

export function TeacherWorkbench({
  configured,
  lessonPrepHref,
}: {
  configured: boolean;
  lessonPrepHref: string;
}) {
  const { locale } = useI18n();
  const copy = getTeacherCopy(locale);
  const [students, setStudents] = useState<TeacherStudent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(configured);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{ student?: TeacherStudent } | null>(null);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<TeacherStudent | null>(null);
  const loadSequence = useRef(0);
  const visibleStudents = filterStudents(students, archived, search);
  const selected =
    visibleStudents.find((student) => student.profile.profileId === selectedId) ??
    visibleStudents[0];

  const refreshStudents = useCallback(
    async (signal?: AbortSignal) => {
      const sequence = ++loadSequence.current;
      setLoading(true);
      setLoadError('');
      try {
        const response = await teacherRequest<{ students: TeacherStudent[] }>(
          '/api/teacher/students',
          { signal },
        );
        if (sequence === loadSequence.current && !signal?.aborted) setStudents(response.students);
        return response.students;
      } catch (failure) {
        if (sequence === loadSequence.current && !signal?.aborted) setLoadError(copy.loadFailed);
        throw failure;
      } finally {
        if (sequence === loadSequence.current && !signal?.aborted) setLoading(false);
      }
    },
    [copy.loadFailed],
  );

  useEffect(() => {
    const controller = new AbortController();
    if (configured) void refreshStudents(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [configured, refreshStudents]);

  function acceptStudent(student: TeacherStudent) {
    loadSequence.current++;
    setLoading(false);
    setStudents((current) => [
      student,
      ...current.filter((item) => item.profile.profileId !== student.profile.profileId),
    ]);
    setSelectedId(student.profile.profileId);
    setArchived(student.archived);
    setSearch('');
    setEditor(null);
    setActionError('');
  }

  async function changeArchived(student: TeacherStudent) {
    setBusy(true);
    setActionError('');
    try {
      const response = await teacherRequest<{ student: TeacherStudent }>(
        `/api/teacher/students/${encodeURIComponent(student.profile.profileId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            ...studentDraftPayload(createStudentDraft(student)),
            archived: !student.archived,
            expectedUpdatedAt: student.profile.updatedAt,
          }),
        },
      );
      setStudents((current) =>
        current.map((item) =>
          item.profile.profileId === student.profile.profileId ? response.student : item,
        ),
      );
      setSelectedId(null);
      setArchiveTarget(null);
    } catch (failure) {
      setArchiveTarget(null);
      setActionError(
        failure instanceof TeacherRequestError && failure.status === 409
          ? copy.conflict
          : copy.failed,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="bg-background min-h-[calc(100dvh-4rem)] min-w-0 [letter-spacing:0]">
      <header className="border-b">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" aria-label={copy.originalHome} className="shrink-0">
              <Image src="/openmaic-mark.png" width={32} height={32} alt="OpenMAIC" />
            </Link>
            <h1 className="min-w-0 break-words text-lg font-semibold sm:text-xl">{copy.title}</h1>
          </div>
          <nav className="flex flex-wrap items-center gap-2" aria-label={copy.title}>
            <Button asChild variant="outline">
              <Link href={lessonPrepHref}>
                <BookOpen />
                {copy.lessonPrep}
              </Link>
            </Button>
            {configured && (
              <IconAction label={copy.identity} onClick={() => setIdentityOpen(true)}>
                <KeyRound />
              </IconAction>
            )}
          </nav>
        </div>
      </header>
      {!configured ? (
        <section className="mx-auto max-w-3xl px-5 py-16">
          <Database className="text-muted-foreground mb-5 size-8" />
          <h2 className="text-lg font-semibold">{copy.storageTitle}</h2>
          <p className="text-muted-foreground mt-3 text-sm leading-6">{copy.storageDescription}</p>
          <Button variant="outline" className="mt-6" onClick={() => window.location.reload()}>
            <RefreshCw />
            {copy.checkConfiguration}
          </Button>
        </section>
      ) : (
        <div className="mx-auto grid max-w-7xl min-w-0 md:grid-cols-[300px_minmax(0,1fr)] lg:grid-cols-[340px_minmax(0,1fr)]">
          <aside
            className="min-w-0 border-b md:min-h-[calc(100dvh-10rem)] md:border-r md:border-b-0"
            aria-label={copy.students}
          >
            <div className="space-y-4 px-4 pt-5 pb-4 sm:px-6">
              <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <UsersRound className="size-4" />
                  {copy.students}
                  <span className="text-muted-foreground font-normal">
                    {students.filter((student) => student.archived === archived).length}
                  </span>
                </h2>
                <div className="flex shrink-0 gap-1">
                  <IconAction
                    label={copy.refresh}
                    disabled={loading || busy}
                    onClick={() => {
                      setActionError('');
                      void refreshStudents().catch(() => {});
                    }}
                  >
                    <RefreshCw className={loading ? 'animate-spin' : undefined} />
                  </IconAction>
                  <IconAction
                    label={copy.addStudent}
                    disabled={loading || busy || Boolean(loadError)}
                    onClick={() => setEditor({})}
                  >
                    <Plus />
                  </IconAction>
                </div>
              </div>
              <div className="flex border-b" role="group" aria-label={copy.students}>
                {[false, true].map((value) => (
                  <button
                    key={String(value)}
                    type="button"
                    aria-pressed={archived === value}
                    className={cn(
                      'min-h-9 flex-1 border-b-2 px-2 text-sm transition-colors',
                      archived === value
                        ? 'border-emerald-600 font-medium text-foreground dark:border-emerald-400'
                        : 'text-muted-foreground border-transparent hover:text-foreground',
                    )}
                    onClick={() => {
                      setArchived(value);
                      setSelectedId(null);
                    }}
                  >
                    {value ? copy.archived : copy.active}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search className="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4" />
                <Input
                  type="search"
                  aria-label={copy.search}
                  placeholder={copy.search}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="pl-9"
                />
              </div>
            </div>
            {loadError ? (
              <div className="space-y-3 px-6 py-5">
                <p role="alert" className="text-destructive text-sm">
                  {loadError}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void refreshStudents().catch(() => {})}
                >
                  <RefreshCw />
                  {copy.retry}
                </Button>
              </div>
            ) : loading && !students.length ? (
              <p
                role="status"
                className="text-muted-foreground flex items-center gap-2 px-6 py-8 text-sm"
              >
                <LoaderCircle className="size-4 animate-spin" />
                {copy.loading}
              </p>
            ) : visibleStudents.length ? (
              <ul className="max-h-72 overflow-y-auto pb-3 md:max-h-[calc(100dvh-17rem)]">
                {visibleStudents.map((student) => (
                  <li key={student.profile.profileId}>
                    <button
                      type="button"
                      aria-pressed={selected?.profile.profileId === student.profile.profileId}
                      className={cn(
                        'flex w-full min-w-0 items-center gap-3 border-l-2 px-4 py-4 text-left transition-colors sm:px-6',
                        selected?.profile.profileId === student.profile.profileId
                          ? 'border-emerald-600 bg-muted dark:border-emerald-400'
                          : 'border-transparent hover:bg-muted/60',
                      )}
                      onClick={() => setSelectedId(student.profile.profileId)}
                    >
                      <span className="bg-background text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md border">
                        <UserRound className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-sm font-medium [overflow-wrap:anywhere]">
                          {student.profile.displayName.value ?? copy.unknown}
                        </span>
                        <span className="text-muted-foreground mt-1 block text-xs">
                          {student.profile.grade.value === null
                            ? copy.unknown
                            : copy.gradeValue(student.profile.grade.value)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="px-6 py-8">
                <p className="text-muted-foreground text-sm">
                  {search ? copy.noResults : archived ? copy.noArchived : copy.empty}
                </p>
                {!search && !archived && (
                  <Button variant="outline" className="mt-4" onClick={() => setEditor({})}>
                    <Plus />
                    {copy.addStudent}
                  </Button>
                )}
              </div>
            )}
          </aside>
          <div className="min-w-0">
            {actionError && (
              <div className="flex flex-wrap items-center gap-3 border-b px-4 py-4 sm:px-7">
                <p role="alert" className="text-destructive min-w-0 flex-1 text-sm">
                  {actionError}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading}
                  onClick={() => {
                    setActionError('');
                    void refreshStudents().catch(() => {});
                  }}
                >
                  <RefreshCw />
                  {copy.refresh}
                </Button>
              </div>
            )}
            {selected ? (
              <StudentProfilePanel
                student={selected}
                copy={copy}
                locale={locale}
                busy={busy || loading || Boolean(loadError)}
                onEdit={() => setEditor({ student: selected })}
                onArchive={() =>
                  selected.archived ? void changeArchived(selected) : setArchiveTarget(selected)
                }
              />
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center gap-4 px-6 py-10 text-center md:min-h-[32rem]">
                <UserRound className="text-muted-foreground/60 size-9" />
                <p className="text-muted-foreground text-sm">{copy.selectStudent}</p>
              </div>
            )}
          </div>
        </div>
      )}
      {editor && (
        <StudentEditor
          copy={copy}
          student={editor.student}
          onClose={() => setEditor(null)}
          onSaved={acceptStudent}
          refreshStudents={refreshStudents}
        />
      )}
      {identityOpen && <TeacherIdentityDialog copy={copy} onClose={() => setIdentityOpen(false)} />}
      {archiveTarget && (
        <Dialog open onOpenChange={(open) => !open && !busy && setArchiveTarget(null)}>
          <DialogContent
            className="w-[calc(100%-2rem)] max-w-md rounded-lg"
            showCloseButton={!busy}
          >
            <DialogHeader className="pr-8">
              <DialogTitle>{copy.archiveTitle}</DialogTitle>
              <DialogDescription>{copy.archiveDescription}</DialogDescription>
            </DialogHeader>
            <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">
              {archiveTarget.profile.displayName.value}
            </p>
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setArchiveTarget(null)}>
                {copy.cancel}
              </Button>
              <Button disabled={busy} onClick={() => void changeArchived(archiveTarget)}>
                {busy ? <LoaderCircle className="animate-spin" /> : <Archive />}
                {copy.archive}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </main>
  );
}
