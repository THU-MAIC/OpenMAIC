import { createLogger } from '@/lib/logger';
import { db } from '@/lib/utils/database';

const log = createLogger('ClassroomStudentStorage');

export interface ClassroomStudent {
  id: string;
  stageId: string;
  name: string;
  studentId?: string;
  email?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateClassroomStudentInput {
  name: string;
  studentId?: string;
  email?: string;
  notes?: string;
}

export interface UpdateClassroomStudentInput {
  name?: string;
  studentId?: string;
  email?: string;
  notes?: string;
}

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `student-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeText(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function listClassroomStudents(stageId: string): Promise<ClassroomStudent[]> {
  try {
    const records = await db.classroomStudents.where('stageId').equals(stageId).toArray();
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (error) {
    log.error('Failed to list classroom students:', error);
    return [];
  }
}

export async function createClassroomStudent(
  stageId: string,
  input: CreateClassroomStudentInput,
): Promise<ClassroomStudent> {
  const name = input.name.trim();
  if (!name) {
    throw new Error('Student name is required');
  }

  const now = Date.now();
  const student: ClassroomStudent = {
    id: createId(),
    stageId,
    name,
    studentId: normalizeText(input.studentId),
    email: normalizeText(input.email),
    notes: normalizeText(input.notes),
    createdAt: now,
    updatedAt: now,
  };

  await db.classroomStudents.put(student);
  return student;
}

export async function updateClassroomStudent(
  stageId: string,
  studentId: string,
  input: UpdateClassroomStudentInput,
): Promise<ClassroomStudent> {
  const existing = await db.classroomStudents.get(studentId);
  if (!existing || existing.stageId !== stageId) {
    throw new Error('Student not found');
  }

  const nextName = input.name !== undefined ? input.name.trim() : existing.name;
  if (!nextName) {
    throw new Error('Student name is required');
  }

  const updated: ClassroomStudent = {
    ...existing,
    name: nextName,
    studentId: input.studentId !== undefined ? normalizeText(input.studentId) : existing.studentId,
    email: input.email !== undefined ? normalizeText(input.email) : existing.email,
    notes: input.notes !== undefined ? normalizeText(input.notes) : existing.notes,
    updatedAt: Date.now(),
  };

  await db.classroomStudents.put(updated);
  return updated;
}

export async function deleteClassroomStudent(stageId: string, studentId: string): Promise<void> {
  const existing = await db.classroomStudents.get(studentId);
  if (!existing || existing.stageId !== stageId) {
    return;
  }
  await db.classroomStudents.delete(studentId);
}

export async function deleteManyClassroomStudents(stageId: string, studentIds: string[]): Promise<void> {
  if (studentIds.length === 0) return;
  await db.classroomStudents
    .where('id')
    .anyOf(studentIds)
    .filter((s) => s.stageId === stageId)
    .delete();
}
