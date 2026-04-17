import { prisma } from '@/lib/auth/prisma';
import { requirePermissions, writeAuditLog } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { ALL_PERMISSIONS } from '@/lib/admin/permissions';
import { ensureBuiltInRoles } from '@/lib/admin/role-definitions';

const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[a-z_]+$/, 'Name must be lowercase letters and underscores'),
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  permissions: z.array(z.string()).default([]),
});

/** GET /api/admin/system-config/roles */
export async function GET() {
  try {
    await requirePermissions('view_roles');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await ensureBuiltInRoles();

  const roles = await prisma.roleDefinition.findMany({
    orderBy: [{ isBuiltIn: 'desc' }, { name: 'asc' }],
  });

  return NextResponse.json({ roles });
}

/** POST /api/admin/system-config/roles */
export async function POST(req: NextRequest) {
  let session;
  try {
    session = await requirePermissions('create_roles');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const parsed = createRoleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const { name, displayName, description, permissions } = parsed.data;

  // Validate all permissions exist
  const invalidPerms = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
  if (invalidPerms.length > 0) {
    return NextResponse.json({ error: `Invalid permissions: ${invalidPerms.join(', ')}` }, { status: 400 });
  }

  // Check if role already exists
  const existing = await prisma.roleDefinition.findUnique({ where: { name } });
  if (existing) {
    return NextResponse.json({ error: 'Role name already exists' }, { status: 409 });
  }

  const role = await prisma.roleDefinition.create({
    data: { name, displayName, description: description || null, permissions, isBuiltIn: false },
  });

  void writeAuditLog({
    actorId: session.user.id,
    action: 'role.create',
    resource: 'RoleDefinition',
    resourceId: role.id,
    details: { name, displayName, permissions },
    req,
  });

  return NextResponse.json({ role }, { status: 201 });
}
