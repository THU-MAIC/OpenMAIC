'use client';

import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface WizardFooterNavProps {
  canGoNext: boolean;
  isSaving: boolean;
  onBack?: () => void;
  onNext?: () => void;
  backLabel?: string;
  nextLabel?: string;
}

export function WizardFooterNav({
  canGoNext,
  isSaving,
  onBack,
  onNext,
  backLabel = 'Back',
  nextLabel = 'Next',
}: WizardFooterNavProps) {
  return (
    <div className="mt-6 flex items-center justify-between rounded-xl border border-white/10 bg-white/5 p-3">
      <Button type="button" variant="outline" className="gap-1.5 border-white/10 text-slate-200" onClick={onBack} disabled={!onBack || isSaving}>
        <ArrowLeft className="h-4 w-4" />
        {backLabel}
      </Button>
      <Button type="button" onClick={onNext} disabled={!canGoNext || isSaving} className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/80">
        {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
        {nextLabel}
      </Button>
    </div>
  );
}
