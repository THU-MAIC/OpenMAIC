import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: vi.fn(),
  ensureClassroomOwnership: vi.fn(),
}));

vi.mock('@/lib/auth/prisma', () => ({
  prisma: {
    classroomAccess: {
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/server/classroom-storage', () => ({
  listDeletedClassrooms: vi.fn(),
  restoreDeletedClassroom: vi.fn(),
}));

import { GET, POST } from '@/app/api/admin/classrooms/recover/route';
import { ensureClassroomOwnership, requireRole } from '@/lib/auth/helpers';
import { prisma } from '@/lib/auth/prisma';
import { listDeletedClassrooms, restoreDeletedClassroom } from '@/lib/server/classroom-storage';

describe('admin classroom recover route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireRole).mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
    } as never);
  });

  it('GET returns forbidden for non-admin session', async () => {
    vi.mocked(requireRole).mockRejectedValueOnce(new Error('FORBIDDEN'));

    const res = await GET();
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'Forbidden' });
  });

  it('GET returns deleted classrooms list', async () => {
    vi.mocked(listDeletedClassrooms).mockResolvedValueOnce([
      {
        id: 'class-1',
        ownerUserId: 'owner-1',
        deletedBy: 'admin-1',
        deletedAt: new Date().toISOString(),
        purgeAt: new Date(Date.now() + 1000).toISOString(),
      },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      classrooms: [
        {
          id: 'class-1',
          ownerUserId: 'owner-1',
        },
      ],
    });
  });

  it('POST returns 404 when classroom is not found in deleted records', async () => {
    vi.mocked(restoreDeletedClassroom).mockResolvedValueOnce(null);

    const req = new Request('http://localhost/api/admin/classrooms/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'missing-id' }),
    });

    const res = await POST(req as never);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Classroom not found in deleted records' });
  });

  it('POST returns 400 for invalid JSON body', async () => {
    const req = new Request('http://localhost/api/admin/classrooms/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    });

    const res = await POST(req as never);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid JSON body' });
  });

  it('POST restores classroom and re-establishes owner access', async () => {
    vi.mocked(restoreDeletedClassroom).mockResolvedValueOnce({
      id: 'class-2',
      ownerUserId: 'owner-2',
      deletedBy: 'admin-1',
      deletedAt: new Date().toISOString(),
      purgeAt: new Date(Date.now() + 1000).toISOString(),
    });

    const req = new Request('http://localhost/api/admin/classrooms/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'class-2' }),
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.classroomAccess.deleteMany)).toHaveBeenCalledWith({
      where: { classroomId: 'class-2' },
    });
    expect(vi.mocked(ensureClassroomOwnership)).toHaveBeenCalledWith('owner-2', 'class-2');

    const payload = (await res.json()) as {
      success: boolean;
      id: string;
      ownerUserId: string;
      restoredAt: string;
    };

    expect(payload.success).toBe(true);
    expect(payload.id).toBe('class-2');
    expect(payload.ownerUserId).toBe('owner-2');
    expect(typeof payload.restoredAt).toBe('string');
  });
});
