'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, CameraOff, SwitchCamera, X } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  registerClassroomCameraCapture,
  type ClassroomCameraSnapshot,
} from '@/lib/live-tutor/classroom-camera-bridge';
import { cn } from '@/lib/utils';

interface InlineQACameraPreviewProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

function InlineQACameraPreviewBody({ onClose }: { readonly onClose: () => void }) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const pausedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const stopTracks = () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };

    const boot = async () => {
      stopTracks();
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        if (!cancelled) setError('Camera is not supported in this browser.');
        return;
      }
      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: facingMode },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        if (!cancelled) {
          setError(null);
          setReady(true);
        }
      } catch {
        if (!cancelled) {
          setReady(false);
          setError('Camera permission is required so the teacher can see your notebook.');
        }
      }
    };

    void boot();
    return () => {
      cancelled = true;
      stopTracks();
    };
  }, [facingMode]);

  const captureSnapshot = useCallback((): ClassroomCameraSnapshot | null => {
    if (pausedRef.current) return null;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) return null;
    const maxDim = 960;
    const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
    const data = dataUrl.split(',')[1];
    if (!data) return null;
    return { data, mimeType: 'image/jpeg' };
  }, []);

  useEffect(() => {
    return registerClassroomCameraCapture(captureSnapshot);
  }, [captureSnapshot]);

  return createPortal(
    <div
      data-testid="inline-qa-camera-preview"
      className="fixed bottom-24 left-4 z-[60] w-[min(280px,calc(100vw-32px))] rounded-2xl overflow-hidden border border-violet-300/70 dark:border-violet-700/70 bg-gray-950/95 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.45)] backdrop-blur-xl"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-black/50 border-b border-white/10">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-300 truncate">
          <span
            className={cn(
              'size-2 rounded-full shrink-0',
              ready && !paused ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400',
            )}
          />
          {t('liveTutor.watchingNotebook')}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => {
              setReady(false);
              setFacingMode((f) => (f === 'environment' ? 'user' : 'environment'));
            }}
            title={t('liveTutor.flipCamera')}
            className="p-1 rounded-lg text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
          >
            <SwitchCamera className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setPaused((p) => {
                const next = !p;
                pausedRef.current = next;
                return next;
              });
            }}
            title={paused ? t('liveTutor.resumeCamera') : t('liveTutor.pauseCamera')}
            className={cn(
              'p-1 rounded-lg transition-colors',
              paused
                ? 'text-amber-300 bg-amber-500/20'
                : 'text-gray-300 hover:text-white hover:bg-white/10',
            )}
          >
            {paused ? <CameraOff className="size-3.5" /> : <Camera className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t('common.close')}
            className="p-1 rounded-lg text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="relative aspect-[4/3] bg-gray-950 flex items-center justify-center">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={cn('w-full h-full object-cover', (paused || error) && 'opacity-25')}
        />
        <canvas ref={canvasRef} className="hidden" />
        {error && (
          <p className="absolute inset-0 flex items-center justify-center p-3 text-center text-[11px] text-red-300">
            {error}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Compact live notebook camera preview rendered while the student has Camera
 * toggled ON inside Classroom Q&A / Discussion. Registers its frame capture
 * callback with `classroom-camera-bridge` so every spoken or typed Q&A turn
 * automatically sends the student's notebook image to the same AI Teacher.
 */
export function InlineQACameraPreview({ open, onClose }: InlineQACameraPreviewProps) {
  if (!open || typeof document === 'undefined') return null;
  return <InlineQACameraPreviewBody onClose={onClose} />;
}
