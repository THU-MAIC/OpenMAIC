'use client';

import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  X, 
  MessageSquare, 
  Bug, 
  Lightbulb, 
  Camera, 
  CheckCircle2, 
  Loader2, 
  AlertCircle,
  HelpCircle
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import html2canvas from 'html2canvas';
import { toast } from 'sonner';

type FeedbackType = 'bug' | 'feature' | 'other';

interface FeedbackModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FeedbackModal({ open, onOpenChange }: FeedbackModalProps) {
  const [type, setType] = useState<FeedbackType>('bug');
  const [content, setContent] = useState('');
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const captureScreenshot = async () => {
    setIsCapturing(true);
    // Hide the modal during capture if possible, but html2canvas usually captures the DOM.
    // We might need to hide the dialog overlay locally.
    try {
      // Small delay to let any animations settle
      await new Promise(r => setTimeout(r, 100));
      const canvas = await html2canvas(document.body, {
        ignoreElements: (el) => {
          // Ignore the modal content itself
          return el.getAttribute('data-slot') === 'dialog-content' || el.classList.contains('feedback-modal-ignore');
        },
        useCORS: true,
        scale: 0.5, // Reduced scale for performance
      });
      const dataUrl = canvas.toDataURL('image/png');
      setScreenshot(dataUrl);
    } catch (err) {
      console.error('Failed to capture screenshot:', err);
      toast.error('Could not capture screenshot');
    } finally {
      setIsCapturing(false);
    }
  };

  const handleSubmit = async () => {
    if (!content.trim()) return;

    setIsSubmitting(true);
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type,
          content,
          screenshot,
          url: window.location.href,
        }),
      });

      if (response.ok) {
        setIsSuccess(true);
        setTimeout(() => {
          onOpenChange(false);
          // Reset after closing
          setTimeout(() => {
            setIsSuccess(false);
            setContent('');
            setScreenshot(null);
            setType('bug');
          }, 300);
        }, 2000);
      } else {
        throw new Error('Failed to submit feedback');
      }
    } catch (err) {
      toast.error('Failed to submit feedback. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] p-0 overflow-hidden border-none bg-slate-50/90 dark:bg-slate-900/90 backdrop-blur-xl shadow-2xl">
        <DialogHeader className="p-6 pb-0">
          <DialogTitle className="text-2xl font-bold flex items-center gap-2 text-slate-900 dark:text-white">
            <MessageSquare className="w-6 h-6 text-indigo-500" />
            Give Feedback
          </DialogTitle>
          <DialogDescription className="text-slate-500 dark:text-slate-400">
            Tell us what's on your mind. We'd love to hear from you.
          </DialogDescription>
        </DialogHeader>

        <div className="p-6 space-y-6">
          {isSuccess ? (
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="py-12 flex flex-col items-center justify-center space-y-4"
            >
              <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center">
                <CheckCircle2 className="w-10 h-10 text-green-500" />
              </div>
              <p className="text-xl font-semibold text-slate-900 dark:text-white">Thank you!</p>
              <p className="text-slate-500 dark:text-slate-400 text-center">Your feedback helps us make Slate better for everyone.</p>
            </motion.div>
          ) : (
            <>
              {/* Type Selection */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { id: 'bug', icon: Bug, label: 'Bug', color: 'text-rose-500', bg: 'bg-rose-500/10' },
                  { id: 'feature', icon: Lightbulb, label: 'Feature', color: 'text-amber-500', bg: 'bg-amber-500/10' },
                  { id: 'other', icon: HelpCircle, label: 'Other', color: 'text-blue-500', bg: 'bg-blue-500/10' },
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setType(item.id as FeedbackType)}
                    className={cn(
                      "flex flex-col items-center justify-center p-3 rounded-xl border-2 transition-all duration-200",
                      type === item.id 
                        ? "border-indigo-500 bg-white dark:bg-slate-800 shadow-md transform scale-[1.02]" 
                        : "border-transparent bg-slate-200/50 dark:bg-slate-800/50 hover:bg-slate-200 dark:hover:bg-slate-800"
                    )}
                  >
                    <item.icon className={cn("w-6 h-6 mb-1", item.color)} />
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{item.label}</span>
                  </button>
                ))}
              </div>

              {/* Text Area */}
              <div className="space-y-2">
                <Textarea
                  placeholder={
                    type === 'bug' ? "What happened? How can we reproduce it?" :
                    type === 'feature' ? "What would you like to see? How would it help you?" :
                    "What's on your mind?"
                  }
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  className="min-h-[120px] bg-white dark:bg-slate-800/80 border-slate-200 dark:border-slate-700 focus:ring-indigo-500 resize-none rounded-xl"
                />
              </div>

              {/* Screenshot Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-300 flex items-center gap-2">
                    <Camera className="w-4 h-4" />
                    Include Screenshot
                  </label>
                  {screenshot && (
                    <button 
                      onClick={() => setScreenshot(null)}
                      className="text-xs text-rose-500 hover:underline font-medium"
                    >
                      Remove
                    </button>
                  )}
                </div>

                {screenshot ? (
                  <div className="relative group rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-black/5">
                    <img src={screenshot} alt="Screenshot preview" className="w-full h-auto max-h-[200px] object-contain" />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                       <Button variant="secondary" size="sm" onClick={captureScreenshot} className="gap-2">
                         <Camera className="w-4 h-4" />
                         Retake
                       </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full h-20 border-dashed border-2 rounded-xl border-slate-300 dark:border-slate-700 hover:border-indigo-400 hover:bg-indigo-50/50 dark:hover:bg-indigo-500/10 flex flex-col gap-1 transition-all"
                    onClick={captureScreenshot}
                    disabled={isCapturing}
                  >
                    {isCapturing ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
                        <span className="text-xs text-slate-500">Capturing...</span>
                      </>
                    ) : (
                      <>
                        <Camera className="w-5 h-5 text-slate-400" />
                        <span className="text-xs text-slate-500">Click to capture screenshot</span>
                      </>
                    )}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>

        {!isSuccess && (
          <DialogFooter className="p-6 bg-slate-100/50 dark:bg-slate-900/50 border-t border-slate-200 dark:border-slate-800">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button 
              onClick={handleSubmit} 
              disabled={isSubmitting || !content.trim()}
              className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-500/20 px-8 rounded-full"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                'Submit Feedback'
              )}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
