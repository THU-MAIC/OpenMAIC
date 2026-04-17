'use client';

import { Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface WizardTopBarProps {
  title: string;
  entityLabel: string;
  hasUnsavedChanges: boolean;
  isSaving: boolean;
  onSaveDraft?: () => Promise<void>;
}

export function WizardTopBar({
  title,
  entityLabel,
  hasUnsavedChanges,
  isSaving,
  onSaveDraft,
}: WizardTopBarProps) {
  return (
    <div className="sticky top-0 z-20 mb-4 flex items-center justify-between rounded-xl border border-white/10 bg-slate-900/90 p-3 backdrop-blur">
      <div>
        <p className="text-xs uppercase tracking-wider text-slate-400">{entityLabel}</p>
        <h1 className="text-lg font-semibold text-white">{title}</h1>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400">{hasUnsavedChanges ? 'Unsaved changes' : 'All changes saved'}</span>
        {onSaveDraft && (
          <Button type="button" variant="outline" onClick={() => void onSaveDraft()} disabled={isSaving} className="gap-1.5 border-white/10 text-slate-200">
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save draft
          </Button>
        )}
      </div>
    </div>
  );
}
