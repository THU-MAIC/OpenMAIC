'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Users, Plus, Pencil, Trash2, X, Search, CheckSquare, Square, ChevronDown, ChevronUp, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import { Button } from '@/components/ui/button';
import {
  createClassroomStudent,
  deleteClassroomStudent,
  deleteManyClassroomStudents,
  listClassroomStudents,
  updateClassroomStudent,
  type ClassroomStudent,
} from '@/lib/utils/classroom-student-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('StudentManager');

interface StudentManagerProps {
  stageId: string;
  /** When provided, the component is fully controlled (no built-in trigger button rendered). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface StudentFormState {
  name: string;
  studentId: string;
  email: string;
  notes: string;
}

const INITIAL_FORM: StudentFormState = {
  name: '',
  studentId: '',
  email: '',
  notes: '',
};

export function StudentManager({ stageId, open: openProp, onOpenChange }: StudentManagerProps) {
  const isControlled = onOpenChange !== undefined;
  const [openState, setOpenState] = useState(false);
  const open = isControlled ? (openProp ?? false) : openState;
  const setOpen = isControlled ? onOpenChange : setOpenState;

  const [students, setStudents] = useState<ClassroomStudent[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<StudentFormState>(INITIAL_FORM);
  const [saving, setSaving] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);
  const [deletingMany, setDeletingMany] = useState(false);
  const [dbQuery, setDbQuery] = useState('');
  const [dbLoading, setDbLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [dbResults, setDbResults] = useState<
    Array<{
      id: string;
      name: string | null;
      studentId: string | null;
      email: string;
      isActive?: boolean;
    }>
  >([]);
  /** DB user ID of the student selected from the search dropdown (if any). */
  const [selectedDbUserId, setSelectedDbUserId] = useState<string | null>(null);
  /** Credentials to display after a new student account is created. */
  const [createdCredentials, setCreatedCredentials] = useState<{ name: string; email: string; password: string; emailSent: boolean } | null>(null);
  const [copiedPassword, setCopiedPassword] = useState(false);
  const [importing, setImporting] = useState(false);
  const [resendingInvitation, setResendingInvitation] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadStudents = useCallback(async () => {
    if (!stageId) return;
    const data = await listClassroomStudents(stageId);
    setStudents(data);
  }, [stageId]);

  const notifyStudentsUpdated = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('classroom-students-updated', {
        detail: { stageId },
      }),
    );
  }, [stageId]);

  useEffect(() => {
    void loadStudents();
  }, [loadStudents]);

  useEffect(() => {
    if (!showAddForm) return;

    const q = dbQuery.trim();
    if (q.length < 2) {
      setDbResults([]);
      setDbError(null);
      setDbLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setDbLoading(true);
      setDbError(null);
      try {
        const res = await fetch(
          `/api/admin/classrooms/${encodeURIComponent(stageId)}/students-search?q=${encodeURIComponent(q)}`,
          { signal: controller.signal },
        );
        if (!res.ok) {
          setDbError('Failed to search students');
          setDbResults([]);
          return;
        }
        const json = (await res.json()) as {
          students?: Array<{
            id: string;
            name: string | null;
            studentId: string | null;
            email: string;
            isActive?: boolean;
          }>;
        };
        setDbResults(json.students ?? []);
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          log.error('Failed to search students from database:', error);
          setDbError('Failed to search students');
          setDbResults([]);
        }
      } finally {
        setDbLoading(false);
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [dbQuery, showAddForm, stageId]);

  useEffect(() => {
    if (!showAddForm) return;
    if (dbQuery.trim().length >= 2) return;

    const seed = form.studentId.trim() || form.name.trim() || form.email.trim();
    if (seed.length >= 2) {
      setDbQuery(seed);
    }
  }, [showAddForm, dbQuery, form.studentId, form.name, form.email]);

  const filterOutExistingStudents = useCallback((
    candidates: Array<{
      id: string;
      name: string | null;
      studentId: string | null;
      email: string;
      isActive?: boolean;
    }>,
  ) => {
    if (candidates.length === 0) return candidates;

    const existingStudentIds = new Set(
      students
        .map((s) => s.studentId?.trim().toLowerCase())
        .filter((v): v is string => !!v),
    );
    const existingEmails = new Set(
      students
        .map((s) => s.email?.trim().toLowerCase())
        .filter((v): v is string => !!v),
    );

    return candidates.filter((candidate) => {
      const candidateStudentId = candidate.studentId?.trim().toLowerCase();
      if (candidateStudentId && existingStudentIds.has(candidateStudentId)) {
        return false;
      }

      const candidateEmail = candidate.email?.trim().toLowerCase();
      if (candidateEmail && existingEmails.has(candidateEmail)) {
        return false;
      }

      return true;
    });
  }, [students]);

  const filteredDbResults = useMemo(
    () => filterOutExistingStudents(dbResults),
    [dbResults, filterOutExistingStudents],
  );

  const allFilteredSelected =
    students.length > 0 && students.every((s) => selectedIds.has(s.id));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        students.forEach((s) => next.delete(s.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        students.forEach((s) => next.add(s.id));
        return next;
      });
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const resetForm = () => {
    setEditingId(null);
    setForm(INITIAL_FORM);
    setDbQuery('');
    setDbResults([]);
    setDbError(null);
    setSelectedDbUserId(null);
    setCreatedCredentials(null);
    setCopiedPassword(false);
  };

  const applyDbStudent = (student: {
    id: string;
    name: string | null;
    studentId: string | null;
    email: string;
  }) => {
    setSelectedDbUserId(student.id);
    setForm((prev) => ({
      ...prev,
      name: student.name ?? prev.name,
      studentId: student.studentId ?? prev.studentId,
      email: student.email ?? prev.email,
    }));
    setDbQuery(student.name ?? student.studentId ?? student.email);
    setDbResults([]);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) return;

    setSaving(true);
    try {
      if (editingId) {
        // Editing an existing local entry
        await updateClassroomStudent(stageId, editingId, {
          name,
          studentId: form.studentId,
          email: form.email,
          notes: form.notes,
        });
        await loadStudents();
        notifyStudentsUpdated();
        resetForm();
      } else if (selectedDbUserId) {
        // Existing DB student selected — grant classroom access in the database
        const assignRes = await fetch(
          `/api/admin/classrooms/${encodeURIComponent(stageId)}/assign`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userIds: [selectedDbUserId] }),
          },
        );
        if (!assignRes.ok) {
          toast.error('Failed to grant classroom access. Please try again.');
          return;
        }
        // Also persist locally so the student appears in the classroom roster
        await createClassroomStudent(stageId, {
          name,
          studentId: form.studentId,
          email: form.email,
          notes: form.notes,
        });
        await loadStudents();
        notifyStudentsUpdated();
        toast.success(`${name} added to classroom.`);
        resetForm();
        setShowAddForm(false);
      } else {
        // Brand-new student — create local entry first
        await createClassroomStudent(stageId, {
          name,
          studentId: form.studentId,
          email: form.email,
          notes: form.notes,
        });
        await loadStudents();
        notifyStudentsUpdated();

        // If an email was provided, create a DB account and send credentials
        const email = form.email.trim();
        if (email) {
          const enrollRes = await fetch(
            `/api/admin/classrooms/${encodeURIComponent(stageId)}/create-and-enroll`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name,
                email,
                studentId: form.studentId.trim() || undefined,
                notes: form.notes,
              }),
            },
          );
          if (enrollRes.ok) {
            const data = (await enrollRes.json()) as {
              userId: string;
              temporaryPassword?: string;
              emailSent: boolean;
              alreadyExisted?: boolean;
            };
            if (data.temporaryPassword) {
              // Show credentials inline so the instructor can relay them
              setCreatedCredentials({
                name,
                email,
                password: data.temporaryPassword,
                emailSent: data.emailSent,
              });
            } else {
              toast.success(
                data.alreadyExisted
                  ? `${name} already has an account — classroom access granted.`
                  : `Account created for ${name}.`,
              );
              resetForm();
              setShowAddForm(false);
            }
          } else {
            // Account creation failed but local entry is already saved
            toast.warning('Student added locally. Account creation failed — check logs.');
            resetForm();
            setShowAddForm(false);
          }
        } else {
          // No email — local-only entry
          resetForm();
          setShowAddForm(false);
        }
      }
    } catch (error) {
      log.error('Failed to save student:', error);
      toast.error('An unexpected error occurred.');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (student: ClassroomStudent) => {
    setEditingId(student.id);
    setForm({
      name: student.name,
      studentId: student.studentId ?? '',
      email: student.email ?? '',
      notes: student.notes ?? '',
    });
    setShowAddForm(true);
  };

  const onDelete = async (student: ClassroomStudent) => {
    const ok = window.confirm(`Delete student "${student.name}"?`);
    if (!ok) return;
    try {
      await deleteClassroomStudent(stageId, student.id);
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(student.id); return next; });
      await loadStudents();
      notifyStudentsUpdated();
      if (editingId === student.id) resetForm();
    } catch (error) {
      log.error('Failed to delete student:', error);
    }
  };

  const onDeleteSelected = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const ok = window.confirm(`Delete ${ids.length} selected student${ids.length > 1 ? 's' : ''}?`);
    if (!ok) return;
    setDeletingMany(true);
    try {
      await deleteManyClassroomStudents(stageId, ids);
      setSelectedIds(new Set());
      await loadStudents();
      notifyStudentsUpdated();
      if (editingId && ids.includes(editingId)) resetForm();
    } catch (error) {
      log.error('Failed to bulk-delete students:', error);
    } finally {
      setDeletingMany(false);
    }
  };

  const onResendInvitation = async () => {
    const name = form.name.trim();
    const email = form.email.trim();

    if (!editingId) return;
    if (!name || !email) {
      toast.error('Full name and email are required to resend an invitation.');
      return;
    }

    setResendingInvitation(true);
    try {
      const response = await fetch(
        `/api/admin/classrooms/${encodeURIComponent(stageId)}/resend-invitation`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            email,
            studentId: form.studentId.trim() || undefined,
          }),
        },
      );

      if (!response.ok) {
        toast.error('Failed to resend invitation.');
        return;
      }

      const data = (await response.json()) as {
        temporaryPassword?: string;
        emailSent: boolean;
        alreadyExisted?: boolean;
      };

      if (data.temporaryPassword) {
        setCreatedCredentials({
          name,
          email,
          password: data.temporaryPassword,
          emailSent: data.emailSent,
        });
        toast.success('A new account was created and credentials were prepared.');
      } else {
        toast.success(
          data.emailSent
            ? 'Classroom invitation sent.'
            : 'Invitation prepared, but email delivery is not configured.',
        );
      }
    } catch (error) {
      log.error('Failed to resend invitation:', error);
      toast.error('Failed to resend invitation.');
    } finally {
      setResendingInvitation(false);
    }
  };

  const downloadTemplate = () => {
    const header = ['Full Name', 'Student ID', 'Email'];
    const sampleRows = [
      ['Jane Doe', 'S10001', 'jane.doe@example.edu'],
      ['John Smith', 'S10002', 'john.smith@example.edu'],
    ];
    const csvLines = [header, ...sampleRows].map((row) => row.map((v) => `"${v.replaceAll('"', '""')}"`).join(','));
    const blob = new Blob([`${csvLines.join('\n')}\n`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'student-import-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const parseStudentRowsFromSheet = (rows: Record<string, unknown>[]) => {
    const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/[_\-\s]+/g, '');
    const asText = (value: unknown) => (value === null || value === undefined ? '' : String(value).trim());

    const nameKeys = new Set(['fullname', 'name', 'studentname']);
    const studentIdKeys = new Set(['studentid', 'id', 'sid']);
    const emailKeys = new Set(['email', 'emailaddress', 'mail', 'e-mail']);

    return rows
      .map((row) => {
        const entries = Object.entries(row);
        let name = '';
        let studentId = '';
        let email = '';

        for (const [rawKey, rawValue] of entries) {
          const key = normalizeHeader(rawKey);
          const value = asText(rawValue);
          if (!value) continue;
          if (!name && nameKeys.has(key)) name = value;
          if (!studentId && studentIdKeys.has(key)) studentId = value;
          if (!email && emailKeys.has(key)) email = value;
        }

        return { name, studentId, email };
      })
      .filter((row) => row.name && row.studentId);
  };

  const onImportFile = async (file: File) => {
    setImporting(true);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        toast.error('The file is empty.');
        return;
      }

      const sheet = workbook.Sheets[firstSheetName];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
      const studentsToImport = parseStudentRowsFromSheet(rawRows);

      if (studentsToImport.length === 0) {
        toast.error('No valid rows found. Required columns: Full Name and Student ID.');
        return;
      }

      const importRes = await fetch(`/api/admin/classrooms/${encodeURIComponent(stageId)}/import-students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ students: studentsToImport }),
      });

      if (!importRes.ok) {
        toast.error('Failed to import students.');
        return;
      }

      const result = (await importRes.json()) as {
        assignedCount: number;
        createdCount: number;
        emailSentCount: number;
        failedCount: number;
        failures: Array<{ row: number; name: string; reason: string }>;
        passwordsToShare: Array<{ name: string; email: string; password: string }>;
        assignedStudents: Array<{ name: string; studentId?: string; email?: string }>;
      };

      const existing = await listClassroomStudents(stageId);
      const existingStudentIds = new Set(existing.map((s) => s.studentId?.trim().toLowerCase()).filter((v): v is string => !!v));
      const existingEmails = new Set(existing.map((s) => s.email?.trim().toLowerCase()).filter((v): v is string => !!v));

      for (const student of result.assignedStudents) {
        const sid = student.studentId?.trim().toLowerCase();
        const email = student.email?.trim().toLowerCase();
        if ((sid && existingStudentIds.has(sid)) || (email && existingEmails.has(email))) {
          continue;
        }
        await createClassroomStudent(stageId, {
          name: student.name,
          studentId: student.studentId,
          email: student.email,
        });
        if (sid) existingStudentIds.add(sid);
        if (email) existingEmails.add(email);
      }

      await loadStudents();
      notifyStudentsUpdated();

      toast.success(
        `Imported ${result.assignedCount} students (${result.createdCount} new accounts, ${result.emailSentCount} notifications sent).`,
      );

      if (result.failedCount > 0) {
        const first = result.failures[0];
        toast.warning(`Some rows failed (${result.failedCount}). First issue: row ${first.row} ${first.reason}`);
      }

      if (result.passwordsToShare.length > 0) {
        const lines = result.passwordsToShare.map((entry) => `${entry.name} (${entry.email}): ${entry.password}`);
        void navigator.clipboard.writeText(lines.join('\n'));
        toast.info('Some welcome emails were not sent. Temporary passwords were copied to clipboard.');
      }
    } catch (error) {
      log.error('Failed to import students:', error);
      toast.error('Failed to import file. Make sure it is a valid CSV/XLSX.');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const panel = open ? (
    <div className="w-[380px] max-w-[95vw] rounded-xl border border-gray-200 dark:border-gray-700 bg-white/95 dark:bg-gray-900/95 backdrop-blur shadow-xl p-3 space-y-2.5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-gray-600 dark:text-gray-300" />
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Classroom Students</h3>
          <span className="text-xs text-gray-500 dark:text-gray-400">({students.length})</span>
        </div>
        <Button variant="ghost" size="icon-xs" onClick={() => setOpen(false)}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={importing}
          onClick={() => fileInputRef.current?.click()}
        >
          {importing ? 'Importing...' : 'Import CSV / Excel'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={downloadTemplate}>
          Download Template
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onImportFile(file);
          }}
        />
      </div>

      {/* Add / Edit form toggle */}
      <button
        type="button"
        onClick={() => { if (showAddForm && editingId) resetForm(); setShowAddForm((v) => !v); }}
        className="w-full flex items-center justify-between rounded-lg border border-dashed border-gray-300 dark:border-gray-600 px-2.5 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:border-purple-400 hover:text-purple-500 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <Plus className="size-3.5" />
          {editingId ? 'Edit Student' : 'Add Student'}
        </span>
        {showAddForm ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
      </button>

      {showAddForm && (
        <form onSubmit={onSubmit} className="rounded-lg border border-gray-100 dark:border-gray-700 p-2.5 space-y-2">
          <div className="space-y-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-gray-400 dark:text-gray-500 pointer-events-none" />
              <input
                value={dbQuery}
                onChange={(e) => setDbQuery(e.target.value)}
                placeholder="Search DB by name or student ID"
                className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 pl-8 pr-2.5 py-1.5 text-sm"
              />
            </div>
            {dbLoading && <p className="text-[11px] text-gray-500 dark:text-gray-400">Searching database...</p>}
            {dbError && <p className="text-[11px] text-red-500">{dbError}</p>}
            {!dbLoading && filteredDbResults.length > 0 && (
              <div className="max-h-32 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
                {filteredDbResults.map((student) => (
                  <button
                    key={student.id}
                    type="button"
                    onClick={() => applyDbStudent(student)}
                    className="w-full px-2.5 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  >
                    <p className="text-sm text-gray-800 dark:text-gray-100 truncate">{student.name ?? student.email}</p>
                    <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                      {student.studentId ? `#${student.studentId} · ` : ''}
                      {student.email}
                      {student.isActive === false ? ' · inactive' : ''}
                    </p>
                  </button>
                ))}
              </div>
            )}
            {!dbLoading && !dbError && dbQuery.trim().length >= 2 && dbResults.length === 0 && (
              <p className="text-[11px] text-gray-500 dark:text-gray-400">
                No matching student was found in the database.
              </p>
            )}
            {!dbLoading && dbResults.length > 0 && filteredDbResults.length === 0 && (
              <p className="text-[11px] text-gray-500 dark:text-gray-400">
                All matched students are already in this classroom.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <input
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="Name *"
              className="col-span-2 w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-sm"
              required
            />
            <input
              value={form.studentId}
              onChange={(e) => setForm((prev) => ({ ...prev, studentId: e.target.value }))}
              placeholder="Student ID"
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-sm"
            />
            <input
              value={form.email}
              onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
              placeholder="Email"
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-sm"
              type="email"
            />
          </div>
          <textarea
            value={form.notes}
            onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
            placeholder="Notes (optional)"
            className="w-full min-h-[56px] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-sm resize-none"
          />
          {/* Temporary password display — shown after new student account creation */}
          {createdCredentials && (
            <div className="rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 p-2.5 space-y-1.5">
              <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-200">
                Account created for {createdCredentials.name}
                {createdCredentials.emailSent ? ' — credentials emailed' : ' — email not configured, copy credentials below'}
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-white dark:bg-gray-800 border border-emerald-200 dark:border-emerald-700 px-2 py-1 text-xs font-mono text-gray-800 dark:text-gray-100 truncate">
                  {createdCredentials.password}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(createdCredentials.password);
                    setCopiedPassword(true);
                    setTimeout(() => setCopiedPassword(false), 2000);
                  }}
                  className="shrink-0 rounded p-1 hover:bg-emerald-100 dark:hover:bg-emerald-800 transition-colors"
                  title="Copy password"
                >
                  {copiedPassword
                    ? <Check className="size-4 text-emerald-600 dark:text-emerald-400" />
                    : <Copy className="size-4 text-emerald-600 dark:text-emerald-400" />}
                </button>
              </div>
              <p className="text-[11px] text-emerald-700 dark:text-emerald-400">Email: {createdCredentials.email}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => { resetForm(); setShowAddForm(false); }}
                className="w-full"
              >
                Done
              </Button>
            </div>
          )}

          {!createdCredentials && (
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={saving}>
                {editingId ? <Pencil className="size-4" /> : <Plus className="size-4" />}
                {editingId ? 'Update' : 'Add / Create'}
              </Button>
              {editingId && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={resendingInvitation}
                  onClick={() => { void onResendInvitation(); }}
                >
                  {resendingInvitation ? 'Sending...' : 'Resend Invitation'}
                </Button>
              )}
              <Button type="button" size="sm" variant="outline" onClick={() => { resetForm(); setShowAddForm(false); }}>
                Cancel
              </Button>
            </div>
          )}
        </form>
      )}

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-2.5 py-1.5">
          <span className="text-xs text-red-700 dark:text-red-300 font-medium">
            {selectedIds.size} selected
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDeleteSelected}
            disabled={deletingMany}
            className="text-red-600 hover:text-red-700 hover:bg-red-100 dark:hover:bg-red-900/30 h-7 px-2 text-xs"
          >
            <Trash2 className="size-3.5 mr-1" />
            Delete selected
          </Button>
        </div>
      )}

      {/* Student list */}
      <div className="max-h-[300px] overflow-y-auto space-y-1.5 pr-0.5">
        {students.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400 py-2 text-center">
            No students yet.
          </p>
        ) : (
          <>
            {/* Select-all row */}
            <div className="flex items-center gap-2 px-1 pb-1 border-b border-gray-100 dark:border-gray-700">
              <button type="button" onClick={toggleSelectAll} className="text-gray-400 hover:text-purple-500 transition-colors">
                {allFilteredSelected
                  ? <CheckSquare className="size-4 text-purple-500" />
                  : <Square className="size-4" />}
              </button>
              <span className="text-xs text-gray-400 dark:text-gray-500 select-none">
                {allFilteredSelected ? 'Deselect all' : 'Select all'}
              </span>
            </div>

            {students.map((student) => (
              <div
                key={student.id}
                className={`rounded-lg border px-2.5 py-2 transition-colors ${
                  selectedIds.has(student.id)
                    ? 'border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-900/20'
                    : 'border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60'
                }`}
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => toggleSelect(student.id)}
                    className="mt-0.5 shrink-0 text-gray-400 hover:text-purple-500 transition-colors"
                  >
                    {selectedIds.has(student.id)
                      ? <CheckSquare className="size-4 text-purple-500" />
                      : <Square className="size-4" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">
                      {student.name}
                    </p>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                      {student.studentId && (
                        <span className="text-xs text-purple-600 dark:text-purple-400 font-mono">
                          #{student.studentId}
                        </span>
                      )}
                      {student.email && (
                        <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                          {student.email}
                        </span>
                      )}
                    </div>
                    {student.notes && (
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 whitespace-pre-wrap line-clamp-2">
                        {student.notes}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="icon-xs" variant="ghost" onClick={() => startEdit(student)}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button size="icon-xs" variant="ghost" onClick={() => onDelete(student)}>
                      <Trash2 className="size-3.5 text-red-500" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  ) : null;

  if (isControlled) {
    return panel;
  }

  return (
    <div className="relative z-40 flex justify-end p-4">
      {!open ? (
        <Button
          size="sm"
          onClick={() => setOpen(true)}
          className="h-8 rounded-lg bg-primary text-primary-foreground hover:opacity-90 shadow-sm"
        >
          <Users className="size-4" />
          Student Management
        </Button>
      ) : (
        panel
      )}
    </div>
  );
}
