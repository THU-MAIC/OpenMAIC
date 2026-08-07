'use client';

import { useRef, useState } from 'react';
import type { AudioInsertLabels, AudioInsertResult } from '../types';

export interface AudioInsertPickerProps {
  readonly labels: AudioInsertLabels;
  readonly onInsert: (result: AudioInsertResult) => void;
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

/** Browser-only audio source picker; persistence is delegated through `onInsert`. */
export function AudioInsertPicker({ labels, onInsert }: AudioInsertPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');

  const insertFile = async (file: File | undefined) => {
    if (!file || !file.type.startsWith('audio/')) return;
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
    <div className="maic-editing-ui-audio-insert-picker">
      <button
        type="button"
        className="maic-editing-ui-audio-dropzone"
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void insertFile(event.dataTransfer.files?.[0]);
        }}
      >
        {labels.audioDrop}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="maic-editing-ui-visually-hidden"
        onChange={(event) => void insertFile(event.target.files?.[0])}
      />
      <div className="maic-editing-ui-audio-or">{labels.audioOr}</div>
      <div className="maic-editing-ui-audio-url-row">
        <input
          type="url"
          value={url}
          aria-label={labels.audioUrlPlaceholder}
          placeholder={labels.audioUrlPlaceholder}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') insertUrl();
          }}
        />
        <button type="button" disabled={!url.trim()} onClick={insertUrl}>
          {labels.audioInsert}
        </button>
      </div>
    </div>
  );
}
