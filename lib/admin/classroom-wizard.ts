export type ClassroomSourceType = 'blank' | 'template' | 'import';
export type ClassroomPacingMode = 'self_paced' | 'scheduled';

export interface ClassroomWizardDraft {
  classroomId: string;
  title: string;
  description: string;
  ownerUserId: string;
  sourceType: ClassroomSourceType;
  templateId: string;
  studentIds: string[];
  startAt: string;
  endAt: string;
  pacingMode: ClassroomPacingMode;
}

export const defaultClassroomWizardDraft: ClassroomWizardDraft = {
  classroomId: '',
  title: '',
  description: '',
  ownerUserId: '',
  sourceType: 'blank',
  templateId: '',
  studentIds: [],
  startAt: '',
  endAt: '',
  pacingMode: 'self_paced',
};

export const classroomWizardSteps = [
  { id: 'basics', title: 'Basics', href: '/admin/classrooms/new/basics' },
  { id: 'content', title: 'Content', href: '/admin/classrooms/new/content' },
  { id: 'access', title: 'Access', href: '/admin/classrooms/new/access' },
  { id: 'schedule', title: 'Schedule', href: '/admin/classrooms/new/schedule' },
  { id: 'review', title: 'Review', href: '/admin/classrooms/new/review' },
] as const;

const classroomIdRegex = /^[A-Za-z0-9_-]{3,64}$/;

export function getBasicsErrors(draft: ClassroomWizardDraft) {
  const errors: string[] = [];
  if (!classroomIdRegex.test(draft.classroomId.trim())) {
    errors.push('Classroom ID must be 3-64 chars and use letters, numbers, _ or -.');
  }
  if (!draft.title.trim()) errors.push('Title is required.');
  return errors;
}

export function getContentErrors(draft: ClassroomWizardDraft) {
  const errors: string[] = [];
  if (draft.sourceType === 'template' && !draft.templateId.trim()) {
    errors.push('Template ID is required for template source.');
  }
  return errors;
}

export function getScheduleErrors(draft: ClassroomWizardDraft) {
  const errors: string[] = [];
  if (draft.startAt && draft.endAt && new Date(draft.endAt).getTime() <= new Date(draft.startAt).getTime()) {
    errors.push('End date must be after start date.');
  }
  return errors;
}

export function canSubmitClassroomWizard(draft: ClassroomWizardDraft) {
  return (
    getBasicsErrors(draft).length === 0 &&
    getContentErrors(draft).length === 0 &&
    getScheduleErrors(draft).length === 0
  );
}
