'use client';

import type { ReactNode } from 'react';
import type { PPTVideoElement } from '@openmaic/dsl';

export interface BaseVideoElementProps {
  elementInfo: PPTVideoElement;
  /**
   * Optional render slot: replace the default <video> with custom content.
   * Lets consumers inject placeholders, retry UI, lazy media resolvers, or
   * controlled playback bound to their own orchestration state.
   * When omitted, the package renders a plain <video src controls preload="metadata">.
   */
  renderVideo?: (element: PPTVideoElement) => ReactNode;
}

export function BaseVideoElement({ elementInfo, renderVideo }: BaseVideoElementProps) {
  return (
    <div
      className="element-content"
      data-video-element
      style={{
        position: 'absolute',
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          transform: `rotate(${elementInfo.rotate}deg)`,
        }}
      >
        {renderVideo ? (
          renderVideo(elementInfo)
        ) : elementInfo.src || elementInfo.poster ? (
          // Render <video> when we have either a playable src OR just a
          // poster/preview frame. A PPTX「视频」often has no decodable src in
          // this pipeline but does carry a preview image; rendering
          // <video poster> still shows that frame on the live canvas (instead
          // of falling through to the gray play-icon placeholder — slide 34).
          // Snapshot capture of the poster frame is handled in slideToPng
          // (html2canvas can't draw <video> directly).
          <video
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            {...(elementInfo.src ? { src: elementInfo.src } : {})}
            poster={elementInfo.poster}
            preload="metadata"
            controls={!!elementInfo.src}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(0, 0, 0, 0.1)',
              borderRadius: '4px',
            }}
          >
            <svg
              style={{ width: '48px', height: '48px', color: '#9ca3af' }}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}
