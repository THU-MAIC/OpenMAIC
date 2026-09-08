'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FolderOpen, LoaderCircle, Settings2, Sparkles, Square, X } from 'lucide-react';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AttachButton, useComposerMaterials } from '@/components/workbench/compose-extras';
import type { WorkbenchMaterial } from '@/lib/workbench/session-store';
import type { TeacherAnalysisCopy } from '@/lib/i18n/teacher-analysis';
import {
  createTeacherAnalysisSchema,
  TEACHER_ANALYSIS_MAX_FILES,
  type CreateTeacherAnalysis,
  type TeacherAnalysis,
  type TeacherAnalysisSourceRole,
} from '@/lib/teacher/analysis';
import type { SettingsSection } from '@/lib/types/settings';
import { createTeacherRequestId, teacherRequest, TeacherRequestError } from './student-ui';
import {
  analysisCollectionUrl,
  analysisErrorMessage,
  analysisRequestHeaders,
  localWorkDate,
} from './analysis-ui';

const selectClass =
  'border-input bg-background focus-visible:ring-ring h-9 w-full min-w-0 rounded-md border px-2 text-sm focus-visible:ring-2 disabled:opacity-50';

interface LibraryMaterial {
  materialId: string;
  originalName?: string;
  bytes: number;
  mime?: string;
}

export function AnalysisComposer({
  profileId,
  nickname,
  copy,
  onClose,
  onSaved,
  onSettings,
}: {
  profileId: string;
  nickname: string;
  copy: TeacherAnalysisCopy;
  onClose: () => void;
  onSaved: (analysis: TeacherAnalysis) => void;
  onSettings: (section: SettingsSection) => void;
}) {
  const uploads = useComposerMaterials();
  const [requestId] = useState(createTeacherRequestId);
  const [workKind, setWorkKind] = useState<CreateTeacherAnalysis['workKind']>('homework');
  const [subject, setSubject] = useState('');
  const [title, setTitle] = useState('');
  const [workDate, setWorkDate] = useState(localWorkDate);
  const [teacherNotes, setTeacherNotes] = useState('');
  const [selectedLibrary, setSelectedLibrary] = useState<WorkbenchMaterial[]>([]);
  const [roles, setRoles] = useState<Record<string, TeacherAnalysisSourceRole | ''>>({});
  const [library, setLibrary] = useState<LibraryMaterial[] | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState<string>();
  const [pendingRequest, setPendingRequest] = useState<CreateTeacherAnalysis | null>(null);
  const requestController = useRef<AbortController | null>(null);
  const libraryController = useRef<AbortController | null>(null);
  const active = useRef(true);
  const selected = [...selectedLibrary, ...uploads.materials].filter(
    (material, index, values) =>
      values.findIndex((item) => item.materialId === material.materialId) === index,
  );
  const locked = generating || pendingRequest !== null;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      requestController.current?.abort();
      libraryController.current?.abort();
    };
  }, []);

  async function loadLibrary() {
    libraryController.current?.abort();
    const controller = new AbortController();
    libraryController.current = controller;
    setLibraryOpen(true);
    setLibraryLoading(true);
    setLibraryError(false);
    try {
      const response = await teacherRequest<{ materials: LibraryMaterial[] }>(
        '/api/materials?scope=owner',
        { signal: controller.signal },
      );
      if (!controller.signal.aborted && active.current) setLibrary(response.materials);
    } catch {
      if (!controller.signal.aborted && active.current) setLibraryError(true);
    } finally {
      if (!controller.signal.aborted && active.current) setLibraryLoading(false);
    }
  }

  function addFiles(files: FileList | File[]) {
    if (locked) return;
    if (selected.length + uploads.uploading.length + files.length > TEACHER_ANALYSIS_MAX_FILES) {
      setError(copy.tooManyMaterials);
      return;
    }
    setError('');
    uploads.addFiles(files);
  }

  function selectMaterial(material: LibraryMaterial) {
    if (locked || selected.some((item) => item.materialId === material.materialId)) return;
    if (selected.length + uploads.uploading.length >= TEACHER_ANALYSIS_MAX_FILES) {
      setError(copy.tooManyMaterials);
      return;
    }
    setSelectedLibrary((current) => [
      ...current,
      {
        materialId: material.materialId,
        name: material.originalName ?? material.materialId,
        bytes: material.bytes,
        mimeType: material.mime,
      },
    ]);
    setError('');
  }

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (generating || uploads.busy || uploads.failed.length) return;
    if (
      !pendingRequest &&
      (!selected.some((material) => roles[material.materialId] === 'student_work') ||
        selected.some((material) => !roles[material.materialId]))
    ) {
      setError(copy.sourceRequired);
      return;
    }
    const parsed = createTeacherAnalysisSchema.safeParse(
      pendingRequest ?? {
        requestId,
        workKind,
        subject,
        title,
        workDate,
        teacherNotes,
        materials: selected.map((material) => ({
          materialId: material.materialId,
          role: roles[material.materialId],
        })),
      },
    );
    if (!parsed.success) {
      setError(copy.inputInvalid);
      return;
    }
    const payload = parsed.data;
    const controller = new AbortController();
    requestController.current = controller;
    setGenerating(true);
    setError('');
    setErrorCode(undefined);
    try {
      const response = await teacherRequest<{ analysis: TeacherAnalysis }>(
        analysisCollectionUrl(profileId),
        {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: analysisRequestHeaders(),
          signal: controller.signal,
        },
      );
      if (response.analysis.profileId !== profileId) throw new Error('Unexpected student analysis');
      if (active.current && !controller.signal.aborted) onSaved(response.analysis);
    } catch (failure) {
      if (!active.current) return;
      const status = failure instanceof TeacherRequestError ? failure.status : 0;
      const code = failure instanceof TeacherRequestError ? failure.code : undefined;
      const uncertain = status === 0 || status >= 500 || status === 408;
      setPendingRequest(uncertain ? payload : null);
      setErrorCode(code);
      setError(controller.signal.aborted ? copy.canceled : analysisErrorMessage(failure, copy));
    } finally {
      if (active.current) {
        setGenerating(false);
        if (controller.signal.aborted) {
          setPendingRequest(payload);
          setError(copy.canceled);
        }
      }
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-lg"
        aria-describedby="teacher-analysis-description"
      >
        <DialogHeader className="min-w-0 pr-7">
          <DialogTitle className="break-words [overflow-wrap:anywhere]">
            {copy.newTitle}
          </DialogTitle>
          <DialogDescription
            id="teacher-analysis-description"
            className="break-words [overflow-wrap:anywhere]"
          >
            {nickname}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => void generate(event)}
          className="min-w-0 space-y-5"
          data-testid="teacher-analysis-composer"
        >
          <fieldset disabled={locked} className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <Label htmlFor="teacher-analysis-kind">{copy.workKind}</Label>
              <select
                id="teacher-analysis-kind"
                value={workKind}
                className={selectClass}
                onChange={(event) =>
                  setWorkKind(event.target.value as CreateTeacherAnalysis['workKind'])
                }
              >
                {Object.entries(copy.workKinds).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0 space-y-2">
              <Label htmlFor="teacher-analysis-date">{copy.workDate}</Label>
              <Input
                id="teacher-analysis-date"
                type="date"
                required
                value={workDate}
                onChange={(event) => setWorkDate(event.target.value)}
                className="w-full min-w-0"
              />
            </div>
            <div className="min-w-0 space-y-2">
              <Label htmlFor="teacher-analysis-subject">{copy.subject}</Label>
              <Input
                id="teacher-analysis-subject"
                maxLength={40}
                required
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
            </div>
            <div className="min-w-0 space-y-2">
              <Label htmlFor="teacher-analysis-title">{copy.recordTitle}</Label>
              <Input
                id="teacher-analysis-title"
                maxLength={120}
                required
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="min-w-0 space-y-2 sm:col-span-2">
              <Label htmlFor="teacher-analysis-notes">{copy.teacherNotes}</Label>
              <Textarea
                id="teacher-analysis-notes"
                maxLength={3000}
                rows={3}
                value={teacherNotes}
                onChange={(event) => setTeacherNotes(event.target.value)}
              />
            </div>
          </fieldset>
          <section className="min-w-0 border-y py-4" aria-label={copy.materials}>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">
                {copy.materials}{' '}
                <span className="text-muted-foreground">
                  {selected.length} / {TEACHER_ANALYSIS_MAX_FILES}
                </span>
              </h3>
              <div className="flex items-center gap-1">
                <AttachButton
                  onFiles={addFiles}
                  disabled={
                    locked ||
                    selected.length + uploads.uploading.length >= TEACHER_ANALYSIS_MAX_FILES
                  }
                  label={copy.upload}
                  testId="teacher-analysis-upload"
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={copy.library}
                      disabled={locked}
                      onClick={() => void loadLibrary()}
                    >
                      <FolderOpen className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{copy.library}</TooltipContent>
                </Tooltip>
              </div>
            </div>
            {!selected.length && !uploads.busy && (
              <p className="text-muted-foreground py-3 text-sm">{copy.noMaterials}</p>
            )}
            <ul className="min-w-0 divide-y">
              {selected.map((material) => (
                <li
                  key={material.materialId}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_200px_auto]"
                >
                  <span className="min-w-0 break-words text-sm [overflow-wrap:anywhere]">
                    {material.name}
                  </span>
                  <select
                    aria-label={`${copy.role}: ${material.name}`}
                    value={roles[material.materialId] ?? ''}
                    disabled={locked}
                    className={`${selectClass} col-start-1 row-start-2 sm:col-auto sm:row-auto`}
                    onChange={(event) =>
                      setRoles((current) => ({
                        ...current,
                        [material.materialId]: event.target.value as TeacherAnalysisSourceRole,
                      }))
                    }
                  >
                    <option value="">{copy.chooseRole}</option>
                    {Object.entries(copy.roles).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`${copy.remove}: ${material.name}`}
                    disabled={locked}
                    className="col-start-2 row-start-1 sm:col-auto sm:row-auto"
                    onClick={() => {
                      uploads.remove(material.materialId);
                      setSelectedLibrary((current) =>
                        current.filter((item) => item.materialId !== material.materialId),
                      );
                    }}
                  >
                    <X className="size-4" />
                  </Button>
                </li>
              ))}
              {uploads.uploading.map((entry) => (
                <li
                  key={entry.id}
                  role="status"
                  className="flex min-w-0 items-center gap-2 py-3 text-sm"
                >
                  <LoaderCircle className="size-4 shrink-0 animate-spin" />
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    {entry.name}: {copy.uploading}
                  </span>
                </li>
              ))}
              {uploads.failed.map((entry) => (
                <li
                  key={entry.id}
                  className="flex min-w-0 items-center justify-between gap-2 py-3 text-sm"
                >
                  <span className="text-destructive min-w-0 break-words [overflow-wrap:anywhere]">
                    {entry.name}: {copy.uploadFailed}
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`${copy.removeFailed}: ${entry.name}`}
                    onClick={() => uploads.removeFailed(entry.id)}
                  >
                    <X className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
            {libraryOpen && (
              <div className="mt-3 min-w-0 border-t pt-3">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-medium">{copy.library}</h4>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={copy.close}
                    onClick={() => setLibraryOpen(false)}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
                {libraryLoading ? (
                  <p role="status" className="text-muted-foreground py-3 text-sm">
                    {copy.libraryLoading}
                  </p>
                ) : libraryError ? (
                  <p role="alert" className="text-destructive py-3 text-sm">
                    {copy.libraryFailed}
                  </p>
                ) : (
                  <ul className="max-h-48 min-w-0 overflow-y-auto divide-y">
                    {library
                      ?.filter(
                        (material) =>
                          !selected.some((item) => item.materialId === material.materialId),
                      )
                      .map((material) => (
                        <li key={material.materialId}>
                          <button
                            type="button"
                            disabled={
                              locked ||
                              selected.length + uploads.uploading.length >=
                                TEACHER_ANALYSIS_MAX_FILES
                            }
                            onClick={() => selectMaterial(material)}
                            className="hover:bg-muted w-full min-w-0 break-words px-2 py-3 text-left text-sm disabled:opacity-50 [overflow-wrap:anywhere]"
                          >
                            {material.originalName ?? material.materialId}
                          </button>
                        </li>
                      ))}
                    {!library?.some(
                      (material) =>
                        !selected.some((item) => item.materialId === material.materialId),
                    ) && (
                      <li className="text-muted-foreground py-3 text-sm">{copy.libraryEmpty}</li>
                    )}
                  </ul>
                )}
              </div>
            )}
          </section>
          <p className="text-muted-foreground text-xs leading-5">{copy.privacy}</p>
          {error && (
            <p role="alert" className="text-destructive text-sm leading-6">
              {error}
            </p>
          )}
          {pendingRequest && (
            <p role="status" className="text-muted-foreground text-sm leading-6">
              {copy.creationPending}
            </p>
          )}
          <DialogFooter className="flex-wrap gap-2 sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                onSettings(
                  errorCode === 'ANALYSIS_OCR_REQUIRED' ||
                    errorCode === 'ANALYSIS_EXTRACTION_FAILED'
                    ? 'pdf'
                    : 'providers',
                )
              }
            >
              <Settings2 className="size-4" />
              {copy.settings}
            </Button>
            {generating ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => requestController.current?.abort()}
              >
                <Square className="size-4" />
                {copy.cancel}
              </Button>
            ) : (
              <Button type="submit" disabled={uploads.busy || uploads.failed.length > 0}>
                <Sparkles className="size-4" />
                {pendingRequest ? copy.retry : copy.generate}
              </Button>
            )}
          </DialogFooter>
          {generating && (
            <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
              <LoaderCircle className="size-4 animate-spin" />
              {copy.generating}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
