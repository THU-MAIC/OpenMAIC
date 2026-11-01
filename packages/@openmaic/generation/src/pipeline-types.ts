/**
 * Type definitions for the generation pipeline.
 */

// ==================== Agent Info ====================

/** Lightweight agent info passed to the generation pipeline */
export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  persona?: string;
}

// ==================== Cross-Page Context ====================

/** Cross-page context for maintaining speech coherence across scenes */
export interface SceneGenerationContext {
  pageIndex: number; // Current page (1-based)
  totalPages: number; // Total number of pages
  allTitles: string[]; // All page titles in order
  previousSpeeches: string[]; // Speech texts from the previous page only
  /**
   * Where this page sits in a long-form course, already rendered by the host.
   *
   * Absent on the short path, where page/total is the whole story. Present on a
   * long sitting, where it carries the module, the course clock and this page's
   * narration budget — the three things a model writing page 19 of 27 cannot
   * infer from a title list.
   */
  longFormBrief?: string;
}

// ==================== Generated Slide Data Interface ====================

/**
 * AI-generated slide data structure
 * Used to parse AI responses
 */
export interface GeneratedSlideData {
  elements: Array<{
    type: 'text' | 'image' | 'video' | 'shape' | 'chart' | 'latex' | 'line';
    left: number;
    top: number;
    width: number;
    height: number;
    [key: string]: unknown;
  }>;
  background?: {
    type: 'solid' | 'gradient';
    color?: string;
    gradient?: {
      type: 'linear' | 'radial';
      colors: Array<{ pos: number; color: string }>;
      rotate: number;
    };
  };
  remark?: string;
}

// ==================== Types ====================

export interface GenerationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export type AICallFn = (
  systemPrompt: string,
  userPrompt: string,
  images?: Array<{ id: string; src: string }>,
) => Promise<string>;
