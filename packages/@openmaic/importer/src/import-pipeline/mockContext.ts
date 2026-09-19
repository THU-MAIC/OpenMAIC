import type { ImportContext } from './types';
import type { ShapePoolItem } from '../openmaic/configs/shapes';
import type { SlideTheme } from '@openmaic/dsl';
import { SHAPE_LIST } from '../openmaic/configs/shapes';

export function createMockImportContext(overrides: Partial<ImportContext> = {}): ImportContext {
  const shapeList: ShapePoolItem[] = [];
  for (const item of SHAPE_LIST) shapeList.push(...item.children);

  const theme: SlideTheme = {
    backgroundColor: '#fff',
    themeColors: [],
    fontColor: '#333',
    fontName: '',
    outline: {},
    shadow: { h: 0, v: 0, blur: 0, color: 'rgba(0,0,0,0)' },
  };

  return {
    ratio: 96 / 72,
    fixedViewport: false,
    viewportWidth: 960,
    theme,
    shapeList,
    uploadBase64Image: async (base64) => base64,
    uploadBlobMedia: async (blob) => URL.createObjectURL(blob),
    extractVideoFirstFrame: async () => null,
    ...overrides,
  };
}
