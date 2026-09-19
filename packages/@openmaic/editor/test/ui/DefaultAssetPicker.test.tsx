// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultAssetPicker } from '../../src/ui/assets/DefaultAssetPicker';
import { resolveEditorLabels } from '../../src/ui/labels';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DefaultAssetPicker', () => {
  it('returns a trimmed URL and derives its extension', () => {
    const onPick = vi.fn();
    render(
      <DefaultAssetPicker
        accept="video/*"
        labels={resolveEditorLabels('en-US').asset}
        onPick={onPick}
      />,
    );

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: ' https://cdn.example.com/lesson.mp4?version=2 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));

    expect(onPick).toHaveBeenCalledWith({
      src: 'https://cdn.example.com/lesson.mp4?version=2',
      ext: 'mp4',
    });
  });

  it('rejects a file whose MIME type does not match accept', () => {
    const onPick = vi.fn();
    const onError = vi.fn();
    const { container } = render(
      <DefaultAssetPicker
        accept="image/*"
        labels={resolveEditorLabels('en-US').asset}
        onPick={onPick}
        onError={onError}
      />,
    );

    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(['audio'], 'lesson.mp3', { type: 'audio/mpeg' })] },
    });

    expect(onPick).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'asset-type-mismatch' }));
  });

  it('includes natural image dimensions for aspect-ratio-aware insertion', async () => {
    class TestImage {
      naturalWidth = 1200;
      naturalHeight = 600;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', TestImage);
    const onPick = vi.fn();
    render(
      <StrictMode>
        <DefaultAssetPicker
          accept="image/*"
          labels={resolveEditorLabels('en-US').asset}
          onPick={onPick}
        />
      </StrictMode>,
    );

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'https://cdn.example.com/cover.png' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));

    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith({
        src: 'https://cdn.example.com/cover.png',
        ext: 'png',
        width: 1200,
        height: 600,
      }),
    );
  });
});
