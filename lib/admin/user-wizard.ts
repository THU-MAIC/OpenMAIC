import type { Role } from '@prisma/client';

export interface UserWizardDraft {
  name: string;
  email: string;
  role: Role;
  studentId: string;
  password: string;
  isActive: boolean;
  classroomIds: string[];
}

export const defaultUserWizardDraft: UserWizardDraft = {
  name: '',
  email: '',
  role: 'STUDENT',
  studentId: '',
  password: '',
  isActive: true,
  classroomIds: [],
};

export const userWizardSteps = [
  { id: 'identity', title: 'Identity', href: '/admin/users/new/identity' },
  { id: 'role', title: 'Role', href: '/admin/users/new/role' },
  { id: 'access', title: 'Access', href: '/admin/users/new/access' },
  { id: 'security', title: 'Security', href: '/admin/users/new/security' },
  { id: 'review', title: 'Review', href: '/admin/users/new/review' },
] as const;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&_\-#])/;

export function getIdentityErrors(draft: UserWizardDraft) {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push('Name is required.');
  if (!emailRegex.test(draft.email.trim())) errors.push('Valid email is required.');
  return errors;
}

export function getRoleErrors(draft: UserWizardDraft) {
  const errors: string[] = [];
  if (draft.role === 'STUDENT' && !draft.studentId.trim()) {
    errors.push('Student ID is required for student role.');
  }
  return errors;
}

export function getSecurityErrors(draft: UserWizardDraft) {
  const errors: string[] = [];
  if (draft.password.length < 10) {
    errors.push('Password must be at least 10 characters.');
  }
  if (draft.password && !passwordRegex.test(draft.password)) {
    errors.push('Password needs upper, lower, number, and special character.');
  }
  return errors;
}

export function canSubmitUserWizard(draft: UserWizardDraft) {
  return (
    getIdentityErrors(draft).length === 0 &&
    getRoleErrors(draft).length === 0 &&
    getSecurityErrors(draft).length === 0
  );
}
