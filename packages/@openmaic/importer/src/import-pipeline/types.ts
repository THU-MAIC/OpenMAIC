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
  /**
   * Degrade-not-fail telemetry: emitted when content survives the import only
   * partially — e.g. a formula that could not be converted to LaTeX, or media
   * in an unconvertible format (WMF / vector-only EMF) replaced by the blank
   * placeholder. Optional so existing callers keep compiling unchanged.
   */
  onWarning?: (warning: ImportWarning) => void;
}

/** A single content-degradation event surfaced to the importing caller. */
export interface ImportWarning {
  /** Stable machine code, e.g. `media-unconvertible` | `formula-fallback-image` | `element-dropped`. */
  code: string;
  /** 0-based index of the slide the warning belongs to. */
  slideIndex: number;
  message: string;
}

export interface TransformResult {
  slides: Slide[];
  uploadTasks: Promise<unknown>[];
}
