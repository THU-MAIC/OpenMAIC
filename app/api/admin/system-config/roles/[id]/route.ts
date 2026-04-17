import { prisma } from '@/lib/auth/prisma';
import { requirePermissions, writeAuditLog } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { ALL_PERMISSIONS } from '@/lib/admin/permissions';
import { findRoleDefinitionById } from '@/lib/admin/role-definitions';

const updateRoleSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  permissions: z.array(z.string()).optional(),
});

/** GET /api/admin/system-config/roles/[id] */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePermissions('view_roles');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const role = await findRoleDefinitionById(id);
  if (!role) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ role });
}

/** PATCH /api/admin/system-config/roles/[id] */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let session;
  try {
    session = await requirePermissions('edit_roles');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const role = await findRoleDefinitionById(id);
  if (!role) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json();
  const parsed = updateRoleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const { displayName, description, permissions } = parsed.data;
  const updateData: Record<string, unknown> = {};

  if (displayName !== undefined) updateData.displayName = displayName;
  if (description !== undefined) updateData.description = description || null;
  if (permissions !== undefined) {
    // Validate all permissions exist
    const invalidPerms = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
    if (invalidPerms.length > 0) {
      return NextResponse.json({ error: `Invalid permissions: ${invalidPerms.join(', ')}` }, { status: 400 });
    }
    updateData.permissions = permissions;
  }

  const updated = await prisma.roleDefinition.update({ where: { id }, data: updateData as never });

  void writeAuditLog({
    actorId: session.user.id,
    action: 'role.update',
    resource: 'RoleDefinition',
    resourceId: id,
    details: { changes: Object.keys(updateData) },
    req,
  });

  return NextResponse.json({ role: updated });
}

/** DELETE /api/admin/system-config/roles/[id] */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let session;
  try {
    session = await requirePermissions('delete_roles');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const role = await findRoleDefinitionById(id);
  if (!role) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Cannot delete built-in roles
  if (role.isBuiltIn) {
    return NextResponse.json({ error: 'Cannot delete built-in roles' }, { status: 403 });
  }

  await prisma.roleDefinition.delete({ where: { id } });

  void writeAuditLog({
    actorId: session.user.id,
    action: 'role.delete',
    resource: 'RoleDefinition',
    resourceId: id,
    req,
  });

  return NextResponse.json({ success: true });
}
