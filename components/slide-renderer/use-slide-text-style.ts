import type { CSSProperties } from 'react';
import { useSceneSelector } from '@/lib/contexts/scene-context';
import type { SceneContent } from '@/lib/types/stage';

interface SlideTextTheme {
  readonly fontColor: string;
  readonly fontName: string;
}

const FALLBACK_TEXT_THEME: SlideTextTheme = { fontColor: '#333333', fontName: 'Microsoft YaHei' };

function selectSlideTextTheme(content: SceneContent): SlideTextTheme {
  return (content.type === 'slide' && content.canvas.theme) || FALLBACK_TEXT_THEME;
}

/**
 * The color and font a slide element's text falls back to when it sets neither.
 * A slide is a document with its own theme, so this must be set on each element
 * that paints in one: left to inherit, the text takes the app's theme instead.
 */
export function useSlideTextStyle(): CSSProperties {
  const theme = useSceneSelector<SceneContent, SlideTextTheme>(selectSlideTextTheme);
  return { color: theme.fontColor, fontFamily: theme.fontName };
}
