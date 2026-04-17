'use client';

import { ClassroomWizardProvider } from '@/lib/contexts/classroom-wizard-context';

const WIZARD_STEPS = [
  { id: 'basics', title: 'Basics', href: '/instructor/classrooms/new/step/basics' },
  { id: 'content', title: 'Content', href: '/instructor/classrooms/new/step/content' },
  { id: 'students', title: 'Students', href: '/instructor/classrooms/new/step/students' },
  { id: 'review', title: 'Review & Create', href: '/instructor/classrooms/new/step/review' },
];

export { WIZARD_STEPS };

export default function NewClassroomLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClassroomWizardProvider>
      {children}
    </ClassroomWizardProvider>
  );
}
