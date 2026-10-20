/** Legacy actions cannot carry Native shape extensions. Validate before any side effects. */
export function legacyShapeCompatibilityError(params: object): string | null {
  const shape = 'shape' in params ? params.shape : undefined;
  const extensions = ['rotate', 'path', 'viewBox', 'stroke', 'expectedLastSeq'];
  if (shape === 'custom' || extensions.some((key) => key in params)) {
    return 'Legacy wb_draw_shape does not support Native rotation/custom path/stroke parameters. Use the Native wb_draw_shape tool and RuntimeStore projection; do not send a Legacy action.';
  }
  if (shape !== 'rectangle' && shape !== 'circle' && shape !== 'triangle') {
    return 'Legacy wb_draw_shape requires shape rectangle|circle|triangle; unknown shapes cannot fall back to rectangles.';
  }
  return null;
}
