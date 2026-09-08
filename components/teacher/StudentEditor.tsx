'use client';

import { useState, type FormEvent } from 'react';
import { LoaderCircle, RefreshCw, Save } from 'lucide-react';
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
import type { TeacherCopy } from '@/lib/i18n/teacher';
import type { TeacherStudent, TeacherStudentFields } from '@/lib/teacher/students';
import {
  createStudentDraft,
  createTeacherRequestId,
  studentDraftError,
  studentDraftPayload,
  teacherRequest,
  TeacherRequestError,
} from './student-ui';

export function StudentEditor({
  student,
  copy,
  onClose,
  onSaved,
  refreshStudents,
}: {
  student?: TeacherStudent;
  copy: TeacherCopy;
  onClose: () => void;
  onSaved: (student: TeacherStudent) => void;
  refreshStudents: () => Promise<TeacherStudent[]>;
}) {
  const [draft, setDraft] = useState(() => createStudentDraft(student));
  const [base, setBase] = useState(student);
  const [requestId] = useState(createTeacherRequestId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState('');
  const [pendingCreation, setPendingCreation] = useState<TeacherStudentFields | null>(null);
  const fieldsLocked = saving || pendingCreation !== null;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || conflict) return;
    const invalid = pendingCreation ? null : studentDraftError(draft);
    if (invalid) {
      setError(copy[invalid]);
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    const values = pendingCreation ?? studentDraftPayload(draft);
    try {
      const response = await teacherRequest<{ student: TeacherStudent }>(
        base
          ? `/api/teacher/students/${encodeURIComponent(base.profile.profileId)}`
          : '/api/teacher/students',
        {
          method: base ? 'PATCH' : 'POST',
          body: JSON.stringify(
            base
              ? { ...values, expectedUpdatedAt: base.profile.updatedAt, archived: base.archived }
              : { ...values, requestId },
          ),
        },
      );
      onSaved(response.student);
    } catch (failure) {
      const status = failure instanceof TeacherRequestError ? failure.status : 0;
      const code = failure instanceof TeacherRequestError ? failure.code : undefined;
      if (!base && (status === 0 || status >= 500 || status === 408)) {
        setPendingCreation(values);
        setError(copy.createPending);
        return;
      }
      setPendingCreation(null);
      const isConflict =
        status === 409 &&
        code !== 'TEACHER_STUDENT_LIMIT_REACHED' &&
        code !== 'TEACHER_STUDENT_STORAGE_CORRUPT' &&
        Boolean(base);
      setConflict(isConflict);
      setError(
        code === 'TEACHER_STUDENT_LIMIT_REACHED'
          ? copy.limitReached
          : code === 'TEACHER_STUDENT_STORAGE_CORRUPT'
            ? copy.storageIssue
            : isConflict
              ? copy.conflict
              : status === 400
                ? copy.invalid
                : copy.failed,
      );
    } finally {
      setSaving(false);
    }
  }

  async function refreshBase() {
    setSaving(true);
    try {
      const students = await refreshStudents();
      const latest = students.find((item) => item.profile.profileId === base?.profile.profileId);
      if (!latest) {
        setError(copy.profileGone);
        return;
      }
      const previousDraft = createStudentDraft(base);
      const latestDraft = createStudentDraft(latest);
      setDraft((current) => {
        const merged = { ...latestDraft };
        for (const field of ['nickname', 'grade', 'examYear', 'region'] as const) {
          if (current[field] !== previousDraft[field]) merged[field] = current[field];
        }
        return merged;
      });
      setBase(latest);
      setConflict(false);
      setError('');
      setNotice(copy.refreshedDraft);
    } catch {
      setError(copy.loadFailed);
    } finally {
      setSaving(false);
    }
  }

  async function close() {
    if (saving) return;
    if (pendingCreation) {
      setSaving(true);
      try {
        await refreshStudents();
      } catch {
        // The parent retains the list error and disables creating more students.
      }
    }
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && void close()}>
      <DialogContent
        className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-lg"
        showCloseButton={!saving}
      >
        <DialogHeader className="pr-8">
          <DialogTitle>{student ? copy.editStudent : copy.addStudent}</DialogTitle>
          <DialogDescription>{copy.studentDescription}</DialogDescription>
        </DialogHeader>
        <form className="min-w-0 space-y-5" onSubmit={save}>
          <div className="space-y-2">
            <Label htmlFor="teacher-student-nickname">{copy.nickname}</Label>
            <Input
              id="teacher-student-nickname"
              autoFocus
              required
              maxLength={80}
              autoComplete="off"
              placeholder={copy.nicknamePlaceholder}
              value={draft.nickname}
              disabled={fieldsLocked}
              onChange={(event) => setDraft({ ...draft, nickname: event.target.value })}
            />
          </div>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <Label htmlFor="teacher-student-grade">
                {copy.grade} <span className="text-muted-foreground text-xs">{copy.optional}</span>
              </Label>
              <Input
                id="teacher-student-grade"
                type="number"
                min={1}
                max={12}
                step={1}
                placeholder={copy.unknown}
                value={draft.grade}
                disabled={fieldsLocked}
                onChange={(event) => setDraft({ ...draft, grade: event.target.value })}
              />
            </div>
            <div className="min-w-0 space-y-2">
              <Label htmlFor="teacher-student-exam-year">
                {copy.examYear}{' '}
                <span className="text-muted-foreground text-xs">{copy.optional}</span>
              </Label>
              <Input
                id="teacher-student-exam-year"
                type="number"
                min={2000}
                max={2100}
                step={1}
                placeholder={copy.unknown}
                value={draft.examYear}
                disabled={fieldsLocked}
                onChange={(event) => setDraft({ ...draft, examYear: event.target.value })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="teacher-student-region">
              {copy.region} <span className="text-muted-foreground text-xs">{copy.optional}</span>
            </Label>
            <Input
              id="teacher-student-region"
              maxLength={100}
              placeholder={copy.unknown}
              value={draft.region}
              disabled={fieldsLocked}
              onChange={(event) => setDraft({ ...draft, region: event.target.value })}
            />
          </div>
          {error && (
            <p role="alert" className="text-destructive break-words text-sm">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-muted-foreground text-sm">
              {notice}
            </p>
          )}
          {conflict && base && (
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              className="h-auto min-h-9 max-w-full whitespace-normal text-left"
              onClick={refreshBase}
            >
              <RefreshCw />
              {copy.refreshDraft}
            </Button>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              className="h-auto min-h-9 whitespace-normal"
              onClick={() => void close()}
            >
              {pendingCreation ? copy.closeAndRefresh : copy.cancel}
            </Button>
            <Button type="submit" disabled={saving || conflict}>
              {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
              {saving ? copy.saving : pendingCreation ? copy.retry : copy.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
