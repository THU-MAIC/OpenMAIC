import { useMemo, type ReactNode } from 'react';
import type {
  PPTAudioElement,
  PPTImageElement,
  PPTLatexElement,
  PPTVideoElement,
} from '@openmaic/dsl';
import type { InsertToolbarItem } from '../types';
import { createAudioAdapter } from './audio';
import { createGenericAdapter } from './generic';
import { createImageAdapter } from './image';
import { useLatexAdapters } from './latex';
import { selectedEditableElement } from './shared';
import type { ElementAdapterContext, ElementEditorAdapter } from './types';
import { createVideoAdapter } from './video';

export function useHostElementEditorAdapters(context: ElementAdapterContext | null): {
  readonly insertItems: readonly InsertToolbarItem[];
  readonly overlays: readonly ReactNode[];
} {
  const selected = context ? selectedEditableElement(context) : null;
  const latexAdapters = useLatexAdapters(
    context,
    selected?.type === 'latex' ? (selected as PPTLatexElement) : null,
  );

  return useMemo(() => {
    if (!context) return { insertItems: [], overlays: [] };
    const adapters: ElementEditorAdapter[] = [
      ...latexAdapters,
      createVideoAdapter(
        context,
        selected?.type === 'video' ? (selected as PPTVideoElement) : null,
      ),
      createAudioAdapter(
        context,
        selected?.type === 'audio' ? (selected as PPTAudioElement) : null,
      ),
    ];

    if (selected?.type === 'image') {
      adapters.push(createImageAdapter(context, selected as PPTImageElement));
    } else if (selected && ['shape', 'table', 'chart'].includes(selected.type)) {
      adapters.push(createGenericAdapter(context, selected));
    }

    return {
      insertItems: adapters.flatMap((adapter) => (adapter.insertItem ? [adapter.insertItem] : [])),
      overlays: adapters.flatMap((adapter) => (adapter.overlay ? [adapter.overlay] : [])),
    };
  }, [context, latexAdapters, selected]);
}
