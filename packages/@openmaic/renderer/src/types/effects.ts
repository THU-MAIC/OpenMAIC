export interface LaserEffectOptions {
  elementId: string;
  color?: string;
  duration?: number;
}

export interface SpotlightEffectOptions {
  elementId: string;
}

export interface HighlightEffectOptions {
  elementId: string;
  color?: string;
  opacity?: number;
  borderWidth?: number;
  animated?: boolean;
}

export interface ZoomEffectOptions {
  elementId: string;
  scale: number;
}

export interface SlideEffects {
  laser?: LaserEffectOptions;
  spotlight?: SpotlightEffectOptions;
  highlight?: HighlightEffectOptions;
  zoom?: ZoomEffectOptions;
}
