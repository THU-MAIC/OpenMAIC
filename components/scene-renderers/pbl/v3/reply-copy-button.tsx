'use client';

import { Check, Copy } from 'lucide-react';
import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/hooks/use-i18n';

export function ReplyCopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const locked = useRef(false);
  const [copied, setCopied] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      locked.current = false;
      setCopied(false);
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy(event: MouseEvent<HTMLButtonElement>) {
    const button = event.currentTarget;
    if (locked.current) return;
    locked.current = true;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (button.matches(':hover') && window.matchMedia('(hover: hover)').matches) {
        setTooltipOpen(true);
      }
    } catch {
      locked.current = false;
    }
  }

  const label = t(copied ? 'workbench.chat.copied' : 'workbench.chat.copyReply');
  return (
    <div className="flex items-center">
      <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground [&_svg]:pointer-events-none"
            aria-label={label}
            aria-disabled={copied}
            onClick={copy}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={5}>
          {label}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
