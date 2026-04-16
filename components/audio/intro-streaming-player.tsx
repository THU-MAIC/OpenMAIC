'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Volume2, VolumeX } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useSettingsStore } from '@/lib/store/settings';
import { playIntroSseStream, type IntroSseStatus } from '@/lib/generation/intro-sse-client';

interface IntroStreamingPlayerProps {
  stageId: string;
  name: string;
  description?: string;
  language?: string;
  onComplete?: () => void;
}

export const IntroStreamingPlayer: React.FC<IntroStreamingPlayerProps> = ({
  stageId,
  name,
  description,
  language = 'zh-CN',
  onComplete,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [script, setScript] = useState<string>('');
  const [status, setStatus] = useState<'idle' | IntroSseStatus>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;

  const selectedVoice = useSettingsStore((s) => s.ttsVoice);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;

    void (async () => {
      const result = await playIntroSseStream({
        stageId,
        name,
        description,
        language,
        voiceId: selectedVoice,
        signal: ac.signal,
        isMuted: () => isMutedRef.current,
        onScript: (text) => {
          if (!cancelled) setScript(text);
        },
        onStatus: (s) => {
          if (cancelled) return;
          setStatus(s);
          if (s === 'streaming') setIsPlaying(true);
        },
      });
      if (!cancelled && !ac.signal.aborted && result === 'completed') {
        onCompleteRef.current?.();
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [stageId, name, description, language, selectedVoice]);

  return (
    <AnimatePresence>
      {(status !== 'idle' && status !== 'completed') && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.05 }}
          className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[60] w-[90%] max-w-2xl"
        >
          <div className="bg-white/80 dark:bg-black/80 backdrop-blur-xl border border-white/20 dark:border-white/10 rounded-2xl p-6 shadow-2xl overflow-hidden relative group">
            <div className="absolute top-0 left-0 h-1 bg-primary/30 w-full overflow-hidden">
              <motion.div
                animate={{ x: ['-100%', '100%'] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
                className="h-full w-1/3 bg-primary"
              />
            </div>

            <div className="flex items-start gap-4">
              <div className="flex-shrink-0 mt-1">
                {status === 'generating' ? (
                  <Loader2 className="w-6 h-6 text-primary animate-spin" />
                ) : (
                  <div className="relative">
                    <Volume2 className={`w-6 h-6 text-primary ${isPlaying ? 'animate-pulse' : ''}`} />
                    {isMuted && <VolumeX className="absolute -top-1 -right-1 w-3 h-3 text-destructive" />}
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-semibold text-primary mb-1 uppercase tracking-wider flex items-center gap-2">
                  {status === 'generating' ? 'Preparing Intro...' : 'Now Speaking'}
                  {status === 'streaming' && (
                    <span className="flex gap-0.5 items-center">
                      {[1, 2, 3].map((i) => (
                        <motion.span
                          key={i}
                          animate={{ height: isPlaying ? [2, 10, 2] : 2 }}
                          transition={{ duration: 0.5, repeat: Infinity, delay: i * 0.1 }}
                          className="w-0.5 bg-primary inline-block rounded-full"
                        />
                      ))}
                    </span>
                  )}
                </h4>
                <div className="text-foreground text-base leading-relaxed line-clamp-3">
                  {script || 'Tuning in to your personal instructor...'}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setIsMuted((prev) => !prev)}
                className="flex-shrink-0 p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors"
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
              </button>
            </div>

            <div className="mt-4 flex justify-between items-center text-[10px] text-muted-foreground uppercase tracking-widest font-medium opacity-50">
              <span>Streaming Intro • {name}</span>
              <span>Priority Access</span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
