'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { X, Settings, Sparkles, Volume2, Workflow } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { GeneralSettings } from './general-settings';
import { SkillSettings } from './skill-settings';
import { ModelSettingsPanel } from './models';
import { VoiceSettings } from './voice-settings';
import type { SettingsSection } from '@/lib/types/settings';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: SettingsSection;
}

const SECTIONS: { id: SettingsSection; icon: typeof Settings; label: string }[] = [
  { id: 'models', icon: Workflow, label: 'settings.modelSettings.nav' },
  { id: 'voice', icon: Volume2, label: 'settings.voiceSettings.nav' },
  { id: 'skills', icon: Sparkles, label: 'settings.skills.nav' },
  { id: 'general', icon: Settings, label: 'settings.systemSettings' },
];

/**
 * The settings dialog. "Models" holds the workspace's model settings, which
 * live on the server; the other sections are the user's own preferences.
 */
export function SettingsDialog({ open, onOpenChange, initialSection }: SettingsDialogProps) {
  const { t } = useI18n();
  const [activeSection, setActiveSection] = useState<SettingsSection>('models');

  // Navigate to initialSection when dialog opens
  useEffect(() => {
    if (open && initialSection) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Sync section from the opener
      setActiveSection(initialSection);
    }
  }, [open, initialSection]);

  // Resizable sidebar width
  const [sidebarWidth, setSidebarWidth] = useState(192);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizeRef.current = { startX: e.clientX, startWidth: sidebarWidth };
      setIsResizing(true);
    },
    [sidebarWidth],
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current) return;
      const { startX, startWidth } = resizeRef.current;
      const delta = e.clientX - startX;
      const newWidth = Math.max(120, Math.min(360, startWidth + delta));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      resizeRef.current = null;
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing]);

  const getHeaderContent = () => {
    switch (activeSection) {
      case 'models':
        return (
          <div>
            <h2 className="text-lg font-semibold">{t('settings.modelSettings.title')}</h2>
            <p className="text-xs text-muted-foreground max-sm:hidden">
              {t('settings.modelSettings.description')}
            </p>
          </div>
        );
      case 'voice':
        return (
          <div>
            <h2 className="text-lg font-semibold">{t('settings.voiceSettings.title')}</h2>
            <p className="text-xs text-muted-foreground max-sm:hidden">
              {t('settings.voiceSettings.description')}
            </p>
          </div>
        );
      case 'general':
        return <h2 className="text-lg font-semibold">{t('settings.systemSettings')}</h2>;
      case 'skills':
        return (
          <>
            <Sparkles className="h-6 w-6 text-muted-foreground" />
            <h2 className="text-lg font-semibold">{t('settings.skills.title')}</h2>
          </>
        );
      default:
        return null;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[85vh] p-0 gap-0 block max-sm:h-[100dvh] max-sm:max-w-none max-sm:rounded-none"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{t('settings.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('settings.description')}</DialogDescription>
        {/* Below `sm` the nav becomes a strip above the panel. */}
        <div className="flex h-full flex-col overflow-hidden sm:flex-row">
          {/* Left Sidebar - Navigation */}
          <div
            className="flex flex-shrink-0 gap-1 overflow-x-auto border-b bg-muted/30 p-2 sm:block sm:w-[var(--settings-nav-width)] sm:space-y-1 sm:overflow-visible sm:border-b-0 sm:p-3"
            style={{ '--settings-nav-width': `${sidebarWidth}px` } as React.CSSProperties}
          >
            {SECTIONS.map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => setActiveSection(id)}
                className={cn(
                  'flex shrink-0 items-center gap-3 whitespace-nowrap px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0 sm:w-full sm:whitespace-normal',
                  activeSection === id
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'hover:bg-muted',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{t(label)}</span>
              </button>
            ))}
          </div>

          {/* Sidebar resize handle */}
          <div
            onMouseDown={(e) => handleResizeStart(e)}
            className="hidden flex-shrink-0 w-[5px] cursor-col-resize group sm:flex justify-center"
          >
            <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
          </div>

          {/* Right - Configuration Panel */}
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            {/* Header */}
            <div className="flex items-center justify-between gap-3 border-b p-4 sm:p-5">
              <div className="flex items-center gap-3">{getHeaderContent()}</div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Content */}
            <div
              className={cn(
                'p-3 sm:p-5',
                activeSection === 'models'
                  ? 'flex min-h-0 flex-1 flex-col pt-3'
                  : 'flex-1 overflow-y-auto',
              )}
            >
              {activeSection === 'models' && <ModelSettingsPanel />}

              {activeSection === 'voice' && (
                <VoiceSettings onOpenModels={() => setActiveSection('models')} />
              )}

              {activeSection === 'general' && <GeneralSettings />}

              {activeSection === 'skills' && <SkillSettings />}
            </div>

            {/* Footer: every change is saved as it is made; only close here. */}
            <div className="flex items-center justify-end gap-3 px-5 py-3 border-t bg-muted/30">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {t('settings.close')}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
