'use client';

import { useEffect, useRef, useState } from 'react';
import type { EditorAsset, EditorError } from '../host';
import type { EditorLabels } from '../labels';
import { readImageDimensions } from './imageDimensions';

export interface DefaultAssetPickerProps {
  readonly accept: string;
  readonly labels: EditorLabels['asset'];
  readonly onPick: (asset: EditorAsset) => void;
  readonly onError?: (error: EditorError) => void;
}

function extensionFrom(value: string): string | undefined {
  const withoutQuery = value.split(/[?#]/, 1)[0];
  const extension = withoutQuery.split('.').pop()?.toLowerCase();
  return extension && extension !== withoutQuery ? extension : undefined;
}

function matchesAccept(file: File, accept: string): boolean {
  return accept.split(',').some((entry) => {
    const expected = entry.trim();
    if (expected.endsWith('/*')) return file.type.startsWith(expected.slice(0, -1));
    if (expected.startsWith('.')) return file.name.toLowerCase().endsWith(expected.toLowerCase());
    return file.type === expected;
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function DefaultAssetPicker({ accept, labels, onPick, onError }: DefaultAssetPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const [url, setUrl] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const deliver = async (src: string, ext?: string) => {
    const dimensions = accept.split(',').some((entry) => entry.trim().startsWith('image/'))
      ? await readImageDimensions(src)
      : undefined;
    if (mountedRef.current) onPick({ src, ext, ...dimensions });
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!matchesAccept(file, accept)) {
      onError?.({ code: 'asset-type-mismatch', message: labels.invalidType });
      return;
    }
    try {
      await deliver(await fileToDataUrl(file), extensionFrom(file.name));
    } catch (cause) {
      onError?.({ code: 'asset-read-failed', message: labels.readFailed, cause });
    }
  };

  const pickUrl = () => {
    const src = url.trim();
    if (!src) return;
    void deliver(src, extensionFrom(src));
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
          void pickFile(event.dataTransfer.files?.[0]);
        }}
      >
        {labels.drop}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="maic-editing-ui-visually-hidden"
        onChange={(event) => void pickFile(event.target.files?.[0])}
      />
      <div className="maic-editing-ui-video-or">{labels.orUrl}</div>
      <div className="maic-editing-ui-video-url-row">
        <input
          type="url"
          value={url}
          aria-label={labels.urlPlaceholder}
          placeholder={labels.urlPlaceholder}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') pickUrl();
          }}
        />
        <button type="button" disabled={!url.trim()} onClick={pickUrl}>
          {labels.insert}
        </button>
      </div>
    </div>
  );
}
