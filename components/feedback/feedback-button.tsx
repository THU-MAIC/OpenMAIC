'use client';

import React, { useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FeedbackModal } from './feedback-modal';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface FeedbackButtonProps {
  className?: string;
  variant?: 'outline' | 'ghost' | 'default' | 'pill';
  showLabel?: boolean;
}

export function FeedbackButton({ className, variant = 'outline', showLabel = false }: FeedbackButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          {variant === 'pill' ? (
            <button
              onClick={() => setOpen(true)}
              className={cn(
                "flex items-center gap-2 h-9 px-4 rounded-full border-2 border-[#073b4c] bg-white text-[#073b4c] font-bold text-xs hover:translate-y-[-1px] shadow-[3px_3px_0_#073b4c] hover:shadow-[4px_4px_0_#073b4c] transition-all cursor-pointer active:translate-y-0 active:shadow-[1px_1px_0_#073b4c]",
                className
              )}
            >
              <MessageSquarePlus className="size-3.5" />
              {showLabel && "Feedback"}
            </button>
          ) : (
            <Button
              variant={variant}
              onClick={() => setOpen(true)}
              className={cn(
                "rounded-full transition-all",
                variant === 'outline' && "border-[#073b4c]/20 hover:border-[#073b4c]/40 hover:bg-[#073b4c]/5",
                className
              )}
              size={showLabel ? 'default' : 'icon'}
            >
              <MessageSquarePlus className={cn("size-4", showLabel && "mr-2")} />
              {showLabel && "Feedback"}
            </Button>
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>Give feedback or report a bug</p>
        </TooltipContent>
      </Tooltip>

      <FeedbackModal open={open} onOpenChange={setOpen} />
    </>
  );
}
