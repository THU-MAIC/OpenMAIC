import { TeacherWorkbench } from '@/components/teacher/TeacherWorkbench';
import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { isWorkbenchEntryEnabled } from '@/lib/workbench/entry-gate';

export const dynamic = 'force-dynamic';

export default function TeacherPage() {
  return (
    <TeacherWorkbench
      configured={isAgentRuntimeConfigured()}
      lessonPrepHref={isWorkbenchEntryEnabled() ? '/workspace' : '/'}
    />
  );
}
