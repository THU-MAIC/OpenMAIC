'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';

export function ReplyCopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const locked = useRef(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      locked.current = false;
      setCopied(false);
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    if (locked.current) return;
    locked.current = true;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      locked.current = false;
    }
  }

  const label = t(copied ? 'workbench.chat.copied' : 'workbench.chat.copyReply');
  return (
    <div className="flex items-center">
      <button
        type="button"
        className="inline-flex items-center rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        aria-label={label}
        aria-disabled={copied}
        onClick={copy}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}
