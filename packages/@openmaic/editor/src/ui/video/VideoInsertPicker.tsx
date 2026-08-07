'use client';

import { useRef, useState } from 'react';
import type { VideoInsertLabels, VideoInsertResult } from '../types';

export interface VideoInsertPickerProps {
  readonly labels: VideoInsertLabels;
  readonly onInsert: (result: VideoInsertResult) => void;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function extensionFrom(value: string): string | undefined {
  const withoutQuery = value.split(/[?#]/, 1)[0];
  const extension = withoutQuery.split('.').pop()?.toLowerCase();
  return extension && extension !== withoutQuery ? extension : undefined;
}

/**
 * Generic browser-only insertion control. It owns selection and data-url
 * reading, while the host owns media upload policy and document persistence.
 */
export function VideoInsertPicker({ labels, onInsert }: VideoInsertPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');

  const insertFile = async (file: File | undefined) => {
    if (!file || !file.type.startsWith('video/')) return;
    try {
      onInsert({ src: await fileToDataUrl(file), ext: extensionFrom(file.name) });
    } catch {
      // A cancelled or unreadable local file should leave the picker open.
    }
  };

  const insertUrl = () => {
    const src = url.trim();
    if (!src) return;
    onInsert({ src, ext: extensionFrom(src) });
  };

  return (
    <div className="maic-editing-ui-video-insert-picker">
      <button
        type="button"
        className="maic-editing-ui-video-dropzone"
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void insertFile(event.dataTransfer.files?.[0]);
        }}
      >
        {labels.videoDrop}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="maic-editing-ui-visually-hidden"
        onChange={(event) => void insertFile(event.target.files?.[0])}
      />
      <div className="maic-editing-ui-video-or">{labels.videoOr}</div>
      <div className="maic-editing-ui-video-url-row">
        <input
          type="url"
          value={url}
          aria-label={labels.videoUrlPlaceholder}
          placeholder={labels.videoUrlPlaceholder}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') insertUrl();
          }}
        />
        <button type="button" disabled={!url.trim()} onClick={insertUrl}>
          {labels.videoInsert}
        </button>
      </div>
    </div>
  );
}
