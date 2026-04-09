import type { SlideTheme } from '../../../lib/types/slides';
import { mockOutlines } from './scene-outlines';

/** Default theme matching lib/types/slides.ts:SlideTheme */
const defaultTheme: SlideTheme = {
  backgroundColor: '#ffffff',
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
  fontColor: '#333333',
  fontName: 'Microsoft Yahei',
};

/** Mock response for POST /api/generate/scene-content */
export const mockSceneContentResponse = {
  success: true,
  content: {
    type: 'slide',
    canvas: {
      id: 'slide-0',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: defaultTheme,
      elements: [
        {
          type: 'text',
          id: 'title-el',
          content: '光合作用的基本概念',
          left: 50,
          top: 50,
          width: 900,
          height: 100,
        },
      ],
    },
  },
  effectiveOutline: mockOutlines[0],
};

export { defaultTheme };
