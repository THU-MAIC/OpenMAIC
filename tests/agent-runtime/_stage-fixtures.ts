/**
 * Shared stage-document fixtures for the route tests: a valid document, a
 * valid slide scene, and the outline envelope.
 */
import type { AppDocument, AppDocumentOutline } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';

/** A fixed clock so timestamps are assertable. */
export const FIXED_NOW = 1_700_000_000_000;

/** A minimal structurally valid slide scene. */
export function makeSlideScene(
  id: string,
  stageId: string,
  order: number,
  title = `Scene ${order}`,
): AppScene {
  return {
    id,
    stageId,
    order,
    title,
    type: 'slide',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${id}`,
        viewportSize: 1000,
        viewportRatio: 16 / 9,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#2563eb'],
          fontColor: '#111827',
          fontName: 'Inter',
        },
        elements: [],
      },
    },
  };
}

export function makeOutline(requirement: string): AppDocumentOutline {
  return {
    outlines: [],
    requirement,
    generationComplete: false,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

export function makeDocument(
  id: string,
  name: string,
  scenes: AppScene[] = [],
  outline: AppDocumentOutline = makeOutline(name),
): AppDocument {
  return {
    stage: { id, name, createdAt: FIXED_NOW, updatedAt: FIXED_NOW },
    scenes,
    outline,
  };
}
