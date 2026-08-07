import type { ReactNode } from 'react';
import type { PPTElement } from '@openmaic/dsl';
import type { TextToolbarLocale } from './types';

export type EditorLocale = TextToolbarLocale;

export interface EditorAsset {
  readonly src: string;
  readonly ext?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface EditorAssetPickerRequest {
  readonly accept: string;
  readonly currentSrc?: string;
  readonly onPick: (asset: EditorAsset) => void;
  readonly close: () => void;
}

export interface EditorError {
  readonly code: 'asset-read-failed' | 'asset-type-mismatch' | 'invalid-asset-url';
  readonly message: string;
  readonly cause?: unknown;
}

export interface EditorHostCapabilities {
  readonly locale?: EditorLocale;
  readonly createElementId?: (type: PPTElement['type']) => string;
  readonly renderAssetPicker?: (request: EditorAssetPickerRequest) => ReactNode;
  readonly onError?: (error: EditorError) => void;
  readonly shortcutsEnabled?: boolean;
}

export interface ResolvedEditorHostCapabilities {
  readonly locale: EditorLocale;
  readonly createElementId: (type: PPTElement['type']) => string;
  readonly renderAssetPicker?: (request: EditorAssetPickerRequest) => ReactNode;
  readonly onError?: (error: EditorError) => void;
  readonly shortcutsEnabled: boolean;
}

let elementIdSequence = 0;

function createDefaultElementId(type: PPTElement['type']): string {
  elementIdSequence += 1;
  return `${type}-${Date.now().toString(36)}-${elementIdSequence.toString(36)}`;
}

export function resolveEditorHost(
  host: EditorHostCapabilities = {},
): ResolvedEditorHostCapabilities {
  return {
    locale: host.locale ?? 'en-US',
    createElementId: host.createElementId ?? createDefaultElementId,
    renderAssetPicker: host.renderAssetPicker,
    onError: host.onError,
    shortcutsEnabled: host.shortcutsEnabled ?? true,
  };
}
