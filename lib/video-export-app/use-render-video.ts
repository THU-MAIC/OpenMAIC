'use client';

/**
 * `useRenderVideo` — thin React facade over the global {@link useVideoRenderStore}.
 *
 * The render lifecycle (build ZIP → upload → poll → download) and the selected
 * options both live in the store, so they survive the export menu unmounting
 * (scene switches, menu close) and can be observed from anywhere — e.g. the
 * persistent ring on the export button. This hook just binds `t` and re-exports
 * the reactive slice the menu needs.
 */
import { useCallback } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useVideoRenderStore } from '@/lib/store/video-render';

export function useRenderVideo() {
  const { t } = useI18n();
  const status = useVideoRenderStore((s) => s.status);
  const percent = useVideoRenderStore((s) => s.percent);
  const etaMs = useVideoRenderStore((s) => s.etaMs);
  const options = useVideoRenderStore((s) => s.options);
  const setOptions = useVideoRenderStore((s) => s.setOptions);
  const startRender = useVideoRenderStore((s) => s.startRender);

  const renderVideo = useCallback(() => startRender(t), [startRender, t]);

  return {
    rendering: status === 'compiling' || status === 'rendering',
    percent,
    etaMs,
    options,
    setOptions,
    renderVideo,
  };
}
