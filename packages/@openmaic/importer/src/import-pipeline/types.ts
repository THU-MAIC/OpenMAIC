import type { Slide, SlideTheme } from '@openmaic/dsl';
import type { ShapePoolItem } from '../openmaic/configs/shapes';

export interface ImportContext {
  ratio: number;
  /** 当前未被 transform 使用，由 hook/render-host 决定是否启用固定 viewport，预留给后续视口策略迁移 */
  fixedViewport: boolean;
  viewportWidth: number;
  theme: SlideTheme;
  shapeList: ShapePoolItem[];
  uploadBase64Image: (base64: string, filename: string, dir: string) => Promise<string>;
  uploadBlobMedia: (blob: Blob, filename: string, dir: string) => Promise<string>;
  /** 当前未被 transform 使用，poster 提取仍由 hook 侧 extractVideoPosters 负责，预留给后续迁移 */
  extractVideoFirstFrame: (videoUrl: string) => Promise<string | null>;
}

export interface TransformResult {
  slides: Slide[];
  uploadTasks: Promise<unknown>[];
}
