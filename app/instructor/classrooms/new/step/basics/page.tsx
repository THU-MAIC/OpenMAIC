'use client';

import { useRouter } from 'next/navigation';
import { useClassroomWizard } from '@/lib/contexts/classroom-wizard-context';
import { WizardShell } from '@/components/admin/wizard/WizardShell';
import { useI18n } from '@/lib/hooks/use-i18n';

export default function BasicsPage() {
  const router = useRouter();
  const { title, description, language, setTitle, setDescription, setLanguage } = useClassroomWizard();
  const { t } = useI18n();

  const STEPS = [
    { id: 'basics', title: t('classroomWizard.steps.basics'), href: '/instructor/classrooms/new/step/basics' },
    { id: 'content', title: t('classroomWizard.steps.content'), href: '/instructor/classrooms/new/step/content' },
    { id: 'students', title: t('classroomWizard.steps.students'), href: '/instructor/classrooms/new/step/students' },
    { id: 'schedule', title: t('classroomWizard.steps.schedule'), href: '/instructor/classrooms/new/step/schedule' },
    { id: 'review', title: t('classroomWizard.steps.review'), href: '/instructor/classrooms/new/step/review' },
  ];

  const canGoNext = title.trim().length > 0;

  return (
    <WizardShell
      title={t('classroomWizard.title')}
      entityLabel={t('classroomWizard.basics.stepLabel')}
      steps={STEPS}
      currentStepId="basics"
      stepState={{
        basics: canGoNext ? 'valid' : 'active',
        content: 'todo',
        students: 'todo',
        schedule: 'todo',
        review: 'todo',
      }}
      canGoNext={canGoNext}
      isSaving={false}
      hasUnsavedChanges={title.length > 0 || description.length > 0}
      backHref="/instructor/classrooms"
      backLabel={t('classroomWizard.backToClassrooms')}
      onNext={() => router.push('/instructor/classrooms/new/step/content')}
      nextLabel={t('classroomWizard.basics.next')}
    >
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-white">{t('classroomWizard.basics.sectionTitle')}</h2>
          <p className="mt-1 text-sm text-slate-400">
            {t('classroomWizard.basics.sectionDesc')}
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="title" className="mb-1.5 block text-sm font-medium text-slate-200">
              {t('classroomWizard.basics.titleLabel')} <span className="text-red-400">*</span>
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('classroomWizard.basics.titlePlaceholder')}
              maxLength={200}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              autoFocus
            />
            {title.trim().length === 0 && (
              <p className="mt-1 text-xs text-slate-500">{t('classroomWizard.basics.titleRequired')}</p>
            )}
          </div>

          <div>
            <label htmlFor="description" className="mb-1.5 block text-sm font-medium text-slate-200">
              {t('classroomWizard.basics.descriptionLabel')}
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('classroomWizard.basics.descriptionPlaceholder')}
              rows={4}
              maxLength={1000}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
            />
          </div>

          <div>
            <label htmlFor="language" className="mb-1.5 block text-sm font-medium text-slate-200">
              {t('classroomWizard.basics.languageLabel')}
            </label>
            <select
              id="language"
              value={language}
              onChange={(e) => setLanguage(e.target.value as 'en' | 'zh-CN' | 'th-TH')}
              className="rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="en">{t('classroomWizard.languages.en')}</option>
              <option value="zh-CN">{t('classroomWizard.languages.zhCN')}</option>
              <option value="th-TH">{t('classroomWizard.languages.thTH')}</option>
            </select>
          </div>
        </div>
      </div>
    </WizardShell>
  );
}
