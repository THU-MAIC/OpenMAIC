'use client';

import { Loader2, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';

export function VoicePreviewButton({
  previewing,
  disabled,
  onClick,
}: {
  previewing?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const label = t(previewing ? 'settings.voxcpmStopPreview' : 'settings.voxcpmPreviewVoice');
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 text-muted-foreground opacity-70 hover:text-foreground group-hover:opacity-100"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {previewing ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Volume2 className="size-3.5" />
      )}
    </Button>
  );
}
