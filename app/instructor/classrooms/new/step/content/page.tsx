'use client';

import { useRouter } from 'next/navigation';
import { Info } from 'lucide-react';
import { useClassroomWizard } from '@/lib/contexts/classroom-wizard-context';
import { WizardShell } from '@/components/admin/wizard/WizardShell';

const STEPS = [
  { id: 'basics', title: 'Basics', href: '/instructor/classrooms/new/step/basics' },
  { id: 'content', title: 'Content', href: '/instructor/classrooms/new/step/content' },
  { id: 'students', title: 'Students', href: '/instructor/classrooms/new/step/students' },
  { id: 'schedule', title: 'Schedule', href: '/instructor/classrooms/new/step/schedule' },
  { id: 'review', title: 'Review & Create', href: '/instructor/classrooms/new/step/review' },
];

export default function ContentPage() {
  const router = useRouter();
  const { title } = useClassroomWizard();

  return (
    <WizardShell
      title="New Classroom"
      entityLabel="Step 2 of 4"
      steps={STEPS}
      currentStepId="content"
      stepState={{ basics: 'valid', content: 'active', students: 'todo', schedule: 'todo', review: 'todo' }}
      canGoNext={true}
      isSaving={false}
      hasUnsavedChanges={false}
      onBack={() => router.push('/instructor/classrooms/new/step/basics')}
      backLabel="Back: Basics"
      onNext={() => router.push('/instructor/classrooms/new/step/students')}
      nextLabel="Next: Students"
    >
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-white">Content</h2>
          <p className="mt-1 text-sm text-slate-400">
            Slides and scenes are imported into your classroom after creation through the AI
            generation canvas.
          </p>
        </div>

        <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-5 flex gap-4">
          <Info className="w-5 h-5 text-indigo-400 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-slate-300 space-y-2">
            <p className="font-medium text-white">How to add content</p>
            <ol className="list-decimal list-inside space-y-1 text-slate-400">
              <li>Create the classroom first (complete this wizard).</li>
              <li>
                Open the classroom in the <strong className="text-slate-200">AI Canvas</strong> —
                use the <em>Manage</em> button from the Classrooms list.
              </li>
              <li>Generate or import slides; the canvas will sync them here automatically.</li>
            </ol>
            <p className="text-slate-500 text-xs">
              Content importing during wizard creation is on the roadmap.
            </p>
          </div>
        </div>

        {title && (
          <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-300">
            Classroom: <span className="font-medium text-white">{title}</span>
          </div>
        )}
      </div>
    </WizardShell>
  );
}
