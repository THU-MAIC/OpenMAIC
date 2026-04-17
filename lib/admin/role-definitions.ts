import { prisma } from '@/lib/auth/prisma';
import { DEFAULT_BUILT_IN_ROLES } from '@/lib/admin/permissions';

export async function ensureBuiltInRoles() {
  await Promise.all(
    Object.entries(DEFAULT_BUILT_IN_ROLES).map(([name, definition]) =>
      prisma.roleDefinition.upsert({
        where: { name },
        update: {
          isBuiltIn: true,
          // Keep persisted role permissions editable in Role Management.
          // Built-in rows are only marked as built-in here; permissions are
          // initialized on create and then managed by admins.
        },
        create: {
          name,
          displayName: definition.displayName,
          description: definition.description,
          permissions: [...definition.permissions],
          isBuiltIn: true,
        },
      }),
    ),
  );
}

export async function findRoleDefinitionById(id: string) {
  await ensureBuiltInRoles();
  return prisma.roleDefinition.findUnique({ where: { id } });
}