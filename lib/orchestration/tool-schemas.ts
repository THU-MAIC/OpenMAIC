/**
 * Action Schemas for Stateless Generation
 *
 * Text descriptions of actions for inclusion in structured output prompts.
 * Actions are parsed from JSON array items in the model's response.
 */

import { SLIDE_ONLY_ACTIONS } from '@/lib/types/action';

// ==================== Effective Actions ====================

/**
 * Filter allowed actions by scene type.
 * Slide-only actions (spotlight, laser) are removed for non-slide scenes.
 */
export function getEffectiveActions(allowedActions: string[], sceneType?: string): string[] {
  if (!sceneType || sceneType === 'slide') return allowedActions;
  return allowedActions.filter(
    (a) => !SLIDE_ONLY_ACTIONS.includes(a as (typeof SLIDE_ONLY_ACTIONS)[number]),
  );
}

// ==================== Text Descriptions ====================

/**
 * Get text descriptions of allowed actions for inclusion in system prompts.
 * Used when the model generates structured output with JSON array format.
 */
export function getActionDescriptions(allowedActions: string[]): string {
  const descriptions: Record<string, string> = {
    spotlight:
      'Focus attention on a single key element by dimming everything else. Use sparingly — max 1-2 per response. Parameters: { elementId: string, dimOpacity?: number }',
    laser:
      'Point at an element with a laser pointer effect. Parameters: { elementId: string, color?: string }',
    wb_open:
      'Open the whiteboard for hand-drawn explanations, formulas, diagrams, or step-by-step derivations. Creates a new whiteboard if none exists. Call this before adding elements. Parameters: {}',
    wb_draw_text:
      'Add text to the whiteboard. Use for writing formulas, steps, or key points. Parameters: { content: string, x: number, y: number, width?: number, height?: number, fontSize?: number, color?: string, elementId?: string }',
    wb_draw_shape:
      'Add a shape to the whiteboard. Use for diagrams and visual explanations. Parameters: { shape: "rectangle"|"circle"|"triangle", x: number, y: number, width: number, height: number, fillColor?: string, elementId?: string }',
    wb_draw_chart:
      'Add a chart to the whiteboard. Use for data visualization (bar charts, line graphs, pie charts, etc.). Parameters: { chartType: "bar"|"column"|"line"|"pie"|"ring"|"area"|"radar"|"scatter", x: number, y: number, width: number, height: number, data: { labels: string[], legends: string[], series: number[][] }, themeColors?: string[], elementId?: string }',
    wb_draw_latex:
      'Add a LaTeX formula to the whiteboard. Use for mathematical equations and scientific notation. Parameters: { latex: string, x: number, y: number, width?: number, height?: number, color?: string, elementId?: string }',
    wb_draw_table:
      'Add a table to the whiteboard. Use for structured data display and comparisons. Parameters: { x: number, y: number, width: number, height: number, data: string[][] (first row is header), outline?: { width: number, style: string, color: string }, theme?: { color: string }, elementId?: string }',
    wb_draw_line:
      'Add a line or arrow to the whiteboard. Use for connecting elements, drawing relationships, flow diagrams, or annotations. Parameters: { startX: number, startY: number, endX: number, endY: number, color?: string (default "#333333"), width?: number (line thickness, default 2), style?: "solid"|"dashed" (default "solid"), points?: [startMarker, endMarker] where marker is ""|"arrow" (default ["",""]), elementId?: string }',
    wb_clear:
      'Clear all elements from the whiteboard. Use when whiteboard is too crowded before adding new elements. Parameters: {}',
    wb_delete:
      'Delete a specific element from the whiteboard by its ID. Use to remove an outdated, incorrect, or overlapping element without clearing the entire board. Parameters: { elementId: string }',
    wb_close:
      'Close the whiteboard and return to the slide view. Always close after you finish drawing. Parameters: {}',
    play_video:
      'Start playback of a video element on the current slide. Synchronous — blocks until the video finishes playing. Use a speech action before this to introduce the video. Parameters: { elementId: string }',
  };

  if (allowedActions.length === 0) {
    return 'You have no actions available. You can only speak to students.';
  }

  const lines = allowedActions
    .filter((action) => descriptions[action])
    .map((action) => `- ${action}: ${descriptions[action]}`);

  return lines.join('\n');
}
