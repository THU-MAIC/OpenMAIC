'use client';

import { Pause, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PPTAudioElement } from '@openmaic/dsl';

export interface BaseAudioElementProps {
  readonly elementInfo: PPTAudioElement;
}

/**
 * The audio affordance belongs to the renderer rather than the editor UI so
 * read-only slide previews can play it directly. Editing mode layers its hit
 * targets above this button, keeping selection and transform gestures intact.
 */
export function BaseAudioElement({ elementInfo }: BaseAudioElementProps) {
  const available = Boolean(elementInfo.src);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
  }, []);

  useEffect(() => stop, [elementInfo.id, elementInfo.src, stop]);

  const togglePlayback = useCallback(async () => {
    if (!elementInfo.src) return;

    if (playing) {
      stop();
      return;
    }

    const audio = new Audio(elementInfo.src);
    audio.loop = elementInfo.loop;
    audio.onended = stop;
    audio.onerror = stop;
    audioRef.current = audio;
    try {
      await audio.play();
      setPlaying(true);
    } catch {
      stop();
    }
  }, [elementInfo.loop, elementInfo.src, playing, stop]);

  return (
    <div
      className="base-element-audio element-content"
      data-audio-element=""
      style={{
        height: `${elementInfo.height}px`,
        left: `${elementInfo.left}px`,
        pointerEvents: 'none',
        position: 'absolute',
        top: `${elementInfo.top}px`,
        width: `${elementInfo.width}px`,
      }}
    >
      <button
        type="button"
        aria-label={playing ? 'Pause audio' : 'Play audio'}
        aria-pressed={playing}
        disabled={!available}
        onClick={() => void togglePlayback()}
        style={{
          alignItems: 'center',
          background: playing ? elementInfo.color : 'transparent',
          border: 0,
          borderRadius: '50%',
          color: playing ? '#ffffff' : available ? elementInfo.color : '#a1a1aa',
          cursor: available ? 'pointer' : 'not-allowed',
          display: 'flex',
          height: '40px',
          justifyContent: 'center',
          left: '50%',
          padding: 0,
          pointerEvents: 'auto',
          position: 'absolute',
          top: '50%',
          transform: `rotate(${elementInfo.rotate}deg)`,
          translate: '-50% -50%',
          transition: 'background-color 120ms ease, color 120ms ease',
          width: '40px',
        }}
      >
        {playing ? (
          <Pause aria-hidden="true" size={22} />
        ) : (
          <Volume2 aria-hidden="true" size={28} />
        )}
      </button>
    </div>
  );
}
