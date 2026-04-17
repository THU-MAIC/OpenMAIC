'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { WizardFooterNav } from '@/components/admin/wizard/WizardFooterNav';
import { WizardStepSidebar, type WizardStep, type WizardStepState } from '@/components/admin/wizard/WizardStepSidebar';
import { WizardTopBar } from '@/components/admin/wizard/WizardTopBar';

interface WizardShellProps {
  title: string;
  entityLabel: string;
  steps: WizardStep[];
  currentStepId: string;
  stepState?: Partial<Record<string, WizardStepState>>;
  canGoNext: boolean;
  isSaving: boolean;
  hasUnsavedChanges: boolean;
  onSaveDraft?: () => Promise<void>;
  onNext?: () => void;
  onBack?: () => void;
  backHref?: string;
  nextLabel?: string;
  backLabel?: string;
  children: React.ReactNode;
}

export function WizardShell({
  title,
  entityLabel,
  steps,
  currentStepId,
  stepState,
  canGoNext,
  isSaving,
  hasUnsavedChanges,
  onSaveDraft,
  onNext,
  onBack,
  backHref,
  nextLabel,
  backLabel,
  children,
}: WizardShellProps) {
  const router = useRouter();

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedChanges]);

  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    if (backHref) {
      router.push(backHref);
      return;
    }
    router.back();
  };

  return (
    <div className="mx-auto max-w-6xl">
      <WizardTopBar
        title={title}
        entityLabel={entityLabel}
        hasUnsavedChanges={hasUnsavedChanges}
        isSaving={isSaving}
        onSaveDraft={onSaveDraft}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[280px_minmax(0,1fr)]">
        <WizardStepSidebar steps={steps} currentStepId={currentStepId} stepState={stepState} />
        <section className="rounded-xl border border-white/10 bg-white/5 p-4">
          {children}
          <WizardFooterNav
            canGoNext={canGoNext}
            isSaving={isSaving}
            onBack={handleBack}
            onNext={onNext}
            nextLabel={nextLabel}
            backLabel={backLabel}
          />
        </section>
      </div>
    </div>
  );
}
