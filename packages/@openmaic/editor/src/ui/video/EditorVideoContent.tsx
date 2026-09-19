import type { PPTVideoElement } from '@openmaic/dsl';
import { Play } from 'lucide-react';

const CONCRETE_URL = /^(https?:|data:|blob:|\/|\.\.?\/)/i;

export interface EditorVideoContentProps {
  readonly element: PPTVideoElement;
}

/** Inert media preview used while canvas gestures own pointer interaction. */
export function EditorVideoContent({ element }: EditorVideoContentProps) {
  const playableSrc = element.src && CONCRETE_URL.test(element.src) ? element.src : undefined;
  return (
    <div
      data-editor-video-preview=""
      style={{
        alignItems: 'center',
        background: 'rgba(0, 0, 0, 0.08)',
        display: 'flex',
        height: '100%',
        justifyContent: 'center',
        overflow: 'hidden',
        position: 'relative',
        width: '100%',
      }}
    >
      {element.poster ? (
        <img
          src={element.poster}
          alt=""
          draggable={false}
          style={{ height: '100%', objectFit: 'contain', width: '100%' }}
        />
      ) : playableSrc ? (
        <video
          src={playableSrc}
          muted
          playsInline
          preload="metadata"
          style={{ height: '100%', objectFit: 'contain', width: '100%' }}
        />
      ) : null}
      <span
        aria-hidden="true"
        style={{
          alignItems: 'center',
          background: 'rgba(0, 0, 0, 0.5)',
          borderRadius: '50%',
          color: '#fff',
          display: 'flex',
          fontSize: 22,
          height: 48,
          justifyContent: 'center',
          left: '50%',
          position: 'absolute',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 48,
        }}
      >
        <Play aria-hidden="true" fill="currentColor" size={24} />
      </span>
    </div>
  );
}
