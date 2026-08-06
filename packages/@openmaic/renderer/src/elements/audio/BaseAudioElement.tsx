'use client';

import { Volume2 } from 'lucide-react';
import type { PPTAudioElement } from '@openmaic/dsl';

function getAudioLabel(src: string): string {
  if (!src) return 'Audio unavailable';
  const path = src.split(/[?#]/, 1)[0];
  const name = path.split('/').pop();
  return name || 'Audio';
}

export interface BaseAudioElementProps {
  readonly elementInfo: PPTAudioElement;
}

/** A non-interactive visual shell; editing controls live in `editing-ui`. */
export function BaseAudioElement({ elementInfo }: BaseAudioElementProps) {
  const label = getAudioLabel(elementInfo.src);
  const available = Boolean(elementInfo.src);

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
      <div
        style={{
          alignItems: 'center',
          background: available ? '#f5f3ff' : '#f4f4f5',
          border: `1px solid ${available ? elementInfo.color : '#d4d4d8'}`,
          borderRadius: '6px',
          color: available ? elementInfo.color : '#71717a',
          display: 'flex',
          gap: '10px',
          height: '100%',
          minWidth: 0,
          padding: '10px 12px',
          transform: `rotate(${elementInfo.rotate}deg)`,
          width: '100%',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            alignItems: 'center',
            background: available ? 'rgb(124 58 237 / 12%)' : '#e4e4e7',
            borderRadius: '50%',
            display: 'inline-flex',
            flex: '0 0 auto',
            height: '28px',
            justifyContent: 'center',
            width: '28px',
          }}
        >
          <Volume2 size={16} />
        </span>
        <span
          style={{
            fontSize: '13px',
            fontWeight: 600,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}
