/**
 * Permission definitions for RBAC system (Phase 2A)
 * Permissions are grouped by resource category
 */

export const PERMISSION_CATEGORIES = {
  users: {
    label: 'User Management',
    permissions: {
      view_users: 'View users',
      create_users: 'Create users',
      edit_users: 'Edit users',
      delete_users: 'Delete users',
    },
  },
  own_classrooms: {
    label: 'Own Classrooms',
    permissions: {
      view_own_classrooms: 'View own classrooms',
      create_own_classrooms: 'Create new classrooms',
      edit_own_classrooms: 'Edit own classrooms',
      delete_own_classrooms: 'Delete own classrooms',
      create_students_own_classrooms: 'Create students for own classrooms',
    },
  },
  invited_classrooms: {
    label: 'Invited Classrooms',
    permissions: {
      view_invited_classrooms: 'View classrooms you are invited to',
      join_invited_classrooms: 'Join and participate in invited classrooms',
    },
  },
  audit: {
    label: 'Audit & Monitoring',
    permissions: {
      view_audit_logs: 'View audit logs',
    },
  },
  roles: {
    label: 'Role Management',
    permissions: {
      view_roles: 'View roles',
      create_roles: 'Create custom roles',
      edit_roles: 'Edit custom roles',
      delete_roles: 'Delete custom roles',
    },
  },
  system: {
    label: 'System Configuration',
    permissions: {
      manage_system_config: 'Manage system configuration',
    },
  },
  prompts: {
    label: 'AI Prompt Studio',
    permissions: {
      view_prompts: 'View prompts',
      create_prompts: 'Create prompts',
      edit_prompts: 'Edit prompts',
      delete_prompts: 'Delete prompts',
      publish_prompts: 'Publish/activate prompts',
    },
  },
} as const;

/** All available permission keys */
export const ALL_PERMISSIONS = Object.values(PERMISSION_CATEGORIES).flatMap((cat) =>
  Object.keys(cat.permissions),
);

/** Default permissions for built-in roles */
export const DEFAULT_BUILT_IN_ROLES = {
  ADMIN: {
    displayName: 'Administrator',
    description: 'Full system access',
    permissions: ALL_PERMISSIONS,
  },
  INSTRUCTOR: {
    displayName: 'Instructor',
    description: 'Classroom and student management',
    permissions: [
      'view_users',
      'view_own_classrooms',
      'create_own_classrooms',
      'edit_own_classrooms',
      'create_students_own_classrooms',
      'view_audit_logs',
      'view_prompts',
    ],
  },
  STUDENT: {
    displayName: 'Student',
    description: 'Access to assigned classrooms',
    permissions: ['view_invited_classrooms', 'join_invited_classrooms'],
  },
} as const;

/**
 * Check if a user has a specific permission
 * Currently checks the session role; in Phase 2B can check RoleDefinition
 */
export function hasPermission(userRole: string, permission: string): boolean {
  if (userRole === 'ADMIN') {
    return true; // Admins always have all permissions
  }
  // For INSTRUCTOR and STUDENT, check against DEFAULT_BUILT_IN_ROLES
  const defaultPerms = DEFAULT_BUILT_IN_ROLES[userRole as keyof typeof DEFAULT_BUILT_IN_ROLES];
  return defaultPerms ? defaultPerms.permissions.includes(permission as never) : false;
}
