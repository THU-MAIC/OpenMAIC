import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/auth/prisma';
import { readClassroom } from '@/lib/server/classroom-storage';
import type { Role, Prisma } from '@prisma/client';
import type { NextRequest } from 'next/server';
import { ensureBuiltInRoles } from '@/lib/admin/role-definitions';
import { DEFAULT_BUILT_IN_ROLES } from '@/lib/admin/permissions';

/** Get the current session on the server. Returns null if not authenticated. */
export async function getServerSession() {
  return auth();
}

/** Assert that the current user has one of the allowed roles. Throws if not. */
export async function requireRole(...roles: Role[]) {
  const session = await auth();
  if (!session?.user) throw new Error('UNAUTHENTICATED');
  if (!roles.includes(session.user.role)) throw new Error('FORBIDDEN');
  return session;
}

async function getEffectivePermissions(role: Role): Promise<string[]> {
  await ensureBuiltInRoles();

  const roleDefinition = await prisma.roleDefinition.findUnique({
    where: { name: role },
    select: { permissions: true },
  });

  if (roleDefinition?.permissions?.length) {
    return roleDefinition.permissions;
  }

  const fallback = DEFAULT_BUILT_IN_ROLES[role as keyof typeof DEFAULT_BUILT_IN_ROLES];
  return fallback?.permissions ? [...fallback.permissions] : [];
}

/** Get the effective permissions for a role from the database (with fallback to code defaults). */
export { getEffectivePermissions };

/** Check whether the current authenticated user has a specific permission. */
export async function hasServerPermission(permission: string): Promise<boolean> {
  const session = await auth();
  if (!session?.user) return false;

  const permissions = await getEffectivePermissions(session.user.role);
  return permissions.includes(permission);
}

/** Check whether the current authenticated user has any of the specified permissions. */
export async function hasAnyServerPermission(...permissions: string[]): Promise<boolean> {
  const session = await auth();
  if (!session?.user) return false;

  const effectivePermissions = await getEffectivePermissions(session.user.role);
  return permissions.some((permission) => effectivePermissions.includes(permission));
}

/** Assert that the current user has all specified permissions. Throws if not. */
export async function requirePermissions(...permissions: string[]) {
  const session = await auth();
  if (!session?.user) throw new Error('UNAUTHENTICATED');

  const effectivePermissions = await getEffectivePermissions(session.user.role);
  const hasAllPermissions = permissions.every((permission) => effectivePermissions.includes(permission));

  if (!hasAllPermissions) throw new Error('FORBIDDEN');
  return session;
}

/** Assert that the current user has at least one of the specified permissions. Throws if not. */
export async function requireAnyPermissions(...permissions: string[]) {
  const session = await auth();
  if (!session?.user) throw new Error('UNAUTHENTICATED');

  const effectivePermissions = await getEffectivePermissions(session.user.role);
  const hasAnyPermission = permissions.some((permission) => effectivePermissions.includes(permission));

  if (!hasAnyPermission) throw new Error('FORBIDDEN');
  return session;
}

/** Write an audit log entry. Safe to call without awaiting (fire-and-forget). */
export function writeAuditLog(params: {
  actorId?: string;
  targetId?: string;
  action: string;
  resource?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  req?: NextRequest;
}) {
  const ip =
    params.req?.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    params.req?.headers.get('x-real-ip') ??
    undefined;
  const ua = params.req?.headers.get('user-agent') ?? undefined;

  return prisma.auditLog
    .create({
      data: {
        actorId: params.actorId,
        targetId: params.targetId,
        action: params.action,
        resource: params.resource,
        resourceId: params.resourceId,
        details: params.details as Prisma.InputJsonValue,
        ipAddress: ip,
        userAgent: ua,
      },
    })
    .catch(() => {
      /* non-critical */
    });
}

/** Check whether the first-run setup has been completed. */
export async function isSetupComplete(): Promise<boolean> {
  try {
    const status = await prisma.setupStatus.findUnique({ where: { id: 'singleton' } });
    return status?.completed ?? false;
  } catch {
    return false;
  }
}

/** Check if a student has access to a specific classroom. */
export async function studentHasClassroomAccess(userId: string, classroomId: string) {
  const access = await prisma.classroomAccess.findUnique({
    where: { userId_classroomId: { userId, classroomId } },
  });
  return !!access;
}

/** Mark a classroom as owned by a specific user (idempotent). */
export async function ensureClassroomOwnership(userId: string, classroomId: string) {
  await prisma.classroomAccess.upsert({
    where: { userId_classroomId: { userId, classroomId } },
    update: { assignedBy: userId },
    create: { userId, classroomId, assignedBy: userId },
  });
}

/**
 * Check whether an instructor/admin owns a classroom.
 * Ownership marker: classroom_access row where userId===assignedBy===owner.
 * Legacy fallback: any row for classroom assignedBy owner (older data before marker rollout).
 */
export async function userOwnsClassroom(userId: string, classroomId: string) {
  const marker = await prisma.classroomAccess.findUnique({
    where: { userId_classroomId: { userId, classroomId } },
    select: { assignedBy: true },
  });
  if (marker?.assignedBy === userId) return true;

  const legacy = await prisma.classroomAccess.findFirst({
    where: { classroomId, assignedBy: userId },
    select: { id: true },
  });
  if (legacy) return true;

  // Fallback: trust persisted classroom owner metadata and backfill marker.
  const classroom = await readClassroom(classroomId);
  if (classroom?.stage?.ownerUserId === userId) {
    await ensureClassroomOwnership(userId, classroomId);
    return true;
  }

  return false;
}

/** Unified classroom access check for all roles. */
export async function userHasClassroomAccess(userId: string, role: Role, classroomId: string) {
  const owns = await userOwnsClassroom(userId, classroomId);
  if (owns) return true;

  // Check DB-backed permissions for this role — any role with join_invited_classrooms
  // can access classrooms they have been explicitly invited/assigned to.
  const permissions = await getEffectivePermissions(role);
  if (permissions.includes('join_invited_classrooms')) {
    return studentHasClassroomAccess(userId, classroomId);
  }

  return false;
}
